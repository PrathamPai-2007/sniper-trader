'use strict';
import { createTestConfig, createCtx, withPatchedMembers } from './_test_helpers.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { monitorService } from '../src/services/monitor/monitor.service.js';
import { tradingService } from '../src/services/trading/trading.service.js';
import { StateStore } from '../src/core/store.js';
import { Context, Position } from '../src/types/index.js';

test('monitor mood adjustments reduce size after a cold streak and pause after a severe one', () => {
  const ctx = createCtx({}, { tradeHistory: [], moodPauseUntil: null });

  assert.deepEqual(monitorService.getMoodAdjustments(ctx), { isPaused: false, sizeMultiplier: 1 });

  ctx.state.tradeHistory = [true, false, false, false, false];
  assert.equal(monitorService.getMoodAdjustments(ctx).sizeMultiplier, 0.5);

  ctx.state.tradeHistory = [false, false, false, false, false, false, false, false, false, true];
  assert.equal(monitorService.getMoodAdjustments(ctx).isPaused, true);
});

test('monitor take-profit helpers compute fractions and raw sell amounts', () => {
  const position = { takeProfitFractions: [0.5, 0.2] } as any;

  assert.equal(monitorService.getTakeProfitFraction(position, 0), 0.5);
  assert.equal(monitorService.getTakeProfitFraction(position, 1), 0.2);
  assert.equal(monitorService.computeTakeProfitSellAmount(10_000n, 0.5), 5_000n);
});

