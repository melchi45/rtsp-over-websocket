import { describe, it, expect } from 'vitest';
import { loadLegacyModuleSlice } from '../test-support/loadLegacyModule';
import { formatBytes, formatBps } from './formatBytes';

function legacyFormatBytes(bytes: number): string {
  const { formatBytes: fn } = loadLegacyModuleSlice<{ formatBytes: (b: number) => string }>('Util/util.js', [[26, 31]], ['formatBytes']);
  return fn(bytes);
}

function legacyFormatBps(bits: number): string {
  const { formatBps: fn } = loadLegacyModuleSlice<{ formatBps: (b: number) => string }>('Util/util.js', [[19, 24]], ['formatBps']);
  return fn(bits);
}

describe('formatBytes/formatBps parity with the legacy player’s Util/util.js', () => {
  it('formatBytes formats each unit tier identically', () => {
    for (const bytes of [500, 2048, 5 * 1048576, 3 * 1073741824]) {
      expect(formatBytes(bytes)).toBe(legacyFormatBytes(bytes));
    }
  });

  it('formatBps formats each unit tier identically', () => {
    for (const bits of [500, 2048, 5 * 1048576, 3 * 1073741824]) {
      expect(formatBps(bits)).toBe(legacyFormatBps(bits));
    }
  });
});
