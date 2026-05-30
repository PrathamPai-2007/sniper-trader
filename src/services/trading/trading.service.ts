import { address, getProgramDerivedAddress, getAddressEncoder } from '@solana/addresses';
import {
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
  signTransaction,
  compileTransaction,
} from '@solana/transactions';
import { AccountRole } from '@solana/instructions';
import {
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
} from '@solana/transaction-messages';
import { createJupiterApiClient } from '@jup-ag/api';
import bs58 from 'bs58';
import {
  rpcCall,
  fetchJson,
  atomicToDecimalString,
  decimalToAtomic,
  PRIORITY,
  safeJsonStringify,
  sleep,
} from '../../core/utils.js';
import { SOL_MINT } from '../../core/config.js';
import { Context, SwapOrder, TokenMetadata } from '../../types/index.js';

const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZu5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyMvGrnC7APhSbxu3nm8Dq9H77Y2pEEat9Bshq7m',
  'DfXygSm4jCyv6LsdiCBsyzpMvMPnPvps9R9fW9GZun9X',
];

/**
 * Selects a random Jito tip account from a predefined list.
 * @returns The Solana address of a Jito tip account.
 */
function getRandomJitoTipAccount() {
  const addrStr = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]!;
  try {
    return address(addrStr);
  } catch (err) {
    throw new Error(
      `Failed to decode Jito tip address "${addrStr}": ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
}

const SOL_PRICE_CACHE_TTL_MS = 10_000;
let _solPriceCache = { price: 0, fetchedAt: 0 };

/**
 * Retrieves the configured wallet address from the application context.
 * @param ctx - The application context.
 * @returns The wallet address string.
 * @throws {Error} If the wallet address is not available in the context.
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

interface TokenAccountInfo {
  value: Array<{
    account: {
      data: {
        parsed: {
          info: {
            tokenAmount: {
              amount: string;
              decimals: number;
            };
          };
        };
      };
    };
  }>;
}

/**
 * Fetches the token balance for a given mint in the current wallet.
 * Supports both paper trading (via state) and live wallet checks (via RPC).
 *
 * @param ctx - The application context.
 * @param mint - The token mint address.
 * @param priority - RPC priority level for the balance check.
 * @returns A promise resolving to WalletBalance info.
 */
export async function getWalletTokenBalance(
  ctx: Context,
  mint: string,
  priority: PRIORITY = PRIORITY.MEDIUM
): Promise<WalletBalance> {
  if (ctx.config.paperTrading) {
    const pos = ctx.state.positions.get(mint);
    const raw = BigInt(pos?.initialTokenAmountRaw || '0');
    const dec = Number(pos?.decimals || 0);
    return {
      mint,
      rawAmount: raw,
      decimals: dec,
      uiAmount: Number(atomicToDecimalString(raw, dec, 9)),
    };
  }
  const res = (await rpcCall(
    ctx,
    'getTokenAccountsByOwner',
    [
      address(await getWalletAddress(ctx)),
      { mint: address(mint) },
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ],
    { priority }
  )) as unknown as TokenAccountInfo;

  let raw = 0n;
  let dec = 0;
  for (const acc of res.value || []) {
    const info = acc.account.data?.parsed?.info?.tokenAmount;
    if (info?.amount) {
      raw += BigInt(info.amount);
      dec = Number(info.decimals);
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
 * Adjusts fees based on market volatility (GMI) and panic state.
 *
 * @param ctx - The application context.
 * @param accountKeys - Optional list of accounts to check local priority fees for.
 * @param isPanic - Whether the system is in a panic state (e.g., emergency exit).
 * @returns A promise resolving to the priority fee in micro-lamports.
 */
export async function fetchDynamicPriorityFee(
  ctx: Context,
  accountKeys: string[] = [],
  isPanic = false
): Promise<number> {
  try {
    const useAccountLocal = ctx.config.priorityFeeAccountLocal && accountKeys.length > 0;
    const publicKeys = useAccountLocal ? accountKeys.map((key) => address(key)) : [];

    const fees = (await rpcCall(ctx, 'getRecentPrioritizationFees', [publicKeys], {
      priority: PRIORITY.HIGH,
    })) as unknown as Array<{ prioritizationFee: number }>;

    if (fees.length === 0) {
      return ctx.config.priorityFeeBaseMicroLamports;
    }

    const sortedFees = fees.map((f) => f.prioritizationFee).sort((a: number, b: number) => a - b);
    const index = Math.floor((ctx.config.priorityFeePercentile / 100) * (sortedFees.length - 1));
    const baseFee = sortedFees[index] || 0;

    let finalFee = Math.max(ctx.config.priorityFeeBaseMicroLamports, baseFee);

    // Apply Volatility Multiplier based on GMI and config
    let volatilityMultiplier = ctx.config.priorityFeeVolatilityMultiplier || 1.0;
    const gmi = typeof ctx.calculateGMI === 'function' ? ctx.calculateGMI() : 0.5;
    if (gmi > 0.8) {
      volatilityMultiplier *= 1.5;
    } else if (gmi > 0.6) {
      volatilityMultiplier *= 1.2;
    }

    finalFee = Math.round(finalFee * volatilityMultiplier);

    if (isPanic) {
      finalFee = Math.round(finalFee * ctx.config.priorityFeePanicMultiplier);
    }

    return Math.min(finalFee, ctx.config.priorityFeeMaxMicroLamports);
  } catch (error: unknown) {
    ctx.logger(
      `Failed to fetch priority fees: ${error instanceof Error ? error.message : String(error)}. Using base fee.`,
      'warn'
    );
    return ctx.config.priorityFeeBaseMicroLamports;
  }
}

/**
 * Fetches a swap order using the Jupiter SDK.
 * Handles priority fee calculation and quote/swap request lifecycle.
 *
 * @param ctx - The application context.
 * @param inputMint - The mint address of the input token.
 * @param outputMint - The mint address of the output token.
 * @param amountLamports - The amount of input token in atomic units.
 * @param isPanic - Whether the system is in a panic state.
 * @param slippageBps - Optional slippage override in basis points.
 * @returns A promise resolving to a SwapOrder.
 */
export async function fetchSdkSwapOrder(
  ctx: Context,
  inputMint: string,
  outputMint: string,
  amountLamports: bigint | string,
  isPanic = false,
  slippageBps: number | null = null
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
    const dynamicFeeMicroLamports = await fetchDynamicPriorityFee(
      ctx,
      [inputMint, outputMint],
      isPanic
    );
    // Estimate total lamports assuming ~250k CU for a typical swap
    const estimatedLamports = BigInt(Math.round((dynamicFeeMicroLamports * 250_000) / 1_000_000));

    const quote = await jupiterQuoteApi.quoteGet({
      inputMint,
      outputMint,
      amount: Number(amountLamports),
      slippageBps: slippageBps ?? ctx.config.slippageBps,
      onlyDirectRoutes: false,
      asLegacyTransaction: false,
    });

    if (!quote) throw new Error('No quote found for SDK swap.');

    const swapResult = await jupiterQuoteApi.swapPost({
      swapRequest: {
        quoteResponse: quote,
        userPublicKey: await getWalletAddress(ctx),
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: {
            priorityLevel: isPanic ? 'veryHigh' : 'high',
            maxLamports: Number(estimatedLamports > 5000n ? estimatedLamports : 5000n),
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
      requestId: (swapResult as unknown as Record<string, unknown>).requestId as string | undefined,
    };
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      (error as unknown as Record<string, unknown>).name === 'ResponseError' &&
      (error as unknown as Record<string, unknown>).response
    ) {
      const response = (error as unknown as Record<string, unknown>).response as {
        status: number;
        json: () => Promise<unknown>;
      };
      const status = response.status;
      let body = 'unable to parse body';
      try {
        body = safeJsonStringify(await response.json());
      } catch {}
      throw new Error(`Jupiter SDK error ${status}: ${body}`, { cause: error });
    }
    throw error;
  }
}

/**
 * Fetches a swap order from Jupiter (either via SDK or HTTP API).
 * Dispatches based on configuration.
 *
 * @param ctx - The application context.
 * @param inputMint - The input token mint.
 * @param outputMint - The output token mint.
 * @param amount - The amount in atomic units.
 * @param isPanic - Whether in panic mode.
 * @param slippageBps - Slippage override.
 * @returns A promise resolving to a SwapOrder.
 */
export async function fetchSwapOrder(
  ctx: Context,
  inputMint: string,
  outputMint: string,
  amount: bigint | string,
  isPanic = false,
  slippageBps: number | null = null
): Promise<SwapOrder> {
  if (ctx.config.useJupiterSdk) {
    ctx.logger(`Using Jupiter SDK path for ${outputMint}.`, 'debug');
    return await fetchSdkSwapOrder(ctx, inputMint, outputMint, amount, isPanic, slippageBps);
  }

  const dynamicFeeMicroLamports = await fetchDynamicPriorityFee(
    ctx,
    [inputMint, outputMint],
    isPanic
  );
  const estimatedLamports = BigInt(Math.round((dynamicFeeMicroLamports * 250_000) / 1_000_000));
  const finalFeeLamports = estimatedLamports > 5000n ? estimatedLamports : 5000n;

  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amount),
    taker: await getWalletAddress(ctx),
    slippageBps: String(slippageBps ?? ctx.config.slippageBps),
    autoWrapSol: 'true',
    prioritizationFeeLamports: String(finalFeeLamports),
  });

  const url = `${ctx.config.jupiterBaseUrl}/swap/v2/order?${params.toString()}`;
  try {
    const order = (await fetchJson(url, {
      headers: { 'x-api-key': ctx.config.jupiterApiKey },
    })) as Record<string, unknown>;

    if (!order || !order.transaction) {
      throw new Error(
        String(order?.errorMessage || order?.error || 'No transaction from Jupiter.')
      );
    }

    return order as unknown as SwapOrder;
  } catch (error: unknown) {
    throw new Error(
      `Jupiter V2 order failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

/**
 * Executes a swap order using the appropriate execution engine.
 * Dispatches to Jito, Jupiter Managed, or direct RPC submission.
 *
 * @param ctx - The application context.
 * @param order - The swap order to execute.
 * @returns A promise resolving to the transaction signature.
 */
export async function executeSwapOrder(
  ctx: Context,
  order: SwapOrder,
  isPanic = false
): Promise<string> {
  if (ctx.config.useJito && !ctx.config.paperTrading && !ctx.config.dryRun) {
    return executeSwapOrderViaJito(ctx, order, isPanic);
  }
  if (order.requestId) {
    return executeJupiterManagedOrder(ctx, order);
  }
  return executeSwapOrderViaRpc(ctx, order);
}

/**
 * High-level swap executor that handles fetching the order and retrying with higher slippage if simulation fails.
 *
 * @param ctx - The application context.
 * @param inputMint - The input token mint.
 * @param outputMint - The output token mint.
 * @param amount - The amount in atomic units.
 * @param isPanic - Whether in panic mode.
 * @param initialOrder - An optional pre-fetched order to start with.
 * @returns A promise resolving to the signature and the order used.
 */
export async function executeSwapOrderWithSmartRetry(
  ctx: Context,
  inputMint: string,
  outputMint: string,
  amount: bigint | string,
  isPanic = false,
  initialOrder: SwapOrder | null = null
): Promise<{ signature: string; order: SwapOrder }> {
  let currentSlippage = ctx.config.slippageBps;
  let attempts = 0;

  while (attempts <= ctx.config.maxAutoSlippageRetry) {
    const order =
      attempts === 0 && initialOrder
        ? initialOrder
        : await tradingService.fetchSwapOrder(
            ctx,
            inputMint,
            outputMint,
            amount,
            isPanic,
            currentSlippage
          );
    try {
      const signature = await tradingService.executeSwapOrder(ctx, order, isPanic);
      return { signature, order };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isSlippageError =
        msg.includes('SlippageExceeded') || msg.includes('6001') || msg.includes('0x1771');
      if (isSlippageError && attempts < ctx.config.maxAutoSlippageRetry) {
        attempts++;
        currentSlippage += ctx.config.autoSlippageIncrementBps;
        ctx.logger(
          `Slippage exceeded for ${outputMint}. Retrying with ${currentSlippage} bps (attempt ${attempts}).`,
          'warn'
        );
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    `Max slippage retries (${ctx.config.maxAutoSlippageRetry}) exceeded for ${outputMint}.`
  );
}

/**
 * Utility to convert a transaction to a base64 encoded wire format.
 * @param transaction - The transaction object.
 * @returns The base64 string.
 */
function getSignedTransactionBase64(transaction: unknown): string {
  return getBase64EncodedWireTransaction(
    transaction as Parameters<typeof getBase64EncodedWireTransaction>[0]
  ) as string;
}

/**
 * Signs a swap transaction using the wallet configured in the context.
 *
 * @param ctx - The application context.
 * @param order - The swap order containing the transaction.
 * @param allowPartialSignatures - Whether to allow partial signatures (for Jupiter execute API).
 * @returns A promise resolving to the base64 encoded signed transaction.
 */
async function signSwapTransaction(
  ctx: Context,
  order: SwapOrder,
  allowPartialSignatures = false
): Promise<string> {
  const transactionBytes = Buffer.from(order.transaction, 'base64');
  const transaction = getTransactionDecoder().decode(transactionBytes);
  const signer = allowPartialSignatures ? partiallySignTransaction : signTransaction;
  const keypairObj = ctx.wallet.keypair;
  if (!keypairObj) {
    throw new Error('Wallet keypair is not configured/available.');
  }

  let cryptoKeyPair: unknown;
  if (typeof keypairObj === 'object' && keypairObj !== null && 'keyPair' in keypairObj) {
    cryptoKeyPair = (keypairObj as { keyPair: unknown }).keyPair;
  } else {
    cryptoKeyPair = keypairObj;
  }

  const signedTransaction = await signer(
    [cryptoKeyPair as Parameters<typeof signer>[0][number]],
    transaction as Parameters<typeof signer>[1]
  );
  return getSignedTransactionBase64(signedTransaction);
}

/**
 * Executes a transaction through Jupiter's managed execution endpoint.
 *
 * @param ctx - The application context.
 * @param order - The swap order with a requestId.
 * @returns A promise resolving to the transaction signature.
 */
async function executeJupiterManagedOrder(ctx: Context, order: SwapOrder): Promise<string> {
  const signedTransaction = await signSwapTransaction(ctx, order, true);
  const body: Record<string, unknown> = {
    signedTransaction,
    requestId: order.requestId,
  };

  if (order.lastValidBlockHeight) {
    body.lastValidBlockHeight = order.lastValidBlockHeight;
  }

  const result = (await fetchJson(`${ctx.config.jupiterBaseUrl}/swap/v2/execute`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ctx.config.jupiterApiKey,
    },
    body,
  })) as Record<string, unknown>;

  if (!result || result.status !== 'Success' || !result.signature) {
    const details = result ? safeJsonStringify(result) : 'empty response';
    throw new Error(`Jupiter execute failed: ${details}`);
  }

  return result.signature as string;
}

/**
 * Executes a swap order by submitting directly to the Solana RPC.
 * Includes mandatory simulation and WebSocket-based confirmation.
 *
 * @param ctx - The application context.
 * @param order - The swap order to execute.
 * @returns A promise resolving to the transaction signature.
 */
async function executeSwapOrderViaRpc(ctx: Context, order: SwapOrder): Promise<string> {
  const wireTransactionBase64 = await signSwapTransaction(ctx, order, false);

  if (ctx.config.inlineSwapSimulation) {
    const simulation = (await rpcCall(
      ctx,
      'simulateTransaction',
      [
        wireTransactionBase64 as any,
        {
          encoding: 'base64',
          commitment: 'confirmed',
        },
      ],
      { priority: PRIORITY.HIGH }
    )) as unknown as { value: { err: unknown } };

    if (simulation.value.err) {
      const errStr = safeJsonStringify(simulation.value.err);
      if (
        errStr.includes('SlippageExceeded') ||
        errStr.includes('0x1771') ||
        errStr.includes('6001')
      ) {
        throw new Error('SlippageExceeded');
      }
      throw new Error(`Simulation failed: ${errStr}`);
    }
  }

  const sig = (await rpcCall(
    ctx,
    'sendTransaction',
    [
      wireTransactionBase64 as any,
      {
        encoding: 'base64',
        maxRetries: 3n,
        preflightCommitment: 'confirmed',
        skipPreflight: ctx.config.inlineSwapSimulation,
      },
    ],
    { priority: PRIORITY.HIGH }
  )) as string;

  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
    ctx.logger(`Transaction ${sig} not confirmed by WebSocket after 30s.`, 'warn');
  }, 30000);

  try {
    const notifications = await ctx.rpcSubscriptions
      .signatureNotifications(
        sig as unknown as Parameters<typeof ctx.rpcSubscriptions.signatureNotifications>[0],
        { commitment: 'confirmed' }
      )
      .subscribe({ abortSignal: abortController.signal });

    for await (const notification of notifications) {
      clearTimeout(timeout);
      abortController.abort();
      if (notification.value.err) {
        throw new Error(`Swap failed: ${safeJsonStringify(notification.value.err)}`);
      } else {
        ctx.logger(`Transaction ${sig} confirmed via WebSocket.`, 'debug');
        return sig;
      }
    }
    return sig;
  } catch (err: unknown) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === 'AbortError') {
      return sig;
    }
    throw err;
  }
}

