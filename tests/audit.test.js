'use strict';
const { createTestConfig, createCtx, withMockedFetch } = require('./_test_helpers');
const assert = require('node:assert/strict');
const test = require('node:test');
const audit = require('../audit');
const { constants } = require('../config');
const { Response } = globalThis;

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
