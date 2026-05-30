import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { log, safeJsonStringify } from './utils.js';
import { SQLiteDb } from './db.js';
import { migrateJsonToSqlite } from './migrate.js';
import { MAX_TRACKED_MINTS } from './config.js';
import {
  Config,
  State,
  Position,
  RecheckItem,
  MarketSnapshot,
  CoolDownEntry,
  ClosedTrade,
  RetiredMintEntry,
  TokenMetadata,
  LaunchHistoryEntry,
  StateMetrics,
} from '../types/index.js';

/**
 * StateStore manages the bot's runtime state, metrics, and persistence using SQLite.
 * It extends EventEmitter to provide a reactive interface for state changes.
 */
export class StateStore extends EventEmitter {
  public config: Config;
  public state: State;
  private _sqlite: SQLiteDb | null = null;
  private _writeQueue: Array<() => void> = [];
  private _flushTimer: NodeJS.Timeout | null = null;
  private _isFlushing = false;
  private _shutdownRequested = false;

  // Prepared Statements
  private stmtUpsertPosition: Database.Statement | null = null;
  private stmtRemovePosition: Database.Statement | null = null;
  private stmtAddClosedTrade: Database.Statement | null = null;
  private stmtUpsertRecheck: Database.Statement | null = null;
  private stmtRemoveRecheck: Database.Statement | null = null;
  private stmtUpsertMetric: Database.Statement | null = null;
  private stmtTrackMint: Database.Statement | null = null;
  private stmtUntrackMint: Database.Statement | null = null;
  private stmtUpsertKV: Database.Statement | null = null;
  private stmtUpsertCooldown: Database.Statement | null = null;
  private stmtRemoveCooldown: Database.Statement | null = null;
  private stmtUpsertRetired: Database.Statement | null = null;
  private stmtRemoveRetired: Database.Statement | null = null;
  private stmtUpsertLaunch: Database.Statement | null = null;
  private stmtUpsertSnapshot: Database.Statement | null = null;
  private stmtRemoveSnapshot: Database.Statement | null = null;

  constructor(config: Config) {
    super();
    this.config = config;
    this.state = this._getDefaultState();
  }

  /**
   * Provides the default initial state for the store.
   * @private
   */
  private _getDefaultState(): State {
    return {
      processedMintQueue: [],
      processedMints: new Set<string>(),
      pendingCandidateRechecks: new Map<string, RecheckItem>(),
      positions: new Map<string, Position>(),
      marketSnapshots: new Map<string, MarketSnapshot>(),
      launchHistory: [],
      paperSolBalanceLamports: this.config?.initialPaperSolLamports?.toString() || '100000000',
      tradeHistory: [],
      moodPauseUntil: null,
      coolDownMints: new Map<string, CoolDownEntry>(),
      retiredMints: new Map<string, RetiredMintEntry>(),
      closedTrades: [],
      metrics: {
        discoveredCandidates: 0,
        passedCheapAudit: 0,
        passedSurvival: 0,
        boughtPositions: 0,
        passedAudit: 0,
        failedMomentum: 0,
        buyAttempts: 0,
        buyFailures: 0,
        profitableTrades: 0,
        stopLosses: 0,
        trailingExits: 0,
        finalAuditQueued: 0,
        finalAuditPassed: 0,
        finalAuditDeferredIndexing: 0,
        finalAuditRejected: 0,
        exitReasonCounts: {},
        rejectionReasons: {},
      },
      sessionStartingSolBalanceLamports: null,
      peakSessionSolBalanceLamports: null,
    };
  }

  /**
   * Loads the state from SQLite, performing migration if necessary.
   * @param stateFile - Base path for state files (will be converted to .db).
   */
  public async load(stateFile: string): Promise<void> {
    if (!stateFile) return;
    const dbPath = stateFile.replace(/\.json$/, '.db');
    this._sqlite = new SQLiteDb(dbPath, this.config.logFile);
    this._sqlite.init();

    // 1. Migrate if needed
    const mintsFile = stateFile.replace(/\.json$/, '_mints.json');
    await migrateJsonToSqlite(stateFile, mintsFile, this._sqlite, this.config.logFile);

    // 2. Prepare Statements
    this._prepareStatements();

    // 3. Load from SQLite
    this._loadFromDb();
  }

