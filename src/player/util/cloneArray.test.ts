import { describe, it, expect } from 'vitest';
import { loadLegacyModuleSlice } from '../test-support/loadLegacyModule';
import { cloneArray } from './cloneArray';

function legacyCloneArray(array: Uint8Array): Uint8Array {
  const { cloneArray: fn } = loadLegacyModuleSlice<{ cloneArray: (a: Uint8Array) => Uint8Array }>('Util/util.js', [[1438, 1443]], ['cloneArray']);
  return fn(array);
}

describe('cloneArray parity with the legacy player’s Util/util.js (window.cloneArray)', () => {
  it('produces an equal but distinct copy of the input typed array', () => {
    const source = new Uint8Array([1, 2, 3, 4, 5]);
    const legacyResult = legacyCloneArray(source);
    const portedResult = cloneArray(source);

    expect(Array.from(portedResult)).toEqual(Array.from(legacyResult));
    expect(portedResult).not.toBe(source);
    expect(portedResult.buffer).not.toBe(source.buffer);
  });

  it('respects a non-zero byteOffset (subarray view) identically', () => {
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
    const view = backing.subarray(2, 5); // [1,2,3], byteOffset=2

    const legacyResult = legacyCloneArray(view);
    const portedResult = cloneArray(view);

    expect(Array.from(portedResult)).toEqual([1, 2, 3]);
    expect(Array.from(portedResult)).toEqual(Array.from(legacyResult));
  });

  it('mutating the clone does not affect the original, identically', () => {
    const source = new Uint8Array([1, 2, 3]);
    const portedResult = cloneArray(source);
    portedResult[0] = 99;
    expect(source[0]).toBe(1);
  });
});
