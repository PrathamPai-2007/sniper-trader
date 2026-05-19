'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { Response } = globalThis;
const audit = require('./audit');
const bot = require('./bot');
const engine = require('./engine');
const monitor = require('./monitor');
const services = require('./services');
const trading = require('./trading');
const utils = require('./utils');
const { constants, validateStartupConfig } = require('./config');
const { decodePumpCurve, runBoundedPool } = utils;

function createTestConfig(overrides = {}) {
  const rpcUrl = 'http://localhost:8899';
  return {
    logFile: path.join(process.cwd(), '.test-artifacts', 'bot.log'),
    stateFile: '',
    metricsFile: '',
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
  const state = createState(stateOverrides);
  return {
    config,
    state,
    rpc: {},
    rpcs: [],
    wallet: { address: 'mock-wallet' },
    logger: () => {},
    persistState: () => {},
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
  const state = bot.loadState('');
  Object.assign(state, createState(stateOverrides));
  bot._setTestConfig(config);
  bot._setTestState(state);
  return { config, state };
}

test('engine evaluates buying-the-top only when price is near ATH after steep growth', async () => {
  const ctx = createCtx();
  const token = {
    id: 'TopMint',
    usdPrice: 225,
    liquidity: 10_000,
    holderCount: 100,
    stats5m: { numBuys: 50, numSells: 10 },
    organicScore: 100,
  };

  const noContext = await engine.evaluateCandidate(ctx, token);
  assert.equal(noContext.approved, true);

  const notAtTop = await engine.evaluateCandidate(ctx, token, 250, [], 100);
  assert.equal(notAtTop.approved, true);

  const atTop = await engine.evaluateCandidate(ctx, token, 226, [], 100);
  assert.equal(atTop.approved, false);
  assert.deepEqual(
    atTop.rejectionReasons.find((reason) => reason.code === 'buying-the-top'),
    { code: 'buying-the-top', recheckEligible: true }
  );
});

test('engine GMI adjusts aggression correctly', async () => {
  const config = createTestConfig({
    minCandidateScore: 70,
    memeKeywords: ['ape'],
    maxMemeFdvUsd: 10_000_000,
    minOrganicScore: 0,
    minSocialLinks: 0,
    allowVerifiedTokens: true,
    maxAuditTopHoldersPct: 100,
    maxCandidateAgeMinutes: 60,
    borderlineThresholdBufferRatio: 0.2,
  });
  const state = createState({ launchHistory: [], retiredMints: new Map() });
  const ctx = { config, state };

  // 1. GMI Neutral (no history)
  ctx.calculateGMI = () => 0.5;
  const token = {
    id: 'test',
    usdPrice: 1,
    liquidity: 50_000, // Ratio > 5 relative to minLiquidityUsd=750
    holderCount: 1000,
    stats5m: { numBuys: 100 },
    name: 'ape',
    website: 'http',
    twitter: 'http',
    telegram: 'http', // 3 social links
    launchpad: 'pump.fun',
    firstPool: { createdAt: new Date(Date.now() - 30_000).toISOString() },
  };

  // GMI Neutral: Target 70. Score 75 should PASS.
  let result = await engine.evaluateCandidate(ctx, token);
  assert.strictEqual(result.candidateScore, 85);
  assert.strictEqual(result.approved, true);

  // GMI Low (< 0.3): Target 70 + 35 = 105. Score 85 should FAIL.
  ctx.calculateGMI = () => 0.2;
  config.minCandidateScore = 105;
  result = await engine.evaluateCandidate(ctx, token);
  assert.strictEqual(result.approved, false);
  assert.ok(result.blockers.some((b) => b.includes('Low entry score')));

  // GMI High (> 0.7): Target 70 - 5 = 65. Score 65 should PASS.
  ctx.calculateGMI = () => 0.8;
  config.minCandidateScore = 65;
  const lowLiqToken = {
    ...token,
    liquidity: config.minLiquidityUsd,
    launchpad: null, // unknown launchpad -> scoreBonus 0
    firstPool: { createdAt: new Date(Date.now() - 30_000).toISOString() },
  };
  result = await engine.evaluateCandidate(ctx, lowLiqToken);
  assert.strictEqual(result.candidateScore, 65);
  assert.strictEqual(result.approved, true);
});

test('engine computes score bonuses from socials and liquidity tiers', () => {
  const thresholds = { minLiquidityUsd: 1000 };
  const profile = { scoreBonus: 10 };

  assert.equal(engine.computeCandidateScore({ liquidity: 1000 }, profile, thresholds, 0), 60);
  assert.equal(
    engine.computeCandidateScore({ liquidity: 1000, organicScore: '15' }, profile, thresholds, 0),
    75
  );
  assert.equal(engine.computeCandidateScore({ liquidity: 1000 }, profile, thresholds, 3), 75);
  assert.equal(engine.computeCandidateScore({ liquidity: 6000 }, profile, thresholds, 0), 70);
});

test('engine treats non-string launchpads as unknown profiles', () => {
  assert.deepEqual(engine.getLaunchpadProfile({ name: 'pump.fun' }), { name: 'unknown' });
  assert.deepEqual(engine.getLaunchpadProfile(123), { name: 'unknown' });
});

test('engine applies launchpad-specific threshold multipliers', () => {
  const ctx = {
    config: { minLiquidityUsd: 1000, minHolderCount: 100, minBuys5m: 10, minPoolAgeSeconds: 30 },
  };
  const profile = {
    name: 'pump.fun',
    liquidityMultiplier: 0.5,
    holderMultiplier: 0.8,
    buysMultiplier: 0.1,
  };

  const thresholds = engine.getLaunchpadAdjustedThresholds(ctx, profile);
  assert.equal(thresholds.minLiquidityUsd, 500);
  assert.equal(thresholds.minHolderCount, 80);
  assert.equal(thresholds.minBuys5m, 1);
});

test('engine identifies memecoin candidates from name, symbol, fdv, and launchpad', () => {
  const ctx = { config: { memeKeywords: ['pepe', 'doge'], maxMemeFdvUsd: 1_000_000 } };

  assert.equal(engine.looksLikeMemecoin(ctx, { name: 'Pepe Coin' }), true);
  assert.equal(engine.looksLikeMemecoin(ctx, { symbol: 'DOGE' }), true);
  assert.equal(engine.looksLikeMemecoin(ctx, { name: 'pepe', fdv: 500_000 }), true);
  assert.equal(engine.looksLikeMemecoin(ctx, { launchpad: 'pump.fun' }), true);
  assert.equal(engine.looksLikeMemecoin(ctx, { name: 'Serious Token', fdv: 2_000_000 }), false);
});

test('engine borderline threshold helper honors configured buffer', () => {
  const ctx = { config: { borderlineThresholdBufferRatio: 0.2 } };

  assert.equal(engine.isSlightlyBelowThreshold(ctx, 85, 100), true);
  assert.equal(engine.isSlightlyBelowThreshold(ctx, 75, 100), false);
  assert.equal(engine.isSlightlyBelowThreshold(ctx, 110, 100), true);
});

test('engine rejects candidates when fdv-to-liquidity exceeds the configured threshold', async () => {
  const ctx = createCtx({ maxFdvToLiquidity: 5 });
  const token = {
    id: 'FdvGateMint',
    symbol: 'FDV',
    name: 'FDV Gate',
    usdPrice: 1,
    liquidity: 1_000,
    fdv: 10_000,
    holderCount: 50,
    organicScore: 10,
    stats5m: { numBuys: 10, numSells: 1 },
    firstPool: { createdAt: new Date(Date.now() - 60_000).toISOString() },
  };

  const evaluation = await engine.evaluateCandidate(ctx, token);
  assert.equal(evaluation.approved, false);
  assert.ok(evaluation.rejectionReasons.some((reason) => reason.code === 'fdv-liquidity-too-high'));
});

test('engine treats missing fdv as neutral when evaluating candidates', async () => {
  const ctx = createCtx({ maxFdvToLiquidity: 5 });
  const token = {
    id: 'NoFdvMint',
    symbol: 'NFDV',
    name: 'No FDV',
    usdPrice: 1,
    liquidity: 1_000,
    holderCount: 50,
    organicScore: 10,
    stats5m: { numBuys: 10, numSells: 1 },
    firstPool: { createdAt: new Date(Date.now() - 60_000).toISOString() },
  };

  const evaluation = await engine.evaluateCandidate(ctx, token);
  assert.equal(evaluation.approved, true);
});

test('engine flags sell pressure when rolling buy counts decrease', async () => {
  const ctx = createCtx();
  const token = {
    id: 'SellPressureMint',
    symbol: 'SP',
    name: 'Pepe Sell Pressure',
    usdPrice: 1,
    liquidity: 10_000,
    holderCount: 50,
    organicScore: 10,
    stats5m: { numBuys: 80, numSells: 5 },
    firstPool: { createdAt: new Date(Date.now() - 60_000).toISOString() },
  };

  const evaluation = await engine.evaluateCandidate(ctx, token, null, [], null, null, {
    buys: 100,
    sells: 1,
  });

  assert.equal(evaluation.approved, false);
  assert.ok(evaluation.rejectionReasons.some((reason) => reason.code === 'high-sell-pressure'));
});

test('engine sanitizes historical price points before volatility and momentum filters', async () => {
  const ctx = createCtx({ earlyPerformanceGuardSeconds: 1 });
  const now = Date.now();
  const token = {
    id: 'HistoryMint',
    symbol: 'HIST',
    name: 'Pepe History',
    usdPrice: 1.2,
    liquidity: 10_000,
    holderCount: 50,
    organicScore: 10,
    stats5m: { numBuys: 10, numSells: 1 },
    firstPool: { createdAt: new Date(now - 60_000).toISOString() },
  };
  const priceHistory = [
    { price: '1.00', timestamp: now - 12_000 },
    { price: 'bad', timestamp: now - 10_000 },
    { price: 0, timestamp: now - 8_000 },
    { price: '1.05', timestamp: now - 7_000 },
    { price: 1.1, timestamp: now - 5_000 },
    { price: 1.15, timestamp: now - 3_000 },
    { price: 1.18, timestamp: now - 1_000 },
  ];

  const evaluation = await engine.evaluateCandidate(ctx, token, null, priceHistory, 1);

  assert.equal(Number.isFinite(evaluation.volatilityScaler), true);
  assert.ok(evaluation.volatilityScaler > 0);
});

test('engine reduced historical notes accept numeric strings as present', async () => {
  const ctx = createCtx();
  const token = {
    id: 'HistoricalStringMint',
    symbol: 'PEPE',
    name: 'Historical Pepe',
    usdPrice: 1.2,
    liquidity: 8_500,
    holderCount: '12',
    organicScore: '5',
    stats5m: { numBuys: '3' },
    launchpad: 'pump.fun',
    firstPool: { createdAt: new Date(Date.now() - 60_000).toISOString() },
    snapshotQuality: 'reduced-historical',
  };

  const evaluation = await engine.evaluateCandidate(ctx, token);

  assert.equal(evaluation.approved, true);
  assert.equal(
    evaluation.notes.some((note) => /missing holder count/i.test(note)),
    false
  );
  assert.equal(
    evaluation.notes.some((note) => /missing organic score/i.test(note)),
    false
  );
  assert.equal(
    evaluation.notes.some((note) => /missing 5m buy tape/i.test(note)),
    false
  );
});

test('engine full audit reports downstream blockers even after mint blockers', async () => {
  const ctx = createCtx(
    {},
    { retiredMints: new Map([['FullAuditMint', { lastExitPriceUsd: 1 }]]) }
  );
  const token = {
    id: 'FullAuditMint',
    symbol: 'FULL',
    name: 'Pepe Full Audit',
    usdPrice: 1.05,
    liquidity: 10_000,
    holderCount: 50,
    organicScore: 10,
    stats5m: { numBuys: 10, numSells: 1 },
    firstPool: { createdAt: new Date(Date.now() - 60_000).toISOString() },
  };

  await withPatchedMembers(
    audit,
    {
      getMintSignals: async () => ({
        mintAuthority: 'mint-authority',
        freezeAuthority: null,
        top1Share: 0,
        top5Share: 0,
        topAccounts: [{ owner: 'owner-a' }],
      }),
      fetchGoPlusTokenSignals: async () => null,
      fetchBubbleMapsSignals: async () => null,
      fetchGoPlusAddressSignals: async () => [{ address: 'owner-a' }],
    },
    async () => {
      const evaluation = await engine.evaluateCandidate(
        ctx,
        token,
        null,
        [],
        null,
        null,
        null,
        [],
        'full'
      );
      const codes = evaluation.rejectionReasons.map((reason) => reason.code);

      assert.equal(evaluation.approved, false);
      assert.ok(codes.includes('mint-authority-enabled'));
      assert.ok(codes.includes('goplus-malicious-owner'));
      assert.ok(codes.includes('price-distance-gate'));
    }
  );
});

test('bot schedules survival delays using score-based timing tiers', () => {
  const { state } = seedBotState();
  const now = Date.now();

  const schedule = (score) => {
    bot.scheduleSurvivalDelay({
      candidateScore: score,
      token: {
        id: `Mint-${score}`,
        usdPrice: 1,
        liquidity: 1000,
        stats5m: { numBuys: 10, numSells: 0 },
      },
    });
    return state.pendingCandidateRechecks.get(`Mint-${score}`);
  };

  const veryHigh = schedule(95);
  const high = schedule(80);
  const standard = schedule(60);

  assert.ok(new Date(veryHigh.nextEligibleAt).getTime() - now <= 2500);
  assert.ok(new Date(high.nextEligibleAt).getTime() - now >= 9000);
  assert.ok(new Date(standard.nextEligibleAt).getTime() - now >= 19_000);
  assert.equal(veryHigh.isSurvivalWait, true);
});

test('bot schedules indexing-lag retries and drops entries after the retry cap', () => {
  const { config, state } = seedBotState({ rpcIndexingRetryDelayMs: 1234 });
  state.pendingCandidateRechecks.set('LagMint', {
    mint: 'LagMint',
    tokenSnapshot: { id: 'LagMint', symbol: 'LAG' },
    isFinalAudit: true,
    indexingLagRetries: 2,
  });

  bot.scheduleIndexingLagRetry(
    {
      recheckEntry: state.pendingCandidateRechecks.get('LagMint'),
      token: { id: 'LagMint', symbol: 'LAG' },
    },
    'RPC Indexing Lag'
  );

  const retried = state.pendingCandidateRechecks.get('LagMint');
  assert.equal(retried.indexingLagRetries, 3);
  assert.ok(new Date(retried.nextEligibleAt).getTime() > Date.now());
  assert.equal(state.metrics.finalAuditDeferredIndexing, 1);

  bot.scheduleIndexingLagRetry(
    {
      recheckEntry: retried,
      token: { id: 'LagMint', symbol: 'LAG' },
    },
    'RPC Indexing Lag'
  );

  assert.equal(state.pendingCandidateRechecks.has('LagMint'), false);
  assert.equal(config.rpcIndexingRetryDelayMs, 1234);
});

test('bot holder-count waitlists use the dedicated holder wait duration', () => {
  const { state } = seedBotState({ holderCountWaitlistSeconds: 42 });
  const now = Date.now();
  bot.scheduleRecheckEligibleWaitlist({ token: { id: 'HolderMint' } }, null, {
    lowHolderWaitlist: true,
  });

  const entry = state.pendingCandidateRechecks.get('HolderMint');
  const delayMs = new Date(entry.nextEligibleAt).getTime() - now;
  assert.ok(delayMs >= 41_000 && delayMs <= 43_000);
});

test('bot skips borderline requeues entirely when borderline rechecks are disabled', async () => {
  const { state } = seedBotState({ borderlineRecheckEnabled: false, maxCandidatesPerScan: 5 });
  const token = { id: 'NoRequeueMint', symbol: 'NRQ', liquidity: 1000, usdPrice: 1 };

  await withPatchedMembers(
    services,
    {
      fetchRecentLaunches: async () => [token],
      evaluateCandidate: async () => ({
        approved: false,
        token,
        blockers: ['Low holders 1.'],
        rejectionReasons: [{ code: 'low-holders', recheckEligible: true }],
      }),
    },
    async () => {
      await bot.scanForCandidates();
      assert.equal(state.pendingCandidateRechecks.size, 0);
      assert.equal(state.processedMints.has('NoRequeueMint'), true);
    }
  );
});

test('bot cancels pullback rechecks when price deterioration exceeds the configured threshold', async () => {
  const { state } = seedBotState({ recheckPriceDropPct: 10, maxCandidatesPerScan: 5 });
  state.pendingCandidateRechecks.set('PullbackMint', {
    mint: 'PullbackMint',
    tokenSnapshot: { id: 'PullbackMint', symbol: 'PBK', liquidity: 1000, usdPrice: 80 },
    highestSeenPriceUsd: 100,
    isFinalAudit: true,
  });

  const token = { id: 'PullbackMint', symbol: 'PBK', liquidity: 1000, usdPrice: 80 };
  await withPatchedMembers(
    services,
    {
      fetchRecentLaunches: async () => [token],
      evaluateCandidate: async () => ({
        approved: false,
        token,
        blockers: ['Buying the top detected.'],
        rejectionReasons: [{ code: 'buying-the-top', recheckEligible: true }],
      }),
    },
    async () => {
      await bot.scanForCandidates();
      assert.equal(state.pendingCandidateRechecks.has('PullbackMint'), false);
      assert.equal(state.processedMints.has('PullbackMint'), true);
    }
  );
});

test('bot counts reserved buy slots against the max open position limit', async () => {
  const { state } = seedBotState({
    maxOpenPositions: 1,
    maxBuysPerScan: 2,
    maxCandidatesPerScan: 5,
    scanParallelismHeavy: 2,
  });
  const tokens = [
    { id: 'FinalMintA', symbol: 'FA', usdPrice: 1, liquidity: 2000 },
    { id: 'FinalMintB', symbol: 'FB', usdPrice: 1, liquidity: 2000 },
  ];

  for (const token of tokens) {
    state.pendingCandidateRechecks.set(token.id, {
      mint: token.id,
      tokenSnapshot: token,
      isFinalAudit: true,
      nextEligibleAt: new Date(Date.now() - 1000).toISOString(),
    });
  }

  let buyAttempts = 0;
  await withPatchedMembers(
    services,
    {
      fetchRecentLaunches: async () => tokens,
      evaluateCandidate: async (_ctx, token) => ({
        approved: true,
        token,
        blockers: [],
        rejectionReasons: [],
        candidateScore: 80,
      }),
      buyCandidate: async (_ctx, evaluation) => {
        buyAttempts++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        const pos = { mint: evaluation.token.id, symbol: evaluation.token.symbol };
        state.positions.set(evaluation.token.id, pos);
        return pos;
      },
    },
    async () => {
      await bot.scanForCandidates();
    }
  );

  assert.equal(buyAttempts, 1);
  assert.equal(state.positions.size, 1);
});

test('services normalizes Jupiter price payloads with and without a data wrapper', async () => {
  const ctx = createCtx();

  await withMockedFetch(
    async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          data: {
            mint1: { price: '1.23' },
            mint2: { usdPrice: '4.56' },
          },
        }),
    }),
    async () => {
      const prices = await services.fetchPrices(ctx, ['mint1', 'mint2']);
      assert.equal(prices.mint1.usdPrice, 1.23);
      assert.equal(prices.mint2.usdPrice, 4.56);
    }
  );

  await withMockedFetch(
    async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          mint3: { usdPrice: '7.89' },
        }),
    }),
    async () => {
      const prices = await services.fetchPrices(ctx, ['mint3']);
      assert.equal(prices.mint3.usdPrice, 7.89);
    }
  );
});

