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
