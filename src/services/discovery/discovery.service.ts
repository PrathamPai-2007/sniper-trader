import { address, Address } from '@solana/addresses';
import { sleep, rpcCall, PRIORITY } from '../../core/utils.js';
import {
  PUMP_FUN_PROGRAM_ID,
  RAYDIUM_AMM_V4_PROGRAM_ID,
  METEORA_DLMM_PROGRAM_ID,
  INITIALIZE_MINT_LOG_PATTERN,
  PUMP_FUN_CREATE_LOG_PATTERN,
  PUMP_FUN_MINT_LOG_PATTERN,
  RAYDIUM_INIT_LOG_PATTERN,
  METEORA_INIT_LOG_PATTERN,
  DISCOVERY_SIGNAL_RETENTION_MS,
} from '../../core/config.js';
import { Context, TransactionData, ParsedInstruction } from '../../types/index.js';

/**
 * DiscoveryService manages WebSocket subscriptions to program logs
 * to identify new token mints across multiple Solana programs.
 */
export class DiscoveryService {
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingSignatures: Map<string, string> = new Map(); // signature -> programId
  private pendingMints: Map<string, string> = new Map(); // mint -> programId
  private recentSignalMints: Map<string, number> = new Map();
  private subscriptionControllers: Map<string, AbortController> = new Map();
  private globalSubscriptionController: AbortController | null = null;
  private lastEventAt: Map<string, number> = new Map();
  private lastGlobalEventAt: number = Date.now();
  private watchdogTimer: NodeJS.Timeout | null = null;

  public websocketReady = false;

  /**
   * Initializes the discovery service and starts log subscriptions.
   * @param ctx - The application context.
   * @param scheduleDiscoverySignalFlush - Callback to trigger signal processing.
   */
  public async start(ctx: Context, scheduleDiscoverySignalFlush: () => void): Promise<void> {
    const programs = [];
    if (ctx.config.discoveryPumpEnabled) programs.push(PUMP_FUN_PROGRAM_ID);
    if (ctx.config.discoveryRaydiumEnabled) programs.push(RAYDIUM_AMM_V4_PROGRAM_ID);
    if (ctx.config.discoveryMeteoraEnabled) programs.push(METEORA_DLMM_PROGRAM_ID);

    void this.subscribeGlobalHeartbeat(ctx);

    for (const pid of programs) {
      void this.subscribe(ctx, pid, scheduleDiscoverySignalFlush);
    }

    this.startWatchdog(ctx, scheduleDiscoverySignalFlush);
  }

  /**
   * Stops all active subscriptions and timers.
   */
  public stop(): void {
    for (const controller of this.subscriptionControllers.values()) {
      controller.abort();
    }
    this.subscriptionControllers.clear();
    this.globalSubscriptionController?.abort();
    this.globalSubscriptionController = null;
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
  }

