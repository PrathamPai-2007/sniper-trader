import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { createSolanaRpc } from '@solana/rpc';
import { createSolanaRpcSubscriptions } from '@solana/rpc-subscriptions';
import { createKeyPairSignerFromBytes } from '@solana/signers';
import bs58 from 'bs58';

import { sleep, log, atomicToDecimalString } from './core/utils.js';
import { loadConfig, validateStartupConfig } from './core/config.js';
import { StateStore } from './core/store.js';
import * as services from './services/services.js';
import * as discovery from './services/discovery/discovery.service.js';
import * as scanner from './services/scanner/scanner.service.js';
import { Config, State, Context } from './types/index.js';
import {
  PUMP_FUN_PROGRAM_ID,
  RAYDIUM_AMM_V4_PROGRAM_ID,
  METEORA_DLMM_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_IDS,
} from './core/config.js';

// Enforce default max listeners for event-heavy environments
EventEmitter.defaultMaxListeners = 100;

export const shutdownController = new AbortController();

export let config: Config;
export let wallet: { address: string; keypair?: any };
export let rpc: any;
export let rpcSubscriptions: any;
export let state: State;
export let store: StateStore;

export let rpcs: any[] = [];
export let rpcSubscriptionPool: any[] = [];
export let shouldStop = false;
export let shutdownRequested = false;
export let websocketWatchdogInterval: NodeJS.Timeout | null = null;

export const scanBackpressure = {
  events: [] as { error: boolean; at: number }[],
  factor: 1,
};

/**
 * Records a scan backpressure event to adjust parallelism based on error rates.
 * @param error - The error encountered or a boolean indicating success/failure.
 */
