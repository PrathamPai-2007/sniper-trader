import {
  sleep,
  formatUsd,
  atomicToDecimalString,
  ratioToPercentString,
  bigintRatioToNumber,
  clamp,
  sendNotification,
  journalPaperTrade,
  journalClosedTrade,
  runBoundedPool,
  PRIORITY,
  computeSpread,
} from '../../core/utils.js';
import {
  BURN_OWNERS,
  TAKE_PROFIT_FRACTION,
  TAKE_PROFIT_MULTIPLES,
  MOOD_THRESHOLDS,
  MOMENTUM_FILTERS,
  SOL_MINT,
} from '../../core/config.js';
import { tradingService } from '../trading/trading.service.js';
import { auditService } from '../audit/audit.service.js';
import { Context, Position, WalletBalance, ClosedTrade } from '../../types/index.js';

/**
 * Default profiles for take-profit logic based on entry confidence.
 */
const TP_PROFILE_DEFAULTS = {
  high: {
    id: 'high-confidence',
    takeProfitMultiples: [1.5, 2.5],
    takeProfitFractions: [0.35, 0.35],
    trailingStopDrawdownPct: 0.2,
  },
  standard: {
    id: 'standard-confidence',
    takeProfitMultiples: [1.3, 2.1],
    takeProfitFractions: [0.5, 0.3],
    trailingStopDrawdownPct: 0.16,
  },
  low: {
    id: 'fast-de-risk',
    takeProfitMultiples: [1.2, 1.8],
    takeProfitFractions: [0.6, 0.25],
    trailingStopDrawdownPct: 0.12,
  },
};

/**
 * Tracks mints currently undergoing an exit operation to prevent race conditions.
 */
/**
 * Tracking set for mints currently being processed for exit.
 * Exported for test cleanup only.
 */
export const processingMints = new Set<string>();

/**
 * Increments the metric for a specific exit reason.
 * @param ctx - The application context.
 * @param reason - The reason for the exit.
 */
export function incrementExitReasonMetric(ctx: Context, reason: string): void {
  ctx.store.incrementExitReason(reason);
}

/**
 * Executes a sell/exit for a position.
 * Handles both paper and live trading modes, manages accounting, and updates state.
 *
 * @param ctx - The application context.
 * @param pos - The position being exited.
 * @param balance - The current wallet balance for the token.
 * @param pUsd - The current price in USD.
 * @param sellRaw - The raw amount of tokens to sell.
 * @param reason - The reason for the exit (e.g., 'stop-loss').
 * @param targetM - The target multiple hit, if applicable.
 * @returns A promise that resolves to true if the exit was successful.
 */
