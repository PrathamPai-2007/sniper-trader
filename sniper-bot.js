#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} = require('@solana/web3.js');
const bs58Module = require('bs58');

const bs58 = bs58Module.default || bs58Module;
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const DEFAULT_STATE_FILE = '';
const MAX_TRACKED_MINTS = 1_000;
// Trading Strategy Constants
const TAKE_PROFIT_MULTIPLES = [1.5]; // Sell at 1.5x entry price
const TAKE_PROFIT_FRACTION = 0.65;   // Fraction of current balance to sell at each TP target
const TP_SELL_PERCENT = Math.round(TAKE_PROFIT_FRACTION * 100);
const TP_HOLD_PERCENT = 100 - TP_SELL_PERCENT;

const BURN_OWNERS = new Set([
  '11111111111111111111111111111111',
  '1nc1nerator11111111111111111111111111111111',
]);
const DEFAULT_MEME_KEYWORDS = [
  'ai',
  'ape',
  'bonk',
  'cat',
  'chad',
  'coin',
  'dog',
  'elon',
  'frog',
  'inu',
  'kitty',
  'meme',
  'moon',
  'pepe',
  'pump',
  'sol',
  'wojak',
];
const DEFAULT_LAUNCHPAD_PROFILES = {
  'pump.fun': {
    scoreBonus: 10,
    liquidityMultiplier: 0.75,
    holderMultiplier: 0.7,
    buysMultiplier: 0.75,
    minPoolAgeSeconds: 5,
  },
  'bags.fun': {
    scoreBonus: 6,
    liquidityMultiplier: 0.7,
    holderMultiplier: 0.6,
    buysMultiplier: 0.5,
    minPoolAgeSeconds: 5,
  },
  raydium: {
    scoreBonus: 8,
    liquidityMultiplier: 1,
    holderMultiplier: 1,
    buysMultiplier: 1,
    minPoolAgeSeconds: 10,
  },
  meteora: {
    scoreBonus: 7,
    liquidityMultiplier: 1,
    holderMultiplier: 1,
    buysMultiplier: 1,
    minPoolAgeSeconds: 10,
  },
  moonshot: {
    scoreBonus: 9,
    liquidityMultiplier: 0.8,
    holderMultiplier: 0.75,
    buysMultiplier: 0.75,
    minPoolAgeSeconds: 5,
  },
};
const SPL_TOKEN_PROGRAM_IDS = [
  new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
];
const INITIALIZE_MINT_LOG_PATTERN = /Instruction:\s+InitializeMint2?/i;
const DISCOVERY_SIGNAL_RETENTION_MS = 10 * 60 * 1000;
const MARKET_SNAPSHOT_RETENTION_MS = 60 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_FETCH_RETRIES = 2;
const DEFAULT_FETCH_RETRY_DELAY_MS = 750;

loadEnvFile();

function loadConfig() {
  const privateKey = process.env.PRIVATE_KEY || '';
  const privateKeyPath = process.env.PRIVATE_KEY_PATH || '';
  const rpcUrl = requireEnv('RPC_URL');
  const scanIntervalMs = numberFromEnv('SCAN_INTERVAL_MS', 5000);
  const discoveryPollIntervalMs = numberFromEnv(
    'DISCOVERY_POLL_INTERVAL_MS',
    Math.max(scanIntervalMs, 30_000)
  );

  const paperTrading = booleanFromEnv('PAPER_TRADING', false);
  const sessionType = paperTrading ? 'paper-trading' : 'live-trading';
  const timestamp = new Date().toISOString().replace('T', '_').replace(/[:.]/g, '-').slice(0, 19);
  const sessionDir = path.join('logs', sessionType, timestamp);

  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  const stateFile = process.env.STATE_FILE || DEFAULT_STATE_FILE;
  const logFile = process.env.LOG_FILE || './bot.log';
  const scannedTokensFile = process.env.SCANNED_TOKENS_FILE || './scanned-memecoins.jsonl';

  return {
    rpcUrl,
    wsRpcUrl: (process.env.WS_RPC_URL || deriveWsRpcUrl(rpcUrl)).replace(/\/+$/, ''),
    jupiterApiKey: requireEnv('JUPITER_API_KEY'),
    jupiterBaseUrl: (process.env.JUPITER_BASE_URL || 'https://api.jup.ag').replace(/\/+$/, ''),
    goPlusBaseUrl: (process.env.GOPLUS_BASE_URL || 'https://api.gopluslabs.io/api/v1').replace(/\/+$/, ''),
    bubbleMapsBaseUrl: (process.env.BUBBLEMAPS_BASE_URL || 'https://api.bubblemaps.io').replace(/\/+$/, ''),
    scanIntervalMs,
    discoveryPollIntervalMs,
    discoveryWsEnabled: booleanFromEnv('DISCOVERY_WS_ENABLED', true),
    discoveryWsDebounceMs: numberFromEnv('DISCOVERY_WS_DEBOUNCE_MS', 750),
    buyAmountSolText: process.env.BUY_AMOUNT_SOL || '0.05',
    buyAmountLamports: decimalToAtomic(process.env.BUY_AMOUNT_SOL || '0.05', 9),
    slippageBps: numberFromEnv('SLIPPAGE_BPS', 150),
    maxOpenPositions: numberFromEnv('MAX_OPEN_POSITIONS', 10),
    maxBuysPerScan: numberFromEnv('MAX_BUYS_PER_SCAN', 1),
    maxCandidatesPerScan: numberFromEnv('MAX_CANDIDATES_PER_SCAN', 10),
    dryRun: booleanFromEnv('DRY_RUN', true),
    paperTrading: booleanFromEnv('PAPER_TRADING', false),
    initialPaperSolText: process.env.INITIAL_PAPER_SOL || '1',
    initialPaperSolLamports: decimalToAtomic(process.env.INITIAL_PAPER_SOL || '1', 9),
    sessionDir,
    stateFile: stateFile ? path.join(sessionDir, path.basename(stateFile)) : '',
    logFile: path.join(sessionDir, path.basename(logFile)),
    scannedTokensFile: path.join(sessionDir, path.basename(scannedTokensFile)),
    tradeJournalFile: path.join(sessionDir, 'trade-journal.jsonl'),
    performanceStatsFile: path.join(sessionDir, 'performance-stats.json'),
    minLiquidityUsd: numberFromEnv('MIN_LIQUIDITY_USD', 1500),
    minOrganicScore: numberFromEnv('MIN_ORGANIC_SCORE', 0),
    minHolderCount: numberFromEnv('MIN_HOLDER_COUNT', 10),
    minBuys5m: numberFromEnv('MIN_BUYS_5M', 2),
    minPoolAgeSeconds: numberFromEnv('MIN_POOL_AGE_SECONDS', 5),
    maxCandidateAgeMinutes: numberFromEnv('MAX_CANDIDATE_AGE_MINUTES', 30),
    minSocialLinks: numberFromEnv('MIN_SOCIAL_LINKS', 0),
    maxAuditTopHoldersPct: numberFromEnv('MAX_AUDIT_TOP_HOLDERS_PCT', 60),
    maxTokenAccountTop1Pct: numberFromEnv('MAX_TOKEN_ACCOUNT_TOP1_PCT', 90),
    maxTokenAccountTop5Pct: numberFromEnv('MAX_TOKEN_ACCOUNT_TOP5_PCT', 98),
    maxFdvToLiquidity: numberFromEnv('MAX_FDV_TO_LIQUIDITY', 80),
    maxMemeFdvUsd: numberFromEnv('MAX_MEME_FDV_USD', 10000000),
    allowVerifiedTokens: booleanFromEnv('ALLOW_VERIFIED_TOKENS', true),
    memeKeywords: (process.env.MEME_KEYWORDS || DEFAULT_MEME_KEYWORDS.join(','))
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
    goPlusAccessToken: process.env.GOPLUS_ACCESS_TOKEN || '',
    bubbleMapsApiKey: process.env.BUBBLEMAPS_API_KEY || '',
    minBubbleMapsScore: numberFromEnv('MIN_BUBBLEMAPS_SCORE', 60),
    maxBubbleMapsLargestClusterShare: numberFromEnv('MAX_BUBBLEMAPS_LARGEST_CLUSTER_SHARE', 0.2),
    minCandidateScore: numberFromEnv('MIN_CANDIDATE_SCORE', 60),
    minMomentumConsistency: numberFromEnv('MIN_MOMENTUM_CONSISTENCY', 0.6),
    maxExhaustionRangePct: numberFromEnv('MAX_EXHAUSTION_RANGE_PCT', 1.5),
    highGrowthConfidenceScore: numberFromEnv('HIGH_GROWTH_CONFIDENCE_SCORE', 70),
    borderlineRecheckEnabled: booleanFromEnv('BORDERLINE_RECHECK_ENABLED', true),
    borderlineRecheckMinDelayMs: numberFromEnv('BORDERLINE_RECHECK_MIN_DELAY_MS', 10_000),
    borderlineRecheckMaxDelayMs: numberFromEnv('BORDERLINE_RECHECK_MAX_DELAY_MS', 20_000),
    borderlineRecheckMaxAttempts: numberFromEnv('BORDERLINE_RECHECK_MAX_ATTEMPTS', 3),
    borderlineThresholdBufferRatio: numberFromEnv('BORDERLINE_THRESHOLD_BUFFER_PCT', 20) / 100,
    survivalDelaySeconds: numberFromEnv('SURVIVAL_DELAY_SECONDS', 30),
    minSurvivalMomentum: numberFromEnv('MIN_SURVIVAL_MOMENTUM', 1.05),
    maxPriceDumpPct: numberFromEnv('MAX_PRICE_DUMP_PCT', 20),
    maxLiquidityDrawdownPct: numberFromEnv('MAX_LIQUIDITY_DRAWDOWN_PCT', 15),
    performanceCheckSeconds: numberFromEnv('PERFORMANCE_CHECK_SECONDS', 75),
    performanceMinMomentum: numberFromEnv('PERFORMANCE_MIN_MOMENTUM', 1.05),
    minHoldTimeSeconds: numberFromEnv('MIN_HOLD_TIME_SECONDS', 60),
    stopLossPct: numberFromEnv('STOP_LOSS_PCT', 0.40),
    maxHoldMinutes: numberFromEnv('MAX_HOLD_MINUTES', 60),
    timeExitMinMultiple: numberFromEnv('TIME_EXIT_MIN_MULTIPLE', 1.25),
    liquidityCollapseThresholdUsd: numberFromEnv('LIQUIDITY_COLLAPSE_THRESHOLD_USD', 750),
    liquidityCollapseThresholdRatio: numberFromEnv('LIQUIDITY_COLLAPSE_THRESHOLD_RATIO', 0.25),
    holdDurationHighConfidenceMinutes: numberFromEnv('HOLD_DURATION_HIGH_CONFIDENCE_MINUTES', 10),
    holdDurationLowConfidenceMinutes: numberFromEnv('HOLD_DURATION_LOW_CONFIDENCE_MINUTES', 5),
    recheckPriceDropPct: numberFromEnv('RECHECK_PRICE_DROP_PCT', 15),
    moodPauseDurationMinutes: numberFromEnv('MOOD_PAUSE_DURATION_MINUTES', 60),
    coolDownMinutes: numberFromEnv('COOL_DOWN_MINUTES', 20),
    reentryDipPct: numberFromEnv('REENTRY_DIP_PCT', 15),
    reentryBreakoutPct: numberFromEnv('REENTRY_BREAKOUT_PCT', 20),
    maxSurvivalGrowthPct: numberFromEnv('MAX_SURVIVAL_GROWTH_PCT', 150),
    minAccelerationFactor: numberFromEnv('MIN_ACCELERATION_FACTOR', 0.4),
    maxSellPressureIncreasePct: numberFromEnv('MAX_SELL_PRESSURE_INCREASE_PCT', 30),
    privateKey,
    privateKeyPath,
  };
}