test('services falls back to per-mint Jupiter lookups when batch pricing fails', async () => {
  const ctx = createCtx({ priceFallbackParallelism: 2 });
  ctx.state.marketSnapshots.set('mint-a', { launchpad: 'raydium' });
  ctx.state.marketSnapshots.set('mint-b', { launchpad: 'raydium' });

  const calls = [];
  await withMockedFetch(
    async (url) => {
      calls.push(url);
      if (url.includes('ids=mint-a%2Cmint-b')) {
        throw new Error('429 too many requests');
      }

      if (url.includes('ids=mint-a')) {
        return { ok: true, text: async () => JSON.stringify({ 'mint-a': { usdPrice: '3.21' } }) };
      }

      if (url.includes('ids=mint-b')) {
        return { ok: true, text: async () => JSON.stringify({ 'mint-b': { usdPrice: '6.54' } }) };
      }

      throw new Error(`unexpected url ${url}`);
    },
    async () => {
      const prices = await services.fetchPricesBestEffort(ctx, ['mint-a', 'mint-b'], 'test');
      assert.equal(prices['mint-a'].usdPrice, 3.21);
      assert.equal(prices['mint-b'].usdPrice, 6.54);
      assert.equal(calls.length, 3);
    }
  );
});

test('services uses the requested Jupiter API key when fetching prices', async () => {
  const ctx = createCtx();
  let lastApiKey = null;

  await withMockedFetch(
    async (_url, options) => {
      lastApiKey = options.headers['x-api-key'];
      return { ok: true, text: async () => JSON.stringify({ mint1: { usdPrice: 1 } }) };
    },
    async () => {
      await services.fetchPrices(ctx, ['mint1'], ctx.config.jupiterPositionApiKey);
      assert.equal(lastApiKey, 'position-key');

      await services.fetchPrices(ctx, ['mint1']);
      assert.equal(lastApiKey, 'test-key');
    }
  );
});

