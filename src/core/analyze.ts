'use strict';

import fs from 'node:fs';
import path from 'node:path';

/**
 * Interface for the reconstructed trade used in analysis.
 */
export interface AnalyzerTrade {
  sessionDir: string;
  mint: string;
  symbol: string;
  entryPriceUsd: number;
  entryUsdValue: number;
  entryScore: number;
  tpProfile: any;
  takeProfitMultiples: number[] | null;
  takeProfitFractions: number[] | null;
  trailingStopDrawdownPctResolved: number;
  maxHoldMinutesResolved: number;
  volatilityScaler: number;
  entryLiquidityUsd: number;
  launchpad: string | null;
  targetsHit: number;
  initialBuyAmountSol: number | null;
  highestPriceUsd: number;
  openedAt: string | null;
  closedAt: string | null;
  events: Array<{
    event: string;
    priceUsd: number;
    tokenAmount: any;
    proceedsUsd: number;
    realizedPnlUsd: number;
    reason: string | null;
    timestamp: string;
  }>;
  totalRealizedPnlUsd: number;
  totalProceedsUsd: number;
  actualExitReason: string | null;
  actualExitPrice: number;
  holdSeconds: number;
}

/**
 * Parameters for the trade replay simulation.
 */
export interface ReplayParams {
  stopLossPct: number;
  trailingDrawdownPct: number;
  takeProfitMultiples: number[];
  takeProfitFraction: number;
  earlyPerformanceDropPct: number;
  earlyPerformanceSellPct: number;
  maxHoldMinutes: number;
}

/**
 * Result of a single trade replay simulation.
 */
export interface ReplayResult {
  pnl: number;
  roi: number;
  exitReason: string;
  exitTime: number;
  targetsHit: number;
  totalProceeds: number;
}

/**
 * Aggregated results for a specific parameter combination.
 */
export interface AnalysisResult {
  params: ReplayParams;
  totalPnl: number;
  winRate: number;
  avgPnl: number;
  maxLoss: number;
  profitFactor: number | string;
  trades: number;
}

// ---------------------------------------------------------------------------
// 1. Data ingestion
// ---------------------------------------------------------------------------

function findSessionDirs(baseDir: string): string[] {
  const logsDir = path.join(baseDir, 'logs', 'paper-trading');
  if (!fs.existsSync(logsDir)) return [];
  return fs
    .readdirSync(logsDir)
    .filter((d) => fs.statSync(path.join(logsDir, d)).isDirectory())
    .sort()
    .map((d) => path.join(logsDir, d));
}

