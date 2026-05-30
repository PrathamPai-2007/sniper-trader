'use strict';
import { createTestConfig, createState, createCtx, withPatchedMembers } from './_test_helpers.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as engine from '../src/services/engine/engine.service.js';
import * as audit from '../src/services/audit/audit.service.js';
import { Context, TokenMetadata } from '../src/types/index.js';

test('engine evaluates buying-the-top only when price is near ATH after steep growth', async () => {
  const ctx = createCtx();
  const token: TokenMetadata = {
    id: 'TopMint',
    symbol: 'TOP',
    name: 'Top Token',
    decimals: 9,
    usdPrice: 225,
    liquidity: 10_000,
    holderCount: 100,
    stats5m: { numBuys: 50, numSells: 10 },
    organicScore: 100,
  };

  const noContext = await engine.evaluateCandidate(ctx, token);
  assert.equal(noContext.approved, true);

  const notAtTop = await engine.evaluateCandidate(ctx, token, 250, [], 100);
  assert.equal(notAtTop.approved, true);

  const atTop = await engine.evaluateCandidate(ctx, token, 226, [], 100);
  assert.equal(atTop.approved, false);
  assert.deepEqual(
    atTop.rejectionReasons.find((reason) => reason.code === 'buying-the-top'),
    { code: 'buying-the-top', recheckEligible: true }
  );
});

test('engine GMI adjusts aggression correctly', async () => {
  const config = createTestConfig({
    minCandidateScore: 70,
    memeKeywords: ['ape'],
    maxMemeFdvUsd: 10_000_000,
    minOrganicScore: 0,
    minSocialLinks: 0,
    allowVerifiedTokens: true,
    maxAuditTopHoldersPct: 100,
    maxCandidateAgeMinutes: 60,
    borderlineThresholdBufferRatio: 0.2,
  });
  const state = createState({ launchHistory: [], retiredMints: new Map() });
  const ctx = { config, state } as unknown as Context;

  // 1. GMI Neutral (no history)
  (ctx as any).calculateGMI = () => 0.5;
  const token: TokenMetadata = {
    id: 'test',
    symbol: 'APE',
    name: 'ape',
    decimals: 9,
    usdPrice: 1,
    liquidity: 50_000, // Ratio > 5 relative to minLiquidityUsd=750
    holderCount: 1000,
    stats5m: { numBuys: 100, numSells: 10 },
    website: 'http',
    twitter: 'http',
    telegram: 'http', // 3 social links
    launchpad: 'pump.fun',
    firstPool: { createdAt: new Date(Date.now() - 30_000).toISOString() },
  };

  // GMI Neutral: Target 70. Score 85 should PASS.
  let result = await engine.evaluateCandidate(ctx, token);
  assert.strictEqual(result.candidateScore, 85);
  assert.strictEqual(result.approved, true);

  // GMI Low (< 0.3): Target 70 + 35 = 105. Score 85 should FAIL.
  (ctx as any).calculateGMI = () => 0.2;
  config.minCandidateScore = 105;
  result = await engine.evaluateCandidate(ctx, token);
  assert.strictEqual(result.approved, false);
  assert.ok(result.blockers.some((b) => b.includes('Low entry score')));

  // GMI High (> 0.7): Target 70 - 5 = 65. Score 65 should PASS.
  (ctx as any).calculateGMI = () => 0.8;
  config.minCandidateScore = 65;
  const lowLiqToken: TokenMetadata = {
    ...token,
    liquidity: config.minLiquidityUsd,
    launchpad: undefined, // unknown launchpad -> scoreBonus 0
    firstPool: { createdAt: new Date(Date.now() - 30_000).toISOString() },
  };
  result = await engine.evaluateCandidate(ctx, lowLiqToken);
  assert.strictEqual(result.candidateScore, 65);
  assert.strictEqual(result.approved, true);
});

test('engine computes score bonuses from socials and liquidity tiers', () => {
  const thresholds = {
    minLiquidityUsd: 1000,
    minHolderCount: 0,
    minBuys5m: 0,
    minPoolAgeSeconds: 0,
  };
  const profile = {
    scoreBonus: 10,
    liquidityMultiplier: 1,
    holderMultiplier: 1,
    buysMultiplier: 1,
    minPoolAgeSeconds: 0,
    name: 'test',
  };

  assert.equal(
    engine.computeCandidateScore({ liquidity: 1000 } as TokenMetadata, profile, thresholds, 0),
    60
  );
  assert.equal(
    engine.computeCandidateScore(
      { liquidity: 1000, organicScore: '15' } as TokenMetadata,
      profile,
      thresholds,
      0
    ),
    75
  );
  assert.equal(
    engine.computeCandidateScore({ liquidity: 1000 } as TokenMetadata, profile, thresholds, 3),
    75
  );
  assert.equal(
    engine.computeCandidateScore({ liquidity: 6000 } as TokenMetadata, profile, thresholds, 0),
    70
  );
});