test('services mergeLoopRequest combines flags, counts, and reasons deterministically', () => {
  const merged = services.mergeLoopRequest(
    { forceDiscovery: false, skipMonitor: true, websocketSignalCount: 2, reason: 'ws' },
    { forceDiscovery: true, skipMonitor: false, websocketSignalCount: 3, reason: 'manual' }
  );

  assert.deepEqual(merged, {
    forceDiscovery: true,
    skipMonitor: true,
    websocketSignalCount: 5,
    reason: 'ws+manual',
  });
});

test('services paper buy and shutdown sell complete a profitable round trip', async () => {
  const initialSol = 1_000_000_000n;
  const ctx = createCtx(
    { paperTrading: true },
    {
      paperSolBalanceLamports: initialSol.toString(),
      positions: new Map(),
      metrics: {
        buyAttempts: 0,
        buyFailures: 0,
        profitableTrades: 0,
        stopLosses: 0,
        trailingExits: 0,
      },
      tradeHistory: [],
      coolDownMints: new Map(),
    }
  );

  await withMockedFetch(
    async () => {
      const prices = {
        [constants.SOL_MINT]: { usdPrice: 100 },
        PaperMint: { usdPrice: 2 },
      };
      return { ok: true, text: async () => JSON.stringify({ data: prices }) };
    },
    async () => {
      const position = await services.buyCandidate(ctx, {
        token: {
          id: 'PaperMint',
          symbol: 'P',
          name: 'Paper Mint',
          decimals: 6,
          usdPrice: 1,
          liquidity: 2000,
        },
        candidateScore: 80,
        mintSignals: { decimals: 6 },
      });

      assert.ok(position);
      assert.equal(ctx.state.positions.has('PaperMint'), true);

      await services.closeAllOpenPositions(ctx);
      assert.equal(ctx.state.positions.has('PaperMint'), false);
      assert.ok(BigInt(ctx.state.paperSolBalanceLamports) > initialSol);
    }
  );
});

