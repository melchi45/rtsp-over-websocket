import { describe, expect, it } from 'vitest';
import { buildAV1CodecString, buildVP9CodecString, defaultRealMseCodecString, mjpegEncoderCandidateCodecStrings } from './codecString';

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

  it('picks Level 3.1 (+3.2 fallback) for a 1280x720@30fps stream', () => {
    expect(mjpegEncoderCandidateCodecStrings(1280 * 720, 30)).toEqual(['avc1.42001f', 'avc1.64001f', 'avc1.420020', 'avc1.640020']);
  });

  it('picks Level 5.0 (+5.1 fallback), not 3.1/4.0, for a real 2048x1536 camera resolution -- the exact case that failed live before this became resolution-aware', () => {
    expect(mjpegEncoderCandidateCodecStrings(2048 * 1536, 30)).toEqual(['avc1.420032', 'avc1.640032', 'avc1.420033', 'avc1.640033']);
  });

  it('picks Level 4.0 (+4.1 fallback) for a 1920x1080@30fps stream', () => {
    expect(mjpegEncoderCandidateCodecStrings(1920 * 1080, 30)).toEqual(['avc1.420028', 'avc1.640028', 'avc1.420029', 'avc1.640029']);
  });

  it('defaults to a 30fps assumption when framerate is omitted/falsy (e.g. an MJPEG stream with no known framerate yet)', () => {
    expect(mjpegEncoderCandidateCodecStrings(1280 * 720)).toEqual(mjpegEncoderCandidateCodecStrings(1280 * 720, 30));
    expect(mjpegEncoderCandidateCodecStrings(1280 * 720, 0)).toEqual(mjpegEncoderCandidateCodecStrings(1280 * 720, 30));
  });

  it('does not return duplicate level candidates when the top of the level table is reached', () => {
    const candidates = mjpegEncoderCandidateCodecStrings(9000 * 6000, 30); // far beyond Level 6.2
    expect(candidates).toEqual(['avc1.42003e', 'avc1.64003e']);
  });
});
