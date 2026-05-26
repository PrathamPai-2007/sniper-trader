import {
  log,
  runBoundedPool,
  PRIORITY,
  isTransientOperationError,
  computeSpread,
} from '../../core/utils.js';
import * as services from '../services.js';
import { MARKET_SNAPSHOT_RETENTION_MS, SOL_MINT } from '../../core/config.js';
import { Context, RecheckItem, TokenMetadata, Position } from '../../types/index.js';

const MAX_INDEXING_LAG_RETRIES = 3;

export interface WorkItem {
  kind: 'discovery' | 'recheck';
  recheckEntry?: RecheckItem;
  token: TokenMetadata;
}

/**
 * Scans for new token candidates and re-audits pending ones.
 * @param ctx - The application context.
 * @param wsMints - Optional array of mints discovered via WebSocket.
 * @param wsLaunchpads - Optional mapping of mints to their launchpad source.
 */
export async function scanForCandidates(
  ctx: Context,
  wsMints: string[] | null = null,
  wsLaunchpads: Record<string, string> | null = null
): Promise<void> {
  const { config, state, store } = ctx;
  let recentLaunches: TokenMetadata[];
  try {
    recentLaunches = await services.fetchRecentLaunches(ctx);
    store.updateLaunchHistory(recentLaunches);
  } catch (e: any) {
    log(config.logFile, `Recent launches failed: ${e.message}`, 'warn');
    return;
  }

  refreshMarketSnapshots(ctx, recentLaunches);

  const launchesByMint = new Map(recentLaunches.filter((t) => t?.id).map((t) => [t.id, t]));
  for (const [mint, token] of launchesByMint) {
    const entry = state.pendingCandidateRechecks.get(mint);
    const pos = state.positions.get(mint);
    const target = (entry || pos) as (RecheckItem | Position) | undefined;
    if (target) {
      const p = Number(token.usdPrice || 0);
      if (p > 0) {
        target.highestSeenPriceUsd = Math.max(target.highestSeenPriceUsd || 0, p);
        target.priceHistory = target.priceHistory || [];
        target.priceHistory.push({ price: p, timestamp: Date.now() });
        target.tapeHistory = target.tapeHistory || [];
        target.tapeHistory.push({
          buys: Number(token.stats5m?.numBuys || 0),
          sells: Number(token.stats5m?.numSells || 0),
          timestamp: Date.now(),
        });

        if ((token as any).bidPrice > 0 && (token as any).askPrice > 0) {
          target.spreadHistory = target.spreadHistory || [];
          target.spreadHistory.push({
            spread: computeSpread((token as any).bidPrice, (token as any).askPrice),
            timestamp: Date.now(),
          });
        }

        const cutoff = Date.now() - 60000;
        target.priceHistory = target.priceHistory.filter((h: any) => h.timestamp > cutoff);
        target.tapeHistory = target.tapeHistory.filter((h: any) => h.timestamp > cutoff);
        if (target.spreadHistory) {
          target.spreadHistory = target.spreadHistory.filter((h: any) => h.timestamp > cutoff);
        }

        if (entry) store.upsertRecheckEntry(target as RecheckItem);
        else store.upsertPosition(target as Position);
      }
    }
  }

  const due = getDueCandidateRechecks(ctx);
  const discoveryItems = recentLaunches
    .filter(
      (t) => t?.id && !state.processedMints.has(t.id) && !state.pendingCandidateRechecks.has(t.id)
    )
    .slice(0, config.maxCandidatesPerScan * 2)
    .map((t) => ({ kind: 'discovery' as const, token: t }));

  if (Array.isArray(wsMints)) {
    for (const mint of wsMints) {
      if (
        !launchesByMint.has(mint) &&
        !state.processedMints.has(mint) &&
        !state.pendingCandidateRechecks.has(mint)
      ) {
        discoveryItems.push({
          kind: 'discovery' as const,
          token: {
            id: mint,
            symbol: 'NEW',
            name: 'New Token',
            decimals: 6,
            launchpad: wsLaunchpads ? wsLaunchpads[mint] : undefined,
          },
        });
      }
    }
  }

  const workItems: WorkItem[] = [];
  const seenMintsInScan = new Set<string>();
  const allRawItems: WorkItem[] = [
    ...due.map((e) => ({
      kind: 'recheck' as const,
      recheckEntry: e,
      token: launchesByMint.get(e.mint) || e.tokenSnapshot,
    })),
    ...discoveryItems,
  ];

  for (const item of allRawItems) {
    if (item.token?.id && !seenMintsInScan.has(item.token.id)) {
      seenMintsInScan.add(item.token.id);
      workItems.push(item);
    }
  }

  const scanStart = Date.now();
  let buys = 0,
    rejected = 0,
    errors = 0;
  let reservedBuys = 0;
  const stageDurations: Record<string, number[]> = {
    lightAuditMs: [],
    heavyAuditMs: [],
    priceRefreshMs: [],
    directMarketMs: [],
    buyAttemptMs: [],
  };

  const heavyAudits = workItems.filter((i) => i.recheckEntry?.isFinalAudit);
  const lightAudits = workItems.filter((i) => !i.recheckEntry?.isFinalAudit);

  const missingDataItems = workItems.filter(
    (item) => !(Number(item.token.usdPrice) > 0) || !(Number(item.token.liquidity) > 0)
  );

  if (missingDataItems.length > 0) {
    const directStart = Date.now();
    await runBoundedPool(
      missingDataItems,
      async (item) => {
        const direct = await services.fetchDirectMarketData(
          ctx,
          item.token.id,
          item.token.launchpad
        );
        if (direct) {
          item.token.usdPrice = direct.usdPrice;
          item.token.liquidity = direct.liquidity;
          item.token.source = direct.source;
          if (direct.isCompleted) item.token.launchpad = undefined;
        }
      },
      { concurrency: ctx.config.priceFallbackParallelism || 5 }
    );
    stageDurations.directMarketMs!.push(Date.now() - directStart);
  }

  const missingPriceMints = [
    ...new Set(
      workItems
        .filter((item) => !(Number(item.token.usdPrice) > 0))
        .map((item) => item.token.id)
        .filter(Boolean)
    ),
  ];
  if (missingPriceMints.length > 0) {
    const priceRefreshStart = Date.now();
    try {
      const prices = await services.fetchPricesBestEffort(ctx, missingPriceMints, 'scan refresh');
      for (const item of workItems)
        if (prices[item.token.id]) item.token.usdPrice = prices[item.token.id].usdPrice;
      if (typeof (ctx as any).recordScanBackpressureEvent === 'function')
        (ctx as any).recordScanBackpressureEvent(false);
    } catch (err: any) {
      if (typeof (ctx as any).recordScanBackpressureEvent === 'function')
        (ctx as any).recordScanBackpressureEvent(isTransientOperationError(err));
      log(config.logFile, `Scan price refresh skipped: ${err.message}`, 'warn', { console: false });
    } finally {
      stageDurations.priceRefreshMs!.push(Date.now() - priceRefreshStart);
    }
  }

  const lightConcurrency =
    typeof (ctx as any).getEffectiveParallelism === 'function'
      ? (ctx as any).getEffectiveParallelism(
          config.scanParallelismLight || config.maxConcurrentAudits || 1
        )
      : config.scanParallelismLight || config.maxConcurrentAudits || 1;

  const heavyConcurrency =
    typeof (ctx as any).getEffectiveParallelism === 'function'
      ? (ctx as any).getEffectiveParallelism(config.scanParallelismHeavy || 1)
      : config.scanParallelismHeavy || 1;

  const reserveBuySlot = (): boolean => {
    if (
      state.positions.size + reservedBuys >= config.maxOpenPositions ||
      buys + reservedBuys >= config.maxBuysPerScan
    )
      return false;
    reservedBuys++;
    return true;
  };

  const releaseBuySlot = (): void => {
    reservedBuys = Math.max(0, reservedBuys - 1);
  };

  const processItem = async (item: WorkItem): Promise<void> => {
    if (
      state.positions.size + reservedBuys >= config.maxOpenPositions ||
      buys + reservedBuys >= config.maxBuysPerScan
    )
      return;
    const token = item.token;
    try {
      const firstPoolCreatedAt = token.firstPool?.createdAt
        ? new Date(token.firstPool.createdAt).getTime()
        : null;
      const ageMinutes = firstPoolCreatedAt ? (Date.now() - firstPoolCreatedAt) / 60000 : 0;
      if (ageMinutes > config.maxCandidateAgeMinutes) {
        rejected++;
        store.trackMint(token.id);
        return;
      }

      if (
        item.recheckEntry &&
        (item.recheckEntry.auditAttempts || 0) >= (config.maxRecheckAttempts || 5)
      ) {
        log(
          config.logFile,
          `[Rejected:MaxRechecks] ${token.symbol} reached max audit attempts. Dropping.`,
          'warn'
        );
        store.trackMint(token.id);
        rejected++;
        return;
      }

      const isFinalAudit = item.recheckEntry?.isFinalAudit;
      const depth = isFinalAudit ? 'full' : 'cheap';
      const priority = isFinalAudit ? PRIORITY.HIGH : PRIORITY.LOW;
      const auditStart = Date.now();
      let e: any;

      let prefetchedQuotePromise: Promise<any> | null = null;
      if (isFinalAudit && !config.dryRun && !config.paperTrading) {
        const mood = services.getMoodAdjustments(ctx);
        if (!mood.isPaused) {
          const buyLamports =
            (BigInt(ctx.config.buyAmountLamports) * BigInt(Math.round(mood.sizeMultiplier * 100))) /
            100n;
          const trading = await import('../trading/trading.service.js');
          prefetchedQuotePromise = trading
            .fetchSwapOrder(ctx, SOL_MINT, token.id, buyLamports.toString())
            .catch(() => null);
        }
      }

      try {
        e = await services.evaluateCandidate(
          ctx,
          token,
          item.recheckEntry?.highestSeenPriceUsd,
          item.recheckEntry?.tokenSnapshot?.priceHistory, // Fallback to priceHistory arrays if any
          item.recheckEntry?.basePriceUsd,
          item.recheckEntry?.tokenSnapshot?.liquidity, // Fallback
          item.recheckEntry?.tokenSnapshot?.tapeAtStart,
          item.recheckEntry?.tokenSnapshot?.tapeHistory || [],
          depth,
          priority
        );
      } finally {
        stageDurations[depth === 'full' ? 'heavyAuditMs' : 'lightAuditMs']!.push(
          Date.now() - auditStart
        );
      }
      if (typeof (ctx as any).recordScanBackpressureEvent === 'function')
        (ctx as any).recordScanBackpressureEvent(false);

      if (!e.approved) {
        rejected++;

        const reasons = Array.isArray(e.rejectionReasons) ? e.rejectionReasons : [];
        const isRecheckEligible = reasons.some((r: any) => r.recheckEligible);
        const isBuyingTop = reasons.some((r: any) => r.code === 'buying-the-top');
        const isLowHolderRecheck = reasons.some((r: any) => r.code === 'low-holders');

        if (isBuyingTop) {
          const currentPrice = Number(token.usdPrice || 0);
          const highestPrice = item.recheckEntry?.highestSeenPriceUsd || currentPrice;
          const dropRatio = 1 - currentPrice / highestPrice;
          if (dropRatio > config.recheckPriceDropPct / 100) {
            log(
              config.logFile,
              `[Rejected:PullbackBreak] ${token.symbol} deteriorated ${(dropRatio * 100).toFixed(1)}% during pullback wait. Dropping permanently.`,
              'warn'
            );
            store.trackMint(token.id);
          } else if (dropRatio > config.buyingTheTopSlPct / 100) {
            log(
              config.logFile,
              `[Rejected:BuyingTop] ${token.symbol} hit rug-guard (${(dropRatio * 100).toFixed(1)}% drop). Dropping permanently.`,
              'warn'
            );
            store.trackMint(token.id);
          } else {
            schedulePullbackRecheck(ctx, e, item.recheckEntry);
            log(
              config.logFile,
              `[PullbackWait] ${token.symbol} still at top; recheck in 10s.`,
              'info',
              { console: false }
            );
            return;
          }
        } else if (isRecheckEligible && config.borderlineRecheckEnabled) {
          scheduleRecheckEligibleWaitlist(ctx, e, item.recheckEntry, {
            lowHolderWaitlist: isLowHolderRecheck,
          });
          log(
            config.logFile,
            `[RecheckEligible] ${token.symbol}: ${e.blockers.join(' | ')}. Rescheduled.`,
            'info',
            { console: false }
          );
          return;
        } else {
          store.trackMint(token.id);
        }

        if (item.recheckEntry?.isFinalAudit) {
          store.incrementMetric('finalAuditRejected');
        }
        if (item.kind === 'recheck') store.incrementMetric('failedMomentum');

        reasons.forEach((r: any) => {
          if (r.code) store.recordRejection(r.code);
        });

        log(
          config.logFile,
          `[${item.recheckEntry?.isFinalAudit ? 'finalAuditRejected' : 'Rejected'}] ${token.symbol}: ${e.blockers.join(' | ')}`,
          'warn',
          { console: false }
        );
        return;
      }

      if (item.kind === 'discovery' || item.recheckEntry?.isWaitlist) {
        if (item.kind === 'discovery') store.incrementMetric('discoveredCandidates');
        store.incrementMetric('passedCheapAudit');
        scheduleSurvivalDelay(ctx, e);
        log(
          config.logFile,
          `${item.kind === 'discovery' ? 'Discovered' : 'Waitlist passed:'} ${token.symbol}; survival armed.`,
          'info',
          { console: false }
        );
        return;
      }

      if (item.recheckEntry?.isSurvivalWait) {
        store.incrementMetric('passedSurvival');
        store.incrementMetric('finalAuditQueued');
        scheduleFinalAudit(ctx, e, item.recheckEntry);
        log(
          config.logFile,
          `[finalAuditQueued] ${token.symbol} passed survival; fact-checking (5s)...`,
          'info'
        );
        return;
      }

      if (item.recheckEntry?.isFinalAudit) {
        store.incrementMetric('finalAuditPassed');
        log(config.logFile, `[finalAuditPassed] ${token.symbol} passed final audit.`, 'info');
      }

      if (!reserveBuySlot()) return;
      const buyStart = Date.now();
      try {
        const pos = await services.buyCandidate(ctx, e, prefetchedQuotePromise);
        stageDurations.buyAttemptMs!.push(Date.now() - buyStart);
        store.trackMint(token.id);
        if (pos) {
          buys++;
          store.incrementMetric('boughtPositions');
          store.unretireMint(token.id);
        }
      } finally {
        releaseBuySlot();
      }
    } catch (err: any) {
      if (typeof (ctx as any).recordScanBackpressureEvent === 'function')
        (ctx as any).recordScanBackpressureEvent(isTransientOperationError(err));
      const message = String(err?.message || err);
      if (!message.includes('RPC Indexing Lag')) {
        errors++;
        log(config.logFile, `Error processing ${token?.symbol || 'unknown'}: ${message}`, 'error');
      } else {
        rejected++;
        scheduleIndexingLagRetry(ctx, item, message);
      }
    }
  };

  await Promise.all([
    runBoundedPool(lightAudits, processItem, { concurrency: lightConcurrency }),
    runBoundedPool(heavyAudits, processItem, { concurrency: heavyConcurrency }),
  ]);

  const summarizeDurations = (values: number[] | undefined) => {
    if (!values || !values.length) return 'n/a';
    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((total, value) => total + value, 0);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
    return `count=${sorted.length}, avg=${Math.round(sum / sorted.length)}ms, med=${median}ms, p95=${p95}ms`;
  };

  log(
    config.logFile,
    `Scan stages: priceRefreshMs=${summarizeDurations(stageDurations.priceRefreshMs)}, directMarketMs=${summarizeDurations(stageDurations.directMarketMs)}, lightAuditMs=${summarizeDurations(stageDurations.lightAuditMs)}, heavyAuditMs=${summarizeDurations(stageDurations.heavyAuditMs)}, buyAttemptMs=${summarizeDurations(stageDurations.buyAttemptMs)}, concurrency=light:${lightConcurrency},heavy:${heavyConcurrency}, backpressure=${((ctx as any).scanBackpressureFactor || 1).toFixed(2)}`,
    'debug',
    { console: false }
  );

  await ctx.persistState();
  const scanDuration = Date.now() - scanStart;
  if (workItems.length > 0)
    log(
      config.logFile,
      `Scan: disc=${discoveryItems.length}, recheck=${due.length}, buys=${buys}, rej=${rejected}, err=${errors}, pos=${state.positions.size} (duration: ${scanDuration}ms)`,
      'info',
      { console: true }
    );
}

