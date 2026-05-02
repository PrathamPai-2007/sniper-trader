'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { Connection, PublicKey } = require('@solana/web3.js');
const { 
  log, 
  ensureParentDirectory, 
  formatUsd, 
  atomicToDecimalString,
  deriveWsRpcUrl,
  isTransientOperationError
} = require('./utils');
const { constants, loadConfig, validateStartupConfig } = require('./config');
const services = require('./services');

const {
  SOL_MINT,
  MAX_TRACKED_MINTS,
  SPL_TOKEN_PROGRAM_IDS,
  INITIALIZE_MINT_LOG_PATTERN,
  DISCOVERY_SIGNAL_RETENTION_MS,
  MARKET_SNAPSHOT_RETENTION_MS
} = constants;

// --- Global State ---

let config, wallet, connection, state, paperAnalytics;
let discoveryState = {
  debounceTimer: null,
  pendingSignatures: new Set(),
  recentSignalMints: new Map(),
  logSubscriptionIds: [],
  websocketReady: false,
};
let loopBusy = false;
let pendingLoopRequest = null;
let lastDiscoveryScanAt = 0;
let shouldStop = false;
let shutdownRequested = false;

// --- Context Builder ---

function getCtx() {
  return {
    config,
    wallet,
    connection,
    state,
    constants,
    logger: (msg, lvl, opts) => log(config.logFile, msg, lvl, opts),
    persistState,
  };
}

// --- Persistence ---

function loadState(stateFile) {
  const baseState = {
    processedMintQueue: [],
    processedMints: new Set(),
    pendingCandidateRechecks: new Map(),
    positions: new Map(),
    marketSnapshots: new Map(),
    paperSolBalanceLamports: config.initialPaperSolLamports,
    tradeHistory: [],
    moodPauseUntil: null,
    coolDownMints: new Map(),
    retiredMints: new Map(),
    metrics: {
      passedAudit: 0,
      failedMomentum: 0,
      buyAttempts: 0,
      buyFailures: 0,
      profitableTrades: 0,
      stopLosses: 0,
      trailingExits: 0,
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
    const rechecks = Array.isArray(parsed.pendingCandidateRechecks) ? parsed.pendingCandidateRechecks : [];
    const metrics = { ...baseState.metrics, ...(parsed.metrics || {}) };
    
    return {
      processedMintQueue: queue,
      processedMints: new Set(queue),
      pendingCandidateRechecks: new Map(rechecks.filter(e => e?.mint).map(e => [e.mint, e])),
      positions: new Map(positions.map(p => [p.mint, p])),
      marketSnapshots: new Map(),
      paperSolBalanceLamports: parsed.paperSolBalanceLamports || config.initialPaperSolLamports,
      tradeHistory: Array.isArray(parsed.tradeHistory) ? parsed.tradeHistory : [],
      moodPauseUntil: parsed.moodPauseUntil || null,
      coolDownMints: new Map(Object.entries(parsed.coolDownMints || {})),
      retiredMints: new Map(Object.entries(parsed.retiredMints || {})),
      metrics,
    };
  } catch (e) {
    log(config.logFile, `Failed to load state: ${e.message}`, 'warn');
    return baseState;
  }
}

function persistState() {
  if (!config.stateFile) return;
  const resolvedPath = path.resolve(config.stateFile);
  ensureParentDirectory(resolvedPath);
  const payload = {
    processedMintQueue: state.processedMintQueue,
    pendingCandidateRechecks: Array.from(state.pendingCandidateRechecks.values()),
    positions: Array.from(state.positions.values()),
    paperSolBalanceLamports: state.paperSolBalanceLamports,
    tradeHistory: state.tradeHistory,
    moodPauseUntil: state.moodPauseUntil,
    coolDownMints: Object.fromEntries(state.coolDownMints),
    retiredMints: Object.fromEntries(state.retiredMints),
    metrics: state.metrics,
  };
  fs.writeFileSync(resolvedPath, JSON.stringify(payload, null, 2));
  persistMetrics();
}

function persistMetrics() {
  if (!config.metricsFile) return;
  ensureParentDirectory(config.metricsFile);
  fs.writeFileSync(path.resolve(config.metricsFile), JSON.stringify(state.metrics, null, 2));
}

// --- Discovery Management ---

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

function untrackProcessedMint(mint) {
  state.processedMints.delete(mint);
  state.pendingCandidateRechecks.delete(mint);
  state.processedMintQueue = state.processedMintQueue.filter((m) => m !== mint);
}

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

function handleDiscoveryProgramLog(logInfo) {
  if (!config.discoveryWsEnabled || shouldStop) return;
  if (!logInfo?.signature || !Array.isArray(logInfo.logs)) return;
  if (!logInfo.logs.some((line) => INITIALIZE_MINT_LOG_PATTERN.test(line))) return;
  discoveryState.pendingSignatures.add(logInfo.signature);
  scheduleDiscoverySignalFlush();
}

function scheduleDiscoverySignalFlush() {
  if (discoveryState.debounceTimer) return;
  discoveryState.debounceTimer = setTimeout(() => {
    discoveryState.debounceTimer = null;
    void flushDiscoverySignals();
  }, config.discoveryWsDebounceMs);
}

async function flushDiscoverySignals() {
  const signatures = Array.from(discoveryState.pendingSignatures);
  discoveryState.pendingSignatures.clear();
  if (signatures.length === 0 || shouldStop) return;

  const parsedTransactions = await Promise.all(signatures.map(async (sig) => {
    try { return await connection.getParsedTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); }
    catch (e) { return null; }
  }));

  const now = Date.now();
  const pendingMints = [];
  for (const tx of parsedTransactions) {
    if (!tx) continue;
    const mints = extractInitializedMints(tx);
    for (const mint of mints) {
      if (state.processedMints.has(mint)) continue;
      const lastSeen = discoveryState.recentSignalMints.get(mint) || 0;
      if (now - lastSeen < DISCOVERY_SIGNAL_RETENTION_MS) continue;
      discoveryState.recentSignalMints.set(mint, now);
      pendingMints.push(mint);
    }
  }

  if (pendingMints.length > 0) {
    await runLoop({ reason: 'ws-mint-init', forceDiscovery: true, skipMonitor: true, websocketSignalCount: pendingMints.length });
  }
}

