import { runBoundedPool, PRIORITY, isTransientOperationError } from '../../core/utils.js';
import { appService } from '../services.js';
import { auditService } from '../audit/audit.service.js';
import { portfolioService } from '../trading/portfolio.service.js';
import { MARKET_SNAPSHOT_RETENTION_MS, SOL_MINT } from '../../core/config.js';
import {
  Context,
  RecheckItem,
  TokenMetadata,
  EvaluationResult,
  SwapOrder,
  MintSignals,
} from '../../types/index.js';

const MAX_INDEXING_LAG_RETRIES = 3;

/**
 * Type representing a work item in the scanning pipeline.
 */
interface WorkItem {
  token: TokenMetadata;
  recheckEntry?: RecheckItem;
}

interface StageDurations {
  priceFetchMs: number[];
  lightAuditMs: number[];
  heavyAuditMs: number[];
  buyMs: number[];
}

interface ScanMetrics {
  discovery: number;
  rechecks: number;
  buys: number;
  rejected: number;
  requeued: number;
  errors: number;
  lagRetries: number;
  reservedBuys: number;
}

/**
 * Checks if a token is older than the configured threshold.
 * @param token - The token metadata.
 * @param maxAgeMinutes - Maximum age in minutes.
 * @returns True if the token exceeds the age limit.
 */
function isTokenTooOld(token: TokenMetadata, maxAgeMinutes: number): boolean {
  if (!token.firstPool?.createdAt) return false;
  const ageMs = Date.now() - new Date(token.firstPool.createdAt).getTime();
  return ageMs > maxAgeMinutes * 60 * 1000;
}

/**
 * Pre-fetches a buy quote from Jupiter API for a token to minimize latency.
 * @param ctx - The application context.
 * @param mint - The token mint address.
 * @returns A promise resolving to a SwapOrder or null.
 */
async function prefetchBuyQuote(ctx: Context, mint: string): Promise<SwapOrder | null> {
  const { config } = ctx;
  const inputMint = SOL_MINT;
  const amount = String(config.buyAmountLamports);
  const slippageBps = config.slippageBps || 500;

  try {
    const url = `${config.jupiterBaseUrl}/quote?inputMint=${inputMint}&outputMint=${mint}&amount=${amount}&slippageBps=${slippageBps}`;
    const quote = (await (
      await fetch(url, { headers: { 'x-api-key': config.jupiterApiKey } })
    ).json()) as SwapOrder;
    return quote;
  } catch (err) {
    ctx.logger(
      `[QuotePrefetch] Failed for ${mint}: ${err instanceof Error ? err.message : String(err)}`,
      'debug'
    );
    return null;
  }
}

/**
 * Handles processing errors for a candidate, including recheck scheduling and indexing lag detection.
 * @param ctx - The application context.
 * @param item - The work item that failed.
 * @param err - The error object.
 * @param metrics - Current scan metrics.
 */
function handleProcessError(
  ctx: Context,
  item: WorkItem,
  err: unknown,
  metrics: ScanMetrics
): void {
  const { store } = ctx;
  const token = item.token;

  if (err instanceof Error && err.message.includes('RPC Indexing Lag')) {
    const retries = item.recheckEntry?.indexingLagRetries || 0;
    if (retries < MAX_INDEXING_LAG_RETRIES) {
      metrics.lagRetries++;
      scannerService.scheduleIndexingLagRetry(ctx, item, retries + 1);
      return;
    }
  }

  if (isTransientOperationError(err)) {
    metrics.errors++;
    ctx.recordScanBackpressureEvent?.(err);
    return;
  }

  const msg = err instanceof Error ? err.message : String(err);
  ctx.logger(`[ScanError] ${token.symbol}: ${msg}`, 'warn');
  metrics.errors++;
  store.trackMint(token.id);
}

/**
 * Scans for token candidates based on incoming discovery items and pending rechecks.
 * Coordinates batch audits, evaluations, and trade executions.
 *
 * @param ctx - The application context.
 * @param discoveryItems - Newly discovered token candidates.
 * @param due - Pending rechecks that are now eligible for processing.
 */
