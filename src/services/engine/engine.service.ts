import {
  formatUsd,
  ratioToPercentString,
  clamp,
  computeStandardDeviation,
} from '../../core/utils.js';
import {
  BURN_OWNERS,
  DEFAULT_LAUNCHPAD_PROFILES,
  SCORING_WEIGHTS,
  MOMENTUM_FILTERS,
} from '../../core/config.js';
import * as audit from '../audit/audit.service.js';
import {
  Context,
  TokenMetadata,
  LaunchpadProfile,
  EvaluationResult,
  AdjustedThresholds,
  MintSignals,
} from '../../types/index.js';

interface PricePoint {
  price: number;
  timestamp: number;
}

/**
 * Retrieves the profile for a given launchpad.
 * @param launchpad - The name of the launchpad.
 * @returns The launchpad profile object.
 */
export function getLaunchpadProfile(launchpad: unknown): LaunchpadProfile & { name: string } {
  const normalized =
    typeof launchpad === 'string' && launchpad.trim() ? launchpad.trim().toLowerCase() : 'unknown';
  const defaultProfiles: Record<string, LaunchpadProfile> = DEFAULT_LAUNCHPAD_PROFILES;
  const profile = defaultProfiles[normalized];
  if (!profile) {
    return {
      name: 'unknown',
      scoreBonus: 0,
      liquidityMultiplier: 1,
      holderMultiplier: 1,
      buysMultiplier: 1,
      minPoolAgeSeconds: 0,
    };
  }
  return { name: normalized, ...profile };
}

/**
 * Normalizes a potential numeric value, falling back to a default if invalid.
 * @param value - The value to normalize.
 * @param fallback - The fallback value if normalization fails (default: 0).
 * @returns A finite number.
 */
export function finiteNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

/**
 * Normalizes a raw price point object into a validated PricePoint.
 * @param point - The raw price point object.
 * @returns A validated PricePoint or null if invalid.
 */
function normalizePricePoint(point: Record<string, unknown>): PricePoint | null {
  const price = finiteNumber(point?.price, NaN);
  const timestamp = finiteNumber(point?.timestamp, NaN);
  if (!(price > 0) || !Number.isFinite(timestamp)) return null;
  return { price, timestamp };
}

/**
 * Filters and normalizes a price history array.
 * @param priceHistory - The raw price history array.
 * @returns An array of validated PricePoints.
 */
function getValidPriceHistory(priceHistory: unknown[]): PricePoint[] {
  if (!Array.isArray(priceHistory)) return [];
  return priceHistory
    .map((p) => normalizePricePoint(p as Record<string, unknown>))
    .filter((p): p is PricePoint => p !== null);
}

/**
 * Calculates adjusted audit thresholds based on the launchpad profile.
 */
export function getLaunchpadAdjustedThresholds(
  ctx: Context,
  profile: LaunchpadProfile & { name: string }
): AdjustedThresholds {
  const defaults = {
    minLiquidityUsd: ctx.config.minLiquidityUsd,
    minHolderCount: ctx.config.minHolderCount,
    minBuys5m: ctx.config.minBuys5m,
    minPoolAgeSeconds: ctx.config.minPoolAgeSeconds,
  };
  if (!profile || profile.name === 'unknown') return defaults;
  return {
    minLiquidityUsd: defaults.minLiquidityUsd * (profile.liquidityMultiplier || 1),
    minHolderCount: defaults.minHolderCount * (profile.holderMultiplier || 1),
    minBuys5m: defaults.minBuys5m * (profile.buysMultiplier || 1),
    minPoolAgeSeconds:
      profile.minPoolAgeSeconds !== undefined
        ? profile.minPoolAgeSeconds
        : defaults.minPoolAgeSeconds,
  };
}

/**
 * Computes a score for a token candidate based on various heuristics.
 * @param token - The token object.
 * @param profile - The launchpad profile.
 * @param thresholds - The adjusted thresholds.
 * @param socialLinks - Number of social links identified.
 * @returns The candidate score (0-100).
 */