  private _enqueueWrite(operation: (() => void) | undefined): void {
    if (!operation || this._shutdownRequested) return;
    this._writeQueue.push(operation);
    if (!this._flushTimer) {
      const delayMs = Math.max(1, Number(this.config.stateFlushIntervalMs || 250));
      this._flushTimer = setTimeout(() => {
        this._flushTimer = null;
        this._flushQueuedWrites().catch((err: unknown) => {
          log(
            this.config.logFile,
            `SQLite queued persistence failed: ${err instanceof Error ? err.message : String(err)}`,
            'error'
          );
        });
      }, delayMs);
    }
  }

  private async _flushQueuedWrites(): Promise<void> {
    if (this._isFlushing || !this._sqlite || this._writeQueue.length === 0) return;
    this._isFlushing = true;
    const batch = this._writeQueue.splice(0);
    try {
      this._sqlite.db.transaction((writes: Array<() => void>) => {
        for (const write of writes) write();
      })(batch);
    } finally {
      this._isFlushing = false;
    }
  }

  /**
   * Prepares SQLite statements for efficient data persistence.
   * @private
   */
  private _prepareStatements(): void {
    if (!this._sqlite) return;
    const { db } = this._sqlite;

    this.stmtUpsertPosition = db.prepare(`
      INSERT OR REPLACE INTO positions (mint, symbol, name, opened_at, entry_price_usd, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.stmtRemovePosition = db.prepare('DELETE FROM positions WHERE mint = ?');

    this.stmtAddClosedTrade = db.prepare(`
      INSERT INTO closed_trades (mint, symbol, exit_reason, realized_pnl_usd, realized_pnl_sol, closed_at, data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtUpsertRecheck = db.prepare(
      'INSERT OR REPLACE INTO rechecks (mint, data) VALUES (?, ?)'
    );
    this.stmtRemoveRecheck = db.prepare('DELETE FROM rechecks WHERE mint = ?');

    this.stmtUpsertMetric = db.prepare('INSERT OR REPLACE INTO metrics (key, value) VALUES (?, ?)');

    this.stmtTrackMint = db.prepare(
      'INSERT OR REPLACE INTO processed_mints (mint, timestamp) VALUES (?, ?)'
    );
    this.stmtUntrackMint = db.prepare('DELETE FROM processed_mints WHERE mint = ?');

    this.stmtUpsertKV = db.prepare('INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)');

    this.stmtUpsertCooldown = db.prepare(
      'INSERT OR REPLACE INTO cooldowns (mint, data) VALUES (?, ?)'
    );
    this.stmtRemoveCooldown = db.prepare('DELETE FROM cooldowns WHERE mint = ?');

    this.stmtUpsertRetired = db.prepare(
      'INSERT OR REPLACE INTO retired_mints (mint, data) VALUES (?, ?)'
    );
    this.stmtRemoveRetired = db.prepare('DELETE FROM retired_mints WHERE mint = ?');

    this.stmtUpsertLaunch = db.prepare(
      'INSERT OR REPLACE INTO launch_history (mint, timestamp, data) VALUES (?, ?, ?)'
    );

    this.stmtUpsertSnapshot = db.prepare(
      'INSERT OR REPLACE INTO snapshots (mint, data) VALUES (?, ?)'
    );
    this.stmtRemoveSnapshot = db.prepare('DELETE FROM snapshots WHERE mint = ?');
  }

  /**
   * Loads all state data from the SQLite database into memory.
   * @private
   */
  private _loadFromDb(): void {
    if (!this._sqlite) return;
    const { db } = this._sqlite;

    // Load Positions
    const positions = db.prepare('SELECT data FROM positions').all() as { data: string }[];
    this.state.positions = new Map(
      positions.map((p) => {
        const parsed = JSON.parse(p.data) as Position;
        return [parsed.mint, parsed];
      })
    );

    // Load Rechecks
    const rechecks = db.prepare('SELECT data FROM rechecks').all() as { data: string }[];
    this.state.pendingCandidateRechecks = new Map(
      rechecks.map((r) => {
        const parsed = JSON.parse(r.data) as RecheckItem;
        return [parsed.mint, parsed];
      })
    );

    // Load Metrics
    const metrics = db.prepare('SELECT key, value FROM metrics').all() as {
      key: string;
      value: string;
    }[];
    for (const m of metrics) {
      const key = m.key as keyof StateMetrics;
      if (key === 'exitReasonCounts' || key === 'rejectionReasons') {
        this.state.metrics[key] = JSON.parse(m.value) as Record<string, number>;
      } else if (typeof this.state.metrics[key] === 'number') {
        (this.state.metrics as any)[key] = Number(m.value);
      }
    }

    // Load Processed Mints
    const mints = db.prepare('SELECT mint FROM processed_mints ORDER BY timestamp ASC').all() as {
      mint: string;
    }[];
    this.state.processedMintQueue = mints.map((m) => m.mint);
    this.state.processedMints = new Set(this.state.processedMintQueue);

    // Load Closed Trades (limit to last 500)
    const closedTrades = db
      .prepare('SELECT data FROM closed_trades ORDER BY id DESC LIMIT 500')
      .all() as { data: string }[];
    this.state.closedTrades = closedTrades.map((t) => JSON.parse(t.data) as ClosedTrade).reverse();

    // Load Launch History (last 100)
    const launchHistory = db
      .prepare('SELECT data FROM launch_history ORDER BY timestamp DESC LIMIT 100')
      .all() as { data: string }[];
    this.state.launchHistory = launchHistory
      .map((l) => JSON.parse(l.data) as LaunchHistoryEntry)
      .reverse();

    // Load Cooldowns
    const cooldowns = db.prepare('SELECT mint, data FROM cooldowns').all() as {
      mint: string;
      data: string;
    }[];
    this.state.coolDownMints = new Map(
      cooldowns.map((c) => [c.mint, JSON.parse(c.data) as CoolDownEntry])
    );

    // Load Retired Mints
    const retired = db.prepare('SELECT mint, data FROM retired_mints').all() as {
      mint: string;
      data: string;
    }[];
    this.state.retiredMints = new Map(
      retired.map((r) => [r.mint, JSON.parse(r.data) as RetiredMintEntry])
    );

    // Load Market Snapshots
    const snapshots = db.prepare('SELECT mint, data FROM snapshots').all() as {
      mint: string;
      data: string;
    }[];
    this.state.marketSnapshots = new Map(
      snapshots.map((s) => [s.mint, JSON.parse(s.data) as MarketSnapshot])
    );

    // Load KV Store
    const kv = db.prepare('SELECT key, value FROM kv_store').all() as {
      key: string;
      value: string;
    }[];
    for (const item of kv) {
      if (item.key === 'paperSolBalanceLamports') this.state.paperSolBalanceLamports = item.value;
      if (item.key === 'tradeHistory')
        this.state.tradeHistory = JSON.parse(item.value) as boolean[];
      if (item.key === 'moodPauseUntil')
        this.state.moodPauseUntil = item.value === 'null' ? null : Number(item.value);
      if (item.key === 'sessionStartingSolBalanceLamports')
        this.state.sessionStartingSolBalanceLamports = item.value === 'null' ? null : item.value;
      if (item.key === 'peakSessionSolBalanceLamports')
        this.state.peakSessionSolBalanceLamports = item.value === 'null' ? null : item.value;
    }

    // Initialize session starting balance if not set (first run of session)
    if (!this.state.sessionStartingSolBalanceLamports) {
      this.state.sessionStartingSolBalanceLamports = this.state.paperSolBalanceLamports;
      this.state.peakSessionSolBalanceLamports = this.state.paperSolBalanceLamports;
      const startVal = this.state.sessionStartingSolBalanceLamports;
      const peakVal = this.state.peakSessionSolBalanceLamports;
      this._enqueueWrite(
        this.stmtUpsertKV
          ? () => {
              this.stmtUpsertKV!.run('sessionStartingSolBalanceLamports', startVal);
              this.stmtUpsertKV!.run('peakSessionSolBalanceLamports', peakVal);
            }
          : undefined
      );
    }

    log(
      this.config.logFile,
      `State loaded from SQLite: ${this.state.positions.size} positions, ${this.state.processedMints.size} mints.`,
      'info'
    );
  }

  /**
   * Tracks a mint as processed.
   * @param mint - The token mint address.
   */
  public trackMint(mint: string): void {
    if (this.state.processedMints.has(mint)) return;

    this.state.pendingCandidateRechecks.delete(mint);
    this._enqueueWrite(
      this.stmtRemoveRecheck ? () => this.stmtRemoveRecheck!.run(mint) : undefined
    );

    this.state.processedMints.add(mint);
    this.state.processedMintQueue.push(mint);

    const now = Date.now();
    this._enqueueWrite(this.stmtTrackMint ? () => this.stmtTrackMint!.run(mint, now) : undefined);

    while (this.state.processedMintQueue.length > MAX_TRACKED_MINTS) {
      const removed = this.state.processedMintQueue.shift();
      if (removed) {
        this.state.processedMints.delete(removed);
        this._enqueueWrite(
          this.stmtUntrackMint ? () => this.stmtUntrackMint!.run(removed) : undefined
        );
      }
    }

    this.emit('mintTracked', mint);
  }

  /**
   * Untracks a mint.
   * @param mint - The token mint address.
   */
  public untrackMint(mint: string): void {
    if (this.state.processedMints.delete(mint)) {
      this.state.processedMintQueue = this.state.processedMintQueue.filter((m) => m !== mint);
      this._enqueueWrite(this.stmtUntrackMint ? () => this.stmtUntrackMint!.run(mint) : undefined);
      this.emit('mintUntracked', mint);
    }
    this.state.pendingCandidateRechecks.delete(mint);
    this._enqueueWrite(
      this.stmtRemoveRecheck ? () => this.stmtRemoveRecheck!.run(mint) : undefined
    );
  }

  /**
   * Upserts a position into the state.
   * @param position - The position object.
   */
  public upsertPosition(position: Position): void {
    const isNew = !this.state.positions.has(position.mint);
    this.state.positions.set(position.mint, position);

    this._enqueueWrite(
      this.stmtUpsertPosition
        ? () =>
            this.stmtUpsertPosition!.run(
              position.mint,
              position.symbol,
              position.name,
              position.openedAt,
              position.entryPriceUsd,
              safeJsonStringify(position)
            )
        : undefined
    );

    this.emit(isNew ? 'positionAdded' : 'positionUpdated', position);
  }

  /**
   * Removes a position from the state.
   * @param mint - The token mint address.
   */
  public removePosition(mint: string): void {
    const position = this.state.positions.get(mint);
    if (position) {
      this.state.positions.delete(mint);
      this._enqueueWrite(
        this.stmtRemovePosition ? () => this.stmtRemovePosition!.run(mint) : undefined
      );
      this.emit('positionRemoved', position);
    }
  }

  /**
   * Increments a numeric metric value.
   * @param key - The metric key to increment.
   * @param amount - The amount to increment by (default: 1).
   */
  public incrementMetric(key: keyof StateMetrics, amount = 1): void {
    const value = this.state.metrics[key];
    if (typeof value === 'number') {
      const newValue = value + amount;
      (this.state.metrics as any)[key] = newValue;
      this._enqueueWrite(
        this.stmtUpsertMetric ? () => this.stmtUpsertMetric!.run(key, String(newValue)) : undefined
      );
      this.emit('metricUpdated', { key, value: newValue });
    }
  }

  /**
   * Updates a metric value directly (e.g., for non-numeric or complex metrics).
   * @param key - The metric key.
   * @param value - The new value.
   */
  public updateMetric<K extends keyof StateMetrics>(key: K, value: StateMetrics[K]): void {
    this.state.metrics[key] = value;
    const stringValue = typeof value === 'object' ? safeJsonStringify(value) : String(value);
    this._enqueueWrite(
      this.stmtUpsertMetric ? () => this.stmtUpsertMetric!.run(key, stringValue) : undefined
    );
    this.emit('metricUpdated', { key, value });
  }

  /**
   * Records a rejection reason in metrics.
   * @param code - The rejection reason code.
   */
  public recordRejection(code: string): void {
    if (!code) return;
    this.state.metrics.rejectionReasons[code] =
      (this.state.metrics.rejectionReasons[code] || 0) + 1;
    const payload = safeJsonStringify(this.state.metrics.rejectionReasons);
    this._enqueueWrite(
      this.stmtUpsertMetric
        ? () => this.stmtUpsertMetric!.run('rejectionReasons', payload)
        : undefined
    );
    this.emit('rejectionRecorded', code);
  }

  /**
   * Updates the paper trading SOL balance.
   * @param amountLamports - The new balance in lamports.
   */
  public updatePaperSolBalance(amountLamports: bigint | string): void {
    this.state.paperSolBalanceLamports = amountLamports.toString();
    const value = this.state.paperSolBalanceLamports;
    this._enqueueWrite(
      this.stmtUpsertKV ? () => this.stmtUpsertKV!.run('paperSolBalanceLamports', value) : undefined
    );
    this.emit('paperSolBalanceUpdated', this.state.paperSolBalanceLamports);
    this.updateSessionPeakBalance();
  }

  /**
   * Updates the session's peak SOL balance if the current balance is higher.
   */
  public updateSessionPeakBalance(): void {
    const current = BigInt(this.state.paperSolBalanceLamports);
    const peak = BigInt(this.state.peakSessionSolBalanceLamports || '0');
    if (current > peak) {
      this.state.peakSessionSolBalanceLamports = current.toString();
      const val = this.state.peakSessionSolBalanceLamports;
      this._enqueueWrite(
        this.stmtUpsertKV
          ? () => this.stmtUpsertKV!.run('peakSessionSolBalanceLamports', val)
          : undefined
      );
      this.emit('sessionPeakBalanceUpdated', val);
    }
  }

  /**
   * Adds a closed trade record to the history.
   * @param trade - The closed trade record.
   */
  public addClosedTrade(trade: ClosedTrade): void {
    this.state.closedTrades.push(trade);
    if (this.state.closedTrades.length > 500) {
      this.state.closedTrades.shift();
    }
    const payload = safeJsonStringify(trade);
    this._enqueueWrite(
      this.stmtAddClosedTrade
        ? () =>
            this.stmtAddClosedTrade!.run(
              trade.mint,
              trade.symbol,
              trade.exitReason,
              trade.realizedPnlUsd,
              trade.realizedPnlSol || 0,
              trade.closedAt,
              payload
            )
        : undefined
    );
    this.emit('tradeClosed', trade);
  }

  /**
   * Increments an exit reason metric.
   * @param reason - The exit reason code.
   */
  public incrementExitReason(reason: string): void {
    if (!reason) return;
    this.state.metrics.exitReasonCounts[reason] =
      (this.state.metrics.exitReasonCounts[reason] || 0) + 1;
    const payload = safeJsonStringify(this.state.metrics.exitReasonCounts);
    this._enqueueWrite(
      this.stmtUpsertMetric
        ? () => this.stmtUpsertMetric!.run('exitReasonCounts', payload)
        : undefined
    );
    this.emit('exitReasonIncremented', {
      reason,
      count: this.state.metrics.exitReasonCounts[reason],
    });
  }

  /**
   * Pauses the bot's mood for a specified duration.
   * @param durationMs - The pause duration in milliseconds.
   */
  public pauseMood(durationMs: number): void {
    this.state.moodPauseUntil = Date.now() + durationMs;
    const value = String(this.state.moodPauseUntil);
    this._enqueueWrite(
      this.stmtUpsertKV ? () => this.stmtUpsertKV!.run('moodPauseUntil', value) : undefined
    );
    this.emit('moodPaused', this.state.moodPauseUntil);
  }

  /**
   * Adds a trade result (win/loss) to the history.
   * @param isWin - Whether the trade was a win.
   */
  public addTradeResult(isWin: boolean): void {
    this.state.tradeHistory.push(isWin);
    if (this.state.tradeHistory.length > 50) {
      this.state.tradeHistory.shift();
    }
    const payload = safeJsonStringify(this.state.tradeHistory);
    this._enqueueWrite(
      this.stmtUpsertKV ? () => this.stmtUpsertKV!.run('tradeHistory', payload) : undefined
    );
    this.emit('tradeResultAdded', isWin);
  }

  /**
   * Starts a cool-down period for a mint.
   * @param mint - The token mint address.
   * @param pUsd - The last exit price in USD.
   * @param expiresAt - Expiration timestamp in milliseconds.
   */
  public startCoolDown(mint: string, pUsd: number, expiresAt: number): void {
    const data = { expiresAt, lastExitPriceUsd: pUsd };
    this.state.coolDownMints.set(mint, data);
    const payload = safeJsonStringify(data);
    this._enqueueWrite(
      this.stmtUpsertCooldown ? () => this.stmtUpsertCooldown!.run(mint, payload) : undefined
    );
    this.emit('coolDownStarted', { mint, expiresAt });
  }

  /**
   * Updates a market snapshot for a mint.
   * @param mint - The token mint address.
   * @param snapshot - The snapshot object.
   */
  public updateMarketSnapshot(mint: string, snapshot: MarketSnapshot): void {
    this.state.marketSnapshots.set(mint, snapshot);
    const payload = safeJsonStringify(snapshot);
    this._enqueueWrite(
      this.stmtUpsertSnapshot ? () => this.stmtUpsertSnapshot!.run(mint, payload) : undefined
    );
    this.emit('marketSnapshotUpdated', { mint, snapshot });
  }

  /**
   * Calculates the Global Momentum Index (GMI) based on the success rate of the last 100 launches.
   * Success is defined as hitting a 1.5x multiple from the first seen price.
   * @returns The GMI as a ratio (0-1).
   */
  public calculateGMI(): number {
    const history = this.state.launchHistory || [];
    if (history.length < 10) return 0.5; // Neutral default
    const successes = history.filter((l) => l.isSuccess).length;
    return successes / history.length;
  }

  /**
   * Updates the launch history with new data and calculates successes.
   * @param launches - Array of recent token launches.
   */
  public updateLaunchHistory(launches: TokenMetadata[]): void {
    const now = Date.now();
    const historyMap = new Map<string, LaunchHistoryEntry>(
      this.state.launchHistory.map((l) => [l.mint, l])
    );

    for (const token of launches) {
      if (!token.id) continue;
      const p = Number(token.usdPrice || 0);
      if (!(p > 0)) continue;

      const existingEntry = historyMap.get(token.id);
      if (!existingEntry) {
        const newEntry: LaunchHistoryEntry = {
          mint: token.id,
          firstSeenPrice: p,
          highestSeenPrice: p,
          isSuccess: false,
          timestamp: now,
        };
        this.state.launchHistory.push(newEntry);
        const payload = safeJsonStringify(newEntry);
        this._enqueueWrite(
          this.stmtUpsertLaunch
            ? () => this.stmtUpsertLaunch!.run(newEntry.mint, newEntry.timestamp, payload)
            : undefined
        );
        historyMap.set(token.id, newEntry);
      } else {
        existingEntry.highestSeenPrice = Math.max(existingEntry.highestSeenPrice, p);
        if (
          !existingEntry.isSuccess &&
          existingEntry.highestSeenPrice >= existingEntry.firstSeenPrice * 1.5
        ) {
          existingEntry.isSuccess = true;
        }
        const payload = safeJsonStringify(existingEntry);
        this._enqueueWrite(
          this.stmtUpsertLaunch
            ? () => this.stmtUpsertLaunch!.run(existingEntry.mint, existingEntry.timestamp, payload)
            : undefined
        );
      }
    }

    // Cap at 100 most recent launches in memory
    if (this.state.launchHistory.length > 100) {
      this.state.launchHistory = this.state.launchHistory.slice(-100);
    }
    this.emit('launchHistoryUpdated', this.state.launchHistory);
  }

  /**
   * Upserts a recheck entry into the state.
   * @param entry - The recheck entry object.
   */
  public upsertRecheckEntry(entry: RecheckItem): void {
    if (entry.scheduledTime && !entry.nextEligibleAt) {
      entry.nextEligibleAt = new Date(entry.scheduledTime).toISOString();
    }
    this.state.pendingCandidateRechecks.set(entry.mint, entry);
    const payload = safeJsonStringify(entry);
    this._enqueueWrite(
      this.stmtUpsertRecheck ? () => this.stmtUpsertRecheck!.run(entry.mint, payload) : undefined
    );
    this.emit('recheckEntryUpserted', entry);
  }

  /**
   * Removes a recheck entry from the state.
   * @param mint - The token mint address.
   */
  public removeRecheckEntry(mint: string): void {
    if (this.state.pendingCandidateRechecks.delete(mint)) {
      this._enqueueWrite(
        this.stmtRemoveRecheck ? () => this.stmtRemoveRecheck!.run(mint) : undefined
      );
      this.emit('recheckEntryRemoved', mint);
    }
  }

  /**
   * Removes a cool-down entry.
   * @param mint - The token mint address.
   */
  public removeCoolDown(mint: string): void {
    if (this.state.coolDownMints.delete(mint)) {
      this._enqueueWrite(
        this.stmtRemoveCooldown ? () => this.stmtRemoveCooldown!.run(mint) : undefined
      );
      this.emit('coolDownRemoved', mint);
    }
  }

  /**
   * Retires a mint from active trading.
   * @param mint - The token mint address.
   * @param data - Metadata for the retirement.
   */
  public retireMint(mint: string, data: RetiredMintEntry): void {
    this.state.retiredMints.set(mint, data);
    const payload = safeJsonStringify(data);
    this._enqueueWrite(
      this.stmtUpsertRetired ? () => this.stmtUpsertRetired!.run(mint, payload) : undefined
    );
    this.emit('mintRetired', { mint, data });
  }

  /**
   * Unretires a mint.
   * @param mint - The token mint address.
   */
  public unretireMint(mint: string): void {
    if (this.state.retiredMints.delete(mint)) {
      this._enqueueWrite(
        this.stmtRemoveRetired ? () => this.stmtRemoveRetired!.run(mint) : undefined
      );
      this.emit('mintUnretired', mint);
    }
  }

  /**
   * Removes a market snapshot.
   * @param mint - The token mint address.
   */
  public removeMarketSnapshot(mint: string): void {
    if (this.state.marketSnapshots.delete(mint)) {
      this._enqueueWrite(
        this.stmtRemoveSnapshot ? () => this.stmtRemoveSnapshot!.run(mint) : undefined
      );
      this.emit('marketSnapshotRemoved', mint);
    }
  }

  /**
   * Flushes any pending state to the database (dummy for backward compatibility).
   * @param _options - Optional persistence options.
   */
  public async flush(_options?: { sync?: boolean; force?: boolean }): Promise<void> {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    await this._flushQueuedWrites();
    if (this._shutdownRequested) {
      this._sqlite?.close();
      this._sqlite = null;
    }
  }

  /**
   * Persists the state to the database (dummy for backward compatibility).
   * @param _options - Optional persistence options.
   */
  public async persist(options?: { sync?: boolean; force?: boolean }): Promise<void> {
    if (options?.force || options?.sync) {
      await this.flush(options);
    }
  }

  /**
   * Signals that the store should prepare for shutdown.
   */
  public requestShutdown(): void {
    this._shutdownRequested = true;
  }
}
