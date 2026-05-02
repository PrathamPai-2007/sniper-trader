'use strict';

const fs = require('node:fs');
const path = require('node:path');

function ensureParentDirectory(filePath) {
  const directory = path.dirname(path.resolve(filePath));
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

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

function log(logFilePath, message, level = 'info', options = {}) {
  const prefix = {
    info: '[INFO]',
    warn: '[WARN]',
    error: '[ERROR]',
    trade: '[TRADE]',
    debug: '[DEBUG]',
  }[level] || '[INFO]';
  const line = `${new Date().toISOString()} ${prefix} ${message}`;
  
  if (logFilePath) {
    appendFileLine(logFilePath, line);
  }

  const shouldPrint =
    options.console !== undefined
      ? options.console
      : level === 'error' || level === 'trade' || level === 'info';

  if (shouldPrint) {
    console.log(line);
  }
}

function formatUsd(value) {
  if (!Number.isFinite(value)) return '$0.00';
  if (value < 0.01 && value > 0) return `$${value.toFixed(6)}`;
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function atomicToDecimalString(amount, decimals, precision = Math.min(decimals, 6)) {
  const raw = BigInt(amount);
  const negative = raw < 0n;
  const unsigned = negative ? raw * -1n : raw;
  const base = 10n ** BigInt(decimals);
  const whole = unsigned / base;
  const fraction = unsigned % base;
  const fractionString = fraction.toString().padStart(decimals, '0').slice(0, precision).replace(/0+$/, '');
  const text = fractionString ? `${whole}.${fractionString}` : whole.toString();
  return negative ? `-${text}` : text;
}

function decimalToAtomic(value, decimals) {
  const normalized = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(`Invalid decimal value: ${value}`);
  }

  const [wholePart, fractionPart = ''] = normalized.split('.');
  const paddedFraction = `${fractionPart}${'0'.repeat(decimals)}`.slice(0, decimals);
  return `${wholePart}${paddedFraction}`.replace(/^0+(?=\d)/, '') || '0';
}

function ratioToPercentString(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function bigintRatioToNumber(numerator, denominator, scale = 1_000_000n) {
  if (denominator <= 0n) {
    return 0;
  }
  return Number((numerator * scale) / denominator) / Number(scale);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeLaunchpad(value) {
  return String(value || 'unknown').trim().toLowerCase();
}

function deriveWsRpcUrl(rpcUrl) {
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

function isTransientOperationError(error) {
  const msg = error.message.toLowerCase();
  return (
    msg.includes('rate limit') ||
    msg.includes('429') ||
    msg.includes('503') ||
    msg.includes('504') ||
    msg.includes('timeout') ||
    msg.includes('too many requests')
  );
}

module.exports = {
  ensureParentDirectory,
  appendFileLine,
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
};
