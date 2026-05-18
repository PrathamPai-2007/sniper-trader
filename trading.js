'use strict';

// Trade execution adapter: builds swap orders, signs and submits transactions,
// handles confirmation polling, and provides paper-trading quote calculations.

const { address } = require('@solana/addresses');
const {
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
  signTransaction,
} = require('@solana/transactions');
const { createJupiterApiClient } = require('@jup-ag/api');
const { rpcCall, fetchJson, atomicToDecimalString, decimalToAtomic, PRIORITY } = require('./utils');
const { constants } = require('./config');

const { SOL_MINT } = constants;

// Cache the last successful SOL/USD price to avoid a redundant /price/v3 call
// on every buy attempt when the scan and monitor loops already fetch it regularly.
const SOL_PRICE_CACHE_TTL_MS = 10_000;
let _solPriceCache = { price: 0, fetchedAt: 0 };

/**
 * Retrieves the wallet address from the context.
 * @param {Object} ctx - The application context.
 * @returns {Promise<string>} The wallet address.
 * @throws {Error} If the wallet address is unavailable.
 */
async function getWalletAddress(ctx) {
  const walletAddress = ctx.wallet?.address;
  if (!walletAddress) throw new Error('Wallet address is unavailable.');
  return walletAddress;
}

/**
 * Fetches the token balance for a given mint in the current wallet.
 * Supports both paper trading and live wallet checks.
 * @param {Object} ctx - The application context.
 * @param {string} mint - The token mint address.
 * @returns {Promise<Object>} Balance info (mint, rawAmount, decimals, uiAmount).
 */