/**
 * Schedules a pullback recheck for a token that is currently at the top.
 */
export function schedulePullbackRecheck(ctx: Context, evaluation: any, oldEntry: any): void {
  const entry = {
    ...(oldEntry || {}),
    mint: evaluation.token.id,
    tokenSnapshot: evaluation.token,
    nextEligibleAt: new Date(Date.now() + 10000).toISOString(),
    isWaitlist: false,
    isSurvivalWait: false,
    isFinalAudit: true,
  };
  ctx.store.upsertRecheckEntry(entry);
}

/**
 * Schedules a recheck for a token that failed with a recheck-eligible reason.
 */
export function scheduleRecheckEligibleWaitlist(
  ctx: Context,
  evaluation: any,
  oldEntry: any,
  options: { lowHolderWaitlist?: boolean } = {}
): void {
  const { config, store } = ctx;
  const delayMs = options.lowHolderWaitlist
    ? Math.max(1000, Math.floor(Number(config.holderCountWaitlistSeconds || 60) * 1000))
    : Math.floor(
        Math.random() * (config.borderlineRecheckMaxDelayMs - config.borderlineRecheckMinDelayMs) +
          config.borderlineRecheckMinDelayMs
      );
  const entry = {
    ...(oldEntry || {}),
    mint: evaluation.token.id,
    tokenSnapshot: evaluation.token,
    auditAttempts: (oldEntry?.auditAttempts || 0) + 1,
    nextEligibleAt: new Date(Date.now() + delayMs).toISOString(),
    isWaitlist: true,
    isSurvivalWait: false,
    isFinalAudit: false,
  };
  store.upsertRecheckEntry(entry);
}