export async function executePositionExit(
  ctx: Context,
  pos: Position,
  balance: WalletBalance,
  pUsd: number,
  sellRaw: bigint,
  reason: string,
  targetM: number | null = null
): Promise<boolean> {
  if (sellRaw <= 0n) {
    ctx.logger(`Skipping ${reason} for ${pos.symbol}; zero amount.`, 'warn');
    return false;
  }

  // Prevent concurrent exits for the same mint
  if (processingMints.has(pos.mint)) {
    ctx.logger(
      `Already processing exit for ${pos.symbol}; skipping concurrent ${reason}.`,
      'debug'
    );
    return false;
  }
  processingMints.add(pos.mint);

  try {
    if (pos.targetsHit === undefined) pos.targetsHit = 0;

    if (ctx.config.paperTrading) {
      const quote = await tradingService.buildPaperSellQuote(
        ctx,
        sellRaw,
        pUsd,
        pos.decimals,
        ctx.config.jupiterPositionApiKey
      );
      const remain = balance.rawAmount - sellRaw;
      const proceedsSol = Number(atomicToDecimalString(quote.outAmount, 9, 9));
      const accounting = monitorService.buildExitAccounting(
        pos,
        sellRaw,
        balance.rawAmount,
        quote.grossUsdValue,
        proceedsSol
      );

      ctx.store.updatePaperSolBalance(BigInt(ctx.state.paperSolBalanceLamports) + quote.outAmount);

      if (reason.startsWith('take-profit')) pos.targetsHit++;
      pos.lastTakeProfitAt = new Date().toISOString();
      pos.lastTakeProfitMultiple = targetM;
      pos.lastKnownBalanceRaw = remain.toString();
      pos.lastKnownPriceUsd = pUsd;
      pos.remainingCostUsd = accounting.remainingCostUsd;
      pos.remainingCostSol = accounting.remainingCostSol;
      pos.realizedPnlUsd = (pos.realizedPnlUsd || 0) + accounting.realizedPnlUsd;
      pos.realizedPnlSol = (pos.realizedPnlSol || 0) + accounting.realizedPnlSol;
      pos.realizedProceedsUsd = (pos.realizedProceedsUsd || 0) + quote.grossUsdValue;
      pos.realizedProceedsSol = (pos.realizedProceedsSol || 0) + proceedsSol;
      pos.lastExitReason = reason;

      if (remain > 0n) {
        ctx.store.upsertPosition(pos);
      } else {
        ctx.store.removePosition(pos.mint);
        const win = (pos.realizedPnlUsd || 0) > 0;
        monitorService.recordTradeResult(ctx, win);
        monitorService.recordClosedTrade(ctx, pos, reason);
        if (win) ctx.store.incrementMetric('profitableTrades');
        if (reason === 'stop-loss') ctx.store.incrementMetric('stopLosses');
        if (reason === 'tp-trailing-max-exit') ctx.store.incrementMetric('trailingExits');
      }

      monitorService.incrementExitReasonMetric(ctx, reason);
      journalPaperTrade(ctx, {
        event: remain > 0n ? 'sell' : 'close',
        mint: pos.mint,
        symbol: pos.symbol,
        priceUsd: pUsd,
        tokenAmount: sellRaw.toString(),
        proceedsUsd: quote.grossUsdValue,
        proceedsSol: proceedsSol,
        realizedPnlUsd: accounting.realizedPnlUsd,
        realizedPnlSol: accounting.realizedPnlSol,
        reason,
        mode: 'paper',
      });
      ctx.logger(
        `PAPER ${reason} on ${pos.symbol}. SOL out ${atomicToDecimalString(quote.outAmount, 9, 6)}. PnL: ${formatUsd(accounting.realizedPnlUsd)}`,
        'trade'
      );
      return true;
    }

    const isPanic = [
      'liquidity-exit',
      'stop-loss',
      'early-performance-guard',
      'security-rug-exit',
    ].includes(reason);
    if (ctx.config.dryRun) {
      ctx.logger(`DRY_RUN would sell ${pos.symbol} for ${reason}.`, 'trade');
      return false;
    }

    // Live Trading: Re-check balance immediately before swap to minimize race conditions
    const upBalBefore = await tradingService.getWalletTokenBalance(ctx, pos.mint, PRIORITY.HIGH);
    const actualSellRaw = sellRaw > upBalBefore.rawAmount ? upBalBefore.rawAmount : sellRaw;

    if (actualSellRaw <= 0n) {
      ctx.logger(`Live exit skipped for ${pos.symbol}: no tokens found.`, 'warn');
      ctx.store.removePosition(pos.mint);
      return false;
    }

    const solBalanceBefore = await tradingService.getSolBalance(ctx).catch(() => 0n);
    const { signature: sig, order } = await tradingService.executeSwapOrderWithSmartRetry(
      ctx,
      pos.mint,
      SOL_MINT,
      actualSellRaw.toString(),
      isPanic
    );

    // Give the RPC a moment to reflect the balance change
    await sleep(2000);
    const upBalAfter = await tradingService.getWalletTokenBalance(ctx, pos.mint, PRIORITY.HIGH);

    const solBalanceAfter = await tradingService.getSolBalance(ctx).catch(() => 0n);
    const solPrice = await tradingService.estimateSolUsdPrice(ctx);

    let proceedsSol = Number(atomicToDecimalString(order.outAmount || '0', 9, 9));
    if (solBalanceBefore > 0n && solBalanceAfter > 0n && solBalanceAfter > solBalanceBefore) {
      proceedsSol = Number(atomicToDecimalString(solBalanceAfter - solBalanceBefore, 9, 9));
    }
    const proceedsUsd = proceedsSol * solPrice;
    const acc = monitorService.buildExitAccounting(
      pos,
      actualSellRaw,
      upBalBefore.rawAmount,
      proceedsUsd,
      proceedsSol
    );

    if (reason.startsWith('take-profit')) pos.targetsHit++;
    pos.lastTakeProfitAt = new Date().toISOString();
    pos.lastTakeProfitMultiple = targetM;
    pos.lastKnownBalanceRaw = upBalAfter.rawAmount.toString();
    pos.lastKnownPriceUsd = pUsd;
    pos.remainingCostUsd = acc.remainingCostUsd;
    pos.remainingCostSol = acc.remainingCostSol;
    pos.realizedPnlUsd = (pos.realizedPnlUsd || 0) + acc.realizedPnlUsd;
    pos.realizedPnlSol = (pos.realizedPnlSol || 0) + acc.realizedPnlSol;
    pos.realizedProceedsUsd = (pos.realizedProceedsUsd || 0) + proceedsUsd;
    pos.realizedProceedsSol = (pos.realizedProceedsSol || 0) + proceedsSol;
    pos.lastExitReason = reason;
    pos.lastSellSignature = sig;

    const totalT = Array.isArray(pos.takeProfitMultiples)
      ? pos.takeProfitMultiples.length
      : TAKE_PROFIT_MULTIPLES.length;

    if (pos.targetsHit >= totalT || upBalAfter.rawAmount <= 0n) {
      ctx.store.removePosition(pos.mint);
      const win = (pos.realizedPnlUsd || 0) > 0;
      monitorService.recordTradeResult(ctx, win);
      monitorService.recordClosedTrade(ctx, pos, reason);
      if (win) ctx.store.incrementMetric('profitableTrades');
      if (reason === 'stop-loss') ctx.store.incrementMetric('stopLosses');
      if (reason === 'tp-trailing-max-exit') ctx.store.incrementMetric('trailingExits');
      startCoolDown(ctx, pos.mint, pUsd);

      const closeAta = () =>
        tradingService.closeAssociatedTokenAccount(ctx, pos.mint).catch((err: unknown) => {
          ctx.logger(
            `ATA close failure for ${pos.symbol}: ${err instanceof Error ? err.message : String(err)}`,
            'debug'
          );
        });
      if (ctx.config.backgroundAtaClose) void closeAta();
      else await closeAta();
    } else {
      ctx.store.upsertPosition(pos);
    }

    monitorService.incrementExitReasonMetric(ctx, reason);
    const pnlUsd = acc.realizedPnlUsd;
    const roi = (pnlUsd / Number(pos.entryUsdValue)) * 100;
    const msg = `EXIT: ${pos.symbol}\nReason: ${reason}\nPrice: ${formatUsd(pUsd)}\nPnL: ${formatUsd(pnlUsd)} (${roi.toFixed(2)}%)`;
    void sendNotification(ctx, msg).catch((err: unknown) => {
      ctx.logger(
        `Exit notification failed for ${pos.symbol}: ${err instanceof Error ? err.message : String(err)}`,
        'debug'
      );
    });
    ctx.logger(
      `Sold ${pos.symbol} for ${reason} at ${formatUsd(pUsd)}. PnL: ${formatUsd(pnlUsd)} (${roi.toFixed(2)}%). sig: ${sig}`,
      'trade'
    );

    return true;
  } catch (err: unknown) {
    ctx.logger(
      `Failed to exit ${pos.symbol} for ${reason}: ${err instanceof Error ? err.message : String(err)}`,
      'error'
    );
    return false;
  } finally {
    processingMints.delete(pos.mint);
  }
}

