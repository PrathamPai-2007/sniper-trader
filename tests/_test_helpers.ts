'use strict';

(global as any).__TEST__ = true;

import path from 'node:path';
import {
  Config,
  State,
  Context,
  Position,
  MarketSnapshot,
  RecheckItem,
} from '../src/types/index.js';
import { StateStore } from '../src/core/store.js';
import * as bot from '../src/index.js';

export function createTestConfig(overrides: Partial<Config> = {}): Config {
  const rpcUrl = 'http://localhost:8899';
  return {
    strategyName: 'test',
    logFile: path.join(process.cwd(), '.test-artifacts', 'bot.log'),
    stateFile: '',
    metricsFile: '',
    mintsFile: '',
    scannedTokensFile: '',
    paperTradeJournalFile: '',
    tradeJournalFile: '',
    performanceStatsFile: '',
    sessionDir: '',
    stateFlushIntervalMs: 250,
    jupiterBaseUrl: 'http://mock',
    jupiterApiKey: 'test-key',
    jupiterPositionApiKey: 'position-key',
    goPlusBaseUrl: 'http://mock-goplus',
    bubbleMapsBaseUrl: 'http://mock-bubblemaps',
    goPlusAccessToken: '',
    bubbleMapsApiKey: '',
    minBubbleMapsScore: 0,
    maxBubbleMapsLargestClusterShare: 100,
    rpcUrl,
    rpcUrls: [rpcUrl],
    wsRpcUrl: 'ws://localhost:8900',
    wsRpcUrls: ['ws://localhost:8900'],
    buyAmountLamports: 50_000_000n,
    buyAmountSolText: '0.05',
    initialPaperSolText: '0.1',
    initialPaperSolLamports: 100_000_000n,
    paperTrading: true,
    dryRun: false,
    liveTradingEnabled: false,
    closePositionsOnShutdown: true,
    slippageBps: 500,
    takeProfitMultiples: [1.5],
    takeProfitFraction: 0.6,
    highGrowthConfidenceScore: 70,
    holdDurationHighConfidenceMinutes: 10,
    holdDurationLowConfidenceMinutes: 5,
    moodPauseDurationMinutes: 60,
    coolDownMinutes: 20,
    minLiquidityUsd: 750,
    minHolderCount: 4,
    minBuys5m: 1,
    minPoolAgeSeconds: 0,
    maxCandidateAgeMinutes: 30,
    minOrganicScore: 0,
    minSocialLinks: 0,
    allowVerifiedTokens: true,
    maxAuditTopHoldersPct: 95,
    maxTokenAccountTop1Pct: 70,
    maxTokenAccountTop5Pct: 85,
    memeKeywords: ['pepe', 'doge'],
    maxMemeFdvUsd: 10_000_000,
    maxFdvToLiquidity: 80,
    borderlineThresholdBufferRatio: 0.2,
    borderlineRecheckEnabled: true,
    borderlineRecheckMinDelayMs: 10_000,
    borderlineRecheckMaxDelayMs: 20_000,
    maxLiquidityDrawdownPct: 15,
    maxSurvivalGrowthPct: 200,
    minSurvivalMomentum: 1.0,
    minBreakoutMultiplier: 1.001,
    earlyPerformanceGuardSeconds: 10,
    earlyPerformanceDropPct: 10,
    earlyPerformanceSellPct: 60,
    minAccelerationFactor: 0.16,
    maxExhaustionRangePct: 1.6,
    minMomentumConsistency: 0.45,
    maxPriceDumpPct: 20,
    maxSellPressureIncreasePct: 100,
    minCandidateScore: 60,
    reentryDipPct: 15,
    reentryBreakoutPct: 20,
    liquidityCollapseThresholdUsd: 750,
    liquidityCollapseThresholdRatio: 0.25,
    minHoldTimeSeconds: 60,
    performanceCheckSeconds: 75,
    performanceMinMomentum: 1.05,
    stopLossPct: 0.2,
    trailingStopDrawdownPct: 0.2,
    maxHoldMinutes: 60,
    timeExitMinMultiple: 1.25,
    holderCountWaitlistSeconds: 60,
    recheckPriceDropPct: 15,
    maxConcurrentAudits: 10,
    scanParallelismLight: 10,
    scanParallelismHeavy: 4,
    ownerAuditParallelism: 4,
    priceFallbackParallelism: 6,
    parallelismMinFactor: 0.5,
    errorRateWindow: 20,
    backpressureErrorRateThreshold: 0.3,
    mintSignalMaxAttempts: 3,
    mintSignalRetryDelayMs: 750,
    rpcIndexingRetryDelayMs: 15_000,
    maxRecheckAttempts: 5,
    borderlineRecheckMaxAttempts: 3,
    maxAutoSlippageRetry: 3,
    autoSlippageIncrementBps: 100,
    priorityFeeBaseMicroLamports: 25_000,
    priorityFeeMaxMicroLamports: 5_000_000,
    priorityFeePanicMultiplier: 2,
    priorityFeePercentile: 75,
    useJito: false,
    jitoTipLamports: 1_000_000n,
    jitoBlockEngineUrl: 'http://mock-jito',
    jitoTipPercentile: 75,
    jitoTipFloorApiUrl: '',
    jitoConfirmTimeoutMs: 30000,
    jitoBundleRetryAttempts: 3,
    priorityFeeAccountLocal: true,
    priorityFeeVolatilityMultiplier: 1.0,
    maxOpenPositions: 10,
    maxBuysPerScan: 2,
    maxCandidatesPerScan: 15,
    scanIntervalMs: 5000,
    discoveryPollIntervalMs: 10_000,
    discoveryWsDebounceMs: 750,
    websocketWatchdogIntervalMs: 30_000,
    websocketStaleThresholdMs: 90_000,
    survivalDelaySeconds: 20,
    survivalDelayThresholdHigh: 75,
    survivalDelayThresholdVeryHigh: 90,
    finalAuditSeconds: 5,
    maxBuyTopGrowthPct: 120,
    buyTopAthBufferPct: 2,
    buyingTheTopSlPct: 25,
    discoveryWsEnabled: true,
    discoveryPumpEnabled: true,
    discoveryRaydiumEnabled: true,
    discoveryMeteoraEnabled: true,
    useJupiterSdk: false,
    inlineSwapSimulation: true,
    backgroundAtaClose: true,
    privateKey: '',
    privateKeyPath: '',
    telegramBotToken: '',
    telegramChatId: '',
    discordWebhookUrl: '',
    maxDailyDrawdownPct: 0.15,
    maxPositionsPerLaunchpad: 3,
    dynamicSizingEnabled: true,
    ...overrides,
  } as Config;
}

