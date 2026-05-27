import {
  sleep,
  atomicWriteFile,
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
} from '../core/utils.js';
import fs from 'node:fs';
import { PUMP_FUN_PROGRAM_ID, SOL_MINT } from '../core/config.js';
import { address, getProgramDerivedAddress, getAddressEncoder } from '@solana/addresses';
import * as engine from './engine/engine.service.js';
import * as trading from './trading/trading.service.js';
import * as monitor from './monitor/monitor.service.js';
import {
  Context,
  Config,
  TokenMetadata,
  Position,
  SwapOrder,
  EvaluationResult,
} from '../types/index.js';
import path from 'node:path';

function resolveBuyAmountLamports(config: Config): string {
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
 */
export async function fetchRecentLaunches(ctx: Context): Promise<TokenMetadata[]> {
  const url = `${ctx.config.jupiterBaseUrl}/tokens/v2/recent`;
  const data = (await fetchJson(url, {
    headers: { 'x-api-key': ctx.config.jupiterApiKey },
    timeoutMs: 8000,
    retries: 1,
  })) as TokenMetadata[];
  if (!Array.isArray(data)) throw new Error('Unexpected Jupiter recent response shape.');
  return data;
}

const PUMP_FUN_CURVE_SEED = 'bonding-curve';

/**
 * Fetches market data (price, liquidity) directly from on-chain RPC for supported launchpads.
 */
export async function fetchDirectMarketData(
  ctx: Context,
  mint: string,
  launchpadName: string | null = null
): Promise<{ usdPrice: number; liquidity: number; isCompleted: boolean; source: string } | null> {
  const launchpad = engine.getLaunchpadProfile(
    launchpadName || ctx.state.marketSnapshots.get(mint)?.launchpad || 'pump.fun'
  );
  if (launchpad.name !== 'pump.fun') return null;

  try {
    const programId = address(PUMP_FUN_PROGRAM_ID);
    const mintAddress = address(mint);
    const [curveAddress] = await getProgramDerivedAddress({
      programAddress: programId,
      seeds: [Buffer.from(PUMP_FUN_CURVE_SEED, 'utf8'), getAddressEncoder().encode(mintAddress)],
    });

    const account = (await rpcCall(
      ctx,
      'getAccountInfo',
      [
        curveAddress,
        {
          encoding: 'base64',
          commitment: 'confirmed',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ],
      { priority: PRIORITY.MEDIUM, cacheTtlMs: 5000 }
    )) as { value: { data: string[] } | null };

    const data = account.value?.data;
    if (!data || !Array.isArray(data) || !data[0]) return null;
    const curve = decodePumpCurve(Buffer.from(data[0], 'base64'));
    if (!curve) return null;

    const solPrice = await trading.estimateSolUsdValue(ctx, 1000000000n);
    const virtualSolReserves = Number(curve.virtualSolReserves) / 1e9;
    const virtualTokenReserves = Number(curve.virtualTokenReserves) / 1e6;
    const usdPrice = (virtualSolReserves / virtualTokenReserves) * solPrice;

    const realSolReserves = Number(curve.realSolReserves) / 1e9;
    const liquidity = realSolReserves * 2 * solPrice;

    return {
      usdPrice,
      liquidity,
      isCompleted: curve.isCompleted,
      source: 'rpc-direct',
    };
  } catch (e: unknown) {
    ctx.logger(
      `Direct RPC market data fetch failed for ${mint}: ${e instanceof Error ? e.message : String(e)}`,
      'debug'
    );
    return null;
  }
}

/**
 * Fetches current prices for a batch of mints from Jupiter.
 */
export async function fetchPrices(
  ctx: Context,
  mints: string[],
  apiKey: string | null = null
): Promise<Record<string, { usdPrice: number; [key: string]: unknown }>> {
  if (mints.length === 0) return {};
  const url = `${ctx.config.jupiterBaseUrl}/price/v3?ids=${encodeURIComponent(mints.join(','))}`;
  const response = (await fetchJson(url, {
    headers: { 'x-api-key': apiKey || ctx.config.jupiterApiKey },
    timeoutMs: 5000,
    retries: 1,
  })) as { data?: Record<string, { usdPrice?: number; price?: number; [key: string]: unknown }> };

  if (!response || typeof response !== 'object') throw new Error('Invalid Jupiter price response.');
  const priceMap = (response.data ?? response) as Record<
    string,
    { usdPrice?: number; price?: number; [key: string]: unknown }
  >;
  if (!priceMap || typeof priceMap !== 'object') return {};

  const normalized: Record<string, { usdPrice: number; [key: string]: unknown }> = {};
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
 */
export async function fetchPricesBestEffort(
  ctx: Context,
  mints: string[],
  contextLabel = 'price refresh',
  apiKey: string | null = null
): Promise<Record<string, { usdPrice: number; [key: string]: unknown }>> {
  if (mints.length === 0) return {};
  const startedAt = Date.now();
  const key = apiKey || ctx.config.jupiterApiKey;

  const [apiResult, onChainResults] = await Promise.all([
    (async () => {
      try {
        return await fetchPrices(ctx, mints, key);
      } catch (e: unknown) {
        ctx.logger(
          `Batch ${contextLabel} API failed: ${e instanceof Error ? e.message : String(e)}.`,
          'debug'
        );
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

  const prices: Record<string, { usdPrice: number; [key: string]: unknown }> = { ...apiResult };

  let directCount = 0;
  for (const result of onChainResults) {
    if (result.status === 'fulfilled' && result.value) {
      const mint = result.item;
      const val = result.value as Record<string, { usdPrice: number; [key: string]: unknown }>;
      const directData = val[mint];
      if (directData) {
        directCount++;
        if (prices[mint]) {
          prices[mint] = {
            ...prices[mint],
            ...directData,
            usdPrice: directData.usdPrice > 0 ? directData.usdPrice : prices[mint].usdPrice,
          };
        } else {
          prices[mint] = directData;
        }
      }
    }
  }

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
        Object.assign(
          prices,
          result.value as Record<string, { usdPrice: number; [key: string]: unknown }>
        );
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

import {
  evaluateCandidate as engineEvaluateCandidate,
  getLaunchpadProfile as engineGetLaunchpadProfile,
  looksLikeMemecoin as engineLooksLikeMemecoin,
} from './engine/engine.service.js';
export const evaluateCandidate = engineEvaluateCandidate;
export const getLaunchpadProfile = engineGetLaunchpadProfile;
export const looksLikeMemecoin = engineLooksLikeMemecoin;

/**
 * Evaluates a candidate and executes a buy order if approved.
 * Supports paper, dry-run, and live trading modes.
 */
export async function buyCandidate(
  ctx: Context,
  evaluation: EvaluationResult,
  prefetchedQuotePromise: Promise<SwapOrder | null> | null = null
): Promise<Position | null> {
  ctx.store.incrementMetric('buyAttempts');
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
      (BigInt(configuredBuyAmountLamports) * BigInt(Math.round(mood.sizeMultiplier * 100))) / 100n;
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
      const entryPriceSol = quote.entryPriceUsd / quote.solPrice;
      const entrySolValue = Number(atomicToDecimalString(buyLamports, 9, 9));
      ctx.store.updatePaperSolBalance(BigInt(ctx.state.paperSolBalanceLamports) - buyLamports);
      const pos = {
        mint: token.id,
        symbol: token.symbol,
        name: token.name,
        decimals,
        openedAt: new Date().toISOString(),
        mode: 'paper' as const,
        entryPriceUsd: quote.entryPriceUsd,
        entryPriceSol,
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
        partiallyClosed: false,
        remainingCostUsd: quote.entryUsdValue,
        remainingCostSol: entrySolValue,
        realizedPnlUsd: 0,
        realizedPnlSol: 0,
        realizedProceedsUsd: 0,
        realizedProceedsSol: 0,
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
        mintSignals: evaluation.mintSignals,
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

      const logDir = path.dirname(ctx.config.logFile);
      const tradesFilePath = path.join(logDir, 'trades.jsonl');
      fs.appendFile(tradesFilePath, safeJsonStringify(pos) + '\n', (err: unknown) => {
        if (err)
          ctx.logger(
            `Failed to append to trades file at ${tradesFilePath}: ${err instanceof Error ? err.message : String(err)}`,
            'error'
          );
      });

      ctx.store.upsertPosition(pos);
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

    const order = prefetchedQuotePromise
      ? (await prefetchedQuotePromise) ||
        (await trading.fetchSwapOrder(ctx, SOL_MINT, token.id, buyLamports.toString()))
      : await trading.fetchSwapOrder(ctx, SOL_MINT, token.id, buyLamports.toString());

    const entryUsdValue =
      Number(order.inUsdValue || 0) > 0
        ? Number(order.inUsdValue)
        : await trading.estimateSolUsdValue(ctx, buyLamports);
    const solPrice = await trading.estimateSolUsdPrice(ctx);
    const entryPriceSol = (token.usdPrice || 0) / solPrice;
    const entrySolValue = Number(atomicToDecimalString(buyLamports, 9, 9));
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
      mode: 'live' as const,
      entryPriceUsd,
      entryPriceSol,
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
      partiallyClosed: false,
      remainingCostUsd: entryUsdValue,
      remainingCostSol: entrySolValue,
      realizedPnlUsd: 0,
      realizedPnlSol: 0,
      realizedProceedsUsd: 0,
      realizedProceedsSol: 0,
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
      mintSignals: evaluation.mintSignals,
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

    const logDir = path.dirname(ctx.config.logFile);
    const statsFilePath = path.join(logDir, 'stats.json');
    atomicWriteFile(statsFilePath, safeJsonStringify(pos, 2)).catch((err: unknown) =>
      ctx.logger(
        `Failed to save stats file at ${statsFilePath}: ${err instanceof Error ? err.message : String(err)}`,
        'error'
      )
    );
    ctx.store.upsertPosition(pos);
    const msg = `🚀 <b>BUY: ${token.symbol}</b>\nScore: ${candidateScore}\nAmount: ${buySolText} SOL\nPrice: ${formatUsd(entryPriceUsd)}`;
    await sendNotification(ctx, msg);
    ctx.logger(
      `Bought ${token.symbol} for ${buySolText} SOL. Entry ${formatUsd(entryPriceUsd)} in tx ${sig}.`,
      'trade'
    );
    return pos;
  } catch (e: unknown) {
    ctx.store.incrementMetric('buyFailures');
    ctx.logger(
      `Buy failed for ${token.symbol || token.id}: ${e instanceof Error ? e.message : String(e)}`,
      'error'
    );
    return null;
  }
}

/**
 * Periodically monitors open positions for exit conditions (SL, TP, etc.).
 */
export async function monitorPositions(ctx: Context): Promise<void> {
  return monitor.monitorPositions(ctx, (c, m, label, key) =>
    fetchPricesBestEffort(c, m, label, key || undefined)
  );
}

/**
 * Closes all currently open positions, regardless of profit/loss.
 */
export async function closeAllOpenPositions(ctx: Context): Promise<void> {
  return monitor.closeAllOpenPositions(
    ctx,
    (c: Context, m: string[], label: string, key?: string) =>
      fetchPricesBestEffort(c, m, label, key)
  );
}

import { getMoodAdjustments as monitorGetMoodAdjustments } from './monitor/monitor.service.js';
export const getMoodAdjustments = monitorGetMoodAdjustments;

export function mergeLoopRequest(
  current: Record<string, unknown> | null,
  next: Record<string, unknown>
): Record<string, unknown> {
  if (!current) return { ...next };
  return {
    ...current,
    ...next,
    forceDiscovery: Boolean(current.forceDiscovery || next.forceDiscovery),
    skipMonitor: Boolean(current.skipMonitor || next.skipMonitor),
    websocketSignalCount:
      Number(current.websocketSignalCount || 0) + Number(next.websocketSignalCount || 0),
    reason:
      [current.reason as string, next.reason as string].filter(Boolean).join('+') ||
      (next.reason as string) ||
      (current.reason as string),
  };
}