/**
 * Executes a swap order as part of a Jito bundle.
 * Includes a tip transaction to a random Jito validator.
 *
 * @param ctx - The application context.
 * @param order - The swap order to execute.
 * @returns A promise resolving to the transaction signature.
 */
/**
 * Fetches the current Jito tip floor from the Block Engine.
 * Converts the configured percentile to lamports and applies a panic multiplier if needed.
 */
export async function getDynamicJitoTip(ctx: Context, isPanic = false): Promise<bigint> {
  const defaultTip = ctx.config.jitoTipLamports || 1_000_000n;
  if (!ctx.config.jitoTipFloorApiUrl && !ctx.config.jitoBlockEngineUrl) {
    return defaultTip;
  }

  const url = ctx.config.jitoTipFloorApiUrl || `${ctx.config.jitoBlockEngineUrl}/api/v1/bundles`;

  try {
    const response = (await fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'getTipFloor',
        params: [],
      },
      timeoutMs: 4000,
      retries: 1,
    })) as {
      result?: Array<{
        landed_tips_25th_percentile?: number;
        landed_tips_50th_percentile?: number;
        landed_tips_75th_percentile?: number;
        landed_tips_95th_percentile?: number;
        landed_tips_99th_percentile?: number;
      }>;
    };

    const stats = response?.result?.[0];
    if (!stats) {
      return defaultTip;
    }

    const percentile = ctx.config.jitoTipPercentile || 75;
    let solPrice = stats.landed_tips_75th_percentile || 0.001; // fallback default
    if (percentile === 25) solPrice = stats.landed_tips_25th_percentile || solPrice;
    else if (percentile === 50) solPrice = stats.landed_tips_50th_percentile || solPrice;
    else if (percentile === 75) solPrice = stats.landed_tips_75th_percentile || solPrice;
    else if (percentile === 95) solPrice = stats.landed_tips_95th_percentile || solPrice;
    else if (percentile === 99) solPrice = stats.landed_tips_99th_percentile || solPrice;

    let tipLamports = BigInt(Math.round(solPrice * 1e9));

    if (isPanic) {
      const multiplier = BigInt(Math.max(1, ctx.config.priorityFeePanicMultiplier || 2));
      tipLamports *= multiplier;
    }

    // Ensure it doesn't exceed a sanity limit (e.g. 0.2 SOL) or fall below a minimum (e.g. 0.0001 SOL)
    const minTip = 100_000n; // 0.0001 SOL
    const maxTip = 200_000_000n; // 0.2 SOL
    if (tipLamports < minTip) tipLamports = minTip;
    if (tipLamports > maxTip) tipLamports = maxTip;

    return tipLamports;
  } catch (err: unknown) {
    ctx.logger(
      `Failed to fetch dynamic Jito tip floor: ${err instanceof Error ? err.message : String(err)}. Using default tip.`,
      'warn'
    );
    return defaultTip;
  }
}

