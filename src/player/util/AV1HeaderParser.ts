import { BitReader } from './BitReader';

export interface AV1FrameHeader {
  width: number;
  height: number;
  profile: number;
  /** seq_level_idx[0] — AV1 spec's 5-bit operating-point-0 level index. */
  seqLevelIdx0: number;
  /** seq_tier[0] — 0 ("Main" tier, also the spec-inferred value whenever
   * seq_level_idx[0] <= 7 or reduced_still_picture_header is set) or 1
   * ("High" tier). */
  seqTier0: number;
  /** color_config() fields (AV1 spec §5.5.2), needed for an `av1C` config box. */
  highBitdepth: number;
  twelveBit: number;
  /** Derived from `highBitdepth`/`twelveBit`/`profile`, not its own bitstream field. */
  bitDepth: number;
  monoChrome: number;
  chromaSubsamplingX: number;
  chromaSubsamplingY: number;
  /** Only meaningful (bitstream-present) when both subsampling flags are 1;
   * `0` (CSP_UNKNOWN) otherwise. */
  chromaSamplePosition: number;
  /** Byte offsets into the `frameData` passed to `parseAV1SequenceHeader`
   * covering the raw Sequence Header OBU (header bytes + payload) —
   * `av1C`'s `configOBUs` field is conventionally the verbatim OBU bytes,
   * not a from-scratch re-serialization. */
  obuStart: number;
  obuEnd: number;
}

/** AV1 Bitstream & Decoding Process spec §6.2.2 OBU type enumeration — the
 * only type this parser looks for (matches the constant `AV1Session.ts`
 * already uses for its own, narrower purpose of key-frame detection). */
const OBU_SEQUENCE_HEADER = 1;

// Defensive bound on the OBU walk below, in case of malformed/looping input.
const MAX_OBU_ITERATIONS = 64;

interface Leb128Result {
  value: number;
  bytesRead: number;
}

/** Reads an unsigned LEB128 value (AV1 spec §4.10.5). A local copy of the
 * same algorithm `AV1Session.ts` uses for RTP-layer OBU-element lengths —
 * kept separate since this module parses in-bitstream `obu_size` fields out
 * of already-reassembled frame bytes, a different call site with its own
 * "truncated input" handling (return `null`, don't throw — see the module
 * doc comment below). */
function readLeb128(data: Uint8Array, offset: number): Leb128Result | null {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;
  while (bytesRead < 8) {
    if (offset + bytesRead >= data.length) {
      return null;
    }
    const byte = data[offset + bytesRead];
    value |= (byte & 0x7f) << shift;
    bytesRead += 1;
    if ((byte & 0x80) === 0) {
      break;
    }
    shift += 7;
  }
  return { value: value >>> 0, bytesRead };
}

/** AV1 spec §5.5.3 `timing_info()`. Parsed only to keep the bit cursor
 * aligned for the fields after it — none of its own fields are needed. */
function skipTimingInfo(reader: BitReader): void {
  reader.readBits(32); // num_units_in_display_tick
  reader.readBits(32); // time_scale
  const equalPictureInterval = reader.readBits(1);
  if (equalPictureInterval === 1) {
    reader.readUvlc(); // num_ticks_per_picture_minus_1
  }
}

/** AV1 spec §5.5.4 `decoder_model_info()` — returns `buffer_delay_length_minus_1`,
 * the one field `operating_parameters_info()` (§5.5.5) needs to know its own
 * field widths. */
function skipDecoderModelInfo(reader: BitReader): number {
  const bufferDelayLengthMinus1 = reader.readBits(5);
  reader.readBits(32); // num_units_in_decoding_tick
  reader.readBits(5); // buffer_removal_time_length_minus_1
  reader.readBits(5); // frame_presentation_time_length_minus_1
  return bufferDelayLengthMinus1;
}

/** AV1 spec §5.5.5 `operating_parameters_info()`. */
function skipOperatingParametersInfo(reader: BitReader, bufferDelayLengthMinus1: number): void {
  const n = bufferDelayLengthMinus1 + 1;
  reader.readBits(n); // decoder_buffer_delay
  reader.readBits(n); // encoder_buffer_delay
  reader.readBits(1); // low_delay_mode_flag
}

/**
 * AV1 spec §5.5.2 `color_config()` — called after `enable_restoration` in
 * `sequence_header_obu()`. Needs `seqProfile` (bit-depth derivation branches
 * on it) and `reducedStillPictureHeader`'s implied `mono_chrome = 0` special
 * case isn't relevant here (that's only for `seq_profile == 1`, a genuine
 * bitstream branch, not a reduced-header inference).
 */
