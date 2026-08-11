import { describe, expect, it } from 'vitest';
import { parseAV1SequenceHeader } from './AV1HeaderParser';
import { BitWriterTestUtil } from './BitWriterTestUtil';

const OBU_SEQUENCE_HEADER = 1;
const OBU_TEMPORAL_DELIMITER = 2;

function obuHeader(obuType: number, hasSizeField: boolean): number {
  return (obuType & 0x0f) << 3 | (hasSizeField ? 0x02 : 0x00);
}

interface ColorConfigOptions {
  highBitdepth?: number;
  twelveBit?: number;
  monoChrome?: number;
  colorDescriptionPresent?: boolean;
  colorPrimaries?: number;
  transferCharacteristics?: number;
  matrixCoefficients?: number;
  subsamplingX?: number; // only consulted for profile 2 + 12-bit
  subsamplingY?: number;
  chromaSamplePosition?: number;
}

/** Builds a `reduced_still_picture_header = 1` sequence header OBU (the
 * simplest valid form — skips the timing-info/operating-points loop
 * entirely) wrapped with obu_header + leb128 obu_size, matching what
 * `parseAV1SequenceHeader` expects to find in an OBU stream. Writes every
 * bit `parseSequenceHeaderObu` now reads — frame-id/superblock/tool-enable
 * flags (all zero, all no-ops for a reduced-still-picture header beyond
 * the three that are still read even then) through `color_config()`. */
function buildSequenceHeaderObu(width: number, height: number, profile = 0, colorOptions: ColorConfigOptions = {}): Uint8Array {
  const widthBitsMinus1 = 10; // covers up to 2048 — plenty for these fixtures
  const heightBitsMinus1 = 10;

  const highBitdepth = colorOptions.highBitdepth ?? 0;
  const twelveBit = colorOptions.twelveBit ?? 0;
  const bitDepth = profile === 2 && highBitdepth === 1 ? (twelveBit === 1 ? 12 : 10) : highBitdepth === 1 ? 10 : 8;
  const monoChrome = profile === 1 ? 0 : colorOptions.monoChrome ?? 0;
  const colorDescriptionPresent = colorOptions.colorDescriptionPresent ?? false;
  const colorPrimaries = colorOptions.colorPrimaries ?? 2;
  const transferCharacteristics = colorOptions.transferCharacteristics ?? 2;
  const matrixCoefficients = colorOptions.matrixCoefficients ?? 2;

  const payloadWriter = new BitWriterTestUtil();
  payloadWriter.writeBits(profile, 3); // seq_profile
  payloadWriter.writeBits(0, 1); // still_picture
  payloadWriter.writeBits(1, 1); // reduced_still_picture_header
  payloadWriter.writeBits(0, 5); // seq_level_idx[0]
  payloadWriter.writeBits(widthBitsMinus1, 4);
  payloadWriter.writeBits(heightBitsMinus1, 4);
  payloadWriter.writeBits(width - 1, widthBitsMinus1 + 1);
  payloadWriter.writeBits(height - 1, heightBitsMinus1 + 1);
  // frame_id_numbers_present_flag is inferred 0 here (no bits)
  payloadWriter.writeBits(0, 1); // use_128x128_superblock
  payloadWriter.writeBits(0, 1); // enable_filter_intra
  payloadWriter.writeBits(0, 1); // enable_intra_edge_filter
  // reduced_still_picture_header=1 skips enable_interintra_compound..order_hint_bits entirely
  payloadWriter.writeBits(0, 1); // enable_superres
  payloadWriter.writeBits(0, 1); // enable_cdef
  payloadWriter.writeBits(0, 1); // enable_restoration

  // color_config()
  payloadWriter.writeBits(highBitdepth, 1);
  if (profile === 2 && highBitdepth === 1) {
    payloadWriter.writeBits(twelveBit, 1);
  }
  if (profile !== 1) {
    payloadWriter.writeBits(monoChrome, 1);
  }
  payloadWriter.writeBits(colorDescriptionPresent ? 1 : 0, 1);
  if (colorDescriptionPresent) {
    payloadWriter.writeBits(colorPrimaries, 8);
    payloadWriter.writeBits(transferCharacteristics, 8);
    payloadWriter.writeBits(matrixCoefficients, 8);
  }
  if (monoChrome === 1) {
    payloadWriter.writeBits(1, 1); // color_range
  } else {
    const isIdentitySrgb = colorDescriptionPresent && colorPrimaries === 1 && transferCharacteristics === 13 && matrixCoefficients === 0;
    let subsamplingX: number;
    if (isIdentitySrgb) {
      subsamplingX = 0;
    } else {
      payloadWriter.writeBits(1, 1); // color_range
      if (profile === 0) {
        subsamplingX = 1;
      } else if (profile === 1) {
        subsamplingX = 0;
      } else if (bitDepth === 12) {
        subsamplingX = colorOptions.subsamplingX ?? 1;
        payloadWriter.writeBits(subsamplingX, 1);
        if (subsamplingX === 1) {
          payloadWriter.writeBits(colorOptions.subsamplingY ?? 1, 1);
        }
      } else {
        subsamplingX = 1;
      }
    }
    const subsamplingY = isIdentitySrgb
      ? 0
      : profile === 0
        ? 1
        : profile === 1
          ? 0
          : bitDepth === 12
            ? subsamplingX === 1
              ? colorOptions.subsamplingY ?? 1
              : 0
            : 0;
    if (subsamplingX === 1 && subsamplingY === 1) {
      payloadWriter.writeBits(colorOptions.chromaSamplePosition ?? 0, 2);
    }
  }
  payloadWriter.writeBits(0, 1); // separate_uv_delta_q (skipped by spec when mono_chrome, but harmless padding here since parser returns before reading it in that branch)

  const payload = payloadWriter.toBytes();
  // All fixtures below stay well under 128 payload bytes, so a single-byte leb128 size field suffices.
  return new Uint8Array([obuHeader(OBU_SEQUENCE_HEADER, true), payload.length, ...payload]);
}

