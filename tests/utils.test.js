'use strict';
const { createTestConfig, createState, withPatchedMembers } = require('./_test_helpers');
const assert = require('node:assert/strict');
const test = require('node:test');
const utils = require('../utils');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');

test('utils journalClosedTrade appends a JSONL line with enriched trade data', async () => {
  const testFile = path.join(process.cwd(), '.test-artifacts', 'test-trade-journal.jsonl');
  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
  const ctx = createTestConfig({ tradeJournalFile: testFile });
  const state = createState({ closedTrades: [] });
  const testCtx = { config: ctx, state, logger: () => {}, persistState: () => {} };

  const trade = {
    mint: 'TestMint',
    symbol: 'TST',
    exitReason: 'take-profit-1.5x',
    realizedPnlUsd: 3.5,
    realizedProceedsUsd: 8.5,
    entryUsdValue: 5,
    entryPriceUsd: 0.5,
    highestPriceUsd: 1.0,
    holdSeconds: 120,
    closedAt: '2026-01-01T00:00:00.000Z',
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

  utils.journalClosedTrade(testCtx, trade);

  let content = '';
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(testFile)) {
      content = fs.readFileSync(testFile, 'utf8').trim();
      if (content.length > 0) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.ok(content.length > 0);
  const lines = content.split('\n');
  const parsed = JSON.parse(lines[lines.length - 1]);
  assert.equal(parsed.mint, 'TestMint');
  assert.equal(parsed.entryScore, 80);
  assert.equal(parsed.exitReason, 'take-profit-1.5x');
  assert.equal(parsed.tpProfile, 'high-confidence');
  assert.ok(parsed.timestamp);
});

test('utility runBoundedPool preserves input order while enforcing concurrency limits', async () => {
  let active = 0;
  let maxActive = 0;

  const results = await utils.runBoundedPool(
    [30, 10, 20],
    async (delay, index) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, delay));
      active--;
      return index;
    },
    { concurrency: 2 }
  );

  assert.equal(maxActive, 2);
  assert.deepEqual(
    results.map((result) => result.value),
    [0, 1, 2]
  );
});

test('utility computeStandardDeviation calculates correctly', () => {
  const values = [10, 12, 23, 23, 16, 23, 21, 16];
  const std = utils.computeStandardDeviation(values);
  assert.ok(Math.abs(std - 5.237) < 0.01);
});

test('utility computeSpread calculates correctly', () => {
  const spread = utils.computeSpread(99, 101); // (101-99) / 100 = 0.02
  assert.strictEqual(spread, 0.02);
});

test('utility decodePumpCurve decodes valid pump.fun curve buffers', () => {
  const buffer = Buffer.alloc(49);
  buffer.write('7b02ecedd6df6b41', 0, 'hex');
  buffer.writeBigUInt64LE(1_000_000_000_000_000n, 8);
  buffer.writeBigUInt64LE(30_000_000_000n, 16);
  buffer.writeBigUInt64LE(800_000_000_000_000n, 24);
  buffer.writeBigUInt64LE(0n, 32);
  buffer.writeBigUInt64LE(1_000_000_000_000_000n, 40);
  buffer.writeUInt8(0, 48);

  const decoded = utils.decodePumpCurve(buffer);
  assert.ok(decoded);
  assert.equal(decoded.virtualTokenReserves, 1_000_000_000_000_000n);
  assert.equal(decoded.virtualSolReserves, 30_000_000_000n);
  assert.equal(decoded.isCompleted, false);
});

// --- NEW TEST CASES ---

test('safeJsonStringify serializes BigInt and other standard types correctly', () => {
  const payload = {
    bigValue: 1234567890123456789n,
    regularValue: 42,
    nested: {
      anotherBig: 999n,
    },
  };

  const serialized = utils.safeJsonStringify(payload);
  const parsed = JSON.parse(serialized);

  assert.equal(parsed.bigValue, '1234567890123456789');
  assert.equal(parsed.regularValue, 42);
  assert.equal(parsed.nested.anotherBig, '999');
});

test('atomicWriteFile retries on Windows EPERM / EBUSY errors', async () => {
  const targetFile = path.join(process.cwd(), '.test-artifacts', 'atomic-retry-test.txt');
  let writeFileCalls = 0;
  const originalWriteFile = fsPromises.writeFile;

  // We patch fsPromises.writeFile using withPatchedMembers
  await withPatchedMembers(
    fsPromises,
    {
      writeFile: async (filePath, content, encoding) => {
        writeFileCalls++;
        if (writeFileCalls === 1) {
          const err = new Error('EPERM: operation not permitted');
          err.code = 'EPERM';
          throw err;
        }
        return originalWriteFile(filePath, content, encoding);
      },
    },
    async () => {
      await utils.atomicWriteFile(targetFile, 'retry success');
      assert.equal(writeFileCalls, 2);
      const written = fs.readFileSync(targetFile, 'utf8');
      assert.equal(written, 'retry success');
    }
  );
});
