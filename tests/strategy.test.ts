'use strict';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { loadStrategy, validateStrategy } from '../src/core/config.js';

test('strategy loader loads valid standard strategy', () => {
  const strategy = loadStrategy('standard');
  assert.equal(typeof strategy, 'object');
  assert.equal(strategy.minLiquidityUsd, 500);
  assert.ok(strategy.takeProfitMultiples.includes(1.3));
});

test('strategy loader falls back to standard for deleted conservative strategy', () => {
  const strategy = loadStrategy('conservative');
  assert.equal(typeof strategy, 'object');
  // Should fall back to standard values
  assert.equal(strategy.stopLossPct, 0.18);
});

test('strategy loader loads custom strategy by arbitrary filename', () => {
  const strategy = loadStrategy('custom-alpha');
  assert.equal(typeof strategy, 'object');
  assert.equal(strategy.name, 'My Custom Strategy');
  assert.equal(strategy.minLiquidityUsd, 777);
  assert.equal(strategy.stopLossPct, 0.07);
});

test('strategy loader falls back to standard for missing strategy', () => {
  const strategy = loadStrategy('non-existent');
  assert.equal(typeof strategy, 'object');
  // Should have standard values
  assert.equal(strategy.stopLossPct, 0.18);
});

test('validateStrategy rejects invalid stopLossPct', () => {
  const invalidStrategy = {
    stopLossPct: 1.5,
    takeProfitMultiples: [1.3],
  } as any;
  assert.throws(() => validateStrategy(invalidStrategy), /stopLossPct/);
});

test('validateStrategy rejects empty takeProfitMultiples', () => {
  const invalidStrategy = {
    stopLossPct: 0.1,
    takeProfitMultiples: [],
  } as any;
  assert.throws(() => validateStrategy(invalidStrategy), /takeProfitMultiples/);
});

test('strategy loader handles malformed yaml by falling back', () => {
  const malformedPath = path.resolve(process.cwd(), 'strategies', 'malformed.yaml');
  fs.writeFileSync(malformedPath, 'name: [unclosed bracket');

  try {
    const strategy = loadStrategy('malformed');
    assert.equal(strategy.stopLossPct, 0.18); // fallback to standard
  } finally {
    if (fs.existsSync(malformedPath)) fs.unlinkSync(malformedPath);
  }
});
