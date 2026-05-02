'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { PublicKey, VersionedTransaction } = require('@solana/web3.js');
const { 
  formatUsd, 
  atomicToDecimalString, 
  decimalToAtomic, 
  ratioToPercentString, 
  bigintRatioToNumber,
  clamp,
  log 
} = require('./utils');
const { constants } = require('./config');

const { 
  SOL_MINT, 
  BURN_OWNERS, 
  DEFAULT_LAUNCHPAD_PROFILES, 
  TAKE_PROFIT_FRACTION, 
  TAKE_PROFIT_MULTIPLES,
  TP_SELL_PERCENT,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_FETCH_RETRIES,
  DEFAULT_FETCH_RETRY_DELAY_MS
} = constants;

// --- API Helpers ---

async function fetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_FETCH_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_FETCH_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_FETCH_RETRY_DELAY_MS;
  const headers = { Accept: 'application/json', ...(options.headers || {}) };

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      let data = null;
      if (text) {
        try { data = JSON.parse(text); } catch (e) { throw new Error(`Failed to parse JSON from ${url}: ${e.message}`); }
      }
      if (!response.ok) {
        const details = data ? JSON.stringify(data) : text;
        throw new Error(`HTTP ${response.status} for ${url}: ${details}`);
      }
      return data;
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !isTransientFetchError(error)) {
        throw new Error(formatFetchError(url, error, timeoutMs));
      }
      await sleep(retryDelayMs * (attempt + 1));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(formatFetchError(url, lastError || new Error('Unknown fetch failure'), timeoutMs));
}

function isAbortError(error) {
  return error?.name === 'AbortError' || /aborted/i.test(String(error?.message || ''));
}

function isTransientFetchError(error) {
  const message = String(error?.message || '');
  return (
    isAbortError(error) ||
    /fetch failed/i.test(message) ||
    /ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|socket hang up/i.test(message) ||
    /HTTP 408|HTTP 425|HTTP 429|HTTP 500|HTTP 502|HTTP 503|HTTP 504/i.test(message)
  );
}

function formatFetchError(url, error, timeoutMs) {
  if (isAbortError(error)) return `Request timed out after ${timeoutMs}ms for ${url}`;
  if (String(error?.message || '').includes(url)) return error.message;
  return `Request failed for ${url}: ${error.message}`;
}

async function fetchRecentLaunches(ctx) {
  const url = `${ctx.config.jupiterBaseUrl}/tokens/v2/recent`;
  const data = await fetchJson(url, { headers: { 'x-api-key': ctx.config.jupiterApiKey } });
  if (!Array.isArray(data)) throw new Error('Unexpected Jupiter recent response shape.');
  return data;
}

async function fetchPrices(ctx, mints) {
  if (mints.length === 0) return {};
  const url = `${ctx.config.jupiterBaseUrl}/price/v3?ids=${encodeURIComponent(mints.join(','))}`;
  const data = await fetchJson(url, { headers: { 'x-api-key': ctx.config.jupiterApiKey } });
  if (!data || typeof data !== 'object') throw new Error('Unexpected Jupiter price response shape.');
  return data;
}

async function fetchPricesBestEffort(ctx, mints, contextLabel = 'price refresh') {
  if (mints.length === 0) return {};
  try {
    return await fetchPrices(ctx, mints);
  } catch (error) {
    ctx.logger(`Batch ${contextLabel} failed for ${mints.length} mint(s): ${error.message}. Falling back to per-mint refresh.`, 'warn', { console: true });
  }
  const prices = {};
  await Promise.all(mints.map(async (mint) => {
    try { Object.assign(prices, await fetchPrices(ctx, [mint])); } catch (e) {
      ctx.logger(`Per-mint ${contextLabel} failed for ${mint}: ${e.message}`, 'debug', { console: false });
    }
  }));
  return prices;
}

// --- Analysis Services ---

function getLaunchpadProfile(launchpad) {
  const normalized = (launchpad || 'unknown').trim().toLowerCase();
  return { name: normalized, ...(DEFAULT_LAUNCHPAD_PROFILES[normalized] || {}) };
}

function getLaunchpadAdjustedThresholds(ctx, profile) {
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
    minPoolAgeSeconds: profile.minPoolAgeSeconds !== undefined ? profile.minPoolAgeSeconds : defaults.minPoolAgeSeconds,
  };
}

function computeCandidateScore(token, profile, thresholds, socialLinks, ageSeconds) {
  let score = 50;
  if (profile.scoreBonus) score += profile.scoreBonus;
  if (socialLinks >= 3) score += 15;
  else if (socialLinks >= 1) score += 5;
  if (token.isVerified) score += 10;
  if (Number.isFinite(token.organicScore)) score += clamp(token.organicScore, -20, 20);
  const liquidityRatio = (token.liquidity || 0) / thresholds.minLiquidityUsd;
  if (liquidityRatio > 5) score += 10;
  else if (liquidityRatio > 2) score += 5;
  return clamp(score, 0, 100);
}

function looksLikeMemecoin(ctx, token) {
  const text = `${token.name || ''} ${token.symbol || ''}`.toLowerCase();
  if (token.launchpad) return true;
  if (ctx.config.memeKeywords.some((keyword) => text.includes(keyword))) return true;
  if (Number.isFinite(token.fdv) && token.fdv > 0 && token.fdv <= ctx.config.maxMemeFdvUsd) return true;
  return false;
}

function countSocialLinks(token) {
  return ['website', 'twitter', 'telegram'].reduce((count, key) => count + (token[key] ? 1 : 0), 0);
}

function isSlightlyBelowThreshold(ctx, actual, required) {
  if (!(required > 0) || !Number.isFinite(actual)) return false;
  return actual >= required * (1 - ctx.config.borderlineThresholdBufferRatio);
}