/**
 * Polls Jito's getBundleStatuses JSON-RPC method until the bundle is confirmed, finalized, or expires.
 */
export async function confirmJitoBundle(
  ctx: Context,
  bundleId: string,
  timeoutMs = 30000
): Promise<boolean> {
  const url = ctx.config.jitoTipFloorApiUrl || `${ctx.config.jitoBlockEngineUrl}/api/v1/bundles`;
  const startTime = Date.now();
  const pollInterval = 1500;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = (await fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'getBundleStatuses',
          params: [[bundleId]],
        },
        timeoutMs: 3000,
        retries: 0,
      })) as {
        result?: {
          value?: Array<{
            bundle_id: string;
            confirmationStatus?: string;
            err?: unknown;
          }>;
        };
      };

      const bundleInfo = response?.result?.value?.[0];
      if (bundleInfo && bundleInfo.bundle_id === bundleId) {
        if (bundleInfo.err) {
          throw new Error(`Jito bundle failed execution: ${safeJsonStringify(bundleInfo.err)}`);
        }
        const status = bundleInfo.confirmationStatus;
        if (status === 'confirmed' || status === 'finalized' || status === 'processed') {
          ctx.logger(`Jito bundle ${bundleId} confirmed (${status}).`, 'debug');
          return true;
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('Jito bundle failed execution')) {
        throw err;
      }
    }
    await sleep(pollInterval);
  }
  return false;
}

