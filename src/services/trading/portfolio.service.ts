import { Context, TokenMetadata } from '../../types/index.js';
import { atomicToDecimalString } from '../../core/utils.js';

/**
 * Calculates the current session drawdown based on SOL balance.
 * Uses starting balance and peak balance tracked in the state.
 */
export function calculateDrawdown(ctx: Context): {
  drawdownPct: number;
  isCritical: boolean;
  currentSol: number;
} {
  const currentSol = ctx.config.paperTrading
    ? Number(atomicToDecimalString(ctx.state.paperSolBalanceLamports, 9, 9))
    : 0; // Live wallet balance check would go here if needed, but paper is easier to track in state
  const peakSol = Number(
    atomicToDecimalString(ctx.state.peakSessionSolBalanceLamports || '0', 9, 9)
  );

  if (peakSol <= 0) return { drawdownPct: 0, isCritical: false, currentSol };

  const drawdownPct = (peakSol - currentSol) / peakSol;
  const isCritical = drawdownPct >= ctx.config.maxDailyDrawdownPct;

  return { drawdownPct, isCritical, currentSol };
}

/**
 * Checks if a new buy is permitted based on global portfolio risk rules.
 */
export function canBuy(ctx: Context, token: TokenMetadata): { approved: boolean; reason?: string } {
  // 1. Drawdown Check
  const { drawdownPct, isCritical } = calculateDrawdown(ctx);
  if (isCritical) {
    return {
      approved: false,
      reason: `Critical drawdown: ${(drawdownPct * 100).toFixed(2)}% exceeds limit of ${(ctx.config.maxDailyDrawdownPct * 100).toFixed(2)}%`,
    };
  }

  // 2. Sector Concentration Check
  if (token.launchpad) {
    const launchpad = token.launchpad.toLowerCase();
    const concurrentInSector = Array.from(ctx.state.positions.values()).filter(
      (pos) => pos.launchpad?.toLowerCase() === launchpad
    ).length;

    if (concurrentInSector >= ctx.config.maxPositionsPerLaunchpad) {
      return {
        approved: false,
        reason: `Max concurrent positions for ${token.launchpad} reached (${concurrentInSector})`,
      };
    }
  }

  return { approved: true };
}

/**
 * Returns a dynamically adjusted buy size based on recent performance.
 * Implementation: Reduces size by 50% if the last 3 trades were losses.
 */
export function getAdjustedBuySize(ctx: Context, baseSizeLamports: bigint): bigint {
  if (!ctx.config.dynamicSizingEnabled) return baseSizeLamports;

  const recentTrades = ctx.state.closedTrades.slice(-3);
  if (recentTrades.length === 3 && recentTrades.every((t) => t.realizedPnlUsd < 0)) {
    return baseSizeLamports / 2n;
  }

  return baseSizeLamports;
}

/**
 * Service object for Portfolio Management.
 */
export const portfolioService = {
  calculateDrawdown,
  canBuy,
  getAdjustedBuySize,
};