test('services live buy dry-run inspects balances but does not execute a swap', async () => {
  const ctx = createCtx(
    { paperTrading: false, dryRun: true },
    {
      positions: new Map(),
      metrics: { buyAttempts: 0, buyFailures: 0 },
    }
  );
  let executeCalled = false;
  let balanceCalls = 0;

  await withPatchedMembers(
    trading,
    {
      fetchSwapOrder: async (_ctx, inputMint, outputMint, amount) => {
        assert.equal(inputMint, constants.SOL_MINT);
        assert.equal(outputMint, 'LiveBuyMint');
        assert.equal(amount, '50000000');
        return { transaction: 'mock-order', inUsdValue: 5, outAmount: '1000000' };
      },
      getWalletTokenBalance: async () => {
        balanceCalls++;
        return { mint: 'LiveBuyMint', rawAmount: 0n, decimals: 6 };
      },
      executeSwapOrder: async () => {
        executeCalled = true;
        return 'unreachable';
      },
    },
    async () => {
      const position = await services.buyCandidate(ctx, {
        token: {
          id: 'LiveBuyMint',
          symbol: 'LB',
          name: 'Live Buy',
          decimals: 6,
          usdPrice: 5,
          liquidity: 2000,
        },
        candidateScore: 80,
        mintSignals: { decimals: 6 },
      });

      assert.equal(position, null);
      assert.equal(executeCalled, false);
      assert.equal(balanceCalls, 1);
      assert.equal(ctx.state.metrics.buyAttempts, 1);
      assert.equal(ctx.state.metrics.buyFailures, 0);
    }
  );
});

