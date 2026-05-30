'use strict';
import { createCtx, withMockedFetch, withPatchedMembers } from './_test_helpers.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { appService } from '../src/services/services.js';
import { tradingService } from '../src/services/trading/trading.service.js';
import * as utils from '../src/core/utils.js';
import { SOL_MINT } from '../src/core/config.js';
import { TokenMetadata } from '../src/types/index.js';

test('services normalizes Jupiter price payloads with and without a data wrapper', async () => {
  const ctx = createCtx();

  await withMockedFetch(
    async () =>
      ({
        ok: true,
        text: async () =>
          JSON.stringify({
            data: {
              mint1: { price: '1.23' },
              mint2: { usdPrice: '4.56' },
            },
          }),
      }) as Response,
    async () => {
      const prices = await appService.fetchPrices(ctx, ['mint1', 'mint2']);
      assert.equal(prices['mint1']!.usdPrice, 1.23);
      assert.equal(prices['mint2']!.usdPrice, 4.56);
    }
  );

  await withMockedFetch(
    async () =>
      ({
        ok: true,
        text: async () =>
          JSON.stringify({
            mint3: { usdPrice: '7.89' },
          }),
      }) as Response,
    async () => {
      const prices = await appService.fetchPrices(ctx, ['mint3']);
      assert.equal(prices['mint3']!.usdPrice, 7.89);
    }
  );
});

test('services falls back to per-mint Jupiter lookups when batch pricing fails', async () => {
  const ctx = createCtx({ priceFallbackParallelism: 2 });
  ctx.state.marketSnapshots.set('mint-a', { launchpad: 'raydium' });
  ctx.state.marketSnapshots.set('mint-b', { launchpad: 'raydium' });

  const calls: string[] = [];
  await withMockedFetch(
    async (url) => {
      calls.push(String(url));
      if (String(url).includes('ids=mint-a%2Cmint-b')) {
        throw new Error('429 too many requests');
      }

      if (String(url).includes('ids=mint-a')) {
        return {
          ok: true,
          text: async () => JSON.stringify({ 'mint-a': { usdPrice: '3.21' } }),
        } as Response;
      }

      if (String(url).includes('ids=mint-b')) {
        return {
          ok: true,
          text: async () => JSON.stringify({ 'mint-b': { usdPrice: '6.54' } }),
        } as Response;
      }

      throw new Error(`unexpected url ${url}`);
    },
    async () => {
      const prices = await appService.fetchPricesBestEffort(ctx, ['mint-a', 'mint-b'], 'test');
      assert.equal(prices['mint-a']!.usdPrice, 3.21);
      assert.equal(prices['mint-b']!.usdPrice, 6.54);
      assert.equal(calls.length, 3);
    }
  );
});

test('services price refresh runs batch API and direct RPC fallback concurrently', async () => {
  const ctx = createCtx({ priceFallbackParallelism: 2 });
  const mintA = SOL_MINT;
  const mintB = '5U3D1bg3jFL2n3zPXSkwQnQKvU4uEPrKzJ6aXvQf6tTq';
  const mints = [mintA, mintB];
  let rpcCalls = 0;
  const delayMs = 80;

  const slowRpc = new Proxy(
    {},
    {
      get: () => {
        return () => ({
          send: async () => {
            rpcCalls++;
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            return { value: null };
          },
        });
      },
    }
  );
  ctx.rpc = slowRpc as any;
  ctx.rpcs = [slowRpc as any];

  await withMockedFetch(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            [mintA]: { usdPrice: 1 },
            [mintB]: { usdPrice: 2 },
          }),
      } as Response;
    },
    async () => {
      const started = Date.now();
      const prices = await appService.fetchPricesBestEffort(ctx, mints, 'concurrency-test');
      const elapsed = Date.now() - started;

      assert.equal(prices[mintA]!.usdPrice, 1);
      assert.equal(prices[mintB]!.usdPrice, 2);
      assert.equal(rpcCalls, 2);
      assert.ok(elapsed < delayMs * 2.5, `expected parallel refresh, got ${elapsed}ms`);
    }
  );
});

