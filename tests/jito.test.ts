import test from 'node:test';
import assert from 'node:assert/strict';
import { getDynamicJitoTip, confirmJitoBundle } from '../src/services/trading/trading.service.js';
import { createCtx, withMockedFetch } from './_test_helpers.js';

test('jito getDynamicJitoTip handles API floor correctly', async () => {
  const ctx = createCtx({
    jitoTipFloorApiUrl: 'http://mock-jito-tip',
    jitoTipPercentile: 75,
  });

  const mockResponse = {
    result: [
      {
        landed_tips_25th_percentile: 0.0001,
        landed_tips_50th_percentile: 0.0003,
        landed_tips_75th_percentile: 0.001,
        landed_tips_95th_percentile: 0.005,
        landed_tips_99th_percentile: 0.02,
      },
    ],
  };

  const fetched = await withMockedFetch(
    async (input) => {
      assert.equal(input, 'http://mock-jito-tip');
      return new Response(JSON.stringify(mockResponse));
    },
    async () => {
      return await getDynamicJitoTip(ctx, false);
    }
  );

  // 0.001 SOL * 1e9 = 1,000,000 lamports
  assert.equal(fetched, 1_000_000n);

  // Test isPanic multiplier
  const fetchedPanic = await withMockedFetch(
    async () => {
      return new Response(JSON.stringify(mockResponse));
    },
    async () => {
      return await getDynamicJitoTip(ctx, true);
    }
  );
  // 1,000,000 * 2 = 2,000,000 lamports
  assert.equal(fetchedPanic, 2_000_000n);
});

test('jito confirmJitoBundle polls status successfully', async () => {
  const ctx = createCtx({
    jitoTipFloorApiUrl: 'http://mock-jito-tip',
  });

  let pollCount = 0;
  const mockResponseNull = { result: null };
  const mockResponseConfirmed = {
    result: {
      value: [
        {
          bundle_id: 'bundle123',
          confirmationStatus: 'confirmed',
          err: null,
        },
      ],
    },
  };

  const confirmed = await withMockedFetch(
    async () => {
      pollCount++;
      if (pollCount === 1) {
        return new Response(JSON.stringify(mockResponseNull));
      }
      return new Response(JSON.stringify(mockResponseConfirmed));
    },
    async () => {
      return await confirmJitoBundle(ctx, 'bundle123', 5000);
    }
  );

  assert.equal(confirmed, true);
  assert.equal(pollCount, 2);
});