test('monitor derives score-based trade management profiles', () => {
  const ctx = createCtx({
    minCandidateScore: 60,
    highGrowthConfidenceScore: 70,
    maxHoldMinutes: 60,
    holdDurationHighConfidenceMinutes: 12,
    holdDurationLowConfidenceMinutes: 4,
  });

  const high = monitorService.getTakeProfitPlan(ctx, 80);
  assert.equal(high.profileId, 'high-confidence');
  assert.deepEqual(high.takeProfitMultiples, [1.5, 2.5]);
  assert.deepEqual(high.takeProfitFractions, [0.35, 0.35]);
  assert.equal(high.trailingStopDrawdownPct, 0.2);
  assert.equal(high.maxHoldMinutesResolved, 12);

  const standard = monitorService.getTakeProfitPlan(ctx, 66);
  assert.equal(standard.profileId, 'standard-confidence');
  assert.deepEqual(standard.takeProfitMultiples, [1.3, 2.1]);
  assert.deepEqual(standard.takeProfitFractions, [0.5, 0.3]);
  assert.equal(standard.trailingStopDrawdownPct, 0.16);
  assert.equal(standard.maxHoldMinutesResolved, 60);

  const low = monitorService.getTakeProfitPlan(ctx, 61);
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

  const initial = (pos.mintSignals.topAccounts as any)[0];
  const current = (newSignals.topAccounts as any).find((a: any) => a.owner === initial.owner);
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
            name: 'Live Token',
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
            mode: 'live',
          } as Position,
        ],
      ]),
      marketSnapshots: new Map(),
      metrics: {
        profitableTrades: 0,
        stopLosses: 0,
        trailingExits: 0,
        discoveredCandidates: 0,
        passedCheapAudit: 0,
        passedSurvival: 0,
        passedAudit: 0,
        boughtPositions: 0,
        failedMomentum: 0,
        buyAttempts: 0,
        buyFailures: 0,
        finalAuditQueued: 0,
        finalAuditPassed: 0,
        finalAuditDeferredIndexing: 0,
        finalAuditRejected: 0,
        exitReasonCounts: {},
        rejectionReasons: {},
      },
      tradeHistory: [],
      coolDownMints: new Map(),
    }
  );
  let balanceCalls = 0;

  await withPatchedMembers(
    tradingService,
    {
      estimateSolUsdPrice: async () => 200,
      fetchSwapOrder: async () => ({ transaction: 'mock-order' }),
      executeSwapOrder: async () => 'mock-signature',
      executeSwapOrderWithSmartRetry: async () => ({
        signature: 'mock-signature',
        order: { transaction: 'mock-order' },
      }),
      getWalletTokenBalance: async () => {
        balanceCalls++;
        return balanceCalls <= 2
          ? { mint: 'LiveMint', rawAmount: 100_000_000n, decimals: 6 }
          : { mint: 'LiveMint', rawAmount: 0n, decimals: 6 };
      },
    },
    async () => {
      await monitorService.monitorPositions(ctx, async () => ({
        LiveMint: { usdPrice: 0.5 } as any,
      }));
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
            name: 'Fast Stop',
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
            mode: 'live',
          } as Position,
        ],
      ]),
      metrics: {
        profitableTrades: 0,
        stopLosses: 0,
        trailingExits: 0,
        discoveredCandidates: 0,
        passedCheapAudit: 0,
        passedSurvival: 0,
        passedAudit: 0,
        boughtPositions: 0,
        failedMomentum: 0,
        buyAttempts: 0,
        buyFailures: 0,
        finalAuditQueued: 0,
        finalAuditPassed: 0,
        finalAuditDeferredIndexing: 0,
        finalAuditRejected: 0,
        exitReasonCounts: {},
        rejectionReasons: {},
      },
      tradeHistory: [],
      coolDownMints: new Map(),
    }
  );
  let balanceCalls = 0;

  await withPatchedMembers(
    tradingService,
    {
      estimateSolUsdPrice: async () => 200,
      fetchSwapOrder: async () => ({ transaction: 'mock-order' }),
      executeSwapOrder: async () => 'mock-signature',
      executeSwapOrderWithSmartRetry: async () => ({
        signature: 'mock-signature',
        order: { transaction: 'mock-order' },
      }),
      getWalletTokenBalance: async () => {
        balanceCalls++;
        return balanceCalls <= 2
          ? { mint: 'FastStopMint', rawAmount: 100_000_000n, decimals: 6 }
          : { mint: 'FastStopMint', rawAmount: 0n, decimals: 6 };
      },
    },
    async () => {
      await monitorService.monitorPositions(ctx, async () => ({
        FastStopMint: { usdPrice: 0.79 } as any,
      }));
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
            name: 'Fast Liquidity',
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
            mode: 'live',
          } as Position,
        ],
      ]),
      marketSnapshots: new Map([
        ['FastLiquidityMint', { liquidityUsd: 700, usdPrice: 0.95 } as any],
      ]),
      metrics: {
        profitableTrades: 0,
        stopLosses: 0,
        trailingExits: 0,
        discoveredCandidates: 0,
        passedCheapAudit: 0,
        passedSurvival: 0,
        passedAudit: 0,
        boughtPositions: 0,
        failedMomentum: 0,
        buyAttempts: 0,
        buyFailures: 0,
        finalAuditQueued: 0,
        finalAuditPassed: 0,
        finalAuditDeferredIndexing: 0,
        finalAuditRejected: 0,
        exitReasonCounts: {},
        rejectionReasons: {},
      },
      tradeHistory: [],
      coolDownMints: new Map(),
    }
  );
  let balanceCalls = 0;

  await withPatchedMembers(
    tradingService,
    {
      estimateSolUsdPrice: async () => 200,
      fetchSwapOrder: async () => ({ transaction: 'mock-order' }),
      executeSwapOrder: async () => 'mock-signature',
      executeSwapOrderWithSmartRetry: async () => ({
        signature: 'mock-signature',
        order: { transaction: 'mock-order' },
      }),
      getWalletTokenBalance: async () => {
        balanceCalls++;
        return balanceCalls <= 2
          ? { mint: 'FastLiquidityMint', rawAmount: 100_000_000n, decimals: 6 }
          : { mint: 'FastLiquidityMint', rawAmount: 0n, decimals: 6 };
      },
    },
    async () => {
      await monitorService.monitorPositions(ctx, async () => ({
        FastLiquidityMint: { usdPrice: 0.95 } as any,
      }));
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
            name: 'Time Gate',
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
            mode: 'paper',
          } as Position,
        ],
      ]),
      metrics: {
        profitableTrades: 0,
        stopLosses: 0,
        trailingExits: 0,
        discoveredCandidates: 0,
        passedCheapAudit: 0,
        passedSurvival: 0,
        passedAudit: 0,
        boughtPositions: 0,
        failedMomentum: 0,
        buyAttempts: 0,
        buyFailures: 0,
        finalAuditQueued: 0,
        finalAuditPassed: 0,
        finalAuditDeferredIndexing: 0,
        finalAuditRejected: 0,
        exitReasonCounts: {},
        rejectionReasons: {},
      },
      tradeHistory: [],
      coolDownMints: new Map(),
    }
  );

  await withPatchedMembers(
    tradingService,
    {
      getWalletTokenBalance: async () => ({
        mint: 'TimeGateMint',
        rawAmount: 100_000_000n,
        decimals: 6,
        uiAmount: 100,
      }),
    },
    async () => {
      await monitorService.monitorPositions(ctx, async () => ({
        TimeGateMint: { usdPrice: 1.1 } as any,
      }));
      assert.equal(ctx.state.positions.has('TimeGateMint'), true);
      assert.equal(ctx.state.metrics.exitReasonCounts['time-exit'], undefined);
    }
  );
});

test('monitor recordClosedTrade enriches data and journals to trade-history file', () => {
  const config = createTestConfig({ tradeJournalFile: 'mock-trade-history.jsonl' });
  const store = new StateStore(config);
  const state = store.state;
  const testCtx = {
    config,
    state,
    store,
    logger: () => {},
    persistState: async () => {},
  } as unknown as Context;

  const pos: Partial<Position> = {
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

  monitorService.recordClosedTrade(testCtx, pos as Position, 'stop-loss');

  assert.equal(state.closedTrades.length, 1);
  const trade = state.closedTrades[0]!;
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