/**
 * Schedules a survival delay for a newly discovered token.
 */
export function scheduleSurvivalDelay(ctx: Context, evaluation: any): void {
  const { config, store } = ctx;
  const score = evaluation.candidateScore || 0;
  let delayMs;
  if (score >= config.survivalDelayThresholdVeryHigh) {
    delayMs = 2000;
  } else if (score >= config.survivalDelayThresholdHigh) {
    delayMs = 10000;
  } else {
    delayMs = config.survivalDelaySeconds * 1000;
  }

  const entry = {
    mint: evaluation.token.id,
    tokenSnapshot: evaluation.token,
    attempts: 0,
    nextEligibleAt: new Date(Date.now() + delayMs).toISOString(),
    candidateScore: score,
    highestSeenPriceUsd: Number(evaluation.token.usdPrice || 0),
    priceAtStartOfDelay: Number(evaluation.token.usdPrice || 0),
    liquidityAtStartOfDelay: Number(evaluation.token.liquidity || 0),
    priceHistory: [{ price: Number(evaluation.token.usdPrice || 0), timestamp: Date.now() }],
    tapeAtStart: {
      buys: Number(evaluation.token.stats5m?.numBuys || 0),
      sells: Number(evaluation.token.stats5m?.numSells || 0),
    },
    tapeHistory: [
      {
        buys: Number(evaluation.token.stats5m?.numBuys || 0),
        sells: Number(evaluation.token.stats5m?.numSells || 0),
        timestamp: Date.now(),
      },
    ],
    isSurvivalWait: true,
    isFinalAudit: false,
  };
  store.upsertRecheckEntry(entry);
}

