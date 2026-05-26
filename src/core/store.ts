import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile, safeJsonStringify, log } from './utils.js';
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
} from '../types/index.js';

/**
 * StateStore manages the bot's runtime state, metrics, and persistence.
 * It extends EventEmitter to provide a reactive interface for state changes.
 */
export class StateStore extends EventEmitter {
  public config: Config;
  public state: State;
  private _persistTimer: NodeJS.Timeout | null = null;
  private _mintsPersistTimer: NodeJS.Timeout | null = null;
  private _persistencePromise: Promise<void> = Promise.resolve();
  private _shutdownRequested = false;
  private _mintsChanged = false;

  constructor(config: Config) {
    super();
    this.config = config;
    this.state = this._getDefaultState();

    // Derived paths for incremental persistence
    if (this.config.stateFile) {
      this.config.mintsFile = this.config.stateFile.replace(/\.json$/, '_mints.json');
    }
  }

  private _getDefaultState(): State {
    return {
      processedMintQueue: [],
      processedMints: new Set<string>(),
      pendingCandidateRechecks: new Map<string, RecheckItem>(),
      positions: new Map<string, Position>(),
      marketSnapshots: new Map<string, MarketSnapshot>(),
      launchHistory: [],
      paperSolBalanceLamports: this.config?.initialPaperSolLamports?.toString() || '1000000000',
      tradeHistory: [],
      moodPauseUntil: null,
      coolDownMints: new Map<string, CoolDownEntry>(),
      retiredMints: new Map<string, any>(),
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
    };
  }