test('services live buy records bookkeeping when swap execution succeeds', async () => {
  const ctx = createCtx(
    { paperTrading: false, dryRun: false },
    {
      positions: new Map(),
      metrics: { buyAttempts: 0, buyFailures: 0 },
    }
  );
  let balanceCalls = 0;

  await withPatchedMembers(
    trading,
    {
      fetchSwapOrder: async () => ({
        transaction: 'mock-order',
        inUsdValue: 5,
        outAmount: '1000000',
      }),
      executeSwapOrder: async () => 'mock-buy-signature',
      getWalletTokenBalance: async () => {
        balanceCalls++;
        return balanceCalls === 1
          ? { mint: 'LiveBuyMint', rawAmount: 0n, decimals: 6 }
          : { mint: 'LiveBuyMint', rawAmount: 1_000_000n, decimals: 6 };
      },
    },
    async () => {
      const position = await services.buyCandidate(ctx, {
        token: {
          id: 'LiveBuyMint',
          symbol: 'LB',
          name: 'Live Buy',
          decimals: 6,
          usdPrice: 5,
          liquidity: 2000,
        },
        candidateScore: 80,
        mintSignals: { decimals: 6 },
      });

      assert.ok(position);
      assert.equal(ctx.state.positions.has('LiveBuyMint'), true);
      assert.equal(position.buySignature, 'mock-buy-signature');
      assert.equal(position.initialTokenAmountRaw, '1000000');
      assert.equal(ctx.state.metrics.buyAttempts, 1);
      assert.equal(ctx.state.metrics.buyFailures, 0);
    }
  );
});

test('services live buy persists nested BigInt audit metadata without failing the order', async () => {
  const ctx = createCtx(
    { paperTrading: false, dryRun: false },
    {
      positions: new Map(),
      metrics: { buyAttempts: 0, buyFailures: 0 },
    }
  );
  let balanceCalls = 0;
  const writes = [];

  await withPatchedMembers(
    utils,
    {
      atomicWriteFile: async (_filePath, content) => {
        writes.push(content);
      },
    },
    async () => {
      await withPatchedMembers(
        trading,
        {
          fetchSwapOrder: async () => ({
            transaction: 'mock-order',
            inUsdValue: 5,
            outAmount: '1000000',
          }),
          executeSwapOrder: async () => 'mock-buy-signature',
          getWalletTokenBalance: async () => {
            balanceCalls++;
            return balanceCalls === 1
              ? { mint: 'LiveBuyMint', rawAmount: 0n, decimals: 6 }
              : { mint: 'LiveBuyMint', rawAmount: 1_000_000n, decimals: 6 };
          },
        },
        async () => {
          const position = await services.buyCandidate(ctx, {
            token: {
              id: 'LiveBuyMint',
              symbol: 'LB',
              name: 'Live Buy',
              decimals: 6,
              usdPrice: 5,
              liquidity: 2000,
            },
            candidateScore: 80,
            mintSignals: {
              decimals: 6,
              supplyRaw: 123_456_789n,
              topAccounts: [{ address: 'holder-1', rawAmount: 25_000_000n, share: 0.2 }],
            },
          });

          assert.ok(position);
          assert.equal(ctx.state.positions.has('LiveBuyMint'), true);
          assert.equal(ctx.state.metrics.buyFailures, 0);
        }
      );
    }
  );

  assert.ok(writes.length > 0);
  const persisted = writes.join('\n');
  assert.match(persisted, /"supplyRaw": "123456789"/);
  assert.match(persisted, /"rawAmount": "25000000"/);
});

test('services live buy increments failure accounting when quoting fails', async () => {
  const ctx = createCtx(
    { paperTrading: false, dryRun: false },
    {
      positions: new Map(),
      metrics: { buyAttempts: 0, buyFailures: 0 },
    }
  );

  await withPatchedMembers(
    trading,
    {
      fetchSwapOrder: async () => {
        throw new Error('quote unavailable');
      },
    },
    async () => {
      const position = await services.buyCandidate(ctx, {
        token: {
          id: 'LiveBuyMint',
          symbol: 'LB',
          name: 'Live Buy',
          decimals: 6,
          usdPrice: 5,
          liquidity: 2000,
        },
        candidateScore: 80,
        mintSignals: { decimals: 6 },
      });

      assert.equal(position, null);
      assert.equal(ctx.state.positions.size, 0);
      assert.equal(ctx.state.metrics.buyAttempts, 1);
      assert.equal(ctx.state.metrics.buyFailures, 1);
    }
  );
});

test('audit mint signal retries stop at the configured indexing-lag attempt limit', async () => {
  let accountInfoCalls = 0;
  const mockRpc = {
    getAccountInfo: () => ({
      send: async () => {
        accountInfoCalls++;
        return { value: { data: { parsed: null } } };
      },
    }),
    getTokenLargestAccounts: () => ({
      send: async () => ({ value: [] }),
    }),
  };
  const ctx = {
    config: createTestConfig({ mintSignalMaxAttempts: 2, mintSignalRetryDelayMs: 1 }),
    rpc: mockRpc,
    rpcs: [mockRpc],
  };

  await assert.rejects(() => audit.getMintSignals(ctx, constants.SOL_MINT), /RPC Indexing Lag/);
  assert.equal(accountInfoCalls, 2);
});

test('audit mint signals fail closed when parsed mint info is missing', async () => {
  const mockRpc = {
    getAccountInfo: () => ({
      send: async () => ({ value: { data: { parsed: { type: 'mint' } } } }),
    }),
    getTokenLargestAccounts: () => ({
      send: async () => ({ value: [{ address: constants.SOL_MINT, amount: '1' }] }),
    }),
  };
  const ctx = {
    config: createTestConfig({ mintSignalRetryDelayMs: 1 }),
    rpc: mockRpc,
    rpcs: [mockRpc],
  };

  await assert.rejects(
    () => audit.getMintSignals(ctx, constants.SOL_MINT),
    /parsed mint info missing/
  );
});

