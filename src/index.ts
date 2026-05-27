import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { Rpc, SolanaRpcApi, createSolanaRpc } from '@solana/rpc';
import {
  RpcSubscriptions,
  SolanaRpcSubscriptionsApi,
  createSolanaRpcSubscriptions,
} from '@solana/rpc-subscriptions';
import { createKeyPairSignerFromBytes, KeyPairSigner } from '@solana/signers';
import bs58 from 'bs58';

import { sleep, log, atomicToDecimalString } from './core/utils.js';
import {
  loadConfig,
  validateStartupConfig,
  PUMP_FUN_PROGRAM_ID,
  RAYDIUM_AMM_V4_PROGRAM_ID,
  METEORA_DLMM_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_IDS,
} from './core/config.js';
import { StateStore } from './core/store.js';
import * as services from './services/services.js';
import * as discovery from './services/discovery/discovery.service.js';
import * as scanner from './services/scanner/scanner.service.js';
import { Config, State, Context } from './types/index.js';

// Enforce default max listeners for event-heavy environments
EventEmitter.defaultMaxListeners = 100;

export const shutdownController = new AbortController();

export let config: Config;
export let wallet: { address: string; keypair?: unknown };
export let rpc: Rpc<SolanaRpcApi>;
export let rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
export let state: State;
export let store: StateStore;

export let rpcs: Rpc<SolanaRpcApi>[] = [];
export let rpcSubscriptionPool: RpcSubscriptions<SolanaRpcSubscriptionsApi>[] = [];

/**
 * Internal helper for testing to inject a mock configuration.
 */
export function _setTestConfig(mockConfig: Config): void {
  config = mockConfig;
}

/**
 * Internal helper for testing to inject a mock state.
 */
export function _setTestState(mockState: State): void {
  state = mockState;
}

/**
 * Constructs the execution context (ctx) used across the application.
 * Legacy version for tests and compatibility.
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
    logger: (msg: string, lvl?: string, opts?: { console?: boolean }) => {
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
    persistState: (opts?: { sync?: boolean; force?: boolean }) => store.persist(opts),
    // Backpressure placeholders for legacy ctx
    recordScanBackpressureEvent: () => {},
    getEffectiveParallelism: (base) => base,
    scanBackpressureFactor: 1,
  };
}

/**
 * VelociBuyBot encapsulates the bot's runtime state, RPC connections, and service loops.
 */
export class VelociBuyBot {
  public config: Config;
  public wallet: KeyPairSigner;
  public rpc: Rpc<SolanaRpcApi>;
  public rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  public state: State;
  public store: StateStore;

  public rpcs: Rpc<SolanaRpcApi>[] = [];
  public rpcSubscriptionPool: RpcSubscriptions<SolanaRpcSubscriptionsApi>[] = [];
  public shouldStop = false;
  public shutdownRequested = false;
  public websocketWatchdogInterval: NodeJS.Timeout | null = null;
  public watchdogBusy = false;

  public scanBackpressure = {
    events: [] as { error: boolean; at: number }[],
    factor: 1,
  };

  public monitorLoopBusy = false;
  public discoveryLoopBusy = false;

  constructor(configIn: Config, walletIn: KeyPairSigner, storeIn: StateStore) {
    this.config = configIn;
    this.wallet = walletIn;
    this.store = storeIn;
    this.state = storeIn.state;

    this.rpcs = configIn.rpcUrls.map((url) => createSolanaRpc(url) as Rpc<SolanaRpcApi>);
    this.rpcSubscriptionPool = configIn.wsRpcUrls.map(
      (url) => createSolanaRpcSubscriptions(url) as RpcSubscriptions<SolanaRpcSubscriptionsApi>
    );

    this.rpc = this.rpcs[0]!;
    this.rpcSubscriptions = this.rpcSubscriptionPool[0]!;

    // Update legacy globals
    config = this.config;
    wallet = { address: this.wallet.address, keypair: this.wallet };
    rpc = this.rpc;
    rpcSubscriptions = this.rpcSubscriptions;
    state = this.state;
    store = this.store;
    rpcs = this.rpcs;
    rpcSubscriptionPool = this.rpcSubscriptionPool;
  }