validateStartupConfig();
const config = loadConfig();
const wallet = createRuntimeWallet(config);
const connectionConfig = {
  commitment: 'confirmed',
};
if (config.wsRpcUrl) {
  connectionConfig.wsEndpoint = config.wsRpcUrl;
}
const connection = new Connection(config.rpcUrl, connectionConfig);
const state = loadState(config.stateFile);
const paperAnalytics = loadPaperAnalytics();
const discoveryState = {
  debounceTimer: null,
  pendingSignatures: new Set(),
  recentSignalMints: new Map(),
  logSubscriptionIds: [],
  websocketReady: false,
};
let loopBusy = false;
let pendingLoopRequest = null;
let lastDiscoveryScanAt = 0;
let shouldStop = false;
let shutdownRequested = false;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid number in ${name}: ${raw}`);
  }
  return value;
}

function booleanFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
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
    if (parsedUrl.protocol === 'wss:' || parsedUrl.protocol === 'ws:') {
      return parsedUrl.toString();
    }
  } catch (error) {
    return '';
  }

  return '';
}

function getLaunchpadProfile(launchpad) {
  const normalized = normalizeLaunchpad(launchpad);
  return {
    name: normalized,
    scoreBonus: normalized === 'unknown' ? 0 : 4,
    liquidityMultiplier: normalized === 'unknown' ? 1.1 : 0.9,
    holderMultiplier: normalized === 'unknown' ? 1.2 : 0.9,
    buysMultiplier: normalized === 'unknown' ? 1.2 : 0.9,
    minPoolAgeSeconds: normalized === 'unknown' ? 10 : 5,
    ...(DEFAULT_LAUNCHPAD_PROFILES[normalized] || {}),
  };
}

function getLaunchpadAdjustedThresholds(launchpadProfile) {
  return {
    minLiquidityUsd: Math.max(250, config.minLiquidityUsd * launchpadProfile.liquidityMultiplier),
    minHolderCount: Math.max(2, config.minHolderCount * launchpadProfile.holderMultiplier),
    minBuys5m: Math.max(0, Math.floor(config.minBuys5m * launchpadProfile.buysMultiplier)),
    minPoolAgeSeconds: Math.max(1, Math.min(config.minPoolAgeSeconds, launchpadProfile.minPoolAgeSeconds)),
  };
}

function computeCandidateScore(token, launchpadProfile, thresholds, socialLinks, ageSeconds) {
  let score = 0;
  const liquidity = Number(token.liquidity || 0);
  const holders = Number(token.holderCount || 0);
  const buys5m = Number(token.stats5m?.numBuys || 0);
  const organicScore = Number(token.organicScore || 0);
  const auditTopHoldersPct = Number(token.audit?.topHoldersPercentage || 100);

  if (looksLikeMemecoin(token)) {
    score += 12;
  }

  score += clamp((liquidity / thresholds.minLiquidityUsd) * 16, 0, 20);
  score += clamp((holders / thresholds.minHolderCount) * 12, 0, 15);
  score += clamp((buys5m / Math.max(1, thresholds.minBuys5m || 1)) * 10, 0, 12);
  score += clamp(organicScore / 5, 0, 18);
  score += Math.min(8, socialLinks * 3);
  score += launchpadProfile.scoreBonus;

  if (token.isVerified) {
    score += 5;
  }
  if (Number.isFinite(auditTopHoldersPct)) {
    score += clamp((config.maxAuditTopHoldersPct - auditTopHoldersPct) / 4, -10, 10);
  }
  if (ageSeconds !== null) {
    score += clamp(8 - ageSeconds / 30, 0, 8);
  }
  if (token.audit?.isSus === true) {
    score -= 25;
  }
  if (token.audit?.mintAuthorityDisabled === false) {
    score -= 15;
  }
  if (token.audit?.freezeAuthorityDisabled === false) {
    score -= 15;
  }

  return Math.round(clamp(score, 0, 100));
}

function createDefaultPaperAnalytics() {
  return {
    startedAt: new Date().toISOString(),
    lastUpdatedAt: null,
    totalBuys: 0,
    totalPartialSells: 0,
    totalClosedPositions: 0,
    winningPositions: 0,
    losingPositions: 0,
    breakEvenPositions: 0,
    takeProfitExecutions: 0,
    stopLossExits: 0,
    trailingStopExits: 0,
    timeExits: 0,
    liquidityExits: 0,
    totalInvestedUsd: 0,
    totalRealizedUsd: 0,
    totalRealizedPnlUsd: 0,
    largestWinUsd: 0,
    largestLossUsd: 0,
    averageClosedPnlUsd: 0,
    winRatePct: 0,
    openPositions: 0,
  };
}

function loadPaperAnalytics() {
  if (!config.paperTrading) return createDefaultPaperAnalytics();
  const resolvedPath = path.resolve(config.performanceStatsFile);
  if (!fs.existsSync(resolvedPath)) {
    return createDefaultPaperAnalytics();
  }

  try {
    return {
      ...createDefaultPaperAnalytics(),
      ...JSON.parse(fs.readFileSync(resolvedPath, 'utf8')),
    };
  } catch (error) {
    log(`Failed to load paper analytics, starting fresh: ${error.message}`, 'warn');
    return createDefaultPaperAnalytics();
  }
}

function persistPaperAnalytics() {
  if (!config.paperTrading) return;
  paperAnalytics.lastUpdatedAt = new Date().toISOString();
  paperAnalytics.openPositions = state.positions.size;
  ensureParentDirectory(config.performanceStatsFile);
  fs.writeFileSync(path.resolve(config.performanceStatsFile), JSON.stringify(paperAnalytics, null, 2));
}

function writePaperTradeEvent(event) {
  if (!config.paperTrading) return;
  appendFileLine(
    config.tradeJournalFile,
    JSON.stringify({
      recordedAt: new Date().toISOString(),
      ...event,
    })
  );
}

function notePaperExitReason(exitReason) {
  if (!config.paperTrading) return;
  if (exitReason.startsWith('take-profit')) {
    paperAnalytics.takeProfitExecutions += 1;
    return;
  }
  if (exitReason === 'stop-loss') {
    paperAnalytics.stopLossExits += 1;
    return;
  }
  if (exitReason === 'trailing-stop' || exitReason === 'tp-trailing-exit') {
    paperAnalytics.trailingStopExits += 1;
    return;
  }
  if (exitReason === 'time-exit' || exitReason === 'no-early-performance') {
    paperAnalytics.timeExits += 1;
    return;
  }
  if (exitReason === 'liquidity-exit') {
    paperAnalytics.liquidityExits += 1;
  }
}

function updatePaperClosedPositionStats(position) {
  if (!config.paperTrading) return;
  const pnl = Number(position.realizedPnlUsd || 0);
  paperAnalytics.totalClosedPositions += 1;
  if (pnl > 0.000001) {
    paperAnalytics.winningPositions += 1;
  } else if (pnl < -0.000001) {
    paperAnalytics.losingPositions += 1;
  } else {
    paperAnalytics.breakEvenPositions += 1;
  }
  paperAnalytics.largestWinUsd = Math.max(paperAnalytics.largestWinUsd, pnl);
  paperAnalytics.largestLossUsd = Math.min(paperAnalytics.largestLossUsd, pnl);
  const denominator = Math.max(1, paperAnalytics.totalClosedPositions);
  paperAnalytics.averageClosedPnlUsd = paperAnalytics.totalRealizedPnlUsd / denominator;
  paperAnalytics.winRatePct = (paperAnalytics.winningPositions / denominator) * 100;

  if (position.lastExitReason) {
    notePaperExitReason(position.lastExitReason);
  }
}

function loadEnvFile() {
  const explicitPath = process.env.ENV_FILE || '.env';
  const resolvedPath = path.resolve(explicitPath);

  if (!fs.existsSync(resolvedPath)) {
    return;
  }

  const raw = fs.readFileSync(resolvedPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function validateStartupConfig() {
  const missing = [];
  const isPaperTrading = booleanFromEnv('PAPER_TRADING', false);

  if (!process.env.RPC_URL) {
    missing.push('RPC_URL');
  }
  if (!process.env.JUPITER_API_KEY) {
    missing.push('JUPITER_API_KEY');
  }

  if (!isPaperTrading && !process.env.PRIVATE_KEY && !process.env.PRIVATE_KEY_PATH) {
    missing.push('PRIVATE_KEY or PRIVATE_KEY_PATH');
  }

  if (missing.length > 0) {
    const mode = isPaperTrading ? 'paper trading' : 'live trading';
    throw new Error(
      `Startup configuration error for ${mode}. Missing required setting(s): ${missing.join(', ')}. ` +
      `Add them to .env or your shell environment and try again.`
    );
  }

  const buyAmount = process.env.BUY_AMOUNT_SOL;
  if (buyAmount && !/^\d+(\.\d+)?$/.test(String(buyAmount).trim())) {
    throw new Error(`Startup configuration error: BUY_AMOUNT_SOL must be a positive decimal, got "${buyAmount}".`);
  }

  const scanInterval = process.env.SCAN_INTERVAL_MS;
  if (scanInterval && !Number.isFinite(Number(scanInterval))) {
    throw new Error(`Startup configuration error: SCAN_INTERVAL_MS must be a number, got "${scanInterval}".`);
  }
}

function loadWallet(currentConfig) {
  let secret = '';

  if (currentConfig.privateKeyPath) {
    secret = fs.readFileSync(path.resolve(currentConfig.privateKeyPath), 'utf8').trim();
  } else if (currentConfig.privateKey) {
    secret = currentConfig.privateKey.trim();
  } else {
    throw new Error('Set PRIVATE_KEY or PRIVATE_KEY_PATH with your Solana wallet secret.');
  }

  let bytes;
  if (secret.startsWith('[')) {
    bytes = Uint8Array.from(JSON.parse(secret));
  } else {
    bytes = Uint8Array.from(bs58.decode(secret));
  }

  if (bytes.length === 64) {
    return Keypair.fromSecretKey(bytes);
  }
  if (bytes.length === 32) {
    return Keypair.fromSeed(bytes);
  }
  throw new Error(`Unsupported private key length: ${bytes.length} bytes`);
}

function createRuntimeWallet(currentConfig) {
  if (currentConfig.paperTrading && !currentConfig.privateKey && !currentConfig.privateKeyPath) {
    return Keypair.generate();
  }

  return loadWallet(currentConfig);
}

function loadState(stateFile) {
  const baseState = {
    processedMintQueue: [],
    processedMints: new Set(),
    pendingCandidateRechecks: new Map(),
    positions: new Map(),
    marketSnapshots: new Map(),
    paperSolBalanceLamports: config.initialPaperSolLamports,
    tradeHistory: [],
    moodPauseUntil: null,
    coolDownMints: new Map(),
    retiredMints: new Map(),
  };

  if (!stateFile) {
    return baseState;
  }

  const resolvedPath = path.resolve(stateFile);
  if (!fs.existsSync(resolvedPath)) {
    return baseState;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
    const queue = Array.isArray(parsed.processedMintQueue) ? parsed.processedMintQueue : [];
    const positions = Array.isArray(parsed.positions) ? parsed.positions : [];
    const pendingCandidateRechecks = Array.isArray(parsed.pendingCandidateRechecks)
      ? parsed.pendingCandidateRechecks
      : [];
    return {
      processedMintQueue: queue,
      processedMints: new Set(queue),
      pendingCandidateRechecks: new Map(
        pendingCandidateRechecks
          .filter((entry) => entry?.mint)
          .map((entry) => [entry.mint, entry])
      ),
      positions: new Map(positions.map((position) => [position.mint, position])),
      marketSnapshots: new Map(),
      paperSolBalanceLamports: parsed.paperSolBalanceLamports || config.initialPaperSolLamports,
      tradeHistory: Array.isArray(parsed.tradeHistory) ? parsed.tradeHistory : [],
      moodPauseUntil: parsed.moodPauseUntil || null,
      coolDownMints: new Map(Object.entries(parsed.coolDownMints || {})),
      retiredMints: new Map(Object.entries(parsed.retiredMints || {})),
    };
  } catch (error) {
    log(`Failed to load state file, starting fresh: ${error.message}`, 'warn');
    return baseState;
  }
}

function persistState() {
  if (!config.stateFile) {
    return;
  }

  const resolvedPath = path.resolve(config.stateFile);
  const payload = {
    processedMintQueue: state.processedMintQueue,
    pendingCandidateRechecks: Array.from(state.pendingCandidateRechecks.values()),
    positions: Array.from(state.positions.values()),
    paperSolBalanceLamports: state.paperSolBalanceLamports,
    tradeHistory: state.tradeHistory,
    moodPauseUntil: state.moodPauseUntil,
    coolDownMints: Object.fromEntries(state.coolDownMints),
    retiredMints: Object.fromEntries(state.retiredMints),
  };

  fs.writeFileSync(resolvedPath, JSON.stringify(payload, null, 2));
}

function ensureParentDirectory(filePath) {
  const directory = path.dirname(path.resolve(filePath));
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

function trackProcessedMint(mint) {
  if (state.processedMints.has(mint)) {
    return;
  }

  state.pendingCandidateRechecks.delete(mint);
  state.processedMints.add(mint);
  state.processedMintQueue.push(mint);

  while (state.processedMintQueue.length > MAX_TRACKED_MINTS) {
    const removedMint = state.processedMintQueue.shift();
    if (removedMint) {
      state.processedMints.delete(removedMint);
    }
  }
}

function untrackProcessedMint(mint) {
  state.processedMints.delete(mint);
  state.pendingCandidateRechecks.delete(mint);
  state.processedMintQueue = state.processedMintQueue.filter((m) => m !== mint);
}

function startCoolDown(mint, lastExitPriceUsd) {
  const expiresAt = Date.now() + config.coolDownMinutes * 60000;
  state.coolDownMints.set(mint, {
    expiresAt,
    lastExitPriceUsd,
  });
  log(`Token ${mint} entered cool-down until ${new Date(expiresAt).toLocaleTimeString()}. Last exit: ${formatUsd(lastExitPriceUsd)}.`, 'info');
}

function processCoolDowns() {
  const now = Date.now();
  let changed = false;

  for (const [mint, entry] of state.coolDownMints.entries()) {
    if (now >= entry.expiresAt) {
      state.coolDownMints.delete(mint);
      state.retiredMints.set(mint, { lastExitPriceUsd: entry.lastExitPriceUsd });
      untrackProcessedMint(mint);
      log(`Cool-down expired for ${mint}. Token is now eligible for re-analysis with price-distance filtering.`, 'info');
      changed = true;
    }
  }

  if (changed) {
    persistState();
  }
}

function appendFileLine(filePath, line) {
  if (!filePath) {
    return;
  }
  ensureParentDirectory(filePath);
  fs.appendFile(path.resolve(filePath), `${line}\n`, (err) => {
    if (err) {
      // We use console.error here because the async logger itself failed
      console.error(`[SYSTEM ERROR] Failed to write to ${filePath}: ${err.message}`);
    }
  });
}

function log(message, level = 'info', options = {}) {
  const prefix = {
    info: '[INFO]',
    warn: '[WARN]',
    error: '[ERROR]',
    trade: '[TRADE]',
    debug: '[DEBUG]',
  }[level] || '[INFO]';
  const line = `${new Date().toISOString()} ${prefix} ${message}`;
  appendFileLine(config.logFile, line);

  const shouldPrint =
    options.console !== undefined
      ? options.console
      : level === 'error' || level === 'trade' || level === 'info';

  if (shouldPrint) {
    console.log(line);
  }
}

function writeScannedTokenRecord(record) {
  appendFileLine(
    config.scannedTokensFile,
    JSON.stringify({
      scannedAt: new Date().toISOString(),
      ...record,
    })
  );
}

function recordTradeResult(win) {
  state.tradeHistory.push({ win, timestamp: Date.now() });
  // Keep only last 20 trades to save memory/state size
  if (state.tradeHistory.length > 20) {
    state.tradeHistory.shift();
  }
}

function getMoodAdjustments() {
  const history = state.tradeHistory;
  const last5 = history.slice(-5);
  const last10 = history.slice(-10);

  let sizeMultiplier = 1.0;
  let isPaused = false;

  if (state.moodPauseUntil && Date.now() < state.moodPauseUntil) {
    isPaused = true;
  }

  if (last10.length >= 10) {
    const winRate10 = last10.filter((t) => t.win).length / last10.length;
    if (winRate10 < 0.25) {
      if (!isPaused) {
        state.moodPauseUntil = Date.now() + config.moodPauseDurationMinutes * 60000;
        log(`Daily Mood: CRITICAL (Last 10 Win Rate: ${(winRate10 * 100).toFixed(0)}%). Pausing trading for ${config.moodPauseDurationMinutes}m.`, 'warn', { console: true });
        isPaused = true;
      }
    }
  }

  if (!isPaused && last5.length >= 5) {
    const winRate5 = last5.filter((t) => t.win).length / last5.length;
    if (winRate5 < 0.4) {
      sizeMultiplier = 0.5;
      log(`Daily Mood: CAUTIOUS (Last 5 Win Rate: ${(winRate5 * 100).toFixed(0)}%). Reducing trade size by 50%.`, 'warn', { console: true });
    }
  }

  return { sizeMultiplier, isPaused };
}

function chooseBorderlineRecheckDelayMs() {
  const minDelay = Math.max(1_000, config.borderlineRecheckMinDelayMs);
  const maxDelay = Math.max(minDelay, config.borderlineRecheckMaxDelayMs);
  return minDelay + Math.floor(Math.random() * (maxDelay - minDelay + 1));
}

function isSlightlyBelowThreshold(actual, required) {
  if (!(required > 0) || !Number.isFinite(actual)) {
    return false;
  }
  return actual >= required * (1 - config.borderlineThresholdBufferRatio);
}

function removeCandidateRecheck(mint) {
  state.pendingCandidateRechecks.delete(mint);
}

function shouldScheduleBorderlineRecheck(evaluation, existingEntry = null) {
  if (!config.borderlineRecheckEnabled || evaluation.approved) {
    return false;
  }

  const rejectionReasons = Array.isArray(evaluation.rejectionReasons) ? evaluation.rejectionReasons : [];
  if (rejectionReasons.length === 0) {
    return false;
  }

  const attempts = Number(existingEntry?.attempts || 0);
  return attempts < config.borderlineRecheckMaxAttempts && rejectionReasons.every((reason) => reason?.recheckEligible === true);
}

function scheduleCandidateRecheck(evaluation, existingEntry = null) {
  const attempts = Number(existingEntry?.attempts || 0) + 1;
  const delayMs = chooseBorderlineRecheckDelayMs();
  const nowIso = new Date().toISOString();
  const nextEligibleAt = new Date(Date.now() + delayMs).toISOString();
  const entry = {
    mint: evaluation.token.id,
    tokenSnapshot: evaluation.token,
    attempts,
    firstSeenAt: existingEntry?.firstSeenAt || nowIso,
    lastScheduledAt: nowIso,
    nextEligibleAt,
    lastCandidateScore: evaluation.candidateScore,
    lastBlockers: evaluation.blockers,
    rejectionReasonCodes: (evaluation.rejectionReasons || []).map((reason) => reason.code),
    launchpadProfile: evaluation.launchpadProfile?.name || null,
    liquidityAtStartOfDelay: Number(evaluation.token.liquidity || 0),
    priceHistory: [{ price: Number(evaluation.token.usdPrice || 0), timestamp: Date.now() }],
  };
  state.pendingCandidateRechecks.set(entry.mint, entry);
  return entry;
}

function scheduleSurvivalDelay(evaluation) {
  const delayMs = config.survivalDelaySeconds * 1000;
  const nowIso = new Date().toISOString();
  const nextEligibleAt = new Date(Date.now() + delayMs).toISOString();
  const entry = {
    mint: evaluation.token.id,
    tokenSnapshot: evaluation.token,
    attempts: 0,
    firstSeenAt: nowIso,
    lastScheduledAt: nowIso,
    nextEligibleAt,
    lastCandidateScore: evaluation.candidateScore,
    lastBlockers: [],
    rejectionReasonCodes: [],
    launchpadProfile: evaluation.launchpadProfile?.name || null,
    highestSeenPriceUsd: Number(evaluation.token.usdPrice || 0),
    priceAtStartOfDelay: Number(evaluation.token.usdPrice || 0),
    liquidityAtStartOfDelay: Number(evaluation.token.liquidity || 0),
    priceHistory: [{ price: Number(evaluation.token.usdPrice || 0), timestamp: Date.now() }],
    tapeAtStart: {
      buys: Number(evaluation.token.stats5m?.numBuys || 0),
      sells: Number(evaluation.token.stats5m?.numSells || 0),
    },
    tapeHistory: [{
      buys: Number(evaluation.token.stats5m?.numBuys || 0),
      sells: Number(evaluation.token.stats5m?.numSells || 0),
      timestamp: Date.now(),
    }],
    isSurvivalWait: true,
  };
  state.pendingCandidateRechecks.set(entry.mint, entry);
  return entry;
}

function postponeCandidateRecheck(entry, tokenSnapshot, errorMessage = '') {
  if (!entry?.mint) {
    return null;
  }

  const delayMs = chooseBorderlineRecheckDelayMs();
  const updatedEntry = {
    ...entry,
    tokenSnapshot: tokenSnapshot || entry.tokenSnapshot,
    lastTransientError: errorMessage || entry.lastTransientError || '',
    lastScheduledAt: new Date().toISOString(),
    nextEligibleAt: new Date(Date.now() + delayMs).toISOString(),
  };
  state.pendingCandidateRechecks.set(updatedEntry.mint, updatedEntry);
  return updatedEntry;
}

function getDueCandidateRechecks(now = Date.now()) {
  return Array.from(state.pendingCandidateRechecks.values())
    .filter((entry) => {
      const nextEligibleAt = entry?.nextEligibleAt ? new Date(entry.nextEligibleAt).getTime() : 0;
      return !nextEligibleAt || nextEligibleAt <= now;
    })
    .sort((left, right) => new Date(left.nextEligibleAt || 0).getTime() - new Date(right.nextEligibleAt || 0).getTime());
}

function refreshMarketSnapshots(recentLaunches) {
  const observedAt = new Date().toISOString();
  for (const token of recentLaunches) {
    if (!token?.id) {
      continue;
    }
    state.marketSnapshots.set(token.id, {
      liquidity: Number(token.liquidity || 0),
      usdPrice: Number(token.usdPrice || 0),
      launchpad: token.launchpad || null,
      observedAt,
    });
  }

  const now = Date.now();
  for (const [mint, snapshot] of state.marketSnapshots.entries()) {
    if (state.positions.has(mint) || state.pendingCandidateRechecks.has(mint)) {
      continue;
    }

    const observedAtMs = snapshot?.observedAt ? new Date(snapshot.observedAt).getTime() : 0;
    if (!observedAtMs || now - observedAtMs > MARKET_SNAPSHOT_RETENTION_MS) {
      state.marketSnapshots.delete(mint);
    }
  }
}

/**
 * Generates the take-profit configuration for a position.
 * The fraction is currently static (${TP_SELL_PERCENT}%), but multiples can be configured.
 */
function getTakeProfitPlan(candidateScore) {
  const isHighGrowthConfidence = Number(candidateScore || 0) >= config.highGrowthConfidenceScore;
  return {
    isHighGrowthConfidence,
    takeProfitMultiples: [...TAKE_PROFIT_MULTIPLES],
    takeProfitFractions: [TAKE_PROFIT_FRACTION],
  };
}

/**
 * Retrieves the sell fraction for a specific TP target index.
 */
function getTakeProfitFraction(position, targetIndex) {
  return TAKE_PROFIT_FRACTION;
}

function computeTakeProfitSellAmount(currentBalanceRaw, takeProfitFraction) {
  const basisPoints = Math.max(1, Math.round(takeProfitFraction * 10_000));
  return (currentBalanceRaw * BigInt(basisPoints)) / 10_000n;
}

function mergeLoopRequest(currentRequest, nextRequest) {
  if (!currentRequest) {
    return {
      ...nextRequest,
      websocketSignalMints: [...(nextRequest.websocketSignalMints || [])],
    };
  }

  return {
    reason:
      nextRequest.forceDiscovery && nextRequest.reason
        ? nextRequest.reason
        : currentRequest.reason || nextRequest.reason,
    forceDiscovery: currentRequest.forceDiscovery || nextRequest.forceDiscovery,
    skipMonitor: currentRequest.skipMonitor && nextRequest.skipMonitor,
    websocketSignalCount:
      Number(currentRequest.websocketSignalCount || 0) +
      Number(nextRequest.websocketSignalCount || 0),
    websocketSignalMints: Array.from(
      new Set([
        ...(currentRequest.websocketSignalMints || []),
        ...(nextRequest.websocketSignalMints || []),
      ])
    ).slice(0, 5),
  };
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

function isTransientOperationError(error) {
  const message = String(error?.message || '');
  return (
    isTransientFetchError(error) ||
    /blockhash not found|node is behind|429|rate limit|temporarily unavailable|timeout/i.test(message)
  );
}

function formatFetchError(url, error, timeoutMs) {
  if (isAbortError(error)) {
    return `Request timed out after ${timeoutMs}ms for ${url}`;
  }

  if (String(error?.message || '').includes(url)) {
    return error.message;
  }

  return `Request failed for ${url}: ${error.message}`;
}

function shouldRunDiscoveryScan(forceDiscovery = false) {
  if (forceDiscovery) {
    return true;
  }

  const discoveryIntervalMs =
    config.discoveryWsEnabled && discoveryState.websocketReady
      ? config.discoveryPollIntervalMs
      : config.scanIntervalMs;

  return lastDiscoveryScanAt === 0 || Date.now() - lastDiscoveryScanAt >= discoveryIntervalMs;
}

function pruneRecentSignalMints(now = Date.now()) {
  for (const [mint, seenAt] of discoveryState.recentSignalMints.entries()) {
    if (now - seenAt > DISCOVERY_SIGNAL_RETENTION_MS) {
      discoveryState.recentSignalMints.delete(mint);
    }
  }
}

function extractInitializedMints(parsedTransaction) {
  const mints = new Set();

  const collectFromInstructions = (instructions) => {
    if (!Array.isArray(instructions)) {
      return;
    }

    for (const instruction of instructions) {
      const parsed = instruction?.parsed;
      const type = String(parsed?.type || '').toLowerCase();
      const mint = parsed?.info?.mint;
      if ((type === 'initializemint' || type === 'initializemint2') && typeof mint === 'string') {
        mints.add(mint);
      }
    }
  };

  collectFromInstructions(parsedTransaction?.transaction?.message?.instructions);

  const innerInstructionGroups = parsedTransaction?.meta?.innerInstructions || [];
  for (const group of innerInstructionGroups) {
    collectFromInstructions(group?.instructions);
  }

  return Array.from(mints);
}

async function flushDiscoverySignals() {
  const signatures = Array.from(discoveryState.pendingSignatures);
  discoveryState.pendingSignatures.clear();

  if (signatures.length === 0 || shouldStop) {
    return;
  }

  const parsedTransactions = await Promise.all(
    signatures.map(async (signature) => {
      try {
        return await connection.getParsedTransaction(signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });
      } catch (error) {
        log(`Failed to hydrate websocket launch signal ${signature}: ${error.message}`, 'debug', { console: false });
        return null;
      }
    })
  );

  const now = Date.now();
  pruneRecentSignalMints(now);

  const pendingMints = [];
  for (const parsedTransaction of parsedTransactions) {
    for (const mint of extractInitializedMints(parsedTransaction)) {
      if (state.processedMints.has(mint)) {
        continue;
      }
      const lastSeenAt = discoveryState.recentSignalMints.get(mint) || 0;
      if (now - lastSeenAt < DISCOVERY_SIGNAL_RETENTION_MS) {
        continue;
      }
      discoveryState.recentSignalMints.set(mint, now);
      pendingMints.push(mint);
    }
  }

  if (pendingMints.length === 0) {
    return;
  }

  await runLoop({
    reason: 'ws-mint-init',
    forceDiscovery: true,
    skipMonitor: true,
    websocketSignalCount: pendingMints.length,
    websocketSignalMints: pendingMints.slice(0, 5),
  });
}

function scheduleDiscoverySignalFlush() {
  if (discoveryState.debounceTimer) {
    return;
  }

  discoveryState.debounceTimer = setTimeout(() => {
    discoveryState.debounceTimer = null;
    void flushDiscoverySignals();
  }, config.discoveryWsDebounceMs);
}

function handleDiscoveryProgramLog(logInfo) {
  if (!config.discoveryWsEnabled || shouldStop) {
    return;
  }
  if (!logInfo?.signature || !Array.isArray(logInfo.logs)) {
    return;
  }
  if (!logInfo.logs.some((line) => INITIALIZE_MINT_LOG_PATTERN.test(line))) {
    return;
  }

  discoveryState.pendingSignatures.add(logInfo.signature);
  scheduleDiscoverySignalFlush();
}

async function startDiscoveryWatchers() {
  if (!config.discoveryWsEnabled) {
    discoveryState.websocketReady = false;
    log('Discovery websocket watcher disabled; using poll-only launch discovery.');
    return;
  }

  if (!config.wsRpcUrl) {
    discoveryState.websocketReady = false;
    log('Discovery websocket watcher unavailable because no websocket RPC endpoint could be derived. Falling back to polling.', 'warn', { console: true });
    return;
  }

  try {
    for (const programId of SPL_TOKEN_PROGRAM_IDS) {
      const subscriptionId = await connection.onLogs(programId, handleDiscoveryProgramLog, 'confirmed');
      discoveryState.logSubscriptionIds.push(subscriptionId);
    }
    discoveryState.websocketReady = true;
    log(
      `Discovery websocket watcher armed on ${discoveryState.logSubscriptionIds.length} token program(s); backfill poll remains enabled every ${config.discoveryPollIntervalMs}ms.`
    );
  } catch (error) {
    discoveryState.websocketReady = false;
    log(`Failed to start discovery websocket watcher: ${error.message}. Falling back to polling.`, 'warn', { console: true });
    await stopDiscoveryWatchers();
  }
}

async function stopDiscoveryWatchers() {
  if (discoveryState.debounceTimer) {
    clearTimeout(discoveryState.debounceTimer);
    discoveryState.debounceTimer = null;
  }

  const subscriptionIds = [...discoveryState.logSubscriptionIds];
  discoveryState.logSubscriptionIds = [];
  discoveryState.pendingSignatures.clear();
  discoveryState.websocketReady = false;

  await Promise.all(
    subscriptionIds.map(async (subscriptionId) => {
      try {
        await connection.removeOnLogsListener(subscriptionId);
      } catch (error) {
        log(`Failed to remove websocket discovery listener ${subscriptionId}: ${error.message}`, 'debug', { console: false });
      }
    })
  );
}

async function fetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_FETCH_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_FETCH_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_FETCH_RETRY_DELAY_MS;
  const headers = {
    Accept: 'application/json',
    ...(options.headers || {}),
  };

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
        try {
          data = JSON.parse(text);
        } catch (error) {
          throw new Error(`Failed to parse JSON from ${url}: ${error.message}`);
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

  throw new Error(formatFetchError(url, lastError || new Error('Unknown fetch failure'), timeoutMs));
}

function jupiterHeaders() {
  return {
    'x-api-key': config.jupiterApiKey,
  };
}

function goPlusHeaders() {
  const headers = {};
  if (config.goPlusAccessToken) {
    headers.Authorization = `Bearer ${config.goPlusAccessToken}`;
  }
  return headers;
}

async function fetchRecentLaunches() {
  const url = `${config.jupiterBaseUrl}/tokens/v2/recent`;
  const data = await fetchJson(url, {
    headers: jupiterHeaders(),
  });

  if (!Array.isArray(data)) {
    throw new Error('Unexpected Jupiter recent response shape.');
  }

  return data;
}

async function fetchPrices(mints) {
  if (mints.length === 0) {
    return {};
  }

  const url = `${config.jupiterBaseUrl}/price/v3?ids=${encodeURIComponent(mints.join(','))}`;
  const data = await fetchJson(url, {
    headers: jupiterHeaders(),
  });

  if (!data || typeof data !== 'object') {
    throw new Error('Unexpected Jupiter price response shape.');
  }

  return data;
}

async function fetchPricesBestEffort(mints, contextLabel = 'price refresh') {
  if (mints.length === 0) {
    return {};
  }

  try {
    return await fetchPrices(mints);
  } catch (error) {
    log(`Batch ${contextLabel} failed for ${mints.length} mint(s): ${error.message}. Falling back to per-mint refresh.`, 'warn', { console: true });
  }

  const prices = {};
  await Promise.all(
    mints.map(async (mint) => {
      try {
        Object.assign(prices, await fetchPrices([mint]));
      } catch (error) {
        log(`Per-mint ${contextLabel} failed for ${mint}: ${error.message}`, 'debug', { console: false });
      }
    })
  );

  return prices;
}

async function fetchSwapOrder(inputMint, outputMint, amount) {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amount),
    taker: wallet.publicKey.toBase58(),
    slippageBps: String(config.slippageBps),
    swapMode: 'ExactIn',
  });

  const url = `${config.jupiterBaseUrl}/swap/v2/order?${params.toString()}`;
  const order = await fetchJson(url, {
    headers: jupiterHeaders(),
  });

  if (!order || typeof order !== 'object') {
    throw new Error('Unexpected Jupiter order response shape.');
  }

  if (!order.transaction) {
    throw new Error(order.errorMessage || order.error || 'Jupiter did not return a signable transaction.');
  }

  return order;
}

async function executeSwapOrder(order) {
  const transaction = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'));
  transaction.sign([wallet]);
  const serialized = transaction.serialize();
  const signature = await connection.sendRawTransaction(serialized, {
    skipPreflight: false,
    maxRetries: 3,
  });

  const confirmation = await connection.confirmTransaction(
    {
      signature,
      blockhash: transaction.message.recentBlockhash,
      lastValidBlockHeight: Number(order.lastValidBlockHeight),
    },
    'confirmed'
  );

  if (confirmation.value.err) {
    throw new Error(`Swap transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }

  return signature;
}

