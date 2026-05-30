import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Rpc, SolanaRpcApi, createSolanaRpc } from '@solana/rpc';
import {
  RpcSubscriptions,
  SolanaRpcSubscriptionsApi,
  createSolanaRpcSubscriptions,
} from '@solana/rpc-subscriptions';
import { createKeyPairSignerFromBytes, KeyPairSigner } from '@solana/signers';
import bs58 from 'bs58';
import readline from 'node:readline';

import { sleep, log, atomicToDecimalString, setConsoleSuppressed } from './core/utils.js';
import { loadConfig, validateStartupConfig } from './core/config.js';
import { StateStore } from './core/store.js';
import * as keystore from './core/keystore.js';
import * as services from './services/services.js';
import * as discovery from './services/discovery/discovery.service.js';
import * as scanner from './services/scanner/scanner.service.js';
import { TuiService } from './services/tui.service.js';
import { Config, State, Context, TokenMetadata } from './types/index.js';

// Enforce default max listeners for event-heavy environments
EventEmitter.defaultMaxListeners = 100;

/**
 * Prompt for a password from stdin without echoing characters.
 */
async function promptPassword(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(query, (password) => {
      rl.close();
      resolve(password);
    });
    const rlExt = rl as unknown as {
      output: NodeJS.WritableStream;
      _writeToOutput: (s: string) => void;
    };
    rlExt._writeToOutput = function _writeToOutput(stringToWrite: string) {
      if (stringToWrite === '\n' || stringToWrite === '\r' || stringToWrite === '\r\n') {
        rlExt.output.write(stringToWrite);
      } else if (stringToWrite.length > 0) {
        // rlExt.output.write('*'); // Optionally show asterisks
      }
    };
  });
}

/**
 * Global abort controller for managing application-wide cancellation signals.
 */
export const shutdownController = new AbortController();

/**
 * Decodes a private key from Base58 or a JSON byte array.
 * @param privateKeyText - The raw private key string.
 * @returns The decoded private key as a Uint8Array.
 * @throws Error if the key is missing or the format is invalid.
 */
export function decodePrivateKeyBytes(privateKeyText: string): Uint8Array {
  const trimmed = String(privateKeyText || '').trim();
  if (!trimmed) throw new Error('PRIVATE_KEY or PRIVATE_KEY_PATH is required.');

  const validateDecodedKey = (bytes: Uint8Array, source: string): Uint8Array => {
    if (bytes.length !== 64) {
      throw new Error(`${source} must decode to a 64-byte Solana keypair, got ${bytes.length}.`);
    }
    return bytes;
  };

  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (e) {
      throw new Error('Failed to parse private key as JSON array.', { cause: e });
    }
    if (
      !Array.isArray(parsed) ||
      parsed.some((value) => !Number.isInteger(value) || Number(value) < 0 || Number(value) > 255)
    ) {
      throw new Error('Private key JSON must be an array of byte values from 0 to 255.');
    }
    return validateDecodedKey(Uint8Array.from(parsed), 'Private key JSON array');
  }

  // Handle various bs58 import styles
  const decoder =
    bs58.decode ||
    (bs58 as unknown as { default?: { decode: (s: string) => Uint8Array } }).default?.decode;

  if (typeof decoder !== 'function') {
    throw new Error('bs58 decode function not found.');
  }

  let decoded: Uint8Array;
  try {
    decoded = decoder(trimmed);
  } catch (e) {
    throw new Error('Failed to decode private key from Base58.', { cause: e });
  }
  return validateDecodedKey(decoded, 'PRIVATE_KEY Base58 value');
}

