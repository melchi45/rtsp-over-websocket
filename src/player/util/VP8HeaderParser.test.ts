import { describe, expect, it } from 'vitest';
import { parseVP8FrameHeader } from './VP8HeaderParser';

function buildVP8KeyframeTag(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0x00,
    0x00,
    0x00, // frame tag: frame_type=0 (key frame); version/show_frame/first_part_size unused by the parser
    0x9d,
    0x01,
    0x2a, // start code
    width & 0xff,
    (width >> 8) & 0x3f, // width (14 bits) + horizontal_scale (2 bits, left 0)
    height & 0xff,
    (height >> 8) & 0x3f // height (14 bits) + vertical_scale (2 bits, left 0)
  ]);
}

describe('parseVP8FrameHeader', () => {
  it('extracts width/height from a keyframe tag + start code', () => {
    expect(parseVP8FrameHeader(buildVP8KeyframeTag(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it('extracts a width/height needing the full 14 bits', () => {
    expect(parseVP8FrameHeader(buildVP8KeyframeTag(0x3fff, 0x3fff))).toEqual({ width: 0x3fff, height: 0x3fff });
  });

  it('returns null for an inter frame (frame_type bit set)', () => {
    const frame = buildVP8KeyframeTag(640, 480);
    frame[0] |= 0x01;
    expect(parseVP8FrameHeader(frame)).toBeNull();
  });

  it('returns null when the start code does not match', () => {
    const frame = buildVP8KeyframeTag(640, 480);
    frame[3] = 0x00;
    expect(parseVP8FrameHeader(frame)).toBeNull();
  });

  it('returns null for input shorter than the tag+start-code+size fields', () => {
    expect(parseVP8FrameHeader(new Uint8Array(9))).toBeNull();
  });
});