/**
 * Executes a swap order as part of a Jito bundle.
 * Includes dynamic tip estimation, bundle status polling, and retry loops.
 *
 * @param ctx - The application context.
 * @param order - The swap order to execute.
 * @param isPanic - Whether in panic mode.
 * @returns A promise resolving to the transaction signature.
 */
async function executeSwapOrderViaJito(
  ctx: Context,
  order: SwapOrder,
  isPanic = false
): Promise<string> {
  const walletAddress = await getWalletAddress(ctx);

  const keypairObj = ctx.wallet.keypair;
  if (!keypairObj) throw new Error('Wallet keypair is missing.');
  let cryptoKeyPair: unknown;
  if (typeof keypairObj === 'object' && keypairObj !== null && 'keyPair' in keypairObj) {
    cryptoKeyPair = (keypairObj as { keyPair: unknown }).keyPair;
  } else {
    cryptoKeyPair = keypairObj;
  }
  const signer = cryptoKeyPair as Parameters<typeof signTransaction>[0][number];

  const maxAttempts = ctx.config.jitoBundleRetryAttempts || 3;
  const timeoutMs = ctx.config.jitoConfirmTimeoutMs || 30000;
  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts++;

    const blockhashRes = (await rpcCall(ctx, 'getLatestBlockhash', [{ commitment: 'confirmed' }], {
      priority: PRIORITY.HIGH,
    })) as unknown as { value: { blockhash: string; lastValidBlockHeight: bigint } };
    const blockhash = blockhashRes.value.blockhash;
    const lastValidBlockHeight = BigInt(blockhashRes.value.lastValidBlockHeight);

    const tipAmount = await getDynamicJitoTip(ctx, isPanic);
    const tipAccount = getRandomJitoTipAccount();

    ctx.logger(
      `[Jito] Preparing bundle attempt ${attempts}/${maxAttempts}. Tip: ${atomicToDecimalString(tipAmount, 9, 6)} SOL to ${tipAccount}`,
      'debug'
    );

    const signedJupiterTxBase64 = await signSwapTransaction(ctx, order, false);

    const data = new Uint8Array(12);
    const view = new DataView(data.buffer);
    view.setUint32(0, 2, true); // Transfer
    view.setBigUint64(4, tipAmount, true);

    const tipInstruction = {
      programAddress: address('11111111111111111111111111111111'),
      accounts: [
        { address: address(walletAddress), role: AccountRole.WRITABLE_SIGNER },
        { address: tipAccount, role: AccountRole.WRITABLE },
      ],
      data,
    };

    let tipMessage = createTransactionMessage({ version: 0 });
    tipMessage = setTransactionMessageFeePayer(address(walletAddress), tipMessage);
    tipMessage = setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: blockhash as unknown as Parameters<
          typeof setTransactionMessageLifetimeUsingBlockhash
        >[0]['blockhash'],
        lastValidBlockHeight,
      },
      tipMessage
    );
    tipMessage = appendTransactionMessageInstruction(tipInstruction, tipMessage as any) as any;

    const compiledTipTransaction = compileTransaction(tipMessage as any);
    const signedTipTransaction = await signTransaction([signer], compiledTipTransaction);
    const signedTipTxBase64 = getBase64EncodedWireTransaction(signedTipTransaction);

    if (ctx.config.inlineSwapSimulation && attempts === 1) {
      const simulation = (await rpcCall(
        ctx,
        'simulateTransaction',
        [
          signedJupiterTxBase64 as any,
          {
            encoding: 'base64',
            commitment: 'confirmed',
          },
        ],
        { priority: PRIORITY.HIGH }
      )) as unknown as { value: { err: unknown } };

      if (simulation.value.err) {
        const errStr = safeJsonStringify(simulation.value.err);
        if (
          errStr.includes('SlippageExceeded') ||
          errStr.includes('0x1771') ||
          errStr.includes('6001')
        ) {
          throw new Error('SlippageExceeded');
        }
        throw new Error(`Simulation failed: ${errStr}`);
      }
    }

    const jitoUrl =
      ctx.config.jitoTipFloorApiUrl || `${ctx.config.jitoBlockEngineUrl}/api/v1/bundles`;
    const response = (await fetchJson(jitoUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'sendBundle',
        params: [[signedJupiterTxBase64, signedTipTxBase64]],
      },
    })) as Record<string, unknown>;

    if (response.error) {
      ctx.logger(
        `Jito sendBundle attempt ${attempts} failed: ${safeJsonStringify(response.error)}`,
        'warn'
      );
      continue;
    }

    const bundleId = response.result as string;
    ctx.logger(
      `Jito bundle submitted. Bundle ID: ${bundleId}. Waiting for confirmation...`,
      'info'
    );

    try {
      const confirmed = await confirmJitoBundle(ctx, bundleId, timeoutMs);
      if (confirmed) {
        const decodedJupiter = getTransactionDecoder().decode(
          Buffer.from(signedJupiterTxBase64, 'base64')
        );
        const signature = (decodedJupiter as unknown as { signatures: Uint8Array[] }).signatures[0];
        if (!signature) throw new Error('No signature found in Jupiter transaction.');
        return bs58.encode(signature);
      }
      ctx.logger(`Jito bundle ${bundleId} timed out without landing.`, 'warn');
    } catch (err: unknown) {
      ctx.logger(
        `Jito bundle ${bundleId} execution failed: ${err instanceof Error ? err.message : String(err)}.`,
        'warn'
      );
    }
  }

  throw new Error(`Jito bundle failed to land after ${maxAttempts} attempts.`);
}

