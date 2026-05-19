'use strict';

// Position risk manager: evaluates exit conditions (SL/TP/trailing/liquidity/time),
// executes sells, updates PnL accounting, and maintains trading mood controls.

const { setTimeout: sleep } = require('node:timers/promises');
const {
  formatUsd,
  atomicToDecimalString,
  ratioToPercentString,
  bigintRatioToNumber,
  clamp,
  sendNotification,
  journalPaperTrade,
  journalClosedTrade,
  runBoundedPool,
} = require('./utils');
const { constants } = require('./config');
const trading = require('./trading');
const audit = require('./audit');

const { TAKE_PROFIT_FRACTION, TAKE_PROFIT_MULTIPLES, MOOD_THRESHOLDS, MOMENTUM_FILTERS } =
  constants;

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

function incrementExitReasonMetric(ctx, reason) {
  if (!ctx?.state?.metrics) return;
  if (
    !ctx.state.metrics.exitReasonCounts ||
    typeof ctx.state.metrics.exitReasonCounts !== 'object'
  ) {
    ctx.state.metrics.exitReasonCounts = {};
  }
  ctx.state.metrics.exitReasonCounts[reason] =
    (ctx.state.metrics.exitReasonCounts[reason] || 0) + 1;
}

/**
 * Executes a sell/exit for a position.
 * @param {Object} ctx - The application context.
 * @param {Object} pos - The position object.
 * @param {Object} balance - The current token balance object.
 * @param {number} pUsd - Current USD price of the token.
 * @param {bigint} sellRaw - Raw amount of tokens to sell.
 * @param {string} reason - The reason for the exit.
 * @param {number} [targetM=null] - The target multiple if it's a take-profit exit.
 * @returns {Promise<boolean>} True if the exit was executed successfully.
 */
