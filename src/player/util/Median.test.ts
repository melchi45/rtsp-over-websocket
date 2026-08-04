import { describe, it, expect } from 'vitest';
import { loadLegacyModuleSlice } from '../test-support/loadLegacyModule';
import { Median } from './Median';

interface LegacyMedian {
  max(a: number[]): number;
  min(a: number[]): number;
  range(a: number[]): number;
  sum(a: number[]): number;
  mean(a: number[]): number;
  median(a: number[]): number;
  getMaxOfArray(a: number[]): number;
  getMinOfArray(a: number[]): number;
  findRangeAndCoefficient(a: number[]): number;
  modes(a: number[]): number[];
  variance(a: number[]): number;
  standardDeviation(a: number[]): number;
  meanAbsoluteDeviation(a: number[]): number;
  zScores(a: number[]): number[];
}

function loadLegacy(): LegacyMedian {
  const { Median: legacyMedian } = loadLegacyModuleSlice<{ Median: LegacyMedian }>('Util/util.js', [[918, 1015]], ['Median']);
  return legacyMedian;
}

describe('Median parity with the legacy player’s Util/util.js (window.Median)', () => {
  const sample = [4, 8, 15, 16, 23, 42];
  const sampleOdd = [7, 1, 5, 3, 9];

  it('max/min/sum/mean match legacy', () => {
    const legacy = loadLegacy();
    const ported = Median;
    expect(ported.max(sample)).toBe(legacy.max(sample));
    expect(ported.min(sample)).toBe(legacy.min(sample));
    expect(ported.sum(sample)).toBe(legacy.sum(sample));
    expect(ported.mean(sample)).toBe(legacy.mean(sample));
  });

  it('median matches legacy for both even- and odd-length arrays', () => {
    const legacy = loadLegacy();
    expect(Median.median([...sample])).toBe(legacy.median([...sample]));
    expect(Median.median([...sampleOdd])).toBe(legacy.median([...sampleOdd]));
  });

  it('variance/standardDeviation/meanAbsoluteDeviation/zScores match legacy', () => {
    const legacy = loadLegacy();
    expect(Median.variance(sample)).toBe(legacy.variance(sample));
    expect(Median.standardDeviation(sample)).toBe(legacy.standardDeviation(sample));
    expect(Median.meanAbsoluteDeviation(sample)).toBe(legacy.meanAbsoluteDeviation(sample));
    expect(Median.zScores(sample)).toEqual(legacy.zScores(sample));
  });

  it('findRangeAndCoefficient/getMaxOfArray/getMinOfArray match legacy', () => {
    const legacy = loadLegacy();
    expect(Median.findRangeAndCoefficient(sample)).toBe(legacy.findRangeAndCoefficient(sample));
    expect(Median.getMaxOfArray(sample)).toBe(legacy.getMaxOfArray(sample));
    expect(Median.getMinOfArray(sample)).toBe(legacy.getMinOfArray(sample));
  });

  it('modes matches legacy, including the empty-array edge case', () => {
    const legacy = loadLegacy();
    expect(Median.modes([1, 2, 2, 3, 3, 3])).toEqual(legacy.modes([1, 2, 2, 3, 3, 3]));
    expect(Median.modes([])).toEqual(legacy.modes([]));
  });

  // legacy's `range()` body is `Median.max(array) - arr.min(array)` — a real
  // bug (`arr` instead of `Median`) that throws ReferenceError: arr is not
  // defined in an actual browser (where `window.Median = {...}` also
  // creates the bare global `Median` that `Median.max(...)` itself relies
  // on, since window === globalThis there). This harness's sandbox uses a
  // separate `window` object from the vm context's own global scope (see
  // Size.test.ts's getHalfSize note for the same limitation), so calling
  // legacy.range() through it would incorrectly fail to resolve even the
  // bare `Median` reference — not a legacy behavior difference, just a
  // harness constraint. Asserted directly against the port instead.
  it('range()/midrange() throw a ReferenceError for the undeclared `arr` global (a real legacy bug: `arr.min(array)` instead of `Median.min(array)`)', () => {
    expect(() => Median.range(sample)).toThrow(new ReferenceError('arr is not defined'));
    expect(() => Median.midrange(sample)).toThrow(new ReferenceError('arr is not defined'));
  });
});