async function getWalletTokenBalance(mint) {
  if (config.paperTrading) {
    const position = state.positions.get(mint);
    const rawAmount = BigInt(position?.lastKnownBalanceRaw || '0');
    const decimals = Number(position?.decimals || 0);

    return {
      mint,
      rawAmount,
      decimals,
      uiAmount: Number(atomicToDecimalString(rawAmount, decimals, 9)),
    };
  }

  const response = await connection.getParsedTokenAccountsByOwner(
    wallet.publicKey,
    { mint: new PublicKey(mint) },
    'confirmed'
  );

  let rawAmount = 0n;
  let decimals = null;

  for (const accountInfo of response.value) {
    const parsedInfo = accountInfo.account.data?.parsed?.info;
    const tokenAmount = parsedInfo?.tokenAmount;
    if (!tokenAmount?.amount) {
      continue;
    }
    rawAmount += BigInt(tokenAmount.amount);
    decimals = tokenAmount.decimals;
  }

  return {
    mint,
    rawAmount,
    decimals: decimals === null ? 0 : decimals,
    uiAmount: Number(atomicToDecimalString(rawAmount, decimals === null ? 0 : decimals, 9)),
  };
}

async function getMintSignals(mint) {
  const parsedAccount = await connection.getParsedAccountInfo(new PublicKey(mint), 'confirmed');
  const parsed = parsedAccount.value?.data?.parsed;

  if (!parsed || parsed.type !== 'mint') {
    throw new Error(`Mint ${mint} did not return parsed mint data.`);
  }

  const mintInfo = parsed.info;
  const largestAccounts = await connection.getTokenLargestAccounts(new PublicKey(mint), 'confirmed');
  const supplyRaw = BigInt(mintInfo.supply || '0');
  const topAccounts = (largestAccounts.value || []).slice(0, 5).map((account) => {
    const rawAmount = BigInt(account.amount || '0');
    return {
      address: account.address,
      rawAmount,
      share: bigintRatioToNumber(rawAmount, supplyRaw),
    };
  });

  const top1Share = topAccounts[0]?.share || 0;
  const top5Share = topAccounts.reduce((sum, account) => sum + account.share, 0);
  const ownerDetails = await Promise.all(
    topAccounts.map(async (account) => {
      try {
        const ownerInfo = await connection.getParsedAccountInfo(new PublicKey(account.address), 'confirmed');
        const owner = ownerInfo.value?.data?.parsed?.info?.owner || null;
        return { ...account, owner };
      } catch (error) {
        return { ...account, owner: null, ownerLookupError: error.message };
      }
    })
  );

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

async function fetchGoPlusTokenSignals(mint) {
  if (!config.goPlusAccessToken) {
    return null;
  }

  try {
    const url = `${config.goPlusBaseUrl}/solana/token_security?contract_addresses=${encodeURIComponent(mint)}`;
    const payload = await fetchJson(url, {
      headers: goPlusHeaders(),
    });

    const record =
      payload?.result?.[mint] ||
      payload?.result?.[mint.toLowerCase()] ||
      payload?.data?.[mint] ||
      payload?.data?.[mint.toLowerCase()] ||
      null;

    if (!record) {
      return null;
    }

    const blockers = [];
    const notes = [];

    if (isTruthyFlag(record.is_mintable)) {
      blockers.push('GoPlus reports token is mintable');
    }
    if (isTruthyFlag(record.is_freezable)) {
      blockers.push('GoPlus reports token is freezable');
    }
    if (isTruthyFlag(record.transfer_fee_upgradable)) {
      notes.push('GoPlus reports transfer fee is upgradable');
    }
    if (isTruthyFlag(record.non_transferable)) {
      blockers.push('GoPlus reports token is non-transferable');
    }
    if (isTruthyFlag(record.default_account_state)) {
      notes.push('GoPlus reports custom default account state');
    }
    if (isTruthyFlag(record.trusted_token) === false && record.trusted_token !== undefined) {
      notes.push('GoPlus does not mark the token as trusted');
    }

    return {
      blockers,
      notes,
      raw: record,
    };
  } catch (error) {
    log(`GoPlus token security skipped for ${mint}: ${error.message}`, 'warn');
    return null;
  }
}

async function fetchGoPlusAddressSignals(addresses) {
  if (!config.goPlusAccessToken) {
    return [];
  }

  const results = [];
  for (const address of addresses) {
    try {
      const url = `${config.goPlusBaseUrl}/address_security/${address}?chain_id=solana`;
      const payload = await fetchJson(url, {
        headers: goPlusHeaders(),
      });
      const record =
        payload?.result?.[address] ||
        payload?.result?.[address.toLowerCase()] ||
        payload?.data?.[address] ||
        payload?.data?.[address.toLowerCase()] ||
        null;

      if (record && isMaliciousGoPlusAddressRecord(record)) {
        results.push({ address, record });
      }
    } catch (error) {
      log(`GoPlus address security skipped for ${address}: ${error.message}`, 'warn');
    }
  }
  return results;
}

function isMaliciousGoPlusAddressRecord(record) {
  return [
    'malicious_address',
    'phishing_activities',
    'fake_token',
    'blackmail_activities',
    'honeypot_related_address',
    'money_laundering',
    'mixer',
    'scam',
    'sanctioned',
  ].some((field) => isTruthyFlag(record[field]));
}

function isTruthyFlag(value) {
  if (value === undefined || value === null || value === '') {
    return false;
  }
  if (value === false || value === 0) {
    return false;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['0', 'false', 'null', 'none', 'no'].includes(normalized)) {
    return false;
  }
  return true;
}

async function fetchBubbleMapsSignals(mint) {
  if (!config.bubbleMapsApiKey) {
    return null;
  }

  try {
    const params = new URLSearchParams({
      return_clusters: 'true',
      return_decentralization_score: 'true',
      return_nodes: 'false',
      use_magic_nodes: 'true',
    });

    const url = `${config.bubbleMapsBaseUrl}/maps/solana/${mint}?${params.toString()}`;
    const payload = await fetchJson(url, {
      headers: {
        'X-ApiKey': config.bubbleMapsApiKey,
      },
      timeoutMs: 25000,
    });

    const largestClusterShare = Array.isArray(payload?.clusters) && payload.clusters.length > 0
      ? Number(payload.clusters[0].share || 0)
      : null;

    const blockers = [];
    if (payload?.decentralization_score !== null && payload?.decentralization_score !== undefined) {
      if (Number(payload.decentralization_score) < config.minBubbleMapsScore) {
        blockers.push(`BubbleMaps decentralization score ${payload.decentralization_score} is below ${config.minBubbleMapsScore}`);
      }
    }
    if (largestClusterShare !== null && largestClusterShare > config.maxBubbleMapsLargestClusterShare) {
      blockers.push(
        `BubbleMaps largest cluster share ${ratioToPercentString(largestClusterShare)} is above ${ratioToPercentString(config.maxBubbleMapsLargestClusterShare)}`
      );
    }

    return {
      blockers,
      score: payload?.decentralization_score ?? null,
      largestClusterShare,
      raw: payload,
    };
  } catch (error) {
    log(`BubbleMaps skipped for ${mint}: ${error.message}`, 'warn');
    return null;
  }
}

function countSocialLinks(token) {
  return ['website', 'twitter', 'telegram'].reduce((count, key) => count + (token[key] ? 1 : 0), 0);
}

function looksLikeMemecoin(token) {
  const text = `${token.name || ''} ${token.symbol || ''}`.toLowerCase();
  if (token.launchpad) {
    return true;
  }
  if (config.memeKeywords.some((keyword) => text.includes(keyword))) {
    return true;
  }
  if (Number.isFinite(token.fdv) && token.fdv > 0 && token.fdv <= config.maxMemeFdvUsd) {
    return true;
  }
  return false;
}

async function evaluateCandidate(token, highestSeenPriceUsd = null, priceHistory = [], priceAtStartOfDelay = null, liquidityAtStartOfDelay = null, tapeAtStart = null, tapeHistory = []) {
  const blockers = [];
  const rejectionReasons = [];
  const notes = [];
  const now = Date.now();
  const firstPoolCreatedAt = token.firstPool?.createdAt ? new Date(token.firstPool.createdAt).getTime() : null;
  const ageSeconds = firstPoolCreatedAt ? Math.floor((now - firstPoolCreatedAt) / 1000) : null;
  const socialLinks = countSocialLinks(token);
  const launchpadProfile = getLaunchpadProfile(token.launchpad);
  const thresholds = getLaunchpadAdjustedThresholds(launchpadProfile);
  const entryScore = computeCandidateScore(token, launchpadProfile, thresholds, socialLinks, ageSeconds);
  const addBlocker = (message, code = 'other', recheckEligible = false) => {
    blockers.push(message);
    rejectionReasons.push({
      code,
      recheckEligible,
    });
  };

  if (liquidityAtStartOfDelay !== null && liquidityAtStartOfDelay > 0) {
    const currentLiquidity = Number(token.liquidity || 0);
    const liqDropRatio = 1 - (currentLiquidity / liquidityAtStartOfDelay);
    // Liquidity Trend Filter: Reject if liquidity is draining (default > 15% drop)
    if (liqDropRatio > config.maxLiquidityDrawdownPct / 100) {
      addBlocker(
        `Liquidity is draining: ${formatUsd(currentLiquidity)} is ${ratioToPercentString(liqDropRatio)} below start ${formatUsd(liquidityAtStartOfDelay)}.`,
        'liquidity-draining'
      );
    }
  }

  if (priceAtStartOfDelay !== null && priceAtStartOfDelay > 0) {
    const currentPrice = Number(token.usdPrice || 0);
    const momentum = currentPrice / priceAtStartOfDelay;
    
    // Parabolic Cap: Reject if token grew too much during 30s delay (default > 150%)
    const growthPct = (momentum - 1) * 100;
    if (growthPct > config.maxSurvivalGrowthPct) {
      addBlocker(
        `Parabolic growth detected: ${growthPct.toFixed(1)}% exceeds limit of ${config.maxSurvivalGrowthPct}%.`,
        'parabolic-growth'
      );
    }

    // Survival Momentum Check: Ensure token grew since discovery (default > 5%)
    if (momentum < config.minSurvivalMomentum) {
      addBlocker(
        `Survival momentum failed: ${momentum.toFixed(3)}x is below required ${config.minSurvivalMomentum}x.`,
        'low-survival-momentum'
      );
    }

    // --- Momentum Quality Engine (Exhaustion Detection 2.0) ---

    if (Array.isArray(priceHistory) && priceHistory.length >= 6) {
      const startTime = priceHistory[0].timestamp;
      const totalDuration = now - startTime;

      if (totalDuration >= 20000) { // Only run advanced checks if we have at least 20s of data
        // A. Acceleration Stability (The Stall Filter)
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
            addBlocker(
              `Momentum stalling (Stall Filter): segment 3 growth (${(growthS3 * 100).toFixed(1)}%) is too low vs segment 1 (${(growthS1 * 100).toFixed(1)}%). factor=${stabilityFactor.toFixed(2)}`,
              'momentum-stalling'
            );
          }
        }

        // B. Buy Velocity Decay (The Tape Filter)
        if (Array.isArray(tapeHistory) && tapeHistory.length >= 2) {
          const midPointTime = startTime + totalDuration / 2;
          const tapeAtStartSnapshot = tapeHistory[0];
          const tapeAtMidSnapshot = tapeHistory.find(t => t.timestamp >= midPointTime) || tapeHistory[Math.floor(tapeHistory.length / 2)];
          
          const buysFirstHalf = tapeAtMidSnapshot.buys - tapeAtStartSnapshot.buys;
          const buysSecondHalf = Number(token.stats5m?.numBuys || 0) - tapeAtMidSnapshot.buys;
          
          if (buysFirstHalf > 5 && buysSecondHalf < buysFirstHalf * 0.7) {
            addBlocker(
              `Buy velocity decay (Tape Filter): second-half buys (${buysSecondHalf}) dropped significantly vs first-half (${buysFirstHalf}).`,
              'buy-velocity-decay'
            );
          }
        }

        // C. Flatline/Exhaustion Detection
        const midPointTime = startTime + totalDuration / 2;
        const pMid = priceHistory.find(h => h.timestamp >= midPointTime)?.price || currentPrice;
        const growthFirstHalf = (pMid - pStart) / pStart;
        
        if (growthFirstHalf > 0.20) {
          // Check range of last 8-10 snapshots
          const recentSnapshots = priceHistory.slice(-8);
          if (recentSnapshots.length >= 5) {
            const prices = recentSnapshots.map(s => s.price).concat(currentPrice);
            const minP = Math.min(...prices);
            const maxP = Math.max(...prices);
            const rangePct = ((maxP - minP) / minP) * 100;
            
            if (rangePct < 1.0) {
              addBlocker(
                `Price exhaustion (Flatline Filter): vertical spike followed by stagnant range (${rangePct.toFixed(2)}%) at the peak.`,
                'price-exhaustion'
              );
            }
          }
        }

        // D. Momentum Consistency
        const snapshots = priceHistory.concat({ price: currentPrice, timestamp: now });
        let greenSnapshots = 0;
        for (let i = 1; i < snapshots.length; i++) {
          if (snapshots[i].price > snapshots[i - 1].price) {
            greenSnapshots++;
          }
        }
        const consistencyRatio = greenSnapshots / (snapshots.length - 1);
        if (consistencyRatio < 0.6) {
          addBlocker(
            `Choppy momentum: only ${(consistencyRatio * 100).toFixed(1)}% of snapshots were green (min 60% required).`,
            'choppy-momentum'
          );
        }
      }
    }
  }

  if (highestSeenPriceUsd !== null && highestSeenPriceUsd > 0) {
    const currentPrice = Number(token.usdPrice || 0);
    const dropRatio = 1 - currentPrice / highestSeenPriceUsd;
    // Anti-Dump Check: Ensure price didn't crash from its discovery-period peak
    if (dropRatio > config.maxPriceDumpPct / 100) {
      addBlocker(
        `Price is dumping: ${formatUsd(currentPrice)} is ${ratioToPercentString(dropRatio)} below peak ${formatUsd(highestSeenPriceUsd)}.`,
        'price-dumping'
      );
    }
  }

  // Sell-Pressure Check
  if (tapeAtStart) {
    const currentBuys = Number(token.stats5m?.numBuys || 0);
    const currentSells = Number(token.stats5m?.numSells || 0);
    const buysDelta = currentBuys - tapeAtStart.buys;
    const sellsDelta = currentSells - tapeAtStart.sells;
    
    if (sellsDelta > 0) {
      const sellRatio = sellsDelta / (buysDelta || 1);
      const sellPressureIncrease = (sellsDelta / (tapeAtStart.sells || 1)) * 100;
      
      if (sellRatio > 0.8 && sellPressureIncrease > config.maxSellPressureIncreasePct) {
        addBlocker(
          `High selling pressure: Sells increased by ${sellPressureIncrease.toFixed(1)}% during delay (Sell/Buy ratio: ${sellRatio.toFixed(2)}).`,
          'high-sell-pressure'
        );
      }
    }
  }

  if (!looksLikeMemecoin(token)) {
    addBlocker('Does not match the configured memecoin launch heuristic.', 'not-memecoin');
  }
  if (!token.usdPrice || Number(token.usdPrice) <= 0) {
    addBlocker('No Jupiter USD price available.', 'missing-price');
  }
  if (!Number.isFinite(token.liquidity) || token.liquidity < thresholds.minLiquidityUsd) {
    addBlocker(
      `Liquidity ${formatUsd(token.liquidity)} is below ${formatUsd(thresholds.minLiquidityUsd)} for ${launchpadProfile.name}.`,
      'low-liquidity',
      isSlightlyBelowThreshold(Number(token.liquidity || 0), thresholds.minLiquidityUsd)
    );
  }
  if (!Number.isFinite(token.holderCount) || token.holderCount < thresholds.minHolderCount) {
    addBlocker(
      `Holder count ${token.holderCount || 0} is below ${Math.ceil(thresholds.minHolderCount)} for ${launchpadProfile.name}.`,
      'low-holders',
      isSlightlyBelowThreshold(Number(token.holderCount || 0), thresholds.minHolderCount)
    );
  }
  if (!Number.isFinite(token.organicScore) || token.organicScore < config.minOrganicScore) {
    addBlocker(`Organic score ${token.organicScore || 0} is below ${config.minOrganicScore}.`, 'low-organic-score');
  }
  if ((token.stats5m?.numBuys || 0) < thresholds.minBuys5m) {
    addBlocker(
      `5m buy count ${(token.stats5m?.numBuys || 0)} is below ${thresholds.minBuys5m} for ${launchpadProfile.name}.`,
      'low-buys',
      isSlightlyBelowThreshold(Number(token.stats5m?.numBuys || 0), thresholds.minBuys5m)
    );
  }
  if (socialLinks < config.minSocialLinks) {
    addBlocker(`Only ${socialLinks} social links found; minimum is ${config.minSocialLinks}.`, 'low-social-links');
  }
  if (!config.allowVerifiedTokens && token.isVerified) {
    addBlocker('Verified tokens are disabled by configuration.', 'verified-token-disabled');
  }

  if (ageSeconds !== null) {
    if (ageSeconds < thresholds.minPoolAgeSeconds) {
      addBlocker(
        `Pool age ${ageSeconds}s is below ${thresholds.minPoolAgeSeconds}s for ${launchpadProfile.name}.`,
        'too-new',
        true
      );
    }
    if (ageSeconds > config.maxCandidateAgeMinutes * 60) {
      addBlocker(`Pool age ${(ageSeconds / 60).toFixed(1)}m exceeds ${config.maxCandidateAgeMinutes}m.`, 'too-old');
    }
  } else {
    notes.push('Missing firstPool.createdAt from Jupiter recent feed.');
  }

  if (Number.isFinite(token.fdv) && Number.isFinite(token.liquidity) && token.liquidity > 0) {
    const fdvToLiquidity = token.fdv / token.liquidity;
    if (fdvToLiquidity > config.maxFdvToLiquidity) {
      addBlocker(`FDV/liquidity ratio ${fdvToLiquidity.toFixed(2)} exceeds ${config.maxFdvToLiquidity}.`, 'fdv-liquidity-too-high');
    }
  }

  if (token.audit?.isSus === true) {
    addBlocker('Jupiter audit marked the token as suspicious.', 'audit-suspicious');
  }
  if (token.audit?.mintAuthorityDisabled === false) {
    addBlocker('Jupiter audit shows mint authority is still enabled.', 'audit-mint-authority');
  }
  if (token.audit?.freezeAuthorityDisabled === false) {
    addBlocker('Jupiter audit shows freeze authority is still enabled.', 'audit-freeze-authority');
  }
  if (Number.isFinite(token.audit?.topHoldersPercentage) && token.audit.topHoldersPercentage > config.maxAuditTopHoldersPct) {
    addBlocker(
      `Jupiter audit top holders percentage ${token.audit.topHoldersPercentage.toFixed(2)}% exceeds ${config.maxAuditTopHoldersPct}%.`,
      'audit-top-holders'
    );
  }
  if (!token.isVerified) {
    notes.push('Token is not Jupiter-verified.');
  }
  if (token.launchpad) {
    notes.push(`Launchpad: ${token.launchpad}`);
  }
  notes.push(`Entry score ${entryScore}/100 via ${launchpadProfile.name} profile.`);

  const mintSignals = await getMintSignals(token.id);
  if (mintSignals.mintAuthority) {
    addBlocker(`On-chain mint authority is still set: ${mintSignals.mintAuthority}`, 'mint-authority-enabled');
  }
  if (mintSignals.freezeAuthority) {
    addBlocker(`On-chain freeze authority is still set: ${mintSignals.freezeAuthority}`, 'freeze-authority-enabled');
  }
  if (mintSignals.top1Share > config.maxTokenAccountTop1Pct / 100) {
    addBlocker(
      `Largest token account holds ${ratioToPercentString(mintSignals.top1Share)}, above ${config.maxTokenAccountTop1Pct.toFixed(2)}%.`,
      'top1-concentration'
    );
  }
  if (mintSignals.top5Share > config.maxTokenAccountTop5Pct / 100) {
    addBlocker(
      `Top 5 token accounts hold ${ratioToPercentString(mintSignals.top5Share)}, above ${config.maxTokenAccountTop5Pct.toFixed(2)}%.`,
      'top5-concentration'
    );
  }

  const ownerAddresses = Array.from(
    new Set(
      mintSignals.topAccounts
        .map((account) => account.owner)
        .filter((owner) => owner && !BURN_OWNERS.has(owner))
    )
  );

  const goPlusTokenSignals = await fetchGoPlusTokenSignals(token.id);
  if (goPlusTokenSignals) {
    for (const blocker of goPlusTokenSignals.blockers) {
      addBlocker(blocker, 'goplus-token-signal');
    }
    notes.push(...goPlusTokenSignals.notes);
  }

  const maliciousAddresses = ownerAddresses.length > 0 ? await fetchGoPlusAddressSignals(ownerAddresses) : [];
  if (maliciousAddresses.length > 0) {
    addBlocker(`GoPlus flagged top-holder owners as malicious: ${maliciousAddresses.map((item) => item.address).join(', ')}`, 'goplus-malicious-owner');
  }

  const bubbleMapsSignals = await fetchBubbleMapsSignals(token.id);
  if (bubbleMapsSignals) {
    for (const blocker of bubbleMapsSignals.blockers) {
      addBlocker(blocker, 'bubblemaps-signal');
    }
    if (bubbleMapsSignals.score !== null) {
      notes.push(`BubbleMaps decentralization score: ${bubbleMapsSignals.score}`);
    }
  }

  if (entryScore < config.minCandidateScore) {
    addBlocker(`Entry score ${entryScore}/100 is below ${config.minCandidateScore}.`, 'entry-score-too-low');
  }

  // Price-Distance Filter (Idea 3)
  const retiredInfo = state.retiredMints.get(token.id);
  if (retiredInfo) {
    const lastExitPrice = Number(retiredInfo.lastExitPriceUsd || 0);
    const currentPrice = Number(token.usdPrice || 0);
    
    if (lastExitPrice > 0 && currentPrice > 0) {
      const diffPct = ((currentPrice - lastExitPrice) / lastExitPrice) * 100;
      const isDip = diffPct <= -config.reentryDipPct;
      const isBreakout = diffPct >= config.reentryBreakoutPct;
      
      if (!isDip && !isBreakout) {
        addBlocker(
          `Price distance check failed: ${diffPct.toFixed(2)}% change is within avoid range (-${config.reentryDipPct}% to +${config.reentryBreakoutPct}%).`,
          'price-distance-gate'
        );
      } else {
        notes.push(`Price distance check passed: ${diffPct.toFixed(2)}% change vs previous exit ${formatUsd(lastExitPrice)}.`);
      }
    }
  }

  return {
    approved: blockers.length === 0,
    blockers,
    rejectionReasons,
    notes,
    candidateScore: entryScore,
    launchpadProfile,
    adjustedThresholds: thresholds,
    token,
    mintSignals,
    goPlusTokenSignals,
    bubbleMapsSignals,
  };
}