/**
 * VelociBuyBot is the core orchestrator for the trading system.
 * It manages service loops, RPC connection pools, state persistence,
 * and graceful shutdown procedures.
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
  public tui: TuiService | null = null;
  private coolDownTimers: Map<string, NodeJS.Timeout> = new Map();

  private shouldStop = false;
  private isShuttingDown = false;
  private monitorTimer: NodeJS.Timeout | null = null;
  private discoveryTimer: NodeJS.Timeout | null = null;

  private scanBackpressure = {
    events: [] as { error: boolean; at: number }[],
    factor: 1,
  };

  private monitorLoopBusy = false;
  private discoveryLoopBusy = false;
  private currentRpcSubIndex = 0;

  /**
   * Initializes the bot instance with required dependencies.
   * @param config - The application configuration.
   * @param wallet - The trading wallet signer.
   * @param store - The state persistence engine.
   * @param tui - Optional terminal UI service.
   */
  constructor(
    config: Config,
    wallet: KeyPairSigner,
    store: StateStore,
    tui: TuiService | null = null
  ) {
    this.config = config;
    this.wallet = wallet;
    this.store = store;
    this.state = store.state;
    this.tui = tui;

    if (!config.rpcUrls?.length) throw new Error('No RPC URLs provided in configuration.');
    if (!config.wsRpcUrls?.length)
      throw new Error('No WebSocket RPC URLs provided in configuration.');

    this.rpcs = config.rpcUrls.map((url) => createSolanaRpc(url) as Rpc<SolanaRpcApi>);
    this.rpcSubscriptionPool = config.wsRpcUrls.map(
      (url) => createSolanaRpcSubscriptions(url) as RpcSubscriptions<SolanaRpcSubscriptionsApi>
    );

    // Default to first healthy-looking endpoint
    this.rpc = this.rpcs[0]!;
    this.rpcSubscriptions = this.rpcSubscriptionPool[0]!;

    this.coolDownTimers = new Map();

    // Listen to coolDownStarted
    this.store.on('coolDownStarted', ({ mint, expiresAt }: { mint: string; expiresAt: number }) => {
      this.scheduleCoolDownExpiry(mint, expiresAt);
    });

    // Listen to coolDownRemoved
    this.store.on('coolDownRemoved', (mint: string) => {
      const timer = this.coolDownTimers.get(mint);
      if (timer) {
        clearTimeout(timer);
        this.coolDownTimers.delete(mint);
      }
    });

    // Schedule timers for existing cooldowns loaded from store
    for (const [mint, entry] of this.state.coolDownMints.entries()) {
      this.scheduleCoolDownExpiry(mint, entry.expiresAt);
    }
  }

  /**
   * Rotates to the next WebSocket RPC in the pool.
   */
  public rotateRpcSubscriptions(): void {
    if (this.rpcSubscriptionPool.length <= 1) return;
    this.currentRpcSubIndex = (this.currentRpcSubIndex + 1) % this.rpcSubscriptionPool.length;
    this.rpcSubscriptions = this.rpcSubscriptionPool[this.currentRpcSubIndex]!;
    this.getCtx().logger(`Rotated WebSocket RPC to index ${this.currentRpcSubIndex}`, 'warn', {
      console: true,
    });
  }

  /**
   * Tracks an RPC error to adjust backpressure factor.
   * Reduces parallelism if error rates exceed thresholds.
   * @param error - The error object or message.
   */
  public recordScanBackpressureEvent(error: unknown): void {
    const windowSize = Math.max(1, Math.floor(this.config.errorRateWindow || 20));
    this.scanBackpressure.events.push({ error: Boolean(error), at: Date.now() });

    while (this.scanBackpressure.events.length > windowSize) {
      this.scanBackpressure.events.shift();
    }

    const errorCount = this.scanBackpressure.events.filter((event) => event.error).length;
    const errorRate = errorCount / this.scanBackpressure.events.length;
    const minFactor = Math.min(1, Math.max(0.1, Number(this.config.parallelismMinFactor || 0.5)));

    this.scanBackpressure.factor =
      errorRate >= Number(this.config.backpressureErrorRateThreshold || 0.3) ? minFactor : 1;
  }

  /**
   * Returns adjusted parallelism count based on current RPC health.
   * @param base - The target parallelism count.
   * @returns The health-adjusted parallelism count.
   */
  public getEffectiveParallelism(base: number): number {
    const numericBase = Math.max(1, Math.floor(Number(base) || 1));
    return Math.max(1, Math.floor(numericBase * this.scanBackpressure.factor));
  }

  /**
   * Generates a unified execution context for all services.
   * @returns The current application context.
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
      tui: this.tui || undefined,
      getBackpressureFactor: () => this.scanBackpressure.factor,
      calculateGMI: () => this.store.calculateGMI(),
      rotateRpcSubscriptions: () => this.rotateRpcSubscriptions(),
      getCurrentRpcSubscriptions: () => this.rpcSubscriptions,
      logger: (msg: string, lvl?: string, opts?: { console?: boolean; sync?: boolean }) => {
        let finalMsg = msg;
        if (lvl === 'trade' && this.config.paperTrading && this.state?.paperSolBalanceLamports) {
          const balText = atomicToDecimalString(this.state.paperSolBalanceLamports, 9, 4);
          if (!msg.includes('[PAPER SOL:')) {
            finalMsg = `${msg} [PAPER SOL: ${balText}]`;
          }
        }
        if (this.tui) {
          this.tui.log(finalMsg, lvl);
          return log(this.config.logFile, finalMsg, lvl, { ...opts, console: false });
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
   * Schedules a precise timer to expire a cooldown.
   */
  private scheduleCoolDownExpiry(mint: string, expiresAt: number): void {
    const existing = this.coolDownTimers.get(mint);
    if (existing) {
      clearTimeout(existing);
      this.coolDownTimers.delete(mint);
    }

    const now = Date.now();
    const delay = Math.max(0, expiresAt - now);

    const timer = setTimeout(() => {
      this.coolDownTimers.delete(mint);
      this.expireCoolDown(mint);
    }, delay);

    this.coolDownTimers.set(mint, timer);
  }

  /**
   * Expires a cooldown for a mint, removing it and retiring it.
   */
  private expireCoolDown(mint: string): void {
    const entry = this.state.coolDownMints.get(mint);
    const lastExitPriceUsd = entry ? entry.lastExitPriceUsd : 0;

    this.store.removeCoolDown(mint);
    this.store.retireMint(mint, {
      lastExitPriceUsd,
      retiredAt: new Date().toISOString(),
    });
    this.store.untrackMint(mint);
    this.getCtx().logger(`Cool-down expired for ${mint}.`, 'info');
  }

  /**
   * Cleans up expired token cool-downs from memory and store.
   */
  private processCoolDowns(): void {
    const now = Date.now();
    for (const [mint, entry] of this.state.coolDownMints.entries()) {
      if (now >= entry.expiresAt) {
        this.expireCoolDown(mint);
      }
    }
  }

  /**
   * Internal callback for debounced discovery signal processing.
   */
  private scheduleDiscoverySignalFlush(): void {
    discovery.discoveryService.scheduleFlush(this.getCtx(), (meta) => this.runDiscoveryLoop(meta));
  }

  /**
   * Main monitoring loop. Scans open positions for exit signals.
   */
  public async runMonitorLoop(): Promise<void> {
    if (this.monitorLoopBusy || this.shouldStop) return;
    this.monitorLoopBusy = true;
    try {
      await services.monitorPositions(this.getCtx());
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.getCtx().logger(`Monitor loop error: ${msg}`, 'error');
    } finally {
      this.monitorLoopBusy = false;
    }
  }

  /**
   * Main discovery loop. Scans for new candidates based on signals or polling.
   * @param trigger - The event triggering the discovery run.
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
        if (isForced) {
          this.getCtx().logger(`Triggering forced discovery scan (reason: ${reason}).`, 'debug');
        }
        const wsMints = typeof trigger === 'object' ? trigger.mints : null;
        const wsLaunchpads = typeof trigger === 'object' ? trigger.mintLaunchpads : null;
        let discoveryItems: TokenMetadata[] | undefined = undefined;
        if (wsMints) {
          const launchpads = wsLaunchpads || {};
          discoveryItems = wsMints.map(
            (mint) =>
              ({
                id: mint,
                symbol: '?',
                name: '?',
                launchpad: launchpads[mint] || 'unknown',
              }) as TokenMetadata
          );
        }
        await scanner.scanForCandidates(this.getCtx(), discoveryItems);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.getCtx().logger(`Discovery loop error: ${msg}`, 'error');
    } finally {
      this.discoveryLoopBusy = false;
    }
  }

  /**
   * Starts all bot services and begins execution.
   */
  public async start(): Promise<void> {
    this.getCtx().logger('VelociBuyBot starting...', 'info', { console: true });

    if (this.config.discoveryWsEnabled) {
      await discovery.discoveryService.start(this.getCtx(), () =>
        this.scheduleDiscoverySignalFlush()
      );
      this.getCtx().logger('WebSocket log discovery active.', 'info', { console: true });
    }

    // Perform initial discovery run to populate state
    await this.runDiscoveryLoop(true);

    this.monitorTimer = setInterval(
      () => this.runMonitorLoop(),
      Math.min(2000, this.config.scanIntervalMs)
    );
    this.discoveryTimer = setInterval(
      () => this.runDiscoveryLoop(),
      this.config.discoveryPollIntervalMs
    );

    this.getCtx().logger('Core service loops initialized.', 'info', { console: true });

    while (!this.shouldStop) {
      await sleep(1000);
    }

    await this.performShutdown();
  }

  /**
   * Signals the bot to begin a graceful shutdown.
   */
  public stop(): void {
    if (this.shouldStop) return;
    this.shouldStop = true;
  }

  /**
   * Internal shutdown logic to cleanup resources and persist final state.
   */
  private async performShutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    this.getCtx().logger('Initiating graceful shutdown...', 'info', { console: true });

    if (this.monitorTimer) clearInterval(this.monitorTimer);
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);

    discovery.discoveryService.stop();

    // Clear all pending cooldown timers
    for (const timer of this.coolDownTimers.values()) {
      clearTimeout(timer);
    }
    this.coolDownTimers.clear();

    if (this.tui) {
      this.tui.disable();
      setConsoleSuppressed(false);
    }

    if (this.config.closePositionsOnShutdown) {
      this.getCtx().logger('Emergency exit: closing all open positions.', 'warn', {
        console: true,
      });
      try {
        await services.closeAllOpenPositions(this.getCtx());
      } catch (e) {
        this.getCtx().logger(
          `Shutdown exit failure: ${e instanceof Error ? e.message : String(e)}`,
          'error'
        );
      }
    }

    this.store.requestShutdown();
    await this.store.persist({ force: true });
    await this.store.flush();

    this.getCtx().logger('All services stopped. Persistence complete.', 'info', {
      console: true,
    });
  }
}

