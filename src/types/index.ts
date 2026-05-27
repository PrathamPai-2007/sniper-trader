import { Rpc, SolanaRpcApi } from '@solana/rpc';
import { RpcSubscriptions, SolanaRpcSubscriptionsApi } from '@solana/rpc-subscriptions';

export interface LaunchpadProfile {
  scoreBonus: number;
  liquidityMultiplier: number;
  holderMultiplier: number;
  buysMultiplier: number;
  minPoolAgeSeconds: number;
}

export interface Config {
  strategyName: string;
  rpcUrls: string[];
  wsRpcUrls: string[];
  rpcUrl: string;
  wsRpcUrl: string;
  jupiterApiKey: string;
  jupiterPositionApiKey: string;
  jupiterBaseUrl: string;
  goPlusBaseUrl: string;
  bubbleMapsBaseUrl: string;
  scanIntervalMs: number;
  discoveryPollIntervalMs: number;
  discoveryWsEnabled: boolean;
  discoveryPumpEnabled: boolean;
  discoveryRaydiumEnabled: boolean;
  discoveryMeteoraEnabled: boolean;
  discoveryWsDebounceMs: number;
  buyAmountSolText: string;
  buyAmountLamports: bigint;
  slippageBps: number;
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
  maxOpenPositions: number;
  maxBuysPerScan: number;
  maxCandidatesPerScan: number;
  dryRun: boolean;
  paperTrading: boolean;
  liveTradingEnabled: boolean;
  initialPaperSolText: string;
  initialPaperSolLamports: bigint;
  sessionDir: string;
  stateFile: string;
  logFile: string;
  scannedTokensFile: string;
  paperTradeJournalFile: string;
  tradeJournalFile: string;
  performanceStatsFile: string;
  metricsFile: string;
  mintsFile?: string;
  minLiquidityUsd: number;
  minOrganicScore: number;
  minHolderCount: number;
  minBuys5m: number;
  minPoolAgeSeconds: number;
  maxCandidateAgeMinutes: number;
  minSocialLinks: number;
  maxAuditTopHoldersPct: number;
  maxTokenAccountTop1Pct: number;
  maxTokenAccountTop5Pct: number;
  maxFdvToLiquidity: number;
  maxMemeFdvUsd: number;
  allowVerifiedTokens: boolean;
  memeKeywords: string[];
  goPlusAccessToken: string;
  bubbleMapsApiKey: string;
  minBubbleMapsScore: number;
  maxBubbleMapsLargestClusterShare: number;
  minCandidateScore: number;
  maxRecheckAttempts: number;
  minMomentumConsistency: number;
  maxExhaustionRangePct: number;
  highGrowthConfidenceScore: number;
  borderlineRecheckEnabled: boolean;
  borderlineRecheckMinDelayMs: number;
  borderlineRecheckPageDelayMs?: number;
  borderlineRecheckMaxDelayMs: number;
  borderlineRecheckMaxAttempts: number;
  borderlineThresholdBufferRatio: number;
  survivalDelaySeconds: number;
  survivalDelayThresholdHigh: number;
  survivalDelayThresholdVeryHigh: number;
  finalAuditSeconds: number;
  minSurvivalMomentum: number;
  minBreakoutMultiplier: number;
  maxPriceDumpPct: number;
  maxLiquidityDrawdownPct: number;
  maxBuyTopGrowthPct: number;
  buyTopAthBufferPct: number;
  buyingTheTopSlPct: number;
  performanceCheckSeconds: number;
  performanceMinMomentum: number;
  minHoldTimeSeconds: number;
  websocketWatchdogIntervalMs: number;
  websocketStaleThresholdMs: number;
  stopLossPct: number;
  trailingStopDrawdownPct: number;
  takeProfitMultiples: number[];
  takeProfitFraction: number;
  earlyPerformanceGuardSeconds: number;
  earlyPerformanceDropPct: number;
  earlyPerformanceSellPct: number;
  maxHoldMinutes: number;
  timeExitMinMultiple: number;
  liquidityCollapseThresholdUsd: number;
  liquidityCollapseThresholdRatio: number;
  holdDurationHighConfidenceMinutes: number;
  holdDurationLowConfidenceMinutes: number;
  recheckPriceDropPct: number;
  moodPauseDurationMinutes: number;
  coolDownMinutes: number;
  holderCountWaitlistSeconds: number;
  reentryDipPct: number;
  reentryBreakoutPct: number;
  maxSurvivalGrowthPct: number;
  minAccelerationFactor: number;
  maxSellPressureIncreasePct: number;
  priorityFeeBaseMicroLamports: number;
  priorityFeeMaxMicroLamports: number;
  priorityFeePanicMultiplier: number;
  priorityFeePercentile: number;
  useJupiterSdk: boolean;
  closePositionsOnShutdown: boolean;
  privateKey: string;
  privateKeyPath: string;
  telegramBotToken: string;
  telegramChatId: string;
  discordWebhookUrl: string;
}