function buildTemporalDelimiterObu(): Uint8Array {
  return new Uint8Array([obuHeader(OBU_TEMPORAL_DELIMITER, true), 0x00]);
}

const DEFAULT_COLOR_FIELDS = {
  seqLevelIdx0: 0,
  seqTier0: 0,
  highBitdepth: 0,
  twelveBit: 0,
  bitDepth: 8,
  monoChrome: 0
};

describe('parseAV1SequenceHeader', () => {
  it('extracts width/height/profile/color fields from a sequence header OBU', () => {
    const obu = buildSequenceHeaderObu(1920, 1080, 0);
    expect(parseAV1SequenceHeader(obu)).toEqual({
      width: 1920,
      height: 1080,
      profile: 0,
      ...DEFAULT_COLOR_FIELDS,
      chromaSubsamplingX: 1,
      chromaSubsamplingY: 1,
      chromaSamplePosition: 0,
      obuStart: 0,
      obuEnd: obu.length
    });
  });

  it('finds the sequence header OBU after a preceding, unrelated OBU, with correct obuStart/obuEnd', () => {
    const tdObu = buildTemporalDelimiterObu();
    const seqObu = buildSequenceHeaderObu(640, 480, 0);
    const stream = new Uint8Array([...tdObu, ...seqObu]);
    expect(parseAV1SequenceHeader(stream)).toEqual({
      width: 640,
      height: 480,
      profile: 0,
      ...DEFAULT_COLOR_FIELDS,
      chromaSubsamplingX: 1,
      chromaSubsamplingY: 1,
      chromaSamplePosition: 0,
      obuStart: tdObu.length,
      obuEnd: tdObu.length + seqObu.length
    });
  });

  it('recovers the true OBU end from bytes actually consumed when the sequence header OBU has no explicit size field (real RTP-depacketized case)', () => {
    // AV1Session.ts's RTP depacketizer commonly concatenates a Sequence Header OBU (RTP-framed,
    // no in-stream obu_size) immediately followed by more OBU data (Frame Header/Tile Group) from
    // the same access unit — parseAV1SequenceHeader must not let the "no size field" case swallow
    // that trailing data into obuEnd/configObu (av1C's configOBUs must be just the sequence header).
    const sized = buildSequenceHeaderObu(640, 480, 0);
    const payload = sized.subarray(2); // drop [obuHeader(sized-flag set), leb128 size byte]
    const seqObuNoSize = new Uint8Array([obuHeader(OBU_SEQUENCE_HEADER, false), ...payload]);
    const trailingObu = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]); // stand-in Frame/Tile OBU bytes
    const stream = new Uint8Array([...seqObuNoSize, ...trailingObu]);

    const result = parseAV1SequenceHeader(stream);

    expect(result).not.toBeNull();
    expect(result!.width).toBe(640);
    expect(result!.height).toBe(480);
    expect(result!.obuStart).toBe(0);
    expect(result!.obuEnd).toBe(seqObuNoSize.length);
    expect(result!.obuEnd).toBeLessThan(stream.length);
  });

  it('extracts a profile-1 keyframe (4:4:4, mono_chrome inferred 0, no subsampling)', () => {
    const obu = buildSequenceHeaderObu(1280, 720, 1);
    expect(parseAV1SequenceHeader(obu)).toEqual({
      width: 1280,
      height: 720,
      profile: 1,
      ...DEFAULT_COLOR_FIELDS,
      chromaSubsamplingX: 0,
      chromaSubsamplingY: 0,
      chromaSamplePosition: 0,
      obuStart: 0,
      obuEnd: obu.length
    });
  });

  it('extracts a profile-2, 12-bit, explicit-subsampling keyframe', () => {
    const obu = buildSequenceHeaderObu(1920, 1080, 2, {
      highBitdepth: 1,
      twelveBit: 1,
      subsamplingX: 1,
      subsamplingY: 0,
      chromaSamplePosition: 0
    });
    expect(parseAV1SequenceHeader(obu)).toEqual({
      width: 1920,
      height: 1080,
      profile: 2,
      seqLevelIdx0: 0,
      seqTier0: 0,
      highBitdepth: 1,
      twelveBit: 1,
      bitDepth: 12,
      monoChrome: 0,
      chromaSubsamplingX: 1,
      chromaSubsamplingY: 0,
      chromaSamplePosition: 0,
      obuStart: 0,
      obuEnd: obu.length
    });
  });

  it('extracts a mono_chrome keyframe (subsampling forced 1/1, no chroma_sample_position)', () => {
    const obu = buildSequenceHeaderObu(320, 240, 0, { monoChrome: 1 });
    expect(parseAV1SequenceHeader(obu)).toEqual({
      width: 320,
      height: 240,
      profile: 0,
      ...DEFAULT_COLOR_FIELDS,
      monoChrome: 1,
      chromaSubsamplingX: 1,
      chromaSubsamplingY: 1,
      chromaSamplePosition: 0,
      obuStart: 0,
      obuEnd: obu.length
    });
  });

  it('returns null when no sequence header OBU is present', () => {
    expect(parseAV1SequenceHeader(buildTemporalDelimiterObu())).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseAV1SequenceHeader(new Uint8Array(0))).toBeNull();
  });

  it('returns null when the leb128 size field claims more bytes than are present', () => {
    const obu = buildSequenceHeaderObu(1920, 1080, 0);
    obu[1] = 0x7f; // claim a 127-byte payload the buffer doesn't actually have
    expect(parseAV1SequenceHeader(obu)).toBeNull();
  });
});
