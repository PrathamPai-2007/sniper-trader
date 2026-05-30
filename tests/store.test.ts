'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createTestConfig } from './_test_helpers.js';
import { StateStore } from '../src/core/store.js';

test('store batches SQLite writes and flushes them on force persist', async () => {
  const dir = path.join(process.cwd(), '.test-artifacts', `store-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const stateFile = path.join(dir, 'state.json');
  const dbFile = path.join(dir, 'state.db');

  const store = new StateStore(
    createTestConfig({
      stateFile,
      logFile: path.join(dir, 'bot.log'),
      stateFlushIntervalMs: 10_000,
    })
  );
  await store.load(stateFile);

  store.incrementMetric('buyAttempts');
  store.upsertRecheckEntry({
    mint: 'QueuedMint',
    tokenSnapshot: { id: 'QueuedMint', symbol: 'Q', name: 'Queued Mint', decimals: 6 },
  });

  const before = new Database(dbFile, { readonly: true });
  assert.equal(
    before.prepare("SELECT value FROM metrics WHERE key = 'buyAttempts'").get(),
    undefined
  );
  before.close();

  assert.equal(store.state.metrics.buyAttempts, 1);
  assert.equal(store.state.pendingCandidateRechecks.has('QueuedMint'), true);

  await store.persist({ force: true });

  const after = new Database(dbFile, { readonly: true });
  assert.equal(
    (
      after.prepare("SELECT value FROM metrics WHERE key = 'buyAttempts'").get() as {
        value: string;
      }
    ).value,
    '1'
  );
  assert.ok(after.prepare("SELECT data FROM rechecks WHERE mint = 'QueuedMint'").get());
  after.close();

  store.requestShutdown();
  await store.flush();
});
