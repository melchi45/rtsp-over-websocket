import { describe, it, expect } from 'vitest';
import { loadLegacyModuleSlice } from '../test-support/loadLegacyModule';
import { Mean } from './Mean';

interface LegacyMean {
  count: number;
  sum: number;
  record(val: number): void;
  variance(val: number): number;
  mean(): string | number;
}

function newLegacy(): LegacyMean {
  const { Mean: LegacyMeanCtor } = loadLegacyModuleSlice<{ Mean: new () => LegacyMean }>('Util/util.js', [[1019, 1035]], ['Mean']);
  return new LegacyMeanCtor();
}

describe('Mean parity with the legacy player’s Util/util.js (window.Mean)', () => {
  it('mean() returns the number 0 (not a string) before any value is recorded', () => {
    const legacy = newLegacy();
    const ported = new Mean();
    expect(ported.mean()).toBe(legacy.mean());
    expect(ported.mean()).toBe(0);
  });

  it('record()+mean() track a running average, returned as a fixed(3) string once count > 0', () => {
    const legacy = newLegacy();
    const ported = new Mean();
    for (const v of [10, 20, 15, 7]) {
      legacy.record(v);
      ported.record(v);
    }
    expect(ported.count).toBe(legacy.count);
    expect(ported.sum).toBe(legacy.sum);
    expect(ported.mean()).toBe(legacy.mean());
    expect(ported.mean()).toBe('13.000');
  });

  it('variance(val) uses the current mean identically', () => {
    const legacy = newLegacy();
    const ported = new Mean();
    [4, 8, 15].forEach((v) => {
      legacy.record(v);
      ported.record(v);
    });
    expect(ported.variance(10)).toBe(legacy.variance(10));
  });
});
