'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getWalletAddress,
  getWalletTokenBalance,
  fetchDynamicPriorityFee,
  estimateSolUsdPrice,
  estimateSolUsdValue,
  executeSwapOrderWithSmartRetry,
} from '../src/services/trading/trading.service.js';
import { createCtx, withPatchedMembers, withMockedFetch } from './_test_helpers.js';
import { SOL_MINT } from '../src/core/config.js';

test('trading getWalletAddress returns wallet address and throws when missing', async () => {
  const ctx = createCtx();
  const address = await getWalletAddress(ctx);
  assert.equal(address, '5U3D1bg3jFL2n3zPXSkwQnQKvU4uEPrKzJ6aXvQf6tTq');

  const invalidCtx = { wallet: null } as any;
  await assert.rejects(() => getWalletAddress(invalidCtx), /Wallet address is unavailable/);
});

test('trading getWalletTokenBalance returns balance under paper and RPC modes', async () => {
  // Paper trading mode
  const ctxPaper = createCtx({ paperTrading: true });
  const mockMint = '5U3D1bg3jFL2n3zPXSkwQnQKvU4uEPrKzJ6aXvQf6tTq';
  ctxPaper.state.positions.set(mockMint, {
    mint: mockMint,
    symbol: 'MT1',
    name: 'Token 1',
    decimals: 6,
    initialTokenAmountRaw: '2000000',
  } as any);

  const paperBal = await getWalletTokenBalance(ctxPaper, mockMint);
  assert.equal(paperBal.rawAmount, 2000000n);
  assert.equal(paperBal.uiAmount, 2.0);

  // Live RPC mode
  const ctxLive = createCtx({ paperTrading: false });
  ctxLive.rpc = {
    getTokenAccountsByOwner: () => ({
      send: async () => ({
        value: [
          {
            account: {
              data: {
                parsed: {
                  info: {
                    tokenAmount: {
                      amount: '3500000',
                      decimals: 6,
                    },
                  },
                },
              },
            },
          },
        ],
      }),
    }),
  } as any;
  ctxLive.rpcs = [ctxLive.rpc];

  const liveBal = await getWalletTokenBalance(ctxLive, mockMint);
  assert.equal(liveBal.rawAmount, 3500000n);
  assert.equal(liveBal.uiAmount, 3.5);
});

test('trading fetchDynamicPriorityFee computes base, panic, and GMI volatility fees', async () => {
  const ctx = createCtx({
    priorityFeeBaseMicroLamports: 1000,
    priorityFeeMaxMicroLamports: 50000,
    priorityFeePercentile: 75,
    priorityFeeAccountLocal: true,
  });

  const mockMint = '5U3D1bg3jFL2n3zPXSkwQnQKvU4uEPrKzJ6aXvQf6tTq';

  // Mock getRecentPrioritizationFees
  ctx.rpc = {
    getRecentPrioritizationFees: () => ({
      send: async () => [
        { prioritizationFee: 500 },
        { prioritizationFee: 1500 },
        { prioritizationFee: 2500 },
        { prioritizationFee: 3500 },
      ],
    }),
  } as any;
  ctx.rpcs = [ctx.rpc];

  // Base fee selection (75th percentile is 2500)
  const baseFee = await fetchDynamicPriorityFee(ctx, [mockMint]);
  assert.equal(baseFee, 2500);

  // Panic mode
  ctx.config.priorityFeePanicMultiplier = 2.0;
  const panicFee = await fetchDynamicPriorityFee(ctx, [mockMint], true);
  assert.equal(panicFee, 5000);

  // GMI high volatility adjustment
  ctx.calculateGMI = () => 0.9;
  const volFee = await fetchDynamicPriorityFee(ctx, [mockMint]);
  // 2500 * 1.5 = 3750
  assert.equal(volFee, 3750);
});

test('trading estimateSolUsdPrice estimates price and value correctly', async () => {
  const ctx = createCtx();

  // Test override check
  (ctx as any).getSolUsdPrice = async () => 145.5;
  const priceOverridden = await estimateSolUsdPrice(ctx);
  assert.equal(priceOverridden, 145.5);

  // Test HTTP fetch and cache path
  const ctxHttp = createCtx();
  await withMockedFetch(
    async () =>
      new Response(
        JSON.stringify({
          data: {
            [SOL_MINT]: { usdPrice: 150.25 },
          },
        }),
        { status: 200 }
      ),
    async () => {
      const price = await estimateSolUsdPrice(ctxHttp);
      assert.equal(price, 150.25);

      const val = await estimateSolUsdValue(ctxHttp, 1_000_000_000n); // 1 SOL
      assert.ok(Math.abs(val - 150.25) < 0.001);
    }
  );
});

test('trading executeSwapOrderWithSmartRetry retry loop handles slippage correctly', async () => {
  const ctx = createCtx({
    maxAutoSlippageRetry: 2,
    autoSlippageIncrementBps: 100,
    slippageBps: 500,
  });
  const mockMint = '5U3D1bg3jFL2n3zPXSkwQnQKvU4uEPrKzJ6aXvQf6tTq';

  // Import tradingService
  const { tradingService } = await import('../src/services/trading/trading.service.js');

  let orderCount = 0;
  let execCount = 0;

  await withPatchedMembers(
    tradingService,
    {
      fetchSwapOrder: async (
        _ctx: any,
        _inMint: string,
        _outMint: string,
        _amount: any,
        _panic: boolean,
        slippage: number
      ) => {
        orderCount++;
        // Verify slippage gets incremented on retry
        if (orderCount === 1) assert.equal(slippage, 500);
        if (orderCount === 2) assert.equal(slippage, 600);
        return { transaction: 'mock-tx', lastValidBlockHeight: 12345 } as any;
      },
      executeSwapOrder: async () => {
        execCount++;
        if (execCount === 1) {
          throw new Error('Simulation failed: SlippageExceeded');
        }
        return 'success-signature';
      },
    },
    async () => {
      const res = await executeSwapOrderWithSmartRetry(ctx, SOL_MINT, mockMint, 100000n);
      assert.equal(res.signature, 'success-signature');
      assert.equal(orderCount, 2);
      assert.equal(execCount, 2);
    }
  );
});
