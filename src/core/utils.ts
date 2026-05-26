import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import { address } from '@solana/addresses';
import bs58 from 'bs58';
import { Context } from '../types/index.js';

// Declare require for compiler compatibility in CommonJS compilation target
declare const require: any;

/**
 * Ensures that the parent directory for a given file path exists.
 * @param filePath - The path to the file.
 */
export function ensureParentDirectory(filePath: string): void {
  const directory = path.dirname(path.resolve(filePath));
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

/**
 * Writes content to a file atomically by writing to a temporary file and then renaming it.
 * This prevents data corruption on Windows due to file locking.
 * @param filePath - The destination file path.
 * @param content - The content to write.
 * @throws {Error} If the write fails after maximum retries.
 */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  if (!filePath) return;
  const resolvedPath = path.resolve(filePath);
  ensureParentDirectory(resolvedPath);
  const tempPath = `${resolvedPath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;

  const maxRetries = 5;
  let lastError: any;

  for (let i = 0; i < maxRetries; i++) {
    try {
      await fsPromises.writeFile(tempPath, content, 'utf8');
      await fsPromises.rename(tempPath, resolvedPath);
      return; // Success
    } catch (err: any) {
      lastError = err;
      if ((err.code === 'EPERM' || err.code === 'EBUSY') && i < maxRetries - 1) {
        await sleep(50 * (i + 1));
        continue;
      }
      break;
    }
  }

  console.error(
    `[SYSTEM ERROR] Atomic write failed for ${filePath} after retries: ${lastError?.message}`
  );
  try {
    if (fs.existsSync(tempPath)) await fsPromises.unlink(tempPath);
  } catch {}
  throw lastError;
}

/**
 * Asynchronously appends a line of text to a file.
 * @param filePath - The path to the file.
 * @param line - The line of text to append.
 */
export function appendFileLine(filePath: string, line: string): void {
  if (!filePath) {
    return;
  }
  ensureParentDirectory(filePath);
  fs.appendFile(path.resolve(filePath), `${line}\n`, (err) => {
    if (err) {
      console.error(`[SYSTEM ERROR] Failed to write to ${filePath}: ${err.message}`);
    }
  });
}

/**
 * Synchronously appends a line of text to a file.
 * @param filePath - The path to the file.
 * @param line - The line of text to append.
 */
export function appendFileLineSync(filePath: string, line: string): void {
  if (!filePath) {
    return;
  }
  ensureParentDirectory(filePath);
  fs.appendFileSync(path.resolve(filePath), `${line}\n`);
}

/**
 * Serializes data to JSON while converting BigInt values to strings.
 * @param value - The value to serialize.
 * @param space - Optional pretty-print spacing.
 * @returns JSON string output safe for persistence/logging.
 */
export function safeJsonStringify(value: any, space?: number | string): string {
  return JSON.stringify(
    value,
    (_key, currentValue) =>
      typeof currentValue === 'bigint' ? currentValue.toString() : currentValue,
    space
  );
}

/**
 * Logs a message to a file and/or the console.
 * @param logFilePath - Path to the log file.
 * @param message - The message to log.
 * @param level - The log level (info, warn, error, trade, debug).
 * @param options - Logging options.
 */
export function log(
  logFilePath: string,
  message: string,
  level: string = 'info',
  options: { sync?: boolean; console?: boolean } = {}
): void {
  const prefix =
    (
      {
        info: '[INFO]',
        warn: '[WARN]',
        error: '[ERROR]',
        trade: '[TRADE]',
        debug: '[DEBUG]',
      } as Record<string, string>
    )[level] || '[INFO]';
  const line = `${new Date().toISOString()} ${prefix} ${message}`;

  if (logFilePath) {
    if (options.sync) {
      appendFileLineSync(logFilePath, line);
    } else {
      appendFileLine(logFilePath, line);
    }
  }

  const shouldPrint =
    options.console !== undefined
      ? options.console
      : level === 'error' || level === 'trade' || level === 'info';

  if (shouldPrint) {
    console.log(line);
  }
}

/**
 * Formats a numeric value as a USD currency string.
 * @param value - The value to format.
 * @returns The formatted USD string.
 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0.00';
  if (value < 0.01 && value > 0) return `$${value.toFixed(6)}`;
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Converts an atomic bigint amount to a decimal string with specified precision.
 * @param amount - The atomic amount.
 * @param decimals - The number of decimals for the token.
 * @param precision - The number of decimal places to include in the output.
 * @returns The formatted decimal string.
 */
export function atomicToDecimalString(
  amount: bigint | number | string,
  decimals: number,
  precision: number = Math.min(decimals, 6)
): string {
  const raw = BigInt(amount);
  const negative = raw < 0n;
  const unsigned = negative ? raw * -1n : raw;
  const base = 10n ** BigInt(decimals);
  const whole = unsigned / base;
  const fraction = unsigned % base;
  const fractionString = fraction
    .toString()
    .padStart(decimals, '0')
    .slice(0, precision)
    .replace(/0+$/, '');
  const text = fractionString ? `${whole}.${fractionString}` : whole.toString();
  return negative ? `-${text}` : text;
}

/**
 * Converts a decimal value string to an atomic string representation.
 * @param value - The decimal value.
 * @param decimals - The number of decimals for the token.
 * @returns The atomic string representation.
 * @throws {Error} If the value is not a valid decimal.
 */
export function decimalToAtomic(value: string | number, decimals: number): string {
  const normalized = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(`Invalid decimal value: ${value}`);
  }

  const [wholePart, fractionPart = ''] = normalized.split('.');
  if (!wholePart) return '0';
  const paddedFraction = `${fractionPart}${'0'.repeat(decimals)}`.slice(0, decimals);
  return `${wholePart}${paddedFraction}`.replace(/^0+(?=\d)/, '') || '0';
}

/**
 * Formats a ratio as a percentage string.
 * @param value - The ratio (e.g., 0.123).
 * @returns The formatted percentage string (e.g., "12.30%").
 */
export function ratioToPercentString(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

/**
 * Safely calculates the ratio of two BigInts as a number.
 * @param numerator - The numerator.
 * @param denominator - The denominator.
 * @param scale - The internal scale used for precision.
 * @returns The resulting ratio.
 */
export function bigintRatioToNumber(
  numerator: bigint,
  denominator: bigint,
  scale: bigint = 1_000_000n
): number {
  if (denominator <= 0n) {
    return 0;
  }
  return Number((numerator * scale) / denominator) / Number(scale);
}

/**
 * Clamps a value between a minimum and maximum.
 * @param value - The value to clamp.
 * @param minimum - The lower bound.
 * @param maximum - The upper bound.
 * @returns The clamped value.
 */
export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Normalizes a launchpad name to a trimmed lowercase string.
 * @param value - The launchpad name.
 * @returns The normalized launchpad name.
 */
export function normalizeLaunchpad(value: string): string {
  return String(value || 'unknown')
    .trim()
    .toLowerCase();
}

/**
 * Derives a WebSocket RPC URL from an HTTP/HTTPS RPC URL.
 * @param rpcUrl - The HTTP(S) RPC URL.
 * @returns The derived WS(S) URL.
 */
export function deriveWsRpcUrl(rpcUrl: string): string {
  try {
    const parsedUrl = new URL(rpcUrl);
    if (parsedUrl.protocol === 'https:') {
      parsedUrl.protocol = 'wss:';
      return parsedUrl.toString();
    }
    if (parsedUrl.protocol === 'http:') {
      parsedUrl.protocol = 'ws:';
      return parsedUrl.toString();
    }
    return rpcUrl;
  } catch {
    return rpcUrl;
  }
}

/**
 * Determines if an error is a transient operation error that can be retried.
 * @param error - The error to check.
 * @returns True if the error is transient.
 */
export function isTransientOperationError(error: any): boolean {
  const msg = String(error?.message || error || '').toLowerCase();
  return (
    msg.includes('rate limit') ||
    msg.includes('429') ||
    msg.includes('503') ||
    msg.includes('504') ||
    msg.includes('timeout') ||
    msg.includes('too many requests')
  );
}

/**
 * Sleeps for a given number of milliseconds.
 * Bypassable during tests.
 * @param ms - The sleep duration.
 */
export async function sleep(ms: number): Promise<void> {
  if ((global as any).__TEST__ || process.env.NODE_ENV === 'test') {
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

const RPC_MAX_REQUESTS_PER_SEC = 10;
const RPC_MAX_SEND_TX_PER_SEC = 1;

/**
 * Priority levels for the rate limiter.
 */
export enum PRIORITY {
  ULTRA_HIGH = 0,
  HIGH = 1,
  MEDIUM = 2,
  LOW = 3,
}

class ShortTermCache {
  private store = new Map<string, { value: any; expiresAt: number }>();

  set(key: string, value: any, ttlMs: number = 5000): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  get(key: string): any | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  clear(): void {
    this.store.clear();
  }
}

const rpcCache = new ShortTermCache();

/**
 * Creates a priority-aware token bucket rate limiter.
 * @param ratePerSec - The number of tokens per second.
 * @returns An async function (priority) => Promise<void>.
 */
function makePriorityTokenBucket(ratePerSec: number): (priority?: PRIORITY) => Promise<void> {
  const intervalMs = 1000 / ratePerSec;
  let tokens = ratePerSec;
  let lastRefillAt = Date.now();

  const queues: Record<PRIORITY, (() => void)[]> = {
    [PRIORITY.ULTRA_HIGH]: [],
    [PRIORITY.HIGH]: [],
    [PRIORITY.MEDIUM]: [],
    [PRIORITY.LOW]: [],
  };

  const refill = (): void => {
    const now = Date.now();
    const elapsed = now - lastRefillAt;
    const refilled = Math.floor(elapsed / intervalMs);
    if (refilled > 0) {
      tokens = Math.min(ratePerSec, tokens + refilled);
      lastRefillAt += refilled * intervalMs;
    }
  };

  const processQueues = (): void => {
    refill();
    while (tokens >= 1) {
      const p = [PRIORITY.ULTRA_HIGH, PRIORITY.HIGH, PRIORITY.MEDIUM, PRIORITY.LOW].find(
        (pri) => queues[pri].length > 0
      );
      if (p === undefined) break;

      tokens -= 1;
      const resolve = queues[p].shift();
      if (resolve) resolve();
    }

    const hasWaiters = Object.values(queues).some((q) => q.length > 0);
    if (hasWaiters) {
      const msUntilNext = Math.max(1, intervalMs - (Date.now() - lastRefillAt));
      setTimeout(processQueues, msUntilNext);
    }
  };

  return function acquireToken(priority: PRIORITY = PRIORITY.MEDIUM): Promise<void> {
    return new Promise<void>((resolve) => {
      queues[priority].push(resolve);
      processQueues();
    });
  };
}

const acquireRpcToken = makePriorityTokenBucket(RPC_MAX_REQUESTS_PER_SEC);
const acquireSendTxToken = makePriorityTokenBucket(RPC_MAX_SEND_TX_PER_SEC);

const keepAliveAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 25,
  maxFreeSockets: 10,
});
let fetchTransportOptionName = 'agent';
let fetchTransportOptionValue: any = keepAliveAgent;
try {
  const { Agent } = require('undici');
  fetchTransportOptionName = 'dispatcher';
  fetchTransportOptionValue = new Agent({
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 30_000,
    connections: 25,
  });
} catch {}

const rpcHealth = new Map<number, { errorCount: number; lastErrorAt: number }>();
let _rpcIndex = 0;

/**
 * Executes an RPC call through the context's RPC client pool with rate limiting and retries.
 * @param ctx - The application context.
 * @param method - The RPC method name.
 * @param params - Arguments for the RPC method.
 * @param options - Call options.
 * @returns The result of the RPC call.
 */
export async function rpcCall(
  ctx: Context,
  method: string,
  params: any[] = [],
  options: { priority?: PRIORITY; maxAttempts?: number; cacheTtlMs?: number } = {}
): Promise<any> {
  const priority = options.priority ?? PRIORITY.MEDIUM;
  const maxAttempts = options.maxAttempts ?? 3;
  const cacheTtlMs = options.cacheTtlMs ?? 0;
  let lastError: any = null;

  const cacheKey = cacheTtlMs > 0 ? `${method}:${JSON.stringify(params)}` : null;
  if (cacheKey) {
    const cached = rpcCache.get(cacheKey);
    if (cached !== null) return cached;
  }

  const rpcPool = Array.isArray(ctx.rpcs) && ctx.rpcs.length > 0 ? ctx.rpcs : [ctx.rpc];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const now = Date.now();

    let candidates = rpcPool
      .map((rpc, index) => ({ rpc, index }))
      .filter(({ index }) => {
        const health = rpcHealth.get(index) || { errorCount: 0, lastErrorAt: 0 };
        return health.errorCount < 3 || now - health.lastErrorAt > 60000;
      });

    if (candidates.length === 0) {
      candidates = rpcPool.map((rpc, index) => ({ rpc, index }));
    }

    const selected = candidates[_rpcIndex % candidates.length];
    if (!selected) {
      throw new Error('No RPC candidate selected.');
    }
    const { rpc, index } = selected;
    _rpcIndex++;

    try {
      if (method === 'sendTransaction') {
        await acquireSendTxToken(PRIORITY.ULTRA_HIGH);
      }
      await acquireRpcToken(priority);

      const result = await rpc[method](...params).send();

      rpcHealth.set(index, { errorCount: 0, lastErrorAt: 0 });

      if (cacheKey) rpcCache.set(cacheKey, result, cacheTtlMs);
      return result;
    } catch (e: any) {
      lastError = e;

      const health = rpcHealth.get(index) || { errorCount: 0, lastErrorAt: 0 };
      health.errorCount++;
      health.lastErrorAt = now;
      rpcHealth.set(index, health);

      if (isTransientOperationError(e) && attempt < maxAttempts - 1) {
        if (candidates.length > 1) continue;

        await sleep(500 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}

/**
 * Fetches JSON data from a URL with timeout and retries.
 * @param url - The URL to fetch.
 * @param options - Fetch options.
 * @returns The parsed JSON data.
 */
export async function fetchJson(
  url: string,
  options: {
    timeoutMs?: number;
    retries?: number;
    retryDelayMs?: number;
    method?: string;
    headers?: Record<string, string>;
    body?: any;
  } = {}
): Promise<any> {
  const timeoutMs = options.timeoutMs || 15000;
  const retries = options.retries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 750;
  const headers = { Accept: 'application/json', ...(options.headers || {}) };

  let lastError: any = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
        [fetchTransportOptionName as any]: fetchTransportOptionValue,
      } as any);
      const text = await response.text();
      let data: any = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (e: any) {
          throw new Error(`Failed to parse JSON from ${url}: ${e.message}`);
        }
      }
      if (!response.ok) {
        const details = data ? JSON.stringify(data) : text;
        throw new Error(`HTTP ${response.status} for ${url}: ${details}`);
      }
      return data;
    } catch (error: any) {
      lastError = error;
      if (attempt >= retries || !isTransientFetchError(error)) {
        throw new Error(formatFetchError(url, error, timeoutMs));
      }
      await sleep(retryDelayMs * (attempt + 1));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(
    formatFetchError(url, lastError || new Error('Unknown fetch failure'), timeoutMs)
  );
}

function isAbortError(error: any): boolean {
  return error?.name === 'AbortError' || /aborted/i.test(String(error?.message || ''));
}

function isTransientFetchError(error: any): boolean {
  const message = String(error?.message || '');
  return (
    isAbortError(error) ||
    /fetch failed/i.test(message) ||
    /ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|socket hang up/i.test(message) ||
    /HTTP 408|HTTP 425|HTTP 429|HTTP 500|HTTP 502|HTTP 503|HTTP 504/i.test(message)
  );
}

function formatFetchError(url: string, error: any, timeoutMs: number): string {
  if (isAbortError(error)) return `Request timed out after ${timeoutMs}ms for ${url}`;
  if (String(error?.message || '').includes(url)) return error.message;
  return `Request failed for ${url}: ${error.message}`;
}

export function normalizeConcurrency(value: any, fallback: number = 1): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 1) return fallback;
  return Math.max(1, Math.floor(numeric));
}

/**
 * Decodes a Pump.fun bonding curve account state from a buffer.
 * @param buffer - The account data buffer.
 * @returns The decoded state or null if invalid.
 */
export function decodePumpCurve(buffer: Buffer): {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  totalSupply: bigint;
  isCompleted: boolean;
} | null {
  if (!buffer || buffer.length < 49) return null;
  const virtualTokenReserves = buffer.readBigUInt64LE(8);
  const virtualSolReserves = buffer.readBigUInt64LE(16);
  const realTokenReserves = buffer.readBigUInt64LE(24);
  const realSolReserves = buffer.readBigUInt64LE(32);
  const totalSupply = buffer.readBigUInt64LE(40);
  const isCompleted = buffer.readUInt8(48) === 1;

  return {
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    realSolReserves,
    totalSupply,
    isCompleted,
  };
}

/**
 * Decodes a Raydium V4 AMM pool account state from a buffer.
 * @param buffer - The account data buffer.
 * @returns The decoded state or null if invalid.
 */
export function decodeRaydiumPool(buffer: Buffer): {
  baseVault: string;
  quoteVault: string;
  baseMint: string;
  quoteMint: string;
} | null {
  if (!buffer || buffer.length < 752) return null;
  const baseVault = buffer.subarray(320, 352);
  const quoteVault = buffer.subarray(352, 384);
  const baseMint = buffer.subarray(400, 432);
  const quoteMint = buffer.subarray(432, 464);

  return {
    baseVault: address(bs58.encode(new Uint8Array(baseVault))),
    quoteVault: address(bs58.encode(new Uint8Array(quoteVault))),
    baseMint: address(bs58.encode(new Uint8Array(baseMint))),
    quoteMint: address(bs58.encode(new Uint8Array(quoteMint))),
  };
}

export interface TaskRecord<T = any> {
  index: number;
  item: T;
  status: 'fulfilled' | 'rejected';
  value?: any;
  reason?: any;
  durationMs: number;
}

/**
 * Runs a set of tasks through a worker function with bounded concurrency.
 * @param items - The items to process.
 * @param worker - The worker function.
 * @param options - Execution options.
 * @returns Array of task results.
 */
export async function runBoundedPool<T = any>(
  items: T[],
  worker: (item: T, index: number) => Promise<any>,
  options: {
    concurrency?: number;
    timeoutMs?: number;
    onTaskStart?: (info: { item: T; index: number }) => void;
    onTaskComplete?: (record: TaskRecord<T>) => void;
    onTaskError?: (record: TaskRecord<T>) => void;
  } = {}
): Promise<TaskRecord<T>[]> {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];

  const concurrency = normalizeConcurrency(options.concurrency, 1);
  const timeoutMs = Number(options.timeoutMs || 0);
  const results = new Array<TaskRecord<T>>(list.length);
  let nextIndex = 0;

  const executeTask = async (item: T, index: number): Promise<void> => {
    const startedAt = Date.now();
    options.onTaskStart?.({ item, index });
    try {
      const taskPromise = Promise.resolve().then(() => worker(item, index));
      const value =
        timeoutMs > 0
          ? await Promise.race([
              taskPromise,
              sleep(timeoutMs).then(() => {
                throw new Error(`Task timed out after ${timeoutMs}ms`);
              }),
            ])
          : await taskPromise;
      const record: TaskRecord<T> = {
        index,
        item,
        status: 'fulfilled',
        value,
        durationMs: Date.now() - startedAt,
      };
      results[index] = record;
      options.onTaskComplete?.(record);
    } catch (reason) {
      const record: TaskRecord<T> = {
        index,
        item,
        status: 'rejected',
        reason,
        durationMs: Date.now() - startedAt,
      };
      results[index] = record;
      options.onTaskError?.(record);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, list.length) }, async () => {
    while (nextIndex < list.length) {
      const index = nextIndex;
      nextIndex += 1;
      await executeTask(list[index]!, index);
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Sends a notification message via Telegram and/or Discord based on configuration.
 * @param ctx - The application context.
 * @param message - The message to send.
 */
export async function sendNotification(ctx: Context, message: string): Promise<void> {
  const { telegramBotToken, telegramChatId, discordWebhookUrl } = ctx.config;
  const promises: Promise<any>[] = [];

  if (telegramBotToken && telegramChatId) {
    const url = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
    promises.push(
      fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { chat_id: telegramChatId, text: message, parse_mode: 'HTML' },
      }).catch((err) => console.error(`[NOTIFY ERROR] Telegram failed: ${err.message}`))
    );
  }

  if (discordWebhookUrl) {
    promises.push(
      fetchJson(discordWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { content: message },
      }).catch((err) => console.error(`[NOTIFY ERROR] Discord failed: ${err.message}`))
    );
  }

  if (promises.length > 0) {
    await Promise.allSettled(promises);
  }
}

export function journalPaperTrade(ctx: Context, entry: any): void {
  if (!ctx.config.paperTrading || !ctx.config.paperTradeJournalFile) {
    return;
  }
  const line = safeJsonStringify({
    timestamp: new Date().toISOString(),
    ...entry,
  });
  appendFileLine(ctx.config.paperTradeJournalFile, line);
}

export function journalClosedTrade(ctx: Context, trade: any): void {
  if (!ctx.config.tradeJournalFile) {
    return;
  }
  const line = safeJsonStringify({
    timestamp: new Date().toISOString(),
    ...trade,
  });
  appendFileLine(ctx.config.tradeJournalFile, line);
}

/**
 * Computes the standard deviation of a series of numbers.
 * @param values - The numeric values.
 * @returns The standard deviation.
 */
export function computeStandardDeviation(values: number[]): number {
  if (!Array.isArray(values) || values.length < 2) return 0;
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (n - 1);
  return Math.sqrt(variance);
}

/**
 * Computes the percentage spread between two prices.
 * @param bid - The bid price.
 * @param ask - The ask price.
 * @returns The spread as a ratio (e.g., 0.01 for 1%).
 */
export function computeSpread(bid: number, ask: number): number {
  if (!(bid > 0) || !(ask > 0)) return 0;
  return Math.abs(ask - bid) / ((ask + bid) / 2);
}
