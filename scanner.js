'use strict';

/**
 * Scanner service: handles candidate identification, multi-stage audit scheduling,
 * and re-audit logic for tokens discovered via polling or WebSocket.
 */

const { log, runBoundedPool, PRIORITY, isTransientOperationError } = require('./utils');
const services = require('./services');

const MAX_INDEXING_LAG_RETRIES = 3;

/**
 * Scans for new token candidates and re-audits pending ones.
 * @param {Object} ctx - The application context.
 * @param {string[]} [wsMints=null] - Optional array of mints discovered via WebSocket.
 * @param {Object} [wsLaunchpads=null] - Optional mapping of mints to their launchpad source.
 * @returns {Promise<void>}
 */
async function scanForCandidates(ctx, wsMints = null, wsLaunchpads = null) {
  const { config, state, store } = ctx;
  let recentLaunches;
  try {
    recentLaunches = await services.fetchRecentLaunches(ctx);
    store.updateLaunchHistory(recentLaunches);
  } catch (e) {
    log(config.logFile, `Recent launches failed: ${e.message}`, 'warn');
    return;
  }

  refreshMarketSnapshots(ctx, recentLaunches);

  const launchesByMint = new Map(recentLaunches.filter((t) => t?.id).map((t) => [t.id, t]));
  for (const [mint, token] of launchesByMint) {
    const entry = state.pendingCandidateRechecks.get(mint);
    const pos = state.positions.get(mint);
    const target = entry || pos;
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

        // Phase 1: Volatility & Spread tracking
        if (token.bidPrice > 0 && token.askPrice > 0) {
          const { computeSpread } = require('./utils');
          target.spreadHistory = target.spreadHistory || [];
          target.spreadHistory.push({
            spread: computeSpread(token.bidPrice, token.askPrice),
            timestamp: Date.now(),
          });
        }

        const cutoff = Date.now() - 60000;
        target.priceHistory = target.priceHistory.filter((h) => h.timestamp > cutoff);
        target.tapeHistory = target.tapeHistory.filter((h) => h.timestamp > cutoff);
        if (target.spreadHistory) {
          target.spreadHistory = target.spreadHistory.filter((h) => h.timestamp > cutoff);
        }

        if (entry) store.upsertRecheckEntry(target);
        else store.upsertPosition(target);
      }
    }
  }

  const due = getDueCandidateRechecks(ctx);
  const discoveryItems = recentLaunches
    .filter(
      (t) => t?.id && !state.processedMints.has(t.id) && !state.pendingCandidateRechecks.has(t.id)
    )
    .slice(0, config.maxCandidatesPerScan * 2)
    .map((t) => ({ kind: 'discovery', token: t }));

  // Add WebSocket discovered mints that aren't in recentLaunches yet
  if (Array.isArray(wsMints)) {
    for (const mint of wsMints) {
      if (
        !launchesByMint.has(mint) &&
        !state.processedMints.has(mint) &&
        !state.pendingCandidateRechecks.has(mint)
      ) {
        discoveryItems.push({
          kind: 'discovery',
          token: {
            id: mint,
            symbol: 'NEW',
            name: 'New Token',
            decimals: 6,
            launchpad: wsLaunchpads ? wsLaunchpads[mint] : null,
          },
        });
      }
    }
  }

  // Deduplicate workItems by mint ID
  const workItems = [];
  const seenMintsInScan = new Set();
  const allRawItems = [
    ...due.map((e) => ({
      kind: 'recheck',
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
  const stageDurations = {
    lightAuditMs: [],
    heavyAuditMs: [],
    priceRefreshMs: [],
    directMarketMs: [],
    buyAttemptMs: [],
  };

  const heavyAudits = workItems.filter((i) => i.recheckEntry?.isFinalAudit);
  const lightAudits = workItems.filter((i) => !i.recheckEntry?.isFinalAudit);

  // Identify items missing critical price/liquidity data (Fast Path)
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
          if (direct.isCompleted) item.token.launchpad = null; // Moved to Raydium
        }
      },
      { concurrency: ctx.config.priceFallbackParallelism || 5 }
    );
    stageDurations.directMarketMs.push(Date.now() - directStart);
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
      if (typeof ctx.recordScanBackpressureEvent === 'function')
        ctx.recordScanBackpressureEvent(false);
    } catch (err) {
      if (typeof ctx.recordScanBackpressureEvent === 'function')
        ctx.recordScanBackpressureEvent(isTransientOperationError(err));
      log(config.logFile, `Scan price refresh skipped: ${err.message}`, 'warn', { console: false });
    } finally {
      stageDurations.priceRefreshMs.push(Date.now() - priceRefreshStart);
    }
  }

  const lightConcurrency =
    typeof ctx.getEffectiveParallelism === 'function'
      ? ctx.getEffectiveParallelism(config.scanParallelismLight || config.maxConcurrentAudits || 1)
      : config.scanParallelismLight || config.maxConcurrentAudits || 1;

  const heavyConcurrency =
    typeof ctx.getEffectiveParallelism === 'function'
      ? ctx.getEffectiveParallelism(config.scanParallelismHeavy || 1)
      : config.scanParallelismHeavy || 1;

  const reserveBuySlot = () => {
    if (
      state.positions.size + reservedBuys >= config.maxOpenPositions ||
      buys + reservedBuys >= config.maxBuysPerScan
    )
      return false;
    reservedBuys++;
    return true;
  };

  const releaseBuySlot = () => {
    reservedBuys = Math.max(0, reservedBuys - 1);
  };

  const processItem = async (item) => {
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

      // Check re-audit attempts cap
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
      let e;

      // Parallelize Final Audit with Jupiter Quote Fetch
      let prefetchedQuotePromise = null;
      if (isFinalAudit && !config.dryRun && !config.paperTrading) {
        const mood = services.getMoodAdjustments(ctx);
        if (!mood.isPaused) {
          const buyLamports =
            (BigInt(ctx.config.buyAmountLamports) * BigInt(Math.round(mood.sizeMultiplier * 100))) /
            100n;
          const trading = require('./trading');
          prefetchedQuotePromise = trading
            .fetchSwapOrder(
              ctx,
              require('./config').constants.SOL_MINT,
              token.id,
              buyLamports.toString()
            )
            .catch(() => null);
        }
      }

      try {
        e = await services.evaluateCandidate(
          ctx,
          token,
          item.recheckEntry?.highestSeenPriceUsd,
          item.recheckEntry?.priceHistory,
          item.recheckEntry?.priceAtStartOfDelay,
          item.recheckEntry?.liquidityAtStartOfDelay,
          item.recheckEntry?.tapeAtStart,
          item.recheckEntry?.tapeHistory,
          depth,
          priority
        );
      } finally {
        stageDurations[depth === 'full' ? 'heavyAuditMs' : 'lightAuditMs'].push(
          Date.now() - auditStart
        );
      }
      if (typeof ctx.recordScanBackpressureEvent === 'function')
        ctx.recordScanBackpressureEvent(false);

      if (!e.approved) {
        rejected++;

        const reasons = Array.isArray(e.rejectionReasons) ? e.rejectionReasons : [];
        const isRecheckEligible = reasons.some((r) => r.recheckEligible);
        const isBuyingTop = reasons.some((r) => r.code === 'buying-the-top');
        const isLowHolderRecheck = reasons.some((r) => r.code === 'low-holders');

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

        reasons.forEach((r) => {
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
        stageDurations.buyAttemptMs.push(Date.now() - buyStart);
        store.trackMint(token.id);
        if (pos) {
          buys++;
          store.incrementMetric('boughtPositions');
          store.unretireMint(token.id);
        }
      } finally {
        releaseBuySlot();
      }
    } catch (err) {
      if (typeof ctx.recordScanBackpressureEvent === 'function')
        ctx.recordScanBackpressureEvent(isTransientOperationError(err));
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

  const summarizeDurations = (values) => {
    if (!values.length) return 'n/a';
    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((total, value) => total + value, 0);
    const median = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    return `count=${sorted.length}, avg=${Math.round(sum / sorted.length)}ms, med=${median}ms, p95=${p95}ms`;
  };

  log(
    config.logFile,
    `Scan stages: priceRefreshMs=${summarizeDurations(stageDurations.priceRefreshMs)}, directMarketMs=${summarizeDurations(stageDurations.directMarketMs)}, lightAuditMs=${summarizeDurations(stageDurations.lightAuditMs)}, heavyAuditMs=${summarizeDurations(stageDurations.heavyAuditMs)}, buyAttemptMs=${summarizeDurations(stageDurations.buyAttemptMs)}, concurrency=light:${lightConcurrency},heavy:${heavyConcurrency}, backpressure=${(ctx.scanBackpressureFactor || 1).toFixed(2)}`,
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
function schedulePullbackRecheck(ctx, evaluation, oldEntry) {
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
function scheduleRecheckEligibleWaitlist(ctx, evaluation, oldEntry, options = {}) {
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
function scheduleSurvivalDelay(ctx, evaluation) {
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
function scheduleFinalAudit(ctx, evaluation, oldEntry) {
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
function scheduleIndexingLagRetry(ctx, item, message = 'RPC Indexing Lag') {
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
  };
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
function getDueCandidateRechecks(ctx) {
  const now = Date.now();
  return Array.from(ctx.state.pendingCandidateRechecks.values()).filter(
    (e) => !e.nextEligibleAt || new Date(e.nextEligibleAt).getTime() <= now
  );
}

/**
 * Refreshes market snapshots with new data and purges stale ones.
 */
function refreshMarketSnapshots(ctx, launches) {
  const { state, store } = ctx;
  const { constants } = require('./config');
  const now = Date.now();
  for (const t of launches)
    if (t?.id)
      store.updateMarketSnapshot(t.id, {
        liquidity: Number(t.liquidity || 0),
        usdPrice: Number(t.usdPrice || 0),
        observedAt: new Date().toISOString(),
      });
  for (const [m, s] of state.marketSnapshots.entries()) {
    if (state.positions.has(m) || state.pendingCandidateRechecks.has(m)) continue;
    if (now - new Date(s.observedAt).getTime() > constants.MARKET_SNAPSHOT_RETENTION_MS)
      store.removeMarketSnapshot(m);
  }
}

module.exports = {
  scanForCandidates,
  schedulePullbackRecheck,
  scheduleRecheckEligibleWaitlist,
  scheduleSurvivalDelay,
  scheduleFinalAudit,
  scheduleIndexingLagRetry,
  getDueCandidateRechecks,
  refreshMarketSnapshots,
};
