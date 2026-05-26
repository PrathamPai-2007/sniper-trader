'use strict';
const { createCtx, withMockedFetch, withPatchedMembers } = require('./_test_helpers');
const assert = require('node:assert/strict');
const test = require('node:test');
const services = require('../services');
const trading = require('../trading');
const utils = require('../utils');
const { constants } = require('../config');

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

// --- NEW TEST CASES ---

test('services buyCandidate handles simulated slippage in paper trading', async () => {
  const initialSol = 1_000_000_000n;
  const ctx = createCtx(
    { paperTrading: true, slippageBps: 1000 }, // 10% slippage
    {
      paperSolBalanceLamports: initialSol.toString(),
      positions: new Map(),
    }
  );

  await withMockedFetch(
    async () => {
      const prices = {
        [constants.SOL_MINT]: { usdPrice: 100 },
        SlippageMint: { usdPrice: 2 },
      };
      return { ok: true, text: async () => JSON.stringify({ data: prices }) };
    },
    async () => {
      const position = await services.buyCandidate(ctx, {
        token: {
          id: 'SlippageMint',
          symbol: 'SLIP',
          name: 'Slippage Mint',
          decimals: 6,
          usdPrice: 2,
          liquidity: 5000,
        },
        candidateScore: 80,
        mintSignals: { decimals: 6 },
      });

      assert.ok(position);
      // Slippage should mean either price is slightly adjusted or the tokens received reflect slippage
      assert.equal(ctx.state.positions.has('SlippageMint'), true);
      const stored = ctx.state.positions.get('SlippageMint');
      assert.ok(stored.entryPriceUsd > 0);
    }
  );
});