/**
 * Executes a take-profit sell for a position.
 * @param ctx - The application context.
 * @param pos - The position object.
 * @param balance - Current wallet balance.
 * @param pUsd - Current price in USD.
 * @param targetM - The target multiple being hit.
 */
export async function sellTakeProfit(
  ctx: Context,
  pos: Position,
  balance: WalletBalance,
  pUsd: number,
  targetM: number
): Promise<boolean> {
  const frac = getTakeProfitFraction(pos, pos.targetsHit || 0);
  const amt = computeTakeProfitSellAmount(balance.rawAmount, frac);
  return monitorService.executePositionExit(
    ctx,
    pos,
    balance,
    pUsd,
    amt,
    `take-profit-${targetM}x`,
    targetM
  );
}

/**
 * Builds accounting information for a position exit, calculating realized PnL and remaining cost.
 * @param pos - The position object.
 * @param sellRaw - Amount being sold.
 * @param balRaw - Balance before the sell.
 * @param proceedsUsd - USD proceeds from the sell.
 * @param proceedsSol - SOL proceeds from the sell.
 */
export function buildExitAccounting(
  pos: Position,
  sellRaw: bigint,
  balRaw: bigint,
  proceedsUsd: number,
  proceedsSol: number
): {
  realizedPnlUsd: number;
  realizedPnlSol: number;
  remainingCostUsd: number;
  remainingCostSol: number;
} {
  const ratio = bigintRatioToNumber(sellRaw, balRaw);
  const costSoldUsd = Number(pos.remainingCostUsd || 0) * ratio;
  const costSoldSol = Number(pos.remainingCostSol || 0) * ratio;
  return {
    realizedPnlUsd: proceedsUsd - costSoldUsd,
    realizedPnlSol: proceedsSol - costSoldSol,
    remainingCostUsd: Math.max(0, Number(pos.remainingCostUsd || 0) - costSoldUsd),
    remainingCostSol: Math.max(0, Number(pos.remainingCostSol || 0) - costSoldSol),
  };
}

export interface TakeProfitPlan {
  profileId: string;
  isHighGrowthConfidence: boolean;
  takeProfitMultiples: number[];
  takeProfitFractions: number[];
  trailingStopDrawdownPct: number;
  maxHoldMinutesResolved: number;
}

/**
 * Constructs a take-profit plan for a new position based on configuration and score.
 * Selects between High, Standard, and Low confidence profiles.
 *
 * @param ctx - The application context.
 * @param score - The candidate evaluation score.
 */