async function getMintSignals(ctx, mint) {
  const parsedAccount = await ctx.connection.getParsedAccountInfo(new PublicKey(mint), 'confirmed');
  const parsed = parsedAccount.value?.data?.parsed;
  if (!parsed || parsed.type !== 'mint') throw new Error(`Mint ${mint} did not return parsed mint data.`);
  
  const mintInfo = parsed.info;
  const largestAccounts = await ctx.connection.getTokenLargestAccounts(new PublicKey(mint), 'confirmed');
  const supplyRaw = BigInt(mintInfo.supply || '0');
  const topAccounts = (largestAccounts.value || []).slice(0, 5).map((account) => {
    const rawAmount = BigInt(account.amount || '0');
    return { address: account.address, rawAmount, share: bigintRatioToNumber(rawAmount, supplyRaw) };
  });

  const top1Share = topAccounts[0]?.share || 0;
  const top5Share = topAccounts.reduce((sum, account) => sum + account.share, 0);
  const ownerDetails = await Promise.all(topAccounts.map(async (account) => {
    try {
      const ownerInfo = await ctx.connection.getParsedAccountInfo(new PublicKey(account.address), 'confirmed');
      const owner = ownerInfo.value?.data?.parsed?.info?.owner || null;
      return { ...account, owner };
    } catch (e) { return { ...account, owner: null, ownerLookupError: e.message }; }
  }));

  return {
    decimals: Number(mintInfo.decimals || 0),
    supplyRaw,
    mintAuthority: mintInfo.mintAuthority || null,
    freezeAuthority: mintInfo.freezeAuthority || null,
    top1Share,
    top5Share,
    topAccounts: ownerDetails,
  };
}

async function fetchGoPlusTokenSignals(ctx, mint) {
  if (!ctx.config.goPlusAccessToken) return null;
  try {
    const url = `${ctx.config.goPlusBaseUrl}/solana/token_security?contract_addresses=${encodeURIComponent(mint)}`;
    const payload = await fetchJson(url, { headers: { Authorization: `Bearer ${ctx.config.goPlusAccessToken}` } });
    const record = payload?.result?.[mint] || payload?.result?.[mint.toLowerCase()] || payload?.data?.[mint] || payload?.data?.[mint.toLowerCase()] || null;
    if (!record) return null;

    const blockers = [];
    const notes = [];
    if (isTruthyFlag(record.is_mintable)) blockers.push('GoPlus reports token is mintable');
    if (isTruthyFlag(record.is_freezable)) blockers.push('GoPlus reports token is freezable');
    if (isTruthyFlag(record.transfer_fee_upgradable)) notes.push('GoPlus reports transfer fee is upgradable');
    if (isTruthyFlag(record.non_transferable)) blockers.push('GoPlus reports token is non-transferable');
    if (isTruthyFlag(record.default_account_state)) notes.push('GoPlus reports custom default account state');
    if (isTruthyFlag(record.trusted_token) === false && record.trusted_token !== undefined) notes.push('GoPlus does not mark the token as trusted');

    return { blockers, notes, raw: record };
  } catch (e) {
    ctx.logger(`GoPlus token security skipped for ${mint}: ${e.message}`, 'warn');
    return null;
  }
}

async function fetchGoPlusAddressSignals(ctx, addresses) {
  if (!ctx.config.goPlusAccessToken) return [];
  const results = [];
  for (const address of addresses) {
    try {
      const url = `${ctx.config.goPlusBaseUrl}/address_security/${address}?chain_id=solana`;
      const payload = await fetchJson(url, { headers: { Authorization: `Bearer ${ctx.config.goPlusAccessToken}` } });
      const record = payload?.result?.[address] || payload?.result?.[address.toLowerCase()] || payload?.data?.[address] || payload?.data?.[address.toLowerCase()] || null;
      if (record && isMaliciousGoPlusAddressRecord(record)) results.push({ address, record });
    } catch (e) { ctx.logger(`GoPlus address security skipped for ${address}: ${e.message}`, 'warn'); }
  }
  return results;
}

function isMaliciousGoPlusAddressRecord(record) {
  return ['malicious_address', 'phishing_activities', 'fake_token', 'blackmail_activities', 'honeypot_related_address', 'money_laundering', 'mixer', 'scam', 'sanctioned'].some((field) => isTruthyFlag(record[field]));
}

function isTruthyFlag(value) {
  if (value === undefined || value === null || value === '' || value === false || value === 0) return false;
  const normalized = String(value).trim().toLowerCase();
  return !['0', 'false', 'null', 'none', 'no'].includes(normalized);
}

async function fetchBubbleMapsSignals(ctx, mint) {
  if (!ctx.config.bubbleMapsApiKey) return null;
  try {
    const params = new URLSearchParams({ return_clusters: 'true', return_decentralization_score: 'true', return_nodes: 'false', use_magic_nodes: 'true' });
    const url = `${ctx.config.bubbleMapsBaseUrl}/maps/solana/${mint}?${params.toString()}`;
    const payload = await fetchJson(url, { headers: { 'X-ApiKey': ctx.config.bubbleMapsApiKey }, timeoutMs: 25000 });
    const largestClusterShare = Array.isArray(payload?.clusters) && payload.clusters.length > 0 ? Number(payload.clusters[0].share || 0) : null;
    const blockers = [];
    if (payload?.decentralization_score != null && Number(payload.decentralization_score) < ctx.config.minBubbleMapsScore) {
      blockers.push(`BubbleMaps decentralization score ${payload.decentralization_score} is below ${ctx.config.minBubbleMapsScore}`);
    }
    if (largestClusterShare != null && largestClusterShare > ctx.config.maxBubbleMapsLargestClusterShare) {
      blockers.push(`BubbleMaps largest cluster share ${ratioToPercentString(largestClusterShare)} is above ${ratioToPercentString(ctx.config.maxBubbleMapsLargestClusterShare)}`);
    }
    return { blockers, score: payload?.decentralization_score ?? null, largestClusterShare, raw: payload };
  } catch (e) { ctx.logger(`BubbleMaps skipped for ${mint}: ${e.message}`, 'warn'); return null; }
}