export interface TokenMetadata {
  id: string;
  symbol: string;
  name: string;
  decimals: number;
  usdPrice?: number;
  liquidity?: number;
  launchpad?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  isVerified?: boolean;
  fdvUsd?: number;
  marketCapUsd?: number;
  priceUsd?: number;
  organicScore?: number | string;
  fdv?: number | string;
  holderCount?: number | string;
  stats5m?: {
    numBuys: number;
    numSells: number;
  };
  snapshotQuality?: string;
  historicalSource?: string;
  firstPool?: {
    createdAt: string | number;
  };
  audit?: {
    isSus?: boolean;
    topHoldersPercentage?: number;
  };
  source?: string;
  priceHistory?: { price: number; timestamp: number }[];
  tapeAtStart?: { buys: number; sells: number };
  tapeHistory?: { buys: number; sells: number; timestamp: number }[];
  volume24h?: number;
  buyPressure?: number;
  sellPressure?: number;
}

export interface Position {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  openedAt: string;
  mode: 'paper' | 'live';
  entryPriceUsd: number;
  entryUsdValue: number;
  entryScore: number;
  initialTokenAmountRaw: string;
  buySignature?: string;
  highestPriceUsd: number;
  partiallyClosed: boolean;
  takeProfitMultiples: number[];
  takeProfitFractions: number[];
  trailingStopDrawdownPctResolved: number;
  maxHoldMinutesResolved: number;
  volatilityScaler: number;
  entryLiquidityUsd: number;
  lastDriftAuditTime?: number;
  lastSecurityAuditAt?: number;
  targetsHit?: number;
  lastTakeProfitAt?: string;
  lastTakeProfitMultiple?: number | null;
  lastKnownBalanceRaw?: string;
  lastKnownPriceUsd?: number;
  remainingCostUsd?: number;
  realizedPnlUsd?: number;
  realizedProceedsUsd?: number;
  lastExitReason?: string;
  lastSellSignature?: string;
  stopLossWarningSent?: boolean;
  minTpArmed?: boolean;
  minTpReached?: boolean;
  minTpFirstReachedAt?: number | null;
  initialBuyAmountSol?: string | number | null;
  initialBuyAmountLamports?: string;
  paperEntryQuoteOutAmount?: string;
  trailingArmed?: boolean;
  mintSignals?: MintSignals;
  securitySignals?: {
    goPlusToken: GoPlusTokenSignals | null;
    bubbleMaps: BubbleMapsSignals | null;
  };
  marketData?: {
    price: number | undefined;
    liquidity: number | undefined;
    volume24h: number | undefined;
    buyPressure: number | undefined;
    sellPressure: number | undefined;
  };
  highGrowthConfidence?: boolean;
  lastKnownLiquidityUsd?: number;
  launchpad?: string | null;
  tpProfile?: string | null;
  highestSeenPriceUsd?: number;
  priceHistory?: { price: number; timestamp: number }[];
  tapeHistory?: { buys: number; sells: number; timestamp: number }[];
  spreadHistory?: { spread: number; timestamp: number }[];
}

