'use strict';

global.__TEST__ = true;

const path = require('node:path');

function createTestConfig(overrides = {}) {
  const rpcUrl = 'http://localhost:8899';
  return {
    logFile: path.join(process.cwd(), '.test-artifacts', 'bot.log'),
    stateFile: '',
    metricsFile: '',
    mintsFile: '',
    jupiterBaseUrl: 'http://mock',
    jupiterApiKey: 'test-key',
    jupiterPositionApiKey: 'position-key',
    rpcUrl,
    rpcUrls: [rpcUrl],
    wsRpcUrl: 'ws://localhost:8900',
    wsRpcUrls: ['ws://localhost:8900'],
    buyAmountLamports: '50000000',
    buyAmountSolText: '0.05',
    initialPaperSolText: '1',
    initialPaperSolLamports: '1000000000',
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
    priorityFeeBaseMicroLamports: 25_000,
    priorityFeeMaxMicroLamports: 5_000_000,
    priorityFeePanicMultiplier: 2,
    priorityFeePercentile: 75,
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
    backtestSolUsdPrice: 150,
    ...overrides,
  };
}

function createState(overrides = {}) {
  return {
    processedMintQueue: [],
    processedMints: new Set(),
    pendingCandidateRechecks: new Map(),
    positions: new Map(),
    marketSnapshots: new Map(),
    paperSolBalanceLamports: '1000000000',
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
    ...overrides,
  };
}

function createCtx(configOverrides = {}, stateOverrides = {}) {
  const config = createTestConfig(configOverrides);
  const StateStore = require('../store');
  const store = new StateStore(config);
  Object.assign(store.state, createState(stateOverrides));
  return {
    config,
    state: store.state,
    store,
    rpc: {},
    rpcs: [],
    wallet: { address: 'mock-wallet' },
    logger: () => {},
    persistState: () => {},
    calculateGMI: () => 0.5,
  };
}

async function withMockedFetch(handler, fn) {
  const originalFetch = global.fetch;
  global.fetch = handler;
  try {
    return await fn();
  } finally {
    global.fetch = originalFetch;
  }
}

async function withPatchedMembers(target, patches, fn) {
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

function seedBotState(configOverrides = {}, stateOverrides = {}) {
  const config = createTestConfig(configOverrides);
  const StateStore = require('../store');
  const store = new StateStore(config);
  Object.assign(store.state, createState(stateOverrides));
  const bot = require('../bot');
  bot._setTestConfig(config);
  bot._setTestState(store.state);
  const originals = { getCtx: bot.getCtx };
  bot.getCtx = () => ({
    config,
    state: store.state,
    store,
    rpc: {},
    rpcs: [],
    wallet: { address: 'mock-wallet' },
    logger: () => {},
    persistState: () => {},
    calculateGMI: store.calculateGMI.bind(store),
  });
  return {
    config,
    state: store.state,
    store,
    cleanup: () => {
      bot.getCtx = originals.getCtx;
    },
  };
}

module.exports = {
  createTestConfig,
  createState,
  createCtx,
  withMockedFetch,
  withPatchedMembers,
  seedBotState,
};