async function evaluateCandidate(ctx, token, highestSeenPriceUsd = null, priceHistory = [], priceAtStartOfDelay = null, liquidityAtStartOfDelay = null, tapeAtStart = null, tapeHistory = []) {
  const blockers = [];
  const rejectionReasons = [];
  const notes = [];
  const now = Date.now();
  const firstPoolCreatedAt = token.firstPool?.createdAt ? new Date(token.firstPool.createdAt).getTime() : null;
  const ageSeconds = firstPoolCreatedAt ? Math.floor((now - firstPoolCreatedAt) / 1000) : null;
  const socialLinks = countSocialLinks(token);
  const launchpadProfile = getLaunchpadProfile(token.launchpad);
  const thresholds = getLaunchpadAdjustedThresholds(ctx, launchpadProfile);
  const entryScore = computeCandidateScore(token, launchpadProfile, thresholds, socialLinks, ageSeconds);
  const addBlocker = (message, code = 'other', recheckEligible = false) => {
    blockers.push(message);
    rejectionReasons.push({ code, recheckEligible });
  };

  if (liquidityAtStartOfDelay != null && liquidityAtStartOfDelay > 0) {
    const currentLiquidity = Number(token.liquidity || 0);
    const liqDropRatio = 1 - (currentLiquidity / liquidityAtStartOfDelay);
    if (liqDropRatio > ctx.config.maxLiquidityDrawdownPct / 100) {
      addBlocker(`Liquidity is draining: ${formatUsd(currentLiquidity)} is ${ratioToPercentString(liqDropRatio)} below start ${formatUsd(liquidityAtStartOfDelay)}.`, 'liquidity-draining');
    }
  }

  if (priceAtStartOfDelay != null && priceAtStartOfDelay > 0) {
    const currentPrice = Number(token.usdPrice || 0);
    const momentum = currentPrice / priceAtStartOfDelay;
    const growthPct = (momentum - 1) * 100;
    if (growthPct > ctx.config.maxSurvivalGrowthPct) {
      addBlocker(`Parabolic growth detected: ${growthPct.toFixed(1)}% exceeds limit of ${ctx.config.maxSurvivalGrowthPct}%.`, 'parabolic-growth');
    }
    if (momentum < ctx.config.minSurvivalMomentum) {
      addBlocker(`Survival momentum failed: ${momentum.toFixed(3)}x is below required ${ctx.config.minSurvivalMomentum}x.`, 'low-survival-momentum');
    }
    if (momentum < 1.03) {
      addBlocker(`Minimum breakout failed: ${momentum.toFixed(3)}x is below required 1.03x threshold.`, 'low-breakout');
    }

    if (Array.isArray(priceHistory) && priceHistory.length >= 6) {
      const startTime = priceHistory[0].timestamp;
      const totalDuration = now - startTime;
      if (totalDuration >= 20000) {
        const segDuration = totalDuration / 3;
        const s1Time = startTime + segDuration;
        const s2Time = startTime + 2 * segDuration;
        const pStart = priceAtStartOfDelay;
        const pS1 = priceHistory.find(h => h.timestamp >= s1Time)?.price || pStart;
        const pS2 = priceHistory.find(h => h.timestamp >= s2Time)?.price || pS1;
        const growthS1 = (pS1 - pStart) / pStart;
        const growthS3 = (currentPrice - pS2) / pS2;
        if (growthS1 > 0.05) {
          const stabilityFactor = growthS3 / growthS1;
          if (stabilityFactor < 0.4) {
            addBlocker(`Momentum stalling (Stall Filter): segment 3 growth (${(growthS3 * 100).toFixed(1)}%) is too low vs segment 1 (${(growthS1 * 100).toFixed(1)}%). factor=${stabilityFactor.toFixed(2)}`, 'momentum-stalling');
          }
        }
        if (Array.isArray(tapeHistory) && tapeHistory.length >= 2) {
          const midPointTime = startTime + totalDuration / 2;
          const tapeAtStartSnapshot = tapeHistory[0];
          const tapeAtMidSnapshot = tapeHistory.find(t => t.timestamp >= midPointTime) || tapeHistory[Math.floor(tapeHistory.length / 2)];
          const buysFirstHalf = tapeAtMidSnapshot.buys - tapeAtStartSnapshot.buys;
          const buysSecondHalf = Number(token.stats5m?.numBuys || 0) - tapeAtMidSnapshot.buys;
          if (buysFirstHalf > 5 && buysSecondHalf < buysFirstHalf * 0.4) {
            addBlocker(`Buy velocity decay (Tape Filter): second-half buys (${buysSecondHalf}) dropped significantly vs first-half (${buysFirstHalf}).`, 'buy-velocity-decay');
          }
        }
        const midPointTime = startTime + totalDuration / 2;
        const pMid = priceHistory.find(h => h.timestamp >= midPointTime)?.price || currentPrice;
        const growthFirstHalf = (pMid - pStart) / pStart;
        if (growthFirstHalf > 0.20) {
          const recentSnapshots = priceHistory.slice(-8);
          if (recentSnapshots.length >= 5) {
            const prices = recentSnapshots.map(s => s.price).concat(currentPrice);
            const minP = Math.min(...prices), maxP = Math.max(...prices);
            const rangePct = ((maxP - minP) / minP) * 100;
            if (rangePct < 1.0) addBlocker(`Price exhaustion (Flatline Filter): vertical spike followed by stagnant range (${rangePct.toFixed(2)}%) at the peak.`, 'price-exhaustion');
          }
        }
        const snapshots = priceHistory.concat({ price: currentPrice, timestamp: now });
        let greenSnapshots = 0;
        for (let i = 1; i < snapshots.length; i++) if (snapshots[i].price > snapshots[i - 1].price) greenSnapshots++;
        const consistencyRatio = greenSnapshots / (snapshots.length - 1);
        if (consistencyRatio < ctx.config.minMomentumConsistency) addBlocker(`Choppy momentum: ${(consistencyRatio * 100).toFixed(1)}% green (min ${(ctx.config.minMomentumConsistency * 100).toFixed(0)}% required).`, 'choppy-momentum');
      }
    }
  }

  if (highestSeenPriceUsd != null && highestSeenPriceUsd > 0) {
    const currentPrice = Number(token.usdPrice || 0);
    const dropRatio = 1 - currentPrice / highestSeenPriceUsd;
    if (dropRatio > ctx.config.maxPriceDumpPct / 100) addBlocker(`Price is dumping: ${formatUsd(currentPrice)} is ${ratioToPercentString(dropRatio)} below peak ${formatUsd(highestSeenPriceUsd)}.`, 'price-dumping');
  }

  if (tapeAtStart) {
    const buysDelta = Number(token.stats5m?.numBuys || 0) - tapeAtStart.buys;
    const sellsDelta = Number(token.stats5m?.numSells || 0) - tapeAtStart.sells;
    if (sellsDelta > 0) {
      const sellRatio = sellsDelta / (buysDelta || 1);
      const sellPressureIncrease = (sellsDelta / (tapeAtStart.sells || 1)) * 100;
      if (sellRatio > 0.8 && sellPressureIncrease > ctx.config.maxSellPressureIncreasePct) addBlocker(`High selling pressure: Sells increased by ${sellPressureIncrease.toFixed(1)}% during delay (Sell/Buy ratio: ${sellRatio.toFixed(2)}).`, 'high-sell-pressure');
    }
  }

  if (!looksLikeMemecoin(ctx, token)) addBlocker('Does not match heuristic.', 'not-memecoin');
  if (!token.usdPrice || Number(token.usdPrice) <= 0) addBlocker('No price.', 'missing-price');
  if (!Number.isFinite(token.liquidity) || token.liquidity < thresholds.minLiquidityUsd) addBlocker(`Low liquidity ${formatUsd(token.liquidity)}.`, 'low-liquidity', isSlightlyBelowThreshold(ctx, token.liquidity, thresholds.minLiquidityUsd));
  if (!Number.isFinite(token.holderCount) || token.holderCount < thresholds.minHolderCount) addBlocker(`Low holders ${token.holderCount}.`, 'low-holders', isSlightlyBelowThreshold(ctx, token.holderCount, thresholds.minHolderCount));
  if (!Number.isFinite(token.organicScore) || token.organicScore < ctx.config.minOrganicScore) addBlocker(`Low organic score ${token.organicScore}.`, 'low-organic-score');
  if ((token.stats5m?.numBuys || 0) < thresholds.minBuys5m) addBlocker(`Low 5m buys ${token.stats5m?.numBuys}.`, 'low-buys', isSlightlyBelowThreshold(ctx, token.stats5m?.numBuys, thresholds.minBuys5m));
  if (socialLinks < ctx.config.minSocialLinks) addBlocker(`Low socials ${socialLinks}.`, 'low-social-links');
  if (!ctx.config.allowVerifiedTokens && token.isVerified) addBlocker('Verified disabled.', 'verified-token-disabled');

  if (ageSeconds != null) {
    if (ageSeconds < thresholds.minPoolAgeSeconds) addBlocker(`Too new ${ageSeconds}s.`, 'too-new', true);
    if (ageSeconds > ctx.config.maxCandidateAgeMinutes * 60) addBlocker(`Too old ${(ageSeconds / 60).toFixed(1)}m.`, 'too-old');
  } else notes.push('Missing age data.');

  if (Number.isFinite(token.fdv) && Number.isFinite(token.liquidity) && token.liquidity > 0) {
    const ratio = token.fdv / token.liquidity;
    if (ratio > ctx.config.maxFdvToLiquidity) addBlocker(`High FDV/Liq ratio ${ratio.toFixed(2)}.`, 'fdv-liquidity-too-high');
  }

  if (token.audit?.isSus === true) addBlocker('Jupiter audit suspicious.', 'audit-suspicious');
  if (token.audit?.mintAuthorityDisabled === false) addBlocker('Mint authority enabled (audit).', 'audit-mint-authority');
  if (token.audit?.freezeAuthorityDisabled === false) addBlocker('Freeze authority enabled (audit).', 'audit-freeze-authority');
  if (Number.isFinite(token.audit?.topHoldersPercentage) && token.audit.topHoldersPercentage > ctx.config.maxAuditTopHoldersPct) addBlocker(`High top holders ${token.audit.topHoldersPercentage.toFixed(2)}%.`, 'audit-top-holders');

  notes.push(`Score ${entryScore}/100 via ${launchpadProfile.name}.`);

  const mintSignals = await getMintSignals(ctx, token.id);
  if (mintSignals.mintAuthority) addBlocker(`Mint authority set: ${mintSignals.mintAuthority}`, 'mint-authority-enabled');
  if (mintSignals.freezeAuthority) addBlocker(`Freeze authority set: ${mintSignals.freezeAuthority}`, 'freeze-authority-enabled');
  if (mintSignals.top1Share > ctx.config.maxTokenAccountTop1Pct / 100) addBlocker(`High top1 concentration ${ratioToPercentString(mintSignals.top1Share)}.`, 'top1-concentration');
  if (mintSignals.top5Share > ctx.config.maxTokenAccountTop5Pct / 100) addBlocker(`High top5 concentration ${ratioToPercentString(mintSignals.top5Share)}.`, 'top5-concentration');

  const owners = Array.from(new Set(mintSignals.topAccounts.map(a => a.owner).filter(o => o && !BURN_OWNERS.has(o))));
  const goPlusSignals = await fetchGoPlusTokenSignals(ctx, token.id);
  if (goPlusSignals) { goPlusSignals.blockers.forEach(b => addBlocker(b, 'goplus-token-signal')); notes.push(...goPlusSignals.notes); }
  const malicious = owners.length > 0 ? await fetchGoPlusAddressSignals(ctx, owners) : [];
  if (malicious.length > 0) addBlocker(`Malicious owners flagged by GoPlus: ${malicious.map(m => m.address).join(', ')}`, 'goplus-malicious-owner');
  const bbSignals = await fetchBubbleMapsSignals(ctx, token.id);
  if (bbSignals) { bbSignals.blockers.forEach(b => addBlocker(b, 'bubblemaps-signal')); if (bbSignals.score != null) notes.push(`BubbleMaps score: ${bbSignals.score}`); }

  if (entryScore < ctx.config.minCandidateScore) addBlocker(`Low entry score ${entryScore}.`, 'entry-score-too-low');

  const retired = ctx.state.retiredMints.get(token.id);
  if (retired && retired.lastExitPriceUsd > 0 && token.usdPrice > 0) {
    const diff = ((token.usdPrice - retired.lastExitPriceUsd) / retired.lastExitPriceUsd) * 100;
    if (diff > -ctx.config.reentryDipPct && diff < ctx.config.reentryBreakoutPct) addBlocker(`Price distance failed: ${diff.toFixed(2)}% in avoid range.`, 'price-distance-gate');
    else notes.push(`Price distance passed: ${diff.toFixed(2)}% vs last exit.`);
  }

  return { approved: blockers.length === 0, blockers, rejectionReasons, notes, candidateScore: entryScore, launchpadProfile, adjustedThresholds: thresholds, token, mintSignals, goPlusTokenSignals: goPlusSignals, bubbleMapsSignals: bbSignals };
}