function extractInitializedMints(tx) {
  const mints = new Set();
  const collect = (ixs) => {
    if (!Array.isArray(ixs)) return;
    for (const ix of ixs) {
      const type = String(ix?.parsed?.type || '').toLowerCase();
      const mint = ix?.parsed?.info?.mint;
      if ((type === 'initializemint' || type === 'initializemint2') && typeof mint === 'string') mints.add(mint);
    }
  };
  collect(tx?.transaction?.message?.instructions);
  (tx?.meta?.innerInstructions || []).forEach(g => collect(g?.instructions));
  return Array.from(mints);
}

// --- Core Loop ---

async function scanForCandidates(trigger = {}) {
  const ctx = getCtx();
  let recentLaunches;
  try { recentLaunches = await services.fetchRecentLaunches(ctx); }
  catch (e) { log(config.logFile, `Recent launches failed: ${e.message}`, 'warn'); return; }
  
  lastDiscoveryScanAt = Date.now();
  refreshMarketSnapshots(recentLaunches);

  const launchesByMint = new Map(recentLaunches.filter(t => t?.id).map(t => [t.id, t]));
  for (const [mint, token] of launchesByMint) {
    const entry = state.pendingCandidateRechecks.get(mint);
    if (entry) {
      const p = Number(token.usdPrice || 0);
      if (p > 0) {
        entry.highestSeenPriceUsd = Math.max(entry.highestSeenPriceUsd || 0, p);
        entry.priceHistory = entry.priceHistory || [];
        entry.priceHistory.push({ price: p, timestamp: Date.now() });
        entry.tapeHistory = entry.tapeHistory || [];
        entry.tapeHistory.push({ buys: Number(token.stats5m?.numBuys || 0), sells: Number(token.stats5m?.numSells || 0), timestamp: Date.now() });
        const cutoff = Date.now() - 60000;
        entry.priceHistory = entry.priceHistory.filter(h => h.timestamp > cutoff);
        entry.tapeHistory = entry.tapeHistory.filter(h => h.timestamp > cutoff);
      }
    }
  }

  const due = getDueCandidateRechecks();
  const discoveryItems = recentLaunches
    .filter(t => t?.id && !state.processedMints.has(t.id) && !state.pendingCandidateRechecks.has(t.id))
    .slice(0, config.maxCandidatesPerScan)
    .map(t => ({ kind: 'discovery', token: t }));
  const workItems = [...due.map(e => ({ kind: 'recheck', recheckEntry: e, token: launchesByMint.get(e.mint) || e.tokenSnapshot })), ...discoveryItems];

  let buys = 0, rejected = 0, errors = 0;
  for (const item of workItems) {
    if (state.positions.size >= config.maxOpenPositions || buys >= config.maxBuysPerScan) break;
    const token = item.token;
    try {
      const e = await services.evaluateCandidate(ctx, token, item.recheckEntry?.highestSeenPriceUsd, item.recheckEntry?.priceHistory, item.recheckEntry?.priceAtStartOfDelay, item.recheckEntry?.liquidityAtStartOfDelay, item.recheckEntry?.tapeAtStart, item.recheckEntry?.tapeHistory);
      if (!e.approved) {
        if (services.shouldScheduleBorderlineRecheck?.(e, item.recheckEntry)) { /* logic for recheck */ }
        rejected++; trackProcessedMint(token.id);
        if (item.kind === 'recheck') state.metrics.failedMomentum++;
        if (Array.isArray(e.rejectionReasons)) e.rejectionReasons.forEach(r => { if (r.code) state.metrics.rejectionReasons[r.code] = (state.metrics.rejectionReasons[r.code] || 0) + 1; });
        log(config.logFile, `Rejected ${token.symbol}: ${e.blockers.join(' | ')}`, 'warn', { console: false });
        persistState(); continue;
      }
      if (item.kind === 'discovery' && config.survivalDelaySeconds > 0) {
        scheduleSurvivalDelay(e); log(config.logFile, `Discovered ${token.symbol}; delay armed.`, 'info'); persistState(); continue;
      }
      const pos = await services.buyCandidate(ctx, e);
      if (item.kind === 'discovery' && config.survivalDelaySeconds <= 0) state.metrics.passedAudit++;
      trackProcessedMint(token.id);
      if (pos) { buys++; state.retiredMints.delete(token.id); }
      persistState();
    } catch (err) {
      errors++;
      log(config.logFile, `Error processing ${token?.symbol || 'unknown'}: ${err.message}`, 'error');
    }
  }
  if (workItems.length > 0) log(config.logFile, `Scan: buys=${buys}, rej=${rejected}, err=${errors}, pos=${state.positions.size}`, 'info', { console: true });
}

