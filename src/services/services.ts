import {
  sleep,
  utilService,
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
import { portfolioService } from './trading/portfolio.service.js';
import {
  Context,
  Config,
  TokenMetadata,
  Position,
  SwapOrder,
  EvaluationResult,
} from '../types/index.js';
import path from 'node:path';

/**
 * Resolves the configured buy amount in lamports.
 * Supports both direct lamport value and SOL decimal text.
 * @param config - The application configuration.
 * @returns Atomic lamport amount as string.
 */
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
 * Fetches recent token launches from Jupiter API.
 * @param ctx - The application context.
 * @returns Array of recent token metadata.
 */
export async function fetchRecentLaunches(ctx: Context): Promise<TokenMetadata[]> {
  const url = `${ctx.config.jupiterBaseUrl}/tokens/v2/recent`;
  try {
    const data = (await fetchJson(url, {
      headers: { 'x-api-key': ctx.config.jupiterApiKey },
      timeoutMs: 8000,
      retries: 2,
    })) as TokenMetadata[];
    if (!Array.isArray(data)) throw new Error('Unexpected Jupiter recent response shape.');
    return data;
  } catch (e: unknown) {
    throw new Error(
      `Failed to fetch recent launches: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e }
    );
  }
}

const PUMP_FUN_CURVE_SEED = 'bonding-curve';

/**
 * Fetches market data (price, liquidity) directly from on-chain RPC for supported launchpads (e.g., Pump.fun).
 * This acts as a high-speed fallback when Jupiter API is lagging.
 * @param ctx - The application context.
 * @param mint - Token mint address.
 * @param launchpadName - Optional launchpad hint.
 */
export async function fetchDirectMarketData(
  ctx: Context,
  mint: string,
  launchpadName: string | null = null
): Promise<{ usdPrice: number; liquidity: number; isCompleted: boolean; source: string } | null> {
  let effectiveLaunchpad = launchpadName || ctx.state.marketSnapshots.get(mint)?.launchpad;
  if (!effectiveLaunchpad || effectiveLaunchpad === 'unknown') {
    if (mint.toLowerCase().endsWith('pump')) {
      effectiveLaunchpad = 'pump.fun';
    }
  }

  const launchpad = engine.getLaunchpadProfile(effectiveLaunchpad || 'pump.fun');
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
      { priority: PRIORITY.MEDIUM, cacheTtlMs: 2000 }
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
 * Fetches current prices for a batch of mints from Jupiter V3 Price API.
 * @param ctx - The application context.
 * @param mints - Array of mint addresses.
 * @param apiKey - Optional API key override.
 */
export async function fetchPrices(
  ctx: Context,
  mints: string[],
  apiKey: string | null = null
): Promise<Record<string, { usdPrice: number; [key: string]: unknown }>> {
  if (mints.length === 0) return {};
  const url = `${ctx.config.jupiterBaseUrl}/price/v3?ids=${encodeURIComponent(mints.join(','))}`;

  try {
    const response = (await fetchJson(url, {
      headers: { 'x-api-key': apiKey || ctx.config.jupiterApiKey },
      timeoutMs: 5000,
      retries: 1,
    })) as { data?: Record<string, { usdPrice?: number; price?: number; [key: string]: unknown }> };

    const priceMap = (response?.data ?? response) as Record<
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
  } catch (e: unknown) {
    ctx.logger(`Jupiter price fetch failed: ${e instanceof Error ? e.message : String(e)}`, 'warn');
    return {};
  }
}

/**
 * Fetches prices with a hybrid approach: Jupiter API + Direct RPC Fallback.
 * This ensures high availability and accuracy for volatile tokens.
 * @param ctx - The application context.
 * @param mints - Array of mint addresses to refresh.
 * @param contextLabel - Label for logging context.
 * @param apiKey - Optional API key override.
 */
export async function fetchPricesBestEffort(
  ctx: Context,
  mints: string[],
  contextLabel = 'price refresh',
  apiKey: string | null = null
): Promise<Record<string, { usdPrice: number; [key: string]: unknown }>> {
  const uniqueMints = [...new Set(mints.filter(Boolean))];
  if (uniqueMints.length === 0) return {};
  const startedAt = Date.now();
  const key = apiKey || ctx.config.jupiterApiKey;

  const [apiResult, onChainResults] = await Promise.all([
    fetchPrices(ctx, uniqueMints, key),
    runBoundedPool(
      uniqueMints,
      async (mint) => {
        const direct = await fetchDirectMarketData(ctx, mint);
        return direct ? { [mint]: direct } : null;
      },
      { concurrency: ctx.config.priceFallbackParallelism || 5 }
    ),
  ]);

  const prices: Record<string, { usdPrice: number; [key: string]: unknown }> = { ...apiResult };

  let directCount = 0;
  for (const result of onChainResults) {
    if (result.status === 'fulfilled' && result.value) {
      const mint = result.item;
      const directData = (
        result.value as Record<string, { usdPrice: number; [key: string]: unknown }>
      )[mint];
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

  const stillMissingMints = uniqueMints.filter((m) => !prices[m] || !(prices[m].usdPrice > 0));
  if (stillMissingMints.length > 0) {
    const fallbackResults = await runBoundedPool(
      stillMissingMints,
      async (mint) => {
        return fetchPrices(ctx, [mint], key);
      },
      { concurrency: ctx.config.priceFallbackParallelism || 1 }
    );
    for (const r of fallbackResults) {
      if (r.status === 'fulfilled' && r.value) {
        Object.assign(prices, r.value);
      }
    }
  }

  const duration = Date.now() - startedAt;
  if (duration > 2000) {
    ctx.logger(
      `Slow ${contextLabel}: duration=${duration}ms, mints=${uniqueMints.length}, direct=${directCount}, api=${Object.keys(apiResult).length}, fallback=${stillMissingMints.length}`,
      'debug'
    );
  }

  return prices;
}

// Re-export core engine evaluation logic
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
 * Supports Paper, Dry-Run, and Live trading modes.
 * @param ctx - The application context.
 * @param evaluation - The audit evaluation result.
 * @param prefetchedQuotePromise - Optional promise of a pre-fetched quote to minimize latency.
 */
export async function buyCandidate(
  ctx: Context,
  evaluation: EvaluationResult,
  prefetchedQuotePromise: Promise<SwapOrder | null> | null = null
): Promise<Position | null> {
  ctx.store.incrementMetric('buyAttempts');
  const { token, candidateScore } = evaluation;
  const decimals = Number(token.decimals || 6);

  const tpPlan = monitor.getTakeProfitPlan(ctx, candidateScore);
  const mood = monitor.getMoodAdjustments(ctx);

  if (mood.isPaused) {
    ctx.logger(`Buy skipped for ${token.symbol}: Mood Paused.`, 'warn');
    return null;
  }

  try {
    const baseBuyLamports = BigInt(resolveBuyAmountLamports(ctx.config));
    const adjustedBuySize = portfolioService.getAdjustedBuySize(ctx, baseBuyLamports);

    const buyLamports = (adjustedBuySize * BigInt(Math.round(mood.sizeMultiplier * 100))) / 100n;
    const buySolText = atomicToDecimalString(buyLamports, 9, 6);

    if (ctx.config.paperTrading) {
      return await executePaperBuy(ctx, evaluation, buyLamports, buySolText, decimals, tpPlan);
    }

    if (ctx.config.dryRun) {
      await trading.tradingService.getWalletTokenBalance(ctx, token.id, PRIORITY.HIGH);
      ctx.logger(`DRY_RUN would buy ${token.symbol} for ${buySolText} SOL.`, 'trade');
      return null;
    }

    return await executeLiveBuy(
      ctx,
      evaluation,
      buyLamports,
      buySolText,
      decimals,
      tpPlan,
      prefetchedQuotePromise
    );
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
 * Executes a simulated buy in Paper Trading mode.
 */
async function executePaperBuy(
  ctx: Context,
  evaluation: EvaluationResult,
  buyLamports: bigint,
  buySolText: string,
  decimals: number,
  tpPlan: monitor.TakeProfitPlan
): Promise<Position | null> {
  const { token, candidateScore } = evaluation;
  if (BigInt(ctx.state.paperSolBalanceLamports) < buyLamports) {
    ctx.logger(`Paper wallet insufficient SOL.`, 'warn');
    return null;
  }

  const quote = await trading.buildPaperBuyQuote(ctx, token, decimals, buyLamports);
  ctx.store.updatePaperSolBalance(BigInt(ctx.state.paperSolBalanceLamports) - buyLamports);

  const pos: Position = {
    mint: token.id,
    symbol: token.symbol,
    name: token.name,
    decimals,
    openedAt: new Date().toISOString(),
    mode: 'paper',
    entryPriceUsd: quote.entryPriceUsd,
    entryPriceSol: quote.entryPriceUsd / quote.solPrice,
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
    remainingCostSol: Number(atomicToDecimalString(buyLamports, 9, 9)),
    realizedPnlUsd: 0,
    realizedPnlSol: 0,
    realizedProceedsUsd: 0,
    realizedProceedsSol: 0,
    entryLiquidityUsd: Number(token.liquidity || 0),
    volatilityScaler: evaluation.volatilityScaler || 0,
    launchpad: token.launchpad || null,
    entryScore: candidateScore,
    paperEntryQuoteOutAmount: quote.outAmount.toString(),
    minTpReached: false,
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

  ctx.store.upsertPosition(pos);
  void logTradeToFile(ctx, 'trades.jsonl', pos);
  journalPaperTrade(ctx, {
    event: 'buy',
    mint: token.id,
    symbol: token.symbol,
    priceUsd: quote.entryPriceUsd,
    solAmount: buySolText,
    tokenAmount: quote.outAmount.toString(),
    mode: 'paper',
  });

  ctx.logger(
    `PAPER buy ${token.symbol} (score ${candidateScore}). [PAPER SOL: ${atomicToDecimalString(ctx.state.paperSolBalanceLamports, 9, 4)}]`,
    'trade'
  );
  return pos;
}

/**
 * Executes a real buy on the Solana mainnet.
 */
async function executeLiveBuy(
  ctx: Context,
  evaluation: EvaluationResult,
  buyLamports: bigint,
  buySolText: string,
  decimals: number,
  tpPlan: monitor.TakeProfitPlan,
  prefetchedQuotePromise: Promise<SwapOrder | null> | null
): Promise<Position | null> {
  const { token, candidateScore } = evaluation;
  const solPricePromise = trading.tradingService.estimateSolUsdPrice(ctx);
  const beforeBalancePromise = trading.tradingService.getWalletTokenBalance(
    ctx,
    token.id,
    PRIORITY.HIGH
  );

  const initialOrder = prefetchedQuotePromise ? await prefetchedQuotePromise : null;
  const beforeBalance = await beforeBalancePromise;
  const { signature: sig, order } = await trading.tradingService.executeSwapOrderWithSmartRetry(
    ctx,
    SOL_MINT,
    token.id,
    buyLamports.toString(),
    false,
    initialOrder
  );

  // Poll for balance update to confirm transaction finality and get exact received amount
  let afterBalance = beforeBalance;
  for (let i = 0; i < 6; i++) {
    await sleep(1000 + i * 500);
    afterBalance = await trading.tradingService.getWalletTokenBalance(ctx, token.id, PRIORITY.HIGH);
    if (afterBalance.rawAmount > beforeBalance.rawAmount) break;
  }

  const solPrice = await solPricePromise;
  const entryUsdValue =
    Number(order.inUsdValue || 0) > 0
      ? Number(order.inUsdValue)
      : await trading.tradingService.estimateSolUsdValue(ctx, buyLamports);
  const entrySolValue =
    entryUsdValue > 0 ? entryUsdValue / solPrice : Number(atomicToDecimalString(buyLamports, 9, 9));

  const received =
    afterBalance.rawAmount - beforeBalance.rawAmount > 0n
      ? afterBalance.rawAmount - beforeBalance.rawAmount
      : BigInt(order.outAmount || '0');
  if (received <= 0n) throw new Error(`Buy confirmation failed (zero delta) for ${sig}`);

  const actualDecimals = afterBalance.decimals || decimals;
  const units = Number(atomicToDecimalString(received, actualDecimals, 9));
  const entryPriceUsd = units > 0 ? entryUsdValue / units : Number(token.usdPrice || 0);

  const pos: Position = {
    mint: token.id,
    symbol: token.symbol,
    name: token.name,
    decimals: actualDecimals,
    openedAt: new Date().toISOString(),
    mode: 'live',
    entryPriceUsd,
    entryPriceSol: entryPriceUsd / solPrice,
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
    lastKnownPriceUsd: entryPriceUsd,
    highestPriceUsd: entryPriceUsd,
    partiallyClosed: false,
    remainingCostUsd: entryUsdValue,
    remainingCostSol: entrySolValue,
    realizedPnlUsd: 0,
    realizedPnlSol: 0,
    realizedProceedsUsd: 0,
    realizedProceedsSol: 0,
    entryLiquidityUsd: Number(token.liquidity || 0),
    volatilityScaler: evaluation.volatilityScaler || 0,
    launchpad: token.launchpad || null,
    entryScore: candidateScore,
    buySignature: sig,
    minTpReached: false,
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

  ctx.store.upsertPosition(pos);
  void logTradeToFile(ctx, 'stats.json', pos, true);

  const msg = `BUY: ${token.symbol}\nScore: ${candidateScore}\nAmount: ${buySolText} SOL\nPrice: ${formatUsd(entryPriceUsd)}`;
  void sendNotification(ctx, msg).catch((err: unknown) => {
    ctx.logger(
      `Buy notification failed for ${token.symbol}: ${err instanceof Error ? err.message : String(err)}`,
      'debug'
    );
  });

  ctx.logger(
    `Bought ${token.symbol} for ${buySolText} SOL. Entry ${formatUsd(entryPriceUsd)} in tx ${sig}.`,
    'trade'
  );
  return pos;
}

/**
 * Logs trade data to a file.
 */
async function logTradeToFile(
  ctx: Context,
  fileName: string,
  data: unknown,
  atomic = false
): Promise<void> {
  const logDir = path.dirname(ctx.config.logFile);
  const filePath = path.join(logDir, fileName);
  try {
    if (atomic) {
      await utilService.atomicWriteFile(filePath, safeJsonStringify(data, 2));
    } else {
      await fs.promises.appendFile(filePath, safeJsonStringify(data) + '\n');
    }
  } catch (err: unknown) {
    ctx.logger(
      `Failed to log to ${fileName}: ${err instanceof Error ? err.message : String(err)}`,
      'error'
    );
  }
}

/**
 * Periodically monitors open positions for exit conditions.
 */
export async function monitorPositions(ctx: Context): Promise<void> {
  return monitor.monitorPositions(ctx, (c, m, label, key) =>
    fetchPricesBestEffort(c, m, label, key || undefined)
  );
}

/**
 * Closes all currently open positions.
 */
export async function closeAllOpenPositions(ctx: Context): Promise<void> {
  return monitor.closeAllOpenPositions(
    ctx,
    (c: Context, m: string[], label: string, key?: string) =>
      fetchPricesBestEffort(c, m, label, key)
  );
}

// Re-export mood adjustments from monitor service
import { getMoodAdjustments as monitorGetMoodAdjustments } from './monitor/monitor.service.js';
export const getMoodAdjustments = monitorGetMoodAdjustments;

/**
 * Merges two loop requests, combining reasons and signal counts.
 */
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

/**
 * Service object to allow for easier mocking in ESM environments.
 */
export const appService = {
  fetchRecentLaunches,
  fetchDirectMarketData,
  fetchPrices,
  fetchPricesBestEffort,
  evaluateCandidate,
  getLaunchpadProfile,
  looksLikeMemecoin,
  buyCandidate,
  monitorPositions,
  closeAllOpenPositions,
  getMoodAdjustments,
  mergeLoopRequest,
};