export function computeCandidateScore(
  token: TokenMetadata,
  profile: LaunchpadProfile,
  thresholds: AdjustedThresholds,
  socialLinks: number
): number {
  let score = 50;
  if (profile.scoreBonus) score += profile.scoreBonus;
  if (socialLinks >= 3) score += SCORING_WEIGHTS.socialLinkHigh;
  else if (socialLinks >= 1) score += SCORING_WEIGHTS.socialLinkLow;
  if (token.isVerified) score += SCORING_WEIGHTS.isVerified;
  const organicScore = Number(token.organicScore);
  if (Number.isFinite(organicScore)) {
    score += clamp(
      organicScore,
      -SCORING_WEIGHTS.organicScoreClamp,
      SCORING_WEIGHTS.organicScoreClamp
    );
  }
  const liquidityRatio = finiteNumber(token.liquidity) / thresholds.minLiquidityUsd;
  if (liquidityRatio > 5) score += SCORING_WEIGHTS.liquidityRatioHigh;
  else if (liquidityRatio > 2) score += SCORING_WEIGHTS.liquidityRatioLow;
  return clamp(score, 0, 100);
}

/**
 * Determines if a token matches the memecoin heuristic based on name, symbol, or source.
 * @param ctx - The application context.
 * @param token - The token object.
 * @returns True if it looks like a memecoin.
 */
export function looksLikeMemecoin(ctx: Context, token: TokenMetadata): boolean {
  if (token.launchpad) return true;

  const text = `${token.name || ''} ${token.symbol || ''}`.toLowerCase();
  const hasKeyword = ctx.config.memeKeywords.some((keyword) => text.includes(keyword));
  const isWithinFdv = Number(token.fdv || 0) <= ctx.config.maxMemeFdvUsd;

  if (hasKeyword && isWithinFdv) return true;
  if (token.isVerified && isWithinFdv) return true;
  if (Number(token.organicScore || 0) > 0 && isWithinFdv) return true;

  return false;
}

/**
 * Counts the number of social links (website, twitter, telegram) present for a token.
 * @param token - The token object.
 * @returns The count of social links.
 */
export function countSocialLinks(token: TokenMetadata): number {
  const fields: (keyof TokenMetadata)[] = ['website', 'twitter', 'telegram'];
  return fields.reduce((count, key) => count + (token[key] ? 1 : 0), 0);
}

/**
 * Determines whether a token snapshot comes from a reduced-fidelity historical backfill.
 * @param token - The token snapshot.
 * @returns True if optional Jupiter-style metrics should be treated as absent-but-acceptable.
 */
export function isReducedHistoricalSnapshot(token: TokenMetadata): boolean {
  return (
    token?.snapshotQuality === 'reduced-historical' ||
    token?.historicalSource === 'geckoterminal' ||
    token?.historicalSource === 'dexscreener'
  );
}

/**
 * Checks if a value is borderline below a required threshold.
 * @param ctx - The application context.
 * @param actual - The actual value.
 * @param required - The required threshold.
 * @returns True if borderline.
 */
export function isSlightlyBelowThreshold(
  ctx: Context,
  actual: number | string,
  required: number
): boolean {
  const numericActual = Number(actual);
  if (!(required > 0) || !Number.isFinite(numericActual)) return false;
  return numericActual >= required * (1 - ctx.config.borderlineThresholdBufferRatio);
}

/**
 * Applies advanced momentum filters to a token candidate.
 * @param ctx - The application context.
 * @param priceHistory - Normalized price history.
 * @param currentPrice - Current token price in USD.
 * @param now - Current timestamp.
 * @param startDelayPrice - Price at the start of the survival delay.
 * @param token - Token metadata.
 * @param tapeHistory - Transaction tape history.
 * @param addBlocker - Callback to add a rejection reason.
 */