// --- Trading & Execution Services ---

async function buyCandidate(ctx, evaluation) {
  ctx.state.metrics.buyAttempts++;
  const { token, candidateScore } = evaluation;
  const decimals = Number(token.decimals || evaluation.mintSignals.decimals || 0);
  const tpPlan = getTakeProfitPlan(ctx, candidateScore);
  const mood = getMoodAdjustments(ctx);
  if (mood.isPaused) { ctx.logger(`Buy skipped for ${token.symbol}: Mood Paused.`, 'warn'); return null; }

  try {
    const buyLamports = (BigInt(ctx.config.buyAmountLamports) * BigInt(Math.round(mood.sizeMultiplier * 100))) / 100n;
    const buySolText = atomicToDecimalString(buyLamports, 9, 6);

    if (ctx.config.paperTrading) {
      if (BigInt(ctx.state.paperSolBalanceLamports) < buyLamports) { ctx.logger(`Paper wallet insufficient SOL: ${atomicToDecimalString(ctx.state.paperSolBalanceLamports, 9, 6)}.`, 'warn'); return null; }
      const quote = await buildPaperBuyQuote(ctx, token, decimals, buyLamports);
      ctx.state.paperSolBalanceLamports = (BigInt(ctx.state.paperSolBalanceLamports) - buyLamports).toString();
      const pos = {
        mint: token.id, symbol: token.symbol, name: token.name, decimals, openedAt: new Date().toISOString(), mode: 'paper',
        entryPriceUsd: quote.entryPriceUsd, entryUsdValue: quote.entryUsdValue, initialBuyAmountSol: buySolText, initialBuyAmountLamports: buyLamports.toString(), initialTokenAmountRaw: quote.outAmount.toString(),
        targetsHit: 0, takeProfitMultiples: tpPlan.takeProfitMultiples, takeProfitFractions: tpPlan.takeProfitFractions, highGrowthConfidence: tpPlan.isHighGrowthConfidence,
        lastKnownBalanceRaw: quote.outAmount.toString(), lastKnownPriceUsd: Number(token.usdPrice || 0), highestPriceUsd: quote.entryPriceUsd, remainingCostUsd: quote.entryUsdValue,
        realizedPnlUsd: 0, realizedProceedsUsd: 0, entryLiquidityUsd: Number(token.liquidity || 0), lastKnownLiquidityUsd: Number(token.liquidity || 0),
        launchpad: token.launchpad || null, entryScore: candidateScore, paperEntryQuoteOutAmount: quote.outAmount.toString(), minTpReached: false, minTpFirstReachedAt: null, minTpArmed: false
      };
      ctx.state.positions.set(token.id, pos);
      ctx.persistState();
      ctx.logger(`PAPER buy ${token.symbol} for ${buySolText} SOL (score ${candidateScore}). Tokens ${atomicToDecimalString(quote.outAmount, decimals, 6)}.`, 'trade');
      return pos;
    }

    const order = await fetchSwapOrder(ctx, SOL_MINT, token.id, buyLamports.toString());
    const entryUsdValue = Number(order.inUsdValue || 0) > 0 ? Number(order.inUsdValue) : await estimateSolUsdValue(ctx, buyLamports);
    const beforeBalance = await getWalletTokenBalance(ctx, token.id);
    if (ctx.config.dryRun) { ctx.logger(`DRY_RUN would buy ${token.symbol} for ${buySolText} SOL.`, 'trade'); return null; }

    const sig = await executeSwapOrder(ctx, order);
    await sleep(2000);
    const afterBalance = await getWalletTokenBalance(ctx, token.id);
    const received = afterBalance.rawAmount - beforeBalance.rawAmount > 0n ? afterBalance.rawAmount - beforeBalance.rawAmount : BigInt(order.outAmount || '0');
    if (received <= 0n) throw new Error(`Buy delta was zero in ${sig}.`);
    const actualDecimals = afterBalance.decimals || decimals;
    const units = Number(atomicToDecimalString(received, actualDecimals, 9));
    const entryPriceUsd = units > 0 ? entryUsdValue / units : Number(token.usdPrice || 0);

    const pos = {
      mint: token.id, symbol: token.symbol, name: token.name, decimals: actualDecimals, openedAt: new Date().toISOString(), mode: 'live',
      entryPriceUsd, entryUsdValue, initialBuyAmountSol: buySolText, initialBuyAmountLamports: buyLamports.toString(), initialTokenAmountRaw: received.toString(),
      targetsHit: 0, takeProfitMultiples: tpPlan.takeProfitMultiples, takeProfitFractions: tpPlan.takeProfitFractions, highGrowthConfidence: tpPlan.isHighGrowthConfidence,
      lastKnownBalanceRaw: afterBalance.rawAmount.toString(), lastKnownPriceUsd: Number(token.usdPrice || 0), highestPriceUsd: entryPriceUsd, remainingCostUsd: entryUsdValue,
      realizedPnlUsd: 0, realizedProceedsUsd: 0, entryLiquidityUsd: Number(token.liquidity || 0), lastKnownLiquidityUsd: Number(token.liquidity || 0),
      launchpad: token.launchpad || null, entryScore: candidateScore, buySignature: sig, minTpReached: false, minTpFirstReachedAt: null, minTpArmed: false
    };
    ctx.state.positions.set(token.id, pos);
    ctx.persistState();
    ctx.logger(`Bought ${token.symbol} for ${buySolText} SOL. Entry ${formatUsd(entryPriceUsd)} in tx ${sig}.`, 'trade');
    return pos;
  } catch (e) { ctx.state.metrics.buyFailures++; ctx.logger(`Buy failed for ${token.symbol || token.id}: ${e.message}`, 'error'); return null; }
}