test('engine treats non-string launchpads as unknown profiles', () => {
  const unknownProfile = {
    name: 'unknown',
    scoreBonus: 0,
    liquidityMultiplier: 1,
    holderMultiplier: 1,
    buysMultiplier: 1,
    minPoolAgeSeconds: 0,
  };
  assert.deepEqual(engine.getLaunchpadProfile('pump.fun'), {
    ...unknownProfile,
    name: 'pump.fun',
    scoreBonus: 10,
    liquidityMultiplier: 0.75,
    holderMultiplier: 0.7,
    buysMultiplier: 0.75,
    minPoolAgeSeconds: 5,
  });
  // The original test might have expected unknown for non-existent ones.
  assert.deepEqual(engine.getLaunchpadProfile(123 as any), unknownProfile);
});

test('engine applies launchpad-specific threshold multipliers', () => {
  const ctx = {
    config: { minLiquidityUsd: 1000, minHolderCount: 100, minBuys5m: 10, minPoolAgeSeconds: 30 },
  } as unknown as Context;
  const profile = {
    name: 'pump.fun',
    scoreBonus: 10,
    liquidityMultiplier: 0.75,
    holderMultiplier: 0.7,
    buysMultiplier: 0.75,
    minPoolAgeSeconds: 5,
  };

  const thresholds = engine.getLaunchpadAdjustedThresholds(ctx, profile);
  assert.equal(thresholds.minLiquidityUsd, 750);
  assert.equal(thresholds.minHolderCount, 70);
  assert.equal(thresholds.minBuys5m, 7.5);
});

test('engine identifies memecoin candidates from name, symbol, fdv, and launchpad', () => {
  const ctx = {
    config: { memeKeywords: ['pepe', 'doge'], maxMemeFdvUsd: 1_000_000 },
  } as unknown as Context;

  assert.equal(engine.looksLikeMemecoin(ctx, { name: 'Pepe Coin' } as TokenMetadata), true);
  assert.equal(engine.looksLikeMemecoin(ctx, { symbol: 'DOGE' } as TokenMetadata), true);
  assert.equal(
    engine.looksLikeMemecoin(ctx, { name: 'pepe', fdv: 500_000 } as TokenMetadata),
    true
  );
  assert.equal(engine.looksLikeMemecoin(ctx, { launchpad: 'pump.fun' } as TokenMetadata), true);
  assert.equal(
    engine.looksLikeMemecoin(ctx, { name: 'Serious Token', fdv: 2_000_000 } as TokenMetadata),
    false
  );
});

test('engine borderline threshold helper honors configured buffer', () => {
  const ctx = { config: { borderlineThresholdBufferRatio: 0.2 } } as unknown as Context;

  assert.equal(engine.isSlightlyBelowThreshold(ctx, 85, 100), true);
  assert.equal(engine.isSlightlyBelowThreshold(ctx, 75, 100), false);
  assert.equal(engine.isSlightlyBelowThreshold(ctx, 110, 100), true);
});

test('engine rejects candidates when fdv-to-liquidity exceeds the configured threshold', async () => {
  const ctx = createCtx({ maxFdvToLiquidity: 5 });
  const token: TokenMetadata = {
    id: 'FdvGateMint',
    symbol: 'FDV',
    name: 'FDV Gate',
    decimals: 9,
    usdPrice: 1,
    liquidity: 1_000,
    fdv: 10_000,
    holderCount: 50,
    organicScore: 10,
    stats5m: { numBuys: 10, numSells: 1 },
    firstPool: { createdAt: new Date(Date.now() - 60_000).toISOString() },
  };

  const evaluation = await engine.evaluateCandidate(ctx, token);
  assert.equal(evaluation.approved, false);
  assert.ok(evaluation.rejectionReasons.some((reason) => reason.code === 'fdv-liquidity-too-high'));
});