async function executePositionExit(ctx, pos, balance, pUsd, sellRaw, reason, targetM = null) {
  if (sellRaw <= 0n) {
    ctx.logger(`Skipping ${reason} for ${pos.symbol}; zero amount.`, 'warn');
    return false;
  }
  if (ctx.config.paperTrading) {
    const quote = await trading.buildPaperSellQuote(
      ctx,
      sellRaw,
      pUsd,
      pos.decimals,
      ctx.config.jupiterPositionApiKey
    );
    const remain = balance.rawAmount - sellRaw;
    const accounting = buildExitAccounting(pos, sellRaw, balance.rawAmount, quote.grossUsdValue);
    ctx.state.paperSolBalanceLamports = (
      BigInt(ctx.state.paperSolBalanceLamports) + quote.outAmount
    ).toString();
    if (reason.startsWith('take-profit')) pos.targetsHit++;
    pos.lastTakeProfitAt = new Date().toISOString();
    pos.lastTakeProfitMultiple = targetM;
    pos.lastKnownBalanceRaw = remain.toString();
    pos.lastKnownPriceUsd = pUsd;
    pos.remainingCostUsd = accounting.remainingCostUsd;
    pos.realizedPnlUsd = (pos.realizedPnlUsd || 0) + accounting.realizedPnlUsd;
    pos.realizedProceedsUsd = (pos.realizedProceedsUsd || 0) + quote.grossUsdValue;
    pos.lastExitReason = reason;
    if (remain > 0n) ctx.state.positions.set(pos.mint, pos);
    else {
      ctx.state.positions.delete(pos.mint);
      const win = pos.realizedPnlUsd > 0;
      recordTradeResult(ctx, win);
      recordClosedTrade(ctx, pos, reason);
      if (win) ctx.state.metrics.profitableTrades++;
      if (reason === 'stop-loss') ctx.state.metrics.stopLosses++;
      if (reason === 'tp-trailing-max-exit') ctx.state.metrics.trailingExits++;
    }
    incrementExitReasonMetric(ctx, reason);
    ctx.persistState();
    journalPaperTrade(ctx, {
      event: remain > 0n ? 'sell' : 'close',
      mint: pos.mint,
      symbol: pos.symbol,
      priceUsd: pUsd,
      tokenAmount: sellRaw.toString(),
      proceedsUsd: quote.grossUsdValue,
      realizedPnlUsd: accounting.realizedPnlUsd,
      reason,
      mode: 'paper',
    });
    ctx.logger(
      `PAPER ${reason} on ${pos.symbol}. SOL out ${atomicToDecimalString(quote.outAmount, 9, 6)}.`,
      'trade'
    );
    return true;
  }
  const isPanic = ['liquidity-exit', 'stop-loss', 'early-performance-guard'].includes(reason);
  const order = await trading.fetchSwapOrder(
    ctx,
    pos.mint,
    constants.SOL_MINT,
    sellRaw.toString(),
    isPanic
  );
  if (ctx.config.dryRun) {
    ctx.logger(`DRY_RUN would sell ${pos.symbol} for ${reason}.`, 'trade');
    return false;
  }
  const sig = await trading.executeSwapOrder(ctx, order);
  await sleep(2000);
  const upBal = await trading.getWalletTokenBalance(ctx, pos.mint);
  const proceeds = Number(atomicToDecimalString(sellRaw, pos.decimals, 9)) * pUsd;
  const acc = buildExitAccounting(pos, sellRaw, balance.rawAmount, proceeds);
  if (reason.startsWith('take-profit')) pos.targetsHit++;
  pos.lastTakeProfitAt = new Date().toISOString();
  pos.lastTakeProfitMultiple = targetM;
  pos.lastKnownBalanceRaw = upBal.rawAmount.toString();
  pos.lastKnownPriceUsd = pUsd;
  pos.remainingCostUsd = acc.remainingCostUsd;
  pos.realizedPnlUsd = (pos.realizedPnlUsd || 0) + acc.realizedPnlUsd;
  pos.realizedProceedsUsd = (pos.realizedProceedsUsd || 0) + proceeds;
  pos.lastExitReason = reason;
  pos.lastSellSignature = sig;
  const totalT = Array.isArray(pos.takeProfitMultiples)
    ? pos.takeProfitMultiples.length
    : TAKE_PROFIT_MULTIPLES.length;
  if (pos.targetsHit >= totalT || upBal.rawAmount <= 0n) {
    if (upBal.rawAmount <= 0n) {
      ctx.state.positions.delete(pos.mint);
      const win = pos.realizedPnlUsd > 0;
      recordTradeResult(ctx, win);
      recordClosedTrade(ctx, pos, reason);
      if (win) ctx.state.metrics.profitableTrades++;
      if (reason === 'stop-loss') ctx.state.metrics.stopLosses++;
      if (reason === 'tp-trailing-max-exit') ctx.state.metrics.trailingExits++;
      startCoolDown(ctx, pos.mint, pUsd);
    } else ctx.state.positions.set(pos.mint, pos);
  } else ctx.state.positions.set(pos.mint, pos);
  incrementExitReasonMetric(ctx, reason);
  ctx.persistState();
  const pnlUsd = acc.realizedPnlUsd;
  const roi = (pnlUsd / Number(pos.entryUsdValue)) * 100;
  const msg = `📉 <b>EXIT: ${pos.symbol}</b>\nReason: ${reason}\nPrice: ${formatUsd(pUsd)}\nPnL: ${formatUsd(pnlUsd)} (${roi.toFixed(2)}%)`;
  await sendNotification(ctx, msg);
  ctx.logger(`Sold ${pos.symbol} for ${reason}. sig ${sig}.`, 'trade');
  return true;
}

/**
 * Executes a take-profit sell for a position.
 * @param {Object} ctx - The application context.
 * @param {Object} pos - The position object.
 * @param {Object} balance - The current token balance object.
 * @param {number} pUsd - Current USD price of the token.
 * @param {number} targetM - The take-profit target multiple.
 * @returns {Promise<boolean>}
 */
async function sellTakeProfit(ctx, pos, balance, pUsd, targetM) {
  const frac = getTakeProfitFraction(pos, pos.targetsHit);
  const amt = computeTakeProfitSellAmount(balance.rawAmount, frac);
  return executePositionExit(ctx, pos, balance, pUsd, amt, `take-profit-${targetM}x`, targetM);
}

/**
 * Builds accounting information for a position exit.
 * @param {Object} pos - The position object.
 * @param {bigint} sellRaw - Raw amount sold.
 * @param {bigint} balRaw - Raw balance before sell.
 * @param {number} proceeds - Total USD proceeds from the sell.
 * @returns {Object} Accounting details including realized PnL and remaining cost.
 */
function buildExitAccounting(pos, sellRaw, balRaw, proceeds) {
  const ratio = bigintRatioToNumber(sellRaw, balRaw);
  const costSold = Number(pos.remainingCostUsd || 0) * ratio;
  return {
    realizedPnlUsd: proceeds - costSold,
    remainingCostUsd: Math.max(0, Number(pos.remainingCostUsd || 0) - costSold),
  };
}

