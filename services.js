'use strict';

// Service composition layer: wraps data fetches, candidate evaluation, buy execution,
// and shared flow helpers used by the bot's discovery and monitoring loops.

const { setTimeout: sleep } = require('node:timers/promises');
const utils = require('./utils');
const {
  fetchJson,
  atomicToDecimalString,
  decimalToAtomic,
  formatUsd,
  runBoundedPool,
  safeJsonStringify,
  sendNotification,
  journalPaperTrade,
  rpcCall,
  decodePumpCurve,
  PRIORITY,
} = utils;
const { constants } = require('./config');
const { address, getProgramDerivedAddress, getAddressEncoder } = require('@solana/addresses');
const engine = require('./engine');
const trading = require('./trading');
const monitor = require('./monitor');

function resolveBuyAmountLamports(config) {
  if (config.buyAmountLamports !== undefined && config.buyAmountLamports !== null) {
    return String(config.buyAmountLamports);
  }
  if (config.buyAmountSolText !== undefined && config.buyAmountSolText !== null) {
    return decimalToAtomic(String(config.buyAmountSolText), 9);
  }
  throw new Error('Missing buy amount configuration.');
}

/**
 * Fetches recent token launches from Jupiter.
 * @param {Object} ctx - The application context.
 * @returns {Promise<Object[]>} Array of recent token launches.
 * @throws {Error} If the response shape is unexpected.
 */
async function fetchRecentLaunches(ctx) {
  const url = `${ctx.config.jupiterBaseUrl}/tokens/v2/recent`;
  const data = await fetchJson(url, {
    headers: { 'x-api-key': ctx.config.jupiterApiKey },
    timeoutMs: 8000,
    retries: 1,
  });
  if (!Array.isArray(data)) throw new Error('Unexpected Jupiter recent response shape.');
  return data;
}

const PUMP_FUN_CURVE_SEED = 'bonding-curve';

/**
 * Fetches market data (price, liquidity) directly from on-chain RPC for supported launchpads.
 * @param {Object} ctx - The application context.
 * @param {string} mint - The token mint address.
 * @param {string} [launchpadName=null] - Optional launchpad name.
 * @returns {Promise<Object|null>} Market data (usdPrice, liquidity, isCompleted, source) or null.
 */
async function fetchDirectMarketData(ctx, mint, launchpadName = null) {
  const launchpad = engine.getLaunchpadProfile(
    launchpadName || ctx.state.marketSnapshots.get(mint)?.launchpad || 'pump.fun'
  );
  if (launchpad.name !== 'pump.fun') return null;

  try {
    const programId = address(constants.PUMP_FUN_PROGRAM_ID);
    const mintAddress = address(mint);
    const [curveAddress] = await getProgramDerivedAddress({
      programAddress: programId,
      seeds: [Buffer.from(PUMP_FUN_CURVE_SEED, 'utf8'), getAddressEncoder().encode(mintAddress)],
    });

    const account = await rpcCall(
      ctx,
      'getAccountInfo',
      [
        curveAddress,
        {
          encoding: 'base64',
          commitment: 'confirmed',
        },
      ],
      { priority: PRIORITY.MEDIUM, cacheTtlMs: 5000 }
    );

    if (!account.value?.data?.[0]) return null;
    const curve = decodePumpCurve(Buffer.from(account.value.data[0], 'base64'));
    if (!curve) return null;

    // Price calculation: (Virtual SOL / Virtual Tokens) * SOL Price
    // Pump.fun constants: 10^9 for SOL, 10^6 for Tokens
    const solPrice = await trading.estimateSolUsdValue(ctx, 1000000000n);
    const virtualSolReserves = Number(curve.virtualSolReserves) / 1e9;
    const virtualTokenReserves = Number(curve.virtualTokenReserves) / 1e6;
    const usdPrice = (virtualSolReserves / virtualTokenReserves) * solPrice;

    // Liquidity calculation: Real SOL Reserves * 2 * SOL Price (approximate)
    const realSolReserves = Number(curve.realSolReserves) / 1e9;
    const liquidity = realSolReserves * 2 * solPrice;

    return {
      usdPrice,
      liquidity,
      isCompleted: curve.isCompleted,
      source: 'rpc-direct',
    };
  } catch (e) {
    ctx.logger(`Direct RPC market data fetch failed for ${mint}: ${e.message}`, 'debug');
    return null;
  }
}