  /**
   * Records a scan backpressure event to adjust parallelism based on error rates.
   */
  public recordScanBackpressureEvent(error: unknown): void {
    const windowSize = Math.max(1, Math.floor(this.config.errorRateWindow || 20));
    this.scanBackpressure.events.push({ error: Boolean(error), at: Date.now() });
    while (this.scanBackpressure.events.length > windowSize) this.scanBackpressure.events.shift();
    const errorCount = this.scanBackpressure.events.filter((event) => event.error).length;
    const errorRate = errorCount / this.scanBackpressure.events.length;
    const minFactor = Math.min(1, Math.max(0.1, Number(this.config.parallelismMinFactor || 0.5)));
    this.scanBackpressure.factor =
      errorRate >= Number(this.config.backpressureErrorRateThreshold || 0.3) ? minFactor : 1;
  }

  /**
   * Calculates effective parallelism factor based on current backpressure.
   */
  public getEffectiveParallelism(base: number): number {
    const numericBase = Math.max(1, Math.floor(Number(base) || 1));
    return Math.max(1, Math.floor(numericBase * this.scanBackpressure.factor));
  }

  /**
   * Constructs the execution context (ctx) used across the application.
   */
  public getCtx(): Context {
    return {
      config: this.config,
      wallet: { address: this.wallet.address, keypair: this.wallet },
      rpc: this.rpc,
      rpcs: this.rpcs,
      rpcSubscriptions: this.rpcSubscriptions,
      rpcSubscriptionPool: this.rpcSubscriptionPool,
      state: this.state,
      store: this.store,
      calculateGMI: () => this.store.calculateGMI(),
      logger: (msg: string, lvl?: string, opts?: { console?: boolean }) => {
        let finalMsg = msg;
        if (lvl === 'trade' && this.config.paperTrading && this.state?.paperSolBalanceLamports) {
          const balText = atomicToDecimalString(this.state.paperSolBalanceLamports, 9, 4);
          if (!msg.includes('[PAPER SOL:')) {
            finalMsg = `${msg} [PAPER SOL: ${balText}]`;
          }
        }
        return log(this.config.logFile, finalMsg, lvl, opts);
      },
      persistState: (opts?: { sync?: boolean; force?: boolean }) => this.store.persist(opts),
      recordScanBackpressureEvent: (err) => this.recordScanBackpressureEvent(err),
      getEffectiveParallelism: (base) => this.getEffectiveParallelism(base),
      scanBackpressureFactor: this.scanBackpressure.factor,
    };
  }

  /**
   * Processes active cool-downs and moves expired entries to retired state.
   */
  public processCoolDowns(): void {
    const now = Date.now();
    for (const [mint, entry] of this.state.coolDownMints.entries()) {
      if (now >= entry.expiresAt) {
        this.store.removeCoolDown(mint);
        this.store.retireMint(mint, {
          lastExitPriceUsd: entry.lastExitPriceUsd,
          retiredAt: new Date().toISOString(),
        });
        this.store.untrackMint(mint);
        log(this.config.logFile, `Cool-down expired for ${mint}.`, 'info');
      }
    }
  }

  /**
   * Schedules a flush of discovery signals with debouncing.
   */
  public scheduleDiscoverySignalFlush(): void {
    if (discovery.discoveryState.debounceTimer) return;
    discovery.discoveryState.debounceTimer = setTimeout(() => {
      discovery.discoveryState.debounceTimer = null;
      void discovery.flushDiscoverySignals(this.getCtx(), (meta) => this.runDiscoveryLoop(meta));
    }, this.config.discoveryWsDebounceMs);
  }