function readJson(filePath: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readJsonl(filePath: string): any[] {
  try {
    const content = fs.readFileSync(filePath, 'utf8').trim();
    if (!content) return [];
    return content
      .split('\n')
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function ingestSessions(baseDir: string): { trades: AnalyzerTrade[]; metrics: any[] } {
  const sessions = findSessionDirs(baseDir);
  const allTrades: AnalyzerTrade[] = [];
  const allMetrics: any[] = [];

  for (const sessionDir of sessions) {
    const journal = readJsonl(path.join(sessionDir, 'paper-trade-journal.jsonl'));
    const journalOld = readJsonl(path.join(sessionDir, 'paper-trade-journal.json'));
    const tradeHistory = readJsonl(path.join(sessionDir, 'trade-journal.jsonl'));
    const metrics = readJson(path.join(sessionDir, 'metrics.json'));

    if (metrics) {
      allMetrics.push({ sessionDir: path.basename(sessionDir), ...metrics });
    }

    const eventsByMint = new Map<string, any[]>();
    for (const ev of [...journal, ...journalOld]) {
      if (!ev.mint) continue;
      if (!eventsByMint.has(ev.mint)) eventsByMint.set(ev.mint, []);
      eventsByMint.get(ev.mint)!.push(ev);
    }

    const tradeByMint = new Map<string, any>();
    for (const t of tradeHistory) {
      if (t.mint) tradeByMint.set(t.mint, t);
    }

    for (const [mint, events] of eventsByMint) {
      const buyEvent = events.find((e) => e.event === 'buy');
      const closeEvent = events.find((e) => e.event === 'close');
      if (!buyEvent) continue;

      const tradeMeta = tradeByMint.get(mint) || {};

      const trade: AnalyzerTrade = {
        sessionDir: path.basename(sessionDir),
        mint: mint,
        symbol: buyEvent.symbol || tradeMeta.symbol || 'UNKNOWN',
        entryPriceUsd: Number(buyEvent.priceUsd || tradeMeta.entryPriceUsd || 0),
        entryUsdValue: Number(tradeMeta.entryUsdValue || 0),
        entryScore: Number(tradeMeta.entryScore || 0),
        tpProfile: tradeMeta.tpProfile || null,
        takeProfitMultiples: tradeMeta.takeProfitMultiples || null,
        takeProfitFractions: tradeMeta.takeProfitFractions || null,
        trailingStopDrawdownPctResolved: Number(tradeMeta.trailingStopDrawdownPctResolved || 0.2),
        maxHoldMinutesResolved: Number(tradeMeta.maxHoldMinutesResolved || 20),
        volatilityScaler: Number(tradeMeta.volatilityScaler || 0),
        entryLiquidityUsd: Number(tradeMeta.entryLiquidityUsd || 0),
        launchpad: tradeMeta.launchpad || null,
        targetsHit: Number(tradeMeta.targetsHit || 0),
        initialBuyAmountSol: tradeMeta.initialBuyAmountSol || null,
        highestPriceUsd: Number(tradeMeta.highestPriceUsd || buyEvent.priceUsd || 0),
        openedAt: buyEvent.timestamp || tradeMeta.openedAt || null,
        closedAt: closeEvent?.timestamp || tradeMeta.closedAt || null,
        events: events.map((e) => ({
          event: e.event,
          priceUsd: Number(e.priceUsd || 0),
          tokenAmount: e.tokenAmount,
          proceedsUsd: Number(e.proceedsUsd || 0),
          realizedPnlUsd: Number(e.realizedPnlUsd || 0),
          reason: e.reason || null,
          timestamp: e.timestamp,
        })),
        totalRealizedPnlUsd: Number(tradeMeta.realizedPnlUsd || closeEvent?.realizedPnlUsd || 0),
        totalProceedsUsd: Number(tradeMeta.realizedProceedsUsd || closeEvent?.proceedsUsd || 0),
        actualExitReason: closeEvent?.reason || tradeMeta.exitReason || null,
        actualExitPrice: Number(closeEvent?.priceUsd || 0),
        holdSeconds: tradeMeta.holdSeconds
          ? Number(tradeMeta.holdSeconds)
          : closeEvent?.timestamp && buyEvent.timestamp
            ? Math.max(
                0,
                (new Date(closeEvent.timestamp).getTime() -
                  new Date(buyEvent.timestamp).getTime()) /
                  1000
              )
            : 0,
      };

      for (const ev of trade.events) {
        if (ev.priceUsd > trade.highestPriceUsd) trade.highestPriceUsd = ev.priceUsd;
      }

      allTrades.push(trade);
    }
  }

  return { trades: allTrades, metrics: allMetrics };
}

// ---------------------------------------------------------------------------
// 2. Price path inference
// ---------------------------------------------------------------------------

export function inferPricePath(
  trade: AnalyzerTrade,
  numPoints: number = 20
): Array<{ time: number; price: number }> {
  const entryP = trade.entryPriceUsd;
  const highestP = Math.max(trade.highestPriceUsd, entryP);
  const exitP = trade.actualExitPrice || entryP;
  const holdSec = Math.max(1, trade.holdSeconds || 1);

  const peakRatio = 0.4;
  const peakTime = holdSec * peakRatio;

  const points = [];
  const steps = numPoints;

  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * holdSec;
    let price;
    if (t <= peakTime) {
      const frac = peakTime > 0 ? t / peakTime : 0;
      price = entryP + (highestP - entryP) * frac;
    } else {
      const frac = holdSec > peakTime ? (t - peakTime) / (holdSec - peakTime) : 0;
      price = highestP + (exitP - highestP) * frac;
    }
    points.push({ time: t, price: Math.max(price, 0.000001) });
  }

  return points;
}

// ---------------------------------------------------------------------------
// 3. Replay engine
// ---------------------------------------------------------------------------

export function replayTrade(trade: AnalyzerTrade, params: ReplayParams): ReplayResult | null {
  const pricePath = inferPricePath(trade);
  if (pricePath.length < 2) return null;

  const entryP = trade.entryPriceUsd;
  const entryValue = trade.entryUsdValue;
  const holdSec = trade.holdSeconds || 1;

  let remainingTokens = 1.0;
  let totalProceeds = 0;
  const originalCost = entryValue;
  let trailingArmed = false;
  let highestSeen = entryP;
  let targetsHit = 0;
  let exitReason = 'none';
  let exitTime = holdSec;

  const tpMultiples = params.takeProfitMultiples;
  const tpFraction = params.takeProfitFraction;
  const slPct = params.stopLossPct;
  const trailingPct = params.trailingDrawdownPct;
  const earlyGuardSec = 15;
  const earlyDropPct = params.earlyPerformanceDropPct / 100;
  const earlySellPct = params.earlyPerformanceSellPct / 100;
  const maxHoldMin = params.maxHoldMinutes;
  const timeExitMinMultiple = 1.25;

  const activationMultiple = 1 + 0.5 * ((tpMultiples[0] || 1) - 1);
  const activationPrice = entryP * Math.min(activationMultiple, 1.12);

  for (let i = 0; i < pricePath.length; i++) {
    const point = pricePath[i];
    if (!point) continue;
    const p = point.price;
    const t = point.time;
    if (remainingTokens <= 0.001) break;

    highestSeen = Math.max(highestSeen, p);

    if (t <= earlyGuardSec && targetsHit === 0) {
      const drop = (entryP - p) / entryP;
      if (drop > earlyDropPct) {
        const soldFraction = Math.min(earlySellPct, remainingTokens);
        totalProceeds += originalCost * soldFraction * (p / entryP);
        remainingTokens -= soldFraction;
        exitReason = 'early-performance-guard';
        exitTime = t;
        if (remainingTokens <= 0.001) break;
      }
    }

    const slPrice = entryP * (1 - slPct);
    if (p <= slPrice) {
      totalProceeds += originalCost * remainingTokens * (p / entryP);
      remainingTokens = 0;
      exitReason = 'stop-loss';
      exitTime = t;
      break;
    }

    while (targetsHit < tpMultiples.length) {
      const targetP = entryP * (tpMultiples[targetsHit] || 1);
      if (p >= targetP && remainingTokens > 0.001) {
        const sellFraction = Math.min(tpFraction, remainingTokens);
        totalProceeds += originalCost * sellFraction * (p / entryP);
        remainingTokens -= sellFraction;
        targetsHit++;
        exitReason = `take-profit-${tpMultiples[targetsHit - 1]}x`;
        exitTime = t;
      } else {
        break;
      }
    }

    if (!trailingArmed && p >= activationPrice) {
      trailingArmed = true;
    }

    if (trailingArmed && remainingTokens > 0.001) {
      const trailP = highestSeen * (1 - trailingPct);
      if (p < trailP) {
        totalProceeds += originalCost * remainingTokens * (p / entryP);
        remainingTokens = 0;
        exitReason = 'tp-trailing-max-exit';
        exitTime = t;
        break;
      }
    }

    const ageMin = t / 60;
    if (ageMin >= maxHoldMin && p < entryP * timeExitMinMultiple && remainingTokens > 0.001) {
      totalProceeds += originalCost * remainingTokens * (p / entryP);
      remainingTokens = 0;
      exitReason = 'time-exit';
      exitTime = t;
      break;
    }
  }

  if (remainingTokens > 0.001) {
    const finalPoint = pricePath[pricePath.length - 1];
    const finalExitP = finalPoint ? finalPoint.price : entryP;
    totalProceeds += originalCost * remainingTokens * (finalExitP / entryP);
    remainingTokens = 0;
    if (exitReason === 'none') exitReason = 'end-of-simulation';
  }

  const pnl = totalProceeds - originalCost;
  const roi = entryValue > 0 ? (pnl / entryValue) * 100 : 0;

  return {
    pnl: Math.round(pnl * 100) / 100,
    roi: Math.round(roi * 100) / 100,
    exitReason,
    exitTime: Math.round(exitTime),
    targetsHit,
    totalProceeds: Math.round(totalProceeds * 100) / 100,
  };
}

// ---------------------------------------------------------------------------
// 4. Parameter grid
// ---------------------------------------------------------------------------

export const PARAM_GRID: Record<string, any[]> = {
  stopLossPct: [0.1, 0.15, 0.2, 0.25],
  trailingDrawdownPct: [0.1, 0.15, 0.2, 0.25],
  takeProfitMultiples: [[1.5], [1.3, 2.0], [1.5, 2.5]],
  takeProfitFraction: [0.5, 0.6, 0.75],
  earlyPerformanceDropPct: [5, 10, 15, 20],
  earlyPerformanceSellPct: [40, 60, 80, 100],
  maxHoldMinutes: [10, 20, 30, 60],
};

export function generateGrid(): ReplayParams[] {
  const keys = Object.keys(PARAM_GRID);
  const values = keys.map((k) => PARAM_GRID[k]);

  function* cartesian(
    arrs: any[][],
    idx: number = 0,
    current: any[] = []
  ): Generator<ReplayParams> {
    if (idx === arrs.length) {
      const params: any = {};
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (key) params[key] = current[i];
      }
      yield params as ReplayParams;
      return;
    }
    const currentArrs = arrs[idx];
    if (currentArrs) {
      for (const v of currentArrs) {
        yield* cartesian(arrs, idx + 1, [...current, v]);
      }
    }
  }

  return [...cartesian(values as any[][])];
}

function stringifyParams(p: ReplayParams): string {
  const parts = [];
  parts.push(`SL=${(p.stopLossPct * 100).toFixed(0)}%`);
  parts.push(`Trail=${(p.trailingDrawdownPct * 100).toFixed(0)}%`);
  parts.push(`TP=[${p.takeProfitMultiples.join(',')}]`);
  parts.push(`TPFrac=${p.takeProfitFraction}`);
  parts.push(`EarlyDrop=${p.earlyPerformanceDropPct}%`);
  parts.push(`EarlySell=${p.earlyPerformanceSellPct}%`);
  parts.push(`Hold=${p.maxHoldMinutes}m`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// 5. Analysis
// ---------------------------------------------------------------------------

export function runAnalysis(
  trades: AnalyzerTrade[],
  metrics: any[]
): { results: AnalysisResult[]; trades: AnalyzerTrade[]; metrics: any[] } {
  const grid = generateGrid();
  const totalCombos = grid.length;

  console.log(`\n=== Veloci-Buy Trade Replay Analyzer ===`);
  console.log(`Sessions: ${new Set(trades.map((t) => t.sessionDir)).size}`);
  console.log(`Trades: ${trades.length}`);
  console.log(`Parameter combos: ${totalCombos.toLocaleString()}`);
  console.log(`\nScanning...`);

  const results: AnalysisResult[] = [];
  let processed = 0;

  for (const params of grid) {
    let totalPnl = 0;
    let wins = 0;
    let losses = 0;
    let maxLoss = 0;
    const pnlValues = [];

    for (const trade of trades) {
      const r = replayTrade(trade, params);
      if (!r) continue;
      totalPnl += r.pnl;
      pnlValues.push(r.pnl);
      if (r.pnl > 0) wins++;
      else losses++;
      if (r.pnl < maxLoss) maxLoss = r.pnl;
    }

    const totalTrades = wins + losses;
    const winRate = totalTrades > 0 ? wins / totalTrades : 0;
    const avgPnl = totalTrades > 0 ? totalPnl / totalTrades : 0;
    const grossWins = pnlValues.filter((v) => v > 0).reduce((a, b) => a + b, 0);
    const grossLosses = Math.abs(pnlValues.filter((v) => v < 0).reduce((a, b) => a + b, 0));
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;

    results.push({
      params,
      totalPnl: Math.round(totalPnl * 100) / 100,
      winRate: Math.round(winRate * 1000) / 10,
      avgPnl: Math.round(avgPnl * 100) / 100,
      maxLoss: Math.round(maxLoss * 100) / 100,
      profitFactor: profitFactor === Infinity ? 'Inf' : Math.round(profitFactor * 100) / 100,
      trades: totalTrades,
    });

    processed++;
    if (processed % 1000 === 0) {
      process.stdout.write(
        `\r  ${processed.toLocaleString()} / ${totalCombos.toLocaleString()} combos`
      );
    }
  }

  process.stdout.write(
    `\r  ${totalCombos.toLocaleString()} / ${totalCombos.toLocaleString()} combos   \n`
  );

  results.sort((a, b) => b.totalPnl - a.totalPnl);

  return { results, trades, metrics };
}

// ---------------------------------------------------------------------------
// 6. Output
// ---------------------------------------------------------------------------

function pad(str: any, len: number): string {
  const s = String(str);
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

function printTradeSummary(trades: AnalyzerTrade[]): void {
  console.log(`\n--- Trade Summary (${trades.length} trades) ---`);
  console.log(
    pad('Symbol', 10) +
      pad('Score', 7) +
      pad('Entry$', 14) +
      pad('Highest$', 14) +
      pad('Exit$', 14) +
      pad('PnL$', 12) +
      pad('Hold', 8) +
      'Exit Reason'
  );
  console.log('-'.repeat(95));

  for (const t of trades) {
    console.log(
      pad(t.symbol, 10) +
        pad(t.entryScore, 7) +
        pad('$' + t.entryPriceUsd.toFixed(8), 14) +
        pad('$' + t.highestPriceUsd.toFixed(8), 14) +
        pad('$' + t.actualExitPrice.toFixed(8), 14) +
        pad('$' + t.totalRealizedPnlUsd.toFixed(2), 12) +
        pad(Math.round(t.holdSeconds) + 's', 8) +
        (t.actualExitReason || 'unknown')
    );
  }
}

function printTopCombos(results: AnalysisResult[], topN: number = 15): void {
  console.log(`\n--- Top ${topN} Parameter Combos (by Total PnL) ---`);
  console.log(
    pad('Rank', 5) +
      pad('Total PnL$', 14) +
      pad('Win%', 7) +
      pad('Avg PnL$', 12) +
      pad('Max Loss$', 12) +
      pad('PF', 6) +
      'Parameters'
  );
  console.log('-'.repeat(130));

  for (let i = 0; i < Math.min(topN, results.length); i++) {
    const r = results[i];
    if (!r) continue;
    console.log(
      pad(i + 1, 5) +
        pad('$' + r.totalPnl.toFixed(2), 14) +
        pad(r.winRate.toFixed(1) + '%', 7) +
        pad('$' + r.avgPnl.toFixed(2), 12) +
        pad('$' + r.maxLoss.toFixed(2), 12) +
        pad(String(r.profitFactor), 6) +
        stringifyParams(r.params)
    );
  }
}

function printSensitivity(results: AnalysisResult[]): void {
  console.log(`\n--- Per-Parameter Sensitivity ---`);

  const paramKeys = Object.keys(PARAM_GRID);

  for (const key of paramKeys) {
    const grouped = new Map<string, { pnl: number; count: number }>();

    for (const r of results) {
      const valKey = Array.isArray((r.params as any)[key])
        ? '[' + (r.params as any)[key].join(',') + ']'
        : String((r.params as any)[key]);
      if (!grouped.has(valKey)) grouped.set(valKey, { pnl: 0, count: 0 });
      const g = grouped.get(valKey)!;
      g.pnl += r.totalPnl;
      g.count++;
    }

    const sorted = [...grouped.entries()].sort((a, b) => b[1].pnl - a[1].pnl);
    const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase());

    console.log(`\n  ${label}:`);
    for (const [val, agg] of sorted) {
      const avg = agg.count > 0 ? agg.pnl / agg.count : 0;
      console.log(`    ${pad(val, 20)}  Avg PnL: $${avg.toFixed(2)}  (${agg.count} combos)`);
    }
  }
}

function printFunnel(metrics: any[]): void {
  if (metrics.length === 0) return;

  console.log(`\n--- Rejection Funnel (across ${metrics.length} sessions) ---`);

  const totalRejections = new Map<string, number>();
  for (const m of metrics) {
    if (m.rejectionReasons) {
      for (const [reason, count] of Object.entries(m.rejectionReasons)) {
        totalRejections.set(reason, (totalRejections.get(reason) || 0) + (count as number));
      }
    }
  }

  const sorted = [...totalRejections.entries()].sort((a, b) => b[1] - a[1]);
  const firstEntry = sorted[0];
  const maxCount = firstEntry ? firstEntry[1] : 1;
  const barWidth = 40;

  console.log(pad('Reason', 35) + pad('Count', 10) + pad('%', 8) + 'Bar');
  console.log('-'.repeat(95));

  for (const [reason, count] of sorted) {
    const pct = ((count / maxCount) * 100).toFixed(1);
    const barLen = Math.round((count / maxCount) * barWidth);
    const bar = '#'.repeat(barLen);
    console.log(pad(reason, 35) + pad(count.toLocaleString(), 10) + pad(pct + '%', 8) + bar);
  }

  const totals = { discovered: 0, cheapAudit: 0, survival: 0, bought: 0, auditPassed: 0 };
  for (const m of metrics) {
    totals.discovered += m.discoveredCandidates || 0;
    totals.cheapAudit += m.passedCheapAudit || 0;
    totals.survival += m.passedSurvival || 0;
    totals.bought += m.boughtPositions || 0;
    totals.auditPassed += m.passedAudit || 0;
  }

  console.log(`\n  Funnel pass-through:`);
  console.log(`    Discovered:        ${totals.discovered.toLocaleString()}`);
  console.log(
    `    Passed cheap audit: ${totals.cheapAudit.toLocaleString()} (${totals.discovered > 0 ? ((totals.cheapAudit / totals.discovered) * 100).toFixed(1) : 0}%)`
  );
  console.log(
    `    Passed survival:    ${totals.survival.toLocaleString()} (${totals.cheapAudit > 0 ? ((totals.survival / totals.cheapAudit) * 100).toFixed(1) : 0}%)`
  );
  console.log(
    `    Bought positions:   ${totals.bought.toLocaleString()} (${totals.survival > 0 ? ((totals.bought / totals.survival) * 100).toFixed(1) : 0}%)`
  );
}

// ---------------------------------------------------------------------------
// 7. Main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const baseDir = process.cwd();
  const { trades, metrics } = ingestSessions(baseDir);

  if (trades.length === 0) {
    console.log('No paper trades found. Run the bot in PAPER_TRADING mode first.');
    return;
  }

  const { results } = runAnalysis(trades, metrics);

  printTradeSummary(trades);
  printTopCombos(results);
  printSensitivity(results);
  printFunnel(metrics);

  const outputFile = path.join(baseDir, 'analysis-results.json');
  fs.writeFileSync(
    outputFile,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        tradeCount: trades.length,
        comboCount: results.length,
        topCombos: results.slice(0, 50).map((r) => ({
          params: r.params,
          totalPnl: r.totalPnl,
          winRate: r.winRate,
          avgPnl: r.avgPnl,
          maxLoss: r.maxLoss,
          profitFactor: r.profitFactor,
        })),
        sensitivity: computeSensitivitySummary(results),
      },
      null,
      2
    )
  );
  console.log(`\nFull results written to ${outputFile}`);
}

function computeSensitivitySummary(results: AnalysisResult[]): Record<string, any[]> {
  const summary: Record<string, any[]> = {};
  for (const key of Object.keys(PARAM_GRID)) {
    const grouped = new Map<string, { pnl: number; count: number }>();
    for (const r of results) {
      const valKey = Array.isArray((r.params as any)[key])
        ? '[' + (r.params as any)[key].join(',') + ']'
        : String((r.params as any)[key]);
      if (!grouped.has(valKey)) grouped.set(valKey, { pnl: 0, count: 0 });
      const g = grouped.get(valKey)!;
      g.pnl += r.totalPnl;
      g.count++;
    }
    summary[key] = [...grouped.entries()]
      .map(([val, agg]) => ({
        value: val,
        avgPnl: agg.count > 0 ? Math.round((agg.pnl / agg.count) * 100) / 100 : 0,
      }))
      .sort((a, b) => b.avgPnl - a.avgPnl);
  }
  return summary;
}

// Support running directly if called as main module
const isMain = process.argv[1]?.endsWith('analyze.js') || process.argv[1]?.endsWith('analyze.ts');
if (isMain) {
  main().catch(console.error);
}
