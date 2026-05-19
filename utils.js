'use strict';

// Shared utility toolkit: logging, atomic file writes, numeric format helpers,
// retry-aware RPC/fetch wrappers, and notification delivery integrations.

const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');

/**
 * Ensures that the parent directory for a given file path exists.
 * @param {string} filePath - The path to the file.
 */
function ensureParentDirectory(filePath) {
  const directory = path.dirname(path.resolve(filePath));
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

/**
 * Writes content to a file atomically by writing to a temporary file and then renaming it.
 * This prevents data corruption on Windows due to file locking.
 * @param {string} filePath - The destination file path.
 * @param {string} content - The content to write.
 * @returns {Promise<void>}
 * @throws {Error} If the write fails after maximum retries.
 */
async function atomicWriteFile(filePath, content) {
  if (!filePath) return;
  const resolvedPath = path.resolve(filePath);
  ensureParentDirectory(resolvedPath);
  const tempPath = `${resolvedPath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;

  const maxRetries = 5;
  let lastError;

  for (let i = 0; i < maxRetries; i++) {
    try {
      await fsPromises.writeFile(tempPath, content, 'utf8');
      await fsPromises.rename(tempPath, resolvedPath);
      return; // Success
    } catch (err) {
      lastError = err;
      // EPERM or EBUSY often happen on Windows if the file is locked or being indexed
      if ((err.code === 'EPERM' || err.code === 'EBUSY') && i < maxRetries - 1) {
        await sleep(50 * (i + 1));
        continue;
      }
      break;
    }
  }

  console.error(
    `[SYSTEM ERROR] Atomic write failed for ${filePath} after retries: ${lastError.message}`
  );
  try {
    if (fs.existsSync(tempPath)) await fsPromises.unlink(tempPath);
  } catch {}
  throw lastError;
}

/**
 * Asynchronously appends a line of text to a file.
 * @param {string} filePath - The path to the file.
 * @param {string} line - The line of text to append.
 */
function appendFileLine(filePath, line) {
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
 * @param {string} filePath - The path to the file.
 * @param {string} line - The line of text to append.
 */
function appendFileLineSync(filePath, line) {
  if (!filePath) {
    return;
  }
  ensureParentDirectory(filePath);
  fs.appendFileSync(path.resolve(filePath), `${line}\n`);
}

/**
 * Serializes data to JSON while converting BigInt values to strings.
 * @param {any} value - The value to serialize.
 * @param {number|string} [space] - Optional pretty-print spacing.
 * @returns {string} JSON string output safe for persistence/logging.
 */
function safeJsonStringify(value, space) {
  return JSON.stringify(
    value,
    (_key, currentValue) =>
      typeof currentValue === 'bigint' ? currentValue.toString() : currentValue,
    space
  );
}

/**
 * Logs a message to a file and/or the console.
 * @param {string} logFilePath - Path to the log file.
 * @param {string} message - The message to log.
 * @param {string} [level='info'] - The log level (info, warn, error, trade, debug).
 * @param {Object} [options={}] - Logging options.
 * @param {boolean} [options.sync=false] - Whether to use synchronous file writing.
 * @param {boolean} [options.console] - Override default console printing behavior.
 */
function log(logFilePath, message, level = 'info', options = {}) {
  const prefix =
    {
      info: '[INFO]',
      warn: '[WARN]',
      error: '[ERROR]',
      trade: '[TRADE]',
      debug: '[DEBUG]',
    }[level] || '[INFO]';
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
 * @param {number} value - The value to format.
 * @returns {string} The formatted USD string.
 */
function formatUsd(value) {
  if (!Number.isFinite(value)) return '$0.00';
  if (value < 0.01 && value > 0) return `$${value.toFixed(6)}`;
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Converts an atomic bigint amount to a decimal string with specified precision.
 * @param {bigint|number|string} amount - The atomic amount.
 * @param {number} decimals - The number of decimals for the token.
 * @param {number} [precision] - The number of decimal places to include in the output.
 * @returns {string} The formatted decimal string.
 */
function atomicToDecimalString(amount, decimals, precision = Math.min(decimals, 6)) {
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
 * @param {string|number} value - The decimal value.
 * @param {number} decimals - The number of decimals for the token.
 * @returns {string} The atomic string representation.
 * @throws {Error} If the value is not a valid decimal.
 */
function decimalToAtomic(value, decimals) {
  // Keep decimal conversion string-based to avoid floating point drift in token and lamport amounts.
  const normalized = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(`Invalid decimal value: ${value}`);
  }

  const [wholePart, fractionPart = ''] = normalized.split('.');
  const paddedFraction = `${fractionPart}${'0'.repeat(decimals)}`.slice(0, decimals);
  return `${wholePart}${paddedFraction}`.replace(/^0+(?=\d)/, '') || '0';
}

/**
 * Formats a ratio as a percentage string.
 * @param {number} value - The ratio (e.g., 0.123).
 * @returns {string} The formatted percentage string (e.g., "12.30%").
 */
function ratioToPercentString(value) {
  return `${(value * 100).toFixed(2)}%`;
}

/**
 * Safely calculates the ratio of two BigInts as a number.
 * @param {bigint} numerator - The numerator.
 * @param {bigint} denominator - The denominator.
 * @param {bigint} [scale=1000000n] - The internal scale used for precision.
 * @returns {number} The resulting ratio.
 */
function bigintRatioToNumber(numerator, denominator, scale = 1_000_000n) {
  if (denominator <= 0n) {
    return 0;
  }
  return Number((numerator * scale) / denominator) / Number(scale);
}

/**
 * Clamps a value between a minimum and maximum.
 * @param {number} value - The value to clamp.
 * @param {number} minimum - The lower bound.
 * @param {number} maximum - The upper bound.
 * @returns {number} The clamped value.
 */
function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Normalizes a launchpad name to a trimmed lowercase string.
 * @param {string} value - The launchpad name.
 * @returns {string} The normalized launchpad name.
 */
function normalizeLaunchpad(value) {
  return String(value || 'unknown')
    .trim()
    .toLowerCase();
}

/**
 * Derives a WebSocket RPC URL from an HTTP/HTTPS RPC URL.
 * @param {string} rpcUrl - The HTTP(S) RPC URL.
 * @returns {string} The derived WS(S) URL.
 */
function deriveWsRpcUrl(rpcUrl) {
  // Most RPC providers expose websocket endpoints by swapping http(s) for ws(s).
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
 * @param {Error|string} error - The error to check.
 * @returns {boolean} True if the error is transient.
 */
function isTransientOperationError(error) {
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

const https = require('node:https');
const { setTimeout: sleep } = require('node:timers/promises');

// ---------------------------------------------------------------------------
// RPC rate limiters — hard limits imposed by the RPC provider.
// General requests: 10 per second.
// sendTransaction:   1 per second.
// Both use a token-bucket algorithm: tokens refill at a fixed rate and each
// call consumes one token, waiting until a token is available if the bucket
// is empty.
// ---------------------------------------------------------------------------
const RPC_MAX_REQUESTS_PER_SEC = 10;
const RPC_MAX_SEND_TX_PER_SEC = 1;

/**
 * Priority levels for the rate limiter.
 */
const PRIORITY = {
  ULTRA_HIGH: 0, // Signature listeners, immediate buys
  HIGH: 1, // Transactions, final audits, pre-fetch quotes
  MEDIUM: 2, // Monitor loop, price refreshes
  LOW: 3, // Discovery polling, non-critical audits
};

/**
 * A simple TTL-based cache for RPC responses and API data.
 */
class ShortTermCache {
  constructor() {
    this.store = new Map();
  }

  set(key, value, ttlMs = 5000) {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  clear() {
    this.store.clear();
  }
}

const rpcCache = new ShortTermCache();

/**
 * Creates a priority-aware token bucket rate limiter.
 * @param {number} ratePerSec - The number of tokens per second.
 * @returns {Function} An async function (priority) => void.
 */
function makePriorityTokenBucket(ratePerSec) {
  const intervalMs = 1000 / ratePerSec;
  let tokens = ratePerSec;
  let lastRefillAt = Date.now();
  const queues = {
    [PRIORITY.ULTRA_HIGH]: [],
    [PRIORITY.HIGH]: [],
    [PRIORITY.MEDIUM]: [],
    [PRIORITY.LOW]: [],
  };

  const refill = () => {
    const now = Date.now();
    const elapsed = now - lastRefillAt;
    const refilled = Math.floor(elapsed / intervalMs);
    if (refilled > 0) {
      tokens = Math.min(ratePerSec, tokens + refilled);
      lastRefillAt += refilled * intervalMs;
    }
  };

  const processQueues = () => {
    refill();
    while (tokens >= 1) {
      const p = [PRIORITY.ULTRA_HIGH, PRIORITY.HIGH, PRIORITY.MEDIUM, PRIORITY.LOW].find(
        (p) => queues[p].length > 0
      );
      if (p === undefined) break;

      tokens -= 1;
      const resolve = queues[p].shift();
      resolve();
    }

    const hasWaiters = Object.values(queues).some((q) => q.length > 0);
    if (hasWaiters) {
      const msUntilNext = Math.max(1, intervalMs - (Date.now() - lastRefillAt));
      setTimeout(processQueues, msUntilNext);
    }
  };

  return function acquireToken(priority = PRIORITY.MEDIUM) {
    return new Promise((resolve) => {
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
let fetchTransportOptionValue = keepAliveAgent;
try {
  const { Agent } = require('undici');
  fetchTransportOptionName = 'dispatcher';
  fetchTransportOptionValue = new Agent({
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 30_000,
    connections: 25,
  });
} catch {}

let _rpcIndex = 0;

/**
 * Executes an RPC call through the context's RPC client pool with rate limiting and retries.
 * @param {Object} ctx - The application context.
 * @param {string} method - The RPC method name.
 * @param {any[]} params - Arguments for the RPC method.
 * @param {Object} [options={}] - Call options.
 * @param {number} [options.priority=PRIORITY.MEDIUM] - Priority level.
 * @param {number} [options.maxAttempts=3] - Maximum retry attempts.
 * @param {number} [options.cacheTtlMs=0] - If > 0, use short-term cache for this request.
 * @returns {Promise<any>} The result of the RPC call.
 * @throws {Error} If the call fails after retries.
 */
async function rpcCall(ctx, method, params = [], options = {}) {
  const priority = options.priority ?? PRIORITY.MEDIUM;
  const maxAttempts = options.maxAttempts ?? 3;
  const cacheTtlMs = options.cacheTtlMs ?? 0;
  let lastError = null;

  const cacheKey = cacheTtlMs > 0 ? `${method}:${JSON.stringify(params)}` : null;
  if (cacheKey) {
    const cached = rpcCache.get(cacheKey);
    if (cached !== null) return cached;
  }

  const rpcs = Array.isArray(ctx.rpcs) ? ctx.rpcs : [ctx.rpc];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (method === 'sendTransaction') {
        await acquireSendTxToken(PRIORITY.ULTRA_HIGH);
      }
      await acquireRpcToken(priority);

      // Round-robin selection of RPC client
      const rpc = rpcs[_rpcIndex % rpcs.length];
      _rpcIndex++;

      const result = await rpc[method](...params).send();
      if (cacheKey) rpcCache.set(cacheKey, result, cacheTtlMs);
      return result;
    } catch (e) {
      lastError = e;
      if (isTransientOperationError(e) && attempt < maxAttempts - 1) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}

/**
 * Fetches JSON data from a URL with timeout and retries.
 * @param {string} url - The URL to fetch.
 * @param {Object} [options={}] - Fetch options.
 * @param {number} [options.timeoutMs=15000] - Request timeout.
 * @param {number} [options.retries=2] - Number of retries for transient errors.
 * @param {number} [options.retryDelayMs=750] - Delay between retries.
 * @param {string} [options.method='GET'] - HTTP method.
 * @param {Object} [options.headers] - HTTP headers.
 * @param {Object} [options.body] - Request body object (will be JSON stringified).
 * @returns {Promise<any>} The parsed JSON data.
 * @throws {Error} If the fetch fails or returns a non-OK status.
 */
async function fetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs || 15000;
  const retries = options.retries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 750;
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
        [fetchTransportOptionName]: fetchTransportOptionValue,
      });
      const text = await response.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (e) {
          throw new Error(`Failed to parse JSON from ${url}: ${e.message}`);
        }
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
  throw new Error(
    formatFetchError(url, lastError || new Error('Unknown fetch failure'), timeoutMs)
  );
}

/**
 * Determines if an error is an AbortError.
 * @param {Error} error - The error to check.
 * @returns {boolean} True if it's an AbortError.
 */
function isAbortError(error) {
  return error?.name === 'AbortError' || /aborted/i.test(String(error?.message || ''));
}

/**
 * Determines if an error is a transient fetch error that can be retried.
 * @param {Error} error - The error to check.
 * @returns {boolean} True if the error is transient.
 */
function isTransientFetchError(error) {
  const message = String(error?.message || '');
  return (
    isAbortError(error) ||
    /fetch failed/i.test(message) ||
    /ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|socket hang up/i.test(message) ||
    /HTTP 408|HTTP 425|HTTP 429|HTTP 500|HTTP 502|HTTP 503|HTTP 504/i.test(message)
  );
}

/**
 * Formats a fetch error message with URL and timeout information.
 * @param {string} url - The URL that failed.
 * @param {Error} error - The error encountered.
 * @param {number} timeoutMs - The timeout value used.
 * @returns {string} The formatted error message.
 */
function formatFetchError(url, error, timeoutMs) {
  if (isAbortError(error)) return `Request timed out after ${timeoutMs}ms for ${url}`;
  if (String(error?.message || '').includes(url)) return error.message;
  return `Request failed for ${url}: ${error.message}`;
}

/**
 * Normalizes a concurrency value to a positive integer.
 * @param {any} value - The input value.
 * @param {number} [fallback=1] - The fallback value if normalization fails.
 * @returns {number} The normalized concurrency.
 */
function normalizeConcurrency(value, fallback = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 1) return fallback;
  return Math.max(1, Math.floor(numeric));
}

/**
 * --- Account Decoders for Direct RPC Evaluation ---
 */

/**
 * Decodes a Pump.fun bonding curve account state from a buffer.
 * @param {Buffer} buffer - The account data buffer.
 * @returns {Object|null} The decoded state or null if invalid.
 */
function decodePumpCurve(buffer) {
  if (!buffer || buffer.length < 49) return null;
  // Layout: Discriminator (8), VirtualTokenReserves (8), VirtualSolReserves (8),
  // RealTokenReserves (8), RealSolReserves (8), TokenTotalSupply (8), Complete (1)
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
 * @param {Buffer} buffer - The account data buffer.
 * @returns {Object|null} The decoded state or null if invalid.
 */
function decodeRaydiumPool(buffer) {
  if (!buffer || buffer.length < 752) return null;
  // Layout (simplified for V4 AMM):
  // We need baseVault (offset 320, 32 bytes) and quoteVault (offset 352, 32 bytes)
  // And potentially the reserves if we want to skip another RPC call, but V4
  // stores them in separate token accounts. For now, we'll just extract vault addresses.
  const baseVault = buffer.slice(320, 352);
  const quoteVault = buffer.slice(352, 384);
  const baseMint = buffer.slice(400, 432);
  const quoteMint = buffer.slice(432, 464);

  const { address } = require('@solana/addresses');
  return {
    baseVault: address(baseVault),
    quoteVault: address(quoteVault),
    baseMint: address(baseMint),
    quoteMint: address(quoteMint),
  };
}

/**
 * Runs a set of tasks through a worker function with bounded concurrency.
 * @param {Array} items - The items to process.
 * @param {Function} worker - The worker function (async (item, index) => ...).
 * @param {Object} [options={}] - Execution options.
 * @param {number} [options.concurrency=1] - Maximum number of concurrent tasks.
 * @param {number} [options.timeoutMs=0] - Timeout for each individual task (0 for no timeout).
 * @param {Function} [options.onTaskStart] - Callback when a task starts.
 * @param {Function} [options.onTaskComplete] - Callback when a task successfully completes.
 * @param {Function} [options.onTaskError] - Callback when a task fails.
 * @returns {Promise<Array>} Array of task results (status, value/reason, duration).
 */
async function runBoundedPool(items, worker, options = {}) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];

  const concurrency = normalizeConcurrency(options.concurrency, 1);
  const timeoutMs = Number(options.timeoutMs || 0);
  const results = new Array(list.length);
  let nextIndex = 0;

  const executeTask = async (item, index) => {
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
      const record = {
        index,
        item,
        status: 'fulfilled',
        value,
        durationMs: Date.now() - startedAt,
      };
      results[index] = record;
      options.onTaskComplete?.(record);
    } catch (reason) {
      const record = {
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
      await executeTask(list[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Sends a notification message via Telegram and/or Discord based on configuration.
 * @param {Object} ctx - The application context.
 * @param {string} message - The message to send.
 * @returns {Promise<void>}
 */
async function sendNotification(ctx, message) {
  const { telegramBotToken, telegramChatId, discordWebhookUrl } = ctx.config;
  const promises = [];

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

/**
 * Appends a paper trade entry to the paper trade journal file.
 * @param {Object} ctx - The application context.
 * @param {Object} entry - The paper trade data entry.
 */
function journalPaperTrade(ctx, entry) {
  if (!ctx.config.paperTrading || !ctx.config.paperTradeJournalFile) {
    return;
  }
  const line = safeJsonStringify({
    timestamp: new Date().toISOString(),
    ...entry,
  });
  appendFileLine(ctx.config.paperTradeJournalFile, line);
}

/**
 * Appends a closed trade record to the cumulative trade journal file.
 * Works for both paper and live trading modes.
 * @param {Object} ctx - The application context.
 * @param {Object} trade - The closed trade data record.
 */
function journalClosedTrade(ctx, trade) {
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
 * @param {number[]} values - The numeric values.
 * @returns {number} The standard deviation.
 */
function computeStandardDeviation(values) {
  if (!Array.isArray(values) || values.length < 2) return 0;
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (n - 1);
  return Math.sqrt(variance);
}

/**
 * Computes the percentage spread between two prices.
 * @param {number} bid - The bid price.
 * @param {number} ask - The ask price.
 * @returns {number} The spread as a ratio (e.g., 0.01 for 1%).
 */
function computeSpread(bid, ask) {
  if (!(bid > 0) || !(ask > 0)) return 0;
  return Math.abs(ask - bid) / ((ask + bid) / 2);
}

module.exports = {
  ensureParentDirectory,
  appendFileLine,
  appendFileLineSync,
  safeJsonStringify,
  log,
  formatUsd,
  atomicToDecimalString,
  decimalToAtomic,
  ratioToPercentString,
  bigintRatioToNumber,
  clamp,
  normalizeLaunchpad,
  deriveWsRpcUrl,
  isTransientOperationError,
  PRIORITY,
  rpcCall,
  fetchJson,
  runBoundedPool,
  atomicWriteFile,
  sendNotification,
  journalPaperTrade,
  journalClosedTrade,
  decodePumpCurve,
  decodeRaydiumPool,
  computeStandardDeviation,
  computeSpread,
};