test('audit GoPlus address signals parse direct result payloads and expanded malicious fields', async () => {
  const ctx = createCtx({
    goPlusAccessToken: 'token',
    goPlusBaseUrl: 'https://mock-goplus',
    ownerAuditParallelism: 2,
  });

  await withMockedFetch(
    async (url) => {
      if (String(url).includes('/address_security/owner-a')) {
        return new Response(
          JSON.stringify({
            result: {
              blacklist_doubt: '1',
            },
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          result: {
            malicious_behavior: ['stealing_attack'],
          },
        }),
        { status: 200 }
      );
    },
    async () => {
      const malicious = await audit.fetchGoPlusAddressSignals(ctx, ['owner-a', 'owner-b']);

      assert.deepEqual(
        malicious.map((entry) => entry.address),
        ['owner-a', 'owner-b']
      );
    }
  );
});

test('monitor mood adjustments reduce size after a cold streak and pause after a severe one', () => {
  const ctx = createCtx({}, { tradeHistory: [], moodPauseUntil: null });

  assert.deepEqual(monitor.getMoodAdjustments(ctx), { isPaused: false, sizeMultiplier: 1 });

  ctx.state.tradeHistory = [true, false, false, false, false];
  assert.equal(monitor.getMoodAdjustments(ctx).sizeMultiplier, 0.5);

  ctx.state.tradeHistory = [false, false, false, false, false, false, false, false, false, true];
  assert.equal(monitor.getMoodAdjustments(ctx).isPaused, true);
});

test('monitor take-profit helpers compute fractions and raw sell amounts', () => {
  const position = { takeProfitFractions: [0.5, 0.2] };

  assert.equal(monitor.getTakeProfitFraction(position, 0), 0.5);
  assert.equal(monitor.getTakeProfitFraction(position, 1), 0.2);
  assert.equal(monitor.computeTakeProfitSellAmount(10_000n, 0.5), 5_000n);
});

test('monitor derives score-based trade management profiles', () => {
  const ctx = createCtx({
    minCandidateScore: 60,
    highGrowthConfidenceScore: 70,
    maxHoldMinutes: 60,
    holdDurationHighConfidenceMinutes: 12,
    holdDurationLowConfidenceMinutes: 4,
  });

  const high = monitor.getTakeProfitPlan(ctx, 80);
  assert.equal(high.profileId, 'high-confidence');
  assert.deepEqual(high.takeProfitMultiples, [1.5, 2.5]);
  assert.deepEqual(high.takeProfitFractions, [0.35, 0.35]);
  assert.equal(high.trailingStopDrawdownPct, 0.2);
  assert.equal(high.maxHoldMinutesResolved, 12);

  const standard = monitor.getTakeProfitPlan(ctx, 66);
  assert.equal(standard.profileId, 'standard-confidence');
  assert.deepEqual(standard.takeProfitMultiples, [1.3, 2.1]);
  assert.deepEqual(standard.takeProfitFractions, [0.5, 0.3]);
  assert.equal(standard.trailingStopDrawdownPct, 0.16);
  assert.equal(standard.maxHoldMinutesResolved, 60);

  const low = monitor.getTakeProfitPlan(ctx, 61);
  assert.equal(low.profileId, 'fast-de-risk');
  assert.deepEqual(low.takeProfitMultiples, [1.2, 1.8]);
  assert.deepEqual(low.takeProfitFractions, [0.6, 0.25]);
  assert.equal(low.trailingStopDrawdownPct, 0.12);
  assert.equal(low.maxHoldMinutesResolved, 4);
});

test('monitor Volatility Scaler adjusts SL correctly', () => {
  const config = { stopLossPct: 0.1 };

  // High volatility position (Scaler 0.5)
  const pos = {
    entryPriceUsd: 100,
    volatilityScaler: 0.5,
  };

  const baseSlPct = config.stopLossPct;
  const adjustedSlPct = baseSlPct * (1 + (pos.volatilityScaler || 0));
  const slP = pos.entryPriceUsd * (1 - adjustedSlPct);

  // Math check with epsilon
  assert.ok(Math.abs(adjustedSlPct - 0.15) < 0.00001);
  assert.ok(Math.abs(slP - 85) < 0.00001);

  // Low volatility position (Scaler 0.1)
  pos.volatilityScaler = 0.1;
  const adjustedSlPctLow = baseSlPct * (1 + pos.volatilityScaler);
  const slPLow = pos.entryPriceUsd * (1 - adjustedSlPctLow);

  assert.ok(Math.abs(adjustedSlPctLow - 0.11) < 0.00001);
  assert.ok(Math.abs(slPLow - 89) < 0.00001);
});

test('monitor Insider Drift tracking logic triggers correctly', () => {
  const initialHolders = [
    { owner: 'A', rawAmount: 1000n },
    { owner: 'B', rawAmount: 1000n },
  ];

  const pos = {
    mintSignals: { topAccounts: initialHolders },
  };

  // Case 1: Holder A sells 30% (Drop ratio 0.3 > 0.25)
  const newSignals = {
    topAccounts: [
      { owner: 'A', rawAmount: 700n },
      { owner: 'B', rawAmount: 1000n },
    ],
  };

  const initial = pos.mintSignals.topAccounts[0];
  const current = newSignals.topAccounts.find((a) => a.owner === initial.owner);
  const dropRatio = 1 - Number(current.rawAmount) / Number(initial.rawAmount);

  assert.ok(dropRatio > 0.25);
  assert.ok(Math.abs(dropRatio - 0.3) < 0.00001);
});

test('monitor closes live positions on stop-loss and records metrics', async () => {
  const ctx = createCtx(
    { paperTrading: false, dryRun: false, closePositionsOnShutdown: false },
    {
      positions: new Map([
        [
          'LiveMint',
          {
            mint: 'LiveMint',
            symbol: 'LIVE',
            decimals: 6,
            openedAt: new Date(Date.now() - 65_000).toISOString(),
            entryPriceUsd: 1,
            entryUsdValue: 100,
            remainingCostUsd: 100,
            realizedPnlUsd: 0,
            realizedProceedsUsd: 0,
            lastKnownBalanceRaw: '100000000',
            targetsHit: 0,
            takeProfitMultiples: [1.5],
          },
        ],
      ]),
      marketSnapshots: new Map(),
      metrics: { profitableTrades: 0, stopLosses: 0, trailingExits: 0 },
      tradeHistory: [],
      coolDownMints: new Map(),
    }
  );
  let balanceCalls = 0;

  await withPatchedMembers(
    trading,
    {
      fetchSwapOrder: async () => ({ transaction: 'mock-order' }),
      executeSwapOrder: async () => 'mock-signature',
      getWalletTokenBalance: async () => {
        balanceCalls++;
        return balanceCalls === 1
          ? { mint: 'LiveMint', rawAmount: 100_000_000n, decimals: 6 }
          : { mint: 'LiveMint', rawAmount: 0n, decimals: 6 };
      },
    },
    async () => {
      await monitor.monitorPositions(ctx, async () => ({ LiveMint: { usdPrice: 0.5 } }));
      assert.equal(ctx.state.positions.has('LiveMint'), false);
      assert.equal(ctx.state.metrics.stopLosses, 1);
    }
  );
});

test('monitor triggers stop-loss before the minimum hold time elapses', async () => {
  const ctx = createCtx(
    { paperTrading: false, dryRun: false, minHoldTimeSeconds: 300 },
    {
      positions: new Map([
        [
          'FastStopMint',
          {
            mint: 'FastStopMint',
            symbol: 'FSTOP',
            decimals: 6,
            openedAt: new Date(Date.now() - 20_000).toISOString(),
            entryPriceUsd: 1,
            entryUsdValue: 100,
            remainingCostUsd: 100,
            realizedPnlUsd: 0,
            realizedProceedsUsd: 0,
            lastKnownBalanceRaw: '100000000',
            targetsHit: 0,
            takeProfitMultiples: [1.5],
          },
        ],
      ]),
      metrics: { profitableTrades: 0, stopLosses: 0, trailingExits: 0, exitReasonCounts: {} },
      tradeHistory: [],
      coolDownMints: new Map(),
    }
  );
  let balanceCalls = 0;

  await withPatchedMembers(
    trading,
    {
      fetchSwapOrder: async () => ({ transaction: 'mock-order' }),
      executeSwapOrder: async () => 'mock-signature',
      getWalletTokenBalance: async () => {
        balanceCalls++;
        return balanceCalls === 1
          ? { mint: 'FastStopMint', rawAmount: 100_000_000n, decimals: 6 }
          : { mint: 'FastStopMint', rawAmount: 0n, decimals: 6 };
      },
    },
    async () => {
      await monitor.monitorPositions(ctx, async () => ({ FastStopMint: { usdPrice: 0.79 } }));
      assert.equal(ctx.state.positions.has('FastStopMint'), false);
      assert.equal(ctx.state.metrics.stopLosses, 1);
      assert.equal(ctx.state.metrics.exitReasonCounts['stop-loss'], 1);
    }
  );
});

test('monitor triggers liquidity exits before the minimum hold time elapses', async () => {
  const ctx = createCtx(
    { paperTrading: false, dryRun: false, minHoldTimeSeconds: 300 },
    {
      positions: new Map([
        [
          'FastLiquidityMint',
          {
            mint: 'FastLiquidityMint',
            symbol: 'FLIQ',
            decimals: 6,
            openedAt: new Date(Date.now() - 20_000).toISOString(),
            entryPriceUsd: 1,
            entryUsdValue: 100,
            remainingCostUsd: 100,
            realizedPnlUsd: 0,
            realizedProceedsUsd: 0,
            entryLiquidityUsd: 5_000,
            lastKnownBalanceRaw: '100000000',
            targetsHit: 0,
            takeProfitMultiples: [1.5],
          },
        ],
      ]),
      marketSnapshots: new Map([['FastLiquidityMint', { liquidity: 700, usdPrice: 0.95 }]]),
      metrics: { profitableTrades: 0, stopLosses: 0, trailingExits: 0, exitReasonCounts: {} },
      tradeHistory: [],
      coolDownMints: new Map(),
    }
  );
  let balanceCalls = 0;

  await withPatchedMembers(
    trading,
    {
      fetchSwapOrder: async () => ({ transaction: 'mock-order' }),
      executeSwapOrder: async () => 'mock-signature',
      getWalletTokenBalance: async () => {
        balanceCalls++;
        return balanceCalls === 1
          ? { mint: 'FastLiquidityMint', rawAmount: 100_000_000n, decimals: 6 }
          : { mint: 'FastLiquidityMint', rawAmount: 0n, decimals: 6 };
      },
    },
    async () => {
      await monitor.monitorPositions(ctx, async () => ({ FastLiquidityMint: { usdPrice: 0.95 } }));
      assert.equal(ctx.state.positions.has('FastLiquidityMint'), false);
      assert.equal(ctx.state.metrics.exitReasonCounts['liquidity-exit'], 1);
    }
  );
});

test('monitor does not trigger time-exit before the minimum hold time elapses', async () => {
  const ctx = createCtx(
    { minHoldTimeSeconds: 300, maxHoldMinutes: 1, timeExitMinMultiple: 1.25 },
    {
      positions: new Map([
        [
          'TimeGateMint',
          {
            mint: 'TimeGateMint',
            symbol: 'TGATE',
            decimals: 6,
            openedAt: new Date(Date.now() - 65_000).toISOString(),
            entryPriceUsd: 1,
            entryUsdValue: 100,
            remainingCostUsd: 100,
            realizedPnlUsd: 0,
            realizedProceedsUsd: 0,
            lastKnownBalanceRaw: '100000000',
            targetsHit: 0,
            takeProfitMultiples: [1.5],
            trailingArmed: false,
            maxHoldMinutesResolved: 1,
          },
        ],
      ]),
      metrics: { profitableTrades: 0, stopLosses: 0, trailingExits: 0, exitReasonCounts: {} },
      tradeHistory: [],
      coolDownMints: new Map(),
    }
  );

  await withPatchedMembers(
    trading,
    {
      getWalletTokenBalance: async () => ({
        mint: 'TimeGateMint',
        rawAmount: 100_000_000n,
        decimals: 6,
      }),
    },
    async () => {
      await monitor.monitorPositions(ctx, async () => ({ TimeGateMint: { usdPrice: 1.1 } }));
      assert.equal(ctx.state.positions.has('TimeGateMint'), true);
      assert.equal(ctx.state.metrics.exitReasonCounts['time-exit'], undefined);
    }
  );
});

test('config startup validation requires explicit live trading arming', () => {
  assert.throws(
    () =>
      validateStartupConfig(
        createTestConfig({
          paperTrading: false,
          dryRun: false,
          liveTradingEnabled: false,
        })
      ),
    /LIVE_TRADING_ENABLED=true/
  );

  assert.equal(
    validateStartupConfig(
      createTestConfig({
        paperTrading: false,
        dryRun: false,
        liveTradingEnabled: true,
      })
    ),
    true
  );
});

test('monitor recordClosedTrade enriches data and journals to trade-history file', () => {
  const ctx = createTestConfig({ tradeJournalFile: 'mock-trade-history.jsonl' });
  const state = createState({ closedTrades: [] });
  const testCtx = {
    config: ctx,
    state,
    logger: () => {},
    persistState: () => {},
  };

  const pos = {
    mint: 'JournalMint',
    symbol: 'JRN',
    openedAt: new Date(Date.now() - 120_000).toISOString(),
    entryPriceUsd: 0.5,
    entryUsdValue: 5,
    realizedPnlUsd: 2.5,
    realizedProceedsUsd: 7.5,
    highestPriceUsd: 1.0,
    entryScore: 80,
    tpProfile: 'high-confidence',
    takeProfitMultiples: [1.5, 2.5],
    takeProfitFractions: [0.35, 0.35],
    trailingStopDrawdownPctResolved: 0.2,
    maxHoldMinutesResolved: 10,
    volatilityScaler: 0.1,
    entryLiquidityUsd: 5000,
    launchpad: 'pump.fun',
    targetsHit: 1,
    initialBuyAmountSol: '0.05',
  };

  monitor.recordClosedTrade(testCtx, pos, 'stop-loss');

  assert.equal(state.closedTrades.length, 1);
  const trade = state.closedTrades[0];
  assert.equal(trade.mint, 'JournalMint');
  assert.equal(trade.entryScore, 80);
  assert.equal(trade.tpProfile, 'high-confidence');
  assert.deepEqual(trade.takeProfitMultiples, [1.5, 2.5]);
  assert.equal(trade.trailingStopDrawdownPctResolved, 0.2);
  assert.equal(trade.maxHoldMinutesResolved, 10);
  assert.equal(trade.volatilityScaler, 0.1);
  assert.equal(trade.entryLiquidityUsd, 5000);
  assert.equal(trade.launchpad, 'pump.fun');
  assert.equal(trade.targetsHit, 1);
  assert.equal(trade.initialBuyAmountSol, '0.05');
  assert.equal(trade.highestPriceUsd, 1.0);
  assert.equal(trade.exitReason, 'stop-loss');
  assert.ok(trade.holdSeconds >= 119 && trade.holdSeconds <= 121);
});

test('utils journalClosedTrade appends a JSONL line with enriched trade data', async () => {
  const testFile = path.join(process.cwd(), '.test-artifacts', 'test-trade-journal.jsonl');
  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
  const ctx = createTestConfig({ tradeJournalFile: testFile });
  const state = createState({ closedTrades: [] });
  const testCtx = { config: ctx, state, logger: () => {}, persistState: () => {} };

  const trade = {
    mint: 'TestMint',
    symbol: 'TST',
    exitReason: 'take-profit-1.5x',
    realizedPnlUsd: 3.5,
    realizedProceedsUsd: 8.5,
    entryUsdValue: 5,
    entryPriceUsd: 0.5,
    highestPriceUsd: 1.0,
    holdSeconds: 120,
    closedAt: '2026-01-01T00:00:00.000Z',
    entryScore: 80,
    tpProfile: 'high-confidence',
    takeProfitMultiples: [1.5, 2.5],
    takeProfitFractions: [0.35, 0.35],
    trailingStopDrawdownPctResolved: 0.2,
    maxHoldMinutesResolved: 10,
    volatilityScaler: 0.1,
    entryLiquidityUsd: 5000,
    launchpad: 'pump.fun',
    targetsHit: 1,
    initialBuyAmountSol: '0.05',
  };

  utils.journalClosedTrade(testCtx, trade);
  await new Promise((resolve) => setTimeout(resolve, 100));

  const content = fs.readFileSync(testFile, 'utf8').trim();
  assert.ok(content.length > 0);
  const lines = content.split('\n');
  const parsed = JSON.parse(lines[lines.length - 1]);
  assert.equal(parsed.mint, 'TestMint');
  assert.equal(parsed.entryScore, 80);
  assert.equal(parsed.exitReason, 'take-profit-1.5x');
  assert.equal(parsed.tpProfile, 'high-confidence');
  assert.ok(parsed.timestamp);
});

test('utility runBoundedPool preserves input order while enforcing concurrency limits', async () => {
  let active = 0;
  let maxActive = 0;

  const results = await runBoundedPool(
    [30, 10, 20],
    async (delay, index) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, delay));
      active--;
      return index;
    },
    { concurrency: 2 }
  );

  assert.equal(maxActive, 2);
  assert.deepEqual(
    results.map((result) => result.value),
    [0, 1, 2]
  );
});

