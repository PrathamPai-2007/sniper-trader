'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import {
  decodePrivateKeyBytes,
  VelociBuyBot,
  _setTestConfig,
  _setTestState,
  _setTestCtx,
  getCtx,
} from '../src/index.js';
import { createTestConfig } from './_test_helpers.js';
import { StateStore } from '../src/core/store.js';

test('index decodePrivateKeyBytes decodes various formats and throws on invalid inputs', () => {
  const keyBytes = Uint8Array.from(Array.from({ length: 64 }, (_, index) => index));

  // Base58 format
  const b58Key = bs58.encode(keyBytes);
  const decodedB58 = decodePrivateKeyBytes(b58Key);
  assert.deepEqual(decodedB58, keyBytes);

  // JSON Array format
  const jsonKey = JSON.stringify([...keyBytes]);
  const decodedJson = decodePrivateKeyBytes(jsonKey);
  assert.deepEqual(decodedJson, keyBytes);

  // Malformed JSON Array
  assert.throws(
    () => decodePrivateKeyBytes('[1, 2, unclosed'),
    /Failed to parse private key as JSON array/
  );

  assert.throws(() => decodePrivateKeyBytes('[1, 2, 3, 4]'), /64-byte Solana keypair, got 4/);
  assert.throws(() => decodePrivateKeyBytes('[1, -1, 256]'), /array of byte values from 0 to 255/);
  assert.throws(
    () => decodePrivateKeyBytes('5U3D1bg3jFL2n3zPXSkwQnQKvU4uEPrKzJ6aXvQf6tTq'),
    /64-byte Solana keypair/
  );

  // Missing or empty key
  assert.throws(() => decodePrivateKeyBytes(''), /PRIVATE_KEY or PRIVATE_KEY_PATH is required/);
});

test('index VelociBuyBot constructor initializes properly and validates input', () => {
  const config = createTestConfig({
    rpcUrls: ['http://localhost:8899'],
    wsRpcUrls: ['ws://localhost:8900'],
  });
  const walletSigner = { address: '5U3D1bg3jFL2n3zPXSkwQnQKvU4uEPrKzJ6aXvQf6tTq' } as any;
  const store = new StateStore(config);

  const bot = new VelociBuyBot(config, walletSigner, store);
  assert.equal(bot.rpcs.length, 1);
  assert.equal(bot.rpcSubscriptionPool.length, 1);

  // Missing rpcUrls
  assert.throws(
    () => new VelociBuyBot(createTestConfig({ rpcUrls: [] }), walletSigner, store),
    /No RPC URLs provided/
  );
  // Missing wsRpcUrls
  assert.throws(
    () =>
      new VelociBuyBot(
        createTestConfig({ rpcUrls: ['http://mock'], wsRpcUrls: [] }),
        walletSigner,
        store
      ),
    /No WebSocket RPC URLs provided/
  );
});

test('index VelociBuyBot adjusts backpressure and effective parallelism correctly', () => {
  const config = createTestConfig({
    rpcUrls: ['http://localhost:8899'],
    wsRpcUrls: ['ws://localhost:8900'],
    errorRateWindow: 5,
    backpressureErrorRateThreshold: 0.4,
    parallelismMinFactor: 0.5,
  });
  const walletSigner = { address: '5U3D1bg3jFL2n3zPXSkwQnQKvU4uEPrKzJ6aXvQf6tTq' } as any;
  const store = new StateStore(config);
  const bot = new VelociBuyBot(config, walletSigner, store);

  // Initial stats
  assert.equal(bot.getEffectiveParallelism(10), 10);

  // Record error events
  bot.recordScanBackpressureEvent(true);
  bot.recordScanBackpressureEvent(true);
  bot.recordScanBackpressureEvent(false); // 2/3 errors = 66% error rate

  // Error rate (66%) is above threshold (40%) => scales by factor 0.5
  assert.equal(bot.getEffectiveParallelism(10), 5);

  // Record success events to recover
  bot.recordScanBackpressureEvent(false);
  bot.recordScanBackpressureEvent(false);
  bot.recordScanBackpressureEvent(false); // 2/5 errors = 40% error rate (below threshold)

  // Recovery should scale back to base
  assert.equal(bot.getEffectiveParallelism(10), 10);
});