/**
 * Constructs a take-profit plan for a new position based on configuration and score.
 * @param {Object} ctx - The application context.
 * @param {number} score - The candidate score of the token.
 * @returns {Object} The take-profit plan.
 */
function getTakeProfitPlan(ctx, score) {
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
 * @param {Object} pos - The position object.
 * @param {number} targetIndex - The index of the take-profit target.
 * @returns {number} The fraction to sell (0-1).
 */
function getTakeProfitFraction(pos, targetIndex) {
  return Array.isArray(pos.takeProfitFractions) &&
    Number.isFinite(pos.takeProfitFractions[targetIndex])
    ? clamp(pos.takeProfitFractions[targetIndex], 0, 1)
    : TAKE_PROFIT_FRACTION;
}

/**
 * Calculates the raw token amount to sell based on a fraction of the balance.
 * @param {bigint} balRaw - The raw balance.
 * @param {number} frac - The fraction to sell.
 * @returns {bigint} The raw amount to sell.
 */
function computeTakeProfitSellAmount(balRaw, frac) {
  return (balRaw * BigInt(Math.max(1, Math.round(frac * 10000)))) / 10000n;
}

function getMoodAdjustments(ctx) {
  let sizeMultiplier = 1.0,
    isPaused = false;
  if (ctx.state.moodPauseUntil && Date.now() < ctx.state.moodPauseUntil) isPaused = true;
  else {
    const history = ctx.state.tradeHistory || [],
      last10 = history.slice(-MOOD_THRESHOLDS.windowLarge),
      last5 = history.slice(-MOOD_THRESHOLDS.windowSmall);
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
      ctx.state.moodPauseUntil = Date.now() + ctx.config.moodPauseDurationMinutes * 60000;
      ctx.logger(
        `Daily Mood: CRITICAL. Pausing for ${ctx.config.moodPauseDurationMinutes}m.`,
        'warn',
        { console: true }
      );
    } else if (winRate5 < MOOD_THRESHOLDS.winRateCautious) {
      sizeMultiplier = MOOD_THRESHOLDS.sizeMultiplierCautious;
      ctx.logger(`Daily Mood: CAUTIOUS. Reducing size 50%.`, 'warn', { console: true });
    }
  }
  return { sizeMultiplier, isPaused };
}

function recordTradeResult(ctx, isWin) {
  ctx.state.tradeHistory.push(isWin);
  if (ctx.state.tradeHistory.length > 50) ctx.state.tradeHistory.shift();
  ctx.persistState();
}

