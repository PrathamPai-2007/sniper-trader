'use strict';

// Main runtime orchestrator: boots config/wallet/RPC, runs discovery + monitor loops,
// persists bot state, manages websocket watchdogs, and handles graceful shutdown.

const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { setMaxListeners, EventEmitter } = require('node:events');

if (typeof EventEmitter.setMaxListeners === 'function') {
  EventEmitter.defaultMaxListeners = 100;
}
const shutdownController = new AbortController();
if (typeof setMaxListeners === 'function') {
  try {
    setMaxListeners(100, shutdownController.signal);
  } catch {}
}

const { createSolanaRpc } = require('@solana/rpc');
const { createSolanaRpcSubscriptions } = require('@solana/rpc-subscriptions');
const { createKeyPairSignerFromBytes } = require('@solana/signers');
const {
  log,
  atomicToDecimalString,
  atomicWriteFile,
  safeJsonStringify,
  isTransientOperationError,
  runBoundedPool,
  PRIORITY,
  computeSpread,
} = require('./utils');
const { constants, loadConfig, validateStartupConfig } = require('./config');
const services = require('./services');
const discovery = require('./discovery');
const trading = require('./trading');

const {
  MAX_TRACKED_MINTS,
  SPL_TOKEN_PROGRAM_IDS,
  PUMP_FUN_PROGRAM_ID,
  RAYDIUM_AMM_V4_PROGRAM_ID,
  METEORA_DLMM_PROGRAM_ID,
  MARKET_SNAPSHOT_RETENTION_MS,
} = constants;

let config, wallet, rpc, rpcSubscriptions, state;
let rpcs = [],
  rpcSubscriptionPool = [];
let shouldStop = false;
let shutdownRequested = false;
let websocketWatchdogInterval = null;
const scanBackpressure = {
  events: [],
  factor: 1,
};

/**
 * Records a scan backpressure event to adjust parallelism based on error rates.
 * @param {Error|boolean} error - The error encountered or a boolean indicating success/failure.
 */
function recordScanBackpressureEvent(error) {
  if (!config) return;
  const windowSize = Math.max(1, Math.floor(config.errorRateWindow || 20));
  scanBackpressure.events.push({ error: Boolean(error), at: Date.now() });
  while (scanBackpressure.events.length > windowSize) scanBackpressure.events.shift();
  const errorCount = scanBackpressure.events.filter((event) => event.error).length;
  const errorRate = errorCount / scanBackpressure.events.length;
  const minFactor = Math.min(1, Math.max(0.1, Number(config.parallelismMinFactor || 0.5)));
  scanBackpressure.factor =
    errorRate >= Number(config.backpressureErrorRateThreshold || 0.3) ? minFactor : 1;
}

/**
 * Calculates effective parallelism factor based on current backpressure.
 * @param {number} base - The base parallelism value.
 * @returns {number} The adjusted parallelism value.
 */
function getEffectiveParallelism(base) {
  const numericBase = Math.max(1, Math.floor(Number(base) || 1));
  return Math.max(1, Math.floor(numericBase * scanBackpressure.factor));
}

/**
 * Summarizes an array of durations into a human-readable string.
 * @param {number[]} values - Array of duration values in milliseconds.
 * @returns {string} Formatted summary string.
 */
function summarizeDurations(values) {
  if (!values.length) return 'n/a';
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  return `count=${sorted.length}, avg=${Math.round(sum / sorted.length)}ms, med=${median}ms, p95=${p95}ms`;
}

/**
 * Calculates the Global Momentum Index (GMI) based on the success rate of the last 100 launches.
 * Success is defined as hitting a 1.5x multiple from the first seen price.
 * @returns {number} The GMI as a ratio (0-1).
 */
function calculateGMI() {
  const history = state.launchHistory || [];
  if (history.length < 10) return 0.5; // Neutral default
  const successes = history.filter((l) => l.isSuccess).length;
  return successes / history.length;
}

/**
 * Updates the launch history with new data and calculates successes.
 * @param {Object[]} launches - Array of recent token launches.
 */
