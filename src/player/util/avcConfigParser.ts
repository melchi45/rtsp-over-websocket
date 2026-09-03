export interface AvcConfigurationRecord {
  profileIdc: number;
  profileCompatibility: number;
  levelIdc: number;
  sps: Uint8Array[];
  pps: Uint8Array[];
}

/** Builds an `avc1.PPCCLL` MSE codec string from a parsed avcC record --
 *  the exact same hex-padding format `H264SPSParser.getCodecInfo()` builds
 *  from a real network SPS, kept in sync here for the encoder-sourced path
 *  where there is no SPS parser to reuse (see `VideoTagPlayer.ts`'s
 *  `onMjpegEncodedChunk()`). */
export function buildAvc1CodecString(record: AvcConfigurationRecord): string {
  const toHex = (value: number): string => (value <= 0x0f ? '0' : '') + value.toString(16);
  return 'avc1.' + toHex(record.profileIdc) + toHex(record.profileCompatibility) + toHex(record.levelIdc);
}

/**
 * Parses an ISO/IEC 14496-15 `AVCDecoderConfigurationRecord` ("avcC" box
 * payload) -- what WebCodecs' `VideoEncoder` surfaces as
 * `EncodedVideoChunkMetadata.decoderConfig.description` for an `avc1.*`
 * codec (present on the first output chunk after `configure()`, and again
 * after any config change). Layout: configurationVersion(1) / profileIdc(1)
 * / profileCompatibility(1) / levelIdc(1) / lengthSizeMinusOne(1, low 2
 * bits -- always `3` here, i.e. 4-byte NAL lengths, matching
 * `mp4Generator.js`'s own hardcoded avcC `lengthSizeMinusOne` and this
 * player's `prefixSize`/`PREFIX_SIZE`) / numSPS(1, low 5 bits) / (SPS
 * length(2) + SPS bytes)* / numPPS(1) / (PPS length(2) + PPS bytes)*.
 *
 * Feeds `WebCodecsVideoEncoder.ts`'s MJPEG-encode path in
 * `VideoTagPlayer.ts`: this repo's H264 real-MSE tier already builds
 * `Mp4VideoTrackInfo` from parsed SPS/PPS NAL bodies + profileIdc/
 * profileCompatibility/levelIdc (see `setVideoInfo()`), but that data
 * normally comes from `MediaRouter.ts`'s `H264SPSParser` reading the
 * network bitstream directly -- MJPEG has no SPS/PPS of its own, so this
 * parser reconstructs the equivalent shape from the *encoder's own* avcC
 * output instead.
 *
 * Returns `null` (logging, not throwing -- matching
 * `WebCodecsVideoDecoder.ts`'s error-swallow convention) on truncated or
 * malformed input, so one bad encode never takes down the whole session.
 */
export function parseAvcConfigurationRecord(description: Uint8Array): AvcConfigurationRecord | null {
  try {
    const view = new DataView(description.buffer, description.byteOffset, description.byteLength);
    let offset = 0;

    offset += 1; // configurationVersion, always 1 -- not needed by Mp4VideoTrackInfo
    const profileIdc = view.getUint8(offset);
    offset += 1;
    const profileCompatibility = view.getUint8(offset);
    offset += 1;
    const levelIdc = view.getUint8(offset);
    offset += 1;
    offset += 1; // lengthSizeMinusOne byte (low 2 bits) -- this player always assumes 4-byte lengths

    const numSps = view.getUint8(offset) & 0x1f;
    offset += 1;
    const sps: Uint8Array[] = [];
    for (let i = 0; i < numSps; i++) {
      const length = view.getUint16(offset);
      offset += 2;
      sps.push(description.subarray(offset, offset + length));
      offset += length;
    }

    const numPps = view.getUint8(offset);
    offset += 1;
    const pps: Uint8Array[] = [];
    for (let i = 0; i < numPps; i++) {
      const length = view.getUint16(offset);
      offset += 2;
      pps.push(description.subarray(offset, offset + length));
      offset += length;
    }

    return { profileIdc, profileCompatibility, levelIdc, sps, pps };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`avcConfigParser: failed to parse AVCDecoderConfigurationRecord (length=${description.byteLength}): ${String(error)}`);
    return null;
  }
}