/**
 * Fetches current prices for a batch of mints from Jupiter.
 * @param {Object} ctx - The application context.
 * @param {string[]} mints - Array of token mint addresses.
 * @param {string} [apiKey=null] - Optional Jupiter API key.
 * @returns {Promise<Object>} Mapping of mint address to price record.
 * @throws {Error} If the response is invalid.
 */
async function fetchPrices(ctx, mints, apiKey = null) {
  if (mints.length === 0) return {};
  const url = `${ctx.config.jupiterBaseUrl}/price/v3?ids=${encodeURIComponent(mints.join(','))}`;
  const response = await fetchJson(url, {
    headers: { 'x-api-key': apiKey || ctx.config.jupiterApiKey },
    timeoutMs: 5000,
    retries: 1,
  });

  // Handle empty or missing data gracefully for brand new tokens
  if (!response || typeof response !== 'object') throw new Error('Invalid Jupiter price response.');
  const priceMap = response.data ?? response;
  if (!priceMap || typeof priceMap !== 'object') return {};

  const normalized = {};
  for (const [id, record] of Object.entries(priceMap)) {
    if (record) {
      normalized[id] = {
        ...record,
        usdPrice: Number(record.usdPrice || record.price || 0),
      };
    }
  }
  return normalized;
}

/**
 * Fetches prices with fallback to per-mint requests if the batch fails.
 * @param {Object} ctx - The application context.
 * @param {string[]} mints - Array of token mint addresses.
 * @param {string} [contextLabel='price refresh'] - Label for logging.
 * @param {string} [apiKey=null] - Optional Jupiter API key.
 * @returns {Promise<Object>} Mapping of mint address to price record.
 */
async function fetchPricesBestEffort(ctx, mints, contextLabel = 'price refresh', apiKey = null) {
  if (mints.length === 0) return {};
  const startedAt = Date.now();
  const key = apiKey || ctx.config.jupiterApiKey;

  // Parallelize Jupiter batch fetch with direct RPC market data fetches
  const [apiResult, onChainResults] = await Promise.all([
    (async () => {
      try {
        return await fetchPrices(ctx, mints, key);
      } catch (e) {
        ctx.logger(`Batch ${contextLabel} API failed: ${e.message}.`, 'debug');
        return {};
      }
    })(),
    runBoundedPool(
      mints,
      async (mint) => {
        const direct = await fetchDirectMarketData(ctx, mint);
        if (direct) return { [mint]: direct };
        return null;
      },
      { concurrency: ctx.config.priceFallbackParallelism || 5 }
    ),
  ]);

  const prices = { ...apiResult };

  // Merge direct RPC data, which provides fresh liquidity alongside price
  let directCount = 0;
  for (const result of onChainResults) {
    if (result.status === 'fulfilled' && result.value) {
      const mint = result.item;
      const directData = result.value[mint];
      if (directData) {
        directCount++;
        // If we already have API data, merge the fields, preferring direct for liquidity
        if (prices[mint]) {
          prices[mint] = {
            ...prices[mint],
            ...directData,
            // If direct price is 0, keep API price
            usdPrice: directData.usdPrice > 0 ? directData.usdPrice : prices[mint].usdPrice,
          };
        } else {
          prices[mint] = directData;
        }
      }
    }
  }

  // If some mints are still missing, try individual API fallbacks
  const missingMints = mints.filter((m) => !prices[m] || !(prices[m].usdPrice > 0));
  if (missingMints.length > 0) {
    const fallbackResults = await runBoundedPool(
      missingMints,
      async (mint) => {
        try {
          return await fetchPrices(ctx, [mint], key);
        } catch {
          return {};
        }
      },
      { concurrency: ctx.config.priceFallbackParallelism || 2 }
    );
    for (const result of fallbackResults) {
      if (result.status === 'fulfilled' && result.value) {
        Object.assign(prices, result.value);
      }
    }
  }

  const duration = Date.now() - startedAt;
  if (duration > 2000) {
    ctx.logger(
      `Slow ${contextLabel}: duration=${duration}ms, mints=${mints.length}, direct=${directCount}, api=${Object.keys(apiResult).length}, fallback=${missingMints.length}`,
      'debug'
    );
  }

  return prices;
}