async function buyCandidate(evaluation) {
  const { token, candidateScore } = evaluation;
  const estimatedDecimals = Number(token.decimals || evaluation.mintSignals.decimals || 0);
  const takeProfitPlan = getTakeProfitPlan(candidateScore);

  const mood = getMoodAdjustments();
  if (mood.isPaused) {
    log(`Buy skipped for ${token.symbol}: Trading is currently paused by Daily Mood Detector.`, 'warn');
    return null;
  }

  const baseBuyAmountLamports = BigInt(config.buyAmountLamports);
  const adjustedBuyAmountLamports = (baseBuyAmountLamports * BigInt(Math.round(mood.sizeMultiplier * 100))) / 100n;
  const buyAmountSolText = atomicToDecimalString(adjustedBuyAmountLamports, 9, 6);

  if (config.paperTrading) {
    const paperQuote = await buildPaperBuyQuote(token, estimatedDecimals, adjustedBuyAmountLamports);
    const quotedOutAmount = paperQuote.outAmount;
    const entryUsdValue = paperQuote.entryUsdValue;
    const quotedEntryPriceUsd = paperQuote.entryPriceUsd;

    if (BigInt(state.paperSolBalanceLamports) < adjustedBuyAmountLamports) {
      log(
        `Paper wallet has insufficient SOL. Balance=${atomicToDecimalString(state.paperSolBalanceLamports, 9, 6)} SOL, required=${buyAmountSolText} SOL.`,
        'warn'
      );
      return null;
    }

    state.paperSolBalanceLamports = (BigInt(state.paperSolBalanceLamports) - adjustedBuyAmountLamports).toString();
    const paperPosition = {
      mint: token.id,
      symbol: token.symbol,
      name: token.name,
      decimals: estimatedDecimals,
      openedAt: new Date().toISOString(),
      mode: 'paper',
      entryPriceUsd: quotedEntryPriceUsd,
      entryUsdValue,
      initialBuyAmountSol: buyAmountSolText,
      initialBuyAmountLamports: adjustedBuyAmountLamports.toString(),
      initialTokenAmountRaw: quotedOutAmount.toString(),
      targetsHit: 0,
      takeProfitMultiples: takeProfitPlan.takeProfitMultiples,
      takeProfitFractions: takeProfitPlan.takeProfitFractions,
      highGrowthConfidence: takeProfitPlan.isHighGrowthConfidence,
      lastKnownBalanceRaw: quotedOutAmount.toString(),
      lastKnownPriceUsd: Number(token.usdPrice || 0),
      highestPriceUsd: quotedEntryPriceUsd,
      remainingCostUsd: entryUsdValue,
      realizedPnlUsd: 0,
      realizedProceedsUsd: 0,
      entryLiquidityUsd: Number(token.liquidity || 0),
      lastKnownLiquidityUsd: Number(token.liquidity || 0),
      launchpad: token.launchpad || null,
      entryScore: candidateScore,
      paperEntryQuoteOutAmount: quotedOutAmount.toString(),
      minTpReached: false,
      minTpFirstReachedAt: null,
      minTpArmed: false,
    };

    state.positions.set(token.id, paperPosition);
    paperAnalytics.totalBuys += 1;
    paperAnalytics.totalInvestedUsd += entryUsdValue;
    writePaperTradeEvent({
      type: 'buy',
      mint: token.id,
      symbol: token.symbol || null,
      launchpad: token.launchpad || null,
      entryUsdValue,
      entryPriceUsd: quotedEntryPriceUsd,
      tokenAmountRaw: quotedOutAmount.toString(),
      candidateScore: candidateScore,
    });
    persistPaperAnalytics();
    persistState();
    log(
      `PAPER buy ${token.symbol} (${token.id}) for ${buyAmountSolText} SOL (score ${candidateScore}, mood x${mood.sizeMultiplier}). Quoted tokens ${atomicToDecimalString(quotedOutAmount, estimatedDecimals, 6)}. TP ladder ${takeProfitPlan.takeProfitFractions.map((fraction) => `${Math.round(fraction * 100)}%@${takeProfitPlan.takeProfitMultiples[0]}x`).join(', ')}. Paper SOL left ${atomicToDecimalString(state.paperSolBalanceLamports, 9, 6)}.`,
      'trade'
    );
    return paperPosition;
  }

  const order = await fetchSwapOrder(SOL_MINT, token.id, adjustedBuyAmountLamports.toString());
  const quotedOutAmount = BigInt(order.outAmount || '0');
  const entryUsdValue = Number(order.inUsdValue || 0) > 0
    ? Number(order.inUsdValue)
    : await estimateSolUsdValue(adjustedBuyAmountLamports);
  const quotedTokenUnits = Number(atomicToDecimalString(quotedOutAmount, estimatedDecimals, 9));
  const quotedEntryPriceUsd = quotedTokenUnits > 0 ? entryUsdValue / quotedTokenUnits : Number(token.usdPrice || 0);

  const beforeBalance = await getWalletTokenBalance(token.id);

  if (config.dryRun) {
    log(
      `DRY_RUN would buy ${token.symbol} (${token.id}) with ${buyAmountSolText} SOL (score ${candidateScore}, mood x${mood.sizeMultiplier}). Quote outAmount=${order.outAmount}.`,
      'trade'
    );
    return null;
  }

  const signature = await executeSwapOrder(order);
  await sleep(2000);
  const afterBalance = await getWalletTokenBalance(token.id);
  const receivedRaw = afterBalance.rawAmount - beforeBalance.rawAmount;
  const receivedAmount = receivedRaw > 0n ? receivedRaw : BigInt(order.outAmount || '0');

  if (receivedAmount <= 0n) {
    throw new Error(`Buy succeeded on-chain (${signature}) but token balance delta was zero.`);
  }

  const decimals = afterBalance.decimals || estimatedDecimals;
  const tokenUnits = Number(atomicToDecimalString(receivedAmount, decimals, 9));
  const entryPriceUsd = tokenUnits > 0 ? entryUsdValue / tokenUnits : quotedEntryPriceUsd;

  const position = {
    mint: token.id,
    symbol: token.symbol,
    name: token.name,
    decimals,
    openedAt: new Date().toISOString(),
    mode: 'live',
    entryPriceUsd,
    entryUsdValue,
    initialBuyAmountSol: buyAmountSolText,
    initialBuyAmountLamports: adjustedBuyAmountLamports.toString(),
    initialTokenAmountRaw: receivedAmount.toString(),
    targetsHit: 0,
    takeProfitMultiples: takeProfitPlan.takeProfitMultiples,
    takeProfitFractions: takeProfitPlan.takeProfitFractions,
    highGrowthConfidence: takeProfitPlan.isHighGrowthConfidence,
    lastKnownBalanceRaw: afterBalance.rawAmount.toString(),
    lastKnownPriceUsd: Number(token.usdPrice || 0),
    highestPriceUsd: entryPriceUsd,
    remainingCostUsd: entryUsdValue,
    realizedPnlUsd: 0,
    realizedProceedsUsd: 0,
    entryLiquidityUsd: Number(token.liquidity || 0),
    lastKnownLiquidityUsd: Number(token.liquidity || 0),
    launchpad: token.launchpad || null,
    entryScore: candidateScore,
    buySignature: signature,
    minTpReached: false,
    minTpFirstReachedAt: null,
    minTpArmed: false,
  };

  state.positions.set(token.id, position);
  persistState();

  log(
    `Bought ${token.symbol} (${token.id}) for ${buyAmountSolText} SOL (score ${candidateScore}, mood x${mood.sizeMultiplier}) in tx ${signature}. Entry price ${formatUsd(entryPriceUsd)} with ${atomicToDecimalString(receivedAmount, decimals, 6)} tokens.`,
    'trade'
  );
  return position;
}