export function recordScanBackpressureEvent(error: any): void {
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
 * @param base - The base parallelism value.
 * @returns The adjusted parallelism value.
 */
export function getEffectiveParallelism(base: number): number {
  const numericBase = Math.max(1, Math.floor(Number(base) || 1));
  return Math.max(1, Math.floor(numericBase * scanBackpressure.factor));
}

/**
 * Internal helper for testing to inject a mock configuration.
 */
export function _setTestConfig(mockConfig: Config): void {
  config = mockConfig;
}

/**
 * Internal helper for testing to inject a mock state.
 * @param mockState - The mock state object.
 */
export function _setTestState(mockState: State): void {
  state = mockState;
}

/**
 * Constructs the execution context (ctx) used across the application.
 * @returns The context object containing config, wallet, rpc, state, and logging utilities.
 */
export function getCtx(): Context {
  return {
    config,
    wallet,
    rpc,
    rpcs,
    rpcSubscriptions,
    rpcSubscriptionPool,
    state,
    store,
    calculateGMI: store ? store.calculateGMI.bind(store) : () => 0.5,
    logger: (msg: string, lvl?: string, opts?: any) => {
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
    persistState: (opts: any) => store.persist(opts),
    // Dynamic/Backpressure extensions
    recordScanBackpressureEvent,
    getEffectiveParallelism,
    scanBackpressureFactor: scanBackpressure.factor,
  };
}

/**
 * Processes active cool-downs and moves expired entries to retired state.
 */
export function processCoolDowns(): void {
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
export function scheduleDiscoverySignalFlush(): void {
  if (discovery.discoveryState.debounceTimer) return;
  discovery.discoveryState.debounceTimer = setTimeout(() => {
    discovery.discoveryState.debounceTimer = null;
    void discovery.flushDiscoverySignals(getCtx(), (meta) => runDiscoveryLoop(meta));
  }, config.discoveryWsDebounceMs);
}

/**
 * Starts a watchdog to monitor WebSocket health and reconnect if stale.
 */
export function startWebsocketWatchdog(): void {
  if (!config.discoveryWsEnabled) return;
  if (websocketWatchdogInterval) clearInterval(websocketWatchdogInterval);
  websocketWatchdogInterval = setInterval(async () => {
    try {
      if (!config.discoveryWsEnabled) return;

      let stale = false;
      const stalePrograms: string[] = [];
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

        discovery.discoveryState.logSubscriptionControllers.forEach((c) => c.abort());
        discovery.discoveryState.logSubscriptionControllers = [];

        const programs: string[] = [];
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
    } catch (e: any) {
      log(config.logFile, `WebSocket watchdog reconnect failed: ${e.message}`, 'error');
    }
  }, config.websocketWatchdogIntervalMs);
  websocketWatchdogInterval.unref?.();
}

/**
 * Decodes private key bytes from various formats (Base58 or JSON array).
 * @param privateKeyText - The private key string.
 * @returns The decoded private key bytes.
 */
export function decodePrivateKeyBytes(privateKeyText: string): Uint8Array {
  const trimmed = String(privateKeyText || '').trim();
  if (!trimmed) throw new Error('PRIVATE_KEY or PRIVATE_KEY_PATH is required.');
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    return Uint8Array.from(parsed);
  }
  return (bs58.decode || (bs58 as any).default?.decode)(trimmed);
}

/**
 * Scans for new token candidates and re-audits pending ones.
 * @param wsMints - Optional array of mints discovered via WebSocket.
 * @param wsLaunchpads - Optional mapping of mints to their launchpad source.
 */
export async function scanForCandidates(
  wsMints: string[] | null = null,
  wsLaunchpads: Record<string, string> | null = null
): Promise<void> {
  return scanner.scanForCandidates(getCtx(), wsMints, wsLaunchpads);
}

export let monitorLoopBusy = false;
export let discoveryLoopBusy = false;

/**
 * Executes the monitor loop to check and manage open positions.
 */
export async function runMonitorLoop(): Promise<void> {
  if (monitorLoopBusy || shouldStop) return;
  monitorLoopBusy = true;
  try {
    await services.monitorPositions(getCtx());
  } catch (e: any) {
    log(config.logFile, `Monitor loop error: ${e.message}`, 'error');
  } finally {
    monitorLoopBusy = false;
  }
}

/**
 * Executes the discovery loop to find and evaluate new token candidates.
 * @param trigger - Optional trigger info (forced scan or WebSocket mints).
 */
export async function runDiscoveryLoop(trigger: boolean | any = false): Promise<void> {
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
  } catch (e: any) {
    log(config.logFile, `Discovery loop error: ${e.message}`, 'error');
  } finally {
    discoveryLoopBusy = false;
  }
}

/**
 * Main entry point for the bot. Initializes configuration, services, and starts loops.
 */
export async function main(): Promise<void> {
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

  rpcs = config.rpcUrls.map((url) => createSolanaRpc(url));
  rpcSubscriptionPool = config.wsRpcUrls.map((url) => createSolanaRpcSubscriptions(url));

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
    const programs: string[] = [];
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

  await runDiscoveryLoop(true);

  const monitorTimer = setInterval(() => runMonitorLoop(), Math.min(2000, config.scanIntervalMs));
  const discoveryTimer = setInterval(() => runDiscoveryLoop(), config.discoveryPollIntervalMs);

  try {
    while (!shouldStop) {
      try {
        await sleep(1000);
      } catch (error) {
        // Silently capture aborts or loops
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
        { console: true }
      );
    }

    store.requestShutdown();
    await store.persist({ force: true });
    log(config.logFile, 'Shutdown complete. Bye!', 'info', { console: true });
    process.exit(0);
  }
}

const handleShutdown = (sig: string): void => {
  if (shutdownRequested) process.exit(130);
  shutdownRequested = true;
  log(
    config?.logFile || './bot-error.log',
    `Shutdown signal ${sig} received. Terminating all services firmly.`,
    'warn',
    { console: true, sync: true }
  );

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

// Trigger execution if run as primary entry point
const isMain =
  process.argv[1] &&
  (__filename === fs.realpathSync(process.argv[1]) ||
    (typeof require !== 'undefined' && require.main === module));
if (isMain) {
  main().catch((e) => {
    log(config?.logFile || './bot-error.log', e.stack || e.message, 'error');
    process.exitCode = 1;
  });
}