async function fetchDynamicPriorityFee(ctx, accountKeys = [], isPanic = false) {
  try {
    const publicKeys = accountKeys.map((key) => new PublicKey(key));
    const fees = await ctx.connection.getRecentPrioritizationFees({
      lockedWritableAccounts: publicKeys,
    });

    if (fees.length === 0) {
      return ctx.config.priorityFeeBaseMicroLamports;
    }

    // Sort by fee and pick the requested percentile
    const sortedFees = fees.map((f) => f.prioritizationFee).sort((a, b) => a - b);
    const index = Math.floor((ctx.config.priorityFeePercentile / 100) * (sortedFees.length - 1));
    let baseFee = sortedFees[index];

    let finalFee = Math.max(ctx.config.priorityFeeBaseMicroLamports, baseFee);
    if (isPanic) {
      finalFee = Math.round(finalFee * ctx.config.priorityFeePanicMultiplier);
    }

    return Math.min(finalFee, ctx.config.priorityFeeMaxMicroLamports);
  } catch (error) {
    ctx.logger(`Failed to fetch priority fees: ${error.message}. Using base fee.`, 'warn');
    return ctx.config.priorityFeeBaseMicroLamports;
  }
}

async function fetchSwapOrder(ctx, inputMint, outputMint, amount, isPanic = false) {
  const priorityFee = await fetchDynamicPriorityFee(ctx, [inputMint, outputMint], isPanic);
  
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amount),
    taker: ctx.wallet.publicKey.toBase58(),
    slippageBps: String(ctx.config.slippageBps),
    swapMode: 'ExactIn',
    computeUnitPriceMicroLamports: String(priorityFee),
  });

  const url = `${ctx.config.jupiterBaseUrl}/swap/v2/order?${params.toString()}`;
  const order = await fetchJson(url, {
    headers: { 'x-api-key': ctx.config.jupiterApiKey },
  });

  if (!order || !order.transaction) {
    throw new Error(order?.errorMessage || order?.error || 'No transaction from Jupiter.');
  }

  return order;
}