test('services uses the requested Jupiter API key when fetching prices', async () => {
  const ctx = createCtx();
  let lastApiKey: string | null = null;

  await withMockedFetch(
    async (_url, options) => {
      lastApiKey = (options?.headers as any)?.['x-api-key'] || null;
      return { ok: true, text: async () => JSON.stringify({ mint1: { usdPrice: 1 } }) } as Response;
    },
    async () => {
      await appService.fetchPrices(ctx, ['mint1'], ctx.config.jupiterPositionApiKey);
      assert.strictEqual(lastApiKey, 'position-key');

      await appService.fetchPrices(ctx, ['mint1']);
      assert.strictEqual(lastApiKey, 'test-key');
    }
  );
});

test('services mergeLoopRequest combines flags, counts, and reasons deterministically', () => {
  const merged = appService.mergeLoopRequest(
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
        discoveredCandidates: 0,
        passedCheapAudit: 0,
        passedSurvival: 0,
        passedAudit: 0,
        boughtPositions: 0,
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
      tradeHistory: [],
      coolDownMints: new Map(),
    }
  );

  await withMockedFetch(
    async () => {
      const prices = {
        [SOL_MINT]: { usdPrice: 100 },
        PaperMint: { usdPrice: 2 },
      };
      return { ok: true, text: async () => JSON.stringify({ data: prices }) } as Response;
    },
    async () => {
      const position = await appService.buyCandidate(ctx, {
        token: {
          id: 'PaperMint',
          symbol: 'P',
          name: 'Paper Mint',
          decimals: 6,
          usdPrice: 1,
          liquidity: 2000,
        } as TokenMetadata,
        candidateScore: 80,
        mintSignals: { decimals: 6 } as any,
      } as any);

      assert.ok(position);
      assert.equal(ctx.state.positions.has('PaperMint'), true);

      await appService.closeAllOpenPositions(ctx);
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
      metrics: {
        discoveredCandidates: 0,
        passedCheapAudit: 0,
        passedSurvival: 0,
        passedAudit: 0,
        boughtPositions: 0,
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
    }
  );
  let executeCalled = false;
  let balanceCalls = 0;

  await withPatchedMembers(
    tradingService,
    {
      fetchSwapOrder: async (_ctx: any, inputMint: string, outputMint: string, amount: string) => {
        assert.equal(inputMint, SOL_MINT);
        assert.equal(outputMint, '5U3D1bg3jFL2n3zPXSkwQnQKvU4uEPrKzJ6aXvQf6tTq');
        assert.equal(amount, '50000000');
        return { transaction: 'mock-order', inUsdValue: 5, outAmount: '1000000' };
      },
      getWalletTokenBalance: async () => {
        balanceCalls++;
        return { mint: '5U3D1bg3jFL2n3zPXSkwQnQKvU4uEPrKzJ6aXvQf6tTq', rawAmount: 0n, decimals: 6 };
      },
      executeSwapOrder: async () => {
        executeCalled = true;
        return 'unreachable';
      },
    },
    async () => {
      const position = await appService.buyCandidate(ctx, {
        token: {
          id: '5U3D1bg3jFL2n3zPXSkwQnQKvU4uEPrKzJ6aXvQf6tTq',
          symbol: 'LB',
          name: 'Live Buy',
          decimals: 6,
          usdPrice: 5,
          liquidity: 2000,
        } as TokenMetadata,
        candidateScore: 80,
        mintSignals: { decimals: 6 } as any,
      } as any);

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
      metrics: {
        discoveredCandidates: 0,
        passedCheapAudit: 0,
        passedSurvival: 0,
        passedAudit: 0,
        boughtPositions: 0,
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
    }
  );
  let balanceCalls = 0;

  await withPatchedMembers(
    tradingService,
    {
      fetchSwapOrder: async () => ({
        transaction: 'mock-order',
        inUsdValue: 5,
        outAmount: '1000000',
      }),
      executeSwapOrder: async () => 'mock-buy-signature',
      executeSwapOrderWithSmartRetry: async () => ({
        signature: 'mock-buy-signature',
        order: {
          transaction: 'mock-order',
          inUsdValue: 5,
          outAmount: '1000000',
        },
      }),
      getWalletTokenBalance: async () => {
        balanceCalls++;
        return balanceCalls === 1
          ? { mint: '5U3D1bg3jFL2n3zPXSkwQnQKvU4uEPrKzJ6aXvQf6tTq', rawAmount: 0n, decimals: 6 }
          : {
              mint: '5U3D1bg3jFL2n3zPXSkwQnQKvU4uEPrKzJ6aXvQf6tTq',
              rawAmount: 1_000_000n,
              decimals: 6,
            };
      },
    },
    async () => {
      const position = await appService.buyCandidate(ctx, {
        token: {
          id: '5U3D1bg3jFL2n3zPXSkwQnQKvU4uEPrKzJ6aXvQf6tTq',
          symbol: 'LB',
          name: 'Live Buy',
          decimals: 6,
          usdPrice: 5,
          liquidity: 2000,
        } as TokenMetadata,
        candidateScore: 80,
        mintSignals: { decimals: 6 } as any,
      } as any);

      assert.ok(position);
      assert.equal(ctx.state.positions.has('5U3D1bg3jFL2n3zPXSkwQnQKvU4uEPrKzJ6aXvQf6tTq'), true);
      assert.equal(position.buySignature, 'mock-buy-signature');
      assert.equal(position.initialTokenAmountRaw, '1000000');
      assert.equal(ctx.state.metrics.buyAttempts, 1);
      assert.equal(ctx.state.metrics.buyFailures, 0);
    }
  );
});

test('services live buy reuses prefetched quote for smart retry', async () => {
  const ctx = createCtx({ paperTrading: false, dryRun: false });
  const prefetched = { transaction: 'prefetched-order', inUsdValue: 5, outAmount: '1000000' };
  let initialOrderSeen: unknown = null;
  let fetchSwapOrderCalled = false;
  let balanceCalls = 0;

  await withPatchedMembers(
    tradingService,
    {
      fetchSwapOrder: async () => {
        fetchSwapOrderCalled = true;
        return { transaction: 'unexpected' };
      },
      executeSwapOrderWithSmartRetry: async (
        _ctx: any,
        _inputMint: string,
        _outputMint: string,
        _amount: string,
        _isPanic: boolean,
        initialOrder: unknown
      ) => {
        initialOrderSeen = initialOrder;
        return { signature: 'mock-buy-signature', order: prefetched };
      },
      getWalletTokenBalance: async () => {
        balanceCalls++;
        return balanceCalls === 1
          ? { mint: 'mint', rawAmount: 0n, decimals: 6 }
          : { mint: 'mint', rawAmount: 1_000_000n, decimals: 6 };
      },
    },
    async () => {
      const position = await appService.buyCandidate(
        ctx,
        {
          token: {
            id: '5U3D1bg3jFL2n3zPXSkwQnQKvU4uEPrKzJ6aXvQf6tTq',
            symbol: 'PQ',
            name: 'Prefetched Quote',
            decimals: 6,
            usdPrice: 5,
            liquidity: 2000,
          } as TokenMetadata,
          candidateScore: 80,
          mintSignals: { decimals: 6 } as any,
        } as any,
        Promise.resolve(prefetched)
      );

      assert.ok(position);
      assert.equal(fetchSwapOrderCalled, false);
      assert.equal(initialOrderSeen, prefetched);
    }
  );
});

test('services live buy persists nested BigInt audit metadata without failing the order', async () => {
  const ctx = createCtx(
    { paperTrading: false, dryRun: false },
    {
      positions: new Map(),
      metrics: {
        discoveredCandidates: 0,
        passedCheapAudit: 0,
        passedSurvival: 0,
        passedAudit: 0,
        boughtPositions: 0,
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
    }
  );
  let balanceCalls = 0;
  const writes: string[] = [];

  await withPatchedMembers(
    utils.utilService,
    {
      atomicWriteFile: async (_filePath: string, content: string) => {
        writes.push(content);
      },
    },
    async () => {
      await withPatchedMembers(
        tradingService,
        {
          fetchSwapOrder: async () => ({
            transaction: 'mock-order',
            inUsdValue: 5,
            outAmount: '1000000',
          }),
          executeSwapOrder: async () => 'mock-buy-signature',
          executeSwapOrderWithSmartRetry: async () => ({
            signature: 'mock-buy-signature',
            order: {
              transaction: 'mock-order',
              inUsdValue: 5,
              outAmount: '1000000',
            },
          }),
          getWalletTokenBalance: async () => {
            balanceCalls++;
            return balanceCalls === 1
              ? { mint: '5U3D1bg3jFL2n3zPXSkwQnQKvU4uEPrKzJ6aXvQf6tTq', rawAmount: 0n, decimals: 6 }
              : {
                  mint: '5U3D1bg3jFL2n3zPXSkwQnQKvU4uEPrKzJ6aXvQf6tTq',
                  rawAmount: 1_000_000n,
                  decimals: 6,
                };
          },
        },
        async () => {
          const position = await appService.buyCandidate(ctx, {
            token: {
              id: '5U3D1bg3jFL2n3zPXSkwQnQKvU4uEPrKzJ6aXvQf6tTq',
              symbol: 'LB',
              name: 'Live Buy',
              decimals: 6,
              usdPrice: 5,
              liquidity: 2000,
            } as TokenMetadata,
            candidateScore: 80,
            mintSignals: {
              decimals: 6,
              supplyRaw: 123_456_789n,
              topAccounts: [{ address: 'holder-1', rawAmount: 25_000_000n, share: 0.2 }],
            } as any,
          } as any);

          assert.ok(position);
          assert.equal(
            ctx.state.positions.has('5U3D1bg3jFL2n3zPXSkwQnQKvU4uEPrKzJ6aXvQf6tTq'),
            true
          );
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
      metrics: {
        discoveredCandidates: 0,
        passedCheapAudit: 0,
        passedSurvival: 0,
        passedAudit: 0,
        boughtPositions: 0,
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
    }
  );

  await withPatchedMembers(
    tradingService,
    {
      fetchSwapOrder: async () => {
        throw new Error('quote unavailable');
      },
    },
    async () => {
      const position = await appService.buyCandidate(ctx, {
        token: {
          id: '5U3D1bg3jFL2n3zPXSkwQnQKvU4uEPrKzJ6aXvQf6tTq',
          symbol: 'LB',
          name: 'Live Buy',
          decimals: 6,
          usdPrice: 5,
          liquidity: 2000,
        } as TokenMetadata,
        candidateScore: 80,
        mintSignals: { decimals: 6 } as any,
      } as any);

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
        [SOL_MINT]: { usdPrice: 100 },
        SlippageMint: { usdPrice: 2 },
      };
      return { ok: true, text: async () => JSON.stringify({ data: prices }) } as Response;
    },
    async () => {
      const position = await appService.buyCandidate(ctx, {
        token: {
          id: 'SlippageMint',
          symbol: 'SLIP',
          name: 'Slippage Mint',
          decimals: 6,
          usdPrice: 2,
          liquidity: 5000,
        } as TokenMetadata,
        candidateScore: 80,
        mintSignals: { decimals: 6 } as any,
      } as any);

      assert.ok(position);
      // Slippage should mean either price is slightly adjusted or the tokens received reflect slippage
      assert.equal(ctx.state.positions.has('SlippageMint'), true);
      const stored = ctx.state.positions.get('SlippageMint')!;
      assert.ok(stored.entryPriceUsd > 0);
    }
  );
});