function updateLaunchHistory(launches) {
  const now = Date.now();
  const historyMap = new Map(state.launchHistory.map((l) => [l.mint, l]));

  for (const token of launches) {
    if (!token.id) continue;
    const p = Number(token.usdPrice || 0);
    if (!(p > 0)) continue;

    let entry = historyMap.get(token.id);
    if (!entry) {
      entry = {
        mint: token.id,
        firstSeenPrice: p,
        highestSeenPrice: p,
        isSuccess: false,
        timestamp: now,
      };
      state.launchHistory.push(entry);
    } else {
      entry.highestSeenPrice = Math.max(entry.highestSeenPrice, p);
      if (!entry.isSuccess && entry.highestSeenPrice >= entry.firstSeenPrice * 1.5) {
        entry.isSuccess = true;
      }
    }
  }

  // Cap at 100 most recent launches
  if (state.launchHistory.length > 100) {
    state.launchHistory = state.launchHistory.slice(-100);
  }
}

/**
 * Internal helper for testing to inject a mock configuration.
 * @param {Object} mockConfig - The mock configuration object.
 */
function _setTestConfig(mockConfig) {
  config = mockConfig;
}

/**
 * Internal helper for testing to inject a mock state.
 * @param {Object} mockState - The mock state object.
 */
function _setTestState(mockState) {
  state = mockState;
}

/**
 * Constructs the execution context (ctx) used across the application.
 * @returns {Object} The context object containing config, wallet, rpc, state, and logging utilities.
 */
function getCtx() {
  return {
    config,
    wallet,
    rpc,
    rpcs,
    rpcSubscriptions,
    rpcSubscriptionPool,
    state,
    constants,
    calculateGMI,
    logger: (msg, lvl, opts) => {
      if (!config) return log('', msg, lvl, opts);
      let finalMsg = msg;
      if (lvl === 'trade' && config.paperTrading && state?.paperSolBalanceLamports) {
        const balText = atomicToDecimalString(state.paperSolBalanceLamports, 9, 4);
        if (!msg.includes('[PAPER SOL:')) {
          finalMsg = `${msg} [PAPER SOL: ${balText}]`;
        }
      }
      return log(config.logFile, finalMsg, lvl, opts);
    },
    persistState,
  };
}

/**
 * Loads the bot state from a JSON file.
 * @param {string} stateFile - Path to the state file.
 * @returns {Object} The loaded or default state object.
 */
function loadState(stateFile) {
  const baseState = {
    processedMintQueue: [],
    processedMints: new Set(),
    pendingCandidateRechecks: new Map(),
    positions: new Map(),
    marketSnapshots: new Map(),
    launchHistory: [],
    paperSolBalanceLamports: config?.initialPaperSolLamports || '1000000000',
    tradeHistory: [],
    moodPauseUntil: null,
    coolDownMints: new Map(),
    retiredMints: new Map(),
    closedTrades: [],
    metrics: {
      discoveredCandidates: 0,
      passedCheapAudit: 0,
      passedSurvival: 0,
      boughtPositions: 0,
      passedAudit: 0,
      failedMomentum: 0,
      buyAttempts: 0,
      buyFailures: 0,
      profitableTrades: 0,
      stopLosses: 0,
      trailingExits: 0,
      finalAuditQueued: 0,
      finalAuditPassed: 0,
      finalAuditDeferredIndexing: 0,
      finalAuditRejected: 0,
      exitReasonCounts: {},
      rejectionReasons: {},
    },
  };

  if (!stateFile) return baseState;
  const resolvedPath = path.resolve(stateFile);
  if (!fs.existsSync(resolvedPath)) return baseState;

  try {
    const parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
    const queue = Array.isArray(parsed.processedMintQueue) ? parsed.processedMintQueue : [];
    const positions = Array.isArray(parsed.positions) ? parsed.positions : [];
    const rechecks = Array.isArray(parsed.pendingCandidateRechecks)
      ? parsed.pendingCandidateRechecks
      : [];
    const metrics = { ...baseState.metrics, ...(parsed.metrics || {}) };

    return {
      processedMintQueue: queue,
      processedMints: new Set(queue),
      pendingCandidateRechecks: new Map(rechecks.filter((e) => e?.mint).map((e) => [e.mint, e])),
      positions: new Map(positions.map((p) => [p.mint, p])),
      marketSnapshots: new Map(),
      launchHistory: Array.isArray(parsed.launchHistory) ? parsed.launchHistory : [],
      paperSolBalanceLamports: parsed.paperSolBalanceLamports ?? config.initialPaperSolLamports,
      tradeHistory: Array.isArray(parsed.tradeHistory) ? parsed.tradeHistory : [],
      moodPauseUntil: parsed.moodPauseUntil || null,
      coolDownMints: new Map(Object.entries(parsed.coolDownMints || {})),
      retiredMints: new Map(Object.entries(parsed.retiredMints || {})),
      closedTrades: Array.isArray(parsed.closedTrades) ? parsed.closedTrades : [],
      metrics,
    };
  } catch (error) {
    log(config.logFile, `Failed to load state: ${error.message}`, 'warn');
    return baseState;
  }
}

