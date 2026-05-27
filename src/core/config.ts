import path from 'node:path';
import fs from 'node:fs';
import { address } from '@solana/addresses';
import { decimalToAtomic, deriveWsRpcUrl } from './utils.js';
import { Config, LaunchpadProfile } from '../types/index.js';

// --- Environment Loading ---

/**
 * Simple .env loader to support local development without external dependencies.
 */
function loadDotEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;

  try {
    const content = fs.readFileSync(envPath, 'utf8');
    content.split(/\r?\n/).forEach((line) => {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith('#')) return;

      const [key, ...valueParts] = trimmedLine.split('=');
      if (!key) return;
      const keyTrimmed = key.trim();
      const valueRaw = valueParts.join('=').trim();

      // Shell-provided values win over .env so production deploys can inject secrets safely.
      if (keyTrimmed && !process.env[keyTrimmed]) {
        // Remove optional surrounding quotes
        process.env[keyTrimmed] = valueRaw.replace(/^["'](.*)["']$/, '$1');
      }
    });
  } catch (err: unknown) {
    console.warn(
      `[CONFIG] Failed to parse .env file: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

loadDotEnv();

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const constants = { SOL_MINT };
export const DEFAULT_STATE_FILE = '';
export const MAX_TRACKED_MINTS = 5_000;

export const TAKE_PROFIT_MULTIPLES = [1.5];
export const TAKE_PROFIT_FRACTION = 0.6;
export const TP_SELL_PERCENT = Math.round(TAKE_PROFIT_FRACTION * 100);
export const TP_HOLD_PERCENT = 100 - TP_SELL_PERCENT;

export const BURN_OWNERS = new Set<string>([
  '11111111111111111111111111111111',
  '1nc1nerator11111111111111111111111111111111',
]);

export const DEFAULT_MEME_KEYWORDS = [
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

export const DEFAULT_LAUNCHPAD_PROFILES: Record<string, LaunchpadProfile> = {
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

export const SPL_TOKEN_PROGRAM_IDS = [
  address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
];

export const PUMP_FUN_PROGRAM_ID = address('6EF8rrecth7QZ77z27Y9RQmP22JdK89pX6X1N1B8bN2');
export const RAYDIUM_AMM_V4_PROGRAM_ID = address('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
export const METEORA_DLMM_PROGRAM_ID = address('LBUZPB6S7GrLs9haYv94LMc6Zz21U9F7r5Q7oJCcG6T');

export const INITIALIZE_MINT_LOG_PATTERN = /Instruction:\s+InitializeMint2?/i;
export const PUMP_FUN_CREATE_LOG_PATTERN = /Instruction:\s+Create/i;
export const PUMP_FUN_MINT_LOG_PATTERN = /Program log:\s+Create\s+\{.*mint:\s*([\w\d]+)/i;
export const RAYDIUM_INIT_LOG_PATTERN = /Instruction:\s+(?:Initialize2|Monitor)/i;
export const METEORA_INIT_LOG_PATTERN = /Instruction:\s+(?:Initialize|CreateLbPair)/i;

export const DISCOVERY_SIGNAL_RETENTION_MS = 10 * 60 * 1000;
export const MARKET_SNAPSHOT_RETENTION_MS = 60 * 60 * 1000;
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
export const DEFAULT_FETCH_RETRIES = 2;
export const DEFAULT_FETCH_RETRY_DELAY_MS = 750;

export const SCORING_WEIGHTS = {
  socialLinkHigh: 15,
  socialLinkLow: 5,
  isVerified: 10,
  organicScoreClamp: 20,
  liquidityRatioHigh: 10,
  liquidityRatioLow: 5,
};

export const MOOD_THRESHOLDS = {
  winRateCritical: 0.2,
  winRateCautious: 0.4,
  sizeMultiplierCautious: 0.5,
  windowLarge: 10,
  windowSmall: 5,
};

export const MOMENTUM_FILTERS = {
  minAccelerationFactor: 0.3,
  minBuysFirstHalf: 5,
  buyVelocityDecayFactor: 0.4,
  maxExhaustionRangePct: 1.6,
  minMomentumConsistency: 0.6,
  minMidpointGuardDelayMs: 2000,
};

interface PresetStrategy {
  minLiquidityUsd: number;
  minHolderCount: number;
  maxRecheckAttempts: number;
  minCandidateScore: number;
  stopLossPct: number;
  takeProfitMultiples: number[];
  survivalDelaySeconds: number;
  maxOpenPositions: number;
  minSurvivalMomentum: number;
  minBreakoutMultiplier: number;
  maxPriceDumpPct: number;
  maxSurvivalGrowthPct: number;
  maxSellPressureIncreasePct: number;
  maxAuditTopHoldersPct: number;
  minMomentumConsistency: number;
  minAccelerationFactor: number;
  maxConcurrentAudits: number;
  scanParallelismLight: number;
  scanParallelismHeavy: number;
  ownerAuditParallelism: number;
  priceFallbackParallelism: number;
  parallelismMinFactor: number;
  errorRateWindow: number;
  backpressureErrorRateThreshold: number;
  mintSignalMaxAttempts: number;
  mintSignalRetryDelayMs: number;
  rpcIndexingRetryDelayMs: number;
}

export const STRATEGY_PRESETS: Record<string, PresetStrategy> = {
  conservative: {
    minLiquidityUsd: 500,
    minHolderCount: 12,
    maxRecheckAttempts: 6,
    minCandidateScore: 64,
    stopLossPct: 0.14,
    takeProfitMultiples: [1.3, 2.1],
    survivalDelaySeconds: 20,
    maxOpenPositions: 5,
    minSurvivalMomentum: 1.16,
    minBreakoutMultiplier: 1.05,
    maxPriceDumpPct: 18,
    maxSurvivalGrowthPct: 450,
    maxSellPressureIncreasePct: 110,
    maxAuditTopHoldersPct: 58,
    minMomentumConsistency: 0.65,
    minAccelerationFactor: 0.3,
    maxConcurrentAudits: 20,
    scanParallelismLight: 18,
    scanParallelismHeavy: 4,
    ownerAuditParallelism: 3,
    priceFallbackParallelism: 6,
    parallelismMinFactor: 0.55,
    errorRateWindow: 30,
    backpressureErrorRateThreshold: 0.22,
    mintSignalMaxAttempts: 2,
    mintSignalRetryDelayMs: 500,
    rpcIndexingRetryDelayMs: 5_000,
  },
  standard: {
    minLiquidityUsd: 500,
    minHolderCount: 12,
    maxRecheckAttempts: 6,
    minCandidateScore: 64,
    stopLossPct: 0.18,
    takeProfitMultiples: [1.3, 2.1],
    survivalDelaySeconds: 20,
    maxOpenPositions: 5,
    minSurvivalMomentum: 1.13,
    minBreakoutMultiplier: 1.05,
    maxPriceDumpPct: 18,
    maxSurvivalGrowthPct: 450,
    maxSellPressureIncreasePct: 110,
    maxAuditTopHoldersPct: 65,
    minMomentumConsistency: 0.65,
    minAccelerationFactor: 0.3,
    maxConcurrentAudits: 20,
    scanParallelismLight: 18,
    scanParallelismHeavy: 4,
    ownerAuditParallelism: 3,
    priceFallbackParallelism: 6,
    parallelismMinFactor: 0.55,
    errorRateWindow: 30,
    backpressureErrorRateThreshold: 0.22,
    mintSignalMaxAttempts: 2,
    mintSignalRetryDelayMs: 500,
    rpcIndexingRetryDelayMs: 5_000,
  },
};

/**
 * Retrieves a required environment variable or throws an error.
 * @param name - The name of the environment variable.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Parses a number from an environment variable with a fallback value.
 * @param name - The name of the environment variable.
 * @param fallback - The fallback value if the environment variable is not set.
 */
function numberFromEnv(name: string, fallback: number): number {
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

/**
 * Parses a boolean from an environment variable with a fallback value.
 * @param name - The name of the environment variable.
 * @param fallback - The fallback value if the environment variable is not set.
 */
function booleanFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

/**
 * Loads and constructs the application configuration from environment variables and presets.
 * @throws {Error} If critical configuration is missing or invalid.
 */
export function loadConfig(): Config {
  const strategyName = (process.env.STRATEGY || 'standard').toLowerCase();
  const preset = (STRATEGY_PRESETS[strategyName] || STRATEGY_PRESETS.standard) as PresetStrategy;

  const rpcUrlRaw = requireEnv('RPC_URL');
  const rpcUrls = rpcUrlRaw
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);

  const wsRpcUrlRaw = process.env.WS_RPC_URL;
  const wsRpcUrls = wsRpcUrlRaw
    ? wsRpcUrlRaw
        .split(',')
        .map((u) => u.trim())
        .filter(Boolean)
    : rpcUrls.map((u) => deriveWsRpcUrl(u));

  const jupiterApiKey = requireEnv('JUPITER_API_KEY');
  const jupiterPositionApiKey = process.env.JUPITER_POSITION_API_KEY || jupiterApiKey;
  const privateKey = process.env.PRIVATE_KEY || '';
  const privateKeyPath = process.env.PRIVATE_KEY_PATH || '';

  if (!privateKey && !privateKeyPath) {
    throw new Error('Startup configuration error: PRIVATE_KEY or PRIVATE_KEY_PATH is required.');
  }

  const buyAmountText = process.env.BUY_AMOUNT_SOL || '0.05';
  if (!/^\d+(\.\d+)?$/.test(String(buyAmountText).trim())) {
    throw new Error(
      `Startup configuration error: BUY_AMOUNT_SOL must be a positive decimal, got "${buyAmountText}".`
    );
  }

  const scanIntervalMs = numberFromEnv('SCAN_INTERVAL_MS', 5000);
  const discoveryPollIntervalMs = numberFromEnv('DISCOVERY_POLL_INTERVAL_MS', 30000);

  const paperTrading = booleanFromEnv('PAPER_TRADING', false);
  // Each run gets an isolated session directory so state, metrics, and journals do not overwrite prior runs.
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
    strategyName,
    rpcUrls,
    wsRpcUrls,
    rpcUrl: rpcUrls[0] || '',
    wsRpcUrl: wsRpcUrls[0] || '',
    jupiterApiKey,
    jupiterPositionApiKey,
    jupiterBaseUrl: (process.env.JUPITER_BASE_URL || 'https://api.jup.ag').replace(/\/+$/, ''),
    goPlusBaseUrl: (process.env.GOPLUS_BASE_URL || 'https://api.gopluslabs.io/api/v1').replace(
      /\/+$/,
      ''
    ),
    bubbleMapsBaseUrl: (process.env.BUBBLEMAPS_BASE_URL || 'https://api.bubblemaps.io').replace(
      /\/+$/,
      ''
    ),
    scanIntervalMs,
    discoveryPollIntervalMs,
    discoveryWsEnabled: booleanFromEnv('DISCOVERY_WS_ENABLED', true),
    discoveryPumpEnabled: booleanFromEnv('DISCOVERY_PUMP_ENABLED', true),
    discoveryRaydiumEnabled: booleanFromEnv('DISCOVERY_RAYDIUM_ENABLED', true),
    discoveryMeteoraEnabled: booleanFromEnv('DISCOVERY_METEORA_ENABLED', true),
    discoveryWsDebounceMs: numberFromEnv('DISCOVERY_WS_DEBOUNCE_MS', 750),
    buyAmountSolText: buyAmountText,
    buyAmountLamports: BigInt(decimalToAtomic(buyAmountText, 9)),
    slippageBps: numberFromEnv('SLIPPAGE_BPS', 500),
    maxConcurrentAudits: numberFromEnv('MAX_CONCURRENT_AUDITS', preset.maxConcurrentAudits),
    scanParallelismLight: numberFromEnv('SCAN_PARALLELISM_LIGHT', preset.scanParallelismLight),
    scanParallelismHeavy: numberFromEnv('SCAN_PARALLELISM_HEAVY', preset.scanParallelismHeavy),
    ownerAuditParallelism: numberFromEnv('OWNER_AUDIT_PARALLELISM', preset.ownerAuditParallelism),
    priceFallbackParallelism: numberFromEnv(
      'PRICE_FALLBACK_PARALLELISM',
      preset.priceFallbackParallelism
    ),
    parallelismMinFactor: numberFromEnv('PARALLELISM_MIN_FACTOR', preset.parallelismMinFactor),
    errorRateWindow: numberFromEnv('ERROR_RATE_WINDOW', preset.errorRateWindow),
    backpressureErrorRateThreshold: numberFromEnv(
      'BACKPRESSURE_ERROR_RATE_THRESHOLD',
      preset.backpressureErrorRateThreshold
    ),
    mintSignalMaxAttempts: numberFromEnv('MINT_SIGNAL_MAX_ATTEMPTS', preset.mintSignalMaxAttempts),
    mintSignalRetryDelayMs: numberFromEnv(
      'MINT_SIGNAL_RETRY_DELAY_MS',
      preset.mintSignalRetryDelayMs
    ),
    rpcIndexingRetryDelayMs: numberFromEnv(
      'RPC_INDEXING_RETRY_DELAY_MS',
      preset.rpcIndexingRetryDelayMs
    ),
    maxOpenPositions: numberFromEnv('MAX_OPEN_POSITIONS', preset.maxOpenPositions),
    maxBuysPerScan: numberFromEnv('MAX_BUYS_PER_SCAN', 2),
    maxCandidatesPerScan: numberFromEnv('MAX_CANDIDATES_PER_SCAN', 15),
    dryRun: booleanFromEnv('DRY_RUN', true),
    paperTrading,
    liveTradingEnabled: booleanFromEnv('LIVE_TRADING_ENABLED', false),
    initialPaperSolText: process.env.INITIAL_PAPER_SOL || '0.1',
    initialPaperSolLamports: BigInt(decimalToAtomic(process.env.INITIAL_PAPER_SOL || '0.1', 9)),
    sessionDir,
    stateFile: stateFile ? path.join(sessionDir, path.basename(stateFile)) : '',
    logFile: path.join(sessionDir, path.basename(logFile)),
    scannedTokensFile: path.join(sessionDir, path.basename(scannedTokensFile)),
    paperTradeJournalFile: path.join(sessionDir, 'paper-trade-journal.jsonl'),
    tradeJournalFile: path.join(sessionDir, 'trade-journal.jsonl'),
    performanceStatsFile: path.join(sessionDir, 'performance-stats.json'),
    metricsFile: path.join(sessionDir, 'metrics.json'),
    minLiquidityUsd: numberFromEnv('MIN_LIQUIDITY_USD', preset.minLiquidityUsd),
    minOrganicScore: numberFromEnv('MIN_ORGANIC_SCORE', 0),
    minHolderCount: numberFromEnv('MIN_HOLDER_COUNT', preset.minHolderCount),
    minBuys5m: numberFromEnv('MIN_BUYS_5M', 1),
    minPoolAgeSeconds: numberFromEnv('MIN_POOL_AGE_SECONDS', 0),
    maxCandidateAgeMinutes: numberFromEnv('MAX_CANDIDATE_AGE_MINUTES', 30),
    minSocialLinks: numberFromEnv('MIN_SOCIAL_LINKS', 0),
    maxAuditTopHoldersPct: numberFromEnv('MAX_AUDIT_TOP_HOLDERS_PCT', preset.maxAuditTopHoldersPct),
    maxTokenAccountTop1Pct: numberFromEnv('MAX_TOKEN_ACCOUNT_TOP1_PCT', 70),
    maxTokenAccountTop5Pct: numberFromEnv('MAX_TOKEN_ACCOUNT_TOP5_PCT', 85),
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
    minCandidateScore: numberFromEnv('MIN_CANDIDATE_SCORE', preset.minCandidateScore),
    maxRecheckAttempts: numberFromEnv('MAX_RECHECK_ATTEMPTS', preset.maxRecheckAttempts),
    minMomentumConsistency: numberFromEnv(
      'MIN_MOMENTUM_CONSISTENCY',
      preset.minMomentumConsistency
    ),
    maxExhaustionRangePct: numberFromEnv('MAX_EXHAUSTION_RANGE_PCT', 1.6),
    highGrowthConfidenceScore: numberFromEnv('HIGH_GROWTH_CONFIDENCE_SCORE', 70),
    borderlineRecheckEnabled: booleanFromEnv('BORDERLINE_RECHECK_ENABLED', true),
    borderlineRecheckMinDelayMs: numberFromEnv('BORDERLINE_RECHECK_MIN_DELAY_MS', 10_000),
    borderlineRecheckMaxDelayMs: numberFromEnv('BORDERLINE_RECHECK_MAX_DELAY_MS', 20_000),
    borderlineRecheckMaxAttempts: numberFromEnv('BORDERLINE_RECHECK_MAX_ATTEMPTS', 6),
    borderlineThresholdBufferRatio: numberFromEnv('BORDERLINE_THRESHOLD_BUFFER_PCT', 20) / 100,
    survivalDelaySeconds: numberFromEnv('SURVIVAL_DELAY_SECONDS', preset.survivalDelaySeconds),
    survivalDelayThresholdHigh: numberFromEnv('SURVIVAL_DELAY_THRESHOLD_HIGH', 75),
    survivalDelayThresholdVeryHigh: numberFromEnv('SURVIVAL_DELAY_THRESHOLD_VERY_HIGH', 90),
    finalAuditSeconds: numberFromEnv('FINAL_AUDIT_SECONDS', 5),
    minSurvivalMomentum: numberFromEnv('MIN_SURVIVAL_MOMENTUM', preset.minSurvivalMomentum),
    minBreakoutMultiplier: numberFromEnv('MIN_BREAKOUT_MULTIPLIER', preset.minBreakoutMultiplier),
    maxPriceDumpPct: numberFromEnv('MAX_PRICE_DUMP_PCT', preset.maxPriceDumpPct),
    maxLiquidityDrawdownPct: numberFromEnv('MAX_LIQUIDITY_DRAWDOWN_PCT', 15),
    maxBuyTopGrowthPct: numberFromEnv('MAX_BUY_TOP_GROWTH_PCT', 120),
    buyTopAthBufferPct: numberFromEnv('BUY_TOP_ATH_BUFFER_PCT', 2),
    buyingTheTopSlPct: numberFromEnv('BUYING_THE_TOP_SL_PCT', 25),
    performanceCheckSeconds: numberFromEnv('PERFORMANCE_CHECK_SECONDS', 90),
    performanceMinMomentum: numberFromEnv('PERFORMANCE_MIN_MOMENTUM', 1.05),
    minHoldTimeSeconds: numberFromEnv('MIN_HOLD_TIME_SECONDS', 13),
    websocketWatchdogIntervalMs: numberFromEnv('WEBSOCKET_WATCHDOG_INTERVAL_MS', 30_000),
    websocketStaleThresholdMs: numberFromEnv('WEBSOCKET_STALE_THRESHOLD_MS', 90_000),
    stopLossPct: numberFromEnv('STOP_LOSS_PCT', preset.stopLossPct),
    trailingStopDrawdownPct: numberFromEnv('TRAILING_STOP_DRAWDOWN_PCT', 0.2),
    takeProfitMultiples: (process.env.TAKE_PROFIT_MULTIPLES || preset.takeProfitMultiples.join(','))
      .split(',')
      .map((v) => Number(v.trim()))
      .filter((v) => !isNaN(v)),
    takeProfitFraction: numberFromEnv('TAKE_PROFIT_FRACTION', 0.6),
    earlyPerformanceGuardSeconds: numberFromEnv('EARLY_PERFORMANCE_GUARD_SECONDS', 15),
    earlyPerformanceDropPct: numberFromEnv('EARLY_PERFORMANCE_DROP_PCT', 10),
    earlyPerformanceSellPct: numberFromEnv('EARLY_PERFORMANCE_SELL_PCT', 50),
    maxHoldMinutes: numberFromEnv('MAX_HOLD_MINUTES', 20),
    timeExitMinMultiple: numberFromEnv('TIME_EXIT_MIN_MULTIPLE', 1.25),
    liquidityCollapseThresholdUsd: numberFromEnv('LIQUIDITY_COLLAPSE_THRESHOLD_USD', 750),
    liquidityCollapseThresholdRatio: numberFromEnv('LIQUIDITY_COLLAPSE_THRESHOLD_RATIO', 0.25),
    holdDurationHighConfidenceMinutes: numberFromEnv('HOLD_DURATION_HIGH_CONFIDENCE_MINUTES', 10),
    holdDurationLowConfidenceMinutes: numberFromEnv('HOLD_DURATION_LOW_CONFIDENCE_MINUTES', 5),
    recheckPriceDropPct: numberFromEnv('RECHECK_PRICE_DROP_PCT', 15),
    moodPauseDurationMinutes: numberFromEnv('MOOD_PAUSE_DURATION_MINUTES', 60),
    coolDownMinutes: numberFromEnv('COOL_DOWN_MINUTES', 20),
    holderCountWaitlistSeconds: numberFromEnv('HOLDER_COUNT_WAITLIST_SECONDS', 60),
    reentryDipPct: numberFromEnv('REENTRY_DIP_PCT', 15),
    reentryBreakoutPct: numberFromEnv('REENTRY_BREAKOUT_PCT', 20),
    maxSurvivalGrowthPct: numberFromEnv('MAX_SURVIVAL_GROWTH_PCT', preset.maxSurvivalGrowthPct),
    minAccelerationFactor: numberFromEnv('MIN_ACCELERATION_FACTOR', preset.minAccelerationFactor),
    maxSellPressureIncreasePct: numberFromEnv(
      'MAX_SELL_PRESSURE_INCREASE_PCT',
      preset.maxSellPressureIncreasePct
    ),
    priorityFeeBaseMicroLamports: numberFromEnv('PRIORITY_FEE_BASE_MICRO_LAMPORTS', 25_000),
    priorityFeeMaxMicroLamports: numberFromEnv('PRIORITY_FEE_MAX_MICRO_LAMPORTS', 5_000_000),
    priorityFeePanicMultiplier: numberFromEnv('PRIORITY_FEE_PANIC_MULTIPLIER', 2.0),
    priorityFeePercentile: numberFromEnv('PRIORITY_FEE_PERCENTILE', 75),
    useJupiterSdk: booleanFromEnv('USE_JUPITER_SDK', false),
    closePositionsOnShutdown: booleanFromEnv('CLOSE_POSITIONS_ON_SHUTDOWN', true),
    privateKey,
    privateKeyPath,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  };
}

/**
 * Validates the startup configuration for correctness and safety.
 * @param config - The configuration object to validate.
 * @returns True if the configuration is valid.
 * @throws {Error} If validation errors are found.
 */
export function validateStartupConfig(config: Config): boolean {
  if (!config || typeof config !== 'object') {
    throw new Error('Startup configuration error: config object is required.');
  }

  const errors: string[] = [];
  const positiveFields: Array<keyof Config> = [
    'scanIntervalMs',
    'discoveryPollIntervalMs',
    'discoveryWsDebounceMs',
    'websocketWatchdogIntervalMs',
    'websocketStaleThresholdMs',
    'buyAmountLamports',
    'minLiquidityUsd',
    'maxOpenPositions',
    'maxBuysPerScan',
    'maxCandidatesPerScan',
    'maxConcurrentAudits',
    'scanParallelismLight',
    'scanParallelismHeavy',
    'ownerAuditParallelism',
    'priceFallbackParallelism',
    'errorRateWindow',
    'mintSignalMaxAttempts',
    'mintSignalRetryDelayMs',
    'rpcIndexingRetryDelayMs',
    'maxRecheckAttempts',
    'borderlineRecheckMaxAttempts',
  ];
  for (const field of positiveFields) {
    const value = Number(config[field]);
    if (!Number.isFinite(value) || value <= 0) {
      errors.push(`${String(field)} must be a positive number.`);
    }
  }

  if (!Number.isFinite(config.slippageBps) || config.slippageBps < 1 || config.slippageBps > 5000) {
    errors.push('slippageBps must be between 1 and 5000.');
  }
  if (!Number.isFinite(config.stopLossPct) || config.stopLossPct <= 0 || config.stopLossPct >= 1) {
    errors.push('stopLossPct must be > 0 and < 1.');
  }
  if (
    !Number.isFinite(config.takeProfitFraction) ||
    config.takeProfitFraction <= 0 ||
    config.takeProfitFraction > 1
  ) {
    errors.push('takeProfitFraction must be > 0 and <= 1.');
  }
  if (
    !Number.isFinite(config.parallelismMinFactor) ||
    config.parallelismMinFactor <= 0 ||
    config.parallelismMinFactor > 1
  ) {
    errors.push('parallelismMinFactor must be > 0 and <= 1.');
  }
  if (
    !Number.isFinite(config.backpressureErrorRateThreshold) ||
    config.backpressureErrorRateThreshold <= 0 ||
    config.backpressureErrorRateThreshold > 1
  ) {
    errors.push('backpressureErrorRateThreshold must be > 0 and <= 1.');
  }
  if (
    !Number.isFinite(config.trailingStopDrawdownPct) ||
    config.trailingStopDrawdownPct <= 0 ||
    config.trailingStopDrawdownPct >= 1
  ) {
    errors.push('trailingStopDrawdownPct must be > 0 and < 1.');
  }
  if (
    !Array.isArray(config.takeProfitMultiples) ||
    config.takeProfitMultiples.length === 0 ||
    config.takeProfitMultiples.some((v) => !Number.isFinite(v) || v <= 1)
  ) {
    errors.push('takeProfitMultiples must contain one or more values greater than 1.');
  }
  if (
    !Number.isFinite(config.priorityFeeBaseMicroLamports) ||
    !Number.isFinite(config.priorityFeeMaxMicroLamports) ||
    config.priorityFeeBaseMicroLamports <= 0 ||
    config.priorityFeeMaxMicroLamports < config.priorityFeeBaseMicroLamports
  ) {
    errors.push('Priority fee range is invalid.');
  }
  if (
    !Number.isFinite(config.priorityFeePercentile) ||
    config.priorityFeePercentile < 1 ||
    config.priorityFeePercentile > 100
  ) {
    errors.push('priorityFeePercentile must be between 1 and 100.');
  }
  if (config.websocketStaleThresholdMs < config.websocketWatchdogIntervalMs) {
    errors.push(
      'websocketStaleThresholdMs must be greater than or equal to websocketWatchdogIntervalMs.'
    );
  }
  if (!config.rpcUrl || !config.jupiterBaseUrl || !config.jupiterApiKey) {
    errors.push('rpcUrl, jupiterBaseUrl, and jupiterApiKey are required.');
  }
  if (!config.paperTrading && !config.dryRun && !config.liveTradingEnabled) {
    errors.push(
      'LIVE_TRADING_ENABLED=true is required when PAPER_TRADING=false and DRY_RUN=false.'
    );
  }

  if (errors.length > 0) {
    throw new Error(`Startup configuration error:\n- ${errors.join('\n- ')}`);
  }
  return true;
}