export interface MarketSnapshot {
  launchpad: string;
  fdvUsd?: number;
  liquidityUsd?: number;
  liquidity?: number;
  usdPrice?: number;
  observedAt?: string;
  holderCount?: number;
  isVerified?: boolean;
}

export interface RecheckItem {
  mint: string;
  tokenSnapshot?: TokenMetadata;
  attempts?: number;
  lastAttemptTime?: number;
  scheduledTime?: number;
  basePriceUsd?: number;
  reason?: string;
  candidateScore?: number;
  highestSeenPriceUsd?: number;
  priceAtStartOfDelay?: number;
  liquidityAtStartOfDelay?: number;
  priceHistory?: { price: number; timestamp: number }[];
  tapeAtStart?: { buys: number; sells: number };
  tapeHistory?: { buys: number; sells: number; timestamp: number }[];
  spreadHistory?: { spread: number; timestamp: number }[];
  isSurvivalWait?: boolean;
  isFinalAudit?: boolean;
  isWaitlist?: boolean;
  auditAttempts?: number;
  indexingLagRetries?: number;
  nextEligibleAt?: string;
}

export interface StateMetrics {
  discoveredCandidates: number;
  passedCheapAudit: number;
  passedSurvival: number;
  passedAudit: number;
  boughtPositions: number;
  failedMomentum: number;
  buyAttempts: number;
  buyFailures: number;
  profitableTrades: number;
  stopLosses: number;
  trailingExits: number;
  finalAuditQueued: number;
  finalAuditPassed: number;
  finalAuditDeferredIndexing: number;
  finalAuditRejected: number;
  exitReasonCounts: Record<string, number>;
  rejectionReasons: Record<string, number>;
}

export interface LaunchHistoryEntry {
  mint: string;
  firstSeenPrice: number;
  highestSeenPrice: number;
  isSuccess: boolean;
  timestamp: number;
}

export interface CoolDownEntry {
  expiresAt: number;
  lastExitPriceUsd: number;
}

export interface RetiredMintEntry {
  lastExitPriceUsd?: number;
  retiredAt: string;
  reason?: string;
}

export interface ClosedTrade {
  mint: string;
  symbol: string;
  exitReason: string;
  realizedPnlUsd: number;
  realizedProceedsUsd: number;
  entryUsdValue: number;
  entryPriceUsd: number;
  highestPriceUsd: number;
  holdSeconds: number;
  closedAt: string;
  entryScore: number;
  tpProfile?: string | null;
  takeProfitMultiples?: number[] | null;
  takeProfitFractions?: number[] | null;
  trailingStopDrawdownPctResolved: number;
  maxHoldMinutesResolved: number;
  volatilityScaler: number;
  entryLiquidityUsd: number;
  launchpad?: string | null;
  targetsHit: number;
  initialBuyAmountSol?: string | number | null;
}

export interface State {
  processedMintQueue: string[];
  processedMints: Set<string>;
  pendingCandidateRechecks: Map<string, RecheckItem>;
  positions: Map<string, Position>;
  marketSnapshots: Map<string, MarketSnapshot>;
  launchHistory: LaunchHistoryEntry[];
  paperSolBalanceLamports: string;
  tradeHistory: boolean[];
  moodPauseUntil: number | null;
  coolDownMints: Map<string, CoolDownEntry>;
  retiredMints: Map<string, RetiredMintEntry>;
  closedTrades: ClosedTrade[];
  metrics: StateMetrics;
}