  /**
   * Starts a watchdog to monitor WebSocket health and reconnect if stale.
   */
  public startWebsocketWatchdog(): void {
    if (!this.config.discoveryWsEnabled) return;
    if (this.websocketWatchdogInterval) clearInterval(this.websocketWatchdogInterval);
    this.websocketWatchdogInterval = setInterval(async () => {
      if (this.watchdogBusy || !this.config.discoveryWsEnabled) return;
      this.watchdogBusy = true;
      try {
        let allStale = true;
        const stalePrograms: string[] = [];
        const now = Date.now();

        for (const [programId, lastSeen] of discovery.discoveryState.lastEventAt.entries()) {
          const idleTime = now - lastSeen;
          if (idleTime > this.config.websocketStaleThresholdMs) {
            stalePrograms.push(programId);
          } else {
            allStale = false;
          }
        }

        const isStale = allStale && discovery.discoveryState.lastEventAt.size > 0;

        if (isStale) {
          log(
            this.config.logFile,
            `WebSocket stream is STALE for all programs: ${stalePrograms.join(', ')}. Attempting RECONNECT...`,
            'warn',
            { console: true }
          );

          discovery.discoveryState.logSubscriptionControllers.forEach((c) => c.abort());
          discovery.discoveryState.logSubscriptionControllers = [];

          const programs: string[] = [];
          if (this.config.discoveryPumpEnabled) programs.push(PUMP_FUN_PROGRAM_ID);
          if (this.config.discoveryRaydiumEnabled) programs.push(RAYDIUM_AMM_V4_PROGRAM_ID);
          if (this.config.discoveryMeteoraEnabled) programs.push(METEORA_DLMM_PROGRAM_ID);
          if (programs.length === 0) programs.push(...SPL_TOKEN_PROGRAM_IDS);

          for (const p of programs) {
            discovery.discoveryState.logSubscriptionControllers.push(
              await discovery.subscribeToProgramLogs(this.getCtx(), p, () =>
                this.scheduleDiscoverySignalFlush()
              )
            );
          }
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log(this.config.logFile, `WebSocket watchdog reconnect failed: ${msg}`, 'error');
      } finally {
        this.watchdogBusy = false;
      }
    }, this.config.websocketWatchdogIntervalMs);
    this.websocketWatchdogInterval.unref?.();
  }

  /**
   * Executes the monitor loop to check and manage open positions.
   */
  public async runMonitorLoop(): Promise<void> {
    if (this.monitorLoopBusy || this.shouldStop) return;
    this.monitorLoopBusy = true;
    try {
      await services.monitorPositions(this.getCtx());
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log(this.config.logFile, `Monitor loop error: ${msg}`, 'error');
    } finally {
      this.monitorLoopBusy = false;
    }
  }

  /**
   * Executes the discovery loop to find and evaluate new token candidates.
   */
  public async runDiscoveryLoop(
    trigger:
      | boolean
      | {
          forceDiscovery?: boolean;
          reason?: string;
          mints?: string[];
          mintLaunchpads?: Record<string, string>;
        } = false
  ): Promise<void> {
    if (this.discoveryLoopBusy || this.shouldStop) return;
    this.discoveryLoopBusy = true;
    try {
      const mood = services.getMoodAdjustments(this.getCtx());
      this.processCoolDowns();

      const isForced = trigger === true || (typeof trigger === 'object' && trigger.forceDiscovery);
      const reason =
        typeof trigger === 'object' ? trigger.reason : trigger === true ? 'manual-force' : 'poll';

      if (!mood.isPaused || isForced) {
        if (isForced)
          log(
            this.config.logFile,
            `Triggering forced discovery scan (reason: ${reason}).`,
            'debug'
          );
        const wsMints = typeof trigger === 'object' ? trigger.mints : null;
        const wsLaunchpads = typeof trigger === 'object' ? trigger.mintLaunchpads : null;
        await scanner.scanForCandidates(this.getCtx(), wsMints, wsLaunchpads);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log(this.config.logFile, `Discovery loop error: ${msg}`, 'error');
    } finally {
      this.discoveryLoopBusy = false;
    }
  }

  /**
   * Starts the bot's service loops.
   */
  public async start(): Promise<void> {
    if (this.config.discoveryWsEnabled) {
      const programs: string[] = [];
      if (this.config.discoveryPumpEnabled) programs.push(PUMP_FUN_PROGRAM_ID);
      if (this.config.discoveryRaydiumEnabled) programs.push(RAYDIUM_AMM_V4_PROGRAM_ID);
      if (this.config.discoveryMeteoraEnabled) programs.push(METEORA_DLMM_PROGRAM_ID);
      if (programs.length === 0) programs.push(...SPL_TOKEN_PROGRAM_IDS);
      for (const p of programs) {
        discovery.discoveryState.logSubscriptionControllers.push(
          await discovery.subscribeToProgramLogs(this.getCtx(), p, () =>
            this.scheduleDiscoverySignalFlush()
          )
        );
      }
    }
    this.startWebsocketWatchdog();

    await this.runDiscoveryLoop(true);

    const monitorTimer = setInterval(
      () => this.runMonitorLoop(),
      Math.min(2000, this.config.scanIntervalMs)
    );
    const discoveryTimer = setInterval(
      () => this.runDiscoveryLoop(),
      this.config.discoveryPollIntervalMs
    );

    try {
      while (!this.shouldStop) {
        await sleep(1000);
      }
    } finally {
      clearInterval(monitorTimer);
      clearInterval(discoveryTimer);
      if (discovery.discoveryState.debounceTimer)
        clearTimeout(discovery.discoveryState.debounceTimer);
      discovery.discoveryState.logSubscriptionControllers.forEach((c) => c.abort());
      if (this.websocketWatchdogInterval) clearInterval(this.websocketWatchdogInterval);

      if (this.config.closePositionsOnShutdown) {
        await services.closeAllOpenPositions(this.getCtx());
      } else {
        log(
          this.config.logFile,
          'Leaving open positions untouched on shutdown by configuration.',
          'warn',
          { console: true }
        );
      }

      this.store.requestShutdown();
      await this.store.persist({ force: true });
      await this.store.flush();
    }
  }

  public stop(): void {
    this.shouldStop = true;
  }
}

/**
 * Decodes private key bytes from various formats (Base58 or JSON array).
 */
export function decodePrivateKeyBytes(privateKeyText: string): Uint8Array {
  const trimmed = String(privateKeyText || '').trim();
  if (!trimmed) throw new Error('PRIVATE_KEY or PRIVATE_KEY_PATH is required.');
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as number[];
    return Uint8Array.from(parsed);
  }
  const decoder =
    bs58.decode ||
    (bs58 as unknown as { default?: { decode: (s: string) => Uint8Array } }).default?.decode;
  if (typeof decoder !== 'function') {
    throw new Error('bs58 decode function not found.');
  }
  return decoder(trimmed);
}

let activeBot: VelociBuyBot | null = null;

const handleShutdown = async (sig: string): Promise<void> => {
  if (activeBot?.shutdownRequested) process.exit(130);
  if (activeBot) activeBot.shutdownRequested = true;

  log(
    activeBot?.config?.logFile || './bot-error.log',
    `Shutdown signal ${sig} received. Terminating all services firmly.`,
    'warn',
    { console: true, sync: true }
  );

  setTimeout(() => {
    log(
      activeBot?.config?.logFile || './bot-error.log',
      'Shutdown timed out. Force exiting.',
      'error',
      {
        console: true,
        sync: true,
      }
    );
    process.exit(1);
  }, 15000).unref();

  if (activeBot) activeBot.stop();
  shutdownController.abort();
};

process.on('SIGINT', () => void handleShutdown('SIGINT'));
process.on('SIGTERM', () => void handleShutdown('SIGTERM'));

/**
 * Main entry point for the bot.
 */
export async function main(): Promise<void> {
  const loadedConfig = loadConfig();
  validateStartupConfig(loadedConfig);

  const initialStore = new StateStore(loadedConfig);
  initialStore.load(loadedConfig.stateFile);

  const pk =
    loadedConfig.privateKey ||
    (loadedConfig.privateKeyPath ? fs.readFileSync(loadedConfig.privateKeyPath, 'utf8') : '');
  const signer = await createKeyPairSignerFromBytes(decodePrivateKeyBytes(pk));

  activeBot = new VelociBuyBot(loadedConfig, signer, initialStore);

  const mode = loadedConfig.paperTrading ? 'PAPER' : loadedConfig.dryRun ? 'DRY-RUN' : 'LIVE';
  log(
    loadedConfig.logFile,
    `Bot started [${mode} MODE][${loadedConfig.strategyName} strategy]. Wallet: ...${signer.address.slice(-5)}. Buy Amount: ${loadedConfig.buyAmountSolText} SOL`,
    'info',
    { console: true }
  );

  await activeBot.start();
  log(loadedConfig.logFile, 'Shutdown complete. Bye!', 'info', { console: true });
  process.exit(0);
}

// Trigger execution if run as primary entry point
const isMain =
  process.argv[1] &&
  (__filename === fs.realpathSync(process.argv[1]) ||
    (typeof require !== 'undefined' && require.main === module));
if (isMain) {
  main().catch((e: unknown) => {
    const msg = e instanceof Error ? e.stack || e.message : String(e);
    log(activeBot?.config?.logFile || './bot-error.log', msg, 'error');
    process.exitCode = 1;
  });
}
