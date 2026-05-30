'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateDrawdown,
  canBuy,
  getAdjustedBuySize,
} from '../src/services/trading/portfolio.service.js';
import { createCtx } from './_test_helpers.js';

test('portfolio calculateDrawdown computes session drawdown', () => {
  // Scenario 1: No drawdown
  const ctx1 = createCtx({ paperTrading: true, maxDailyDrawdownPct: 0.15 });
  ctx1.state.paperSolBalanceLamports = '100000000'; // 0.1 SOL
  ctx1.state.peakSessionSolBalanceLamports = '100000000'; // 0.1 SOL
  const res1 = calculateDrawdown(ctx1);
  assert.equal(res1.drawdownPct, 0);
  assert.equal(res1.isCritical, false);

  // Scenario 2: Drawdown exceeds threshold (e.g. drop from 1 SOL to 0.8 SOL is 20% drawdown)
  const ctx2 = createCtx({ paperTrading: true, maxDailyDrawdownPct: 0.15 });
  ctx2.state.paperSolBalanceLamports = '800000000'; // 0.8 SOL
  ctx2.state.peakSessionSolBalanceLamports = '1000000000'; // 1.0 SOL
  const res2 = calculateDrawdown(ctx2);
  assert.ok(Math.abs(res2.drawdownPct - 0.2) < 0.001);
  assert.equal(res2.isCritical, true);

  // Scenario 3: peakSol <= 0
  const ctx3 = createCtx({ paperTrading: true });
  ctx3.state.peakSessionSolBalanceLamports = '0';
  const res3 = calculateDrawdown(ctx3);
  assert.equal(res3.drawdownPct, 0);
});

test('portfolio canBuy validates drawdown and sector concentration', () => {
  const ctx = createCtx({
    paperTrading: true,
    maxDailyDrawdownPct: 0.15,
    maxPositionsPerLaunchpad: 2,
  });

  // Approved
  ctx.state.paperSolBalanceLamports = '1000000000';
  ctx.state.peakSessionSolBalanceLamports = '1000000000';
  const approvedRes = canBuy(ctx, { id: 'MintA', launchpad: 'pump.fun' } as any);
  assert.equal(approvedRes.approved, true);

  // Rejected by drawdown
  ctx.state.paperSolBalanceLamports = '800000000'; // 20% drawdown
  const drawRes = canBuy(ctx, { id: 'MintA', launchpad: 'pump.fun' } as any);
  assert.equal(drawRes.approved, false);
  assert.match(drawRes.reason!, /Critical drawdown/);

  // Rejected by sector concentration
  ctx.state.paperSolBalanceLamports = '1000000000'; // reset drawdown
  ctx.state.positions.set('MintB', { mint: 'MintB', launchpad: 'pump.fun' } as any);
  ctx.state.positions.set('MintC', { mint: 'MintC', launchpad: 'pump.fun' } as any);

  const concRes = canBuy(ctx, { id: 'MintA', launchpad: 'pump.fun' } as any);
  assert.equal(concRes.approved, false);
  assert.match(concRes.reason!, /Max concurrent positions for pump.fun reached/);
});

test('portfolio getAdjustedBuySize scales buy size on loss streak', () => {
  const ctx = createCtx({ dynamicSizingEnabled: true });
  const baseSize = 100_000_000n;

  // No loss streak (no closed trades)
  const size1 = getAdjustedBuySize(ctx, baseSize);
  assert.equal(size1, baseSize);

  // Dynamic sizing disabled
  const ctxDisabled = createCtx({ dynamicSizingEnabled: false });
  ctxDisabled.state.closedTrades = [
    { realizedPnlUsd: -10 },
    { realizedPnlUsd: -5 },
    { realizedPnlUsd: -2 },
  ] as any[];
  const size2 = getAdjustedBuySize(ctxDisabled, baseSize);
  assert.equal(size2, baseSize);

  // 3 consecutive losses with dynamic sizing enabled
  ctx.state.closedTrades = [
    { realizedPnlUsd: -10 },
    { realizedPnlUsd: -5 },
    { realizedPnlUsd: -2 },
  ] as any[];
  const size3 = getAdjustedBuySize(ctx, baseSize);
  assert.equal(size3, baseSize / 2n);
});