async function executeSwapOrder(ctx, order) {
  const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'));
  tx.sign([ctx.wallet]);
  const sig = await ctx.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  const conf = await ctx.connection.confirmTransaction({ signature: sig, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: Number(order.lastValidBlockHeight) }, 'confirmed');
  if (conf.value.err) throw new Error(`Swap failed: ${JSON.stringify(conf.value.err)}`);
  return sig;
}

async function getWalletTokenBalance(ctx, mint) {
  if (ctx.config.paperTrading) {
    const pos = ctx.state.positions.get(mint);
    const raw = BigInt(pos?.lastKnownBalanceRaw || '0');
    const dec = Number(pos?.decimals || 0);
    return { mint, rawAmount: raw, decimals: dec, uiAmount: Number(atomicToDecimalString(raw, dec, 9)) };
  }
  const res = await ctx.connection.getParsedTokenAccountsByOwner(ctx.wallet.publicKey, { mint: new PublicKey(mint) }, 'confirmed');
  let raw = 0n, dec = 0;
  for (const acc of res.value) {
    const info = acc.account.data?.parsed?.info?.tokenAmount;
    if (info?.amount) { raw += BigInt(info.amount); dec = info.decimals; }
  }
  return { mint, rawAmount: raw, decimals: dec, uiAmount: Number(atomicToDecimalString(raw, dec, 9)) };
}

async function estimateSolUsdValue(ctx, amountLamports) {
  const prices = await fetchPrices(ctx, [SOL_MINT]);
  return Number(prices[SOL_MINT]?.usdPrice || 0) * Number(atomicToDecimalString(amountLamports, 9, 9));
}

async function estimateSolUsdPrice(ctx) {
  const prices = await fetchPrices(ctx, [SOL_MINT]);
  const p = Number(prices[SOL_MINT]?.usdPrice || 0);
  if (!(p > 0)) throw new Error('No SOL price for paper.');
  return p;
}

async function buildPaperBuyQuote(ctx, token, decimals, buyLamports) {
  const p = Number(token.usdPrice || 0);
  if (!(p > 0)) throw new Error(`No price for paper buy ${token.symbol}.`);
  const val = await estimateSolUsdValue(ctx, buyLamports);
  const units = val / p;
  const raw = BigInt(decimalToAtomic(units.toFixed(Math.min(decimals, 9)), decimals));
  const out = (raw * BigInt(Math.max(0, 10000 - ctx.config.slippageBps))) / 10000n;
  if (out <= 0n) throw new Error('Paper buy rounded to zero.');
  return { outAmount: out, entryUsdValue: val, entryPriceUsd: p };
}

async function buildPaperSellQuote(ctx, rawAmount, pUsd, dec) {
  if (!(pUsd > 0)) throw new Error('No price for paper sell.');
  const solP = await estimateSolUsdPrice(ctx);
  const val = Number(atomicToDecimalString(rawAmount, dec, 9)) * pUsd;
  const rawLamports = BigInt(decimalToAtomic((val / solP).toFixed(9), 9));
  const out = (rawLamports * BigInt(Math.max(0, 10000 - ctx.config.slippageBps))) / 10000n;
  if (out <= 0n) throw new Error('Paper sell rounded to zero.');
  return { outAmount: out, grossUsdValue: val };
}

// --- Risk & Monitoring Services ---