let persistencePromise = Promise.resolve();

/**
 * Persists the current state and metrics to disk atomically.
 * @returns {Promise<void>}
 */
async function persistState(options = {}) {
  if (!config.stateFile || (shutdownRequested && !options.force)) return;

  // Serialize writes to prevent EPERM collisions on Windows
  persistencePromise = persistencePromise.then(async () => {
    const payload = {
      processedMintQueue: state.processedMintQueue,
      pendingCandidateRechecks: Array.from(state.pendingCandidateRechecks.values()),
      positions: Array.from(state.positions.values()),
      launchHistory: state.launchHistory,
      paperSolBalanceLamports: state.paperSolBalanceLamports,
      tradeHistory: state.tradeHistory,
      moodPauseUntil: state.moodPauseUntil,
      coolDownMints: Object.fromEntries(state.coolDownMints),
      retiredMints: Object.fromEntries(state.retiredMints),
      closedTrades: state.closedTrades,
      metrics: state.metrics,
    };
    try {
      await atomicWriteFile(config.stateFile, safeJsonStringify(payload, 2));
      await persistMetricsInternal();
    } catch {
      // Error logged in atomicWriteFile
    }
  });

  return persistencePromise;
}

/**
 * Persists metrics to the metrics file.
 * @returns {Promise<void>}
 */
async function persistMetricsInternal() {
  if (!config.metricsFile) return;
  try {
    await atomicWriteFile(config.metricsFile, safeJsonStringify(state.metrics, 2));
  } catch {
    // Error logged in atomicWriteFile
  }
}

/**
 * Tracks a mint as processed to prevent duplicate discovery.
 * @param {string} mint - The token mint address.
 */
function trackProcessedMint(mint) {
  if (state.processedMints.has(mint)) return;
  state.pendingCandidateRechecks.delete(mint);
  state.processedMints.add(mint);
  state.processedMintQueue.push(mint);
  while (state.processedMintQueue.length > MAX_TRACKED_MINTS) {
    const removed = state.processedMintQueue.shift();
    if (removed) state.processedMints.delete(removed);
  }
}

/**
 * Removes a mint from the processed tracking.
 * @param {string} mint - The token mint address.
 */
function untrackProcessedMint(mint) {
  state.processedMints.delete(mint);
  state.pendingCandidateRechecks.delete(mint);
  state.processedMintQueue = state.processedMintQueue.filter((m) => m !== mint);
}

/**
 * Processes active cool-downs and moves expired entries to retired state.
 */
function processCoolDowns() {
  const now = Date.now();
  let changed = false;
  for (const [mint, entry] of state.coolDownMints.entries()) {
    if (now >= entry.expiresAt) {
      state.coolDownMints.delete(mint);
      state.retiredMints.set(mint, { lastExitPriceUsd: entry.lastExitPriceUsd });
      untrackProcessedMint(mint);
      log(config.logFile, `Cool-down expired for ${mint}.`, 'info');
      changed = true;
    }
  }
  if (changed) persistState();
}