export function createState(overrides: Partial<State> = {}): State {
  return {
    processedMintQueue: [],
    processedMints: new Set<string>(),
    pendingCandidateRechecks: new Map<string, RecheckItem>(),
    positions: new Map<string, Position>(),
    marketSnapshots: new Map<string, MarketSnapshot>(),
    paperSolBalanceLamports: '1000000000',
    tradeHistory: [],
    moodPauseUntil: null,
    coolDownMints: new Map(),
    retiredMints: new Map(),
    closedTrades: [],
    launchHistory: [],
    sessionStartingSolBalanceLamports: null,
    peakSessionSolBalanceLamports: null,
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
    ...overrides,
  };
}

export function createCtx(
  configOverrides: Partial<Config> = {},
  stateOverrides: Partial<State> = {}
): Context {
  const config = createTestConfig(configOverrides);
  const store = new StateStore(config);
  Object.assign(store.state, createState(stateOverrides));

  // A functional proxy for mock RPC methods that returns a .send() method
  const rpcProxy = new Proxy(
    {},
    {
      get: (_target, prop) => {
        return () => ({
          send: async () => {
            if (prop === 'getTokenAccountsByOwner') return { value: [] };
            return { value: { blockhash: '1'.repeat(32), lastValidBlockHeight: 12345 } };
          },
        });
      },
    }
  );

  return {
    config,
    state: store.state,
    store,
    rpc: rpcProxy as any,
    rpcs: [rpcProxy as any],
    rpcSubscriptions: {} as any,
    rpcSubscriptionPool: [],
    wallet: { address: '5U3D1bg3jFL2n3zPXSkwQnQKvU4uEPrKzJ6aXvQf6tTq' },
    logger: () => {},
    persistState: async () => {},
    calculateGMI: () => 0.5,
    rotateRpcSubscriptions: () => {},
    getCurrentRpcSubscriptions: () => ({}) as any,
  };
}

export async function withMockedFetch<T>(
  handler: (input: any, init?: any) => Promise<Response>,
  fn: () => Promise<T>
): Promise<T> {
  const originalFetch = global.fetch;
  global.fetch = handler as any;
  try {
    return await fn();
  } finally {
    global.fetch = originalFetch;
  }
}

export async function withPatchedMembers<T>(
  target: any,
  patches: Record<string, any>,
  fn: () => Promise<T>
): Promise<T> {
  const originals = new Map();
  for (const [key, value] of Object.entries(patches)) {
    originals.set(key, target[key]);
    target[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of originals) {
      target[key] = value;
    }
  }
}

export function seedBotState(
  configOverrides: Partial<Config> = {},
  stateOverrides: Partial<State> = {}
) {
  const config = createTestConfig(configOverrides);
  const store = new StateStore(config);
  Object.assign(store.state, createState(stateOverrides));

  bot._setTestConfig(config);
  bot._setTestState(store.state);

  const ctx: Context = {
    config,
    state: store.state,
    store,
    rpc: {} as any,
    rpcs: [],
    rpcSubscriptions: {} as any,
    rpcSubscriptionPool: [],
    wallet: { address: '11111111111111111111111111111111' },
    logger: () => {},
    persistState: async () => {},
    calculateGMI: store.calculateGMI.bind(store),
    rotateRpcSubscriptions: () => {},
    getCurrentRpcSubscriptions: () => ({}) as any,
  };

  bot._setTestCtx(ctx);

  return {
    config,
    state: store.state,
    store,
    cleanup: () => {
      bot._setTestCtx(null);
    },
  };
}