  /**
   * Schedules a flush of discovery signals with debouncing.
   */
  public scheduleFlush(
    ctx: Context,
    runLoop: (req: Record<string, unknown>) => Promise<void>
  ): void {
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.flush(ctx, runLoop);
    }, ctx.config.discoveryWsDebounceMs || 100);
  }

  /**
   * Starts a watchdog timer to monitor subscription health.
   */
  private startWatchdog(ctx: Context, scheduleDiscoverySignalFlush: () => void): void {
    const interval = ctx.config.websocketWatchdogIntervalMs || 30000;
    const globalStaleThreshold = 60000; // 60s for global heartbeat
    const programStaleThreshold = 300000; // 5m for individual programs if global is OK

    this.watchdogTimer = setInterval(() => {
      const now = Date.now();

      // 1. Check global heartbeat
      if (now - this.lastGlobalEventAt > globalStaleThreshold) {
        ctx.logger(
          `Global WebSocket heartbeat stale (${((now - this.lastGlobalEventAt) / 1000).toFixed(1)}s). Rotating RPC...`,
          'warn',
          { console: true }
        );
        ctx.rotateRpcSubscriptions();
        void this.restartAllSubscriptions(ctx, scheduleDiscoverySignalFlush);
        return;
      }

      // 2. Check individual programs
      for (const [pid, lastSeen] of this.lastEventAt.entries()) {
        if (now - lastSeen > programStaleThreshold) {
          ctx.logger(
            `WebSocket subscription for ${pid} stale (${((now - lastSeen) / 1000).toFixed(1)}s). Restarting...`,
            'warn',
            { console: true }
          );
          void this.subscribe(ctx, pid, scheduleDiscoverySignalFlush);
        }
      }
    }, interval);
  }

  /**
   * Subscribes to global slot notifications to serve as a connection heartbeat.
   */
  private async subscribeGlobalHeartbeat(ctx: Context): Promise<void> {
    this.globalSubscriptionController?.abort();
    const controller = new AbortController();
    this.globalSubscriptionController = controller;
    this.lastGlobalEventAt = Date.now();

    try {
      const rpcSub = ctx.getCurrentRpcSubscriptions();
      const notifications = await rpcSub
        .slotNotifications()
        .subscribe({ abortSignal: controller.signal });

      for await (const _notification of notifications) {
        if (controller.signal.aborted) break;
        this.lastGlobalEventAt = Date.now();
      }
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        ctx.logger(
          `Global WebSocket heartbeat failed: ${error instanceof Error ? error.message : String(error)}. Retrying in 5s...`,
          'warn'
        );
        await sleep(5000);
        if (!controller.signal.aborted) {
          return this.subscribeGlobalHeartbeat(ctx);
        }
      }
    }
  }

  /**
   * Restarts all active program subscriptions and the global heartbeat.
   */
  private async restartAllSubscriptions(
    ctx: Context,
    scheduleDiscoverySignalFlush: () => void
  ): Promise<void> {
    const programs = [];
    if (ctx.config.discoveryPumpEnabled) programs.push(PUMP_FUN_PROGRAM_ID);
    if (ctx.config.discoveryRaydiumEnabled) programs.push(RAYDIUM_AMM_V4_PROGRAM_ID);
    if (ctx.config.discoveryMeteoraEnabled) programs.push(METEORA_DLMM_PROGRAM_ID);

    void this.subscribeGlobalHeartbeat(ctx);
    for (const pid of programs) {
      void this.subscribe(ctx, pid, scheduleDiscoverySignalFlush);
    }
  }

  /**
   * Subscribes to program logs for a specific program ID.
   */
  public async subscribe(
    ctx: Context,
    programId: string,
    scheduleDiscoverySignalFlush: () => void
  ): Promise<void> {
    // Abort existing subscription if any
    this.subscriptionControllers.get(programId)?.abort();

    const controller = new AbortController();
    this.subscriptionControllers.set(programId, controller);
    this.lastEventAt.set(programId, Date.now());

    try {
      const rpcSub = ctx.getCurrentRpcSubscriptions();
      const notifications = await rpcSub
        .logsNotifications(
          { mentions: [address(programId)] as [Address] },
          { commitment: 'processed' }
        )
        .subscribe({ abortSignal: controller.signal });

      this.websocketReady = true;
      ctx.logger(`WebSocket logs subscription active for ${programId}`, 'info', {
        console: true,
      });

      for await (const notification of notifications) {
        if (controller.signal.aborted) break;
        const val = notification?.value || notification;
        this.handleLog(ctx, val, programId, scheduleDiscoverySignalFlush);
      }
    } catch (error: unknown) {
      this.websocketReady = false;
      if (!controller.signal.aborted) {
        ctx.logger(
          `WebSocket logs subscription failed for ${programId}: ${error instanceof Error ? error.message : String(error)}. Retrying in 5s...`,
          'warn',
          { console: true }
        );
        await sleep(5000);
        if (!controller.signal.aborted) {
          return this.subscribe(ctx, programId, scheduleDiscoverySignalFlush);
        }
      }
    }
  }

  /**
   * Processes a single log notification.
   */
  public handleLog(
    ctx: Context,
    logInfo: unknown,
    programId: string,
    scheduleDiscoverySignalFlush: () => void
  ): void {
    this.lastEventAt.set(programId, Date.now());
    if (!ctx.config.discoveryWsEnabled) return;

    const info = logInfo as { signature: string; logs: string[] };
    if (!info?.signature || !Array.isArray(info.logs)) return;

    let match = false;
    let extractedMint: string | null = null;

    if (programId === PUMP_FUN_PROGRAM_ID) {
      for (const line of info.logs) {
        if (PUMP_FUN_CREATE_LOG_PATTERN.test(line)) match = true;
        const mintMatch = line.match(PUMP_FUN_MINT_LOG_PATTERN);
        if (mintMatch && mintMatch[1]) {
          extractedMint = mintMatch[1];
          break;
        }
      }
    } else if (programId === RAYDIUM_AMM_V4_PROGRAM_ID) {
      match = info.logs.some((line: string) => RAYDIUM_INIT_LOG_PATTERN.test(line));
    } else if (programId === METEORA_DLMM_PROGRAM_ID) {
      match = info.logs.some((line: string) => METEORA_INIT_LOG_PATTERN.test(line));
    } else {
      match = info.logs.some((line: string) => INITIALIZE_MINT_LOG_PATTERN.test(line));
    }

    if (extractedMint) {
      this.pendingMints.set(extractedMint, programId);
      scheduleDiscoverySignalFlush();
    } else if (match) {
      this.pendingSignatures.set(info.signature, programId);
      scheduleDiscoverySignalFlush();
    }
  }

  /**
   * Flushes pending signals, fetches transaction details if needed, and triggers the run loop.
   */
  public async flush(
    ctx: Context,
    runLoop: (req: Record<string, unknown>) => Promise<void>
  ): Promise<void> {
    const signatureEntries = Array.from(this.pendingSignatures.entries());
    this.pendingSignatures.clear();

    const mintEntries = Array.from(this.pendingMints.entries());
    this.pendingMints.clear();

    if (signatureEntries.length === 0 && mintEntries.length === 0) return;

    const now = Date.now();
    this.cleanupRecentSignals(now);

    const pendingMints: string[] = [];
    const mintLaunchpads = new Map<string, string>();

    const addPendingMint = (mint: string, programId: string): boolean => {
      if (ctx.state.processedMints.has(mint)) return false;
      const lastSeen = this.recentSignalMints.get(mint) || 0;
      if (now - lastSeen < DISCOVERY_SIGNAL_RETENTION_MS) return false;

      this.recentSignalMints.set(mint, now);
      pendingMints.push(mint);

      const launchpad = this.getLaunchpadName(programId);
      if (launchpad) mintLaunchpads.set(mint, launchpad);
      return true;
    };

    // 1. Process direct mints
    for (const [mint, programId] of mintEntries) {
      addPendingMint(mint, programId);
    }

    // 2. Process signatures (fallback)
    if (signatureEntries.length > 0) {
      const batchSize = 3;
      for (let i = 0; i < signatureEntries.length; i += batchSize) {
        const batch = signatureEntries.slice(i, i + batchSize);
        const results = await Promise.all(
          batch.map(async ([sig, programId]) => {
            try {
              const tx = await rpcCall(
                ctx,
                'getTransaction',
                [
                  sig as any,
                  {
                    commitment: 'confirmed',
                    encoding: 'jsonParsed' as any,
                    maxSupportedTransactionVersion: 0,
                  },
                ],
                { priority: PRIORITY.LOW }
              );
              return { tx: tx as unknown as TransactionData, programId };
            } catch {
              return null;
            }
          })
        );

        for (const item of results) {
          if (!item?.tx) continue;
          const mints = this.extractInitializedMints(item.tx);
          for (const mint of mints) {
            addPendingMint(mint, item.programId);
          }
        }
      }
    }

    if (pendingMints.length > 0) {
      await runLoop({
        reason: 'ws-mint-init',
        forceDiscovery: true,
        skipMonitor: true,
        websocketSignalCount: pendingMints.length,
        mints: pendingMints,
        mintLaunchpads: Object.fromEntries(mintLaunchpads),
      });
    }
  }

  /**
   * Cleans up the recent signals map to prevent memory growth.
   */
  private cleanupRecentSignals(now: number): void {
    if (this.recentSignalMints.size > 2000) {
      for (const [mint, lastSeen] of this.recentSignalMints.entries()) {
        if (now - lastSeen > DISCOVERY_SIGNAL_RETENTION_MS * 2) {
          this.recentSignalMints.delete(mint);
        }
      }
    }
  }

  /**
   * Maps a program ID to a friendly launchpad name.
   */
  private getLaunchpadName(programId: string): string | null {
    switch (programId) {
      case PUMP_FUN_PROGRAM_ID:
        return 'pump.fun';
      case RAYDIUM_AMM_V4_PROGRAM_ID:
        return 'raydium';
      case METEORA_DLMM_PROGRAM_ID:
        return 'meteora';
      default:
        return null;
    }
  }

  /**
   * Extracts initialized mint addresses from a parsed transaction.
   */
  private extractInitializedMints(tx: TransactionData): string[] {
    const mints = new Set<string>();
    const collect = (ixs: ParsedInstruction[] | undefined) => {
      if (!Array.isArray(ixs)) return;
      for (const ix of ixs) {
        const parsed = ix?.parsed;
        const type = String(parsed?.type || '').toLowerCase();
        const info = parsed?.info;
        const mint = info?.mint;
        if ((type === 'initializemint' || type === 'initializemint2') && typeof mint === 'string')
          mints.add(mint);
      }
    };
    collect(tx?.transaction?.message?.instructions);
    const meta = tx?.meta;
    (meta?.innerInstructions || []).forEach((g) => collect(g?.instructions));
    return Array.from(mints);
  }
}

// Export a singleton instance for backward compatibility or shared state
export const discoveryService = new DiscoveryService();

// Re-export functional wrappers to maintain original API if needed
export function handleDiscoveryProgramLog(
  ctx: Context,
  logInfo: unknown,
  programId: string,
  scheduleDiscoverySignalFlush: () => void
): void {
  discoveryService.handleLog(ctx, logInfo, programId, scheduleDiscoverySignalFlush);
}

export async function flushDiscoverySignals(
  ctx: Context,
  runLoop: (req: Record<string, unknown>) => Promise<void>
): Promise<void> {
  return discoveryService.flush(ctx, runLoop);
}

export async function subscribeToProgramLogs(
  ctx: Context,
  programId: string,
  scheduleDiscoverySignalFlush: () => void
): Promise<AbortController> {
  void discoveryService.subscribe(ctx, programId, scheduleDiscoverySignalFlush);
  return new AbortController();
}