module.exports = {
  fetchRecentLaunches,
  fetchPrices,
  fetchPricesBestEffort,
  fetchDirectMarketData,

  evaluateCandidate: (
    ctx,
    token,
    highestSeenPriceUsd,
    priceHistory,
    priceAtStartOfDelay,
    liquidityAtStartOfDelay,
    tapeAtStart,
    tapeHistory,
    depth,
    priority
  ) =>
    engine.evaluateCandidate(
      ctx,
      token,
      highestSeenPriceUsd,
      priceHistory,
      priceAtStartOfDelay,
      liquidityAtStartOfDelay,
      tapeAtStart,
      tapeHistory,
      depth,
      priority
    ),
  getLaunchpadProfile: engine.getLaunchpadProfile,
  looksLikeMemecoin: engine.looksLikeMemecoin,

  /**
   * Evaluates a candidate and executes a buy order if approved.
   * Supports paper, dry-run, and live trading modes.
   * @param {Object} ctx - The application context.
   * @param {Object} evaluation - The candidate evaluation from engine.evaluateCandidate.
   * @param {Promise<Object>} [prefetchedQuotePromise=null] - Optional pre-fetched Jupiter quote.
   * @returns {Promise<Object|null>} The newly opened position object or null if the buy failed/was skipped.
   */
  buyCandidate: async (ctx, evaluation, prefetchedQuotePromise = null) => {
    ctx.state.metrics.buyAttempts++;
    const { token, candidateScore } = evaluation;
    const decimals = Number(
      token.decimals || (evaluation.mintSignals ? evaluation.mintSignals.decimals : 0) || 0
    );
    const tpPlan = monitor.getTakeProfitPlan(ctx, candidateScore);
    const mood = monitor.getMoodAdjustments(ctx);
    if (mood.isPaused) {
      ctx.logger(`Buy skipped for ${token.symbol}: Mood Paused.`, 'warn');
      return null;
    }

    try {
      const configuredBuyAmountLamports = resolveBuyAmountLamports(ctx.config);
      const buyLamports =
        (BigInt(configuredBuyAmountLamports) * BigInt(Math.round(mood.sizeMultiplier * 100))) /
        100n;
      const buySolText = atomicToDecimalString(buyLamports, 9, 6);

      if (ctx.config.paperTrading) {
        if (BigInt(ctx.state.paperSolBalanceLamports) < buyLamports) {
          ctx.logger(
            `Paper wallet insufficient SOL: ${atomicToDecimalString(ctx.state.paperSolBalanceLamports, 9, 6)}.`,
            'warn'
          );
          return null;
        }
        const quote = await trading.buildPaperBuyQuote(ctx, token, decimals, buyLamports);
        ctx.state.paperSolBalanceLamports = (
          BigInt(ctx.state.paperSolBalanceLamports) - buyLamports
        ).toString();
        const pos = {
          mint: token.id,
          symbol: token.symbol,
          name: token.name,
          decimals,
          openedAt: new Date().toISOString(),
          mode: 'paper',
          entryPriceUsd: quote.entryPriceUsd,
          entryUsdValue: quote.entryUsdValue,
          initialBuyAmountSol: buySolText,
          initialBuyAmountLamports: buyLamports.toString(),
          initialTokenAmountRaw: quote.outAmount.toString(),
          targetsHit: 0,
          tpProfile: tpPlan.profileId,
          takeProfitMultiples: tpPlan.takeProfitMultiples,
          takeProfitFractions: tpPlan.takeProfitFractions,
          highGrowthConfidence: tpPlan.isHighGrowthConfidence,
          trailingStopDrawdownPctResolved: tpPlan.trailingStopDrawdownPct,
          maxHoldMinutesResolved: tpPlan.maxHoldMinutesResolved,
          lastKnownBalanceRaw: quote.outAmount.toString(),
          lastKnownPriceUsd: Number(token.usdPrice || 0),
          highestPriceUsd: quote.entryPriceUsd,
          remainingCostUsd: quote.entryUsdValue,
          realizedPnlUsd: 0,
          realizedProceedsUsd: 0,
          entryLiquidityUsd: Number(token.liquidity || 0),
          lastKnownLiquidityUsd: Number(token.liquidity || 0),
          volatilityScaler: evaluation.volatilityScaler || 0,
          launchpad: token.launchpad || null,
          entryScore: candidateScore,
          paperEntryQuoteOutAmount: quote.outAmount.toString(),
          minTpReached: false,
          minTpFirstReachedAt: null,
          minTpArmed: false,
          trailingArmed: false,
          // Audit & Market Metadata
          mintSignals: evaluation.mintSignals || {},
          securitySignals: {
            goPlusToken: evaluation.goPlusTokenSignals || null,
            bubbleMaps: evaluation.bubbleMapsSignals || null,
          },
          marketData: {
            price: token.usdPrice,
            liquidity: token.liquidity,
            volume24h: token.volume24h,
            buyPressure: token.buyPressure,
            sellPressure: token.sellPressure,
          },
        };

        // Record stats in the session log directory
        const logDir = require('node:path').dirname(ctx.config.logFile);
        const statsFilePath = require('node:path').join(logDir, 'stats.json');
        utils
          .atomicWriteFile(statsFilePath, safeJsonStringify(pos, 2))
          .catch((err) =>
            ctx.logger(`Failed to save stats file at ${statsFilePath}: ${err.message}`, 'error')
          );

        ctx.state.positions.set(token.id, pos);
        ctx.persistState();
        journalPaperTrade(ctx, {
          event: 'buy',
          mint: token.id,
          symbol: token.symbol,
          priceUsd: quote.entryPriceUsd,
          solAmount: buySolText,
          tokenAmount: quote.outAmount.toString(),
          mode: 'paper',
        });
        const balText = atomicToDecimalString(ctx.state.paperSolBalanceLamports, 9, 4);
        ctx.logger(
          `PAPER buy ${token.symbol} (${token.id}) (score ${candidateScore}). Tokens ${atomicToDecimalString(quote.outAmount, decimals, 6)}. [PAPER SOL: ${balText}]`,
          'trade'
        );
        return pos;
      }

      // Use pre-fetched quote if available, otherwise fetch a new one
      const order = prefetchedQuotePromise
        ? (await prefetchedQuotePromise) ||
          (await trading.fetchSwapOrder(ctx, constants.SOL_MINT, token.id, buyLamports.toString()))
        : await trading.fetchSwapOrder(ctx, constants.SOL_MINT, token.id, buyLamports.toString());

      const entryUsdValue =
        Number(order.inUsdValue || 0) > 0
          ? Number(order.inUsdValue)
          : await trading.estimateSolUsdValue(ctx, buyLamports);
      const beforeBalance = await trading.getWalletTokenBalance(ctx, token.id, PRIORITY.HIGH);
      if (ctx.config.dryRun) {
        ctx.logger(`DRY_RUN would buy ${token.symbol} for ${buySolText} SOL.`, 'trade');
        return null;
      }

      const sig = await trading.executeSwapOrder(ctx, order);

      let afterBalance = beforeBalance;
      for (let i = 0; i < 5; i++) {
        await sleep(1500);
        afterBalance = await trading.getWalletTokenBalance(ctx, token.id, PRIORITY.HIGH);
        if (afterBalance.rawAmount > beforeBalance.rawAmount) break;
      }

      const received =
        afterBalance.rawAmount - beforeBalance.rawAmount > 0n
          ? afterBalance.rawAmount - beforeBalance.rawAmount
          : BigInt(order.outAmount || '0');
      if (received <= 0n) throw new Error(`Buy delta was zero in ${sig}.`);
      const actualDecimals = afterBalance.decimals || decimals;
      const units = Number(atomicToDecimalString(received, actualDecimals, 9));
      const entryPriceUsd = units > 0 ? entryUsdValue / units : Number(token.usdPrice || 0);
      const pos = {
        mint: token.id,
        symbol: token.symbol,
        name: token.name,
        decimals: actualDecimals,
        openedAt: new Date().toISOString(),
        mode: 'live',
        entryPriceUsd,
        entryUsdValue,
        initialBuyAmountSol: buySolText,
        initialBuyAmountLamports: buyLamports.toString(),
        initialTokenAmountRaw: received.toString(),
        targetsHit: 0,
        tpProfile: tpPlan.profileId,
        takeProfitMultiples: tpPlan.takeProfitMultiples,
        takeProfitFractions: tpPlan.takeProfitFractions,
        highGrowthConfidence: tpPlan.isHighGrowthConfidence,
        trailingStopDrawdownPctResolved: tpPlan.trailingStopDrawdownPct,
        maxHoldMinutesResolved: tpPlan.maxHoldMinutesResolved,
        lastKnownBalanceRaw: afterBalance.rawAmount.toString(),
        lastKnownPriceUsd: Number(token.usdPrice || 0),
        highestPriceUsd: entryPriceUsd,
        remainingCostUsd: entryUsdValue,
        realizedPnlUsd: 0,
        realizedProceedsUsd: 0,
        entryLiquidityUsd: Number(token.liquidity || 0),
        lastKnownLiquidityUsd: Number(token.liquidity || 0),
        volatilityScaler: evaluation.volatilityScaler || 0,
        launchpad: token.launchpad || null,
        entryScore: candidateScore,
        buySignature: sig,
        minTpReached: false,
        minTpFirstReachedAt: null,
        minTpArmed: false,
        trailingArmed: false,
        // Audit & Market Metadata
        mintSignals: evaluation.mintSignals || {},
        securitySignals: {
          goPlusToken: evaluation.goPlusTokenSignals || null,
          bubbleMaps: evaluation.bubbleMapsSignals || null,
        },
        marketData: {
          price: token.usdPrice,
          liquidity: token.liquidity,
          volume24h: token.volume24h,
          buyPressure: token.buyPressure,
          sellPressure: token.sellPressure,
        },
      };

      // Record stats in the session log directory
      const logDir = require('node:path').dirname(ctx.config.logFile);
      const statsFilePath = require('node:path').join(logDir, 'stats.json');
      utils
        .atomicWriteFile(statsFilePath, safeJsonStringify(pos, 2))
        .catch((err) =>
          ctx.logger(`Failed to save stats file at ${statsFilePath}: ${err.message}`, 'error')
        );
      ctx.state.positions.set(token.id, pos);
      ctx.persistState();
      const msg = `🚀 <b>BUY: ${token.symbol}</b>\nScore: ${candidateScore}\nAmount: ${buySolText} SOL\nPrice: ${formatUsd(entryPriceUsd)}`;
      await sendNotification(ctx, msg);
      ctx.logger(
        `Bought ${token.symbol} for ${buySolText} SOL. Entry ${formatUsd(entryPriceUsd)} in tx ${sig}.`,
        'trade'
      );
      return pos;
    } catch (e) {
      ctx.state.metrics.buyFailures++;
      ctx.logger(`Buy failed for ${token.symbol || token.id}: ${e.message}`, 'error');
      return null;
    }
  },

  /**
   * Periodically monitors open positions for exit conditions (SL, TP, etc.).
   * @param {Object} ctx - The application context.
   * @returns {Promise<void>}
   */
  monitorPositions: (ctx) =>
    monitor.monitorPositions(ctx, (c, m, label, key) => fetchPricesBestEffort(c, m, label, key)),

  /**
   * Closes all currently open positions, regardless of profit/loss.
   * @param {Object} ctx - The application context.
   * @returns {Promise<void>}
   */
  closeAllOpenPositions: (ctx) =>
    monitor.closeAllOpenPositions(ctx, (c, m, label, key) =>
      fetchPricesBestEffort(c, m, label, key)
    ),
  getMoodAdjustments: monitor.getMoodAdjustments,

  /**
   * Merges a new loop request into an existing one.
   * @param {Object} current - The current request object.
   * @param {Object} next - The new request object to merge in.
   * @returns {Object} The merged request object.
   */
  mergeLoopRequest: (current, next) => {
    if (!current) return { ...next };
    return {
      ...current,
      ...next,
      forceDiscovery: Boolean(current.forceDiscovery || next.forceDiscovery),
      skipMonitor: Boolean(current.skipMonitor || next.skipMonitor),
      websocketSignalCount:
        Number(current.websocketSignalCount || 0) + Number(next.websocketSignalCount || 0),
      reason:
        [current.reason, next.reason].filter(Boolean).join('+') || next.reason || current.reason,
    };
  },
};