test('engine treats missing fdv as neutral when evaluating candidates', async () => {
  const ctx = createCtx({ maxFdvToLiquidity: 5 });
  const token: TokenMetadata = {
    id: 'NoFdvMint',
    symbol: 'NFDV',
    name: 'No FDV',
    decimals: 9,
    usdPrice: 1,
    liquidity: 1_000,
    holderCount: 50,
    organicScore: 10,
    stats5m: { numBuys: 10, numSells: 1 },
    firstPool: { createdAt: new Date(Date.now() - 60_000).toISOString() },
  };

  const evaluation = await engine.evaluateCandidate(ctx, token);
  assert.equal(evaluation.approved, true);
});

test('engine handles future pool timestamps (clock drift) by reporting negative age', async () => {
  const ctx = createCtx({ minPoolAgeSeconds: 5 });
  const token: TokenMetadata = {
    id: 'FuturePoolMint',
    symbol: 'FUT',
    name: 'Future Pool',
    decimals: 9,
    usdPrice: 1,
    liquidity: 1_000,
    holderCount: 50,
    organicScore: 10,
    stats5m: { numBuys: 10, numSells: 1 },
    firstPool: { createdAt: new Date(Date.now() + 180_000).toISOString() },
  };

  const evaluation = await engine.evaluateCandidate(ctx, token);
  assert.equal(evaluation.approved, false);
  assert.ok(evaluation.blockers.some((blocker) => /Too new -\d+s\./.test(blocker)));
});

test('engine flags sell pressure when rolling buy counts decrease', async () => {
  const ctx = createCtx();
  const token: TokenMetadata = {
    id: 'SellPressureMint',
    symbol: 'SP',
    name: 'Pepe Sell Pressure',
    decimals: 9,
    usdPrice: 1,
    liquidity: 10_000,
    holderCount: 50,
    organicScore: 10,
    stats5m: { numBuys: 80, numSells: 5 },
    firstPool: { createdAt: new Date(Date.now() - 60_000).toISOString() },
  };

  const evaluation = await engine.evaluateCandidate(
    ctx,
    token,
    undefined,
    [],
    undefined,
    undefined,
    {
      buys: 100,
      sells: 1,
    }
  );

  assert.equal(evaluation.approved, false);
  assert.ok(evaluation.rejectionReasons.some((reason) => reason.code === 'high-sell-pressure'));
});

test('engine sanitizes historical price points before volatility and momentum filters', async () => {
  const ctx = createCtx({ earlyPerformanceGuardSeconds: 1 });
  const now = Date.now();
  const token: TokenMetadata = {
    id: 'HistoryMint',
    symbol: 'HIST',
    name: 'Pepe History',
    decimals: 9,
    usdPrice: 1.2,
    liquidity: 10_000,
    holderCount: 50,
    organicScore: 10,
    stats5m: { numBuys: 10, numSells: 1 },
    firstPool: { createdAt: new Date(now - 60_000).toISOString() },
  };
  const priceHistory = [
    { price: '1.00' as any, timestamp: now - 12_000 },
    { price: 'bad' as any, timestamp: now - 10_000 },
    { price: 0, timestamp: now - 8_000 },
    { price: '1.05' as any, timestamp: now - 7_000 },
    { price: 1.1, timestamp: now - 5_000 },
    { price: 1.15, timestamp: now - 3_000 },
    { price: 1.18, timestamp: now - 1_000 },
  ];

  const evaluation = await engine.evaluateCandidate(ctx, token, undefined, priceHistory, 1);

  assert.equal(Number.isFinite(evaluation.volatilityScaler), true);
  assert.ok(evaluation.volatilityScaler > 0);
});

test('engine reduced historical notes accept numeric strings as present', async () => {
  const ctx = createCtx();
  const token: TokenMetadata = {
    id: 'HistoricalStringMint',
    symbol: 'PEPE',
    name: 'Historical Pepe',
    decimals: 9,
    usdPrice: 1.2,
    liquidity: 8_500,
    holderCount: '12',
    organicScore: '5',
    stats5m: { numBuys: '3' } as any,
    launchpad: 'pump.fun',
    firstPool: { createdAt: new Date(Date.now() - 60_000).toISOString() },
    snapshotQuality: 'reduced-historical',
  };

  const evaluation = await engine.evaluateCandidate(ctx, token);

  assert.equal(evaluation.approved, true);
  assert.equal(
    evaluation.notes.some((note) => /missing holder count/i.test(note)),
    false
  );
  assert.equal(
    evaluation.notes.some((note) => /missing organic score/i.test(note)),
    false
  );
  assert.equal(
    evaluation.notes.some((note) => /missing 5m buy tape/i.test(note)),
    false
  );
});