function parseColorConfig(
  reader: BitReader,
  seqProfile: number
): {
  highBitdepth: number;
  twelveBit: number;
  bitDepth: number;
  monoChrome: number;
  chromaSubsamplingX: number;
  chromaSubsamplingY: number;
  chromaSamplePosition: number;
} {
  const highBitdepth = reader.readBits(1);
  let twelveBit = 0;
  let bitDepth: number;
  if (seqProfile === 2 && highBitdepth === 1) {
    twelveBit = reader.readBits(1);
    bitDepth = twelveBit === 1 ? 12 : 10;
  } else {
    bitDepth = highBitdepth === 1 ? 10 : 8;
  }

  const monoChrome = seqProfile === 1 ? 0 : reader.readBits(1);

  const colorDescriptionPresentFlag = reader.readBits(1);
  let colorPrimaries = 2; // CP_UNSPECIFIED
  let transferCharacteristics = 2; // TC_UNSPECIFIED
  let matrixCoefficients = 2; // MC_UNSPECIFIED
  if (colorDescriptionPresentFlag === 1) {
    colorPrimaries = reader.readBits(8);
    transferCharacteristics = reader.readBits(8);
    matrixCoefficients = reader.readBits(8);
  }

  if (monoChrome === 1) {
    reader.readBits(1); // color_range
    return { highBitdepth, twelveBit, bitDepth, monoChrome, chromaSubsamplingX: 1, chromaSubsamplingY: 1, chromaSamplePosition: 0 };
  }

  let chromaSubsamplingX: number;
  let chromaSubsamplingY: number;
  const isIdentitySrgb = colorPrimaries === 1 && transferCharacteristics === 13 && matrixCoefficients === 0;
  if (isIdentitySrgb) {
    chromaSubsamplingX = 0;
    chromaSubsamplingY = 0;
  } else {
    reader.readBits(1); // color_range
    if (seqProfile === 0) {
      chromaSubsamplingX = 1;
      chromaSubsamplingY = 1;
    } else if (seqProfile === 1) {
      chromaSubsamplingX = 0;
      chromaSubsamplingY = 0;
    } else if (bitDepth === 12) {
      chromaSubsamplingX = reader.readBits(1);
      chromaSubsamplingY = chromaSubsamplingX === 1 ? reader.readBits(1) : 0;
    } else {
      chromaSubsamplingX = 1;
      chromaSubsamplingY = 0;
    }
  }

  let chromaSamplePosition = 0; // CSP_UNKNOWN
  if (chromaSubsamplingX === 1 && chromaSubsamplingY === 1) {
    chromaSamplePosition = reader.readBits(2);
  }
  reader.readBits(1); // separate_uv_delta_q

  return { highBitdepth, twelveBit, bitDepth, monoChrome, chromaSubsamplingX, chromaSubsamplingY, chromaSamplePosition };
}

/**
 * AV1 spec §5.5.1 `sequence_header_obu()` — parses through the optional
 * timing-info/decoder-model/operating-points loop (walked correctly to keep
 * the bit cursor aligned even though most of its fields, beyond operating
 * point 0's level/tier, aren't returned), the maximum frame width/height,
 * the frame-id/superblock/tool-enable flag run, and `color_config()`, to
 * recover everything an `av1C` config box needs. Returns `null` if the
 * input looks truncated.
 */
