'use strict';
import { createTestConfig, createState, withPatchedMembers, createCtx } from './_test_helpers.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as utils from '../src/core/utils.js';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { Context, ClosedTrade } from '../src/types/index.js';

test('utils journalClosedTrade appends a JSONL line with enriched trade data', async () => {
  const testFile = path.join(process.cwd(), '.test-artifacts', 'test-trade-journal.jsonl');
  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
  const config = createTestConfig({ tradeJournalFile: testFile });
  const state = createState({ closedTrades: [] });
  const testCtx = {
    config,
    state,
    logger: () => {},
    persistState: async () => {},
  } as unknown as Context;

  const trade: ClosedTrade = {
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

  utils.journalClosedTrade(testCtx, trade as any);

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
  const parsed = JSON.parse(lines[lines.length - 1]!);
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
      writeFile: async (filePath: string, content: string, encoding: string) => {
        writeFileCalls++;
        if (writeFileCalls === 1) {
          const err = new Error('EPERM: operation not permitted') as any;
          err.code = 'EPERM';
          throw err;
        }
        return originalWriteFile(filePath, content, encoding as any);
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

test('utils additional coverage tests', async () => {
  // 1. atomicWriteFile falsy path & non-retried error
  await utils.atomicWriteFile('', 'ignored'); // should return immediately

  await assert.rejects(
    () =>
      utils.atomicWriteFile(path.join(process.cwd(), '.test-artifacts'), 'data', {
        logErrors: false,
      }),
    (err: any) => err.code === 'EISDIR' || err.code === 'EACCES' || !!err
  );

  // 2. appendFileLine and appendFileLineSync falsy path
  utils.appendFileLine('', 'ignored');
  utils.appendFileLineSync('', 'ignored');

  // 3. safeJsonStringify with space parameter
  const obj = { a: 1 };
  const str = utils.safeJsonStringify(obj, 2);
  assert.ok(str.includes('\n'));

  // 4. log prefix fallback & console suppression
  const originalConsoleLog = console.log;
  let loggedConsole: string | null = null;
  console.log = (msg: string) => {
    loggedConsole = msg;
  };

  try {
    utils.setConsoleSuppressed(false);
    utils.log(null, 'hello', 'unknown', { console: true });
    assert.match(loggedConsole!, /\[INFO\] hello/);

    utils.setConsoleSuppressed(true);
    loggedConsole = null;
    utils.log(null, 'hello', 'info');
    assert.equal(loggedConsole, null);
  } finally {
    utils.setConsoleSuppressed(false);
    console.log = originalConsoleLog;
  }

  // 5. formatUsd non-finite and fractional
  assert.equal(utils.formatUsd(NaN), '$0.00');
  assert.equal(utils.formatUsd(0.0001), '$0.000100');

  // 6. atomicToDecimalString negative
  assert.equal(utils.atomicToDecimalString(-100n, 2), '-1');

  // 7. decimalToAtomic errors
  assert.throws(() => utils.decimalToAtomic('abc', 9), /Invalid decimal value/);

  // 8. bigintRatioToNumber denominator <= 0n
  assert.equal(utils.bigintRatioToNumber(10n, 0n), 0);

  // 9. clamp
  assert.equal(utils.clamp(5, 10, 20), 10);
  assert.equal(utils.clamp(25, 10, 20), 20);
  assert.equal(utils.clamp(15, 10, 20), 15);

  // 10. normalizeLaunchpad fallback
  assert.equal(utils.normalizeLaunchpad(''), 'unknown');

  // 11. deriveWsRpcUrl errors and protocols
  assert.equal(utils.deriveWsRpcUrl('invalid-url'), 'invalid-url');
  assert.equal(utils.deriveWsRpcUrl('https://example.com'), 'wss://example.com/');
  assert.equal(utils.deriveWsRpcUrl('http://example.com'), 'ws://example.com/');

  // 12. ShortTermCache eviction & clear via rpcCall
  const testCtx = createCtx();
  let rpcCalls = 0;
  testCtx.rpc = {
    getEpochInfo: () => ({
      send: async () => {
        rpcCalls++;
        return { value: rpcCalls };
      },
    }),
  } as any;
  testCtx.rpcs = [testCtx.rpc];

  const res1 = (await utils.rpcCall(testCtx, 'getEpochInfo', [], { cacheTtlMs: 50 })) as any;
  const res2 = (await utils.rpcCall(testCtx, 'getEpochInfo', [], { cacheTtlMs: 50 })) as any;
  assert.equal(res1.value, 1);
  assert.equal(res2.value, 1); // served from cache

  await new Promise((resolve) => setTimeout(resolve, 60));
  const res3 = (await utils.rpcCall(testCtx, 'getEpochInfo', [], { cacheTtlMs: 50 })) as any;
  assert.equal(res3.value, 2); // cache evicted due to TTL

  // 13. isTransientOperationError
  assert.equal(utils.isTransientOperationError(new Error('rate limit')), true);
  assert.equal(utils.isTransientOperationError(new Error('fatal error')), false);
});