export function getTakeProfitPlan(ctx: Context, score: number): TakeProfitPlan {
  const numericScore = Number(score || 0);
  const highThreshold = Number(ctx.config.highGrowthConfidenceScore || 70);
  const baselineThreshold = Number(ctx.config.minCandidateScore || 60);
  const standardThreshold =
    baselineThreshold + Math.max(2, (highThreshold - baselineThreshold) / 2);

  let profile = TP_PROFILE_DEFAULTS.low;
  let maxHoldMinutesResolved = Number(ctx.config.holdDurationLowConfidenceMinutes || 5);

  if (numericScore >= highThreshold) {
    profile = TP_PROFILE_DEFAULTS.high;
    maxHoldMinutesResolved = Number(ctx.config.holdDurationHighConfidenceMinutes || 10);
  } else if (numericScore >= standardThreshold) {
    profile = TP_PROFILE_DEFAULTS.standard;
    maxHoldMinutesResolved = Number(ctx.config.maxHoldMinutes || 20);
  }

  const multiples =
    Array.isArray(profile.takeProfitMultiples) && profile.takeProfitMultiples.length > 0
      ? profile.takeProfitMultiples
      : Array.isArray(ctx.config.takeProfitMultiples) && ctx.config.takeProfitMultiples.length > 0
        ? ctx.config.takeProfitMultiples
        : TAKE_PROFIT_MULTIPLES;

  const fractions =
    Array.isArray(profile.takeProfitFractions) && profile.takeProfitFractions.length > 0
      ? profile.takeProfitFractions
      : [
          Number.isFinite(ctx.config.takeProfitFraction) && ctx.config.takeProfitFraction > 0
            ? ctx.config.takeProfitFraction
            : TAKE_PROFIT_FRACTION,
        ];

  return {
    profileId: profile.id,
    isHighGrowthConfidence: numericScore >= highThreshold,
    takeProfitMultiples: [...multiples],
    takeProfitFractions: fractions.map((value) => clamp(value, 0, 1)),
    trailingStopDrawdownPct: clamp(
      Number(profile.trailingStopDrawdownPct || ctx.config.trailingStopDrawdownPct || 0.2),
      0.01,
      0.95
    ),
    maxHoldMinutesResolved: Math.max(
      1,
      Math.floor(maxHoldMinutesResolved || ctx.config.maxHoldMinutes || 20)
    ),
  };
}

/**
 * Retrieves the take-profit fraction for a specific target index.
 * @param pos - The position object.
 * @param targetIndex - The index of the take-profit target.
 */
export function getTakeProfitFraction(pos: Position, targetIndex: number): number {
  return Array.isArray(pos.takeProfitFractions) &&
    Number.isFinite(pos.takeProfitFractions[targetIndex])
    ? clamp(pos.takeProfitFractions[targetIndex]!, 0, 1)
    : TAKE_PROFIT_FRACTION;
}

/**
 * Calculates the raw token amount to sell based on a fraction of the balance.
 * @param balRaw - The current raw token balance.
 * @param frac - The fraction of the balance to sell.
 */
export function computeTakeProfitSellAmount(balRaw: bigint, frac: number): bigint {
  return (balRaw * BigInt(Math.max(1, Math.round(frac * 10000)))) / 10000n;
}

export interface MoodAdjustments {
  sizeMultiplier: number;
  isPaused: boolean;
}

/**
 * Calculates trading mood adjustments based on recent trade win rates.
 * Can pause trading or reduce buy sizes if performance is poor.
 *
 * @param ctx - The application context.
 */
export function getMoodAdjustments(ctx: Context): MoodAdjustments {
  let sizeMultiplier = 1.0;
  let isPaused = false;

  if (ctx.state.moodPauseUntil && Date.now() < ctx.state.moodPauseUntil) {
    isPaused = true;
  } else {
    const history = ctx.state.tradeHistory || [];
    const last10 = history.slice(-MOOD_THRESHOLDS.windowLarge);
    const last5 = history.slice(-MOOD_THRESHOLDS.windowSmall);

    const winRate10 =
      last10.length >= MOOD_THRESHOLDS.windowLarge
        ? last10.filter((w) => w).length / MOOD_THRESHOLDS.windowLarge
        : 1;

    const winRate5 =
      last5.length >= MOOD_THRESHOLDS.windowSmall
        ? last5.filter((w) => w).length / MOOD_THRESHOLDS.windowSmall
        : 1;

    if (winRate10 < MOOD_THRESHOLDS.winRateCritical) {
      isPaused = true;
      ctx.store.pauseMood(ctx.config.moodPauseDurationMinutes * 60000);
      ctx.logger(
        `Daily Mood: CRITICAL (${(winRate10 * 100).toFixed(0)}% WR). Pausing for ${ctx.config.moodPauseDurationMinutes}m.`,
        'warn',
        { console: true }
      );
    } else if (winRate5 < MOOD_THRESHOLDS.winRateCautious) {
      sizeMultiplier = MOOD_THRESHOLDS.sizeMultiplierCautious;
      ctx.logger(
        `Daily Mood: CAUTIOUS (${(winRate5 * 100).toFixed(0)}% WR). Reducing size 50%.`,
        'warn',
        { console: true }
      );
    }
  }

  return { sizeMultiplier, isPaused };
}

/**
 * Records a trade result in the global metrics.
 * @param ctx - The application context.
 * @param isWin - Whether the trade was profitable.
 */
export function recordTradeResult(ctx: Context, isWin: boolean): void {
  ctx.store.addTradeResult(isWin);
}

/**
 * Records a closed trade with all its metadata for history and journaling.
 * @param ctx - The application context.
 * @param pos - The position being closed.
 * @param reason - The reason for closing the position.
 */
