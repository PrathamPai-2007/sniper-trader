/**
 * @module Migrate
 * Handles the one-time migration of data from legacy JSON files to the SQLite database.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SQLiteDb } from './db.js';
import { log, safeJsonStringify } from './utils.js';
import {
  Position,
  RecheckItem,
  LaunchHistoryEntry,
  CoolDownEntry,
  RetiredMintEntry,
  ClosedTrade,
} from '../types/index.js';

/**
 * Migrates data from state.json and _mints.json to a provided SQLite database.
 * This function is designed to be idempotent; it checks for a 'migrated' key in the kv_store.
 *
 * @param stateFile - Path to the legacy state.json file.
 * @param mintsFile - Path to the legacy _mints.json file.
 * @param sqliteDb - The initialized SQLiteDb instance to migrate into.
 * @param logFile - Optional path to a log file.
 * @throws Will throw an error if the migration fails after starting.
 */
export async function migrateJsonToSqlite(
  stateFile: string,
  mintsFile: string,
  sqliteDb: SQLiteDb,
  logFile?: string
): Promise<void> {
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const { db } = sqliteDb;

  // Check if migration is already done
  try {
    const isMigrated = db.prepare("SELECT value FROM kv_store WHERE key = 'migrated'").get() as
      | { value: string }
      | undefined;
    if (isMigrated?.value === 'true') {
      log(logFile, 'Migration already completed.', 'info');
      return;
    }
  } catch {
    // If kv_store doesn't exist yet, we proceed with migration as it will be created by the store initialization
    log(logFile, 'Migration check failed (table might not exist), proceeding...', 'debug');
  }

  log(logFile, 'Starting JSON to SQLite migration...', 'info');

  try {
    const stateContent = fs.readFileSync(stateFile, 'utf8');
    const state = JSON.parse(stateContent) as Record<string, unknown>;

    const migrateAction = db.transaction(() => {
      // 1. Positions
      if (Array.isArray(state.positions)) {
        const insertPosition = db.prepare(`
          INSERT OR REPLACE INTO positions (mint, symbol, name, opened_at, entry_price_usd, data)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const p of state.positions as Position[]) {
          insertPosition.run(
            p.mint,
            p.symbol,
            p.name,
            p.openedAt,
            p.entryPriceUsd,
            safeJsonStringify(p)
          );
        }
      }

      // 2. Closed Trades
      if (Array.isArray(state.closedTrades)) {
        const insertTrade = db.prepare(`
          INSERT INTO closed_trades (mint, symbol, exit_reason, realized_pnl_usd, realized_pnl_sol, closed_at, data)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const t of state.closedTrades as ClosedTrade[]) {
          insertTrade.run(
            t.mint,
            t.symbol,
            t.exitReason,
            t.realizedPnlUsd,
            t.realizedPnlSol || 0,
            t.closedAt,
            safeJsonStringify(t)
          );
        }
      }

      // 3. Rechecks
      if (Array.isArray(state.pendingCandidateRechecks)) {
        const insertRecheck = db.prepare(
          'INSERT OR REPLACE INTO rechecks (mint, data) VALUES (?, ?)'
        );
        for (const r of state.pendingCandidateRechecks as RecheckItem[]) {
          insertRecheck.run(r.mint, safeJsonStringify(r));
        }
      }

      // 4. Metrics
      if (state.metrics && typeof state.metrics === 'object') {
        const metrics = state.metrics as Record<string, unknown>;
        const insertMetric = db.prepare(
          'INSERT OR REPLACE INTO metrics (key, value) VALUES (?, ?)'
        );
        for (const [key, value] of Object.entries(metrics)) {
          if (typeof value === 'object' && value !== null) {
            insertMetric.run(key, safeJsonStringify(value));
          } else {
            insertMetric.run(key, String(value));
          }
        }
      }

      // 5. Mints
      if (fs.existsSync(mintsFile)) {
        const mintsData = JSON.parse(fs.readFileSync(mintsFile, 'utf8')) as Record<string, unknown>;
        if (Array.isArray(mintsData.processedMintQueue)) {
          const insertMint = db.prepare(
            'INSERT OR REPLACE INTO processed_mints (mint, timestamp) VALUES (?, ?)'
          );
          const now = Date.now();
          for (const m of mintsData.processedMintQueue as string[]) {
            insertMint.run(m, now);
          }
        }
      }

      // 6. Launch History
      if (Array.isArray(state.launchHistory)) {
        const insertLaunch = db.prepare(
          'INSERT OR REPLACE INTO launch_history (mint, timestamp, data) VALUES (?, ?, ?)'
        );
        for (const l of state.launchHistory as LaunchHistoryEntry[]) {
          insertLaunch.run(l.mint, l.timestamp, safeJsonStringify(l));
        }
      }

      // 7. Cooldowns
      if (state.coolDownMints && typeof state.coolDownMints === 'object') {
        const insertCooldown = db.prepare(
          'INSERT OR REPLACE INTO cooldowns (mint, data) VALUES (?, ?)'
        );
        for (const [mint, data] of Object.entries(
          state.coolDownMints as Record<string, CoolDownEntry>
        )) {
          insertCooldown.run(mint, safeJsonStringify(data));
        }
      }

      // 8. Retired Mints
      if (state.retiredMints && typeof state.retiredMints === 'object') {
        const insertRetired = db.prepare(
          'INSERT OR REPLACE INTO retired_mints (mint, data) VALUES (?, ?)'
        );
        for (const [mint, data] of Object.entries(
          state.retiredMints as Record<string, RetiredMintEntry>
        )) {
          insertRetired.run(mint, safeJsonStringify(data));
        }
      }

      // 9. KV Store items
      const insertKV = db.prepare('INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)');
      insertKV.run('paperSolBalanceLamports', String(state.paperSolBalanceLamports || '0'));
      insertKV.run('tradeHistory', safeJsonStringify(state.tradeHistory || []));
      insertKV.run('moodPauseUntil', String(state.moodPauseUntil || 'null'));
      insertKV.run('migrated', 'true');
    });

    migrateAction();

    log(logFile, 'Migration completed successfully.', 'info');

    // Backup JSON files
    const backupDir = path.join(path.dirname(stateFile), 'backup');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    const timestamp = Date.now();
    try {
      fs.renameSync(stateFile, path.join(backupDir, `state.json.bak.${timestamp}`));
      if (fs.existsSync(mintsFile)) {
        fs.renameSync(mintsFile, path.join(backupDir, `_mints.json.bak.${timestamp}`));
      }
    } catch (renameErr) {
      log(
        logFile,
        `Failed to backup JSON files (continuing anyway): ${renameErr instanceof Error ? renameErr.message : String(renameErr)}`,
        'warn'
      );
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    log(logFile, `Migration failed: ${msg}`, 'error');
    throw new Error(`Migration failed: ${msg}`, { cause: error });
  }
}
