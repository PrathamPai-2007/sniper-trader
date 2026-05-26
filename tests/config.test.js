'use strict';
const { createTestConfig } = require('./_test_helpers');
const assert = require('node:assert/strict');
const test = require('node:test');
const { validateStartupConfig } = require('../config');

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