/**
 * Schedules a flush of discovery signals with debouncing.
 */
function scheduleDiscoverySignalFlush() {
  if (discovery.discoveryState.debounceTimer) return;
  discovery.discoveryState.debounceTimer = setTimeout(() => {
    discovery.discoveryState.debounceTimer = null;
    void discovery.flushDiscoverySignals(getCtx(), (meta) => runDiscoveryLoop(meta));
  }, config.discoveryWsDebounceMs);
}

/**
 * Starts a watchdog to monitor WebSocket health and reconnect if stale.
 */
function startWebsocketWatchdog() {
  if (!config.discoveryWsEnabled) return;
  if (websocketWatchdogInterval) clearInterval(websocketWatchdogInterval);
  websocketWatchdogInterval = setInterval(async () => {
    try {
      if (!config.discoveryWsEnabled) return;
      const idleTime = Date.now() - discovery.discoveryState.lastEventAt;
      if (idleTime > config.websocketStaleThresholdMs) {
        log(
          config.logFile,
          `WebSocket stream is STALE (${Math.floor(idleTime / 1000)}s). Attempting RECONNECT...`,
          'warn',
          { console: true }
        );

        // Abort existing subscriptions
        discovery.discoveryState.logSubscriptionControllers.forEach((c) => c.abort());
        discovery.discoveryState.logSubscriptionControllers = [];

        // Re-subscribe
        const programs = [];
        if (config.discoveryPumpEnabled) programs.push(PUMP_FUN_PROGRAM_ID);
        if (config.discoveryRaydiumEnabled) programs.push(RAYDIUM_AMM_V4_PROGRAM_ID);
        if (config.discoveryMeteoraEnabled) programs.push(METEORA_DLMM_PROGRAM_ID);
        if (programs.length === 0) programs.push(...SPL_TOKEN_PROGRAM_IDS);

        for (const p of programs) {
          discovery.discoveryState.logSubscriptionControllers.push(
            await discovery.subscribeToProgramLogs(getCtx(), p, scheduleDiscoverySignalFlush)
          );
        }
        // Reset timer to avoid immediate re-trigger
        discovery.discoveryState.lastEventAt = Date.now();
      }
    } catch (e) {
      log(config.logFile, `WebSocket watchdog reconnect failed: ${e.message}`, 'error');
    }
  }, config.websocketWatchdogIntervalMs);
  websocketWatchdogInterval.unref?.();
}

/**
 * Decodes private key bytes from various formats (Base58 or JSON array).
 * @param {string} privateKeyText - The private key string.
 * @returns {Uint8Array} The decoded private key bytes.
 * @throws {Error} If the private key is missing or invalid.
 */
function decodePrivateKeyBytes(privateKeyText) {
  const trimmed = String(privateKeyText || '').trim();
  if (!trimmed) throw new Error('PRIVATE_KEY or PRIVATE_KEY_PATH is required.');
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    return Uint8Array.from(parsed);
  }
  const bs58 = require('bs58');
  return (bs58.decode || bs58.default?.decode)(trimmed);
}

/**
 * Scans for new token candidates and re-audits pending ones.
 * @param {string[]} [wsMints=null] - Optional array of mints discovered via WebSocket.
 * @param {Object} [wsLaunchpads=null] - Optional mapping of mints to their launchpad source.
 * @returns {Promise<void>}
 */
