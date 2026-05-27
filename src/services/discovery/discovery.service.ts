import { address, Address } from '@solana/addresses';
import { SolanaRpcApi } from '@solana/rpc';
import { sleep, log, rpcCall, PRIORITY } from '../../core/utils.js';
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
import { Context } from '../../types/index.js';

export interface DiscoveryState {
  debounceTimer: NodeJS.Timeout | null;
  pendingSignatures: Map<string, string>; // signature -> programId
  pendingMints: Map<string, string>; // mint -> programId
  recentSignalMints: Map<string, number>;
  logSubscriptionControllers: AbortController[];
  websocketReady: boolean;
  lastEventAt: Map<string, number>; // programId -> timestamp
}

export const discoveryState: DiscoveryState = {
  debounceTimer: null,
  pendingSignatures: new Map(),
  pendingMints: new Map(),
  recentSignalMints: new Map(),
  logSubscriptionControllers: [],
  websocketReady: false,
  lastEventAt: new Map(),
};

interface ParsedInstruction {
  parsed?: {
    type?: string;
    info?: {
      mint?: string;
    };
  };
}

interface InnerInstruction {
  instructions: ParsedInstruction[];
}

interface TransactionData {
  transaction?: {
    message?: {
      instructions: ParsedInstruction[];
    };
  };
  meta?: {
    innerInstructions?: InnerInstruction[];
  };
}

/**
 * Processes a program log notification to identify potential new token mints.
 */
export function handleDiscoveryProgramLog(
  ctx: Context,
  logInfo: unknown,
  programId: string,
  scheduleDiscoverySignalFlush: () => void
): void {
  discoveryState.lastEventAt.set(programId, Date.now());
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
    discoveryState.pendingMints.set(extractedMint, programId);
    scheduleDiscoverySignalFlush();
  } else if (match) {
    discoveryState.pendingSignatures.set(info.signature, programId);
    scheduleDiscoverySignalFlush();
  }
}

/**
 * Flushes pending discovery signals by fetching transaction details and extracting mints.
 */
export async function flushDiscoverySignals(
  ctx: Context,
  runLoop: (req: Record<string, unknown>) => Promise<void>
): Promise<void> {
  const signatureEntries = Array.from(discoveryState.pendingSignatures.entries());
  discoveryState.pendingSignatures.clear();

  const mintEntries = Array.from(discoveryState.pendingMints.entries());
  discoveryState.pendingMints.clear();

  if (signatureEntries.length === 0 && mintEntries.length === 0) return;

  const now = Date.now();
  if (discoveryState.recentSignalMints.size > 2000) {
    for (const [mint, lastSeen] of discoveryState.recentSignalMints.entries()) {
      if (now - lastSeen > DISCOVERY_SIGNAL_RETENTION_MS * 2) {
        discoveryState.recentSignalMints.delete(mint);
      }
    }
  }

  const pendingMints: string[] = [];
  const mintLaunchpads = new Map<string, string>();

  const addPendingMint = (mint: string, programId: string): boolean => {
    if (ctx.state.processedMints.has(mint)) return false;
    const lastSeen = discoveryState.recentSignalMints.get(mint) || 0;
    if (now - lastSeen < DISCOVERY_SIGNAL_RETENTION_MS) return false;

    discoveryState.recentSignalMints.set(mint, now);
    pendingMints.push(mint);

    const launchpad =
      programId === PUMP_FUN_PROGRAM_ID
        ? 'pump.fun'
        : programId === RAYDIUM_AMM_V4_PROGRAM_ID
          ? 'raydium'
          : programId === METEORA_DLMM_PROGRAM_ID
            ? 'meteora'
            : null;
    if (launchpad) mintLaunchpads.set(mint, launchpad);
    return true;
  };

  // 1. Process direct mints (optimized)
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
                sig as unknown as Parameters<SolanaRpcApi['getTransaction']>[0],
                {
                  commitment: 'confirmed',
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
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
        const mints = extractInitializedMints(item.tx);
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
 * Extracts initialized mint addresses from a parsed transaction.
 */
function extractInitializedMints(tx: unknown): string[] {
  const mints = new Set<string>();
  const txData = tx as TransactionData;
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
  collect(txData?.transaction?.message?.instructions);
  const meta = txData?.meta;
  (meta?.innerInstructions || []).forEach((g) => collect(g?.instructions));
  return Array.from(mints);
}

/**
 * Subscribes to program logs via WebSocket and handles discovery signals.
 */
export async function subscribeToProgramLogs(
  ctx: Context,
  programId: string,
  scheduleDiscoverySignalFlush: () => void
): Promise<AbortController> {
  const controller = new AbortController();
  discoveryState.lastEventAt.set(programId, Date.now());
  const consumeNotifications = async () => {
    while (!controller.signal.aborted) {
      try {
        const notifications = await ctx.rpcSubscriptions
          .logsNotifications(
            { mentions: [address(programId)] as [Address] },
            { commitment: 'confirmed' }
          )
          .subscribe({ abortSignal: controller.signal });

        discoveryState.websocketReady = true;
        log(ctx.config.logFile, `WebSocket logs subscription active for ${programId}`, 'info', {
          console: true,
        });

        for await (const notification of notifications) {
          const val = notification?.value || notification;
          handleDiscoveryProgramLog(ctx, val, programId, scheduleDiscoverySignalFlush);
        }
      } catch (error: unknown) {
        discoveryState.websocketReady = false;
        if (!controller.signal.aborted) {
          log(
            ctx.config.logFile,
            `WebSocket logs subscription failed for ${programId}: ${error instanceof Error ? error.message : String(error)}. Retrying in 5s...`,
            'warn',
            { console: true }
          );
          await sleep(5000);
        }
      }
    }
  };
  void consumeNotifications();
  return controller;
}