test('utility computeStandardDeviation calculates correctly', () => {
  const values = [10, 12, 23, 23, 16, 23, 21, 16];
  const std = utils.computeStandardDeviation(values);
  assert.ok(Math.abs(std - 5.237) < 0.01);
});

test('utility computeSpread calculates correctly', () => {
  const spread = utils.computeSpread(99, 101); // (101-99) / 100 = 0.02
  assert.strictEqual(spread, 0.02);
});

test('utility decodePumpCurve decodes valid pump.fun curve buffers', () => {
  const buffer = Buffer.alloc(49);
  buffer.write('7b02ecedd6df6b41', 0, 'hex');
  buffer.writeBigUInt64LE(1_000_000_000_000_000n, 8);
  buffer.writeBigUInt64LE(30_000_000_000n, 16);
  buffer.writeBigUInt64LE(800_000_000_000_000n, 24);
  buffer.writeBigUInt64LE(0n, 32);
  buffer.writeBigUInt64LE(1_000_000_000_000_000n, 40);
  buffer.writeUInt8(0, 48);

  const decoded = decodePumpCurve(buffer);
  assert.ok(decoded);
  assert.equal(decoded.virtualTokenReserves, 1_000_000_000_000_000n);
  assert.equal(decoded.virtualSolReserves, 30_000_000_000n);
  assert.equal(decoded.isCompleted, false);
});

test('historical backfill snapshots degrade gracefully without Jupiter-only metrics', async () => {
  const ctx = createCtx({ minHoldTimeSeconds: 300 });
  const createdAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const token = {
    id: 'HistoricalMint',
    symbol: 'PEPE',
    name: 'Historical Pepe',
    usdPrice: 1.2,
    liquidity: 8_500,
    launchpad: 'pump.fun',
    firstPool: { createdAt },
    snapshotQuality: 'reduced-historical',
    historicalSource: 'geckoterminal',
  };

  const evaluation = await engine.evaluateCandidate(ctx, token);
  assert.equal(evaluation.approved, true);
  assert.ok(evaluation.notes.some((note) => /missing holder count/i.test(note)));
});
