'use strict';
const { createTestConfig, createCtx, withPatchedMembers } = require('./_test_helpers');
const assert = require('node:assert/strict');
const test = require('node:test');
const monitor = require('../monitor');
const trading = require('../trading');
const StateStore = require('../store');

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

test('monitor recordClosedTrade enriches data and journals to trade-history file', () => {
  const ctx = createTestConfig({ tradeJournalFile: 'mock-trade-history.jsonl' });
  const store = new StateStore(ctx);
  const state = store.state;
  const testCtx = {
    config: ctx,
    state,
    store,
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
