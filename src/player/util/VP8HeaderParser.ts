export interface VP8FrameHeader {
  width: number;
  height: number;
}

const VP8_START_CODE = [0x9d, 0x01, 0x2a];

/**
 * RFC 6386 §9.1 — VP8's 3-byte uncompressed data chunk tag, plus (on a
 * keyframe only) the 3-byte start code and two 16-bit little-endian
 * width/height-and-scale fields immediately following it. Used by
 * `MediaRouter.getFrameSizeInfo` in place of an SPS parse — VP8 has no
 * SPS-equivalent parameter set, every keyframe is self-describing instead.
 *
 * Returns `null` for inter frames (no size fields present at all) or
 * anything too short/malformed to be a keyframe tag — this is called on
 * every frame, not just keyframes, so callers must treat `null` as "no size
 * info in this particular frame," not as an error.
 */
export function parseVP8FrameHeader(frameData: Uint8Array): VP8FrameHeader | null {
  if (frameData.length < 10) {
    return null;
  }

  const isKeyFrame = (frameData[0] & 0x01) === 0;
  if (!isKeyFrame) {
    return null;
  }
  if (frameData[3] !== VP8_START_CODE[0] || frameData[4] !== VP8_START_CODE[1] || frameData[5] !== VP8_START_CODE[2]) {
    return null;
  }

  const widthAndScale = frameData[6] | (frameData[7] << 8);
  const heightAndScale = frameData[8] | (frameData[9] << 8);

  return { width: widthAndScale & 0x3fff, height: heightAndScale & 0x3fff };
}
