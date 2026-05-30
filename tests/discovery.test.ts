'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DiscoveryService,
  handleDiscoveryProgramLog,
} from '../src/services/discovery/discovery.service.js';
import { createCtx } from './_test_helpers.js';
import {
  PUMP_FUN_PROGRAM_ID,
  RAYDIUM_AMM_V4_PROGRAM_ID,
  METEORA_DLMM_PROGRAM_ID,
} from '../src/core/config.js';

test('discovery handleLog parses Pump.fun create logs correctly', () => {
  const service = new DiscoveryService();
  const ctx = createCtx();
  let flushCalled = false;

  const logInfo = {
    signature: 'SigPump1',
    logs: [
      'Instruction: Create',
      'Program log: Create { name: "Test", symbol: "TST", uri: "", mint: MintPump1 }',
    ],
  };

  service.handleLog(ctx, logInfo, PUMP_FUN_PROGRAM_ID, () => {
    flushCalled = true;
  });

  assert.ok(flushCalled);
  assert.equal((service as any).pendingMints.get('MintPump1'), PUMP_FUN_PROGRAM_ID);
});

test('discovery handleLog parses Raydium initialization logs correctly', () => {
  const service = new DiscoveryService();
  const ctx = createCtx();
  let flushCalled = false;

  const logInfo = {
    signature: 'SigRay1',
    logs: ['Instruction: Initialize2', 'Program log: init pool info'],
  };

  service.handleLog(ctx, logInfo, RAYDIUM_AMM_V4_PROGRAM_ID, () => {
    flushCalled = true;
  });

  assert.ok(flushCalled);
  assert.equal((service as any).pendingSignatures.get('SigRay1'), RAYDIUM_AMM_V4_PROGRAM_ID);
});

test('discovery handleLog parses Meteora initialization logs correctly', () => {
  const service = new DiscoveryService();
  const ctx = createCtx();
  let flushCalled = false;

  const logInfo = {
    signature: 'SigMet1',
    logs: ['Instruction: CreateLbPair', 'Program log: init lb pair info'],
  };

  service.handleLog(ctx, logInfo, METEORA_DLMM_PROGRAM_ID, () => {
    flushCalled = true;
  });

  assert.ok(flushCalled);
  assert.equal((service as any).pendingSignatures.get('SigMet1'), METEORA_DLMM_PROGRAM_ID);
});

test('discovery flush triggers runLoop with identified candidates', async () => {
  const service = new DiscoveryService();
  const ctx = createCtx({ discoveryWsDebounceMs: 1 });

  (service as any).pendingMints.set('MintPump1', PUMP_FUN_PROGRAM_ID);
  (service as any).pendingSignatures.set('SigRay1', RAYDIUM_AMM_V4_PROGRAM_ID);

  // Mock getTransaction RPC call for the signature fallback
  ctx.rpc = {
    getTransaction: (sig: string) => {
      assert.equal(sig, 'SigRay1');
      return {
        send: async () => ({
          meta: { innerInstructions: [] },
          transaction: {
            message: {
              instructions: [
                {
                  parsed: {
                    type: 'initializeMint',
                    info: { mint: 'MintRay1' },
                  },
                },
              ],
            },
          },
        }),
      };
    },
  } as any;
  ctx.rpcs = [ctx.rpc];

  let loopReq: any = null;
  await service.flush(ctx, async (req) => {
    loopReq = req;
  });

  assert.ok(loopReq);
  assert.equal(loopReq.reason, 'ws-mint-init');
  assert.deepEqual(loopReq.mints, ['MintPump1', 'MintRay1']);
  assert.equal(loopReq.mintLaunchpads['MintPump1'], 'pump.fun');
  assert.equal(loopReq.mintLaunchpads['MintRay1'], 'raydium');
});

test('discovery service subscribe and stop lifecycle', async () => {
  const service = new DiscoveryService();
  const logCalls: any[] = [];
  const ctx = createCtx();
  ctx.logger = (msg: string) => {
    logCalls.push(msg);
  };

  let subscribeAbortSignal: AbortSignal | null = null;
  const mockSub = {
    logsNotifications: (_filters: any) => {
      return {
        subscribe: async (options: any) => {
          subscribeAbortSignal = options.abortSignal;
          return {
            async *[Symbol.asyncIterator]() {
              yield { value: { signature: 'sig', logs: ['Instruction: Create'] } };
            },
          };
        },
      };
    },
    slotNotifications: () => {
      return {
        subscribe: async () => {
          return {
            async *[Symbol.asyncIterator]() {
              yield { slot: 123 };
            },
          };
        },
      };
    },
  };

  ctx.rpcSubscriptions = mockSub as any;
  ctx.getCurrentRpcSubscriptions = () => mockSub as any;

  let flushCalled = false;
  await service.subscribe(ctx, PUMP_FUN_PROGRAM_ID, () => {
    flushCalled = true;
  });

  assert.ok(service.websocketReady);
  assert.ok(subscribeAbortSignal);
  assert.equal((subscribeAbortSignal as AbortSignal).aborted, false);
  assert.ok(flushCalled);

  service.stop();
  assert.equal((subscribeAbortSignal as AbortSignal).aborted, true);
});

test('discovery watchdog timer restarts stale subscriptions', async () => {
  const service = new DiscoveryService();
  const ctx = createCtx({ websocketWatchdogIntervalMs: 2, websocketStaleThresholdMs: 2 });

  let restartCount = 0;
  service.subscribe = async () => {
    restartCount++;
  };
  (service as any).subscribeGlobalHeartbeat = async () => {};

  let rotateCount = 0;
  ctx.rotateRpcSubscriptions = () => {
    rotateCount++;
  };

  // Mock global heartbeat to look stale
  (service as any).lastGlobalEventAt = Date.now() - 100000;

  (service as any).startWatchdog(ctx, () => {});

  await new Promise((resolve) => setTimeout(resolve, 50));

  service.stop();
  assert.ok(rotateCount > 0);
  assert.ok(restartCount > 0);
});

test('discovery module wrapper exports function correctly', async () => {
  const ctx = createCtx();
  let logCalled = false;
  handleDiscoveryProgramLog(ctx, { signature: 'sig', logs: [] }, PUMP_FUN_PROGRAM_ID, () => {
    logCalled = true;
  });
  // Should call handleLog internally and trigger callback
  assert.ok(!logCalled); // signature logs are empty, no match
});