export function recordClosedTrade(ctx: Context, pos: Position, reason: string): void {
  const openedAtMs = new Date(pos.openedAt || Date.now()).getTime();
  const trade: ClosedTrade = {
    mint: pos.mint,
    symbol: pos.symbol,
    exitReason: reason,
    realizedPnlUsd: Number(pos.realizedPnlUsd || 0),
    realizedPnlSol: Number(pos.realizedPnlSol || 0),
    realizedProceedsUsd: Number(pos.realizedProceedsUsd || 0),
    realizedProceedsSol: Number(pos.realizedProceedsSol || 0),
    entryUsdValue: Number(pos.entryUsdValue || 0),
    entryPriceUsd: Number(pos.entryPriceUsd || 0),
    entryPriceSol: Number(pos.entryPriceSol || 0),
    highestPriceUsd: Number(pos.highestPriceUsd || pos.entryPriceUsd || 0),
    holdSeconds: Math.max(0, (Date.now() - openedAtMs) / 1000),
    closedAt: new Date().toISOString(),
    entryScore: Number(pos.entryScore || 0),
    tpProfile: pos.tpProfile || null,
    takeProfitMultiples: pos.takeProfitMultiples || null,
    takeProfitFractions: pos.takeProfitFractions || null,
    trailingStopDrawdownPctResolved: Number(pos.trailingStopDrawdownPctResolved || 0),
    maxHoldMinutesResolved: Number(pos.maxHoldMinutesResolved || 0),
    volatilityScaler: Number(pos.volatilityScaler || 0),
    entryLiquidityUsd: Number(pos.entryLiquidityUsd || 0),
    launchpad: pos.launchpad || null,
    targetsHit: Number(pos.targetsHit || 0),
    initialBuyAmountSol: pos.initialBuyAmountSol || null,
  };
  ctx.store.addClosedTrade(trade);
  journalClosedTrade(ctx, trade as unknown as Record<string, unknown>);
}

/**
 * Calculates the multiple at which trailing stops should be activated.
 * Usually activated at the midpoint to the first target.
 * @param pos - The position object.
 */
function getTrailingActivationMultiple(pos: Position): number {
  const multiples =
    Array.isArray(pos.takeProfitMultiples) && pos.takeProfitMultiples.length > 0
      ? pos.takeProfitMultiples
      : TAKE_PROFIT_MULTIPLES;
  const firstTarget = Number(multiples[0] || 1.5);
  const midpoint = 1 + 0.5 * (firstTarget - 1);
  return Math.min(midpoint, 1.12);
}

/**
 * Starts a cool-down period for a mint to prevent immediate re-entry.
 * @param ctx - The application context.
 * @param mint - The token mint address.
 * @param pUsd - The exit price in USD.
 */
export function startCoolDown(ctx: Context, mint: string, pUsd: number): void {
  const expires = Date.now() + ctx.config.coolDownMinutes * 60000;
  ctx.store.startCoolDown(mint, pUsd, expires);
}

export interface PriceRecord {
  usdPrice?: number;
  liquidity?: number;
  bidPrice?: number;
  askPrice?: number;
}

/**
 * Periodically monitors all active positions for exit triggers.
 * Checks Stop-Loss, Trailing Stops, Take-Profit targets, Liquidity collapse,
 * and perform Security Re-Audits.
 *
 * @param ctx - The application context.
 * @param fetchPricesBestEffort - Function to fetch current prices for mints.
 */