function scheduleSurvivalDelay(evaluation) {
  state.metrics.passedAudit++;
  const delayMs = config.survivalDelaySeconds * 1000;
  const entry = {
    mint: evaluation.token.id, tokenSnapshot: evaluation.token, attempts: 0, nextEligibleAt: new Date(Date.now() + delayMs).toISOString(),
    highestSeenPriceUsd: Number(evaluation.token.usdPrice || 0), priceAtStartOfDelay: Number(evaluation.token.usdPrice || 0),
    liquidityAtStartOfDelay: Number(evaluation.token.liquidity || 0), priceHistory: [{ price: Number(evaluation.token.usdPrice || 0), timestamp: Date.now() }],
    tapeAtStart: { buys: Number(evaluation.token.stats5m?.numBuys || 0), sells: Number(evaluation.token.stats5m?.numSells || 0) },
    tapeHistory: [{ buys: Number(evaluation.token.stats5m?.numBuys || 0), sells: Number(evaluation.token.stats5m?.numSells || 0), timestamp: Date.now() }],
    isSurvivalWait: true
  };
  state.pendingCandidateRechecks.set(entry.mint, entry);
}

function getDueCandidateRechecks() {
  const now = Date.now();
  return Array.from(state.pendingCandidateRechecks.values()).filter(e => !e.nextEligibleAt || new Date(e.nextEligibleAt).getTime() <= now);
}