let activeBot: VelociBuyBot | null = null;
let globalShutdownInProgress = false;

/**
 * Handles OS termination signals for graceful shutdown.
 * @param sig - The OS signal name.
 */
const handleShutdown = async (sig: string): Promise<void> => {
  if (globalShutdownInProgress) return;
  globalShutdownInProgress = true;

  const msg = `Signal ${sig} received. Terminating firmly.`;
  if (activeBot) {
    activeBot.getCtx().logger(msg, 'warn', { console: true, sync: true });
  } else {
    log('./bot-error.log', msg, 'warn', { console: true, sync: true });
  }

  // Hard exit watchdog
  setTimeout(() => {
    const timeoutMsg = 'Shutdown timed out after 25s. Force exiting.';
    if (activeBot) {
      activeBot.getCtx().logger(timeoutMsg, 'error', { console: true, sync: true });
    } else {
      log('./bot-error.log', timeoutMsg, 'error', { console: true, sync: true });
    }
    process.exit(1);
  }, 25000).unref();

  if (activeBot) {
    activeBot.stop();
  } else {
    process.exit(0);
  }

  shutdownController.abort();
};

process.on('SIGINT', () => void handleShutdown('SIGINT'));
process.on('SIGTERM', () => void handleShutdown('SIGTERM'));

