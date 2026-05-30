/**
 * @module PnlAnalyzer
 * Generates detailed PnL reports for trading sessions.
 */

'use strict';

import fs from 'node:fs';
import path from 'node:path';

/**
 * Interface for raw trade events logged during trading.
 */
interface TradeEvent {
  event: string;
  mint: string;
  symbol: string;
  priceUsd: number;
  priceSol?: number;
  tokenAmount?: string;
  solAmount?: string;
  proceedsUsd?: number;
  proceedsSol?: number;
  realizedPnlUsd?: number;
  realizedPnlSol?: number;
  reason?: string;
  timestamp: string;
  mode: string;
}

/**
 * Interface for a closed trade record.
 */
interface ClosedTrade {
  mint: string;
  symbol: string;
  exitReason: string;
  realizedPnlUsd: number;
  realizedPnlSol: number;
  realizedProceedsUsd: number;
  realizedProceedsSol: number;
  entryUsdValue: number;
  entryPriceUsd: number;
  entryPriceSol: number;
  highestPriceUsd: number;
  holdSeconds: number;
  closedAt: string;
  entryScore: number;
  initialBuyAmountSol: string | number | null;
}

/**
 * Reads a JSONL file and returns an array of parsed objects.
 */
function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const content = fs.readFileSync(filePath, 'utf8').trim();
    if (!content) return [];
    return content.split('\n').map((line) => JSON.parse(line) as T);
  } catch (err) {
    console.error(`Failed to read ${filePath}:`, err);
    return [];
  }
}

/**
 * Formats a number as a USD string.
 */
function formatUsd(val: number): string {
  return `$${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Formats a number as a SOL string.
 */
function formatSol(val: number): string {
  return `${val.toFixed(6)} SOL`;
}

/**
 * Generates a Markdown PnL report for a specific session.
 *
 * @param sessionDir - The directory containing the session's logs.
 * @returns Path to the generated Markdown report.
 */
export async function generatePnlReport(sessionDir: string): Promise<string> {
  const tradeJournalPath = path.join(sessionDir, 'trade-journal.jsonl');
  const paperJournalPath = path.join(sessionDir, 'paper-trade-journal.jsonl');

  const liveTrades = readJsonl<ClosedTrade>(tradeJournalPath);
  const paperEvents = readJsonl<TradeEvent>(paperJournalPath);

  const allClosedTrades: ClosedTrade[] = [...liveTrades];

  // Fallback: Reconstruct from paper events if trade-journal is missing or incomplete
  if (allClosedTrades.length === 0 && paperEvents.length > 0) {
    const byMint = new Map<string, TradeEvent[]>();
    for (const ev of paperEvents) {
      if (!byMint.has(ev.mint)) byMint.set(ev.mint, []);
      byMint.get(ev.mint)!.push(ev);
    }

    for (const [mint, events] of byMint) {
      const buy = events.find((e) => e.event === 'buy');
      const last = events[events.length - 1];
      if (buy && last && (last.event === 'close' || last.event === 'sell')) {
        const realizedPnlUsd = events.reduce((sum, e) => sum + (e.realizedPnlUsd || 0), 0);
        const realizedPnlSol = events.reduce((sum, e) => sum + (e.realizedPnlSol || 0), 0);
        const realizedProceedsUsd = events.reduce((sum, e) => sum + (e.proceedsUsd || 0), 0);
        const realizedProceedsSol = events.reduce((sum, e) => sum + (e.proceedsSol || 0), 0);

        allClosedTrades.push({
          mint,
          symbol: buy.symbol,
          exitReason: last.reason || 'unknown',
          realizedPnlUsd,
          realizedPnlSol,
          realizedProceedsUsd,
          realizedProceedsSol,
          entryPriceUsd: buy.priceUsd,
          entryPriceSol: buy.priceSol || 0,
          closedAt: last.timestamp,
          entryUsdValue: buy.proceedsUsd ? Math.abs(buy.proceedsUsd) : 0,
          highestPriceUsd: Math.max(...events.map((e) => e.priceUsd)),
          holdSeconds:
            (new Date(last.timestamp).getTime() - new Date(buy.timestamp).getTime()) / 1000,
          entryScore: 0,
          initialBuyAmountSol: buy.solAmount || null,
        });
      }
    }
  }

  let grossProfitUsd = 0;
  let grossProfitSol = 0;
  let totalPnlUsd = 0;
  let totalPnlSol = 0;
  let lostValueUsd = 0;
  let lostValueSol = 0;

  for (const trade of allClosedTrades) {
    const pnlUsd = trade.realizedPnlUsd || 0;
    const pnlSol = trade.realizedPnlSol || 0;

    totalPnlUsd += pnlUsd;
    totalPnlSol += pnlSol;

    if (pnlUsd > 0) {
      grossProfitUsd += pnlUsd;
    } else {
      lostValueUsd += Math.abs(pnlUsd);
    }

    if (pnlSol > 0) {
      grossProfitSol += pnlSol;
    } else {
      lostValueSol += Math.abs(pnlSol);
    }
  }

  const reportPath = path.join(sessionDir, 'pnl-report.md');
  const sessionName = path.basename(sessionDir);

  let md = `# PnL Report: ${sessionName}\n\n`;

  md += `## Executive Summary\n\n`;
  md += `| Metric | USD | SOL |\n`;
  md += `| :--- | :--- | :--- |\n`;
  md += `| **Gross Profit** | \`${formatUsd(grossProfitUsd)}\` | \`${formatSol(grossProfitSol)}\` |\n`;
  md += `| **Lost Value** | \`${formatUsd(lostValueUsd)}\` | \`${formatSol(lostValueSol)}\` |\n`;
  md += `| **Net PnL** | **\`${formatUsd(totalPnlUsd)}\`** | **\`${formatSol(totalPnlSol)}\`** |\n`;
  md += `| **Total Trades** | ${allClosedTrades.length} | - |\n\n`;

  md += `## Detailed Trade History\n\n`;
  md += `| Timestamp | Asset | Reason | PnL (USD) | PnL (SOL) | Proceeds (USD) | Proceeds (SOL) |\n`;
  md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;

  for (const trade of allClosedTrades) {
    md += `| ${trade.closedAt || 'N/A'} | ${trade.symbol} | ${trade.exitReason} | ${formatUsd(trade.realizedPnlUsd || 0)} | ${formatSol(trade.realizedPnlSol || 0)} | ${formatUsd(trade.realizedProceedsUsd || 0)} | ${formatSol(trade.realizedProceedsSol || 0)} |\n`;
  }

  md += `\n---\n*Generated by Veloci-Buy PnL Analyzer on ${new Date().toISOString()}*`;

  try {
    fs.writeFileSync(reportPath, md);
  } catch (err) {
    console.error(`Failed to write report to ${reportPath}:`, err);
  }
  return reportPath;
}

// Support CLI usage
if (process.argv[1]?.endsWith('pnl-analyzer.js') || process.argv[1]?.endsWith('pnl-analyzer.ts')) {
  const targetDir = process.argv[2] || process.cwd();
  generatePnlReport(targetDir)
    .then((resultPath) => console.log(`Report generated: ${resultPath}`))
    .catch((err) => console.error('Failed to generate report:', err));
}