test('index VelociBuyBot context logger intercepts and formats logs correctly', () => {
  const config = createTestConfig({
    rpcUrls: ['http://localhost:8899'],
    wsRpcUrls: ['ws://localhost:8900'],
    paperTrading: true,
  });
  const walletSigner = { address: '5U3D1bg3jFL2n3zPXSkwQnQKvU4uEPrKzJ6aXvQf6tTq' } as any;
  const store = new StateStore(config);
  store.state.paperSolBalanceLamports = '1500000000'; // 1.5 SOL
  const bot = new VelociBuyBot(config, walletSigner, store);

  const ctx = bot.getCtx();
  let logOutput = '';
  const originalLog = console.log;
  console.log = (msg: string) => {
    logOutput = msg;
  };

  try {
    ctx.logger('Swap executed', 'trade');
    // Trade logs in paper trading mode should print paper SOL balance details
    assert.match(logOutput, /\[TRADE\] Swap executed \[PAPER SOL: 1.5\]/);
  } finally {
    console.log = originalLog;
  }
});

test('index VelociBuyBot processes expired cooldowns correctly', () => {
  const config = createTestConfig({
    rpcUrls: ['http://localhost:8899'],
    wsRpcUrls: ['ws://localhost:8900'],
  });
  const walletSigner = { address: '5U3D1bg3jFL2n3zPXSkwQnQKvU4uEPrKzJ6aXvQf6tTq' } as any;
  const store = new StateStore(config);
  const bot = new VelociBuyBot(config, walletSigner, store);

  // Seed processed/cooldown state
  const mockMint = '5U3D1bg3jFL2n3zPXSkwQnQKvU4uEPrKzJ6aXvQf6tTq';
  bot.state.processedMints.add(mockMint);
  bot.state.coolDownMints.set(mockMint, {
    expiresAt: Date.now() - 100, // already expired
    lastExitPriceUsd: 1.25,
  });

  (bot as any).processCoolDowns();

  // Expired cooldown should be removed, and mint should be retired/untracked
  assert.equal(bot.state.coolDownMints.has(mockMint), false);
  assert.equal(bot.state.retiredMints.has(mockMint), true);
  assert.equal(bot.state.processedMints.has(mockMint), false);
});

test('index getCtx returns active bot context or injected test context', () => {
  _setTestCtx(null);
  assert.throws(() => getCtx(), /Bot not initialized/);

  const mockCtx = { label: 'test' } as any;
  _setTestCtx(mockCtx);
  assert.equal(getCtx(), mockCtx);
  _setTestCtx(null);
});

test('index VelociBuyBot schedules and expires cooldown reactively using timers', async () => {
  const config = createTestConfig({
    rpcUrls: ['http://localhost:8899'],
    wsRpcUrls: ['ws://localhost:8900'],
  });
  const walletSigner = { address: '5U3D1bg3jFL2n3zPXSkwQnQKvU4uEPrKzJ6aXvQf6tTq' } as any;
  const store = new StateStore(config);
  const bot = new VelociBuyBot(config, walletSigner, store);

  const mockMint = 'ReactiveMint1';
  bot.state.processedMints.add(mockMint);

  // Trigger coolDownStarted event via store
  store.startCoolDown(mockMint, 1.25, Date.now() + 50); // expires in 50ms

  assert.equal(bot.state.coolDownMints.has(mockMint), true);

  // Wait 100ms for timer to fire
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Expired cooldown should be removed, and mint should be retired/untracked
  assert.equal(bot.state.coolDownMints.has(mockMint), false);
  assert.equal(bot.state.retiredMints.has(mockMint), true);
  assert.equal(bot.state.processedMints.has(mockMint), false);

  // Clean up
  bot.stop();
  await (bot as any).performShutdown();
});
