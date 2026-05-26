'use strict';

const EventEmitter = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteFile, safeJsonStringify, log } = require('./utils');

/**
 * StateStore manages the bot's runtime state, metrics, and persistence.
 * It extends EventEmitter to provide a reactive interface for state changes.
 */
class StateStore extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.state = this._getDefaultState();
    this._persistTimer = null;
    this._mintsPersistTimer = null;
    this._persistencePromise = Promise.resolve();
    this._shutdownRequested = false;
    this._mintsChanged = false;

    // Derived paths for incremental persistence
    if (this.config.stateFile) {
      this.config.mintsFile = this.config.stateFile.replace(/\.json$/, '_mints.json');
    }
  }

  _getDefaultState() {
    return {
      processedMintQueue: [],
      processedMints: new Set(),
      pendingCandidateRechecks: new Map(),
      positions: new Map(),
      marketSnapshots: new Map(),
      launchHistory: [],
      paperSolBalanceLamports: this.config?.initialPaperSolLamports || '1000000000',
      tradeHistory: [],
      moodPauseUntil: null,
      coolDownMints: new Map(),
      retiredMints: new Map(),
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
   * @param {string} stateFile - Path to the state file.
   */
  load(stateFile) {
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
          rechecks.filter((e) => e?.mint).map((e) => [e.mint, e])
        );

        const positions = Array.isArray(parsed.positions) ? parsed.positions : [];
        this.state.positions = new Map(positions.map((p) => [p.mint, p]));

        this.state.launchHistory = Array.isArray(parsed.launchHistory) ? parsed.launchHistory : [];
        this.state.paperSolBalanceLamports =
          parsed.paperSolBalanceLamports ?? this.config.initialPaperSolLamports;
        this.state.tradeHistory = Array.isArray(parsed.tradeHistory) ? parsed.tradeHistory : [];
        this.state.moodPauseUntil = parsed.moodPauseUntil || null;
        this.state.coolDownMints = new Map(Object.entries(parsed.coolDownMints || {}));
        this.state.retiredMints = new Map(Object.entries(parsed.retiredMints || {}));
        this.state.closedTrades = Array.isArray(parsed.closedTrades) ? parsed.closedTrades : [];
        this.state.metrics = { ...this.state.metrics, ...(parsed.metrics || {}) };

        log(this.config.logFile, 'Main state loaded successfully.', 'info');
      } catch (error) {
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
      } catch (error) {
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
   * @param {Object} [options={}] - Persistence options.
   * @param {boolean} [options.force=false] - If true, persists immediately.
   * @param {boolean} [options.mints=false] - If true, also persists the processed mints file.
   */
  async persist(options = {}) {
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

  async _doPersist(includeMints = false) {
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
      } catch (err) {
        log(this.config.logFile, `Main persistence failed: ${err.message}`, 'error');
      }

      // 2. Persist Mints State (Lazily)
      if (includeMints && this._mintsChanged && this.config.mintsFile) {
        const mintsPayload = { processedMintQueue: this.state.processedMintQueue };
        try {
          await atomicWriteFile(this.config.mintsFile, safeJsonStringify(mintsPayload));
          this._mintsChanged = false;
        } catch (err) {
          log(this.config.logFile, `Mints persistence failed: ${err.message}`, 'error');
        }
      }
    });

    return this._persistencePromise;
  }

  /**
   * Tracks a mint as processed.
   * @param {string} mint - The token mint address.
   */
  trackMint(mint) {
    if (this.state.processedMints.has(mint)) return;

    this.state.pendingCandidateRechecks.delete(mint);
    this.state.processedMints.add(mint);
    this.state.processedMintQueue.push(mint);

    const MAX_TRACKED = 5000; // From config.constants.MAX_TRACKED_MINTS
    while (this.state.processedMintQueue.length > MAX_TRACKED) {
      const removed = this.state.processedMintQueue.shift();
      if (removed) this.state.processedMints.delete(removed);
    }

    this.emit('mintTracked', mint);
    this.persist({ mints: true });
  }

  /**
   * Untracks a mint.
   * @param {string} mint - The token mint address.
   */
  untrackMint(mint) {
    if (this.state.processedMints.delete(mint)) {
      this.state.processedMintQueue = this.state.processedMintQueue.filter((m) => m !== mint);
      this.emit('mintUntracked', mint);
      this.persist({ mints: true });
    }
    this.state.pendingCandidateRechecks.delete(mint);
  }

  /**
   * Upserts a position into the state.
   * @param {Object} position - The position object.
   */
  upsertPosition(position) {
    const isNew = !this.state.positions.has(position.mint);
    this.state.positions.set(position.mint, position);
    this.emit(isNew ? 'positionAdded' : 'positionUpdated', position);
    this.persist();
  }

  /**
   * Removes a position from the state.
   * @param {string} mint - The token mint address.
   */
  removePosition(mint) {
    const position = this.state.positions.get(mint);
    if (position) {
      this.state.positions.delete(mint);
      this.emit('positionRemoved', position);
      this.persist();
    }
  }

  /**
   * Increments a metric value.
   * @param {string} key - The metric key.
   * @param {number} [amount=1] - The amount to increment by.
   */
  incrementMetric(key, amount = 1) {
    if (this.state.metrics[key] !== undefined) {
      this.state.metrics[key] += amount;
      this.emit('metricUpdated', { key, value: this.state.metrics[key] });
      this.persist();
    }
  }

  /**
   * Records a rejection reason in metrics.
   * @param {string} code - The rejection reason code.
   */
  recordRejection(code) {
    if (!code) return;
    this.state.metrics.rejectionReasons[code] =
      (this.state.metrics.rejectionReasons[code] || 0) + 1;
    this.emit('rejectionRecorded', code);
    this.persist();
  }

  /**
   * Updates the paper trading SOL balance.
   * @param {bigint|string} amountLamports - The new balance in lamports.
   */
  updatePaperSolBalance(amountLamports) {
    this.state.paperSolBalanceLamports = amountLamports.toString();
    this.emit('paperSolBalanceUpdated', this.state.paperSolBalanceLamports);
    this.persist();
  }

  /**
   * Adds a closed trade record to the history.
   * @param {Object} trade - The closed trade record.
   */
  addClosedTrade(trade) {
    this.state.closedTrades.push(trade);
    if (this.state.closedTrades.length > 500) {
      this.state.closedTrades.shift();
    }
    this.emit('tradeClosed', trade);
    this.persist();
  }

  /**
   * Increments an exit reason metric.
   * @param {string} reason - The exit reason code.
   */
  incrementExitReason(reason) {
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
   * @param {number} durationMs - The pause duration in milliseconds.
   */
  pauseMood(durationMs) {
    this.state.moodPauseUntil = Date.now() + durationMs;
    this.emit('moodPaused', this.state.moodPauseUntil);
    this.persist();
  }

  /**
   * Adds a trade result (win/loss) to the history.
   * @param {boolean} isWin - Whether the trade was a win.
   */
  addTradeResult(isWin) {
    this.state.tradeHistory.push(isWin);
    if (this.state.tradeHistory.length > 50) {
      this.state.tradeHistory.shift();
    }
    this.emit('tradeResultAdded', isWin);
    this.persist();
  }

  /**
   * Starts a cool-down period for a mint.
   * @param {string} mint - The token mint address.
   * @param {number} pUsd - The last exit price in USD.
   * @param {number} expiresAt - Expiration timestamp in milliseconds.
   */
  startCoolDown(mint, pUsd, expiresAt) {
    this.state.coolDownMints.set(mint, { expiresAt, lastExitPriceUsd: pUsd });
    this.emit('coolDownStarted', { mint, expiresAt });
    this.persist();
  }

  /**
   * Updates a market snapshot for a mint.
   * @param {string} mint - The token mint address.
   * @param {Object} snapshot - The snapshot object.
   */
  updateMarketSnapshot(mint, snapshot) {
    this.state.marketSnapshots.set(mint, snapshot);
    this.emit('marketSnapshotUpdated', { mint, snapshot });
    // snapshots are transient enough that we don't necessarily need to persist every update,
    // but the bot's architecture currently assumes they might be used after restart.
    this.persist();
  }

  /**
   * Calculates the Global Momentum Index (GMI) based on the success rate of the last 100 launches.
   * Success is defined as hitting a 1.5x multiple from the first seen price.
   * @returns {number} The GMI as a ratio (0-1).
   */
  calculateGMI() {
    const history = this.state.launchHistory || [];
    if (history.length < 10) return 0.5; // Neutral default
    const successes = history.filter((l) => l.isSuccess).length;
    return successes / history.length;
  }

  /**
   * Updates the launch history with new data and calculates successes.
   * @param {Object[]} launches - Array of recent token launches.
   */
  updateLaunchHistory(launches) {
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
   * @param {Object} entry - The recheck entry object.
   */
  upsertRecheckEntry(entry) {
    this.state.pendingCandidateRechecks.set(entry.mint, entry);
    this.emit('recheckEntryUpserted', entry);
    this.persist();
  }

  /**
   * Removes a recheck entry from the state.
   * @param {string} mint - The token mint address.
   */
  removeRecheckEntry(mint) {
    if (this.state.pendingCandidateRechecks.delete(mint)) {
      this.emit('recheckEntryRemoved', mint);
      this.persist();
    }
  }

  /**
   * Removes a cool-down entry.
   * @param {string} mint - The token mint address.
   */
  removeCoolDown(mint) {
    if (this.state.coolDownMints.delete(mint)) {
      this.emit('coolDownRemoved', mint);
      this.persist();
    }
  }

  /**
   * Retires a mint from active trading.
   * @param {string} mint - The token mint address.
   * @param {Object} data - Metadata for the retirement.
   */
  retireMint(mint, data) {
    this.state.retiredMints.set(mint, data);
    this.emit('mintRetired', { mint, data });
    this.persist();
  }

  /**
   * Unretires a mint.
   * @param {string} mint - The token mint address.
   */
  unretireMint(mint) {
    if (this.state.retiredMints.delete(mint)) {
      this.emit('mintUnretired', mint);
      this.persist();
    }
  }

  /**
   * Removes a market snapshot.
   * @param {string} mint - The token mint address.
   */
  removeMarketSnapshot(mint) {
    if (this.state.marketSnapshots.delete(mint)) {
      this.emit('marketSnapshotRemoved', mint);
      this.persist();
    }
  }

  /**
   * Signals that the store should prepare for shutdown.
   */
  requestShutdown() {
    this._shutdownRequested = true;
  }
}

module.exports = StateStore;
