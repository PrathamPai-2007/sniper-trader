'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { SQLiteDb } from '../src/core/db.js';
import { migrateJsonToSqlite } from '../src/core/migrate.js';

test('migrateJsonToSqlite migrates legacy JSON files to SQLite', async () => {
  const testDir = path.join(process.cwd(), '.test-artifacts', `migrate-test-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });

  const stateFile = path.join(testDir, 'state.json');
  const mintsFile = path.join(testDir, '_mints.json');
  const dbFile = path.join(testDir, 'state.db');

  const legacyState = {
    paperSolBalanceLamports: '500000000',
    tradeHistory: [true, false, true],
    moodPauseUntil: 1234567890,
    positions: [
      {
        mint: 'MintPosition1',
        symbol: 'POS1',
        name: 'Position One',
        openedAt: '2026-01-01T00:00:00.000Z',
        entryPriceUsd: 1.25,
        decimals: 6,
        initialTokenAmountRaw: '1000000',
      },
    ],
    closedTrades: [
      {
        mint: 'MintClosed1',
        symbol: 'CL1',
        exitReason: 'take-profit-1.5x',
        realizedPnlUsd: 2.5,
        realizedPnlSol: 0.02,
        closedAt: '2026-01-02T00:00:00.000Z',
      },
    ],
    pendingCandidateRechecks: [
      {
        mint: 'MintRecheck1',
        candidateScore: 85,
        isFinalAudit: true,
      },
    ],
    metrics: {
      buyAttempts: 10,
      buyFailures: 2,
      exitReasonCounts: { 'stop-loss': 1 },
    },
    launchHistory: [
      {
        mint: 'MintLaunch1',
        firstSeenPrice: 0.5,
        highestSeenPrice: 0.8,
        isSuccess: true,
        timestamp: 1600000000,
      },
    ],
    coolDownMints: {
      MintCool1: {
        expiresAt: 1700000000,
        lastExitPriceUsd: 1.1,
      },
    },
    retiredMints: {
      MintRetired1: {
        lastExitPriceUsd: 0.95,
        retiredAt: '2026-01-03T00:00:00.000Z',
      },
    },
  };

  const legacyMints = {
    processedMintQueue: ['MintProcessed1', 'MintProcessed2'],
  };

  fs.writeFileSync(stateFile, JSON.stringify(legacyState), 'utf8');
  fs.writeFileSync(mintsFile, JSON.stringify(legacyMints), 'utf8');

  // Initialize DB
  const sqliteDb = new SQLiteDb(dbFile, path.join(testDir, 'bot.log'));
  sqliteDb.init();

  // Run migration
  await migrateJsonToSqlite(stateFile, mintsFile, sqliteDb, path.join(testDir, 'bot.log'));

  // Assert DB values
  const { db } = sqliteDb;

  const migratedKey = db.prepare("SELECT value FROM kv_store WHERE key = 'migrated'").get() as any;
  assert.equal(migratedKey?.value, 'true');

  const paperSol = db
    .prepare("SELECT value FROM kv_store WHERE key = 'paperSolBalanceLamports'")
    .get() as any;
  assert.equal(paperSol?.value, '500000000');

  const tradeHistory = db
    .prepare("SELECT value FROM kv_store WHERE key = 'tradeHistory'")
    .get() as any;
  assert.deepEqual(JSON.parse(tradeHistory?.value), [true, false, true]);

  const pos1 = db.prepare("SELECT * FROM positions WHERE mint = 'MintPosition1'").get() as any;
  assert.ok(pos1);
  assert.equal(pos1.symbol, 'POS1');
  assert.equal(pos1.entry_price_usd, 1.25);

  const closed = db.prepare("SELECT * FROM closed_trades WHERE mint = 'MintClosed1'").get() as any;
  assert.ok(closed);
  assert.equal(closed.exit_reason, 'take-profit-1.5x');
  assert.equal(closed.realized_pnl_usd, 2.5);

  const recheck = db.prepare("SELECT * FROM rechecks WHERE mint = 'MintRecheck1'").get() as any;
  assert.ok(recheck);
  const recheckData = JSON.parse(recheck.data);
  assert.equal(recheckData.candidateScore, 85);

  const metricBuy = db.prepare("SELECT value FROM metrics WHERE key = 'buyAttempts'").get() as any;
  assert.equal(metricBuy?.value, '10');

  const processed = db
    .prepare('SELECT mint FROM processed_mints ORDER BY timestamp ASC')
    .all() as any[];
  assert.equal(processed.length, 2);
  assert.equal(processed[0].mint, 'MintProcessed1');
  assert.equal(processed[1].mint, 'MintProcessed2');

  const launch = db.prepare("SELECT * FROM launch_history WHERE mint = 'MintLaunch1'").get() as any;
  assert.ok(launch);
  const launchData = JSON.parse(launch.data);
  assert.equal(launchData.highestSeenPrice, 0.8);

  const cooldown = db.prepare("SELECT * FROM cooldowns WHERE mint = 'MintCool1'").get() as any;
  assert.ok(cooldown);
  const cooldownData = JSON.parse(cooldown.data);
  assert.equal(cooldownData.expiresAt, 1700000000);

  const retired = db
    .prepare("SELECT * FROM retired_mints WHERE mint = 'MintRetired1'")
    .get() as any;
  assert.ok(retired);
  const retiredData = JSON.parse(retired.data);
  assert.equal(retiredData.lastExitPriceUsd, 0.95);

  sqliteDb.close();

  // Verify backup created
  const backupDir = path.join(testDir, 'backup');
  assert.ok(fs.existsSync(backupDir));
  const backups = fs.readdirSync(backupDir);
  assert.ok(backups.some((f) => f.startsWith('state.json.bak.')));
  assert.ok(backups.some((f) => f.startsWith('_mints.json.bak.')));
});

test('migrateJsonToSqlite handles missing files and failures gracefully', async () => {
  const testDir = path.join(process.cwd(), '.test-artifacts', `migrate-fail-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });

  const stateFile = path.join(testDir, 'non-existent.json');
  const dbFile = path.join(testDir, 'state.db');

  const sqliteDb = new SQLiteDb(dbFile, path.join(testDir, 'bot.log'));
  sqliteDb.init();

  // If stateFile doesn't exist, it should return early
  await assert.doesNotReject(() => migrateJsonToSqlite(stateFile, '', sqliteDb));

  // If stateFile contains invalid JSON, it should throw
  const invalidFile = path.join(testDir, 'invalid.json');
  fs.writeFileSync(invalidFile, '{ malformed', 'utf8');
  await assert.rejects(() => migrateJsonToSqlite(invalidFile, '', sqliteDb), /Migration failed/);

  sqliteDb.close();
});
