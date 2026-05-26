import { address } from '@solana/addresses';
import {
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
  signTransaction,
} from '@solana/transactions';
import { createJupiterApiClient } from '@jup-ag/api';
import {
  rpcCall,
  fetchJson,
  atomicToDecimalString,
  decimalToAtomic,
  PRIORITY,
} from '../../core/utils.js';
import { SOL_MINT } from '../../core/config.js';
import { Context, SwapOrder, TokenMetadata } from '../../types/index.js';

const SOL_PRICE_CACHE_TTL_MS = 10_000;
let _solPriceCache = { price: 0, fetchedAt: 0 };

/**
 * Retrieves the wallet address from the context.
 * @param ctx - The application context.
 * @returns The wallet address.
 * @throws {Error} If the wallet address is unavailable.
 */
export async function getWalletAddress(ctx: Context): Promise<string> {
  const walletAddress = ctx.wallet?.address;
  if (!walletAddress) throw new Error('Wallet address is unavailable.');
  return walletAddress;
}

export interface WalletBalance {
  mint: string;
  rawAmount: bigint;
  decimals: number;
  uiAmount: number;
}

/**
 * Fetches the token balance for a given mint in the current wallet.
 * Supports both paper trading and live wallet checks.
 * @param ctx - The application context.
 * @param mint - The token mint address.
 * @returns Balance info (mint, rawAmount, decimals, uiAmount).
 */
export async function getWalletTokenBalance(
  ctx: Context,
  mint: string,
  priority: PRIORITY = PRIORITY.MEDIUM
): Promise<WalletBalance> {
  if (ctx.config.paperTrading) {
    const pos = ctx.state.positions.get(mint);
    const raw = BigInt(pos?.initialTokenAmountRaw || '0'); // Fallback to initialTokenAmountRaw if lastKnownBalanceRaw not parsed
    const dec = Number(pos?.decimals || 0);
    return {
      mint,
      rawAmount: raw,
      decimals: dec,
      uiAmount: Number(atomicToDecimalString(raw, dec, 9)),
    };
  }
  const res = await rpcCall(
    ctx,
    'getTokenAccountsByOwner',
    [
      address(await getWalletAddress(ctx)),
      { mint: address(mint) },
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ],
    { priority }
  );
  let raw = 0n;
  let dec = 0;
  for (const acc of res.value || []) {
    const info = acc.account.data?.parsed?.info?.tokenAmount;
    if (info?.amount) {
      raw += BigInt(info.amount);
      dec = info.decimals;
    }
  }
  return {
    mint,
    rawAmount: raw,
    decimals: dec,
    uiAmount: Number(atomicToDecimalString(raw, dec, 9)),
  };
}

/**
 * Fetches dynamic priority fees based on recent prioritization fees on-chain.
 * @param ctx - The application context.
 * @param accountKeys - Keys to check for prioritization.
 * @param isPanic - Whether to apply the panic multiplier.
 * @returns Effective priority fee in micro-lamports.
 */
export async function fetchDynamicPriorityFee(
  ctx: Context,
  accountKeys: string[] = [],
  isPanic = false
): Promise<number> {
  try {
    const publicKeys = accountKeys.map((key) => address(key));
    const fees = await rpcCall(ctx, 'getRecentPrioritizationFees', [publicKeys], {
      priority: PRIORITY.HIGH,
    });

    if (fees.length === 0) {
      return ctx.config.priorityFeeBaseMicroLamports;
    }

    const sortedFees = fees
      .map((f: any) => f.prioritizationFee)
      .sort((a: number, b: number) => a - b);
    const index = Math.floor((ctx.config.priorityFeePercentile / 100) * (sortedFees.length - 1));
    const baseFee = sortedFees[index] || 0;

    let finalFee = Math.max(ctx.config.priorityFeeBaseMicroLamports, baseFee);
    if (isPanic) {
      finalFee = Math.round(finalFee * ctx.config.priorityFeePanicMultiplier);
    }

    return Math.min(finalFee, ctx.config.priorityFeeMaxMicroLamports);
  } catch (error: any) {
    ctx.logger(`Failed to fetch priority fees: ${error.message}. Using base fee.`, 'warn');
    return ctx.config.priorityFeeBaseMicroLamports;
  }
}

/**
 * Fetches a swap order using the Jupiter SDK.
 */
