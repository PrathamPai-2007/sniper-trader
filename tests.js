'use strict';

const services = require('./services');

async function testMomentumEngine() {
  console.log('--- Testing Momentum Engine ---');
  
  const ctx = {
    config: {
      minSurvivalMomentum: 1.04,
      minMomentumConsistency: 0.55,
      maxSurvivalGrowthPct: 150,
      reentryDipPct: 15,
      reentryBreakoutPct: 20,
      maxMemeFdvUsd: 10000000,
      memeKeywords: ['meme', 'pepe'],
      allowVerifiedTokens: true,
      minLiquidityUsd: 1000,
      minHolderCount: 10,
      minBuys5m: 2,
      minPoolAgeSeconds: 5,
      maxCandidateAgeMinutes: 30,
      minSocialLinks: 0,
      maxFdvToLiquidity: 80,
      maxAuditTopHoldersPct: 60,
      maxTokenAccountTop1Pct: 90,
      maxTokenAccountTop5Pct: 98,
      minCandidateScore: 60,
      maxPriceDumpPct: 40,
      maxSellPressureIncreasePct: 30,
      borderlineThresholdBufferRatio: 0.2
    },
    state: {
      retiredMints: new Map(),
      metrics: { rejectionReasons: {} }
    },
    connection: {
      getParsedAccountInfo: async () => ({
        value: {
          data: {
            parsed: {
              type: 'mint',
              info: { decimals: 9, supply: '1000000000000', mintAuthority: null, freezeAuthority: null }
            }
          }
        }
      }),
      getTokenLargestAccounts: async () => ({ value: [] })
    },
    logger: () => {}
  };

  const mockToken = {
    id: 'So11111111111111111111111111111111111111112', symbol: 'PEPE', name: 'Pepe', usdPrice: 1.10, liquidity: 5000, holderCount: 100,
    stats5m: { numBuys: 20, numSells: 5 }, audit: { isSus: false }, organicScore: 50
  };

  // Mocking getMintSignals to avoid RPC call
  services.getMintSignals = async () => ({
    mintAuthority: null, freezeAuthority: null, top1Share: 0.05, top5Share: 0.15, topAccounts: []
  });
  services.fetchGoPlusTokenSignals = async () => null;
  services.fetchGoPlusAddressSignals = async () => [];
  services.fetchBubbleMapsSignals = async () => null;

  console.log('Testing Normal Growth...');
  const now = Date.now();
  const priceHistoryNormal = [
    { price: 1.00, timestamp: now - 30000 },
    { price: 1.03, timestamp: now - 25000 },
    { price: 1.06, timestamp: now - 20000 },
    { price: 1.09, timestamp: now - 15000 },
    { price: 1.12, timestamp: now - 10000 },
    { price: 1.15, timestamp: now - 5000 },
  ];
  const e1 = await services.evaluateCandidate(ctx, { ...mockToken, usdPrice: 1.18 }, 1.18, priceHistoryNormal, 1.00);
  console.log(`Approved: ${e1.approved} (Expected: true)`);
  if (!e1.approved) console.log(`Blockers: ${e1.blockers.join(', ')}`);

  console.log('Testing Stall Filter...');
  const priceHistoryStall = [
    { price: 1.00, timestamp: now - 30000 },
    { price: 1.05, timestamp: now - 25000 },
    { price: 1.10, timestamp: now - 20000 },
    { price: 1.11, timestamp: now - 15000 },
    { price: 1.11, timestamp: now - 10000 },
    { price: 1.11, timestamp: now - 5000 },
  ];
  const e2 = await services.evaluateCandidate(ctx, { ...mockToken, usdPrice: 1.11 }, 1.11, priceHistoryStall, 1.00);
  console.log(`Approved: ${e2.approved} (Expected: false)`);
  console.log(`Blockers: ${e2.blockers.join(', ')}`);

  console.log('--- Momentum Tests Finished ---');
}

async function runTests() {
  try {
    await testMomentumEngine();
  } catch (e) {
    console.error('Tests failed:', e);
  }
}

runTests();
