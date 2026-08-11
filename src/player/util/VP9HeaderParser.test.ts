import { describe, expect, it } from 'vitest';
import { parseVP9FrameHeader } from './VP9HeaderParser';
import { BitWriterTestUtil } from './BitWriterTestUtil';

const CS_BT_601 = 1;
const CS_RGB = 7;

function buildVP9KeyframeHeader(
  width: number,
  height: number,
  profile = 0,
  options: { colorSpace?: number; colorRange?: number; subsamplingX?: number; subsamplingY?: number } = {}
): Uint8Array {
  const colorSpace = options.colorSpace ?? CS_BT_601;
  const writer = new BitWriterTestUtil();
  writer.writeBits(0b10, 2); // frame_marker
  writer.writeBits(profile & 0x1, 1); // profile_low_bit
  writer.writeBits((profile >> 1) & 0x1, 1); // profile_high_bit
  if (profile === 3) {
    writer.writeBits(0, 1); // reserved_zero
  }
  writer.writeBits(0, 1); // show_existing_frame
  writer.writeBits(0, 1); // frame_type = key frame
  writer.writeBits(1, 1); // show_frame
  writer.writeBits(0, 1); // error_resilient_mode
  writer.writeBits(0x49, 8);
  writer.writeBits(0x83, 8);
  writer.writeBits(0x42, 8); // frame_sync_code
  if (profile >= 2) {
    writer.writeBits(0, 1); // ten_or_twelve_bit -> 10-bit
  }
  writer.writeBits(colorSpace, 3);
  if (colorSpace !== CS_RGB) {
    writer.writeBits(options.colorRange ?? 1, 1); // color_range
    if (profile === 1 || profile === 3) {
      writer.writeBits(options.subsamplingX ?? 1, 1);
      writer.writeBits(options.subsamplingY ?? 1, 1);
      writer.writeBits(0, 1); // reserved_zero
    }
  } else if (profile === 1 || profile === 3) {
    writer.writeBits(0, 1); // reserved_zero
  }
  writer.writeBits(width - 1, 16); // frame_width_minus_1
  writer.writeBits(height - 1, 16); // frame_height_minus_1
  return writer.toBytes();
}

describe('parseVP9FrameHeader', () => {
  it('extracts width/height/profile/bitDepth/color fields from a profile-0 keyframe', () => {
    expect(parseVP9FrameHeader(buildVP9KeyframeHeader(1280, 720, 0))).toEqual({
      width: 1280,
      height: 720,
      profile: 0,
      bitDepth: 8,
      colorSpace: CS_BT_601,
      colorRange: 1,
      subsamplingX: 1,
      subsamplingY: 1
    });
  });

  it('extracts a profile-2 (10-bit) keyframe', () => {
    expect(parseVP9FrameHeader(buildVP9KeyframeHeader(1920, 1080, 2))).toEqual({
      width: 1920,
      height: 1080,
      profile: 2,
      bitDepth: 10,
      colorSpace: CS_BT_601,
      colorRange: 1,
      subsamplingX: 1,
      subsamplingY: 1
    });
  });

  it('extracts explicit subsampling bits for a profile-1 keyframe (4:2:2)', () => {
    const header = buildVP9KeyframeHeader(640, 480, 1, { subsamplingX: 1, subsamplingY: 0 });
    expect(parseVP9FrameHeader(header)).toEqual({
      width: 640,
      height: 480,
      profile: 1,
      bitDepth: 8,
      colorSpace: CS_BT_601,
      colorRange: 1,
      subsamplingX: 1,
      subsamplingY: 0
    });
  });

  it('treats CS_RGB as full-range with no subsampling', () => {
    const header = buildVP9KeyframeHeader(320, 240, 0, { colorSpace: CS_RGB });
    expect(parseVP9FrameHeader(header)).toEqual({
      width: 320,
      height: 240,
      profile: 0,
      bitDepth: 8,
      colorSpace: CS_RGB,
      colorRange: 1,
      subsamplingX: 0,
      subsamplingY: 0
    });
  });

  it('returns null for an inter frame (frame_type=1, no frame_size present)', () => {
    const writer = new BitWriterTestUtil();
    writer.writeBits(0b10, 2);
    writer.writeBits(0, 1);
    writer.writeBits(0, 1);
    writer.writeBits(0, 1); // show_existing_frame
    writer.writeBits(1, 1); // frame_type = inter frame
    expect(parseVP9FrameHeader(writer.toBytes())).toBeNull();
  });

  it('returns null when show_existing_frame is set', () => {
    const writer = new BitWriterTestUtil();
    writer.writeBits(0b10, 2);
    writer.writeBits(0, 1);
    writer.writeBits(0, 1);
    writer.writeBits(1, 1); // show_existing_frame
    expect(parseVP9FrameHeader(writer.toBytes())).toBeNull();
  });

  it('returns null for a bad frame_marker', () => {
    const writer = new BitWriterTestUtil();
    writer.writeBits(0b01, 2);
    expect(parseVP9FrameHeader(writer.toBytes())).toBeNull();
  });

  it('returns null for input truncated before frame_size', () => {
    const writer = new BitWriterTestUtil();
    writer.writeBits(0b10, 2);
    writer.writeBits(0, 1);
    writer.writeBits(0, 1);
    writer.writeBits(0, 1); // show_existing_frame
    writer.writeBits(0, 1); // frame_type = key
    writer.writeBits(1, 1); // show_frame
    writer.writeBits(0, 1); // error_resilient_mode
    writer.writeBits(0x49, 8);
    writer.writeBits(0x83, 8);
    writer.writeBits(0x42, 8);
    writer.writeBits(CS_BT_601, 3);
    writer.writeBits(1, 1);
    // no frame_size bits written
    expect(parseVP9FrameHeader(writer.toBytes())).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseVP9FrameHeader(new Uint8Array(0))).toBeNull();
  });
});
