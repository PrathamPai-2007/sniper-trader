'use strict';

import blessed from 'blessed';
import { Config, Context, RecheckItem, ClosedTrade, StateStore, Position } from '../types/index.js';
import { formatUsd, ratioToPercentString } from '../core/utils.js';

interface TuiText {
  setContent(content: string): void;
}

interface TuiTable {
  setData(data: (string | undefined)[][]): void;
}

interface TuiGauge {
  setPercent(percent: number): void;
}

interface TuiLog {
  log(message: string): void;
}

interface TuiStore extends StateStore {
  on(event: string, listener: (...args: any[]) => void): this;
}

/**
 * TuiService manages the Terminal User Interface (TUI) for the bot.
 * It provides a real-time dashboard showing bot status, active positions,
 * discovery feed, and performance metrics using 'blessed'.
 */
export class TuiService {
  private screen: blessed.Widgets.Screen;
  private store: TuiStore;
  private config: Config;
  private getBackpressureFactor: () => number;

  // Widgets
  private logWidget!: TuiLog;
  private positionsTable!: TuiTable;
  private discoveryFeed!: TuiTable;
  private statusBar!: TuiText;
  private gmiGauge!: TuiGauge;
  private metricsWidget!: TuiText;

  private renderThrottleTimeout: NodeJS.Timeout | null = null;
  private isEnabled = false;
  private shutdownRequested = false;

