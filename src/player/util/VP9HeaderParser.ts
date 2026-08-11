import { BitReader } from './BitReader';

export interface VP9FrameHeader {
  width: number;
  height: number;
  profile: number;
  bitDepth: number;
  /** VP9 spec §7.2.2's 3-bit `color_space` enum (0=unknown, 1=BT.601,
   * 2=BT.709, 3=SMPTE-170, 4=SMPTE-240, 5=BT.2020, 6=reserved, 7=RGB) — kept
   * as the raw VP9 enum value; callers needing ISO/IEC 23001-8 CICP
   * primaries/transfer/matrix values (e.g. for an MSE `vpcC` config box)
   * must map it themselves. */
  colorSpace: number;
  /** `1` = full swing (JPEG-style), `0` = studio swing (16-235-style). */
  colorRange: number;
  /** 4:2:0 chroma subsampling flags — always `1`/`1` for profile 0/2 (no
   * other subsampling exists for those profiles), parsed from the
   * bitstream for profile 1/3, and always `0`/`0` when `colorSpace` is RGB
   * (no subsampling at all). */
  subsamplingX: number;
  subsamplingY: number;
}

const VP9_FRAME_SYNC_CODE = [0x49, 0x83, 0x42];
const CS_RGB = 7;

/**
 * VP9 Bitstream & Decoding Process Spec §6.2 `uncompressed_header()` —
 * continues past what `VP9Session.parseFrameType` already reads
 * (`frame_marker`/profile bits/`show_existing_frame`/`frame_type`, all
 * within byte 0) through `frame_sync_code()` and `color_config()` into
 * `frame_size()`, to recover width/height/profile/bit-depth. Used by
 * `MediaRouter.getFrameSizeInfo` in place of an SPS parse — VP9 has no
 * SPS-equivalent parameter set, every keyframe is self-describing instead.
 *
 * Returns `null` for inter frames (no `frame_size()` here — VP9 inter frames
 * either reuse a reference frame's size or carry it via a different, more
 * involved path this parser doesn't implement) or anything truncated. This
 * is called on every frame, not just keyframes, so callers must treat
 * `null` as "no size info in this particular frame," not as an error.
 */
export function parseVP9FrameHeader(frameData: Uint8Array): VP9FrameHeader | null {
  if (frameData.length < 3) {
    return null;
  }
  const reader = new BitReader(frameData);

  const frameMarker = reader.readBits(2);
  if (frameMarker !== 0b10) {
    return null;
  }

  const profileLowBit = reader.readBits(1);
  const profileHighBit = reader.readBits(1);
  const profile = (profileHighBit << 1) | profileLowBit;
  if (profile === 3) {
    reader.readBits(1); // reserved_zero
  }

  const showExistingFrame = reader.readBits(1);
  if (showExistingFrame === 1) {
    return null;
  }

  const frameType = reader.readBits(1); // 0 = key frame
  if (frameType !== 0) {
    return null;
  }
  reader.readBits(1); // show_frame
  reader.readBits(1); // error_resilient_mode

  for (const expected of VP9_FRAME_SYNC_CODE) {
    if (reader.readBits(8) !== expected) {
      return null;
    }
  }

  // color_config()
  let bitDepth = 8;
  if (profile >= 2) {
    bitDepth = reader.readBits(1) === 1 ? 12 : 10;
  }
  const colorSpace = reader.readBits(3);
  let colorRange: number;
  let subsamplingX: number;
  let subsamplingY: number;
  if (colorSpace !== CS_RGB) {
    colorRange = reader.readBits(1);
    if (profile === 1 || profile === 3) {
      subsamplingX = reader.readBits(1);
      subsamplingY = reader.readBits(1);
      reader.readBits(1); // reserved_zero
    } else {
      subsamplingX = 1;
      subsamplingY = 1;
    }
  } else {
    colorRange = 1;
    subsamplingX = 0;
    subsamplingY = 0;
    if (profile === 1 || profile === 3) {
      reader.readBits(1); // reserved_zero
    }
  }

  // frame_size()
  const width = reader.readBits(16) + 1;
  const height = reader.readBits(16) + 1;

  if (reader.bitsRemaining() < 0) {
    return null;
  }

  return { width, height, profile, bitDepth, colorSpace, colorRange, subsamplingX, subsamplingY };
}
