'use strict';

import fs from 'node:fs';
import path from 'node:path';

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

function formatUsd(val: number): string {
  return `$${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatSol(val: number): string {
  return `${val.toFixed(6)} SOL`;
}

export async function generatePnlReport(sessionDir: string): Promise<string> {
  const tradeJournalPath = path.join(sessionDir, 'trade-journal.jsonl');
  const paperJournalPath = path.join(sessionDir, 'paper-trade-journal.jsonl');

  const liveTrades = readJsonl<ClosedTrade>(tradeJournalPath);
  const paperEvents = readJsonl<TradeEvent>(paperJournalPath);

  // Group paper events by mint to calculate closed trade stats if they are not in trade-journal.jsonl
  // (In Veloci-Buy, closed trades are also journaled to trade-journal.jsonl even in paper mode)

  const allClosedTrades: ClosedTrade[] = [...liveTrades];

  // If trade-journal is empty but paper-journal has events, we might need to reconstruct from paper events
  // However, based on monitor.service.ts, recordClosedTrade is called for both live and paper.

  if (allClosedTrades.length === 0 && paperEvents.length > 0) {
    // Fallback: Reconstruct from paper events if trade-journal is missing
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
          closedAt: last.timestamp,
          entryUsdValue: 0,
          entryPriceSol: 0,
          highestPriceUsd: 0,
          holdSeconds: 0,
          entryScore: 0,
          initialBuyAmountSol: null,
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

  fs.writeFileSync(reportPath, md);
  return reportPath;
}

// Support CLI usage
if (process.argv[1]?.endsWith('pnl-analyzer.js') || process.argv[1]?.endsWith('pnl-analyzer.ts')) {
  const targetDir = process.argv[2] || process.cwd();
  generatePnlReport(targetDir)
    .then((resultPath) => console.log(`Report generated: ${resultPath}`))
    .catch((err) => console.error('Failed to generate report:', err));
}