async function estimateSolUsdValue(amountLamports) {
  const prices = await fetchPrices([SOL_MINT]);
  const solPrice = Number(prices[SOL_MINT]?.usdPrice || 0);
  const amountSol = Number(atomicToDecimalString(amountLamports, 9, 9));
  return solPrice * amountSol;
}

async function estimateSolUsdPrice() {
  const prices = await fetchPrices([SOL_MINT]);
  const solPrice = Number(prices[SOL_MINT]?.usdPrice || 0);
  if (!(solPrice > 0)) {
    throw new Error('No SOL USD price available for paper trading.');
  }
  return solPrice;
}

function applyPaperSlippage(rawAmount) {
  const multiplierBps = BigInt(Math.max(0, 10_000 - config.slippageBps));
  return (rawAmount * multiplierBps) / 10_000n;
}

async function buildPaperBuyQuote(token, decimals, buyAmountLamports) {
  const tokenPriceUsd = Number(token.usdPrice || 0);
  if (!(tokenPriceUsd > 0)) {
    throw new Error(`No USD price available for paper buy of ${token.symbol || token.id}.`);
  }

  const entryUsdValue = await estimateSolUsdValue(buyAmountLamports);
  const estimatedTokenUnits = entryUsdValue / tokenPriceUsd;
  const rawTokenAmount = BigInt(decimalToAtomic(estimatedTokenUnits.toFixed(Math.min(decimals, 9)), decimals));
  const outAmount = applyPaperSlippage(rawTokenAmount);

  if (outAmount <= 0n) {
    throw new Error(`Paper buy quote for ${token.symbol || token.id} rounded to zero.`);
  }

  return {
    outAmount,
    entryUsdValue,
    entryPriceUsd: tokenPriceUsd,
  };
}