/**
 * Estimates the current SOL price in USD using Jupiter's price API.
 * Uses a short-term cache to minimize API calls.
 *
 * @param ctx - The application context.
 * @param apiKey - Optional API key override.
 * @returns A promise resolving to the SOL price in USD.
 */
export async function estimateSolUsdPrice(
  ctx: Context,
  apiKey: string | null = null
): Promise<number> {
  const walletAny = ctx as unknown as Record<string, unknown>;
  if (typeof walletAny.getSolUsdPrice === 'function') {
    const overriddenPrice = Number(await (walletAny.getSolUsdPrice as () => Promise<number>)());
    if (overriddenPrice > 0) return overriddenPrice;
  }

  const now = Date.now();
  if (_solPriceCache.price > 0 && now - _solPriceCache.fetchedAt < SOL_PRICE_CACHE_TTL_MS) {
    return _solPriceCache.price;
  }

  const url = `${ctx.config.jupiterBaseUrl}/price/v3?ids=${SOL_MINT}`;
  let response: Record<string, unknown>;
  try {
    response = (await fetchJson(url, {
      headers: { 'x-api-key': apiKey || ctx.config.jupiterApiKey },
    })) as Record<string, unknown>;
  } catch (error: unknown) {
    if (_solPriceCache.price > 0) {
      ctx.logger(
        `Failed to fetch SOL price, using cached value: ${error instanceof Error ? error.message : String(error)}`,
        'warn'
      );
      return _solPriceCache.price;
    }
    throw error;
  }

  const priceMap = (response?.data ?? response) as Record<
    string,
    { usdPrice?: string | number; price?: string | number }
  >;
  if (!priceMap?.[SOL_MINT]) {
    ctx.logger(`Jupiter price response missing SOL: ${safeJsonStringify(response)}`, 'error');
    throw new Error('No SOL price available.');
  }

  const record = priceMap[SOL_MINT];
  const p = Number(record.usdPrice || record.price || 0);

  if (!(p > 0)) {
    ctx.logger(`Jupiter SOL price is zero or invalid: ${safeJsonStringify(record)}`, 'error');
    throw new Error('No SOL price available.');
  }

  _solPriceCache = { price: p, fetchedAt: now };
  return p;
}

