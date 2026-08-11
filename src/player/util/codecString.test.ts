import { describe, expect, it } from 'vitest';
import { buildAV1CodecString, buildVP9CodecString, defaultRealMseCodecString } from './codecString';

describe('codecString', () => {
  it('builds a VP9 codec string with the fixed level component', () => {
    expect(buildVP9CodecString(0, 8)).toBe('vp09.00.10.08');
    expect(buildVP9CodecString(2, 10)).toBe('vp09.02.10.10');
  });

  it('builds an AV1 codec string with Main/High tier letters', () => {
    expect(buildAV1CodecString(0, 4, 0, 8)).toBe('av01.0.04M.08');
    expect(buildAV1CodecString(1, 13, 1, 10)).toBe('av01.1.13H.10');
  });

  it('returns the spike-verified default candidate strings for VP9/AV1, and null for VP8', () => {
    expect(defaultRealMseCodecString('VP9')).toBe('vp09.00.10.08');
    expect(defaultRealMseCodecString('AV1')).toBe('av01.0.04M.08');
    expect(defaultRealMseCodecString('VP8')).toBeNull();
  });
});