export async function fetchSdkSwapOrder(
  ctx: Context,
  inputMint: string,
  outputMint: string,
  amountLamports: bigint | string,
  isPanic = false
): Promise<SwapOrder> {
  const basePath =
    ctx.config.jupiterBaseUrl.includes('api.jup.ag') && !ctx.config.jupiterBaseUrl.includes('v6')
      ? 'https://quote-api.jup.ag/v6'
      : ctx.config.jupiterBaseUrl;

  const jupiterQuoteApi = createJupiterApiClient({
    basePath,
    apiKey: ctx.config.jupiterApiKey,
  });

  try {
    const quote = await jupiterQuoteApi.quoteGet({
      inputMint,
      outputMint,
      amount: Number(amountLamports),
      slippageBps: ctx.config.slippageBps,
      onlyDirectRoutes: false,
      asLegacyTransaction: false,
    });

    if (!quote) throw new Error('No quote found for SDK swap.');

    const swapResult = await jupiterQuoteApi.swapPost({
      swapRequest: {
        quoteResponse: quote,
        userPublicKey: await getWalletAddress(ctx),
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: isPanic
          ? {
              priorityLevelWithMaxLamports: {
                priorityLevel: 'veryHigh',
                maxLamports: 10_000_000,
              },
            }
          : {
              priorityLevelWithMaxLamports: {
                priorityLevel: 'high',
                maxLamports: 2_000_000,
              },
            },
      },
    });

    if (!swapResult || !swapResult.swapTransaction) {
      throw new Error('No swap transaction received from SDK.');
    }

    return {
      transaction: swapResult.swapTransaction,
      lastValidBlockHeight: swapResult.lastValidBlockHeight,
      requestId: (swapResult as any).requestId,
    };
  } catch (error: any) {
    if (error.name === 'ResponseError' && error.response) {
      const status = error.response.status;
      let body = 'unable to parse body';
      try {
        body = JSON.stringify(await error.response.json());
      } catch {}
      throw new Error(`Jupiter SDK error ${status}: ${body}`);
    }
    throw error;
  }
}

/**
 * Fetches a swap order from Jupiter (either via SDK or HTTP API).
 */
export async function fetchSwapOrder(
  ctx: Context,
  inputMint: string,
  outputMint: string,
  amount: bigint | string,
  isPanic = false
): Promise<SwapOrder> {
  if (ctx.config.useJupiterSdk) {
    ctx.logger(`Using Jupiter SDK path for ${outputMint}.`, 'debug');
    return await fetchSdkSwapOrder(ctx, inputMint, outputMint, amount, isPanic);
  }

  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amount),
    taker: await getWalletAddress(ctx),
    slippageBps: String(ctx.config.slippageBps),
    autoWrapSol: 'true',
  });

  const url = `${ctx.config.jupiterBaseUrl}/swap/v2/order?${params.toString()}`;
  try {
    const order = await fetchJson(url, {
      headers: { 'x-api-key': ctx.config.jupiterApiKey },
    });

    if (!order || !order.transaction) {
      throw new Error(order?.errorMessage || order?.error || 'No transaction from Jupiter.');
    }

    return order;
  } catch (error: any) {
    throw new Error(`Jupiter V2 order failed: ${error.message}`);
  }
}

/**
 * Executes a swap order. Dispatches to either Jupiter managed execution or direct RPC submission.
 */
export async function executeSwapOrder(ctx: Context, order: SwapOrder): Promise<string> {
  if (order.requestId) {
    return executeJupiterManagedOrder(ctx, order);
  }
  return executeSwapOrderViaRpc(ctx, order);
}

function getSignedTransactionBase64(transaction: any): string {
  return getBase64EncodedWireTransaction(transaction);
}

async function signSwapTransaction(
  ctx: Context,
  order: SwapOrder,
  allowPartialSignatures = false
): Promise<string> {
  const transactionBytes = Buffer.from(order.transaction, 'base64');
  const transaction = getTransactionDecoder().decode(transactionBytes);
  const signer = allowPartialSignatures ? partiallySignTransaction : signTransaction;
  const signedTransaction = await signer([ctx.wallet.keypair], transaction as any);
  return getSignedTransactionBase64(signedTransaction);
}

async function executeJupiterManagedOrder(ctx: Context, order: SwapOrder): Promise<string> {
  const signedTransaction = await signSwapTransaction(ctx, order, true);
  const body: any = {
    signedTransaction,
    requestId: order.requestId,
  };

  if (order.lastValidBlockHeight) {
    body.lastValidBlockHeight = order.lastValidBlockHeight;
  }

  const result = await fetchJson(`${ctx.config.jupiterBaseUrl}/swap/v2/execute`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ctx.config.jupiterApiKey,
    },
    body,
  });

  if (!result || result.status !== 'Success' || !result.signature) {
    const details = result ? JSON.stringify(result) : 'empty response';
    throw new Error(`Jupiter execute failed: ${details}`);
  }

  return result.signature;
}

