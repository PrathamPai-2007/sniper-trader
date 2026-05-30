'use strict';
import { createTestConfig } from './_test_helpers.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateStartupConfig, loadConfig } from '../src/core/config.js';

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

test('config validation fails when required endpoints are missing', () => {
  assert.throws(
    () =>
      validateStartupConfig(
        createTestConfig({
          rpcUrl: '',
        })
      ),
    /rpcUrl, jupiterBaseUrl, and jupiterApiKey are required/
  );
});

test('config validation rejects invalid numeric bounds', () => {
  // slippageBps must be between 1 and 5000
  assert.throws(
    () =>
      validateStartupConfig(
        createTestConfig({
          slippageBps: 0,
        })
      ),
    /slippageBps/
  );

  assert.throws(
    () =>
      validateStartupConfig(
        createTestConfig({
          slippageBps: 6000,
        })
      ),
    /slippageBps/
  );

  // stopLossPct must be > 0 and < 1
  assert.throws(
    () =>
      validateStartupConfig(
        createTestConfig({
          stopLossPct: 0,
        })
      ),
    /stopLossPct/
  );

  assert.throws(
    () =>
      validateStartupConfig(
        createTestConfig({
          stopLossPct: 1,
        })
      ),
    /stopLossPct/
  );
});

test('config validateStartupConfig validation edge cases', () => {
  // Invalid config
  assert.throws(() => validateStartupConfig(null as any), /config object is required/);

  // positive fields negative check
  assert.throws(
    () =>
      validateStartupConfig(
        createTestConfig({
          scanIntervalMs: -1,
        })
      ),
    /scanIntervalMs/
  );

  // takeProfitFraction bounds
  assert.throws(
    () =>
      validateStartupConfig(
        createTestConfig({
          takeProfitFraction: 0,
        })
      ),
    /takeProfitFraction/
  );
  assert.throws(
    () =>
      validateStartupConfig(
        createTestConfig({
          takeProfitFraction: 1.5,
        })
      ),
    /takeProfitFraction/
  );

  // parallelismMinFactor bounds
  assert.throws(
    () =>
      validateStartupConfig(
        createTestConfig({
          parallelismMinFactor: 0,
        })
      ),
    /parallelismMinFactor/
  );

  // backpressureErrorRateThreshold bounds
  assert.throws(
    () =>
      validateStartupConfig(
        createTestConfig({
          backpressureErrorRateThreshold: 1.2,
        })
      ),
    /backpressureErrorRateThreshold/
  );

  // trailingStopDrawdownPct bounds
  assert.throws(
    () =>
      validateStartupConfig(
        createTestConfig({
          trailingStopDrawdownPct: 1.5,
        })
      ),
    /trailingStopDrawdownPct/
  );

  // takeProfitMultiples empty/invalid
  assert.throws(
    () =>
      validateStartupConfig(
        createTestConfig({
          takeProfitMultiples: [],
        })
      ),
    /takeProfitMultiples/
  );
  assert.throws(
    () =>
      validateStartupConfig(
        createTestConfig({
          takeProfitMultiples: [0.5],
        })
      ),
    /takeProfitMultiples/
  );

  // priority fees invalid
  assert.throws(
    () =>
      validateStartupConfig(
        createTestConfig({
          priorityFeeBaseMicroLamports: 100,
          priorityFeeMaxMicroLamports: 50,
        })
      ),
    /Priority fee range is invalid/
  );

  // priorityFeePercentile bounds
  assert.throws(
    () =>
      validateStartupConfig(
        createTestConfig({
          priorityFeePercentile: 101,
        })
      ),
    /priorityFeePercentile/
  );

  // stale threshold vs watchdog
  assert.throws(
    () =>
      validateStartupConfig(
        createTestConfig({
          websocketWatchdogIntervalMs: 5000,
          websocketStaleThresholdMs: 2000,
        })
      ),
    /websocketStaleThresholdMs/
  );

  // Jito config invalid
  assert.throws(
    () =>
      validateStartupConfig(
        createTestConfig({
          useJito: true,
          jitoBlockEngineUrl: '',
        })
      ),
    /jitoBlockEngineUrl is required/
  );
  assert.throws(
    () =>
      validateStartupConfig(
        createTestConfig({
          useJito: true,
          jitoTipLamports: 0n,
        })
      ),
    /jitoTipLamports must be greater than 0/
  );
});

test('config loadConfig from environment', () => {
  const originalEnv = { ...process.env };
  try {
    process.env.RPC_URL = 'http://localhost:8899,http://localhost:8900';
    process.env.JUPITER_API_KEY = 'mock-api-key';
    process.env.PRIVATE_KEY = '5U3D1bg3jFL2n3zPXSkwQnQKvU4uEPrKzJ6aXvQf6tTq';
    process.env.PAPER_TRADING = 'true';
    process.env.BUY_AMOUNT_SOL = '0.1';

    const loaded = loadConfig();

    assert.equal(loaded.rpcUrl, 'http://localhost:8899');
    assert.deepEqual(loaded.rpcUrls, ['http://localhost:8899', 'http://localhost:8900']);
    assert.equal(loaded.jupiterApiKey, 'mock-api-key');
    assert.equal(loaded.paperTrading, true);
    assert.equal(loaded.buyAmountSolText, '0.1');

    // Test invalid buy amount error
    process.env.BUY_AMOUNT_SOL = 'invalid';
    assert.throws(() => loadConfig(), /BUY_AMOUNT_SOL must be a positive decimal/);
  } finally {
    process.env = originalEnv;
  }
});