export interface StateStore {
  load(stateFile: string): void;
  trackMint(mint: string): void;
  untrackMint(mint: string): void;
  upsertPosition(position: Position): void;
  removePosition(mint: string): void;
  incrementMetric(key: keyof StateMetrics, amount?: number): void;
  recordRejection(code: string): void;
  updatePaperSolBalance(amountLamports: bigint | string): void;
  addClosedTrade(trade: ClosedTrade): void;
  incrementExitReason(reason: string): void;
  pauseMood(durationMs: number): void;
  addTradeResult(isWin: boolean): void;
  startCoolDown(mint: string, pUsd: number, expiresAt: number): void;
  updateMarketSnapshot(mint: string, snapshot: MarketSnapshot): void;
  calculateGMI(): number;
  updateLaunchHistory(launches: TokenMetadata[]): void;
  upsertRecheckEntry(entry: RecheckItem): void;
  removeRecheckEntry(mint: string): void;
  removeCoolDown(mint: string): void;
  retireMint(mint: string, data: RetiredMintEntry): void;
  unretireMint(mint: string): void;
  removeMarketSnapshot(mint: string): void;
  requestShutdown(): void;
  persist(options?: { sync?: boolean; force?: boolean }): Promise<void>;
}

export interface AdjustedThresholds {
  minLiquidityUsd: number;
  minHolderCount: number;
  minBuys5m: number;
  minPoolAgeSeconds: number;
}

export interface MintSignals {
  decimals: number;
  supplyRaw: bigint;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  top1Share: number;
  top5Share: number;
  topAccounts: Array<{
    address: string;
    rawAmount: bigint;
    share: number;
    owner: string | null;
    ownerLookupError?: string;
  }>;
}

export interface GoPlusTokenSignals {
  status: 'ok' | 'no_data' | 'timeout' | 'error';
  blockers: string[];
  notes: string[];
  raw?: unknown;
  error?: string;
}

export interface BubbleMapsSignals {
  status: 'ok' | 'timeout' | 'error';
  blockers: string[];
  score: number | null;
  largestClusterShare: number | null;
  raw?: unknown;
  error?: string;
}

export interface DiscoveryLoopTrigger {
  reason?: string;
  forceDiscovery?: boolean;
  skipMonitor?: boolean;
  websocketSignalCount?: number;
  mints?: string[];
  mintLaunchpads?: Record<string, string>;
}

export interface EvaluationResult {
  approved: boolean;
  blockers: string[];
  rejectionReasons: { code: string; recheckEligible: boolean }[];
  notes: string[];
  candidateScore: number;
  volatilityScaler: number;
  launchpadProfile: LaunchpadProfile & { name: string };
  adjustedThresholds: AdjustedThresholds;
  token: TokenMetadata;
  mintSignals?: MintSignals;
  goPlusTokenSignals?: GoPlusTokenSignals | null;
  bubbleMapsSignals?: BubbleMapsSignals | null;
}

export interface Context {
  config: Config;
  state: State;
  rpc: Rpc<SolanaRpcApi>;
  rpcs: Rpc<SolanaRpcApi>[];
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  rpcSubscriptionPool: RpcSubscriptions<SolanaRpcSubscriptionsApi>[];
  wallet: { address: string; keypair?: unknown };
  logger: (message: string, level?: string, options?: { console?: boolean }) => void;
  persistState: (options?: { sync?: boolean; force?: boolean }) => Promise<void>;
  calculateGMI: () => number;
  store: StateStore;
  recordScanBackpressureEvent?: (error: unknown) => void;
  getEffectiveParallelism?: (base: number) => number;
  scanBackpressureFactor?: number;
}

export interface SwapOrder {
  transaction: string;
  lastValidBlockHeight?: number;
  requestId?: string;
  errorMessage?: string;
  error?: string;
  inUsdValue?: number | string;
  outAmount?: string;
}

export interface WalletBalance {
  mint: string;
  rawAmount: bigint;
  decimals: number;
  uiAmount: number;
}