async function scanForCandidates(wsMints = null, wsLaunchpads = null) {
  const ctx = getCtx();
  let recentLaunches;
  try {
    recentLaunches = await services.fetchRecentLaunches(ctx);
    updateLaunchHistory(recentLaunches);
  } catch (e) {
    log(config.logFile, `Recent launches failed: ${e.message}`, 'warn');
    return;
  }

  refreshMarketSnapshots(recentLaunches);

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
      }
    }
  }

  const due = getDueCandidateRechecks();
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
      recordScanBackpressureEvent(false);
    } catch (err) {
      recordScanBackpressureEvent(isTransientOperationError(err));
      log(config.logFile, `Scan price refresh skipped: ${err.message}`, 'warn', { console: false });
    } finally {
      stageDurations.priceRefreshMs.push(Date.now() - priceRefreshStart);
    }
  }
  const lightConcurrency = getEffectiveParallelism(
    config.scanParallelismLight || config.maxConcurrentAudits || 1
  );
  const heavyConcurrency = getEffectiveParallelism(config.scanParallelismHeavy || 1);

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
        trackProcessedMint(token.id);
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
        trackProcessedMint(token.id);
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
            (BigInt(config.buyAmountLamports) * BigInt(Math.round(mood.sizeMultiplier * 100))) /
            100n;
          prefetchedQuotePromise = trading
            .fetchSwapOrder(ctx, constants.SOL_MINT, token.id, buyLamports.toString())
            .catch(() => null); // Silent catch, buyCandidate will retry if needed
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
      recordScanBackpressureEvent(false);

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
            trackProcessedMint(token.id);
          } else if (dropRatio > config.buyingTheTopSlPct / 100) {
            log(
              config.logFile,
              `[Rejected:BuyingTop] ${token.symbol} hit rug-guard (${(dropRatio * 100).toFixed(1)}% drop). Dropping permanently.`,
              'warn'
            );
            trackProcessedMint(token.id);
          } else {
            schedulePullbackRecheck(e, item.recheckEntry);
            log(
              config.logFile,
              `[PullbackWait] ${token.symbol} still at top; recheck in 10s.`,
              'info',
              { console: false }
            );
            return;
          }
        } else if (isRecheckEligible && config.borderlineRecheckEnabled) {
          scheduleRecheckEligibleWaitlist(e, item.recheckEntry, {
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
          trackProcessedMint(token.id);
        }

        if (item.recheckEntry?.isFinalAudit) {
          state.metrics.finalAuditRejected++;
        }
        if (item.kind === 'recheck') state.metrics.failedMomentum++;

        reasons.forEach((r) => {
          if (r.code)
            state.metrics.rejectionReasons[r.code] =
              (state.metrics.rejectionReasons[r.code] || 0) + 1;
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
        if (item.kind === 'discovery') state.metrics.discoveredCandidates++;
        state.metrics.passedCheapAudit++;
        scheduleSurvivalDelay(e);
        log(
          config.logFile,
          `${item.kind === 'discovery' ? 'Discovered' : 'Waitlist passed:'} ${token.symbol}; survival armed.`,
          'info',
          { console: false }
        );
        return;
      }

      if (item.recheckEntry?.isSurvivalWait) {
        state.metrics.passedSurvival++;
        state.metrics.finalAuditQueued++;
        scheduleFinalAudit(e, item.recheckEntry);
        log(
          config.logFile,
          `[finalAuditQueued] ${token.symbol} passed survival; fact-checking (5s)...`,
          'info'
        );
        return;
      }

      if (item.recheckEntry?.isFinalAudit) {
        state.metrics.finalAuditPassed++;
        log(config.logFile, `[finalAuditPassed] ${token.symbol} passed final audit.`, 'info');
      }

      if (!reserveBuySlot()) return;
      const buyStart = Date.now();
      try {
        const pos = await services.buyCandidate(ctx, e, prefetchedQuotePromise);
        stageDurations.buyAttemptMs.push(Date.now() - buyStart);
        trackProcessedMint(token.id);
        if (pos) {
          buys++;
          state.metrics.boughtPositions++;
          state.retiredMints.delete(token.id);
        }
      } finally {
        releaseBuySlot();
      }
    } catch (err) {
      recordScanBackpressureEvent(isTransientOperationError(err));
      const message = String(err?.message || err);
      if (!message.includes('RPC Indexing Lag')) {
        errors++;
        log(config.logFile, `Error processing ${token?.symbol || 'unknown'}: ${message}`, 'error');
      } else {
        rejected++;
        scheduleIndexingLagRetry(item, message);
      }
    }
  };

  await Promise.all([
    runBoundedPool(lightAudits, processItem, { concurrency: lightConcurrency }),
    runBoundedPool(heavyAudits, processItem, { concurrency: heavyConcurrency }),
  ]);

  log(
    config.logFile,
    `Scan stages: priceRefreshMs=${summarizeDurations(stageDurations.priceRefreshMs)}, directMarketMs=${summarizeDurations(stageDurations.directMarketMs)}, lightAuditMs=${summarizeDurations(stageDurations.lightAuditMs)}, heavyAuditMs=${summarizeDurations(stageDurations.heavyAuditMs)}, buyAttemptMs=${summarizeDurations(stageDurations.buyAttemptMs)}, concurrency=light:${lightConcurrency}/${config.scanParallelismLight || config.maxConcurrentAudits || 1},heavy:${heavyConcurrency}/${config.scanParallelismHeavy || 1}, backpressure=${scanBackpressure.factor.toFixed(2)}`,
    'debug',
    { console: false }
  );

  await persistState();
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
 * @param {Object} evaluation - The candidate evaluation object.
 * @param {Object} oldEntry - The previous recheck entry.
 */
function schedulePullbackRecheck(evaluation, oldEntry) {
  const entry = {
    ...(oldEntry || {}),
    mint: evaluation.token.id,
    tokenSnapshot: evaluation.token,
    nextEligibleAt: new Date(Date.now() + 10000).toISOString(),
    isWaitlist: false,
    isSurvivalWait: false,
    isFinalAudit: true,
  };
  state.pendingCandidateRechecks.set(entry.mint, entry);
}

/**
 * Schedules a recheck for a token that failed with a recheck-eligible reason.
 * @param {Object} evaluation - The candidate evaluation object.
 * @param {Object} oldEntry - The previous recheck entry.
 */
function scheduleRecheckEligibleWaitlist(evaluation, oldEntry, options = {}) {
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
  state.pendingCandidateRechecks.set(entry.mint, entry);
}

/**
 * Schedules a survival delay for a newly discovered token.
 * @param {Object} evaluation - The candidate evaluation object.
 */
function scheduleSurvivalDelay(evaluation) {
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
  state.pendingCandidateRechecks.set(entry.mint, entry);
}

/**
 * Schedules a final security audit for a token that passed survival delay.
 * @param {Object} evaluation - The candidate evaluation object.
 * @param {Object} oldEntry - The previous recheck entry.
 */
function scheduleFinalAudit(evaluation, oldEntry) {
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
  state.pendingCandidateRechecks.set(entry.mint, entry);
}

const MAX_INDEXING_LAG_RETRIES = 3;

/**
 * Schedules a retry for a token recheck that failed due to RPC indexing lag.
 * @param {Object} item - The scan work item.
 * @param {string} [message='RPC Indexing Lag'] - Error message.
 */
function scheduleIndexingLagRetry(item, message = 'RPC Indexing Lag') {
  const existing = item?.recheckEntry;
  const token = item?.token;
  const mint = existing?.mint || token?.id;
  if (!mint) return;

  if (existing?.isFinalAudit) {
    state.metrics.finalAuditDeferredIndexing++;
  }

  const currentRetries = Number(existing?.indexingLagRetries || 0);

  if (currentRetries >= MAX_INDEXING_LAG_RETRIES) {
    state.pendingCandidateRechecks.delete(mint);
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
  state.pendingCandidateRechecks.set(mint, entry);
  log(
    config.logFile,
    `[${existing?.isFinalAudit ? 'finalAuditDeferredIndexing' : 'IndexingLag'}] Deferred ${token?.symbol || mint} after indexing lag; retry in ${Math.round(delayMs / 1000)}s (attempt ${currentRetries + 1}/${MAX_INDEXING_LAG_RETRIES}). ${message}`,
    'debug',
    { console: false }
  );
}

/**
 * Filters the pending rechecks that are eligible for processing now.
 * @returns {Object[]} Array of due recheck entries.
 */
function getDueCandidateRechecks() {
  const now = Date.now();
  return Array.from(state.pendingCandidateRechecks.values()).filter(
    (e) => !e.nextEligibleAt || new Date(e.nextEligibleAt).getTime() <= now
  );
}

/**
 * Refreshes market snapshots with new data and purges stale ones.
 * @param {Object[]} launches - Array of recent token launches.
 */
function refreshMarketSnapshots(launches) {
  const now = Date.now();
  for (const t of launches)
    if (t?.id)
      state.marketSnapshots.set(t.id, {
        liquidity: Number(t.liquidity || 0),
        usdPrice: Number(t.usdPrice || 0),
        observedAt: new Date().toISOString(),
      });
  for (const [m, s] of state.marketSnapshots.entries()) {
    if (state.positions.has(m) || state.pendingCandidateRechecks.has(m)) continue;
    if (now - new Date(s.observedAt).getTime() > MARKET_SNAPSHOT_RETENTION_MS)
      state.marketSnapshots.delete(m);
  }
}

let monitorLoopBusy = false;
let discoveryLoopBusy = false;

/**
 * Executes the monitor loop to check and manage open positions.
 * @returns {Promise<void>}
 */
async function runMonitorLoop() {
  if (monitorLoopBusy || shouldStop) return;
  monitorLoopBusy = true;
  try {
    await services.monitorPositions(getCtx());
  } catch (e) {
    log(config.logFile, `Monitor loop error: ${e.message}`, 'error');
  } finally {
    monitorLoopBusy = false;
  }
}

/**
 * Executes the discovery loop to find and evaluate new token candidates.
 * @param {boolean|Object} [trigger=false] - Optional trigger info (forced scan or WebSocket mints).
 * @returns {Promise<void>}
 */
async function runDiscoveryLoop(trigger = false) {
  if (discoveryLoopBusy || shouldStop) return;
  discoveryLoopBusy = true;
  try {
    const mood = services.getMoodAdjustments(getCtx());
    processCoolDowns();

    const isForced = trigger === true || (typeof trigger === 'object' && trigger.forceDiscovery);
    const reason =
      typeof trigger === 'object' ? trigger.reason : trigger === true ? 'manual-force' : 'poll';

    if (!mood.isPaused || isForced) {
      if (isForced)
        log(config.logFile, `Triggering forced discovery scan (reason: ${reason}).`, 'debug');
      const wsMints = typeof trigger === 'object' ? trigger.mints : null;
      const wsLaunchpads = typeof trigger === 'object' ? trigger.mintLaunchpads : null;
      await scanForCandidates(wsMints, wsLaunchpads);
    }
  } catch (e) {
    log(config.logFile, `Discovery loop error: ${e.message}`, 'error');
  } finally {
    discoveryLoopBusy = false;
  }
}

/**
 * Main entry point for the bot. Initializes configuration, services, and starts loops.
 * @returns {Promise<void>}
 */
async function main() {
  const loadedConfig = loadConfig();
  validateStartupConfig(loadedConfig);
  config = loadedConfig;
  const pk =
    config.privateKey ||
    (config.privateKeyPath ? fs.readFileSync(config.privateKeyPath, 'utf8') : '');
  wallet = await createKeyPairSignerFromBytes(decodePrivateKeyBytes(pk));

  // Initialize RPC and Subscription Pools
  rpcs = config.rpcUrls.map((url) => createSolanaRpc(url));
  rpcSubscriptionPool = config.wsRpcUrls.map((url) => createSolanaRpcSubscriptions(url));

  // Backwards compatibility for single rpc/subs
  rpc = rpcs[0];
  rpcSubscriptions = rpcSubscriptionPool[0];

  state = loadState(config.stateFile);

  const mode = config.paperTrading ? 'PAPER' : config.dryRun ? 'DRY-RUN' : 'LIVE';
  log(
    config.logFile,
    `Bot started [${mode} MODE][${config.strategyName} strategy]. Wallet: ...${wallet.address.slice(-5)}. Buy Amount: ${config.buyAmountSolText} SOL`,
    'info',
    { console: true }
  );

  if (config.discoveryWsEnabled) {
    const programs = [];
    if (config.discoveryPumpEnabled) programs.push(PUMP_FUN_PROGRAM_ID);
    if (config.discoveryRaydiumEnabled) programs.push(RAYDIUM_AMM_V4_PROGRAM_ID);
    if (config.discoveryMeteoraEnabled) programs.push(METEORA_DLMM_PROGRAM_ID);
    if (programs.length === 0) programs.push(...SPL_TOKEN_PROGRAM_IDS);
    for (const p of programs) {
      discovery.discoveryState.logSubscriptionControllers.push(
        await discovery.subscribeToProgramLogs(getCtx(), p, scheduleDiscoverySignalFlush)
      );
    }
  }
  startWebsocketWatchdog();

  // 1. Initial Discovery Scan
  await runDiscoveryLoop(true);

  // 2. Start Monitor Loop (Fast Interval)
  const monitorTimer = setInterval(() => runMonitorLoop(), Math.min(2000, config.scanIntervalMs));

  // 3. Start Discovery Loop (Configured Interval)
  const discoveryTimer = setInterval(() => runDiscoveryLoop(), config.discoveryPollIntervalMs);

  // 4. Wait for shutdown
  try {
    while (!shouldStop) {
      try {
        await sleep(1000, undefined, { signal: shutdownController.signal });
      } catch (error) {
        if (error?.name !== 'AbortError') throw error;
      }
    }
  } finally {
    log(config.logFile, 'Shutting down services firmly...', 'warn', { console: true });
    clearInterval(monitorTimer);
    clearInterval(discoveryTimer);
    if (discovery.discoveryState.debounceTimer)
      clearTimeout(discovery.discoveryState.debounceTimer);
    discovery.discoveryState.logSubscriptionControllers.forEach((c) => c.abort());
    if (websocketWatchdogInterval) clearInterval(websocketWatchdogInterval);

    if (config.closePositionsOnShutdown) {
      await services.closeAllOpenPositions(getCtx());
    } else {
      log(
        config.logFile,
        'Leaving open positions untouched on shutdown by configuration.',
        'warn',
        {
          console: true,
        }
      );
    }

    await persistState({ force: true });
    log(config.logFile, 'Shutdown complete. Bye!', 'info', { console: true });
    process.exit(0);
  }
}

const handleShutdown = (sig) => {
  if (shutdownRequested) process.exit(130);
  shutdownRequested = true;
  log(
    config?.logFile || './bot-error.log',
    `Shutdown signal ${sig} received. Terminating all services firmly.`,
    'warn',
    { console: true, sync: true }
  );

  // Force exit after 5s if graceful shutdown hangs
  setTimeout(() => {
    log(config?.logFile || './bot-error.log', 'Shutdown timed out. Force exiting.', 'error', {
      console: true,
      sync: true,
    });
    process.exit(1);
  }, 5000).unref();

  shouldStop = true;
  shutdownController.abort();
};
process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

if (require.main === module) {
  main().catch((e) => {
    log(
      typeof config !== 'undefined' && config.logFile ? config.logFile : './bot-error.log',
      e.stack || e.message,
      'error'
    );
    process.exitCode = 1;
  });
}

module.exports = {
  getCtx,
  loadState,
  persistState,
  trackProcessedMint,
  untrackProcessedMint,
  _setTestConfig,
  _setTestState,
  processCoolDowns,
  scheduleDiscoverySignalFlush,
  startWebsocketWatchdog,
  decodePrivateKeyBytes,
  scanForCandidates,
  schedulePullbackRecheck,
  scheduleRecheckEligibleWaitlist,
  scheduleSurvivalDelay,
  scheduleFinalAudit,
  scheduleIndexingLagRetry,
  getDueCandidateRechecks,
  refreshMarketSnapshots,
  runMonitorLoop,
  runDiscoveryLoop,
  main,
};