/**
 * Estimates the USD value of a given amount of lamports.
 *
 * @param ctx - The application context.
 * @param amountLamports - The amount in lamports.
 * @param apiKey - Optional API key override.
 * @returns A promise resolving to the USD value.
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
 * Builds a simulated buy quote for paper trading based on current market price.
 *
 * @param ctx - The application context.
 * @param token - The token metadata.
 * @param decimals - Token decimals.
 * @param buyLamports - The amount of SOL to spend.
 * @returns A promise resolving to paper trade quote details.
 */
export async function buildPaperBuyQuote(
  ctx: Context,
  token: TokenMetadata,
  decimals: number,
  buyLamports: bigint | string
): Promise<{
  outAmount: bigint;
  entryUsdValue: number;
  entryPriceUsd: number;
  solPrice: number;
}> {
  const p = Number(token.usdPrice || 0);
  if (!(p > 0)) throw new Error(`No price for paper buy ${token.symbol}.`);
  const solPrice = await estimateSolUsdPrice(ctx);
  const val = await estimateSolUsdValue(ctx, buyLamports);
  const units = val / p;
  const raw = BigInt(decimalToAtomic(units.toFixed(Math.min(decimals, 9)), decimals));
  const out = (raw * BigInt(Math.max(0, 10000 - ctx.config.slippageBps))) / 10000n;
  if (out <= 0n) throw new Error('Paper buy rounded to zero.');
  return { outAmount: out, entryUsdValue: val, entryPriceUsd: p, solPrice };
}

