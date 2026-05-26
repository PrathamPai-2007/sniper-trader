'use strict';

// Main runtime orchestrator: boots config/wallet/RPC, runs discovery + monitor loops,
// persists bot state, manages websocket watchdogs, and handles graceful shutdown.

const fs = require('node:fs');
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
const { sleep, log, atomicToDecimalString } = require('./utils');
const { constants, loadConfig, validateStartupConfig } = require('./config');
const StateStore = require('./store');
const services = require('./services');
const discovery = require('./discovery');
const scanner = require('./scanner');

const {
  SPL_TOKEN_PROGRAM_IDS,
  PUMP_FUN_PROGRAM_ID,
  RAYDIUM_AMM_V4_PROGRAM_ID,
  METEORA_DLMM_PROGRAM_ID,
} = constants;

let config, wallet, rpc, rpcSubscriptions, state, store;
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
 * Internal helper for testing to inject a mock configuration.
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
    store,
    constants,
    calculateGMI: store ? store.calculateGMI.bind(store) : () => 0.5,
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
    persistState: (opts) => store.persist(opts),
    recordScanBackpressureEvent,
    getEffectiveParallelism,
    scanBackpressureFactor: scanBackpressure.factor,
  };
}

/**
 * Processes active cool-downs and moves expired entries to retired state.
 */
function processCoolDowns() {
  const now = Date.now();
  for (const [mint, entry] of state.coolDownMints.entries()) {
    if (now >= entry.expiresAt) {
      store.removeCoolDown(mint);
      store.retireMint(mint, { lastExitPriceUsd: entry.lastExitPriceUsd });
      store.untrackMint(mint);
      log(config.logFile, `Cool-down expired for ${mint}.`, 'info');
    }
  }
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

      let stale = false;
      const stalePrograms = [];
      const now = Date.now();

      for (const [programId, lastSeen] of discovery.discoveryState.lastEventAt.entries()) {
        const idleTime = now - lastSeen;
        if (idleTime > config.websocketStaleThresholdMs) {
          stale = true;
          stalePrograms.push(programId);
        }
      }

      if (stale) {
        log(
          config.logFile,
          `WebSocket stream is STALE for programs: ${stalePrograms.join(', ')}. Attempting RECONNECT...`,
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
  return scanner.scanForCandidates(getCtx(), wsMints, wsLaunchpads);
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

  store = new StateStore(config);
  store.load(config.stateFile);
  state = store.state;

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

    store.requestShutdown();
    await store.persist({ force: true });
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
  _setTestConfig,
  _setTestState,
  processCoolDowns,
  scheduleDiscoverySignalFlush,
  startWebsocketWatchdog,
  decodePrivateKeyBytes,
  scanForCandidates,
  runMonitorLoop,
  runDiscoveryLoop,
  main,
};
