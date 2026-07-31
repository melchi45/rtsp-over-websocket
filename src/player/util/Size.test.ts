import { describe, it, expect } from 'vitest';
import { loadLegacyModuleSlice } from '../test-support/loadLegacyModule';
import { Size } from './Size';

interface LegacySize {
  w: number;
  h: number;
  viewWidth?: number;
  viewHeight?: number;
  toString(): string;
  getHalfSize(): LegacySize;
  length(): number;
}

function newLegacy(width: number, height: number, viewWidth?: number, viewHeight?: number): LegacySize {
  const { Size: LegacySizeCtor } = loadLegacyModuleSlice<{ Size: (w: number, h: number, vw?: number, vh?: number) => LegacySize }>(
    'Util/util.js',
    [[1279, 1302]],
    ['Size']
  );
  return LegacySizeCtor(width, height, viewWidth, viewHeight);
}

describe('Size parity with the legacy player’s Util/util.js (window.Size)', () => {
  it('exposes w/h identically and leaves viewWidth/viewHeight undefined when omitted', () => {
    const legacy = newLegacy(640, 480);
    const ported = new Size(640, 480);
    expect(ported.w).toBe(legacy.w);
    expect(ported.h).toBe(legacy.h);
    expect(ported.viewWidth).toBe(legacy.viewWidth);
    expect(ported.viewHeight).toBe(legacy.viewHeight);
  });

  it('exposes viewWidth/viewHeight identically when provided', () => {
    const legacy = newLegacy(320, 240, 640, 480);
    const ported = new Size(320, 240, 640, 480);
    expect(ported.viewWidth).toBe(legacy.viewWidth);
    expect(ported.viewHeight).toBe(legacy.viewHeight);
  });

  it('toString() formats identically', () => {
    const legacy = newLegacy(1920, 1080);
    const ported = new Size(1920, 1080);
    expect(ported.toString()).toBe(legacy.toString());
  });

  it('getHalfSize() halves both dimensions (unsigned right shift) identically', () => {
    for (const [w, h] of [
      [640, 480],
      [641, 481],
      [1, 0]
    ]) {
      const legacy = newLegacy(w, h).getHalfSize();
      const ported = new Size(w, h).getHalfSize();
      expect(ported.w).toBe(legacy.w);
      expect(ported.h).toBe(legacy.h);
      expect(ported.w).toBe(w >>> 1);
      expect(ported.h).toBe(h >>> 1);
    }
  });

  it('length() multiplies w*h identically', () => {
    const legacy = newLegacy(100, 50);
    const ported = new Size(100, 50);
    expect(ported.length()).toBe(legacy.length());
    expect(ported.length()).toBe(5000);
  });
});