  /**
   * Loads the state from disk.
   * @param stateFile - Path to the state file.
   */
  public load(stateFile: string): void {
    if (!stateFile) return;
    const resolvedPath = path.resolve(stateFile);
    const resolvedMintsPath = path.resolve(this.config.mintsFile || '');

    // 1. Load Main State
    if (fs.existsSync(resolvedPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));

        const rechecks = Array.isArray(parsed.pendingCandidateRechecks)
          ? parsed.pendingCandidateRechecks
          : [];
        this.state.pendingCandidateRechecks = new Map(
          rechecks.filter((e: RecheckItem) => e?.mint).map((e: RecheckItem) => [e.mint, e])
        );

        const positions = Array.isArray(parsed.positions) ? parsed.positions : [];
        this.state.positions = new Map(positions.map((p: Position) => [p.mint, p]));

        this.state.launchHistory = Array.isArray(parsed.launchHistory) ? parsed.launchHistory : [];
        this.state.paperSolBalanceLamports =
          parsed.paperSolBalanceLamports ?? this.config.initialPaperSolLamports?.toString();
        this.state.tradeHistory = Array.isArray(parsed.tradeHistory) ? parsed.tradeHistory : [];
        this.state.moodPauseUntil = parsed.moodPauseUntil || null;
        this.state.coolDownMints = new Map(Object.entries(parsed.coolDownMints || {}));
        this.state.retiredMints = new Map(Object.entries(parsed.retiredMints || {}));
        this.state.closedTrades = Array.isArray(parsed.closedTrades) ? parsed.closedTrades : [];
        this.state.metrics = { ...this.state.metrics, ...(parsed.metrics || {}) };

        log(this.config.logFile, 'Main state loaded successfully.', 'info');
      } catch (error: any) {
        log(this.config.logFile, `Failed to load main state: ${error.message}`, 'warn');
      }
    }

    // 2. Load Processed Mints (Legacy fallback to main state if mintsFile doesn't exist)
    if (fs.existsSync(resolvedMintsPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(resolvedMintsPath, 'utf8'));
        this.state.processedMintQueue = Array.isArray(parsed.processedMintQueue)
          ? parsed.processedMintQueue
          : [];
        this.state.processedMints = new Set(this.state.processedMintQueue);
        log(
          this.config.logFile,
          `Loaded ${this.state.processedMints.size} processed mints from dedicated file.`,
          'info'
        );
      } catch (error: any) {
        log(this.config.logFile, `Failed to load mints state: ${error.message}`, 'warn');
      }
    } else if (fs.existsSync(resolvedPath)) {
      // Fallback for first run after refactor: check if they were in the main state
      try {
        const parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
        if (Array.isArray(parsed.processedMintQueue)) {
          this.state.processedMintQueue = parsed.processedMintQueue;
          this.state.processedMints = new Set(this.state.processedMintQueue);
          log(
            this.config.logFile,
            `Loaded ${this.state.processedMints.size} processed mints from main state fallback.`,
            'info'
          );
        }
      } catch {}
    }
  }

  /**
   * Schedules an atomic persistence of the current state.
   * @param options - Persistence options.
   */
  public async persist(options: { force?: boolean; mints?: boolean } = {}): Promise<void> {
    if (!this.config.stateFile || (this._shutdownRequested && !options.force)) return;

    if (options.force) {
      if (this._persistTimer) clearTimeout(this._persistTimer);
      if (this._mintsPersistTimer) clearTimeout(this._mintsPersistTimer);
      return this._doPersist(true);
    }

    if (options.mints) this._mintsChanged = true;

    // Debounce main state (2s)
    if (!this._persistTimer) {
      this._persistTimer = setTimeout(() => {
        this._persistTimer = null;
        this._doPersist(false).catch(() => {});
      }, 2000);
    }

    // Debounce mints state (30s)
    if (this._mintsChanged && !this._mintsPersistTimer) {
      this._mintsPersistTimer = setTimeout(() => {
        this._mintsPersistTimer = null;
        this._doPersist(true).catch(() => {});
      }, 30000);
    }
  }

  private async _doPersist(includeMints = false): Promise<void> {
    this._persistencePromise = this._persistencePromise.then(async () => {
      // 1. Persist Main State
      const mainPayload = {
        pendingCandidateRechecks: Array.from(this.state.pendingCandidateRechecks.values()),
        positions: Array.from(this.state.positions.values()),
        launchHistory: this.state.launchHistory,
        paperSolBalanceLamports: this.state.paperSolBalanceLamports,
        tradeHistory: this.state.tradeHistory,
        moodPauseUntil: this.state.moodPauseUntil,
        coolDownMints: Object.fromEntries(this.state.coolDownMints),
        retiredMints: Object.fromEntries(this.state.retiredMints),
        closedTrades: this.state.closedTrades,
        metrics: this.state.metrics,
      };

      try {
        await atomicWriteFile(this.config.stateFile, safeJsonStringify(mainPayload, 2));
        if (this.config.metricsFile) {
          await atomicWriteFile(this.config.metricsFile, safeJsonStringify(this.state.metrics, 2));
        }
      } catch (err: any) {
        log(this.config.logFile, `Main persistence failed: ${err.message}`, 'error');
      }

      // 2. Persist Mints State (Lazily)
      if (includeMints && this._mintsChanged && this.config.mintsFile) {
        const mintsPayload = { processedMintQueue: this.state.processedMintQueue };
        try {
          await atomicWriteFile(this.config.mintsFile, safeJsonStringify(mintsPayload));
          this._mintsChanged = false;
        } catch (err: any) {
          log(this.config.logFile, `Mints persistence failed: ${err.message}`, 'error');
        }
      }
    });

    return this._persistencePromise;
  }

  /**
   * Tracks a mint as processed.
   * @param mint - The token mint address.
   */
  public trackMint(mint: string): void {
    if (this.state.processedMints.has(mint)) return;

    this.state.pendingCandidateRechecks.delete(mint);
    this.state.processedMints.add(mint);
    this.state.processedMintQueue.push(mint);

    const MAX_TRACKED = 5000;
    while (this.state.processedMintQueue.length > MAX_TRACKED) {
      const removed = this.state.processedMintQueue.shift();
      if (removed) this.state.processedMints.delete(removed);
    }

    this.emit('mintTracked', mint);
    this.persist({ mints: true });
  }

  /**
   * Untracks a mint.
   * @param mint - The token mint address.
   */
  public untrackMint(mint: string): void {
    if (this.state.processedMints.delete(mint)) {
      this.state.processedMintQueue = this.state.processedMintQueue.filter((m) => m !== mint);
      this.emit('mintUntracked', mint);
      this.persist({ mints: true });
    }
    this.state.pendingCandidateRechecks.delete(mint);
  }

  /**
   * Upserts a position into the state.
   * @param position - The position object.
   */
  public upsertPosition(position: Position): void {
    const isNew = !this.state.positions.has(position.mint);
    this.state.positions.set(position.mint, position);
    this.emit(isNew ? 'positionAdded' : 'positionUpdated', position);
    this.persist();
  }

  /**
   * Removes a position from the state.
   * @param mint - The token mint address.
   */
  public removePosition(mint: string): void {
    const position = this.state.positions.get(mint);
    if (position) {
      this.state.positions.delete(mint);
      this.emit('positionRemoved', position);
      this.persist();
    }
  }

  /**
   * Increments a metric value.
   * @param key - The metric key.
   * @param amount - The amount to increment by.
   */
  public incrementMetric(key: string, amount = 1): void {
    const metrics = this.state.metrics as any;
    if (metrics[key] !== undefined) {
      metrics[key] += amount;
      this.emit('metricUpdated', { key, value: metrics[key] });
    }
  }

  /**
   * Records a rejection reason in metrics.
   * @param code - The rejection reason code.
   */
  public recordRejection(code: string): void {
    if (!code) return;
    this.state.metrics.rejectionReasons[code] =
      (this.state.metrics.rejectionReasons[code] || 0) + 1;
    this.emit('rejectionRecorded', code);
    this.persist();
  }

  /**
   * Updates the paper trading SOL balance.
   * @param amountLamports - The new balance in lamports.
   */
  public updatePaperSolBalance(amountLamports: bigint | string): void {
    this.state.paperSolBalanceLamports = amountLamports.toString();
    this.emit('paperSolBalanceUpdated', this.state.paperSolBalanceLamports);
    this.persist();
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
    this.emit('tradeClosed', trade);
    this.persist();
  }

  /**
   * Increments an exit reason metric.
   * @param reason - The exit reason code.
   */
  public incrementExitReason(reason: string): void {
    if (!reason) return;
    this.state.metrics.exitReasonCounts[reason] =
      (this.state.metrics.exitReasonCounts[reason] || 0) + 1;
    this.emit('exitReasonIncremented', {
      reason,
      count: this.state.metrics.exitReasonCounts[reason],
    });
    this.persist();
  }

  /**
   * Pauses the bot's mood for a specified duration.
   * @param durationMs - The pause duration in milliseconds.
   */
  public pauseMood(durationMs: number): void {
    this.state.moodPauseUntil = Date.now() + durationMs;
    this.emit('moodPaused', this.state.moodPauseUntil);
    this.persist();
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
    this.emit('tradeResultAdded', isWin);
    this.persist();
  }

  /**
   * Starts a cool-down period for a mint.
   * @param mint - The token mint address.
   * @param pUsd - The last exit price in USD.
   * @param expiresAt - Expiration timestamp in milliseconds.
   */
  public startCoolDown(mint: string, pUsd: number, expiresAt: number): void {
    this.state.coolDownMints.set(mint, { expiresAt, lastExitPriceUsd: pUsd });
    this.emit('coolDownStarted', { mint, expiresAt });
    this.persist();
  }

  /**
   * Updates a market snapshot for a mint.
   * @param mint - The token mint address.
   * @param snapshot - The snapshot object.
   */
  public updateMarketSnapshot(mint: string, snapshot: MarketSnapshot): void {
    this.state.marketSnapshots.set(mint, snapshot);
    this.emit('marketSnapshotUpdated', { mint, snapshot });
    this.persist();
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
    const historyMap = new Map(this.state.launchHistory.map((l) => [l.mint, l]));

    for (const token of launches) {
      if (!token.id) continue;
      const p = Number(token.usdPrice || 0);
      if (!(p > 0)) continue;

      let entry = historyMap.get(token.id);
      if (!entry) {
        entry = {
          mint: token.id,
          firstSeenPrice: p,
          highestSeenPrice: p,
          isSuccess: false,
          timestamp: now,
        };
        this.state.launchHistory.push(entry);
      } else {
        entry.highestSeenPrice = Math.max(entry.highestSeenPrice, p);
        if (!entry.isSuccess && entry.highestSeenPrice >= entry.firstSeenPrice * 1.5) {
          entry.isSuccess = true;
        }
      }
    }

    // Cap at 100 most recent launches
    if (this.state.launchHistory.length > 100) {
      this.state.launchHistory = this.state.launchHistory.slice(-100);
    }
    this.emit('launchHistoryUpdated', this.state.launchHistory);
    this.persist();
  }

  /**
   * Upserts a recheck entry into the state.
   * @param entry - The recheck entry object.
   */
  public upsertRecheckEntry(entry: RecheckItem): void {
    this.state.pendingCandidateRechecks.set(entry.mint, entry);
    this.emit('recheckEntryUpserted', entry);
    this.persist();
  }

  /**
   * Removes a recheck entry from the state.
   * @param mint - The token mint address.
   */
  public removeRecheckEntry(mint: string): void {
    if (this.state.pendingCandidateRechecks.delete(mint)) {
      this.emit('recheckEntryRemoved', mint);
      this.persist();
    }
  }

  /**
   * Removes a cool-down entry.
   * @param mint - The token mint address.
   */
  public removeCoolDown(mint: string): void {
    if (this.state.coolDownMints.delete(mint)) {
      this.emit('coolDownRemoved', mint);
      this.persist();
    }
  }

  /**
   * Retires a mint from active trading.
   * @param mint - The token mint address.
   * @param data - Metadata for the retirement.
   */
  public retireMint(mint: string, data: RetiredMintEntry): void {
    this.state.retiredMints.set(mint, data);
    this.emit('mintRetired', { mint, data });
    this.persist();
  }

  /**
   * Unretires a mint.
   * @param mint - The token mint address.
   */
  public unretireMint(mint: string): void {
    if (this.state.retiredMints.delete(mint)) {
      this.emit('mintUnretired', mint);
      this.persist();
    }
  }

  /**
   * Removes a market snapshot.
   * @param mint - The token mint address.
   */
  public removeMarketSnapshot(mint: string): void {
    if (this.state.marketSnapshots.delete(mint)) {
      this.emit('marketSnapshotRemoved', mint);
      this.persist();
    }
  }

  /**
   * Signals that the store should prepare for shutdown.
   */
  public requestShutdown(): void {
    this._shutdownRequested = true;
  }
}