async function executeSwapOrderViaRpc(ctx: Context, order: SwapOrder): Promise<string> {
  const wireTransactionBase64 = await signSwapTransaction(ctx, order, false);

  const sig = await rpcCall(
    ctx,
    'sendTransaction',
    [
      wireTransactionBase64,
      {
        encoding: 'base64',
        maxRetries: 3,
        preflightCommitment: 'confirmed',
        skipPreflight: false,
      },
    ],
    { priority: PRIORITY.HIGH }
  );

  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
    ctx.logger(`Transaction ${sig} not confirmed by WebSocket after 30s.`, 'warn');
  }, 30000);

  try {
    const notifications = await ctx.rpcSubscriptions
      .signatureNotifications(sig, { commitment: 'confirmed' })
      .subscribe({ abortSignal: abortController.signal });

    for await (const notification of notifications) {
      clearTimeout(timeout);
      abortController.abort();
      if (notification.value.err) {
        throw new Error(`Swap failed: ${JSON.stringify(notification.value.err)}`);
      } else {
        ctx.logger(`Transaction ${sig} confirmed via WebSocket.`, 'debug');
        return sig;
      }
    }
    return sig;
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return sig;
    }
    throw err;
  }
}

/**
 * Estimates the current SOL price in USD using Jupiter's price API.
 */
export async function estimateSolUsdPrice(
  ctx: Context,
  apiKey: string | null = null
): Promise<number> {
  if (typeof (ctx as any).getSolUsdPrice === 'function') {
    const overriddenPrice = Number(await (ctx as any).getSolUsdPrice());
    if (overriddenPrice > 0) return overriddenPrice;
  }

  const now = Date.now();
  if (_solPriceCache.price > 0 && now - _solPriceCache.fetchedAt < SOL_PRICE_CACHE_TTL_MS) {
    return _solPriceCache.price;
  }

  const url = `${ctx.config.jupiterBaseUrl}/price/v3?ids=${SOL_MINT}`;
  const response = await fetchJson(url, {
    headers: { 'x-api-key': apiKey || ctx.config.jupiterApiKey },
  });

  const priceMap = response?.data ?? response;
  if (!priceMap?.[SOL_MINT]) {
    ctx.logger(`Jupiter price response missing SOL: ${JSON.stringify(response)}`, 'error');
    throw new Error('No SOL price available.');
  }

  const record = priceMap[SOL_MINT];
  const p = Number(record.usdPrice || record.price || 0);

  if (!(p > 0)) {
    ctx.logger(`Jupiter SOL price is zero or invalid: ${JSON.stringify(record)}`, 'error');
    throw new Error('No SOL price available.');
  }

  _solPriceCache = { price: p, fetchedAt: now };
  return p;
}

/**
 * Estimates the USD value of a given amount of lamports.
 */
export async function estimateSolUsdValue(
  ctx: Context,
  amountLamports: bigint | string,
  apiKey: string | null = null
): Promise<number> {
  const p = await estimateSolUsdPrice(ctx, apiKey);
  return p * Number(atomicToDecimalString(amountLamports, 9, 9));
}

/**
 * Builds a buy quote for paper trading based on current market price.
 */
export async function buildPaperBuyQuote(
  ctx: Context,
  token: TokenMetadata,
  decimals: number,
  buyLamports: bigint | string
): Promise<{ outAmount: bigint; entryUsdValue: number; entryPriceUsd: number }> {
  const p = Number(token.usdPrice || 0);
  if (!(p > 0)) throw new Error(`No price for paper buy ${token.symbol}.`);
  const val = await estimateSolUsdValue(ctx, buyLamports);
  const units = val / p;
  const raw = BigInt(decimalToAtomic(units.toFixed(Math.min(decimals, 9)), decimals));
  const out = (raw * BigInt(Math.max(0, 10000 - ctx.config.slippageBps))) / 10000n;
  if (out <= 0n) throw new Error('Paper buy rounded to zero.');
  return { outAmount: out, entryUsdValue: val, entryPriceUsd: p };
}

/**
 * Builds a sell quote for paper trading based on current market price.
 */
export async function buildPaperSellQuote(
  ctx: Context,
  rawAmount: bigint | string,
  pUsd: number,
  dec: number,
  apiKey: string | null = null
): Promise<{ outAmount: bigint; grossUsdValue: number }> {
  if (!(pUsd > 0)) throw new Error('No price for paper sell.');
  const solP = await estimateSolUsdPrice(ctx, apiKey);
  const val = Number(atomicToDecimalString(rawAmount, dec, 9)) * pUsd;
  const rawLamports = BigInt(decimalToAtomic((val / solP).toFixed(9), 9));
  const out = (rawLamports * BigInt(Math.max(0, 10000 - ctx.config.slippageBps))) / 10000n;
  if (out <= 0n) throw new Error('Paper sell rounded to zero.');
  return { outAmount: out, grossUsdValue: val };
}