export async function monitorPositions(
  ctx: Context,
  fetchPricesBestEffort: (
    ctx: Context,
    mints: string[],
    label: string,
    apiKey?: string
  ) => Promise<Record<string, PriceRecord>>
): Promise<void> {
  if (ctx.state.positions.size === 0) return;

  const mints = Array.from(ctx.state.positions.keys());
  const prices = await fetchPricesBestEffort(
    ctx,
    mints,
    'position refresh',
    ctx.config.jupiterPositionApiKey
  );

  await runBoundedPool(
    mints,
    async (mint) => {
      const pos = ctx.state.positions.get(mint);
      if (!pos) return;

      // Skip if already being processed by another task or earlier in this loop
      if (processingMints.has(mint)) return;

      const balance = await tradingService.getWalletTokenBalance(ctx, mint);
      if (balance.rawAmount <= 0n) {
        ctx.logger(`Position ${pos.symbol} zero balance; removing.`, 'warn');
        ctx.store.removePosition(mint);
        return;
      }

      const snap = ctx.state.marketSnapshots.get(mint);
      const pRecord = prices[mint];
      const pUsd = Number(pRecord?.usdPrice || snap?.usdPrice || 0);

      // Update Liquidity if available
      if (pRecord?.liquidity != null) {
        pos.lastKnownLiquidityUsd = pRecord.liquidity;
        if (snap) {
          snap.liquidity = pRecord.liquidity;
          snap.usdPrice = pUsd;
          snap.observedAt = new Date().toISOString();
          ctx.store.updateMarketSnapshot(mint, snap);
        }
      } else if (snap?.liquidity != null || snap?.liquidityUsd != null) {
        pos.lastKnownLiquidityUsd = snap.liquidity || snap.liquidityUsd;
      }

      const liquidityExitFloor =
        pos.lastKnownLiquidityUsd != null
          ? Math.max(
              ctx.config.liquidityCollapseThresholdUsd,
              Number(pos.entryLiquidityUsd || 0) * ctx.config.liquidityCollapseThresholdRatio
            )
          : null;

      // Check Liquidity Collapse early
      if (
        liquidityExitFloor != null &&
        pos.lastKnownLiquidityUsd != null &&
        pos.lastKnownLiquidityUsd <= liquidityExitFloor
      ) {
        ctx.logger(
          `Liquidity collapse detected for ${pos.symbol} ($${pos.lastKnownLiquidityUsd.toFixed(0)} <= $${liquidityExitFloor.toFixed(0)}).`,
          'warn',
          { console: true }
        );
        await monitorService.executePositionExit(
          ctx,
          pos,
          balance,
          pUsd || pos.lastKnownPriceUsd || pos.entryPriceUsd,
          balance.rawAmount,
          'liquidity-exit'
        );
        return;
      }

      // Skip price-based checks if price is missing
      if (!(pUsd > 0)) {
        ctx.logger(`Price unavailable for ${pos.symbol}; skipping price checks.`, 'debug');
        return;
      }

      // Update Position State
      pos.highestPriceUsd = Math.max(Number(pos.highestPriceUsd || pos.entryPriceUsd || 0), pUsd);
      pos.lastKnownBalanceRaw = balance.rawAmount.toString();
      pos.lastKnownPriceUsd = pUsd;

      // Track Price/Spread History
      pos.priceHistory = pos.priceHistory || [];
      pos.priceHistory.push({ price: pUsd, timestamp: Date.now() });
      if (
        pRecord &&
        pRecord.bidPrice !== undefined &&
        pRecord.askPrice !== undefined &&
        pRecord.bidPrice > 0 &&
        pRecord.askPrice > 0
      ) {
        pos.spreadHistory = pos.spreadHistory || [];
        pos.spreadHistory.push({
          spread: computeSpread(pRecord.bidPrice, pRecord.askPrice),
          timestamp: Date.now(),
        });
      }

      const cutoff = Date.now() - 60000;
      pos.priceHistory = pos.priceHistory.filter((h) => h.timestamp > cutoff);
      if (pos.spreadHistory) {
        pos.spreadHistory = pos.spreadHistory.filter((h) => h.timestamp > cutoff);
      }

      ctx.store.upsertPosition(pos);

      // --- Security Re-Audit (Every 30s) ---
      if (!pos.lastSecurityAuditAt || Date.now() - pos.lastSecurityAuditAt > 30000) {
        pos.lastSecurityAuditAt = Date.now();
        try {
          const signals = await auditService.getMintSignals(ctx, mint, { priority: PRIORITY.LOW });

          if (signals.mintAuthority || signals.freezeAuthority) {
            ctx.logger(
              `SECURITY ALERT: ${pos.symbol} authorities enabled after buy! Emergency Exit.`,
              'warn',
              { console: true }
            );
            await monitorService.executePositionExit(
              ctx,
              pos,
              balance,
              pUsd,
              balance.rawAmount,
              'security-rug-exit'
            );
            return;
          }

          const initialHolders = pos.mintSignals?.topAccounts || [];
          if (initialHolders.length > 0) {
            for (const initial of initialHolders) {
              if (!initial.owner || BURN_OWNERS.has(initial.owner)) continue;
              const current = signals.topAccounts.find((a) => a.owner === initial.owner);
              const initialAmt = Number(initial.rawAmount);

              if (current) {
                const currentAmt = Number(current.rawAmount);
                const dropRatio = 1 - currentAmt / initialAmt;
                if (dropRatio > 0.25) {
                  ctx.logger(
                    `INSIDER ALERT: Top holder ${initial.owner.slice(0, 8)} sold ${(dropRatio * 100).toFixed(1)}%. De-risking 40%.`,
                    'warn',
                    { console: true }
                  );
                  if (
                    await monitorService.executePositionExit(
                      ctx,
                      pos,
                      balance,
                      pUsd,
                      computeTakeProfitSellAmount(balance.rawAmount, 0.4),
                      'insider-drift-exit'
                    )
                  ) {
                    return; // Position partially exited, stop processing this loop
                  }
                }
              } else {
                ctx.logger(
                  `INSIDER ALERT: Top holder ${initial.owner.slice(0, 8)} exited top 5. De-risking 40%.`,
                  'warn',
                  { console: true }
                );
                if (
                  await monitorService.executePositionExit(
                    ctx,
                    pos,
                    balance,
                    pUsd,
                    computeTakeProfitSellAmount(balance.rawAmount, 0.4),
                    'insider-drift-exit'
                  )
                ) {
                  return;
                }
              }
            }
          }
        } catch (err: unknown) {
          ctx.logger(
            `Re-audit failed for ${pos.symbol}: ${err instanceof Error ? err.message : String(err)}`,
            'debug'
          );
        }
      }

      const ageSec = (Date.now() - new Date(pos.openedAt).getTime()) / 1000;
      const multiples =
        Array.isArray(pos.takeProfitMultiples) && pos.takeProfitMultiples.length > 0
          ? pos.takeProfitMultiples
          : TAKE_PROFIT_MULTIPLES;

      // --- Adaptive Midpoint Exit ---
      if (pos.minTpArmed && pos.targetsHit! < multiples.length) {
        const nextM = multiples[pos.targetsHit!]!;
        const minTpM = 1 + 0.5 * (nextM - 1);
        const minTpP = pos.entryPriceUsd * minTpM;
        if (pUsd < minTpP) {
          ctx.logger(
            `Price fell back to midpoint ${formatUsd(minTpP)} for ${pos.symbol} (Target ${pos.targetsHit! + 1}). Midpoint exit.`,
            'trade'
          );
          await monitorService.executePositionExit(
            ctx,
            pos,
            balance,
            pUsd,
            balance.rawAmount,
            'adaptive-tp-exit'
          );
          return;
        }
      }

      // --- Early Performance Guard ---
      if (ageSec <= ctx.config.earlyPerformanceGuardSeconds && pos.targetsHit === 0) {
        const drop = (pos.entryPriceUsd - pUsd) / pos.entryPriceUsd;
        const buyCollapse =
          Array.isArray(pos.tapeHistory) &&
          pos.tapeHistory.length >= 2 &&
          (pos.tapeHistory[pos.tapeHistory.length - 1]?.buys ?? 0) -
            (pos.tapeHistory[pos.tapeHistory.length - 2]?.buys ?? 0) ===
            0;

        if (drop > ctx.config.earlyPerformanceDropPct / 100 || buyCollapse) {
          ctx.logger(
            `Early Guard for ${pos.symbol}: drop ${(drop * 100).toFixed(1)}% or buy collapse. Partial exit.`,
            'warn',
            { console: true }
          );
          await monitorService.executePositionExit(
            ctx,
            pos,
            balance,
            pUsd,
            computeTakeProfitSellAmount(
              balance.rawAmount,
              ctx.config.earlyPerformanceSellPct / 100
            ),
            'early-performance-guard'
          );
          return;
        }
      }

      // --- Stop Loss ---
      const baseSlPct = ctx.config.stopLossPct;
      const adjustedSlPct = baseSlPct * (1 + (pos.volatilityScaler || 0));
      const slP = pos.entryPriceUsd * (1 - adjustedSlPct);
      const slWP = pos.entryPriceUsd * (1 - adjustedSlPct / 2);

      if (pUsd <= slWP && !pos.stopLossWarningSent) {
        pos.stopLossWarningSent = true;
        ctx.logger(
          `WARNING: ${pos.symbol} half-SL touched. Drawdown: ${((1 - pUsd / pos.entryPriceUsd) * 100).toFixed(2)}%.`,
          'warn',
          { console: true }
        );
        ctx.store.upsertPosition(pos);
      }

      if (pUsd <= slP) {
        ctx.logger(`STOP LOSS hit for ${pos.symbol} at ${formatUsd(pUsd)}.`, 'trade');
        await monitorService.executePositionExit(
          ctx,
          pos,
          balance,
          pUsd,
          balance.rawAmount,
          'stop-loss'
        );
        return;
      }

      // --- Trailing Stop Activation ---
      if (!pos.trailingArmed) {
        const activationMultiple = getTrailingActivationMultiple(pos);
        if (pUsd >= pos.entryPriceUsd * activationMultiple) {
          pos.trailingArmed = true;
          ctx.logger(
            `Trailing Stop ARMED for ${pos.symbol} at ${activationMultiple.toFixed(2)}x.`,
            'info'
          );
          ctx.store.upsertPosition(pos);
        }
      }

      // Minimum Hold Time
      if (ageSec < ctx.config.minHoldTimeSeconds) return;

      // --- Momentum / Performance Check ---
      if (
        ageSec > ctx.config.performanceCheckSeconds &&
        pos.targetsHit === 0 &&
        pUsd < pos.entryPriceUsd * ctx.config.performanceMinMomentum
      ) {
        ctx.logger(`No early performance for ${pos.symbol}; exiting.`, 'trade');
        await monitorService.executePositionExit(
          ctx,
          pos,
          balance,
          pUsd,
          balance.rawAmount,
          'no-early-performance'
        );
        return;
      }

      // --- Trailing Stop Exit ---
      let trailingDrawdownPct = Number(
        pos.trailingStopDrawdownPctResolved || ctx.config.trailingStopDrawdownPct || 0.2
      );
      const currentMultiple = pUsd / pos.entryPriceUsd;

      // Tighten trailing stop as price rises (acceleration)
      if (currentMultiple > 1.8) {
        const acceleration = Math.min(0.12, (currentMultiple - 1.8) * 0.04);
        trailingDrawdownPct = Math.max(0.04, trailingDrawdownPct - acceleration);
      }

      const trailP = (pos.highestPriceUsd || pUsd) * (1 - trailingDrawdownPct);
      if (pos.trailingArmed && pUsd < trailP) {
        ctx.logger(
          `Trailing Stop hit for ${pos.symbol}: price ${formatUsd(pUsd)} < ${ratioToPercentString(1 - trailingDrawdownPct)} of peak (${formatUsd(pos.highestPriceUsd)}).`,
          'trade'
        );
        await monitorService.executePositionExit(
          ctx,
          pos,
          balance,
          pUsd,
          balance.rawAmount,
          'tp-trailing-max-exit'
        );
        return;
      }

      // --- Spread Velocity Exit ---
      if (Array.isArray(pos.spreadHistory) && pos.spreadHistory.length >= 2) {
        const last = pos.spreadHistory[pos.spreadHistory.length - 1]!;
        const prev = pos.spreadHistory[pos.spreadHistory.length - 2]!;
        const timeDiff = (last.timestamp - prev.timestamp) / 1000;
        if (timeDiff <= 15 && prev.spread > 0) {
          const spreadIncrease = last.spread / prev.spread - 1;
          if (spreadIncrease > 0.5) {
            ctx.logger(
              `SPREAD VELOCITY: Widened ${(spreadIncrease * 100).toFixed(1)}% for ${pos.symbol}. Rug risk.`,
              'warn',
              { console: true }
            );
            await monitorService.executePositionExit(
              ctx,
              pos,
              balance,
              pUsd,
              balance.rawAmount,
              'spread-velocity-exit'
            );
            return;
          }
        }
      }

      // --- Time-based Exit ---
      const ageMin = ageSec / 60;
      const maxHoldMinutesResolved = Number(
        pos.maxHoldMinutesResolved || ctx.config.maxHoldMinutes || 20
      );
      if (
        ageMin >= maxHoldMinutesResolved &&
        pUsd < pos.entryPriceUsd * ctx.config.timeExitMinMultiple
      ) {
        ctx.logger(
          `Max hold time reached for ${pos.symbol} (${ageMin.toFixed(1)}m); exiting.`,
          'trade'
        );
        await monitorService.executePositionExit(
          ctx,
          pos,
          balance,
          pUsd,
          balance.rawAmount,
          'time-exit'
        );
        return;
      }

      // --- Take Profit Targets ---
      while (pos.targetsHit! < multiples.length) {
        const nextM = multiples[pos.targetsHit!]!;
        const targetP = pos.entryPriceUsd * nextM;
        const minTpM = 1 + 0.5 * (nextM - 1);
        const minTpP = pos.entryPriceUsd * minTpM;

        if (pUsd >= minTpP) {
          if (!pos.minTpReached) {
            pos.minTpReached = true;
            pos.minTpFirstReachedAt = Date.now();
          } else if (
            !pos.minTpArmed &&
            Date.now() - (pos.minTpFirstReachedAt || 0) >= MOMENTUM_FILTERS.minMidpointGuardDelayMs
          ) {
            pos.minTpArmed = true;
            ctx.logger(
              `Midpoint Profit Guard ARMED for ${pos.symbol} (Target ${pos.targetsHit! + 1}).`,
              'info'
            );
          }
        }

        if (pUsd < targetP) break;

        const freshBalance = await tradingService.getWalletTokenBalance(
          ctx,
          pos.mint,
          PRIORITY.HIGH
        );
        if (await monitorService.sellTakeProfit(ctx, pos, freshBalance, pUsd, nextM)) {
          pos.minTpReached = false;
          pos.minTpFirstReachedAt = null;
          pos.minTpArmed = false;
          ctx.store.upsertPosition(pos);
        } else {
          break;
        }
      }
    },
    { concurrency: ctx.config.scanParallelismLight || 5 }
  );
}