function refreshMarketSnapshots(launches) {
  const now = Date.now();
  for (const t of launches) if (t?.id) state.marketSnapshots.set(t.id, { liquidity: Number(t.liquidity || 0), usdPrice: Number(t.usdPrice || 0), observedAt: new Date().toISOString() });
  for (const [m, s] of state.marketSnapshots.entries()) {
    if (state.positions.has(m) || state.pendingCandidateRechecks.has(m)) continue;
    if (now - new Date(s.observedAt).getTime() > MARKET_SNAPSHOT_RETENTION_MS) state.marketSnapshots.delete(m);
  }
}

async function runLoop(request = {}) {
  if (loopBusy) { pendingLoopRequest = services.mergeLoopRequest?.(pendingLoopRequest, request); return; }
  loopBusy = true;
  try {
    const mood = services.getMoodAdjustments(getCtx());
    processCoolDowns();
    if (!request.skipMonitor) await services.monitorPositions(getCtx());
    if (!mood.isPaused || request.forceDiscovery) {
      if (request.forceDiscovery || lastDiscoveryScanAt === 0 || Date.now() - lastDiscoveryScanAt >= config.discoveryPollIntervalMs) await scanForCandidates(request);
    }
  } catch (e) { log(config.logFile, `Loop error: ${e.message}`, 'error'); }
  finally { loopBusy = false; }
  if (pendingLoopRequest && !shouldStop) { const next = pendingLoopRequest; pendingLoopRequest = null; setImmediate(() => runLoop(next)); }
}

async function main() {
  validateStartupConfig();
  config = loadConfig();
  const bs58Module = require('bs58');
  const bs58 = bs58Module.default || bs58Module;
  const pk = config.privateKey || (config.privateKeyPath ? fs.readFileSync(config.privateKeyPath, 'utf8') : '');
  const { Keypair } = require('@solana/web3.js');
  wallet = Keypair.fromSecretKey(bs58.decode(pk.trim()));
  connection = new Connection(config.rpcUrl, { commitment: 'confirmed', wsEndpoint: config.wsRpcUrl });
  state = loadState(config.stateFile);

  log(config.logFile, `Bot started. Wallet: ${wallet.publicKey.toBase58()}`);
  
  for (const pId of SPL_TOKEN_PROGRAM_IDS) {
    const subId = connection.onLogs(pId, handleDiscoveryProgramLog, 'confirmed');
    discoveryState.logSubscriptionIds.push(subId);
  }

  await runLoop({ reason: 'startup', forceDiscovery: true });
  while (!shouldStop) {
    await sleep(config.scanIntervalMs);
    if (!shouldStop) await runLoop({ reason: 'tick' });
  }

  await Promise.all(discoveryState.logSubscriptionIds.map(id => connection.removeOnLogsListener(id)));
  await services.closeAllOpenPositions(getCtx());
  persistState();
}

const handleShutdown = (sig) => {
  if (shutdownRequested) return;
  shutdownRequested = true;
  log(config.logFile, `Shutdown signal ${sig} received.`, 'warn', { console: true });
  shouldStop = true;
};

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

main().catch(e => { log(config?.logFile, e.stack || e.message, 'error'); process.exitCode = 1; });