function applyMomentumFilters(
  ctx: Context,
  priceHistory: PricePoint[],
  currentPrice: number,
  now: number,
  startDelayPrice: number,
  token: TokenMetadata,
  tapeHistory: unknown[],
  addBlocker: (message: string, code: string, recheckEligible?: boolean) => void
): void {
  if (priceHistory.length < 6) return;

  const startTime = priceHistory[0]!.timestamp;
  const totalDuration = now - startTime;

  if (totalDuration < ctx.config.earlyPerformanceGuardSeconds * 1000) return;

  const segDuration = totalDuration / 3;
  const s1Time = startTime + segDuration;
  const s2Time = startTime + 2 * segDuration;
  const pStart = startDelayPrice;

  const pS1 = priceHistory.find((h) => h.timestamp >= s1Time)?.price || pStart;
  const pS2 = priceHistory.find((h) => h.timestamp >= s2Time)?.price || pS1;

  const growthS1 = (pS1 - pStart) / pStart;
  const growthS3 = (currentPrice - pS2) / pS2;

  // Stall Filter
  if (growthS1 > 0.05) {
    const stabilityFactor = growthS3 / growthS1;
    const minAccel = ctx.config.minAccelerationFactor ?? MOMENTUM_FILTERS.minAccelerationFactor;
    if (stabilityFactor < minAccel) {
      addBlocker(
        `Momentum stalling (Stall Filter): segment 3 growth (${(growthS3 * 100).toFixed(1)}%) is too low vs segment 1 (${(growthS1 * 100).toFixed(1)}%). factor=${stabilityFactor.toFixed(2)}`,
        'momentum-stalling'
      );
    }
  }

  // Tape Filter (Buy velocity decay)
  if (Array.isArray(tapeHistory) && tapeHistory.length >= 2) {
    const midPointTime = startTime + totalDuration / 2;
    const tapeAtStartSnapshot = tapeHistory[0] as { buys: number; timestamp: number };
    const tapeAtMidSnapshot =
      (tapeHistory as { buys: number; timestamp: number }[]).find(
        (t) => t.timestamp >= midPointTime
      ) ||
      (tapeHistory[Math.floor(tapeHistory.length / 2)] as {
        buys: number;
        timestamp: number;
      });

    const buysFirstHalf = tapeAtMidSnapshot.buys - tapeAtStartSnapshot.buys;
    const buysSecondHalf = Number(token.stats5m?.numBuys || 0) - tapeAtMidSnapshot.buys;

    if (
      buysFirstHalf > MOMENTUM_FILTERS.minBuysFirstHalf &&
      buysSecondHalf < buysFirstHalf * MOMENTUM_FILTERS.buyVelocityDecayFactor
    ) {
      addBlocker(
        `Buy velocity decay (Tape Filter): second-half buys (${buysSecondHalf}) dropped significantly vs first-half (${buysFirstHalf}).`,
        'buy-velocity-decay'
      );
    }
  }

  // Flatline Filter (Price exhaustion)
  const midPointTime = startTime + totalDuration / 2;
  const pMid = priceHistory.find((h) => h.timestamp >= midPointTime)?.price || currentPrice;
  const growthFirstHalf = (pMid - pStart) / pStart;

  if (growthFirstHalf > 0.2) {
    const recentSnapshots = priceHistory.slice(-8);
    if (recentSnapshots.length >= 5) {
      const prices = recentSnapshots.map((s) => s.price).concat(currentPrice);
      const minP = Math.min(...prices);
      const maxP = Math.max(...prices);
      const rangePct = minP > 0 ? ((maxP - minP) / minP) * 100 : Infinity;
      const maxExhaustion =
        ctx.config.maxExhaustionRangePct ?? MOMENTUM_FILTERS.maxExhaustionRangePct;
      if (Number.isFinite(rangePct) && rangePct < maxExhaustion) {
        addBlocker(
          `Price exhaustion (Flatline Filter): vertical spike followed by stagnant range (${rangePct.toFixed(2)}%) at the peak.`,
          'price-exhaustion'
        );
      }
    }
  }

  // Consistency Filter
  const snapshots = priceHistory.concat({ price: currentPrice, timestamp: now });
  let greenSnapshots = 0;
  for (let i = 1; i < snapshots.length; i++) {
    if (snapshots[i]!.price > snapshots[i - 1]!.price) greenSnapshots++;
  }
  const consistencyRatio = greenSnapshots / (snapshots.length - 1);
  const minConsistency =
    ctx.config.minMomentumConsistency ?? MOMENTUM_FILTERS.minMomentumConsistency;
  if (consistencyRatio < minConsistency) {
    addBlocker(
      `Choppy momentum: ${(consistencyRatio * 100).toFixed(1)}% green (min ${(minConsistency * 100).toFixed(0)}% required).`,
      'choppy-momentum'
    );
  }
}