/**
 * Builds a simulated sell quote for paper trading based on current market price.
 *
 * @param ctx - The application context.
 * @param rawAmount - The amount of tokens to sell.
 * @param pUsd - The current USD price of the token.
 * @param dec - Token decimals.
 * @param apiKey - Optional API key override.
 * @returns A promise resolving to paper trade quote details.
 */
export async function buildPaperSellQuote(
  ctx: Context,
  rawAmount: bigint | string,
  pUsd: number,
  dec: number,
  apiKey: string | null = null
): Promise<{ outAmount: bigint; grossUsdValue: number; solPrice: number }> {
  if (!(pUsd > 0)) throw new Error('No price for paper sell.');
  const solPrice = await estimateSolUsdPrice(ctx, apiKey);
  const val = Number(atomicToDecimalString(rawAmount, dec, 9)) * pUsd;
  const rawLamports = BigInt(decimalToAtomic((val / solPrice).toFixed(9), 9));
  const out = (rawLamports * BigInt(Math.max(0, 10000 - ctx.config.slippageBps))) / 10000n;
  if (out <= 0n) throw new Error('Paper sell rounded to zero.');
  return { outAmount: out, grossUsdValue: val, solPrice };
}

/**
 * Fetches the current SOL balance of the wallet.
 *
 * @param ctx - The application context.
 * @param priority - RPC priority level.
 * @returns A promise resolving to the balance in lamports.
 */
export async function getSolBalance(
  ctx: Context,
  priority: PRIORITY = PRIORITY.HIGH
): Promise<bigint> {
  const walletAddr = await getWalletAddress(ctx);
  const res = (await rpcCall(
    ctx,
    'getBalance',
    [address(walletAddr), { commitment: 'confirmed' }],
    { priority }
  )) as unknown as { value: bigint };
  return BigInt(res.value);
}