async function buildPaperSellQuote(rawTokenAmount, tokenPriceUsd, tokenDecimals) {
  if (!(tokenPriceUsd > 0)) {
    throw new Error('No USD price available for paper sell.');
  }

  const solPriceUsd = await estimateSolUsdPrice();
  const tokenUnits = Number(atomicToDecimalString(rawTokenAmount, tokenDecimals, 9));
  const grossUsdValue = tokenUnits * tokenPriceUsd;
  const rawLamports = BigInt(decimalToAtomic((grossUsdValue / solPriceUsd).toFixed(9), 9));
  const outAmount = applyPaperSlippage(rawLamports);

  if (outAmount <= 0n) {
    throw new Error('Paper sell quote rounded to zero.');
  }

  return {
    outAmount,
    grossUsdValue,
  };
}

function buildExitAccounting(position, sellRawAmount, currentBalanceRaw, proceedsUsd) {
  const sellRatio = bigintRatioToNumber(sellRawAmount, currentBalanceRaw);
  const costBasisSold = Number(position.remainingCostUsd || 0) * sellRatio;
  const realizedPnlUsd = proceedsUsd - costBasisSold;
  return {
    realizedPnlUsd,
    remainingCostUsd: Math.max(0, Number(position.remainingCostUsd || 0) - costBasisSold),
  };
}