/**
 * Performs a multi-stage evaluation of a token candidate.
 * Applies strategy filters including momentum, liquidity, volume, and audits.
 *
 * @param ctx - The application context.
 * @param token - The token metadata to evaluate.
 * @param highestSeenPriceUsd - The highest price observed for this token.
 * @param priceHistory - Historical price data.
 * @param priceAtStartOfDelay - Price when the evaluation delay started.
 * @param liquidityAtStartOfDelay - Liquidity when the evaluation delay started.
 * @param tapeAtStart - Transaction tape (buys/sells) at the start of delay.
 * @param tapeHistory - Historical transaction tape data.
 * @param depth - Depth of evaluation ('cheap' skips heavy audits).
 * @param priority - RPC priority level.
 * @param preFetchedSignals - Optional pre-fetched mint signals to optimize performance.
 * @returns An evaluation result with approval status and reasons.
 */
export async function evaluateCandidate(
  ctx: Context,
  token: TokenMetadata,
  highestSeenPriceUsd: number | null = null,
  priceHistory: unknown[] = [],
  priceAtStartOfDelay: number | null = null,
  liquidityAtStartOfDelay: number | null = null,
  tapeAtStart: { buys: number; sells: number } | null = null,
  tapeHistory: unknown[] = [],
  depth = 'cheap',
  priority: number | undefined = undefined,
  preFetchedSignals?: MintSignals
): Promise<EvaluationResult> {
  const blockers: string[] = [];
  const rejectionReasons: { code: string; recheckEligible: boolean }[] = [];
  const notes: string[] = [];
  const now = Date.now();
  const firstPoolCreatedAt = token.firstPool?.createdAt
    ? new Date(token.firstPool.createdAt).getTime()
    : null;
  const ageSeconds = Number.isFinite(firstPoolCreatedAt)
    ? Math.floor((now - (firstPoolCreatedAt as number)) / 1000)
    : null;
  const socialLinks = countSocialLinks(token);
  const reducedHistoricalSnapshot = isReducedHistoricalSnapshot(token);

  const usdPrice = finiteNumber(token.usdPrice);
  const liquidity = finiteNumber(token.liquidity);
  const fdv = finiteNumber(token.fdv);
  const holderCount = finiteNumber(token.holderCount);
  const organicScore = finiteNumber(token.organicScore);
  const buys5m = finiteNumber(token.stats5m?.numBuys);
  const sells5m = finiteNumber(token.stats5m?.numSells);

  const validPriceHistory = getValidPriceHistory(priceHistory);
  const launchpadProfile = getLaunchpadProfile(token.launchpad);
  const thresholds = getLaunchpadAdjustedThresholds(ctx, launchpadProfile);
  const entryScore = computeCandidateScore(token, launchpadProfile, thresholds, socialLinks);

  let volatilityScaler = 0;
  if (validPriceHistory.length >= 5) {
    const prices = validPriceHistory.map((h) => h.price);
    const stdDev = computeStandardDeviation(prices);
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    volatilityScaler = mean > 0 ? stdDev / mean : 0;
  }

  const addBlocker = (message: string, code = 'other', recheckEligible = false) => {
    blockers.push(message);
    rejectionReasons.push({ code, recheckEligible });
  };

  // Liquidity Drain Guard
  if (liquidityAtStartOfDelay != null && liquidityAtStartOfDelay > 0) {
    const liqDropRatio = 1 - liquidity / liquidityAtStartOfDelay;
    if (liqDropRatio > ctx.config.maxLiquidityDrawdownPct / 100) {
      addBlocker(
        `Liquidity is draining: ${formatUsd(liquidity)} is ${ratioToPercentString(liqDropRatio)} below start ${formatUsd(liquidityAtStartOfDelay)}.`,
        'liquidity-draining'
      );
    }
  }

  const startDelayPrice = finiteNumber(priceAtStartOfDelay, NaN);
  if (startDelayPrice > 0) {
    const currentPrice = usdPrice;
    const momentum = currentPrice / startDelayPrice;
    const growthPct = (momentum - 1) * 100;

    if (growthPct > ctx.config.maxSurvivalGrowthPct) {
      addBlocker(
        `Parabolic growth detected: ${growthPct.toFixed(1)}% exceeds limit of ${ctx.config.maxSurvivalGrowthPct}%.`,
        'parabolic-growth'
      );
    }
    if (momentum < ctx.config.minSurvivalMomentum) {
      addBlocker(
        `Survival momentum failed: ${momentum.toFixed(3)}x is below required ${ctx.config.minSurvivalMomentum}x.`,
        'low-survival-momentum'
      );
    }
    if (momentum < ctx.config.minBreakoutMultiplier) {
      addBlocker(
        `Minimum breakout failed: ${momentum.toFixed(3)}x is below required ${ctx.config.minBreakoutMultiplier}x threshold.`,
        'low-breakout'
      );
    }

    applyMomentumFilters(
      ctx,
      validPriceHistory,
      currentPrice,
      now,
      startDelayPrice,
      token,
      tapeHistory,
      addBlocker
    );
  }

  const highestSeenPrice = finiteNumber(highestSeenPriceUsd, NaN);
  if (highestSeenPrice > 0) {
    const currentPrice = usdPrice;
    const dropRatio = 1 - currentPrice / highestSeenPrice;
    if (dropRatio > ctx.config.maxPriceDumpPct / 100) {
      addBlocker(
        `Price is dumping: ${formatUsd(currentPrice)} is ${ratioToPercentString(dropRatio)} below peak ${formatUsd(highestSeenPrice)}.`,
        'price-dumping'
      );
    }

    if (startDelayPrice > 0) {
      const growthSinceStart = (currentPrice / startDelayPrice - 1) * 100;
      const isNearAth =
        currentPrice >= highestSeenPrice * (1 - ctx.config.buyTopAthBufferPct / 100);
      if (growthSinceStart > ctx.config.maxBuyTopGrowthPct && isNearAth) {
        addBlocker(
          `Buying the top detected: Growth since start is ${growthSinceStart.toFixed(1)}% and price is near ATH. Waiting for pullback.`,
          'buying-the-top',
          true
        );
      }
    }
  }

  // Sell Pressure Guard
  if (tapeAtStart) {
    const startBuys = finiteNumber(tapeAtStart.buys);
    const startSells = finiteNumber(tapeAtStart.sells);
    const buysDelta = buys5m - startBuys;
    const sellsDelta = sells5m - startSells;
    if (sellsDelta > 0) {
      const effectiveBuysDelta = Math.max(1, buysDelta);
      const sellRatio = sellsDelta / effectiveBuysDelta;
      const sellPressureIncrease = (sellsDelta / Math.max(1, startSells)) * 100;
      if (sellRatio > 0.8 && sellPressureIncrease > ctx.config.maxSellPressureIncreasePct) {
        addBlocker(
          `High selling pressure: Sells increased by ${sellPressureIncrease.toFixed(1)}% during delay (Sell/Buy ratio: ${sellRatio.toFixed(2)}).`,
          'high-sell-pressure'
        );
      }
    }
  }

  // Static Heuristics & Thresholds
  if (!looksLikeMemecoin(ctx, token)) addBlocker('Does not match heuristic.', 'not-memecoin');
  if (!(usdPrice > 0)) addBlocker('No price.', 'missing-price');
  if (!Number.isFinite(liquidity) || liquidity < thresholds.minLiquidityUsd) {
    addBlocker(
      `Low liquidity ${formatUsd(liquidity)}.`,
      'low-liquidity',
      isSlightlyBelowThreshold(ctx, liquidity, thresholds.minLiquidityUsd)
    );
  }

  if (fdv > 0 && liquidity > 0) {
    const fdvToLiquidity = fdv / liquidity;
    if (fdvToLiquidity > ctx.config.maxFdvToLiquidity) {
      addBlocker(
        `FDV/liquidity too high: ${fdvToLiquidity.toFixed(2)} exceeds ${ctx.config.maxFdvToLiquidity}.`,
        'fdv-liquidity-too-high'
      );
    }
  }

  if (!reducedHistoricalSnapshot) {
    if (!Number.isFinite(holderCount) || holderCount < thresholds.minHolderCount) {
      addBlocker(
        `Low holders ${holderCount}.`,
        'low-holders',
        isSlightlyBelowThreshold(ctx, holderCount, thresholds.minHolderCount)
      );
    }
    if (!Number.isFinite(organicScore) || organicScore < ctx.config.minOrganicScore) {
      addBlocker(`Low organic score ${organicScore}.`, 'low-organic-score');
    }
    if (buys5m < thresholds.minBuys5m) {
      addBlocker(
        `Low 5m buys ${buys5m}.`,
        'low-buys',
        isSlightlyBelowThreshold(ctx, buys5m, thresholds.minBuys5m)
      );
    }
  }

  if (socialLinks < ctx.config.minSocialLinks) {
    addBlocker(`Low social links ${socialLinks}.`, 'low-social-links');
  }
  if (!ctx.config.allowVerifiedTokens && token.isVerified) {
    addBlocker('Verified tokens are disabled by config.', 'verified-token-disabled');
  }

  // Audit Results (from Metadata)
  if (token.audit?.isSus) {
    addBlocker('Jupiter audit marks token as suspicious.', 'jupiter-audit-suspicious');
  }
  if (
    token.audit?.topHoldersPercentage != null &&
    token.audit.topHoldersPercentage > ctx.config.maxAuditTopHoldersPct
  ) {
    addBlocker(
      `Jupiter audit top holders ${token.audit.topHoldersPercentage}% exceeds ${ctx.config.maxAuditTopHoldersPct}%.`,
      'jupiter-audit-top-holders'
    );
  }

  // Age Checks
  if (ageSeconds != null) {
    if (ageSeconds < thresholds.minPoolAgeSeconds) {
      addBlocker(`Too new ${ageSeconds}s.`, 'too-new', true);
    }
    if (ageSeconds > ctx.config.maxCandidateAgeMinutes * 60) {
      addBlocker(`Too old ${(ageSeconds / 60).toFixed(1)}m.`, 'too-old');
    }
  } else {
    notes.push('Missing age data.');
  }

  if (reducedHistoricalSnapshot) {
    if (!(holderCount > 0)) notes.push('Historical backfill is missing holder count.');
    if (!Number.isFinite(Number(token.organicScore)))
      notes.push('Historical backfill is missing organic score.');
    if (!Number.isFinite(Number(token.stats5m?.numBuys)))
      notes.push('Historical backfill is missing 5m buy tape.');
  }

  // Entry Score adjustment based on GMI
  if (!reducedHistoricalSnapshot) {
    let adjustedMinScore = ctx.config.minCandidateScore;
    if (typeof ctx.calculateGMI === 'function') {
      const gmi = ctx.calculateGMI();
      if (gmi < 0.3) {
        adjustedMinScore += 10;
        notes.push(`GMI low (${(gmi * 100).toFixed(1)}%): MinScore +10 (${adjustedMinScore})`);
      } else if (gmi > 0.7) {
        adjustedMinScore -= 5;
        notes.push(`GMI high (${(gmi * 100).toFixed(1)}%): MinScore -5 (${adjustedMinScore})`);
      }
    }
    if (entryScore < adjustedMinScore) {
      addBlocker(
        `Low entry score ${entryScore} (Target ${adjustedMinScore}).`,
        'entry-score-too-low'
      );
    }
  }

  if (blockers.length > 0) {
    return {
      approved: false,
      blockers,
      rejectionReasons,
      notes,
      candidateScore: entryScore,
      volatilityScaler,
      launchpadProfile,
      adjustedThresholds: thresholds,
      token,
    };
  }

  if (depth === 'cheap') {
    return {
      approved: true,
      blockers: [],
      rejectionReasons: [],
      notes,
      candidateScore: entryScore,
      volatilityScaler,
      launchpadProfile,
      adjustedThresholds: thresholds,
      token,
    };
  }

  // Deep Audit
  const [mintSignals, goPlusSignals, bbSignals] = await Promise.all([
    preFetchedSignals
      ? Promise.resolve(preFetchedSignals)
      : audit.auditService.getMintSignals(ctx, token.id, { priority }),
    audit.auditService.fetchGoPlusTokenSignals(ctx, token.id),
    audit.auditService.fetchBubbleMapsSignals(ctx, token.id),
  ]);

  if (mintSignals.mintAuthority) {
    addBlocker(`Mint authority set: ${mintSignals.mintAuthority}`, 'mint-authority-enabled');
  }
  if (mintSignals.freezeAuthority) {
    addBlocker(`Freeze authority set: ${mintSignals.freezeAuthority}`, 'freeze-authority-enabled');
  }
  if (mintSignals.top1Share > ctx.config.maxTokenAccountTop1Pct / 100) {
    addBlocker(
      `High top1 concentration ${ratioToPercentString(mintSignals.top1Share)}.`,
      'top1-concentration'
    );
  }
  if (mintSignals.top5Share > ctx.config.maxTokenAccountTop5Pct / 100) {
    addBlocker(
      `High top5 concentration ${ratioToPercentString(mintSignals.top5Share)}.`,
      'top5-concentration'
    );
  }

  if (goPlusSignals) {
    if (goPlusSignals.status === 'ok') {
      goPlusSignals.blockers.forEach((b) => addBlocker(b, 'goplus-token-signal'));
      notes.push(...goPlusSignals.notes);
    } else {
      notes.push(`GoPlus audit skipped (${goPlusSignals.status}). Relying on on-chain signals.`);
    }
  }

  if (bbSignals) {
    if (bbSignals.status === 'ok') {
      bbSignals.blockers.forEach((b) => addBlocker(b, 'bubblemaps-signal'));
      if (bbSignals.score != null) notes.push(`BubbleMaps score: ${bbSignals.score}`);
    } else {
      notes.push(
        `BubbleMaps audit skipped (${bbSignals.status}). Applying stricter concentration checks.`
      );
      if (mintSignals.top5Share > (ctx.config.maxTokenAccountTop5Pct - 10) / 100) {
        addBlocker(
          `BubbleMaps down and top5 concentration ${ratioToPercentString(mintSignals.top5Share)} is borderline.`,
          'bubblemaps-fail-safe-concentration'
        );
      }
    }
  }

  // Owner Audit
  const owners = Array.from(
    new Set(
      (mintSignals.topAccounts || [])
        .map((a) => a.owner)
        .filter((o): o is string => o !== null && !BURN_OWNERS.has(o))
    )
  );
  if (owners.length > 0) {
    const malicious = await audit.auditService.fetchGoPlusAddressSignals(ctx, owners);
    if (malicious.length > 0) {
      addBlocker(
        `Malicious owners flagged by GoPlus: ${malicious.map((m) => m.address).join(', ')}`,
        'goplus-malicious-owner'
      );
    }
  }

  // Re-entry Gate
  const retired = ctx.state.retiredMints.get(token.id);
  const lastExitPriceUsd = finiteNumber(retired?.lastExitPriceUsd, NaN);
  if (lastExitPriceUsd > 0 && usdPrice > 0) {
    const diff = ((usdPrice - lastExitPriceUsd) / lastExitPriceUsd) * 100;
    if (diff > -ctx.config.reentryDipPct && diff < ctx.config.reentryBreakoutPct) {
      addBlocker(
        `Price distance failed: ${diff.toFixed(2)}% in avoid range.`,
        'price-distance-gate'
      );
    }
  }

  return {
    approved: blockers.length === 0,
    blockers,
    rejectionReasons,
    notes,
    candidateScore: entryScore,
    volatilityScaler,
    launchpadProfile,
    adjustedThresholds: thresholds,
    token,
    mintSignals,
    goPlusTokenSignals: goPlusSignals,
    bubbleMapsSignals: bbSignals,
  };
}
export { countSocialLinks as countSocialLinksHelper };
export { finiteNumber as finiteNumberHelper };
