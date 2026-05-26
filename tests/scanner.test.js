'use strict';
const { withPatchedMembers, seedBotState } = require('./_test_helpers');
const assert = require('node:assert/strict');
const test = require('node:test');
const scanner = require('../scanner');
const bot = require('../bot');
const services = require('../services');

// Mock Date.now to prevent timing issues on slow CI environments
const MOCK_NOW = 1700000000000;
Date.now = () => MOCK_NOW;

test('bot schedules survival delays using score-based timing tiers', () => {
  const { state, cleanup } = seedBotState();
  const now = Date.now();

  const schedule = (score) => {
    scanner.scheduleSurvivalDelay(bot.getCtx(), {
      candidateScore: score,
      token: {
        id: `Mint-${score}`,
        usdPrice: 1,
        liquidity: 1000,
        stats5m: { numBuys: 10, numSells: 0 },
      },
    });
    return state.pendingCandidateRechecks.get(`Mint-${score}`);
  };

  const veryHigh = schedule(95);
  const high = schedule(80);
  const standard = schedule(60);

  assert.ok(new Date(veryHigh.nextEligibleAt).getTime() - now <= 2500);
  assert.ok(new Date(high.nextEligibleAt).getTime() - now >= 9000);
  assert.ok(new Date(standard.nextEligibleAt).getTime() - now >= 19_000);
  assert.equal(veryHigh.isSurvivalWait, true);
  cleanup();
});

test('bot schedules indexing-lag retries and drops entries after the retry cap', () => {
  const { config, state, cleanup } = seedBotState({ rpcIndexingRetryDelayMs: 1234 });
  state.pendingCandidateRechecks.set('LagMint', {
    mint: 'LagMint',
    tokenSnapshot: { id: 'LagMint', symbol: 'LAG' },
    isFinalAudit: true,
    indexingLagRetries: 2,
  });

  scanner.scheduleIndexingLagRetry(
    bot.getCtx(),
    {
      recheckEntry: state.pendingCandidateRechecks.get('LagMint'),
      token: { id: 'LagMint', symbol: 'LAG' },
    },
    'RPC Indexing Lag'
  );

  const retried = state.pendingCandidateRechecks.get('LagMint');
  assert.equal(retried.indexingLagRetries, 3);
  assert.ok(new Date(retried.nextEligibleAt).getTime() > Date.now());
  assert.equal(state.metrics.finalAuditDeferredIndexing, 1);

  scanner.scheduleIndexingLagRetry(
    bot.getCtx(),
    {
      recheckEntry: retried,
      token: { id: 'LagMint', symbol: 'LAG' },
    },
    'RPC Indexing Lag'
  );

  assert.equal(state.pendingCandidateRechecks.has('LagMint'), false);
  assert.equal(config.rpcIndexingRetryDelayMs, 1234);
  cleanup();
});

test('bot holder-count waitlists use the dedicated holder wait duration', () => {
  const { state, cleanup } = seedBotState({ holderCountWaitlistSeconds: 42 });
  const now = Date.now();
  scanner.scheduleRecheckEligibleWaitlist(bot.getCtx(), { token: { id: 'HolderMint' } }, null, {
    lowHolderWaitlist: true,
  });

  const entry = state.pendingCandidateRechecks.get('HolderMint');
  const delayMs = new Date(entry.nextEligibleAt).getTime() - now;
  assert.ok(delayMs >= 41_000 && delayMs <= 43_000);
  cleanup();
});

test('bot skips borderline requeues entirely when borderline rechecks are disabled', async () => {
  const { state, cleanup } = seedBotState({
    borderlineRecheckEnabled: false,
    maxCandidatesPerScan: 5,
  });
  const token = { id: 'NoRequeueMint', symbol: 'NRQ', liquidity: 1000, usdPrice: 1 };

  await withPatchedMembers(
    services,
    {
      fetchRecentLaunches: async () => [token],
      evaluateCandidate: async () => ({
        approved: false,
        token,
        blockers: ['Low holders 1.'],
        rejectionReasons: [{ code: 'low-holders', recheckEligible: true }],
      }),
    },
    async () => {
      await scanner.scanForCandidates(bot.getCtx());
      assert.equal(state.pendingCandidateRechecks.size, 0);
      assert.equal(state.processedMints.has('NoRequeueMint'), true);
    }
  );
  cleanup();
});

test('bot cancels pullback rechecks when price deterioration exceeds the configured threshold', async () => {
  const { state, cleanup } = seedBotState({ recheckPriceDropPct: 10, maxCandidatesPerScan: 5 });
  state.pendingCandidateRechecks.set('PullbackMint', {
    mint: 'PullbackMint',
    tokenSnapshot: { id: 'PullbackMint', symbol: 'PBK', liquidity: 1000, usdPrice: 80 },
    highestSeenPriceUsd: 100,
    isFinalAudit: true,
  });

  const token = { id: 'PullbackMint', symbol: 'PBK', liquidity: 1000, usdPrice: 80 };
  await withPatchedMembers(
    services,
    {
      fetchRecentLaunches: async () => [token],
      evaluateCandidate: async () => ({
        approved: false,
        token,
        blockers: ['Buying the top detected.'],
        rejectionReasons: [{ code: 'buying-the-top', recheckEligible: true }],
      }),
    },
    async () => {
      await scanner.scanForCandidates(bot.getCtx());
      assert.equal(state.pendingCandidateRechecks.has('PullbackMint'), false);
      assert.equal(state.processedMints.has('PullbackMint'), true);
    }
  );
  cleanup();
});

test('bot counts reserved buy slots against the max open position limit', async () => {
  const { state, cleanup } = seedBotState({
    maxOpenPositions: 1,
    maxBuysPerScan: 2,
    maxCandidatesPerScan: 5,
    scanParallelismHeavy: 2,
  });
  const tokens = [
    { id: 'FinalMintA', symbol: 'FA', usdPrice: 1, liquidity: 2000 },
    { id: 'FinalMintB', symbol: 'FB', usdPrice: 1, liquidity: 2000 },
  ];

  for (const token of tokens) {
    state.pendingCandidateRechecks.set(token.id, {
      mint: token.id,
      tokenSnapshot: token,
      isFinalAudit: true,
      nextEligibleAt: new Date(Date.now() - 1000).toISOString(),
    });
  }

  let buyAttempts = 0;
  await withPatchedMembers(
    services,
    {
      fetchRecentLaunches: async () => tokens,
      evaluateCandidate: async (_ctx, token) => ({
        approved: true,
        token,
        blockers: [],
        rejectionReasons: [],
        candidateScore: 80,
      }),
      buyCandidate: async (_ctx, evaluation) => {
        buyAttempts++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        const pos = { mint: evaluation.token.id, symbol: evaluation.token.symbol };
        state.positions.set(evaluation.token.id, pos);
        return pos;
      },
    },
    async () => {
      await scanner.scanForCandidates(bot.getCtx());
    }
  );

  assert.equal(buyAttempts, 1);
  assert.equal(state.positions.size, 1);
  cleanup();
});