async function executePositionExit(position, currentBalance, currentPriceUsd, sellRawAmount, exitReason, targetMultiple = null) {
  if (sellRawAmount <= 0n) {
    log(`Skipping ${exitReason} for ${position.symbol}; sell amount rounded to zero.`, 'warn');
    return false;
  }

  if (config.paperTrading) {
    const paperQuote = await buildPaperSellQuote(sellRawAmount, currentPriceUsd, position.decimals);
    const quotedSolOut = paperQuote.outAmount;
    const remainingBalanceRaw = currentBalance.rawAmount - sellRawAmount;
    const accounting = buildExitAccounting(position, sellRawAmount, currentBalance.rawAmount, paperQuote.grossUsdValue);

    state.paperSolBalanceLamports = (BigInt(state.paperSolBalanceLamports) + quotedSolOut).toString();
    if (exitReason.startsWith('take-profit')) {
      position.targetsHit += 1;
    }
    position.lastTakeProfitAt = new Date().toISOString();
    position.lastTakeProfitMultiple = targetMultiple;
    position.lastKnownBalanceRaw = remainingBalanceRaw.toString();
    position.lastKnownPriceUsd = currentPriceUsd;
    position.remainingCostUsd = accounting.remainingCostUsd;
    position.realizedPnlUsd = Number(position.realizedPnlUsd || 0) + accounting.realizedPnlUsd;
    position.realizedProceedsUsd = Number(position.realizedProceedsUsd || 0) + paperQuote.grossUsdValue;
    position.lastExitReason = exitReason;
    position.paperLastQuotedSolOutLamports = quotedSolOut.toString();

    if (remainingBalanceRaw > 0n) {
      state.positions.set(position.mint, position);
    } else {
      state.positions.delete(position.mint);
      updatePaperClosedPositionStats(position);
      // Record result for Mood Detector
      const totalPnl = Number(position.realizedPnlUsd || 0);
      recordTradeResult(totalPnl > 0);
    }

    writePaperTradeEvent({
      type: 'sell',
      exitReason,
      mint: position.mint,
      symbol: position.symbol,
      reason: exitReason,
      targetMultiple,
      currentPriceUsd,
      sellAmountRaw: sellRawAmount.toString(),
      proceedsUsd: paperQuote.grossUsdValue,
      realizedPnlUsd: accounting.realizedPnlUsd,
      remainingBalanceRaw: remainingBalanceRaw.toString(),
    });

    persistPaperAnalytics();
    persistState();
    log(
      `PAPER ${exitReason} on ${position.symbol}. Quoted SOL out ${atomicToDecimalString(quotedSolOut, 9, 6)}. Paper SOL now ${atomicToDecimalString(state.paperSolBalanceLamports, 9, 6)}.`,
      'trade'
    );
    return true;
  }

  const order = await fetchSwapOrder(position.mint, SOL_MINT, sellRawAmount.toString());

  if (config.dryRun) {
    const currentBalanceRaw = currentBalance?.rawAmount || 0n;
    const sellSharePct = currentBalanceRaw > 0n
      ? (bigintRatioToNumber(sellRawAmount, currentBalanceRaw) * 100).toFixed(2)
      : '0.00';
    const exitDescriptor =
      exitReason.startsWith('take-profit') && targetMultiple
        ? `at ${targetMultiple}x`
        : `for ${exitReason}`;
    log(
      `DRY_RUN would sell ${sellSharePct}% of ${position.symbol} (${atomicToDecimalString(sellRawAmount, position.decimals, 6)} tokens) ${exitDescriptor}.`,
      'trade'
    );
    return false;
  }

  const signature = await executeSwapOrder(order);
  await sleep(2000);
  const updatedBalance = await getWalletTokenBalance(position.mint);
  const sellUnits = Number(atomicToDecimalString(sellRawAmount, position.decimals, 9));
  const proceedsUsd = sellUnits * currentPriceUsd;
  const accounting = buildExitAccounting(position, sellRawAmount, currentBalance.rawAmount, proceedsUsd);

  if (exitReason.startsWith('take-profit')) {
    position.targetsHit += 1;
  }
  position.lastTakeProfitAt = new Date().toISOString();
  position.lastTakeProfitMultiple = targetMultiple;
  position.lastKnownBalanceRaw = updatedBalance.rawAmount.toString();
  position.lastKnownPriceUsd = currentPriceUsd;
  position.remainingCostUsd = accounting.remainingCostUsd;
  position.realizedPnlUsd = Number(position.realizedPnlUsd || 0) + accounting.realizedPnlUsd;
  position.realizedProceedsUsd = Number(position.realizedProceedsUsd || 0) + proceedsUsd;
  position.lastExitReason = exitReason;
  position.lastSellSignature = signature;

  const totalTargets = Array.isArray(position.takeProfitMultiples) ? position.takeProfitMultiples.length : TAKE_PROFIT_MULTIPLES.length;
  if (position.targetsHit >= totalTargets || updatedBalance.rawAmount <= 0n) {
    if (updatedBalance.rawAmount <= 0n) {
      state.positions.delete(position.mint);
      // Record result for Mood Detector
      const totalPnl = Number(position.realizedPnlUsd || 0);
      recordTradeResult(totalPnl > 0);
      notePaperExitReason(exitReason);
      // Trigger Cool-down and Price-Distance Tracking
      startCoolDown(position.mint, currentPriceUsd);
    } else {
      state.positions.set(position.mint, position);
    }
  } else {
    state.positions.set(position.mint, position);
  }

  persistState();
  log(
    `Sold ${position.symbol} for ${exitReason} in tx ${signature}. Remaining balance ${atomicToDecimalString(updatedBalance.rawAmount, position.decimals, 6)}.`,
    'trade'
  );
  return true;
}

async function sellTakeProfit(position, currentBalance, currentPriceUsd, targetMultiple) {
  const targetIndex = Number(position.targetsHit || 0);
  const takeProfitFraction = getTakeProfitFraction(position, targetIndex);
  const sellAmount = computeTakeProfitSellAmount(currentBalance.rawAmount, takeProfitFraction);

  return executePositionExit(
    position,
    currentBalance,
    currentPriceUsd,
    sellAmount,
    `take-profit-${targetMultiple}x`,
    targetMultiple
  );
}

async function closeAllOpenPositions(exitReason = 'shutdown-exit') {
  const openMints = Array.from(state.positions.keys());
  if (openMints.length === 0) {
    log('Shutdown requested with no open positions to close.');
    return;
  }

  log(`Shutdown requested; attempting to close ${openMints.length} open position(s) before exit.`, 'warn', { console: true });

  const prices = await fetchPricesBestEffort(openMints, 'shutdown exit price refresh');

  let closedCount = 0;
  let failedCount = 0;

  for (const mint of openMints) {
    const position = state.positions.get(mint);
    if (!position) {
      continue;
    }

    try {
      const currentBalance = await getWalletTokenBalance(mint);
      if (currentBalance.rawAmount <= 0n) {
        state.positions.delete(mint);
        persistState();
        log(`Removed ${position.symbol || mint} during shutdown because wallet balance is already zero.`, 'warn');
        continue;
      }

      let currentPriceUsd = Number(
        prices[mint]?.usdPrice || position.lastKnownPriceUsd || position.entryPriceUsd || 0
      );

      if (!(currentPriceUsd > 0)) {
        currentPriceUsd = 0;
        log(
          `No USD price available for ${position.symbol || mint} during shutdown exit; proceeding with market exit using zero-price accounting fallback.`,
          'warn',
          { console: true }
        );
      }

      const closed = await executePositionExit(
        position,
        currentBalance,
        currentPriceUsd,
        currentBalance.rawAmount,
        exitReason
      );

      if (closed) {
        closedCount += 1;
      } else {
        failedCount += 1;
        log(`Shutdown exit for ${position.symbol || mint} did not complete.`, 'warn', { console: true });
      }
    } catch (error) {
      failedCount += 1;
      log(`Failed to close ${position.symbol || mint} during shutdown: ${error.message}`, 'error', { console: true });
    }
  }

  if (state.positions.size === 0) {
    log(`Shutdown exit complete. Closed ${closedCount} position(s).`);
    return;
  }

  log(
    `Shutdown exit finished with ${state.positions.size} position(s) still open. Closed=${closedCount}, failed=${failedCount}.`,
    'warn',
    { console: true }
  );
}

async function monitorPositions() {
  if (state.positions.size === 0) {
    return;
  }

  const mints = Array.from(state.positions.keys());
  const prices = await fetchPricesBestEffort(mints, 'position price refresh');

  for (const mint of mints) {
    const position = state.positions.get(mint);
    if (!position) {
      continue;
    }

    const currentBalance = await getWalletTokenBalance(mint);
    if (currentBalance.rawAmount <= 0n) {
      log(`Position ${position.symbol} balance is zero; removing it from tracked positions.`, 'warn');
      state.positions.delete(mint);
      persistState();
      continue;
    }

    const latestSnapshot = state.marketSnapshots.get(mint);
    const currentPriceUsd = Number(prices[mint]?.usdPrice || latestSnapshot?.usdPrice || 0);
    if (latestSnapshot && Number.isFinite(latestSnapshot.liquidity)) {
      position.lastKnownLiquidityUsd = latestSnapshot.liquidity;
    }
    if (!(currentPriceUsd > 0)) {
      if (latestSnapshot && Number.isFinite(latestSnapshot.liquidity)) {
        const liquidityFloor = Math.max(
          config.liquidityCollapseThresholdUsd,
          Number(position.entryLiquidityUsd || 0) * config.liquidityCollapseThresholdRatio
        );
        if (latestSnapshot.liquidity <= liquidityFloor) {
          const fallbackExitPrice = Number(position.lastKnownPriceUsd || position.entryPriceUsd || 0);
          if (fallbackExitPrice > 0) {
            await executePositionExit(position, currentBalance, fallbackExitPrice, currentBalance.rawAmount, 'liquidity-exit');
            continue;
          }
        }
      }
      log(`Price unavailable for ${position.symbol}; skipping take-profit check this cycle.`, 'warn');
      continue;
    }

    position.highestPriceUsd = Math.max(Number(position.highestPriceUsd || position.entryPriceUsd || 0), currentPriceUsd);
    position.lastKnownBalanceRaw = currentBalance.rawAmount.toString();
    position.lastKnownPriceUsd = currentPriceUsd;
    state.positions.set(mint, position);

    const positionAgeSeconds = (Date.now() - new Date(position.openedAt).getTime()) / 1000;
    if (positionAgeSeconds < config.minHoldTimeSeconds) {
      continue;
    }

    // Time-to-Perform Filter: Exit if the position hasn't gained at least 5% within 75s
    if (positionAgeSeconds > config.performanceCheckSeconds && 
        position.targetsHit === 0 &&
        currentPriceUsd < position.entryPriceUsd * config.performanceMinMomentum) {
      await executePositionExit(position, currentBalance, currentPriceUsd, currentBalance.rawAmount, 'no-early-performance');
      continue;
    }

    const stopLossPrice = position.entryPriceUsd * (1 - config.stopLossPct);
    if (currentPriceUsd <= stopLossPrice) {
      await executePositionExit(position, currentBalance, currentPriceUsd, currentBalance.rawAmount, 'stop-loss');
      continue;
    }

    const positionAgeMinutes = (Date.now() - new Date(position.openedAt).getTime()) / 60000;
    if (positionAgeMinutes >= config.maxHoldMinutes && currentPriceUsd < position.entryPriceUsd * config.timeExitMinMultiple) {
      await executePositionExit(position, currentBalance, currentPriceUsd, currentBalance.rawAmount, 'time-exit');
      continue;
    }

    if (latestSnapshot && Number.isFinite(latestSnapshot.liquidity)) {
      const liquidityFloor = Math.max(
        config.liquidityCollapseThresholdUsd,
        Number(position.entryLiquidityUsd || 0) * config.liquidityCollapseThresholdRatio
      );
      if (latestSnapshot.liquidity <= liquidityFloor) {
        await executePositionExit(position, currentBalance, currentPriceUsd, currentBalance.rawAmount, 'liquidity-exit');
        continue;
      }
    }

    while (position.targetsHit < (Array.isArray(position.takeProfitMultiples) ? position.takeProfitMultiples.length : TAKE_PROFIT_MULTIPLES.length)) {
      const configuredMultiples = Array.isArray(position.takeProfitMultiples) ? position.takeProfitMultiples : TAKE_PROFIT_MULTIPLES;
      const nextMultiple = configuredMultiples[position.targetsHit];
      const targetPrice = position.entryPriceUsd * nextMultiple;

      // Adaptive Dynamic TP Logic
      // minTP = 1 + 0.5 * (expectedTP - 1)
      const minTpMultiple = 1 + 0.5 * (nextMultiple - 1);
      const minTpPrice = position.entryPriceUsd * minTpMultiple;

      if (currentPriceUsd >= minTpPrice) {
        if (!position.minTpReached) {
          position.minTpReached = true;
          position.minTpFirstReachedAt = Date.now();
          log(`Adaptive minTP ${minTpMultiple.toFixed(2)}x touched for ${position.symbol}. Noise filter active (10s).`, 'debug');
        } else if (!position.minTpArmed && Date.now() - position.minTpFirstReachedAt >= 10000) {
          position.minTpArmed = true;
          log(`Adaptive minTP ${minTpMultiple.toFixed(2)}x held for 10s. Profit guard ARMED for ${position.symbol}.`, 'info');
        }
      }

      // Exit if armed and price falls back
      if (position.minTpArmed && currentPriceUsd < minTpPrice) {
        log(`Price ${formatUsd(currentPriceUsd)} fell back to adaptive minTP ${formatUsd(minTpPrice)} for ${position.symbol}. Executing 100% adaptive exit.`, 'trade');
        const sold = await executePositionExit(position, currentBalance, currentPriceUsd, currentBalance.rawAmount, 'adaptive-tp-exit');
        if (sold) {
          log(`${position.symbol} entered cool-down. Re-analysis eligibility follows.`, 'info');
        }
        break;
      }

      if (currentPriceUsd < targetPrice) {
        break;
      }

      const sold = await sellTakeProfit(position, await getWalletTokenBalance(mint), currentPriceUsd, nextMultiple);
      if (!sold) {
        break;
      }

      // Reset adaptive state for next target
      position.minTpReached = false;
      position.minTpFirstReachedAt = null;
      position.minTpArmed = false;
    }

    if (position.targetsHit >= 1 && currentBalance.rawAmount > 0n) {
      if (!position.firstTpHitAt) {
        position.firstTpHitAt = new Date().toISOString();
        position.holdUntil = new Date(Date.now() + 30000).toISOString();
        const targetMultiple = position.lastTakeProfitMultiple || 1.5;
        log(`${targetMultiple}x profit reached for ${position.symbol}; ${TP_SELL_PERCENT}% sold. Monitoring every 30 seconds. Next check at ${position.holdUntil}.`, 'trade');
      }

      if (Date.now() >= new Date(position.holdUntil).getTime()) {
        const targetPrice = position.entryPriceUsd * (position.lastTakeProfitMultiple || 1.5);
        if (currentPriceUsd < 0.9 * targetPrice) {
          log(`Price ${formatUsd(currentPriceUsd)} fell below 0.9x target price ${formatUsd(targetPrice)} for ${position.symbol}. Exiting remaining position.`, 'trade');
          await executePositionExit(position, currentBalance, currentPriceUsd, currentBalance.rawAmount, 'tp-trailing-exit');
          continue;
        } else {
          position.holdUntil = new Date(Date.now() + 30000).toISOString();
          log(`Price ${formatUsd(currentPriceUsd)} is holding above 0.9x target for ${position.symbol}. Next check at ${position.holdUntil}.`, 'info');
        }
      }
    }
  }

  persistState();
}