async function monitorPositions(ctx) {
  if (ctx.state.positions.size === 0) return;
  const mints = Array.from(ctx.state.positions.keys());
  const prices = await fetchPricesBestEffort(ctx, mints, 'position refresh');

  for (const mint of mints) {
    const pos = ctx.state.positions.get(mint);
    if (!pos) continue;
    const balance = await getWalletTokenBalance(ctx, mint);
    if (balance.rawAmount <= 0n) { ctx.logger(`Position ${pos.symbol} zero balance; removing.`, 'warn'); ctx.state.positions.delete(mint); ctx.persistState(); continue; }

    const snap = ctx.state.marketSnapshots.get(mint);
    const pUsd = Number(prices[mint]?.usdPrice || snap?.usdPrice || 0);
    if (snap?.liquidity != null) pos.lastKnownLiquidityUsd = snap.liquidity;
    
    if (!(pUsd > 0)) {
      if (snap?.liquidity != null) {
        const floor = Math.max(ctx.config.liquidityCollapseThresholdUsd, Number(pos.entryLiquidityUsd || 0) * ctx.config.liquidityCollapseThresholdRatio);
        if (snap.liquidity <= floor && (pos.lastKnownPriceUsd || pos.entryPriceUsd) > 0) {
          await executePositionExit(ctx, pos, balance, Number(pos.lastKnownPriceUsd || pos.entryPriceUsd), balance.rawAmount, 'liquidity-exit');
          continue;
        }
      }
      ctx.logger(`Price unavailable for ${pos.symbol}; skipping check.`, 'warn'); continue;
    }

    pos.highestPriceUsd = Math.max(Number(pos.highestPriceUsd || pos.entryPriceUsd || 0), pUsd);
    pos.lastKnownBalanceRaw = balance.rawAmount.toString();
    pos.lastKnownPriceUsd = pUsd;
    ctx.state.positions.set(mint, pos);

    const ageSec = (Date.now() - new Date(pos.openedAt).getTime()) / 1000;
    if (ageSec <= 20 && pos.targetsHit === 0) {
      const drop = (pos.entryPriceUsd - pUsd) / pos.entryPriceUsd;
      const buyCollapse = Array.isArray(pos.tapeHistory) && pos.tapeHistory.length >= 2 && (pos.tapeHistory[pos.tapeHistory.length-1].buys - pos.tapeHistory[pos.tapeHistory.length-2].buys) === 0;
      if (drop > 0.10 || buyCollapse) {
        ctx.logger(`Early Guard for ${pos.symbol}: drop ${(drop*100).toFixed(1)}% or buy collapse. Selling 60%.`, 'warn', { console: true });
        await executePositionExit(ctx, pos, balance, pUsd, computeTakeProfitSellAmount(balance.rawAmount, 0.60), 'early-performance-guard');
        continue;
      }
    }
    if (ageSec < ctx.config.minHoldTimeSeconds) continue;
    if (ageSec > ctx.config.performanceCheckSeconds && pos.targetsHit === 0 && pUsd < pos.entryPriceUsd * ctx.config.performanceMinMomentum) {
      await executePositionExit(ctx, pos, balance, pUsd, balance.rawAmount, 'no-early-performance'); continue;
    }

    const slP = pos.entryPriceUsd * (1 - ctx.config.stopLossPct);
    const slWP = pos.entryPriceUsd * (1 - (ctx.config.stopLossPct / 2));
    if (pUsd <= slWP && !pos.stopLossWarningSent) {
      pos.stopLossWarningSent = true;
      ctx.logger(`WARNING: ${pos.symbol} half-SL. Drawdown: ${((1 - pUsd/pos.entryPriceUsd)*100).toFixed(2)}%. SL at ${formatUsd(slP)}.`, 'warn', { console: true });
      ctx.state.positions.set(mint, pos);
    }
    if (pUsd <= slP) { await executePositionExit(ctx, pos, balance, pUsd, balance.rawAmount, 'stop-loss'); continue; }

    const trailP = (pos.highestPriceUsd || pUsd) * 0.8;
    if (pUsd < trailP) {
      ctx.logger(`Price ${formatUsd(pUsd)} below 80% of peak (${formatUsd(pos.highestPriceUsd)}). Max TP Exit for ${pos.symbol}.`, 'trade');
      await executePositionExit(ctx, pos, balance, pUsd, balance.rawAmount, 'tp-trailing-max-exit'); continue;
    }

    const ageMin = ageSec / 60;
    if (ageMin >= ctx.config.maxHoldMinutes && pUsd < pos.entryPriceUsd * ctx.config.timeExitMinMultiple) {
      await executePositionExit(ctx, pos, balance, pUsd, balance.rawAmount, 'time-exit'); continue;
    }

    if (snap?.liquidity != null) {
      const floor = Math.max(ctx.config.liquidityCollapseThresholdUsd, Number(pos.entryLiquidityUsd || 0) * ctx.config.liquidityCollapseThresholdRatio);
      if (snap.liquidity <= floor) { await executePositionExit(ctx, pos, balance, pUsd, balance.rawAmount, 'liquidity-exit'); continue; }
    }

    const multiples = Array.isArray(pos.takeProfitMultiples) ? pos.takeProfitMultiples : TAKE_PROFIT_MULTIPLES;
    while (pos.targetsHit < multiples.length) {
      const nextM = multiples[pos.targetsHit], targetP = pos.entryPriceUsd * nextM;
      const minTpM = 1 + 0.5 * (nextM - 1), minTpP = pos.entryPriceUsd * minTpM;
      if (pUsd >= minTpP) {
        if (!pos.minTpReached) { pos.minTpReached = true; pos.minTpFirstReachedAt = Date.now(); ctx.logger(`Adaptive minTP ${minTpM.toFixed(2)}x touched for ${pos.symbol}.`, 'debug'); }
        else if (!pos.minTpArmed && Date.now() - pos.minTpFirstReachedAt >= 10000) { pos.minTpArmed = true; ctx.logger(`Midpoint Profit Guard ARMED for ${pos.symbol}.`, 'info'); }
      }
      if (pos.minTpArmed && pUsd < minTpP) {
        ctx.logger(`Price fell back to midpoint ${formatUsd(minTpP)} for ${pos.symbol}. Midpoint exit.`, 'trade');
        if (await executePositionExit(ctx, pos, balance, pUsd, balance.rawAmount, 'adaptive-tp-exit')) ctx.logger(`${pos.symbol} entered cool-down.`, 'info');
        break;
      }
      if (pUsd < targetP) break;
      if (!await sellTakeProfit(ctx, pos, await getWalletTokenBalance(ctx, mint), pUsd, nextM)) break;
      pos.minTpReached = false; pos.minTpFirstReachedAt = null; pos.minTpArmed = false;
    }
    if (pos.targetsHit >= 1 && balance.rawAmount > 0n && !pos.firstTpHitAt) {
      pos.firstTpHitAt = new Date().toISOString();
      ctx.logger(`${pos.lastTakeProfitMultiple || 1.5}x profit hit for ${pos.symbol}; ${TP_SELL_PERCENT}% sold. Global 80% trailing guard active.`, 'trade');
    }
  }
  ctx.persistState();
}

async function executePositionExit(ctx, pos, balance, pUsd, sellRaw, reason, targetM = null) {
  if (sellRaw <= 0n) { ctx.logger(`Skipping ${reason} for ${pos.symbol}; zero amount.`, 'warn'); return false; }
  if (ctx.config.paperTrading) {
    const quote = await buildPaperSellQuote(ctx, sellRaw, pUsd, pos.decimals);
    const remain = balance.rawAmount - sellRaw, accounting = buildExitAccounting(pos, sellRaw, balance.rawAmount, quote.grossUsdValue);
    ctx.state.paperSolBalanceLamports = (BigInt(ctx.state.paperSolBalanceLamports) + quote.outAmount).toString();
    if (reason.startsWith('take-profit')) pos.targetsHit++;
    pos.lastTakeProfitAt = new Date().toISOString(); pos.lastTakeProfitMultiple = targetM;
    pos.lastKnownBalanceRaw = remain.toString(); pos.lastKnownPriceUsd = pUsd; pos.remainingCostUsd = accounting.remainingCostUsd;
    pos.realizedPnlUsd = (pos.realizedPnlUsd || 0) + accounting.realizedPnlUsd;
    pos.realizedProceedsUsd = (pos.realizedProceedsUsd || 0) + quote.grossUsdValue;
    pos.lastExitReason = reason;
    if (remain > 0n) ctx.state.positions.set(pos.mint, pos);
    else {
      ctx.state.positions.delete(pos.mint);
      updatePaperClosedPositionStats(ctx, pos);
      const win = pos.realizedPnlUsd > 0;
      recordTradeResult(ctx, win);
      if (win) ctx.state.metrics.profitableTrades++;
      if (reason === 'stop-loss') ctx.state.metrics.stopLosses++;
      if (reason === 'tp-trailing-max-exit') ctx.state.metrics.trailingExits++;
    }
    ctx.persistState();
    ctx.logger(`PAPER ${reason} on ${pos.symbol}. SOL out ${atomicToDecimalString(quote.outAmount, 9, 6)}.`, 'trade');
    return true;
  }
  const isPanic = ['liquidity-exit', 'stop-loss', 'early-performance-guard'].includes(reason);
  const order = await fetchSwapOrder(ctx, pos.mint, SOL_MINT, sellRaw.toString(), isPanic);
  if (ctx.config.dryRun) { ctx.logger(`DRY_RUN would sell ${pos.symbol} for ${reason}.`, 'trade'); return false; }
  const sig = await executeSwapOrder(ctx, order);
  await sleep(2000);
  const upBal = await getWalletTokenBalance(ctx, pos.mint);
  const proceeds = Number(atomicToDecimalString(sellRaw, pos.decimals, 9)) * pUsd;
  const acc = buildExitAccounting(pos, sellRaw, balance.rawAmount, proceeds);
  if (reason.startsWith('take-profit')) pos.targetsHit++;
  pos.lastTakeProfitAt = new Date().toISOString(); pos.lastTakeProfitMultiple = targetM;
  pos.lastKnownBalanceRaw = upBal.rawAmount.toString(); pos.lastKnownPriceUsd = pUsd; pos.remainingCostUsd = acc.remainingCostUsd;
  pos.realizedPnlUsd = (pos.realizedPnlUsd || 0) + acc.realizedPnlUsd;
  pos.realizedProceedsUsd = (pos.realizedProceedsUsd || 0) + proceeds;
  pos.lastExitReason = reason; pos.lastSellSignature = sig;
  const totalT = Array.isArray(pos.takeProfitMultiples) ? pos.takeProfitMultiples.length : TAKE_PROFIT_MULTIPLES.length;
  if (pos.targetsHit >= totalT || upBal.rawAmount <= 0n) {
    if (upBal.rawAmount <= 0n) {
      ctx.state.positions.delete(pos.mint);
      const win = pos.realizedPnlUsd > 0;
      recordTradeResult(ctx, win);
      if (win) ctx.state.metrics.profitableTrades++;
      if (reason === 'stop-loss') ctx.state.metrics.stopLosses++;
      if (reason === 'tp-trailing-max-exit') ctx.state.metrics.trailingExits++;
      startCoolDown(ctx, pos.mint, pUsd);
    } else ctx.state.positions.set(pos.mint, pos);
  } else ctx.state.positions.set(pos.mint, pos);
  ctx.persistState();
  ctx.logger(`Sold ${pos.symbol} for ${reason}. sig ${sig}.`, 'trade');
  return true;
}

