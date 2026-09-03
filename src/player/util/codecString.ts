const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * VP9 codec string per the WebM Codecs spec: `vp09.PP.LL.DD`. VP9's own
 * bitstream carries no per-keyframe level field (see mp4Generator.js's
 * `vpcC()` comment, which sets the box's `level` to `0`/"unspecified" for
 * the same reason) — the level component here is always the fixed "10",
 * matching this player's existing WebCodecs fallback candidate
 * (`WebCodecsVideoDecoder.ts`'s `candidateCodecStrings()`).
 */
export function buildVP9CodecString(profile: number, bitDepth: number): string {
  return `vp09.${pad2(profile)}.10.${pad2(bitDepth)}`;
}

/**
 * AV1 codec string per the AV1 Codec ISO Media File Format Binding's
 * "Codecs Parameter String" section: `av01.P.LLT.DD`, where LL is
 * `seq_level_idx[0]` and T is 'M' (Main tier) or 'H' (High tier) —
 * both now available from `AV1HeaderParser`'s extended `AV1FrameHeader`.
 */
export function buildAV1CodecString(profile: number, seqLevelIdx0: number, seqTier0: number, bitDepth: number): string {
  const tier = seqTier0 === 1 ? 'H' : 'M';
  return `av01.${profile}.${pad2(seqLevelIdx0)}${tier}.${pad2(bitDepth)}`;
}

/**
 * A representative, profile-0/8-bit real-MSE codec string for an early
 * (pre-keyframe) real-MSE-vs-bridge tier probe — before any frame has
 * arrived there is no parsed header yet to build the *real* string from,
 * but profile 0/8-bit is overwhelmingly the common case for camera-
 * generated RTP streams (same assumption `WebCodecsVideoDecoder.ts`'s
 * `candidateCodecStrings()` already makes for its own WebCodecs
 * `configure()` fallback list — these two literal strings are exactly
 * its first candidates, confirmed via `MediaSource.isTypeSupported` in a
 * pre-implementation spike against a real Chromium build). Returns `null`
 * for VP8, which has no real-MSE tier at all (confirmed live:
 * `MediaSource.isTypeSupported` returns `false` for every
 * `video/mp4;codecs="vp8"`/`"vp08"` variant tried — VP8-in-MP4 was never a
 * real browser-invested combination, unlike VP8-in-WebM).
 */
export function defaultRealMseCodecString(codecType: string): string | null {
  switch (codecType) {
    case 'VP9':
      return buildVP9CodecString(0, 8);
    case 'AV1':
      return buildAV1CodecString(0, 4, 0, 8);
    default:
      return null;
  }
}

/**
 * ITU-T H.264 Annex A Table A-1 level limits: `maxFS` (max frame size,
 * macroblocks/frame) and `maxMBPS` (max macroblock processing rate,
 * macroblocks/sec), for every level from 3.0 up (sub-VGA levels 1.x/2.x are
 * skipped -- no real camera resolution this player targets needs them).
 * `levelHex` is the level_idc byte (level x 10) as the zero-padded hex pair
 * an `avc1.PPCCLL` codec string's `LL` component needs directly.
 *
 * A *fixed* level (this function's previous shape: always `avc1.42001f`/
 * `avc1.640028`, Level 3.1/4.0) silently failed `VideoEncoder.
 * isConfigSupported()` for any resolution its MaxFS doesn't cover --
 * confirmed live against a real Hanwha camera at 2048x1536 (128x96 = 12,288
 * macroblocks/frame), which exceeds even Level 4.0's 8,192 MaxFS and needs
 * Level 5.0 (22,080) at minimum. MJPEG cameras have no codec-level
 * resolution ceiling the way H264/H265 do, so this needed to become
 * resolution-aware rather than guessing a "common" one.
 */
const H264_LEVEL_LIMITS: { levelHex: string; maxFS: number; maxMBPS: number }[] = [
  { levelHex: '1e', maxFS: 1_620, maxMBPS: 40_500 }, // 3.0
  { levelHex: '1f', maxFS: 3_600, maxMBPS: 108_000 }, // 3.1
  { levelHex: '20', maxFS: 5_120, maxMBPS: 216_000 }, // 3.2
  { levelHex: '28', maxFS: 8_192, maxMBPS: 245_760 }, // 4.0
  { levelHex: '29', maxFS: 8_192, maxMBPS: 245_760 }, // 4.1
  { levelHex: '2a', maxFS: 8_704, maxMBPS: 522_240 }, // 4.2
  { levelHex: '32', maxFS: 22_080, maxMBPS: 589_824 }, // 5.0
  { levelHex: '33', maxFS: 36_864, maxMBPS: 983_040 }, // 5.1
  { levelHex: '34', maxFS: 36_864, maxMBPS: 2_073_600 }, // 5.2
  { levelHex: '3c', maxFS: 139_264, maxMBPS: 4_177_920 }, // 6.0
  { levelHex: '3d', maxFS: 139_264, maxMBPS: 8_355_840 }, // 6.1
  { levelHex: '3e', maxFS: 139_264, maxMBPS: 16_711_680 } // 6.2
];

const MACROBLOCK_PIXELS = 256; // 16x16
const DEFAULT_FRAMERATE_FOR_LEVEL_CHECK = 30;

/** Indexes of the levels `mjpegEncoderCandidateCodecStrings()` returns
 *  candidates for: the lowest level that actually covers `pixelCount`/
 *  `framerate`, plus the next level up as a fallback (some real encoders
 *  have gaps in level support even when the resolution itself would fit
 *  the lower one) -- falls back to the table's own highest two levels if
 *  even the largest doesn't cover the requested frame size, letting
 *  `VideoEncoder.isConfigSupported()` reject it for real rather than this
 *  function silently under-shooting. */
function selectH264LevelIndexes(pixelCount: number, framerate: number): number[] {
  const macroblocks = Math.ceil(pixelCount / MACROBLOCK_PIXELS);
  const mbps = macroblocks * framerate;
  const fitIndex = H264_LEVEL_LIMITS.findIndex((level) => macroblocks <= level.maxFS && mbps <= level.maxMBPS);
  const primaryIndex = fitIndex === -1 ? H264_LEVEL_LIMITS.length - 1 : fitIndex;
  const nextIndex = Math.min(primaryIndex + 1, H264_LEVEL_LIMITS.length - 1);
  return primaryIndex === nextIndex ? [primaryIndex] : [primaryIndex, nextIndex];
}

/**
 * Ordered candidate H264 codec strings for MJPEG's WebCodecs-`VideoEncoder`
 * real-MSE tier (`WebCodecsVideoEncoder.ts`) -- shared by two callers that
 * must never drift apart: `MediaRouter.ts`'s `selectVideoPlayer()` pre-flight
 * `MediaSource.isTypeSupported` probe (using `sizeInfo.decodeSize`, already
 * a pixel count, as `pixelCount` here) and `WebCodecsVideoEncoder.
 * configure()`'s own `VideoEncoder.isConfigSupported()` loop (using its real
 * `width * height`, which actually commits to one candidate). `framerate`
 * defaults to a generic 30fps assumption when the caller doesn't know the
 * real one yet (matches `WebCodecsVideoEncoder.ts`'s own
 * `DEFAULT_FRAMERATE_HINT`).
 *
 * Baseline (`42`) first at each level: widest hardware/software encoder
 * availability. High profile (`64`) second, for encoders that support it.
 * Every candidate is still verified with `isConfigSupported()` before being
 * committed to, never assumed blindly.
 */
export function mjpegEncoderCandidateCodecStrings(pixelCount: number, framerate: number = DEFAULT_FRAMERATE_FOR_LEVEL_CHECK): string[] {
  const levelIndexes = selectH264LevelIndexes(pixelCount, framerate || DEFAULT_FRAMERATE_FOR_LEVEL_CHECK);
  const candidates: string[] = [];
  for (const index of levelIndexes) {
    const levelHex = H264_LEVEL_LIMITS[index].levelHex;
    candidates.push(`avc1.4200${levelHex}`, `avc1.6400${levelHex}`);
  }
  return candidates;
}