function recordClosedTrade(ctx, pos, reason) {
  if (!ctx?.state) return;
  if (!Array.isArray(ctx.state.closedTrades)) ctx.state.closedTrades = [];
  const openedAtMs = new Date(pos.openedAt || Date.now()).getTime();
  const trade = {
    mint: pos.mint,
    symbol: pos.symbol,
    exitReason: reason,
    realizedPnlUsd: Number(pos.realizedPnlUsd || 0),
    realizedProceedsUsd: Number(pos.realizedProceedsUsd || 0),
    entryUsdValue: Number(pos.entryUsdValue || 0),
    entryPriceUsd: Number(pos.entryPriceUsd || 0),
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
  ctx.state.closedTrades.push(trade);
  journalClosedTrade(ctx, trade);
}

function getTrailingActivationMultiple(pos) {
  const multiples =
    Array.isArray(pos.takeProfitMultiples) && pos.takeProfitMultiples.length > 0
      ? pos.takeProfitMultiples
      : TAKE_PROFIT_MULTIPLES;
  const firstTarget = Number(multiples[0] || 1.5);
  const midpoint = 1 + 0.5 * (firstTarget - 1);
  return Math.min(midpoint, 1.12);
}

function startCoolDown(ctx, mint, pUsd) {
  const expires = Date.now() + ctx.config.coolDownMinutes * 60000;
  ctx.state.coolDownMints.set(mint, { expiresAt: expires, lastExitPriceUsd: pUsd });
}

async function monitorPositions(ctx, fetchPricesBestEffort) {
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
      let balance = await trading.getWalletTokenBalance(ctx, mint);
      if (balance.rawAmount <= 0n) {
        ctx.logger(`Position ${pos.symbol} zero balance; removing.`, 'warn');
        ctx.state.positions.delete(mint);
        ctx.persistState();
        return;
      }

      const snap = ctx.state.marketSnapshots.get(mint);
      const pRecord = prices[mint];
      const pUsd = Number(pRecord?.usdPrice || snap?.usdPrice || 0);

      // Update fresh liquidity data into the position and snapshot for better rug detection
      if (pRecord?.liquidity != null) {
        pos.lastKnownLiquidityUsd = pRecord.liquidity;
        if (snap) {
          snap.liquidity = pRecord.liquidity;
          snap.usdPrice = pUsd;
          snap.observedAt = new Date().toISOString();
          ctx.state.marketSnapshots.set(mint, snap);
        }
      } else if (snap?.liquidity != null) {
        pos.lastKnownLiquidityUsd = snap.liquidity;
      }

      if (!(pUsd > 0)) {
        if (pos.lastKnownLiquidityUsd != null) {
          const floor = Math.max(
            ctx.config.liquidityCollapseThresholdUsd,
            Number(pos.entryLiquidityUsd || 0) * ctx.config.liquidityCollapseThresholdRatio
          );
          if (
            pos.lastKnownLiquidityUsd <= floor &&
            (pos.lastKnownPriceUsd || pos.entryPriceUsd) > 0
          ) {
            await executePositionExit(
              ctx,
              pos,
              balance,
              Number(pos.lastKnownPriceUsd || pos.entryPriceUsd),
              balance.rawAmount,
              'liquidity-exit'
            );
            return;
          }
        }
        ctx.logger(`Price unavailable for ${pos.symbol}; skipping check.`, 'warn');
        return;
      }

      pos.highestPriceUsd = Math.max(Number(pos.highestPriceUsd || pos.entryPriceUsd || 0), pUsd);
      pos.lastKnownBalanceRaw = balance.rawAmount.toString();
      pos.lastKnownPriceUsd = pUsd;

      // Phase 2: Update histories for quant logic
      pos.priceHistory = pos.priceHistory || [];
      pos.priceHistory.push({ price: pUsd, timestamp: Date.now() });
      if (pRecord?.bidPrice > 0 && pRecord?.askPrice > 0) {
        const { computeSpread } = require('./utils');
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

      ctx.state.positions.set(mint, pos);

      // Periodic Security Re-Audit (detecting delayed authorities/freeze) & Holder Drift
      if (!pos.lastSecurityAuditAt || Date.now() - pos.lastSecurityAuditAt > 30000) {
        pos.lastSecurityAuditAt = Date.now();
        try {
          const signals = await audit.getMintSignals(ctx, mint, { priority: 0 }); // Low priority

          // 1. Rug Detection
          if (signals.mintAuthority || signals.freezeAuthority) {
            ctx.logger(
              `SECURITY ALERT: ${pos.symbol} authorities enabled after buy! Mint: ${signals.mintAuthority}, Freeze: ${signals.freezeAuthority}. Emergency Exit.`,
              'warn',
              { console: true }
            );
            await executePositionExit(
              ctx,
              pos,
              balance,
              pUsd,
              balance.rawAmount,
              'security-rug-exit'
            );
            return;
          }

          // 2. Holder Drift Detection (Insider Selling)
          const initialHolders = pos.mintSignals?.topAccounts || [];
          if (initialHolders.length > 0) {
            for (const initial of initialHolders) {
              if (!initial.owner || constants.BURN_OWNERS.has(initial.owner)) continue;

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
                    await executePositionExit(
                      ctx,
                      pos,
                      balance,
                      pUsd,
                      computeTakeProfitSellAmount(balance.rawAmount, 0.4),
                      'insider-drift-exit'
                    )
                  ) {
                    return; // Exit loop for this position after de-risking
                  }
                }
              } else {
                // Address vanished from top 5 - significant liquidation
                ctx.logger(
                  `INSIDER ALERT: Top holder ${initial.owner.slice(0, 8)} exited top 5. De-risking 40%.`,
                  'warn',
                  { console: true }
                );
                if (
                  await executePositionExit(
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
        } catch (err) {
          // Silent fail for re-audit; don't disrupt monitoring
          ctx.logger(`Re-audit failed for ${pos.symbol}: ${err.message}`, 'debug');
        }
      }

      const ageSec = (Date.now() - new Date(pos.openedAt).getTime()) / 1000;
      const liquidityExitFloor =
        pos.lastKnownLiquidityUsd != null
          ? Math.max(
              ctx.config.liquidityCollapseThresholdUsd,
              Number(pos.entryLiquidityUsd || 0) * ctx.config.liquidityCollapseThresholdRatio
            )
          : null;

      // 1. Midpoint Profit Guard Exit Check (Highest Priority for profit preservation)
      const multiples = Array.isArray(pos.takeProfitMultiples)
        ? pos.takeProfitMultiples
        : TAKE_PROFIT_MULTIPLES;
      if (pos.minTpArmed && pos.targetsHit < multiples.length) {
        const nextM = multiples[pos.targetsHit];
        const minTpM = 1 + 0.5 * (nextM - 1);
        const minTpP = pos.entryPriceUsd * minTpM;
        if (pUsd < minTpP) {
          ctx.logger(
            `Price fell back to midpoint ${formatUsd(minTpP)} for ${pos.symbol} (Target ${pos.targetsHit + 1}). Midpoint exit.`,
            'trade'
          );
          if (
            await executePositionExit(
              ctx,
              pos,
              balance,
              pUsd,
              balance.rawAmount,
              'adaptive-tp-exit'
            )
          )
            ctx.logger(`${pos.symbol} entered cool-down.`, 'info');
          return;
        }
      }

      // 2. Performance Guards
      if (ageSec <= ctx.config.earlyPerformanceGuardSeconds && pos.targetsHit === 0) {
        const drop = (pos.entryPriceUsd - pUsd) / pos.entryPriceUsd;
        const buyCollapse =
          Array.isArray(pos.tapeHistory) &&
          pos.tapeHistory.length >= 2 &&
          pos.tapeHistory[pos.tapeHistory.length - 1].buys -
            pos.tapeHistory[pos.tapeHistory.length - 2].buys ===
            0;
        if (drop > ctx.config.earlyPerformanceDropPct / 100 || buyCollapse) {
          ctx.logger(
            `Early Guard for ${pos.symbol}: drop ${(drop * 100).toFixed(1)}% or buy collapse. Selling ${ctx.config.earlyPerformanceSellPct}%.`,
            'warn',
            { console: true }
          );
          await executePositionExit(
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

      // 3. Risk Exits (SL, Liquidity)
      const baseSlPct = ctx.config.stopLossPct;
      const adjustedSlPct = baseSlPct * (1 + (pos.volatilityScaler || 0));
      const slP = pos.entryPriceUsd * (1 - adjustedSlPct);
      const slWP = pos.entryPriceUsd * (1 - adjustedSlPct / 2);

      if (pUsd <= slWP && !pos.stopLossWarningSent) {
        pos.stopLossWarningSent = true;
        ctx.logger(
          `WARNING: ${pos.symbol} half-SL. Drawdown: ${((1 - pUsd / pos.entryPriceUsd) * 100).toFixed(2)}% (Adjusted SL: ${(adjustedSlPct * 100).toFixed(1)}%). SL at ${formatUsd(slP)}.`,
          'warn',
          { console: true }
        );
        ctx.state.positions.set(mint, pos);
      }
      if (pUsd <= slP) {
        await executePositionExit(ctx, pos, balance, pUsd, balance.rawAmount, 'stop-loss');
        return;
      }

      if (pos.lastKnownLiquidityUsd != null && pos.lastKnownLiquidityUsd <= liquidityExitFloor) {
        await executePositionExit(ctx, pos, balance, pUsd, balance.rawAmount, 'liquidity-exit');
        return;
      }

      // 4. Trailing Stop & Time Exits
      if (!pos.trailingArmed) {
        const activationMultiple = getTrailingActivationMultiple(pos);
        if (pUsd >= pos.entryPriceUsd * activationMultiple) {
          pos.trailingArmed = true;
          ctx.state.positions.set(mint, pos);
        }
      }

      if (ageSec < ctx.config.minHoldTimeSeconds) return;

      if (
        ageSec > ctx.config.performanceCheckSeconds &&
        pos.targetsHit === 0 &&
        pUsd < pos.entryPriceUsd * ctx.config.performanceMinMomentum
      ) {
        await executePositionExit(
          ctx,
          pos,
          balance,
          pUsd,
          balance.rawAmount,
          'no-early-performance'
        );
        return;
      }

      let trailingDrawdownPct = Number(
        pos.trailingStopDrawdownPctResolved || ctx.config.trailingStopDrawdownPct || 0.2
      );

      // Acceleration: Tighten stop-loss as price discovery moves further from entry
      const currentMultiple = pUsd / pos.entryPriceUsd;
      if (currentMultiple > 1.8) {
        const acceleration = Math.min(0.12, (currentMultiple - 1.8) * 0.04);
        trailingDrawdownPct = Math.max(0.04, trailingDrawdownPct - acceleration);
      }

      const trailP = (pos.highestPriceUsd || pUsd) * (1 - trailingDrawdownPct);
      if (pos.trailingArmed && pUsd < trailP) {
        ctx.logger(
          `Price ${formatUsd(pUsd)} below ${ratioToPercentString(1 - trailingDrawdownPct)} of peak (${formatUsd(pos.highestPriceUsd)}). Accelerated TP Exit for ${pos.symbol}.`,
          'trade'
        );
        await executePositionExit(
          ctx,
          pos,
          balance,
          pUsd,
          balance.rawAmount,
          'tp-trailing-max-exit'
        );
        return;
      }

      // 6. Spread Velocity (Pre-Rug Exit)
      if (Array.isArray(pos.spreadHistory) && pos.spreadHistory.length >= 2) {
        const last = pos.spreadHistory[pos.spreadHistory.length - 1];
        const prev = pos.spreadHistory[pos.spreadHistory.length - 2];
        const timeDiff = (last.timestamp - prev.timestamp) / 1000;
        if (timeDiff <= 15) {
          const spreadIncrease = last.spread / prev.spread - 1;
          if (spreadIncrease > 0.5) {
            ctx.logger(
              `SPREAD VELOCITY ALERT: Spread widened by ${(spreadIncrease * 100).toFixed(1)}% for ${pos.symbol}. Pre-Rug Exit.`,
              'warn',
              { console: true }
            );
            await executePositionExit(
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

      const ageMin = ageSec / 60;
      const maxHoldMinutesResolved = Number(
        pos.maxHoldMinutesResolved || ctx.config.maxHoldMinutes || 20
      );
      if (
        ageMin >= maxHoldMinutesResolved &&
        pUsd < pos.entryPriceUsd * ctx.config.timeExitMinMultiple
      ) {
        await executePositionExit(ctx, pos, balance, pUsd, balance.rawAmount, 'time-exit');
        return;
      }

      // 5. Take Profit Arming and Selling
      while (pos.targetsHit < multiples.length) {
        const nextM = multiples[pos.targetsHit],
          targetP = pos.entryPriceUsd * nextM;
        const minTpM = 1 + 0.5 * (nextM - 1),
          minTpP = pos.entryPriceUsd * minTpM;
        if (pUsd >= minTpP) {
          if (!pos.minTpReached) {
            pos.minTpReached = true;
            pos.minTpFirstReachedAt = Date.now();
            ctx.logger(
              `Adaptive minTP ${minTpM.toFixed(2)}x touched for ${pos.symbol} (Target ${pos.targetsHit + 1}).`,
              'debug'
            );
          } else if (
            !pos.minTpArmed &&
            Date.now() - pos.minTpFirstReachedAt >= MOMENTUM_FILTERS.minMidpointGuardDelayMs
          ) {
            pos.minTpArmed = true;
            ctx.logger(
              `Midpoint Profit Guard ARMED for ${pos.symbol} (Target ${pos.targetsHit + 1}).`,
              'info'
            );
          }
        }
        if (pUsd < targetP) break;
        // Refresh balance after each partial sell so the next target uses the updated amount.
        const freshBalance = await trading.getWalletTokenBalance(ctx, pos.mint);
        if (!(await sellTakeProfit(ctx, pos, freshBalance, pUsd, nextM))) break;
        balance = freshBalance;
        pos.minTpReached = false;
        pos.minTpFirstReachedAt = null;
        pos.minTpArmed = false;
      }
    },
    { concurrency: ctx.config.scanParallelismLight || 5 }
  );
}

async function closeAllOpenPositions(ctx, fetchPricesBestEffort, reason = 'shutdown-exit') {
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
      const bal = await trading.getWalletTokenBalance(ctx, mint);
      if (bal.rawAmount <= 0n) {
        ctx.state.positions.delete(mint);
        ctx.persistState();
        continue;
      }
      let p = Number(prices[mint]?.usdPrice || pos.lastKnownPriceUsd || pos.entryPriceUsd || 0);
      await executePositionExit(ctx, pos, bal, p, bal.rawAmount, reason);
    } catch (e) {
      ctx.logger(`Failed to close ${pos.symbol || mint}: ${e.message}`, 'error', { console: true });
    }
  }
}

module.exports = {
  monitorPositions,
  closeAllOpenPositions,
  getMoodAdjustments,
  getTakeProfitPlan,
  startCoolDown,
  recordTradeResult,
  recordClosedTrade,
  getTakeProfitFraction,
  computeTakeProfitSellAmount,
  incrementExitReasonMetric,
};