function parseSequenceHeaderObu(payload: Uint8Array): Omit<AV1FrameHeader, 'obuStart' | 'obuEnd'> | null {
  const reader = new BitReader(payload);

  const seqProfile = reader.readBits(3);
  reader.readBits(1); // still_picture
  const reducedStillPictureHeader = reader.readBits(1);

  let seqLevelIdx0 = 0;
  let seqTier0 = 0;

  if (reducedStillPictureHeader === 1) {
    seqLevelIdx0 = reader.readBits(5); // seq_level_idx[0]
  } else {
    let decoderModelInfoPresentFlag = 0;
    let bufferDelayLengthMinus1 = 0;

    const timingInfoPresentFlag = reader.readBits(1);
    if (timingInfoPresentFlag === 1) {
      skipTimingInfo(reader);
      decoderModelInfoPresentFlag = reader.readBits(1);
      if (decoderModelInfoPresentFlag === 1) {
        bufferDelayLengthMinus1 = skipDecoderModelInfo(reader);
      }
    }

    const initialDisplayDelayPresentFlag = reader.readBits(1);
    const operatingPointsCntMinus1 = reader.readBits(5);
    for (let i = 0; i <= operatingPointsCntMinus1; i++) {
      reader.readBits(12); // operating_point_idc[i]
      const seqLevelIdx = reader.readBits(5);
      let seqTier = 0;
      if (seqLevelIdx > 7) {
        seqTier = reader.readBits(1); // seq_tier[i]
      }
      if (i === 0) {
        seqLevelIdx0 = seqLevelIdx;
        seqTier0 = seqTier;
      }
      if (decoderModelInfoPresentFlag === 1) {
        const decoderModelPresentForThisOp = reader.readBits(1);
        if (decoderModelPresentForThisOp === 1) {
          skipOperatingParametersInfo(reader, bufferDelayLengthMinus1);
        }
      }
      if (initialDisplayDelayPresentFlag === 1) {
        const initialDisplayDelayPresentForThisOp = reader.readBits(1);
        if (initialDisplayDelayPresentForThisOp === 1) {
          reader.readBits(4); // initial_display_delay_minus_1[i]
        }
      }
    }
  }

  const frameWidthBitsMinus1 = reader.readBits(4);
  const frameHeightBitsMinus1 = reader.readBits(4);
  const width = reader.readBits(frameWidthBitsMinus1 + 1) + 1;
  const height = reader.readBits(frameHeightBitsMinus1 + 1) + 1;

  const frameIdNumbersPresentFlag = reducedStillPictureHeader === 1 ? 0 : reader.readBits(1);
  if (frameIdNumbersPresentFlag === 1) {
    reader.readBits(4); // delta_frame_id_length_minus_2
    reader.readBits(3); // additional_frame_id_length_minus_1
  }

  reader.readBits(1); // use_128x128_superblock
  reader.readBits(1); // enable_filter_intra
  reader.readBits(1); // enable_intra_edge_filter

  if (reducedStillPictureHeader !== 1) {
    reader.readBits(1); // enable_interintra_compound
    reader.readBits(1); // enable_masked_compound
    reader.readBits(1); // enable_warped_motion
    reader.readBits(1); // enable_dual_filter
    const enableOrderHint = reader.readBits(1);
    if (enableOrderHint === 1) {
      reader.readBits(1); // enable_jnt_comp
      reader.readBits(1); // enable_ref_frame_mvs
    }
    const seqChooseScreenContentTools = reader.readBits(1);
    let seqForceScreenContentTools = 2; // SELECT_SCREEN_CONTENT_TOOLS
    if (seqChooseScreenContentTools === 0) {
      seqForceScreenContentTools = reader.readBits(1);
    }
    if (seqForceScreenContentTools > 0) {
      const seqChooseIntegerMv = reader.readBits(1);
      if (seqChooseIntegerMv === 0) {
        reader.readBits(1); // seq_force_integer_mv
      }
    }
    if (enableOrderHint === 1) {
      reader.readBits(3); // order_hint_bits_minus_1
    }
  }

  reader.readBits(1); // enable_superres
  reader.readBits(1); // enable_cdef
  reader.readBits(1); // enable_restoration

  const colorConfig = parseColorConfig(reader, seqProfile);

  if (reader.bitsRemaining() < 0) {
    return null;
  }

  return { width, height, profile: seqProfile, seqLevelIdx0, seqTier0, ...colorConfig };
}

/**
 * Walks the raw OBU stream in `frameData` (AV1 spec §5.3.1 `obu_header()` +
 * §4.10.5 leb128 `obu_size`) looking for a Sequence Header OBU, and parses
 * it if found. Used by `MediaRouter.getFrameSizeInfo` in place of an SPS
 * parse — AV1 has no SPS-equivalent parameter set tied 1:1 to a NAL/frame;
 * the Sequence Header OBU plays that role but only appears in access units
 * that start a new coded video sequence (matches the same OBU
 * `AV1Session.ts` already locates for its own, narrower key-frame-detection
 * purpose).
 *
 * Returns `null` when no Sequence Header OBU is present (the overwhelming
 * majority of frames — inter frames don't carry one) or the input looks
 * truncated/malformed. This is called on every frame, not just keyframes,
 * so callers must treat `null` as "no size info in this particular frame,"
 * not as an error.
 */
export function parseAV1SequenceHeader(frameData: Uint8Array): AV1FrameHeader | null {
  let pos = 0;
  let iterations = 0;

  while (pos < frameData.length && iterations < MAX_OBU_ITERATIONS) {
    iterations += 1;

    const obuStart = pos;
    const headerByte = frameData[pos];
    const obuType = (headerByte >> 3) & 0x0f;
    const obuExtensionFlag = (headerByte & 0x04) !== 0;
    const obuHasSizeField = (headerByte & 0x02) !== 0;

    let payloadStart = pos + (obuExtensionFlag ? 2 : 1);
    let payloadEnd: number;

    if (obuHasSizeField) {
      const sizeResult = readLeb128(frameData, payloadStart);
      if (sizeResult === null) {
        return null;
      }
      payloadStart += sizeResult.bytesRead;
      payloadEnd = payloadStart + sizeResult.value;
      if (payloadEnd > frameData.length) {
        return null;
      }
    } else {
      // No explicit size: per the AV1 spec this OBU's payload runs to the
      // end of the containing temporal unit — which, at this call site, is
      // all of `frameData` (one already-reassembled access unit).
      payloadEnd = frameData.length;
    }

    if (obuType === OBU_SEQUENCE_HEADER) {
      const parsed = parseSequenceHeaderObu(frameData.subarray(payloadStart, payloadEnd));
      return parsed === null ? null : { ...parsed, obuStart, obuEnd: payloadEnd };
    }

    if (!obuHasSizeField) {
      // Can't locate the next OBU's start without a size field once this
      // one isn't the sequence header being searched for.
      return null;
    }

    pos = payloadEnd;
  }

  return null;
}