/**
 * Schedules a final security audit for a token that passed survival delay.
 */
export function scheduleFinalAudit(ctx: Context, evaluation: any, oldEntry: any): void {
  const { config, store } = ctx;
  const score = evaluation.candidateScore || 0;
  let delayMs;
  if (score >= config.survivalDelayThresholdVeryHigh) {
    delayMs = 3000;
  } else {
    delayMs = config.finalAuditSeconds * 1000;
  }

  const entry = {
    ...oldEntry,
    nextEligibleAt: new Date(Date.now() + delayMs).toISOString(),
    isSurvivalWait: false,
    isFinalAudit: true,
  };
  store.upsertRecheckEntry(entry);
}

/**
 * Schedules a retry for a token recheck that failed due to RPC indexing lag.
 */
export function scheduleIndexingLagRetry(
  ctx: Context,
  item: WorkItem,
  message = 'RPC Indexing Lag'
): void {
  const { config, store } = ctx;
  const existing = item?.recheckEntry;
  const token = item?.token;
  const mint = existing?.mint || token?.id;
  if (!mint) return;

  if (existing?.isFinalAudit) {
    store.incrementMetric('finalAuditDeferredIndexing');
  }

  const currentRetries = Number(existing?.indexingLagRetries || 0);

  if (currentRetries >= MAX_INDEXING_LAG_RETRIES) {
    store.removeRecheckEntry(mint);
    log(
      config.logFile,
      `[${existing?.isFinalAudit ? 'finalAuditDeferredIndexing' : 'IndexingLag'}] Permanently dropped ${token?.symbol || mint} after ${currentRetries} indexing lag retries. ${message}`,
      'warn',
      { console: false }
    );
    return;
  }

  const delayMs = Math.max(1000, Math.floor(Number(config.rpcIndexingRetryDelayMs || 15000)));
  const entry = {
    ...(existing || {}),
    mint,
    tokenSnapshot: token || existing?.tokenSnapshot,
    attempts: Number(existing?.attempts || 0) + 1,
    nextEligibleAt: new Date(Date.now() + delayMs).toISOString(),
    indexingLagRetries: currentRetries + 1,
  } as any;
  store.upsertRecheckEntry(entry);
  log(
    config.logFile,
    `[${existing?.isFinalAudit ? 'finalAuditDeferredIndexing' : 'IndexingLag'}] Deferred ${token?.symbol || mint} after indexing lag; retry in ${Math.round(delayMs / 1000)}s (attempt ${currentRetries + 1}/${MAX_INDEXING_LAG_RETRIES}). ${message}`,
    'debug',
    { console: false }
  );
}