export async function scanForCandidates(
  ctx: Context,
  discoveryItems?: TokenMetadata[],
  due?: RecheckItem[]
): Promise<void> {
  const { state, store, config } = ctx;
  const scanStart = Date.now();

  const actualDue = due ?? scannerService.getDueCandidateRechecks(ctx);
  let actualDiscovery = discoveryItems;
  if (!actualDiscovery) {
    try {
      actualDiscovery = await appService.fetchRecentLaunches(ctx);
    } catch (e) {
      ctx.logger(
        `Failed to fetch recent launches: ${e instanceof Error ? e.message : String(e)}`,
        'warn'
      );
      actualDiscovery = [];
    }
  }

  // Update market snapshots with current prices of discovery candidates
  for (const t of actualDiscovery) {
    if (t.id && t.usdPrice !== undefined) {
      store.updateMarketSnapshot(t.id, {
        launchpad: t.launchpad || 'unknown',
        liquidity: Number(t.liquidity || 0),
        usdPrice: Number(t.usdPrice || 0),
        observedAt: new Date().toISOString(),
      });
    }
  }

  const metrics: ScanMetrics = {
    discovery: actualDiscovery.length,
    rechecks: actualDue.length,
    buys: 0,
    rejected: 0,
    requeued: 0,
    errors: 0,
    lagRetries: 0,
    reservedBuys: 0,
  };

  const stageDurations: StageDurations = {
    priceFetchMs: [],
    lightAuditMs: [],
    heavyAuditMs: [],
    buyMs: [],
  };

  // Pre-fetch missing market data (price/liquidity) for all items in the scan
  const allMints = [
    ...new Set([...actualDiscovery.map((i) => i.id), ...actualDue.map((i) => i.mint)]),
  ];
  const missingMints = allMints.filter((m) => !state.marketSnapshots.has(m));

  if (missingMints.length > 0) {
    const started = Date.now();
    try {
      const prices = await appService.fetchPricesBestEffort(ctx, missingMints, 'scan pre-fetch');
      for (const [mint, data] of Object.entries(prices)) {
        store.updateMarketSnapshot(mint, {
          launchpad: 'unknown',
          liquidity: Number(data.liquidity || 0),
          usdPrice: data.usdPrice,
          observedAt: new Date().toISOString(),
        });
      }
    } catch (e) {
      ctx.logger(
        `Scan market data pre-fetch failed: ${e instanceof Error ? e.message : String(e)}`,
        'warn'
      );
    }
    stageDurations.priceFetchMs.push(Date.now() - started);
  }

  // Build work items pool
  const workItems: WorkItem[] = [];
  for (const token of actualDiscovery) {
    if (state.processedMints.has(token.id) || state.pendingCandidateRechecks.has(token.id))
      continue;
    workItems.push({ token });
  }
  for (const entry of actualDue) {
    if (state.processedMints.has(entry.mint)) continue;

    // Check for pullback price deterioration
    if (entry.highestSeenPriceUsd && config.recheckPriceDropPct) {
      const currentPrice = state.marketSnapshots.get(entry.mint)?.usdPrice;
      if (currentPrice !== undefined && currentPrice > 0) {
        const dropPct =
          ((entry.highestSeenPriceUsd - currentPrice) / entry.highestSeenPriceUsd) * 100;
        if (dropPct > config.recheckPriceDropPct) {
          ctx.logger(
            `[Scan] Cancelling pullback recheck for ${entry.mint}: price dropped ${dropPct.toFixed(2)}% from high of ${entry.highestSeenPriceUsd} to ${currentPrice} (limit ${config.recheckPriceDropPct}%)`,
            'warn'
          );
          store.trackMint(entry.mint);
          continue;
        }
      }
    }

    workItems.push({
      token: entry.tokenSnapshot || ({ id: entry.mint, symbol: '?', name: '?' } as TokenMetadata),
      recheckEntry: entry,
    });
  }

  if (workItems.length === 0) return;

  // Run audits in parallel pools grouped by audit depth
  const lightAudits = workItems.filter((i) => !i.recheckEntry?.isFinalAudit);
  const heavyAudits = workItems.filter((i) => i.recheckEntry?.isFinalAudit);

  const batchedSignalsMap = new Map<string, MintSignals>();
  if (heavyAudits.length > 0) {
    const prefetchStart = Date.now();
    try {
      const signals = await auditService.batchGetMintSignals(
        ctx,
        heavyAudits.map((i) => i.token.id),
        { priority: PRIORITY.HIGH }
      );
      for (const [m, s] of signals) {
        batchedSignalsMap.set(m, s);
      }
      ctx.logger(
        `[BatchAudit] Pre-fetched signals for ${heavyAudits.length} candidates in ${Date.now() - prefetchStart}ms`,
        'debug'
      );
    } catch (err) {
      ctx.logger(
        `Batch signal pre-fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        'warn'
      );
    }
  }

  /**
   * Worker function to process a single work item.
   */
  const processItem = async (item: WorkItem): Promise<void> => {
    const isFinalAudit = item.recheckEntry?.isFinalAudit;

    // Final check for global limits before starting expensive audit
    if (
      state.positions.size + metrics.reservedBuys >= config.maxOpenPositions ||
      metrics.buys + metrics.reservedBuys >= config.maxBuysPerScan
    ) {
      return;
    }

    if (isFinalAudit) {
      metrics.reservedBuys++;
    }

    const reservedIncremented = isFinalAudit;

    const token = item.token;
    try {
      // Portfolio Risk Check
      const riskCheck = portfolioService.canBuy(ctx, token);
      if (!riskCheck.approved) {
        ctx.logger(`[RiskBlock] ${token.symbol}: ${riskCheck.reason}`, 'warn');
        return;
      }

      // Age check
      if (isTokenTooOld(token, config.maxCandidateAgeMinutes)) {
        metrics.rejected++;
        store.trackMint(token.id);
        return;
      }

      // Max recheck check
      if (
        item.recheckEntry &&
        (item.recheckEntry.auditAttempts || 0) >= (config.maxRecheckAttempts || 5)
      ) {
        ctx.logger(`[MaxRechecks] ${token.symbol} reached limit. Dropping.`, 'warn');
        store.trackMint(token.id);
        metrics.rejected++;
        return;
      }

      const depth = isFinalAudit ? 'full' : 'cheap';
      const priority = isFinalAudit ? PRIORITY.HIGH : PRIORITY.LOW;

      // Start pre-fetching quote for high-confidence final audits to minimize execution latency
      let prefetchedQuotePromise: Promise<SwapOrder | null> | null = null;
      if (isFinalAudit && !config.dryRun && !config.paperTrading) {
        prefetchedQuotePromise = prefetchBuyQuote(ctx, token.id);
      }

      const auditStart = Date.now();
      let evaluation: EvaluationResult;
      try {
        evaluation = await appService.evaluateCandidate(
          ctx,
          token,
          item.recheckEntry?.highestSeenPriceUsd,
          item.recheckEntry?.tokenSnapshot?.priceHistory || [],
          item.recheckEntry?.basePriceUsd,
          item.recheckEntry?.tokenSnapshot?.liquidity,
          item.recheckEntry?.tokenSnapshot?.tapeAtStart || null,
          item.recheckEntry?.tokenSnapshot?.tapeHistory || [],
          depth,
          priority,
          batchedSignalsMap.get(token.id)
        );
      } finally {
        stageDurations[depth === 'full' ? 'heavyAuditMs' : 'lightAuditMs'].push(
          Date.now() - auditStart
        );
      }

      if (evaluation.approved) {
        if (depth === 'cheap') {
          metrics.requeued++;
          scannerService.scheduleSurvivalDelay(ctx, item, evaluation.candidateScore);
          return;
        }

        // Final Audit Passed -> Buy
        const buyStart = Date.now();
        try {
          const pos = await appService.buyCandidate(ctx, evaluation, prefetchedQuotePromise);
          if (pos) {
            metrics.buys++;
            store.trackMint(token.id);
          } else {
            handleProcessError(
              ctx,
              item,
              new Error('Buy execution returned null position.'),
              metrics
            );
          }
        } finally {
          stageDurations.buyMs.push(Date.now() - buyStart);
        }
      } else {
        // Rejected -> Check if recheck eligible
        const reasons =
          evaluation.blockers.length > 0
            ? evaluation.blockers.join(' | ')
            : `Scorecard check failed (score: ${evaluation.candidateScore} < ${ctx.config.minCandidateScore})`;
        ctx.logger(`[REJECT] ${token.symbol} (${token.id}): ${reasons}`, 'debug');

        const hasHardBlocker = evaluation.rejectionReasons.some((r) => !r.recheckEligible);
        const recheckReason = hasHardBlocker
          ? undefined
          : evaluation.rejectionReasons.find((r) => r.recheckEligible);
        if (
          config.borderlineRecheckEnabled &&
          recheckReason &&
          (item.recheckEntry?.auditAttempts || 0) < (config.maxRecheckAttempts || 5)
        ) {
          metrics.requeued++;
          scannerService.scheduleRecheckEligibleWaitlist(ctx, item, recheckReason.code);
        } else {
          metrics.rejected++;
          store.trackMint(token.id);
        }
      }
      ctx.recordScanBackpressureEvent?.(null);
    } catch (err: unknown) {
      handleProcessError(ctx, item, err, metrics);
    } finally {
      if (reservedIncremented) {
        metrics.reservedBuys--;
      }
    }
  };

  const lightConcurrency = ctx.getEffectiveParallelism?.(config.scanParallelismLight || 10) || 10;
  const heavyConcurrency = ctx.getEffectiveParallelism?.(config.scanParallelismHeavy || 4) || 4;

  await Promise.all([
    runBoundedPool(lightAudits, processItem, { concurrency: lightConcurrency }),
    runBoundedPool(heavyAudits, processItem, { concurrency: heavyConcurrency }),
  ]);

  logScanSummary(
    ctx,
    stageDurations,
    metrics,
    workItems,
    actualDue.length,
    actualDiscovery.length,
    scanStart,
    lightConcurrency,
    heavyConcurrency
  );
}

/**
 * Logs a summary of the scan results and performance metrics.
 */
function logScanSummary(
  ctx: Context,
  _stageDurations: StageDurations,
  metrics: ScanMetrics,
  workItems: WorkItem[],
  _dueCount: number,
  _discoveryCount: number,
  scanStart: number,
  _lightC: number,
  _heavyC: number
): void {
  ctx.logger(
    `[SCAN] ${workItems.length} items. ` +
      `pos: ${ctx.state.positions.size}, buys: ${metrics.buys}, rchk: ${metrics.requeued}, rej: ${metrics.rejected}, err: ${metrics.errors}${metrics.lagRetries > 0 ? ` (lag:${metrics.lagRetries})` : ''}. ` +
      `(Total: ${Date.now() - scanStart}ms)`,
    'info'
  );
}

/**
 * Schedules a pullback recheck for a candidate.
 */
export function schedulePullbackRecheck(ctx: Context, item: WorkItem, reason: string): void {
  const { store } = ctx;
  const delayMs = 15000;
  store.upsertRecheckEntry({
    mint: item.token.id,
    tokenSnapshot: item.token,
    reason: `pullback:${reason}`,
    scheduledTime: Date.now() + delayMs,
    basePriceUsd: item.recheckEntry?.basePriceUsd || item.token.usdPrice,
    auditAttempts: (item.recheckEntry?.auditAttempts || 0) + 1,
  });
}

/**
 * Schedules a recheck for a candidate that is eligible for retry after rejection.
 */
export function scheduleRecheckEligibleWaitlist(
  ctx: Context,
  item: WorkItem,
  code: string,
  options?: { lowHolderWaitlist?: boolean }
): void {
  const { config, store } = ctx;
  let delayMs = config.borderlineRecheckMinDelayMs || 8000;
  if (code === 'low-holders' || options?.lowHolderWaitlist) {
    delayMs = (config.holderCountWaitlistSeconds || 33) * 1000;
  }
  const isTooNew = code === 'too-new';
  store.upsertRecheckEntry({
    mint: item.token.id,
    tokenSnapshot: item.token,
    reason: `waitlist:${code || 'low-holders'}`,
    scheduledTime: Date.now() + delayMs,
    auditAttempts: isTooNew
      ? item.recheckEntry?.auditAttempts || 0
      : (item.recheckEntry?.auditAttempts || 0) + 1,
    isWaitlist: true,
  });
}

/**
 * Schedules a survival delay for a candidate after passing cheap audits.
 */
export function scheduleSurvivalDelay(ctx: Context, item: WorkItem, score: number): void {
  const { config, store } = ctx;
  let delayMs = (config.survivalDelaySeconds || 5) * 1000;
  if (score >= (config.survivalDelayThresholdVeryHigh || 90)) {
    delayMs = (config.survivalDelaySeconds || 5) * 100;
  } else if (score >= (config.survivalDelayThresholdHigh || 75)) {
    delayMs = (config.survivalDelaySeconds || 5) * 500;
  }
  store.upsertRecheckEntry({
    mint: item.token.id,
    tokenSnapshot: item.token,
    reason: 'survival',
    scheduledTime: Date.now() + delayMs,
    candidateScore: score,
    basePriceUsd: item.token.usdPrice,
    isSurvivalWait: true,
    auditAttempts: item.recheckEntry?.auditAttempts || 0,
  });
}

/**
 * Schedules a final audit for a candidate.
 */
export function scheduleFinalAudit(ctx: Context, item: WorkItem): void {
  const { config, store } = ctx;
  const delayMs = (config.finalAuditSeconds || 2) * 1000;
  store.upsertRecheckEntry({
    mint: item.token.id,
    tokenSnapshot: item.token,
    reason: 'final-audit',
    scheduledTime: Date.now() + delayMs,
    isFinalAudit: true,
    auditAttempts: item.recheckEntry?.auditAttempts || 0,
  });
}

/**
 * Schedules a retry for a candidate experiencing RPC indexing lag.
 */
export function scheduleIndexingLagRetry(ctx: Context, item: WorkItem, retryCount: number): void {
  const { store } = ctx;
  if (retryCount > MAX_INDEXING_LAG_RETRIES) {
    store.trackMint(item.token.id);
    return;
  }
  store.incrementMetric('finalAuditDeferredIndexing', 1);
  const delayMs = 5000;
  store.upsertRecheckEntry({
    ...item.recheckEntry!,
    mint: item.token.id,
    tokenSnapshot: item.token,
    scheduledTime: Date.now() + delayMs,
    indexingLagRetries: retryCount,
  });
}

/**
 * Retrieves all pending rechecks that are due for processing.
 */
export function getDueCandidateRechecks(ctx: Context): RecheckItem[] {
  const { state } = ctx;
  const now = Date.now();
  return Array.from(state.pendingCandidateRechecks.values())
    .filter((r) => (r.scheduledTime || 0) <= now)
    .sort((a, b) => (a.scheduledTime || 0) - (b.scheduledTime || 0));
}

/**
 * Refreshes market snapshots and removes expired entries.
 */
export async function refreshMarketSnapshots(
  ctx: Context,
  launches: TokenMetadata[]
): Promise<void> {
  const { state, store } = ctx;
  const now = Date.now();
  for (const t of launches) {
    if (t?.id) {
      store.updateMarketSnapshot(t.id, {
        launchpad: t.launchpad || 'unknown',
        liquidity: Number(t.liquidity || 0),
        usdPrice: Number(t.usdPrice || 0),
        observedAt: new Date().toISOString(),
      });
    }
  }
  for (const [m, s] of state.marketSnapshots.entries()) {
    if (state.positions.has(m) || state.pendingCandidateRechecks.has(m)) continue;
    if (now - new Date(s.observedAt || 0).getTime() > MARKET_SNAPSHOT_RETENTION_MS) {
      store.removeMarketSnapshot(m);
    }
  }
}

/**
 * Service object to allow for easier mocking in ESM environments.
 */
export const scannerService = {
  scanForCandidates,
  schedulePullbackRecheck,
  scheduleRecheckEligibleWaitlist,
  scheduleSurvivalDelay,
  scheduleFinalAudit,
  scheduleIndexingLagRetry,
  getDueCandidateRechecks,
  refreshMarketSnapshots,
};
