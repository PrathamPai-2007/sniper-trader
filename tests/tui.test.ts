'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { TuiService } from '../src/services/tui.service.js';
import { createCtx } from './_test_helpers.js';

test('tui refresh reads the live backpressure factor from context', () => {
  const ctx = createCtx();
  ctx.getBackpressureFactor = () => 0.5;

  const tui = new TuiService(ctx);
  let status = '';
  (tui as any).statusBar = {
    setContent: (content: string) => {
      status = content;
    },
  };

  try {
    tui.enable();
    tui.refresh();
    assert.match(status, /BP:.*50%/);
  } finally {
    tui.disable();
  }
});

test('tui schedules renders for recheck and trade-history store events', () => {
  const ctx = createCtx();
  const tui = new TuiService(ctx);
  let renders = 0;
  (tui as any).scheduleRender = () => {
    renders += 1;
  };

  try {
    (ctx.store as any).emit('recheckEntryUpserted', { mint: 'mint-a' });
    (ctx.store as any).emit('recheckEntryRemoved', 'mint-a');
    (ctx.store as any).emit('tradeResultAdded', true);

    assert.equal(renders, 3);
  } finally {
    tui.disable();
  }
});

test('tui shutdown request emits one graceful signal even if triggered repeatedly', () => {
  const ctx = createCtx();
  const tui = new TuiService(ctx);
  const originalEmit = process.emit;
  const signals: string[] = [];

  process.emit = ((event: string | symbol, ...args: any[]) => {
    if (event === 'SIGINT') {
      signals.push(event);
      return true;
    }
    return originalEmit.call(process, event, ...args);
  }) as typeof process.emit;

  try {
    (tui as any)._requestShutdown('SIGINT');
    (tui as any)._requestShutdown('SIGINT');

    assert.deepEqual(signals, ['SIGINT']);
  } finally {
    process.emit = originalEmit;
    tui.disable();
  }
});

test('tui updates tables with correct 2D array format', () => {
  const ctx = createCtx();
  const tui = new TuiService(ctx);

  let positionsData: any[] = [];
  (tui as any).positionsTable = {
    setData: (data: any) => {
      positionsData = data;
    },
  };

  let discoveryData: any[] = [];
  (tui as any).discoveryFeed = {
    setData: (data: any) => {
      discoveryData = data;
    },
  };

  try {
    // Mock store data
    ctx.store.state.positions.set('mint-a', {
      symbol: 'TEST',
      entryPriceUsd: 1,
      lastKnownPriceUsd: 1.1,
      targetsHit: 2,
    } as any);

    ctx.store.state.pendingCandidateRechecks.set('mint-b', {
      mint: 'mint-b-long-address',
      candidateScore: 85,
      isFinalAudit: true,
      tokenSnapshot: { symbol: 'CANDY' },
    } as any);

    (tui as any)._updatePositionsTable();
    (tui as any)._updateDiscoveryFeed();

    // Check positions table
    assert.equal(positionsData.length, 2); // Header + 1 row
    assert.deepEqual(positionsData[0], ['Symbol', 'Entry', 'Current', 'PnL%', 'TPs']);
    assert.equal(positionsData[1][0], 'TEST');
    assert.match(positionsData[1][3], /10.00%/);

    // Check discovery feed
    assert.equal(discoveryData.length, 2); // Header + 1 row
    assert.deepEqual(discoveryData[0], ['Symbol', 'Score', 'Mint', 'Status']);
    assert.equal(discoveryData[1][0], 'CANDY');
    assert.equal(discoveryData[1][1], '85');
    assert.equal(discoveryData[1][3], 'Auditing');
  } finally {
    tui.disable();
  }
});