/**
 * Filters the pending rechecks that are eligible for processing now.
 */
export function getDueCandidateRechecks(ctx: Context): RecheckItem[] {
  const now = Date.now();
  return Array.from(ctx.state.pendingCandidateRechecks.values()).filter(
    (e) =>
      !e.scheduledTime ||
      e.scheduledTime <= now ||
      (e as any).nextEligibleAt === undefined ||
      new Date((e as any).nextEligibleAt).getTime() <= now
  );
}

/**
 * Refreshes market snapshots with new data and purges stale ones.
 */
export function refreshMarketSnapshots(ctx: Context, launches: any[]): void {
  const { state, store } = ctx;
  const now = Date.now();
  for (const t of launches)
    if (t?.id)
      store.updateMarketSnapshot(t.id, {
        launchpad: t.launchpad || 'unknown',
        liquidity: Number(t.liquidity || 0),
        usdPrice: Number(t.usdPrice || 0),
        observedAt: new Date().toISOString(),
      });
  for (const [m, s] of state.marketSnapshots.entries()) {
    if (state.positions.has(m) || state.pendingCandidateRechecks.has(m)) continue;
    if (now - new Date(s.observedAt || 0).getTime() > MARKET_SNAPSHOT_RETENTION_MS)
      store.removeMarketSnapshot(m);
  }
}