async function getWalletTokenBalance(ctx, mint, priority = PRIORITY.MEDIUM) {
  if (ctx.config.paperTrading) {
    const pos = ctx.state.positions.get(mint);
    const raw = BigInt(pos?.lastKnownBalanceRaw || '0');
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
  let raw = 0n,
    dec = 0;
  for (const acc of res.value) {
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
 * @param {Object} ctx - The application context.
 * @param {string[]} [accountKeys=[]] - Keys to check for prioritization.
 * @param {boolean} [isPanic=false] - Whether to apply the panic multiplier.
 * @returns {Promise<number>} Effective priority fee in micro-lamports.
 */
async function fetchDynamicPriorityFee(ctx, accountKeys = [], isPanic = false) {
  try {
    const publicKeys = accountKeys.map((key) => address(key));
    const fees = await rpcCall(ctx, 'getRecentPrioritizationFees', [publicKeys], {
      priority: PRIORITY.HIGH,
    });

    if (fees.length === 0) {
      return ctx.config.priorityFeeBaseMicroLamports;
    }

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

/**
 * Fetches a swap order using the Jupiter SDK.
 * @param {Object} ctx - The application context.
 * @param {string} inputMint - The input token mint address.
 * @param {string} outputMint - The output token mint address.
 * @param {bigint|string} amountLamports - The input amount in atomic units.
 * @param {boolean} [isPanic=false] - Whether to apply panic fee settings.
 * @returns {Promise<Object>} The swap order (transaction, lastValidBlockHeight).
 * @throws {Error} If no quote or transaction is received.
 */
async function fetchSdkSwapOrder(ctx, inputMint, outputMint, amountLamports, isPanic = false) {
  // Use a dedicated V6 endpoint for the SDK if the base URL is the standard api.jup.ag
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
      amount: String(amountLamports),
      slippageBps: ctx.config.slippageBps,
      onlyDirectRoutes: false, // Allow multi-hop if needed for better price
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
                maxLamports: 10_000_000, // 0.01 SOL cap for panic
              },
            }
          : {
              priorityLevelWithMaxLamports: {
                priorityLevel: 'high',
                maxLamports: 2_000_000, // 0.002 SOL cap for standard
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
      requestId: swapResult.requestId,
    };
  } catch (error) {
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
 * @param {Object} ctx - The application context.
 * @param {string} inputMint - The input token mint address.
 * @param {string} outputMint - The output token mint address.
 * @param {bigint|string} amount - The input amount in atomic units.
 * @param {boolean} [isPanic=false] - Whether to apply panic fee settings.
 * @returns {Promise<Object>} The swap order object.
 * @throws {Error} If the order cannot be retrieved.
 */
async function fetchSwapOrder(ctx, inputMint, outputMint, amount, isPanic = false) {
  if (ctx.config.useJupiterSdk) {
    ctx.logger(`Using Jupiter SDK path for ${outputMint}.`, 'debug');
    return await fetchSdkSwapOrder(ctx, inputMint, outputMint, amount, isPanic);
  }

  // The /swap/v2/order endpoint (Meta-Aggregator) expects 'taker' and standard swap params.
  // It may not support 'swapMode' or 'computeUnitPriceMicroLamports' in the GET request;
  // instead, priority fees are typically handled at the execution or transaction assembly stage.
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
  } catch (error) {
    // fetchJson already includes status and details, but we'll ensure it's clear
    throw new Error(`Jupiter V2 order failed: ${error.message}`);
  }
}

/**
 * Executes a swap order. Dispatches to either Jupiter managed execution or direct RPC submission.
 * @param {Object} ctx - The application context.
 * @param {Object} order - The swap order object.
 * @returns {Promise<string>} The transaction signature.
 */
async function executeSwapOrder(ctx, order) {
  if (order.requestId) {
    return executeJupiterManagedOrder(ctx, order);
  }
  return executeSwapOrderViaRpc(ctx, order);
}

/**
 * Encodes a transaction to a base64 wire format string.
 * @param {Object} transaction - The transaction object.
 * @returns {string} Base64 encoded wire transaction.
 */
function getSignedTransactionBase64(transaction) {
  return getBase64EncodedWireTransaction(transaction);
}

/**
 * Signs a swap transaction from a Jupiter order.
 * @param {Object} ctx - The application context.
 * @param {Object} order - The swap order containing the base64 transaction.
 * @param {boolean} [allowPartialSignatures=false] - Whether to use partial signing.
 * @returns {Promise<string>} Base64 encoded signed wire transaction.
 */
async function signSwapTransaction(ctx, order, allowPartialSignatures = false) {
  const transactionBytes = Buffer.from(order.transaction, 'base64');
  const transaction = getTransactionDecoder().decode(transactionBytes);
  const signer = allowPartialSignatures ? partiallySignTransaction : signTransaction;
  const signedTransaction = await signer([ctx.wallet.keyPair], transaction);
  return getSignedTransactionBase64(signedTransaction);
}

/**
 * Executes a swap order using Jupiter's managed /execute endpoint.
 * @param {Object} ctx - The application context.
 * @param {Object} order - The swap order object.
 * @returns {Promise<string>} The transaction signature.
 * @throws {Error} If execution fails.
 */
async function executeJupiterManagedOrder(ctx, order) {
  const signedTransaction = await signSwapTransaction(ctx, order, true);
  const body = {
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

/**
 * Executes a swap order by submitting it directly to the Solana RPC.
 * @param {Object} ctx - The application context.
 * @param {Object} order - The swap order object.
 * @returns {Promise<string>} The transaction signature.
 */
async function executeSwapOrderViaRpc(ctx, order) {
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

  // Modern v2 confirmation: use WebSocket for sub-second reaction
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
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return sig; // resolve anyway if timed out
    }
    throw err;
  }
}

/**
 * Estimates the current SOL price in USD using Jupiter's price API.
 * @param {Object} ctx - The application context.
 * @param {string} [apiKey=null] - Optional Jupiter API key.
 * @returns {Promise<number>} The price of 1 SOL in USD.
 * @throws {Error} If the price is unavailable or invalid.
 */
async function estimateSolUsdPrice(ctx, apiKey = null) {
  if (typeof ctx?.getSolUsdPrice === 'function') {
    const overriddenPrice = Number(await ctx.getSolUsdPrice());
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
 * @param {Object} ctx - The application context.
 * @param {bigint|string} amountLamports - Amount in lamports.
 * @param {string} [apiKey=null] - Optional Jupiter API key.
 * @returns {Promise<number>} Estimated USD value.
 */
async function estimateSolUsdValue(ctx, amountLamports, apiKey = null) {
  const p = await estimateSolUsdPrice(ctx, apiKey);
  return p * Number(atomicToDecimalString(amountLamports, 9, 9));
}

/**
 * Builds a buy quote for paper trading based on current market price.
 * @param {Object} ctx - The application context.
 * @param {Object} token - Token data (must include usdPrice).
 * @param {number} decimals - Token decimals.
 * @param {bigint|string} buyLamports - Amount of SOL to spend.
 * @returns {Promise<Object>} Quote result (outAmount, entryUsdValue, entryPriceUsd).
 * @throws {Error} If price is missing or resulting amount is zero.
 */
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

/**
 * Builds a sell quote for paper trading based on current market price.
 * @param {Object} ctx - The application context.
 * @param {bigint|string} rawAmount - Atomic token amount to sell.
 * @param {number} pUsd - Current token price in USD.
 * @param {number} dec - Token decimals.
 * @param {string} [apiKey=null] - Optional Jupiter API key.
 * @returns {Promise<Object>} Quote result (outAmount, grossUsdValue).
 * @throws {Error} If price is missing or resulting amount is zero.
 */
async function buildPaperSellQuote(ctx, rawAmount, pUsd, dec, apiKey = null) {
  if (!(pUsd > 0)) throw new Error('No price for paper sell.');
  const solP = await estimateSolUsdPrice(ctx, apiKey);
  const val = Number(atomicToDecimalString(rawAmount, dec, 9)) * pUsd;
  const rawLamports = BigInt(decimalToAtomic((val / solP).toFixed(9), 9));
  const out = (rawLamports * BigInt(Math.max(0, 10000 - ctx.config.slippageBps))) / 10000n;
  if (out <= 0n) throw new Error('Paper sell rounded to zero.');
  return { outAmount: out, grossUsdValue: val };
}

module.exports = {
  getWalletAddress,
  getWalletTokenBalance,
  fetchSwapOrder,
  fetchDynamicPriorityFee,
  executeSwapOrder,
  estimateSolUsdValue,
  estimateSolUsdPrice,
  buildPaperBuyQuote,
  buildPaperSellQuote,
};