async function sellTakeProfit(ctx, pos, balance, pUsd, targetM) {
  const frac = getTakeProfitFraction(pos, pos.targetsHit);
  const amt = computeTakeProfitSellAmount(balance.rawAmount, frac);
  return executePositionExit(ctx, pos, balance, pUsd, amt, `take-profit-${targetM}x`, targetM);
}

function buildExitAccounting(pos, sellRaw, balRaw, proceeds) {
  const ratio = bigintRatioToNumber(sellRaw, balRaw);
  const costSold = Number(pos.remainingCostUsd || 0) * ratio;
  return { realizedPnlUsd: proceeds - costSold, remainingCostUsd: Math.max(0, Number(pos.remainingCostUsd || 0) - costSold) };
}

function getTakeProfitPlan(ctx, score) {
  return { isHighGrowthConfidence: Number(score || 0) >= ctx.config.highGrowthConfidenceScore, takeProfitMultiples: [...TAKE_PROFIT_MULTIPLES], takeProfitFractions: [TAKE_PROFIT_FRACTION] };
}

function getTakeProfitFraction(pos, targetIndex) { return TAKE_PROFIT_FRACTION; }
function computeTakeProfitSellAmount(balRaw, frac) { return (balRaw * BigInt(Math.max(1, Math.round(frac * 10000)))) / 10000n; }

async function closeAllOpenPositions(ctx, reason = 'shutdown-exit') {
  const mints = Array.from(ctx.state.positions.keys());
  if (mints.length === 0) { ctx.logger('No positions to close.'); return; }
  ctx.logger(`Closing ${mints.length} positions for shutdown...`, 'warn', { console: true });
  const prices = await fetchPricesBestEffort(ctx, mints, 'shutdown exit');
  for (const mint of mints) {
    const pos = ctx.state.positions.get(mint);
    if (!pos) continue;
    try {
      const bal = await getWalletTokenBalance(ctx, mint);
      if (bal.rawAmount <= 0n) { ctx.state.positions.delete(mint); ctx.persistState(); continue; }
      let p = Number(prices[mint]?.usdPrice || pos.lastKnownPriceUsd || pos.entryPriceUsd || 0);
      await executePositionExit(ctx, pos, bal, p, bal.rawAmount, reason);
    } catch (e) { ctx.logger(`Failed to close ${pos.symbol || mint}: ${e.message}`, 'error', { console: true }); }
  }
}

// --- Mood & State Services ---

function getMoodAdjustments(ctx) {
  let sizeMultiplier = 1.0, isPaused = false;
  if (ctx.state.moodPauseUntil && Date.now() < ctx.state.moodPauseUntil) isPaused = true;
  else {
    const history = ctx.state.tradeHistory || [], last10 = history.slice(-10), last5 = history.slice(-5);
    const winRate10 = last10.length >= 10 ? last10.filter(w => w).length / 10 : 1;
    const winRate5 = last5.length >= 5 ? last5.filter(w => w).length / 5 : 1;
    if (winRate10 < 0.2) {
      isPaused = true; ctx.state.moodPauseUntil = Date.now() + ctx.config.moodPauseDurationMinutes * 60000;
      ctx.logger(`Daily Mood: CRITICAL. Pausing for ${ctx.config.moodPauseDurationMinutes}m.`, 'warn', { console: true });
    } else if (winRate5 < 0.4) {
      sizeMultiplier = 0.5; ctx.logger(`Daily Mood: CAUTIOUS. Reducing size 50%.`, 'warn', { console: true });
    }
  }
  return { sizeMultiplier, isPaused };
}

function recordTradeResult(ctx, isWin) {
  ctx.state.tradeHistory.push(isWin);
  if (ctx.state.tradeHistory.length > 50) ctx.state.tradeHistory.shift();
  ctx.persistState();
}

function startCoolDown(ctx, mint, pUsd) {
  const expires = Date.now() + ctx.config.coolDownMinutes * 60000;
  ctx.state.coolDownMints.set(mint, { expiresAt: expires, lastExitPriceUsd: pUsd });
}

function updatePaperClosedPositionStats(ctx, pos) {
  // Logic from updatePaperClosedPositionStats
}

module.exports = {
  fetchRecentLaunches,
  fetchPricesBestEffort,
  evaluateCandidate,
  buyCandidate,
  monitorPositions,
  closeAllOpenPositions,
  getWalletTokenBalance,
  getMoodAdjustments
};
