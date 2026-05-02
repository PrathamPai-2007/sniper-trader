'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { PublicKey } = require('@solana/web3.js');
const { decimalToAtomic, deriveWsRpcUrl } = require('./utils');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const DEFAULT_STATE_FILE = '';
const MAX_TRACKED_MINTS = 1_000;

const TAKE_PROFIT_MULTIPLES = [1.5];
const TAKE_PROFIT_FRACTION = 0.60;
const TP_SELL_PERCENT = Math.round(TAKE_PROFIT_FRACTION * 100);
const TP_HOLD_PERCENT = 100 - TP_SELL_PERCENT;

const BURN_OWNERS = new Set([
  '11111111111111111111111111111111',
  '1nc1nerator11111111111111111111111111111111',
]);

const DEFAULT_MEME_KEYWORDS = [
  'ai', 'ape', 'bonk', 'cat', 'chad', 'coin', 'dog', 'elon', 'frog', 'inu', 'kitty', 'meme', 'moon', 'pepe', 'pump', 'sol', 'wojak',
];

const DEFAULT_LAUNCHPAD_PROFILES = {
  'pump.fun': { scoreBonus: 10, liquidityMultiplier: 0.75, holderMultiplier: 0.7, buysMultiplier: 0.75, minPoolAgeSeconds: 5 },
  'bags.fun': { scoreBonus: 6, liquidityMultiplier: 0.7, holderMultiplier: 0.6, buysMultiplier: 0.5, minPoolAgeSeconds: 5 },
  raydium: { scoreBonus: 8, liquidityMultiplier: 1, holderMultiplier: 1, buysMultiplier: 1, minPoolAgeSeconds: 10 },
  meteora: { scoreBonus: 7, liquidityMultiplier: 1, holderMultiplier: 1, buysMultiplier: 1, minPoolAgeSeconds: 10 },
  moonshot: { scoreBonus: 9, liquidityMultiplier: 0.8, holderMultiplier: 0.75, buysMultiplier: 0.75, minPoolAgeSeconds: 5 },
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
    metricsFile: path.join(sessionDir, 'metrics.json'),
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
    minMomentumConsistency: numberFromEnv('MIN_MOMENTUM_CONSISTENCY', 0.55),
    maxExhaustionRangePct: numberFromEnv('MAX_EXHAUSTION_RANGE_PCT', 1.5),
    highGrowthConfidenceScore: numberFromEnv('HIGH_GROWTH_CONFIDENCE_SCORE', 70),
    borderlineRecheckEnabled: booleanFromEnv('BORDERLINE_RECHECK_ENABLED', true),
    borderlineRecheckMinDelayMs: numberFromEnv('BORDERLINE_RECHECK_MIN_DELAY_MS', 10_000),
    borderlineRecheckMaxDelayMs: numberFromEnv('BORDERLINE_RECHECK_MAX_DELAY_MS', 20_000),
    borderlineRecheckMaxAttempts: numberFromEnv('BORDERLINE_RECHECK_MAX_ATTEMPTS', 3),
    borderlineThresholdBufferRatio: numberFromEnv('BORDERLINE_THRESHOLD_BUFFER_PCT', 20) / 100,
    survivalDelaySeconds: numberFromEnv('SURVIVAL_DELAY_SECONDS', 30),
    minSurvivalMomentum: numberFromEnv('MIN_SURVIVAL_MOMENTUM', 1.04),
    maxPriceDumpPct: numberFromEnv('MAX_PRICE_DUMP_PCT', 40),
    maxLiquidityDrawdownPct: numberFromEnv('MAX_LIQUIDITY_DRAWDOWN_PCT', 15),
    performanceCheckSeconds: numberFromEnv('PERFORMANCE_CHECK_SECONDS', 75),
    performanceMinMomentum: numberFromEnv('PERFORMANCE_MIN_MOMENTUM', 1.05),
    minHoldTimeSeconds: numberFromEnv('MIN_HOLD_TIME_SECONDS', 60),
    stopLossPct: numberFromEnv('STOP_LOSS_PCT', 0.25),
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
    minAccelerationFactor: numberFromEnv('MIN_ACCELERATION_FACTOR', 0.2),
    maxSellPressureIncreasePct: numberFromEnv('MAX_SELL_PRESSURE_INCREASE_PCT', 30),
    priorityFeeBaseMicroLamports: numberFromEnv('PRIORITY_FEE_BASE_MICRO_LAMPORTS', 10_000),
    priorityFeeMaxMicroLamports: numberFromEnv('PRIORITY_FEE_MAX_MICRO_LAMPORTS', 5_000_000),
    priorityFeePanicMultiplier: numberFromEnv('PRIORITY_FEE_PANIC_MULTIPLIER', 2.0),
    priorityFeePercentile: numberFromEnv('PRIORITY_FEE_PERCENTILE', 75),
    privateKey,
    privateKeyPath,
  };
}

function validateStartupConfig() {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) {
    throw new Error(
      'Startup configuration error: RPC_URL is required but not set.\n' +
      'Add it to .env or your shell environment and try again.'
    );
  }

  const jupiterApiKey = process.env.JUPITER_API_KEY;
  if (!jupiterApiKey) {
    throw new Error(
      'Startup configuration error: JUPITER_API_KEY is required but not set.\n' +
      'Add it to .env or your shell environment and try again.'
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

module.exports = {
  constants: {
    SOL_MINT,
    MAX_TRACKED_MINTS,
    TAKE_PROFIT_MULTIPLES,
    TAKE_PROFIT_FRACTION,
    TP_SELL_PERCENT,
    TP_HOLD_PERCENT,
    BURN_OWNERS,
    DEFAULT_MEME_KEYWORDS,
    DEFAULT_LAUNCHPAD_PROFILES,
    SPL_TOKEN_PROGRAM_IDS,
    INITIALIZE_MINT_LOG_PATTERN,
    DISCOVERY_SIGNAL_RETENTION_MS,
    MARKET_SNAPSHOT_RETENTION_MS,
    DEFAULT_FETCH_TIMEOUT_MS,
    DEFAULT_FETCH_RETRIES,
    DEFAULT_FETCH_RETRY_DELAY_MS,
  },
  loadConfig,
  validateStartupConfig,
};