async function scanForCandidates(trigger = {}) {
  const discoveryReason = trigger.reason || 'poll';
  let recentLaunches;
  try {
    recentLaunches = await fetchRecentLaunches();
  } catch (error) {
    const level = trigger.reason === 'ws-mint-init' ? 'warn' : 'warn';
    log(`Launch discovery refresh failed (${discoveryReason}): ${error.message}`, level, { console: true });
    return;
  }
  lastDiscoveryScanAt = Date.now();
  refreshMarketSnapshots(recentLaunches);

  const launchesByMint = new Map(
    recentLaunches
      .filter((token) => token?.id)
      .map((token) => [token.id, token])
  );

  for (const [mint, token] of launchesByMint) {
    const entry = state.pendingCandidateRechecks.get(mint);
    if (entry) {
      const currentPrice = Number(token.usdPrice || 0);
      if (currentPrice > 0) {
        entry.highestSeenPriceUsd = Math.max(entry.highestSeenPriceUsd || 0, currentPrice);
        entry.priceHistory = entry.priceHistory || [];
        entry.priceHistory.push({ price: currentPrice, timestamp: Date.now() });
        entry.tapeHistory = entry.tapeHistory || [];
        entry.tapeHistory.push({
          buys: Number(token.stats5m?.numBuys || 0),
          sells: Number(token.stats5m?.numSells || 0),
          timestamp: Date.now(),
        });
        // Keep last 60s of history
        const cutoff = Date.now() - 60000;
        entry.priceHistory = entry.priceHistory.filter(h => h.timestamp > cutoff);
        entry.tapeHistory = entry.tapeHistory.filter(h => h.timestamp > cutoff);

      }
    }
  }

  const dueRechecks = getDueCandidateRechecks();
  const recheckItems = dueRechecks
    .map((entry) => ({
      kind: 'recheck',
      recheckEntry: entry,
      token: launchesByMint.get(entry.mint) || entry.tokenSnapshot,
    }))
    .filter((item) => item.token?.id);
  const discoveryItems = recentLaunches
    .filter((token) => token?.id && !state.processedMints.has(token.id) && !state.pendingCandidateRechecks.has(token.id))
    .slice(0, config.maxCandidatesPerScan)
    .map((token) => ({
      kind: 'discovery',
      recheckEntry: null,
      token,
    }));
  const workItems = [...recheckItems, ...discoveryItems];

  let buysThisScan = 0;
  let rejectedThisScan = 0;
  let errorsThisScan = 0;
  let skippedNonTokenThisScan = 0;
  let scheduledForRecheckThisScan = 0;
  let rechecksAttemptedThisScan = 0;

  for (const item of workItems) {
    const token = item.token;
    if (!token?.id) {
      continue;
    }
    if (state.positions.size >= config.maxOpenPositions) {
      log(`Max open positions reached (${config.maxOpenPositions}); skipping more buys this cycle.`, 'warn', { console: true });
      break;
    }
    if (buysThisScan >= config.maxBuysPerScan) {
      break;
    }

    if (item.kind === 'recheck') {
      rechecksAttemptedThisScan += 1;
    } else {
      writeScannedTokenRecord({
        mint: token.id,
        symbol: token.symbol || null,
        name: token.name || null,
        launchpad: token.launchpad || null,
        liquidity: Number.isFinite(token.liquidity) ? token.liquidity : null,
        holderCount: Number.isFinite(token.holderCount) ? token.holderCount : null,
        organicScore: Number.isFinite(token.organicScore) ? token.organicScore : null,
        status: 'discovered',
      });
    }

    try {
      const highestSeenPriceUsd = item.recheckEntry?.highestSeenPriceUsd || null;
      const priceAtStartOfDelay = item.recheckEntry?.priceAtStartOfDelay || null;
      const liquidityAtStartOfDelay = item.recheckEntry?.liquidityAtStartOfDelay || null;
      const tapeAtStart = item.recheckEntry?.tapeAtStart || null;
      const priceHistory = item.recheckEntry?.priceHistory || [];
      const tapeHistory = item.recheckEntry?.tapeHistory || [];
      const evaluation = await evaluateCandidate(token, highestSeenPriceUsd, priceHistory, priceAtStartOfDelay, liquidityAtStartOfDelay, tapeAtStart, tapeHistory);
      if (!evaluation.approved) {
        if (shouldScheduleBorderlineRecheck(evaluation, item.recheckEntry)) {
          const recheckEntry = scheduleCandidateRecheck(evaluation, item.recheckEntry);
          scheduledForRecheckThisScan += 1;
          writeScannedTokenRecord({
            mint: token.id,
            symbol: token.symbol || null,
            name: token.name || null,
            status: item.kind === 'recheck' ? 'recheck-rescheduled' : 'borderline-recheck-scheduled',
            candidateScore: evaluation.candidateScore,
            launchpadProfile: evaluation.launchpadProfile?.name || null,
            blockers: evaluation.blockers,
            notes: evaluation.notes,
            recheckAttempt: recheckEntry.attempts,
            nextEligibleAt: recheckEntry.nextEligibleAt,
          });
          persistState();
          continue;
        }

        rejectedThisScan += 1;
        trackProcessedMint(token.id);
        writeScannedTokenRecord({
          mint: token.id,
          symbol: token.symbol || null,
          name: token.name || null,
          status: 'rejected',
          candidateScore: evaluation.candidateScore,
          launchpadProfile: evaluation.launchpadProfile?.name || null,
          blockers: evaluation.blockers,
          notes: evaluation.notes,
        });
        log(
          `Rejected ${token.symbol || token.id}: ${evaluation.blockers.join(' | ')}${evaluation.notes.length ? ` | Notes: ${evaluation.notes.join(' ; ')}` : ''}`,
          'warn',
          { console: false }
        );
        persistState();
        continue;
      }

      if (item.kind === 'discovery' && config.survivalDelaySeconds > 0) {
        const recheckEntry = scheduleSurvivalDelay(evaluation);
        writeScannedTokenRecord({
          mint: token.id,
          symbol: token.symbol || null,
          name: token.name || null,
          status: 'survival-delay-armed',
          candidateScore: evaluation.candidateScore,
          launchpadProfile: evaluation.launchpadProfile?.name || null,
          nextEligibleAt: recheckEntry.nextEligibleAt,
        });
        log(`Discovered ${token.symbol || token.id}; survival delay armed (${config.survivalDelaySeconds}s).`, 'info');
        persistState();
        continue;
      }

      const position = await buyCandidate(evaluation);
      trackProcessedMint(token.id);
      if (position) {
        buysThisScan += 1;
        state.retiredMints.delete(token.id);
        writeScannedTokenRecord({
          mint: token.id,
          symbol: token.symbol || null,
          name: token.name || null,
          status: config.paperTrading ? 'paper-bought' : 'bought',
          candidateScore: evaluation.candidateScore,
          launchpadProfile: evaluation.launchpadProfile?.name || null,
          entryPriceUsd: position.entryPriceUsd,
          entryUsdValue: position.entryUsdValue,
        });
      } else {
        writeScannedTokenRecord({
          mint: token.id,
          symbol: token.symbol || null,
          name: token.name || null,
          status: config.dryRun ? 'approved-dry-run' : 'approved-no-entry',
          candidateScore: evaluation.candidateScore,
          launchpadProfile: evaluation.launchpadProfile?.name || null,
        });
      }
      persistState();
    } catch (error) {
      const isNonTokenMint = /not a Token mint/i.test(error.message);
      if (isNonTokenMint) {
        skippedNonTokenThisScan += 1;
        trackProcessedMint(token.id);
        writeScannedTokenRecord({
          mint: token.id,
          symbol: token.symbol || null,
          name: token.name || null,
          status: 'skipped-non-token-mint',
          error: error.message,
        });
        log(`Skipped ${token.symbol || token.id}: ${error.message}`, 'debug', { console: false });
      } else if (item.recheckEntry) {
        errorsThisScan += 1;
        const postponedEntry = postponeCandidateRecheck(item.recheckEntry, token, error.message);
        writeScannedTokenRecord({
          mint: token.id,
          symbol: token.symbol || null,
          name: token.name || null,
          status: isTransientOperationError(error) ? 'recheck-postponed-transient' : 'recheck-postponed-error',
          error: error.message,
          nextEligibleAt: postponedEntry?.nextEligibleAt || null,
          recheckAttempt: item.recheckEntry.attempts,
        });
        log(`Deferred recheck for ${token.symbol || token.id}: ${error.message}`, isTransientOperationError(error) ? 'warn' : 'error', { console: true });
        persistState();
      } else if (isTransientOperationError(error)) {
        errorsThisScan += 1;
        writeScannedTokenRecord({
          mint: token.id,
          symbol: token.symbol || null,
          name: token.name || null,
          status: 'deferred-transient-error',
          error: error.message,
        });
        log(`Deferred ${token.symbol || token.id} after transient processing error: ${error.message}`, 'warn', { console: true });
      } else {
        errorsThisScan += 1;
        writeScannedTokenRecord({
          mint: token.id,
          symbol: token.symbol || null,
          name: token.name || null,
          status: 'error',
          error: error.message,
        });
        log(`Failed to process ${token.symbol || token.id}: ${error.message}`, 'error', { console: true });
      }
    }
  }

  if (workItems.length > 0) {
    log(
      `Scan: src=${discoveryReason}, disc=${discoveryItems.length}, buy=${buysThisScan}, rej=${rejectedThisScan}, err=${errorsThisScan}, pos=${state.positions.size}`,
      'info',
      { console: true }
    );
  } else if (trigger.websocketSignalCount) {
    log(
      `Websocket discovery refresh completed with no new Jupiter launches after ${trigger.websocketSignalCount} mint signal(s).`,
      'debug',
      { console: false }
    );
  }
}

function formatUsd(value) {
  if (!Number.isFinite(value)) {
    return '$0.00';
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 1 ? 2 : 6,
  }).format(value);
}

async function runLoop(request = {}) {
  const normalizedRequest = {
    reason: request.reason || 'interval',
    forceDiscovery: Boolean(request.forceDiscovery),
    skipMonitor: Boolean(request.skipMonitor),
    websocketSignalCount: Number(request.websocketSignalCount || 0),
    websocketSignalMints: Array.isArray(request.websocketSignalMints) ? request.websocketSignalMints : [],
  };

  if (loopBusy) {
    pendingLoopRequest = mergeLoopRequest(pendingLoopRequest, normalizedRequest);
    return;
  }

  loopBusy = true;
  try {
    const mood = getMoodAdjustments();
    processCoolDowns();
    
    if (!normalizedRequest.skipMonitor) {
      await monitorPositions();
    }
    
    if (mood.isPaused && !normalizedRequest.forceDiscovery) {
      // Skip discovery if paused, unless it's a forced startup/manual check
    } else if (shouldRunDiscoveryScan(normalizedRequest.forceDiscovery)) {
      await scanForCandidates(normalizedRequest);
    }
  } catch (error) {
    log(`Main loop error (${normalizedRequest.reason}): ${error.message}`, 'error');
  } finally {
    loopBusy = false;
  }

  if (pendingLoopRequest && !shouldStop) {
    const nextRequest = pendingLoopRequest;
    pendingLoopRequest = null;
    setImmediate(() => {
      void runLoop(nextRequest);
    });
  }
}

async function main() {
  log(`Wallet loaded: ${wallet.publicKey.toBase58()}`);
  log(`RPC endpoint: ${config.rpcUrl}`);
  if (config.wsRpcUrl) {
    log(`Websocket RPC endpoint: ${config.wsRpcUrl}`);
  }
  log(`Jupiter base URL: ${config.jupiterBaseUrl}`);
  log(`Mode: ${config.paperTrading ? 'paper trading' : 'live trading'}`);
  log(`Buy amount per entry: ${config.buyAmountSolText} SOL (${config.buyAmountLamports} lamports)`);
  log(`Dry run mode: ${config.dryRun ? 'enabled' : 'disabled'}`);
  log(`Position monitor interval: ${config.scanIntervalMs}ms`);
  log(`Discovery backfill interval: ${config.discoveryPollIntervalMs}ms`);
  if (config.paperTrading) {
    log(`Paper SOL balance: ${atomicToDecimalString(state.paperSolBalanceLamports, 9, 6)} SOL`);
  }
  log(`Bot log file: ${path.resolve(config.logFile)}`);
  log(`Scanned tokens file: ${path.resolve(config.scannedTokensFile)}`);
  log(`Currently tracked positions: ${state.positions.size}`);

  await startDiscoveryWatchers();
  try {
    await runLoop({ reason: 'startup', forceDiscovery: true });

    while (!shouldStop) {
      await sleep(config.scanIntervalMs);
      if (shouldStop) {
        break;
      }
      await runLoop({ reason: 'monitor-tick' });
    }
  } finally {
    await stopDiscoveryWatchers();
    if (shouldStop) {
      await closeAllOpenPositions();
    }
    persistState();
  }
}

function handleShutdown(signal) {
  if (shutdownRequested) {
    log(`Received ${signal} again; graceful shutdown is already in progress and positions are being closed.`, 'warn', { console: true });
    return;
  }

  shutdownRequested = true;
  log(`Received ${signal}; stopping discovery and closing all open positions before shutdown.`, 'warn', { console: true });
  shouldStop = true;
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

main().catch((error) => {
  log(error.stack || error.message, 'error');
  process.exitCode = 1;
});