/**
 * Closes an Associated Token Account (ATA) to reclaim rent-exempt SOL.
 * This is performed after a position is fully closed.
 *
 * @param ctx - The application context.
 * @param mint - The token mint address.
 * @param priority - RPC priority level.
 * @returns A promise resolving to the signature or null if failed.
 */
export async function closeAssociatedTokenAccount(
  ctx: Context,
  mint: string,
  priority: PRIORITY = PRIORITY.HIGH
): Promise<string | null> {
  try {
    const walletAddr = await getWalletAddress(ctx);
    let ownerAddress, mintAddress;
    try {
      ownerAddress = address(walletAddr);
      mintAddress = address(mint);
    } catch {
      ctx.logger(`Invalid address provided to close ATA: ${walletAddr} or ${mint}`, 'debug');
      return null;
    }
    const tokenProgramId = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const ataProgramId = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

    // 1. Derive the Associated Token Account (ATA) address
    const [ataAddress] = await getProgramDerivedAddress({
      programAddress: ataProgramId,
      seeds: [
        getAddressEncoder().encode(ownerAddress),
        getAddressEncoder().encode(tokenProgramId),
        getAddressEncoder().encode(mintAddress),
      ],
    });

    // 2. Fetch recent blockhash
    const blockhashRes = (await rpcCall(ctx, 'getLatestBlockhash', [{ commitment: 'confirmed' }], {
      priority,
    })) as unknown as { value: { blockhash: string; lastValidBlockHeight: bigint } };
    const blockhash = blockhashRes.value.blockhash;
    const lastValidBlockHeight = BigInt(blockhashRes.value.lastValidBlockHeight);

    // 3. Build CloseAccount instruction
    const closeInstruction = {
      programAddress: tokenProgramId,
      accounts: [
        { address: ataAddress, role: AccountRole.WRITABLE },
        { address: ownerAddress, role: AccountRole.WRITABLE },
        { address: ownerAddress, role: AccountRole.WRITABLE_SIGNER },
      ],
      data: new Uint8Array([9]), // CloseAccount discriminator is 9
    };

    // 4. Build transaction message
    let message = createTransactionMessage({ version: 0 });
    message = setTransactionMessageFeePayer(ownerAddress, message);
    message = setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: blockhash as unknown as Parameters<
          typeof setTransactionMessageLifetimeUsingBlockhash
        >[0]['blockhash'],
        lastValidBlockHeight,
      },
      message
    );
    message = appendTransactionMessageInstruction(closeInstruction, message as any) as any;

    // 5. Compile and sign transaction
    const compiledTransaction = compileTransaction(message as any);
    const keypairObj = ctx.wallet.keypair;
    if (!keypairObj) {
      throw new Error('Wallet keypair is not configured/available.');
    }

    let cryptoKeyPair: unknown;
    if (typeof keypairObj === 'object' && keypairObj !== null && 'keyPair' in keypairObj) {
      cryptoKeyPair = (keypairObj as { keyPair: unknown }).keyPair;
    } else {
      cryptoKeyPair = keypairObj;
    }

    const signedTransaction = await signTransaction(
      [cryptoKeyPair as Parameters<typeof signTransaction>[0][number]],
      compiledTransaction as Parameters<typeof signTransaction>[1]
    );

    const wireTransactionBase64 = getBase64EncodedWireTransaction(signedTransaction);

    // 6. Submit transaction
    const sig = (await rpcCall(
      ctx,
      'sendTransaction',
      [
        wireTransactionBase64 as any,
        {
          encoding: 'base64',
          maxRetries: 3n,
          preflightCommitment: 'confirmed',
          skipPreflight: false,
        },
      ],
      { priority }
    )) as string;

    ctx.logger(`Reclaimed ATA rent for ${mint}. Closed ATA ${ataAddress} in tx ${sig}.`, 'info');
    return sig;
  } catch (err: unknown) {
    ctx.logger(
      `Failed to close ATA for ${mint}: ${err instanceof Error ? err.message : String(err)}`,
      'error'
    );
    return null;
  }
}

/**
 * Service object to allow for easier mocking in ESM environments.
 */
export const tradingService = {
  getWalletAddress,
  getWalletTokenBalance,
  fetchDynamicPriorityFee,
  fetchSwapOrder,
  executeSwapOrder,
  executeSwapOrderWithSmartRetry,
  estimateSolUsdPrice,
  estimateSolUsdValue,
  buildPaperBuyQuote,
  buildPaperSellQuote,
  getSolBalance,
  closeAssociatedTokenAccount,
  getDynamicJitoTip,
  confirmJitoBundle,
};