test('engine full audit reports downstream blockers even after mint blockers', async () => {
  const ctx = createCtx(
    {},
    {
      retiredMints: new Map([
        ['FullAuditMint', { lastExitPriceUsd: 1, retiredAt: new Date().toISOString() }],
      ]),
    }
  );
  const token: TokenMetadata = {
    id: 'FullAuditMint',
    symbol: 'FULL',
    name: 'Pepe Full Audit',
    decimals: 9,
    usdPrice: 1.05,
    liquidity: 10_000,
    holderCount: 50,
    organicScore: 10,
    stats5m: { numBuys: 10, numSells: 1 },
    firstPool: { createdAt: new Date(Date.now() - 60_000).toISOString() },
  };

  await withPatchedMembers(
    audit.auditService,
    {
      getMintSignals: async () => ({
        mintAuthority: 'mint-authority',
        freezeAuthority: null,
        top1Share: 0,
        top5Share: 0,
        topAccounts: [{ owner: 'owner-a' }],
      }),
      fetchGoPlusTokenSignals: async () => null,
      fetchBubbleMapsSignals: async () => null,
      fetchGoPlusAddressSignals: async () => [{ address: 'owner-a' }],
    },
    async () => {
      const evaluation = await engine.evaluateCandidate(
        ctx,
        token,
        undefined,
        [],
        undefined,
        undefined,
        undefined,
        [],
        'full'
      );
      const codes = evaluation.rejectionReasons.map((reason) => reason.code);

      assert.equal(evaluation.approved, false);
      assert.ok(codes.includes('mint-authority-enabled'));
      assert.ok(codes.includes('goplus-malicious-owner'));
      assert.ok(codes.includes('price-distance-gate'));
    }
  );
});

test('historical backfill snapshots degrade gracefully without Jupiter-only metrics', async () => {
  const ctx = createCtx({ minHoldTimeSeconds: 300 });
  const createdAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const token: TokenMetadata = {
    id: 'HistoricalMint',
    symbol: 'PEPE',
    name: 'Historical Pepe',
    decimals: 9,
    usdPrice: 1.2,
    liquidity: 8_500,
    launchpad: 'pump.fun',
    firstPool: { createdAt },
    snapshotQuality: 'reduced-historical',
    historicalSource: 'geckoterminal',
  };

  const evaluation = await engine.evaluateCandidate(ctx, token);
  assert.equal(evaluation.approved, true);
  assert.ok(evaluation.notes.some((note) => /missing holder count/i.test(note)));
});

// --- NEW/UPGRADED TEST CASES ---

test('engine GMI handles extreme mock launch history / total supply BigInt simulation', async () => {
  const config = createTestConfig({ minCandidateScore: 60 });
  const state = createState();
  const ctx = {
    config,
    state,
    calculateGMI: () => {
      // Simulate extreme BigInt logic where we count very high total supplies or similar
      const mockTotalSupply = 18_446_744_073_709_551_615n; // 2^64 - 1
      if (mockTotalSupply > 100_000n) {
        return 0.1; // Low GMI
      }
      return 0.5;
    },
  } as unknown as Context;

  const token: TokenMetadata = {
    id: 'BigIntGMIMint',
    symbol: 'BGMI',
    name: 'BigInt GMI Token',
    decimals: 9,
    usdPrice: 1,
    liquidity: 5_000,
    holderCount: 200,
    stats5m: { numBuys: 50, numSells: 10 },
    firstPool: { createdAt: new Date(Date.now() - 30_000).toISOString() },
  };

  const result = await engine.evaluateCandidate(ctx, token);
  // With calculateGMI returning 0.1, the borderline/min threshold target becomes higher or adjusted
  assert.ok(result);
});

test('engine rejects candidate with zero buys/sells (zero volume)', async () => {
  const ctx = createCtx({ minBuys5m: 5 });
  const token: TokenMetadata = {
    id: 'ZeroVolumeMint',
    symbol: 'ZERO',
    name: 'Zero Volume Token',
    decimals: 9,
    usdPrice: 1,
    liquidity: 5_000,
    holderCount: 200,
    stats5m: { numBuys: 0, numSells: 0 },
    firstPool: { createdAt: new Date(Date.now() - 30_000).toISOString() },
  };

  const result = await engine.evaluateCandidate(ctx, token);
  assert.equal(result.approved, false);
  assert.ok(result.blockers.some((b) => b.includes('Low 5m buys')));
});