/**
 * Application entry point. Loads config, initializes store, and boots the bot.
 */
export async function main(): Promise<void> {
  try {
    const args = process.argv.slice(2);

    // Support legacy strategy overrides
    const strategyIdx = args.findIndex((arg) => arg === '--strategy' || arg === '-s');
    if (strategyIdx !== -1 && args[strategyIdx + 1]) {
      process.env.STRATEGY = args[strategyIdx + 1];
    }

    const tuiEnabled = args.includes('--tui');

    const config = loadConfig();
    validateStartupConfig(config);

    const store = new StateStore(config);
    await store.load(config.stateFile);

    let pkRaw = '';
    if (config.keystorePath) {
      if (!fs.existsSync(config.keystorePath)) {
        throw new Error(`Keystore file not found: ${config.keystorePath}`);
      }
      const password =
        config.keystorePassword || (await promptPassword('Enter keystore password: '));
      const data = JSON.parse(
        fs.readFileSync(config.keystorePath, 'utf8')
      ) as keystore.KeystoreData;
      try {
        pkRaw = await keystore.decrypt(data, password);
      } catch (err) {
        throw new Error('Failed to decrypt keystore. Incorrect password?', { cause: err });
      }
    } else {
      pkRaw =
        config.privateKey ||
        (config.privateKeyPath ? fs.readFileSync(config.privateKeyPath, 'utf8') : '');
    }

    let signer: KeyPairSigner;
    try {
      signer = await createKeyPairSignerFromBytes(decodePrivateKeyBytes(pkRaw));
    } catch (err) {
      throw new Error(
        'Failed to create wallet signer from private key. Ensure the key is a valid 64-byte Solana keypair.',
        { cause: err }
      );
    }

    // Redact sensitive material immediately after loading into memory
    pkRaw = '';
    config.privateKey = '[REDACTED]';
    config.privateKeyPath = '[REDACTED]';
    config.keystorePassword = '[REDACTED]';

    activeBot = new VelociBuyBot(config, signer, store);

    if (tuiEnabled) {
      setConsoleSuppressed(true);
      const tui = new TuiService(activeBot.getCtx());
      tui.enable();
      activeBot.tui = tui;
    }

    const runMode = config.paperTrading ? 'PAPER' : config.dryRun ? 'DRY-RUN' : 'LIVE';
    activeBot
      .getCtx()
      .logger(
        `VelociBuyBot ${runMode} started. Strategy: ${config.strategyName}. Wallet: ...${signer.address.slice(-5)}.`,
        'info',
        { console: true }
      );

    await activeBot.start();

    log(config.logFile, 'Main loop terminated. Exiting.', 'info', { console: true });
    process.exit(0);
  } catch (err) {
    setConsoleSuppressed(false);
    const errorMsg = err instanceof Error ? err.stack || err.message : String(err);
    log(
      activeBot?.config?.logFile || './bot-error.log',
      `Fatal startup error: ${errorMsg}`,
      'error',
      { console: true }
    );
    process.exit(1);
  }
}

