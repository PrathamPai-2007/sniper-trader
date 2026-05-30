'use strict';
import { createTestConfig, createCtx, withMockedFetch } from './_test_helpers.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as audit from '../src/services/audit/audit.service.js';
import { Context } from '../src/types/index.js';

// The original used constants.SOL_MINT. Let's see if we can find where SOL_MINT is.
// Actually, looking at the code, it probably means a generic mint.
const MOCK_MINT = 'So11111111111111111111111111111111111111112';

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
  } as any;
  const ctx = {
    config: createTestConfig({ mintSignalMaxAttempts: 2, mintSignalRetryDelayMs: 1 }),
    rpc: mockRpc,
    rpcs: [mockRpc],
    logger: () => {},
  } as unknown as Context;

  await assert.rejects(() => audit.getMintSignals(ctx, MOCK_MINT), /RPC Indexing Lag/);
  assert.equal(accountInfoCalls, 2);
});

test('audit mint signals fail closed when parsed mint info is missing', async () => {
  const mockRpc = {
    getAccountInfo: () => ({
      send: async () => ({ value: { data: { parsed: { type: 'mint' } } } }),
    }),
    getTokenLargestAccounts: () => ({
      send: async () => ({ value: [{ address: MOCK_MINT, amount: '1' }] }),
    }),
  } as any;
  const ctx = {
    config: createTestConfig({ mintSignalRetryDelayMs: 1 }),
    rpc: mockRpc,
    rpcs: [mockRpc],
    logger: () => {},
  } as unknown as Context;

  await assert.rejects(() => audit.getMintSignals(ctx, MOCK_MINT), /parsed mint info missing/);
});

test('audit batch mint signals fetches metadata and owners correctly', async () => {
  const MOCK_MINT_1 = 'Mint111111111111111111111111111111111111111';
  const MOCK_MINT_2 = 'Mint222222222222222222222222222222222222222';

  const mockRpc = {
    getMultipleAccounts: (addresses: string[]) => ({
      send: async () => {
        // Handle mint metadata and owner lookups
        const value = addresses.map((addr: string) => {
          const addrStr = String(addr);
          if (addrStr === MOCK_MINT_1 || addrStr === MOCK_MINT_2) {
            return {
              data: {
                parsed: {
                  type: 'mint',
                  info: {
                    decimals: 6,
                    supply: '1000000',
                    mintAuthority: null,
                    freezeAuthority: null,
                  },
                },
              },
            };
          }
          // Default to token account for holders
          return {
            data: {
              parsed: {
                info: { owner: 'Owner' + addrStr },
              },
            },
          };
        });
        return { value };
      },
    }),
    getTokenLargestAccounts: () => ({
      send: async () => ({
        value: [{ address: '5U3D1bg3jFL2n3zPXSkwQnQKvU4uEPrKzJ6aXvQf6tTq', amount: '100' }],
      }),
    }),
  } as any;

  const ctx = {
    config: createTestConfig({ mintSignalRetryDelayMs: 1 }),
    rpc: mockRpc,
    rpcs: [mockRpc],
    logger: () => {},
  } as unknown as Context;

  const results = await audit.batchGetMintSignals(ctx, [MOCK_MINT_1, MOCK_MINT_2]);
  assert.equal(results.size, 2);
  assert.ok(results.has(MOCK_MINT_1));
  assert.ok(results.has(MOCK_MINT_2));
  assert.equal(
    results.get(MOCK_MINT_1)?.topAccounts[0]?.owner,
    'Owner5U3D1bg3jFL2n3zPXSkwQnQKvU4uEPrKzJ6aXvQf6tTq'
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
