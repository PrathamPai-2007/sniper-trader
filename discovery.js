'use strict';

// Discovery pipeline for new token signals: consumes program logs, extracts candidate mints,
// deduplicates websocket events, and triggers forced discovery scans when needed.

const { setTimeout: sleep } = require('node:timers/promises');
const { log, rpcCall, PRIORITY } = require('./utils');
const { constants } = require('./config');

const {
  PUMP_FUN_PROGRAM_ID,
  RAYDIUM_AMM_V4_PROGRAM_ID,
  METEORA_DLMM_PROGRAM_ID,
  INITIALIZE_MINT_LOG_PATTERN,
  PUMP_FUN_CREATE_LOG_PATTERN,
  RAYDIUM_INIT_LOG_PATTERN,
  METEORA_INIT_LOG_PATTERN,
  DISCOVERY_SIGNAL_RETENTION_MS,
} = constants;

let discoveryState = {
  debounceTimer: null,
  pendingSignatures: new Map(), // signature -> programId
  recentSignalMints: new Map(),
  logSubscriptionControllers: [],
  websocketReady: false,
  lastEventAt: Date.now(),
};

/**
 * Processes a program log notification to identify potential new token mints.
 * @param {Object} ctx - The application context.
 * @param {Object} logInfo - The log notification value.
 * @param {string} programId - The ID of the program that generated the log.
 * @param {Function} scheduleDiscoverySignalFlush - Callback to schedule a signal flush.
 */
function handleDiscoveryProgramLog(ctx, logInfo, programId, scheduleDiscoverySignalFlush) {
  discoveryState.lastEventAt = Date.now();
  if (!ctx.config.discoveryWsEnabled) return;
  if (!logInfo?.signature || !Array.isArray(logInfo.logs)) return;

  let match = false;
  if (programId === PUMP_FUN_PROGRAM_ID) {
    match = logInfo.logs.some((line) => PUMP_FUN_CREATE_LOG_PATTERN.test(line));
  } else if (programId === RAYDIUM_AMM_V4_PROGRAM_ID) {
    match = logInfo.logs.some((line) => RAYDIUM_INIT_LOG_PATTERN.test(line));
  } else if (programId === METEORA_DLMM_PROGRAM_ID) {
    match = logInfo.logs.some((line) => METEORA_INIT_LOG_PATTERN.test(line));
  } else {
    match = logInfo.logs.some((line) => INITIALIZE_MINT_LOG_PATTERN.test(line));
  }

  if (!match) return;
  discoveryState.pendingSignatures.set(logInfo.signature, programId);
  scheduleDiscoverySignalFlush();
}

/**
 * Flushes pending discovery signals by fetching transaction details and extracting mints.
 * @param {Object} ctx - The application context.
 * @param {Function} runLoop - Callback to trigger the discovery loop with new mints.
 * @returns {Promise<void>}
 */
async function flushDiscoverySignals(ctx, runLoop) {
  const signatureEntries = Array.from(discoveryState.pendingSignatures.entries());
  discoveryState.pendingSignatures.clear();
  if (signatureEntries.length === 0) return;

  const now = Date.now();
  if (discoveryState.recentSignalMints.size > 2000) {
    for (const [mint, lastSeen] of discoveryState.recentSignalMints.entries()) {
      if (now - lastSeen > DISCOVERY_SIGNAL_RETENTION_MS * 2) {
        discoveryState.recentSignalMints.delete(mint);
      }
    }
  }

  // Process in small batches; the rate limiter in rpcCall handles per-call pacing.
  const batchSize = 3;
  const parsedTransactions = [];
  for (let i = 0; i < signatureEntries.length; i += batchSize) {
    const batch = signatureEntries.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async ([sig, programId]) => {
        try {
          const tx = await rpcCall(
            ctx,
            'getTransaction',
            [
              sig,
              {
                commitment: 'confirmed',
                encoding: 'jsonParsed',
                maxSupportedTransactionVersion: 0,
              },
            ],
            { priority: PRIORITY.LOW }
          );
          return { tx, programId };
        } catch {
          return null;
        }
      })
    );
    parsedTransactions.push(...results);
  }

  const pendingMints = [];
  const mintLaunchpads = new Map();

  for (const item of parsedTransactions) {
    if (!item?.tx) continue;
    const mints = extractInitializedMints(item.tx);
    const launchpad =
      item.programId === PUMP_FUN_PROGRAM_ID
        ? 'pump.fun'
        : item.programId === RAYDIUM_AMM_V4_PROGRAM_ID
          ? 'raydium'
          : item.programId === METEORA_DLMM_PROGRAM_ID
            ? 'meteora'
            : null;

    for (const mint of mints) {
      if (ctx.state.processedMints.has(mint)) continue;
      const lastSeen = discoveryState.recentSignalMints.get(mint) || 0;
      if (now - lastSeen < DISCOVERY_SIGNAL_RETENTION_MS) continue;
      discoveryState.recentSignalMints.set(mint, now);
      pendingMints.push(mint);
      if (launchpad) mintLaunchpads.set(mint, launchpad);
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
 * @param {Object} tx - The parsed transaction object.
 * @returns {string[]} Array of mint addresses.
 */
function extractInitializedMints(tx) {
  const mints = new Set();
  const collect = (ixs) => {
    if (!Array.isArray(ixs)) return;
    for (const ix of ixs) {
      const type = String(ix?.parsed?.type || '').toLowerCase();
      const mint = ix?.parsed?.info?.mint;
      if ((type === 'initializemint' || type === 'initializemint2') && typeof mint === 'string')
        mints.add(mint);
    }
  };
  collect(tx?.transaction?.message?.instructions);
  (tx?.meta?.innerInstructions || []).forEach((g) => collect(g?.instructions));
  return Array.from(mints);
}

/**
 * Subscribes to program logs via WebSocket and handles discovery signals.
 * @param {Object} ctx - The application context.
 * @param {string} programId - The ID of the program to subscribe to.
 * @param {Function} scheduleDiscoverySignalFlush - Callback to schedule a signal flush.
 * @returns {Promise<AbortController>} The controller to abort the subscription.
 */
async function subscribeToProgramLogs(ctx, programId, scheduleDiscoverySignalFlush) {
  const controller = new AbortController();
  const consumeNotifications = async () => {
    while (!controller.signal.aborted) {
      try {
        const notifications = await ctx.rpcSubscriptions
          .logsNotifications({ mentions: [programId] }, { commitment: 'confirmed' })
          .subscribe({ abortSignal: controller.signal });

        discoveryState.websocketReady = true;
        log(ctx.config.logFile, `WebSocket logs subscription active for ${programId}`, 'info', {
          console: true,
        });

        for await (const notification of notifications) {
          discoveryState.lastEventAt = Date.now();
          const val = notification?.value || notification;
          handleDiscoveryProgramLog(ctx, val, programId, scheduleDiscoverySignalFlush);
        }
      } catch (error) {
        discoveryState.websocketReady = false;
        if (!controller.signal.aborted) {
          log(
            ctx.config.logFile,
            `WebSocket logs subscription failed for ${programId}: ${error.message}. Retrying in 5s...`,
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

module.exports = {
  discoveryState,
  handleDiscoveryProgramLog,
  flushDiscoverySignals,
  subscribeToProgramLogs,
};