/**
 * Internal helper for testing to inject a mock configuration.
 * @deprecated Use VelociBuyBot instance directly.
 */
export function _setTestConfig(mockConfig: Config): void {
  if (activeBot) activeBot.config = mockConfig;
}

/**
 * Internal helper for testing to inject a mock state.
 * @deprecated Use VelociBuyBot instance directly.
 */
export function _setTestState(mockState: State): void {
  if (activeBot) activeBot.state = mockState;
}

let testCtx: Context | null = null;
/**
 * Internal helper for testing to inject a mock context.
 */
export function _setTestCtx(ctx: Context | null): void {
  testCtx = ctx;
}

/**
 * Legacy accessor for application context.
 * @deprecated Use activeBot.getCtx() if available.
 */
export function getCtx(): Context {
  if (testCtx) return testCtx;
  if (activeBot) return activeBot.getCtx();
  throw new Error('Bot not initialized.');
}

// Execution trigger
const isPrimaryEntry =
  process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isPrimaryEntry) {
  main().catch((e: unknown) => {
    const msg = e instanceof Error ? e.stack || e.message : String(e);
    log(
      activeBot?.config?.logFile || './bot-error.log',
      `Unhandled top-level error: ${msg}`,
      'error'
    );
    process.exit(1);
  });
}