/**
 * Closes all open positions, typically used during bot shutdown.
 * @param ctx - The application context.
 * @param fetchPricesBestEffort - Function to fetch current prices for mints.
 * @param reason - The reason for closing all positions.
 */
export async function closeAllOpenPositions(
  ctx: Context,
  fetchPricesBestEffort: (
    ctx: Context,
    mints: string[],
    label: string,
    apiKey?: string
  ) => Promise<Record<string, PriceRecord>>,
  reason = 'shutdown-exit'
): Promise<void> {
  const mints = Array.from(ctx.state.positions.keys());
  if (mints.length === 0) {
    ctx.logger('No positions to close.');
    return;
  }

  ctx.logger(`Closing ${mints.length} positions for shutdown...`, 'warn', { console: true });
  const prices = await fetchPricesBestEffort(
    ctx,
    mints,
    'shutdown exit',
    ctx.config.jupiterPositionApiKey
  );

  for (const mint of mints) {
    const pos = ctx.state.positions.get(mint);
    if (!pos) continue;
    try {
      const bal = await tradingService.getWalletTokenBalance(ctx, mint, PRIORITY.HIGH);
      if (bal.rawAmount <= 0n) {
        ctx.store.removePosition(mint);
        continue;
      }
      const p = Number(prices[mint]?.usdPrice || pos.lastKnownPriceUsd || pos.entryPriceUsd || 0);
      await monitorService.executePositionExit(ctx, pos, bal, p, bal.rawAmount, reason);
    } catch (e: unknown) {
      ctx.logger(
        `Failed to close ${pos.symbol || mint}: ${e instanceof Error ? e.message : String(e)}`,
        'error',
        { console: true }
      );
    }
  }
}

/**
 * Service object to allow for easier mocking in ESM environments.
 */
export const monitorService = {
  incrementExitReasonMetric,
  executePositionExit,
  sellTakeProfit,
  buildExitAccounting,
  getTakeProfitPlan,
  getTakeProfitFraction,
  computeTakeProfitSellAmount,
  getMoodAdjustments,
  recordTradeResult,
  recordClosedTrade,
  startCoolDown,
  monitorPositions,
  closeAllOpenPositions,
};