  /**
   * Initializes the TUI service and sets up widgets and key bindings.
   * @param ctx - The application context.
   */
  constructor(ctx: Context) {
    this.store = ctx.store as TuiStore;
    this.config = ctx.config;
    this.getBackpressureFactor = ctx.getBackpressureFactor || (() => 1);

    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Veloci-Buy War Room',
      autoPadding: true,
      dockBorders: false,
    });

    this._setupWidgets();
    this._setupKeyBindings();
    this._setupSubscriptions();
  }

  private createGauge(options: blessed.Widgets.BoxOptions): TuiGauge & blessed.Widgets.BoxElement {
    const widget = blessed.box({
      ...options,
      tags: true,
      content: ' 0%',
    }) as blessed.Widgets.BoxElement & TuiGauge;
    widget.setPercent = (percent: number) => {
      const clamped = Math.min(100, Math.max(0, Math.round(percent)));
      const filled = Math.round(clamped / 10);
      const bar = '█'.repeat(filled).padEnd(10, '░');
      widget.setContent(` ${bar} ${clamped}%`);
    };
    return widget;
  }

  /**
   * Sets up the dashboard layout and individual widgets.
   * @private
   */
  private _setupWidgets(): void {
    // Status Bar (Top)
    this.statusBar = blessed.text({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: 1,
      content: ' Initializing...',
      tags: true,
      style: { fg: 'white', bg: 'blue' },
    }) as blessed.Widgets.TextElement & TuiText;

    // Active Positions Table
    this.positionsTable = blessed.listtable({
      parent: this.screen,
      top: 1,
      left: 0,
      width: '50%',
      height: '42%',
      keys: true,
      interactive: true,
      label: ' Positions ',
      tags: true,
      border: { type: 'line' },
      style: {
        fg: 'white',
        border: { fg: 'cyan' },
        selected: { fg: 'white', bg: 'blue' },
        header: { fg: 'cyan', bold: true },
      },
    }) as blessed.Widgets.ListTableElement & TuiTable;

    // Discovery Feed
    this.discoveryFeed = blessed.listtable({
      parent: this.screen,
      top: 1,
      left: '50%',
      width: '30%',
      height: '42%',
      label: ' Discovery ',
      tags: true,
      border: { type: 'line' },
      style: {
        fg: 'white',
        border: { fg: 'yellow' },
        header: { fg: 'yellow', bold: true },
      },
    }) as blessed.Widgets.ListTableElement & TuiTable;

    // GMI Sparkline / Gauge
    this.gmiGauge = this.createGauge({
      parent: this.screen,
      top: 1,
      left: '80%',
      width: '20%',
      height: '25%-1',
      label: ' GMI Momentum ',
      border: { type: 'line' },
      style: { fg: 'green', border: { fg: 'green' } },
    }) as TuiGauge;

    // Metrics / Win Rate
    this.metricsWidget = blessed.text({
      parent: this.screen,
      top: '26%',
      left: '80%',
      width: '20%',
      height: '17%',
      label: ' Stats ',
      border: { type: 'line' },
      tags: true,
      style: { border: { fg: 'magenta' } },
    }) as blessed.Widgets.TextElement & TuiText;

    // System Logs
    this.logWidget = blessed.log({
      parent: this.screen,
      top: '43%',
      left: 0,
      width: '100%',
      height: '49%',
      label: ' System Logs ',
      border: { type: 'line' },
      wrap: true,
      tags: true,
      scrollback: 200,
      style: { fg: 'green', border: { fg: 'white' } },
    }) as blessed.Widgets.Log & TuiLog;

    // Footer Bar
    blessed.text({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 1,
      content: ' [Q] Quit | [R] Refresh | [S] Panic (Close All & Exit)',
      tags: true,
      style: { fg: 'black', bg: 'white' },
    });

    this.screen.render();
  }

  /**
   * Defines global keyboard shortcuts for the TUI.
   * @private
   */
  private _setupKeyBindings(): void {
    this.screen.key(['q', 'C-c'], () => {
      this._requestShutdown('SIGINT');
    });

    this.screen.key(['r'], () => {
      this.refresh();
    });

    this.screen.key(['s'], () => {
      this.log('!!! PANIC SIGNAL RECEIVED !!!', 'error');
      this.log('Closing all positions and shutting down...', 'warn');
      this._requestShutdown('SIGINT');
    });
  }

  /**
   * Requests the same graceful shutdown path as an OS signal.
   * @private
   */
  private _requestShutdown(signal: NodeJS.Signals): void {
    if (this.shutdownRequested) return;
    this.shutdownRequested = true;
    process.emit(signal);
  }

  /**
   * Subscribes to store events to trigger UI updates.
   * @private
   */
  private _setupSubscriptions(): void {
    const events = [
      'positionAdded',
      'positionUpdated',
      'positionRemoved',
      'metricUpdated',
      'paperSolBalanceUpdated',
      'launchHistoryUpdated',
      'tradeClosed',
      'tradeResultAdded',
      'recheckEntryUpserted',
      'recheckEntryRemoved',
    ];
    for (const event of events) {
      this.store.on(event, () => this.scheduleRender());
    }
  }

  /**
   * Enables the TUI and performs an initial refresh.
   */
  public enable(): void {
    this.isEnabled = true;
    this.refresh();
  }

  /**
   * Disables the TUI and releases terminal resources.
   */
  public disable(): void {
    this.isEnabled = false;
    if (this.renderThrottleTimeout) {
      clearTimeout(this.renderThrottleTimeout);
      this.renderThrottleTimeout = null;
    }
    if (this.screen) {
      this.screen.destroy();
    }
    process.stdin.pause();
  }

  /**
   * Appends a log message to the log widget.
   * @param message - The log message.
   * @param level - The log level (info, warn, error, trade, debug).
   */
  public log(message: string, level: string = 'info'): void {
    if (!this.isEnabled) return;
    const color =
      (
        {
          info: '{white-fg}',
          warn: '{yellow-fg}',
          error: '{red-fg}',
          trade: '{green-fg}',
          debug: '{grey-fg}',
        } as Record<string, string>
      )[level] || '{white-fg}';

    this.logWidget.log(`${color}${message}{/}`);
  }

  /**
   * Schedules a dashboard render, throttled to prevent excessive CPU usage.
   * Max 5 FPS (200ms throttle).
   */
  public scheduleRender(): void {
    if (this.renderThrottleTimeout || !this.isEnabled) return;
    this.renderThrottleTimeout = setTimeout(() => {
      this.renderThrottleTimeout = null;
      this.refresh();
    }, 200);
  }

  /**
   * Refreshes all widgets with the latest state and renders the screen.
   * @param backpressureFactor - Optional override for the backpressure indicator.
   */
  public refresh(backpressureFactor?: number): void {
    if (!this.isEnabled) return;

    try {
      const bp =
        backpressureFactor !== undefined ? backpressureFactor : this.getBackpressureFactor();
      this._updateStatusBar(bp);
      this._updatePositionsTable();
      this._updateDiscoveryFeed();
      this._updateGmi();
      this._updateMetrics();

      this.screen.render();
    } catch (err: unknown) {
      // Prevent TUI errors from crashing the bot
      if (!(global as { __TEST__?: boolean }).__TEST__) {
        console.error('TUI Refresh Error:', err);
      }
    }
  }

  /**
   * Updates the top status bar with bot mode, GMI, and balance.
   * @private
   */
  private _updateStatusBar(backpressureFactor: number): void {
    const mode = this.config.paperTrading ? 'PAPER' : this.config.dryRun ? 'DRY-RUN' : 'LIVE';
    const balance = this.store.state.paperSolBalanceLamports;
    const solBalance = (Number(balance) / 1e9).toFixed(2);
    const gmi = this.store.calculateGMI().toFixed(2);

    const bpColor = backpressureFactor < 1 ? '{red-fg}' : '{green-fg}';
    const bpPercent = (backpressureFactor * 100).toFixed(0);
    const bpText = `${bpColor}${bpPercent}%{/}`;

    this.statusBar.setContent(
      ` {bold}Bot Status:{/bold} [RUNNING] | {bold}Mode:{/bold} [${mode}] | {bold}GMI:{/bold} ${gmi} | {bold}BAL:{/bold} ${solBalance} SOL | {bold}BP:{/bold} ${bpText}`
    );
  }

  /**
   * Updates the active positions table.
   * @private
   */
  private _updatePositionsTable(): void {
    const positions = Array.from(this.store.state.positions.values()) as Position[];
    const data = positions.map((p) => {
      const currentPrice = p.lastKnownPriceUsd || 0;
      const entryPrice = p.entryPriceUsd || 0;
      const pnlPct = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;
      const pnlColor = pnlPct >= 0 ? '{green-fg}' : '{red-fg}';

      return [
        p.symbol,
        formatUsd(entryPrice),
        formatUsd(currentPrice),
        `${pnlColor}${pnlPct.toFixed(2)}%{/}`,
        p.targetsHit?.toString() || '0',
      ];
    });

    this.positionsTable.setData([['Symbol', 'Entry', 'Current', 'PnL%', 'TPs'], ...data]);
  }

  /**
   * Updates the discovery feed showing pending candidate audits.
   * @private
   */
  private _updateDiscoveryFeed(): void {
    const candidates = Array.from(
      this.store.state.pendingCandidateRechecks.values() as IterableIterator<RecheckItem>
    )
      .slice(0, 10)
      .map((c: RecheckItem) => {
        const score = c.candidateScore || 0;
        const status = c.isFinalAudit ? 'Auditing' : c.isSurvivalWait ? 'Survival' : 'Waiting';
        return [c.tokenSnapshot?.symbol || '?', score.toString(), c.mint.slice(0, 8), status];
      });

    this.discoveryFeed.setData([['Symbol', 'Score', 'Mint', 'Status'], ...candidates]);
  }

  /**
   * Updates the Global Momentum Index (GMI) gauge.
   * @private
   */
  private _updateGmi(): void {
    const gmi = this.store.calculateGMI();
    this.gmiGauge.setPercent(Math.min(100, Math.max(0, Math.round(gmi * 100))));
  }

  /**
   * Updates the statistics widget with win rate, profit factor, and trade history.
   * @private
   */
  private _updateMetrics(): void {
    const state = this.store.state;
    const closed = state.closedTrades as ClosedTrade[];

    // Win rate based on all closed trades in current session history
    const totalTrades = closed.length;
    const wins = closed.filter((t) => t.realizedPnlUsd > 0).length;
    const winRate = totalTrades > 0 ? wins / totalTrades : 0;

    // Profit Factor: sum of gains / sum of absolute losses
    let totalGains = 0;
    let totalLosses = 0;
    for (const t of closed) {
      if (t.realizedPnlUsd > 0) totalGains += t.realizedPnlUsd;
      else totalLosses += Math.abs(t.realizedPnlUsd);
    }
    const profitFactor = totalLosses > 0 ? (totalGains / totalLosses).toFixed(2) : 'N/A';

    // Last 20 trade results sparkline-style
    const history = (state.tradeHistory as boolean[])
      .slice(-20)
      .map((win: boolean) => (win ? '{green-fg}W{/}' : '{red-fg}L{/}'))
      .join('');

    const content =
      ` Win Rate: {bold}${ratioToPercentString(winRate)}{/bold} (${wins}/${totalTrades})\n` +
      ` Profit Factor: {bold}${profitFactor}{/bold}\n` +
      ` Session PnL: {bold}${formatUsd(totalGains - totalLosses)}{/bold}\n` +
      ` Last 20: ${history}`;

    this.metricsWidget.setContent(content);
  }
}
