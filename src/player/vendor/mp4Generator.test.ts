import { describe, expect, it } from 'vitest';
import { initSegment } from './mp4Generator';
import type { Mp4VideoTrackInfo } from './mp4Generator';

interface BoxHeader {
  type: string;
  size: number;
  payloadStart: number;
  payloadEnd: number;
}

function readBoxHeader(data: Uint8Array, offset: number): BoxHeader {
  const size = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0);
  const type = String.fromCharCode(data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]);
  return { type, size, payloadStart: offset + 8, payloadEnd: offset + size };
}

/** Walks a flat sibling-box sequence looking for the first box of `type` — sufficient for the fixed,
 * single-track-per-container structure `initSegment()` always produces (moov/trak/mdia/minf/stbl each
 * have exactly the fixed child set `mp4Generator.js` writes, in a known order). */
function findChildBox(data: Uint8Array, containerStart: number, containerEnd: number, type: string): BoxHeader {
  let pos = containerStart;
  while (pos < containerEnd) {
    const header = readBoxHeader(data, pos);
    if (header.type === type) {
      return header;
    }
    pos = header.payloadEnd;
  }
  throw new Error(`box '${type}' not found in byte range [${containerStart}, ${containerEnd})`);
}

/** Descends moov -> trak -> mdia -> minf -> stbl -> stsd -> (78-byte VisualSampleEntry header) ->
 * config box, for a single-video-track `initSegment()` result. `sampleEntryType` is read directly
 * (not searched for) since `stsd`'s entry_count is always 1 in this player's usage. */
function findVideoConfigBox(segment: Uint8Array, configBoxType: string): BoxHeader {
  const moov = findChildBox(segment, 0, segment.length, 'moov');
  const trak = findChildBox(segment, moov.payloadStart, moov.payloadEnd, 'trak');
  const mdia = findChildBox(segment, trak.payloadStart, trak.payloadEnd, 'mdia');
  const minf = findChildBox(segment, mdia.payloadStart, mdia.payloadEnd, 'minf');
  const stbl = findChildBox(segment, minf.payloadStart, minf.payloadEnd, 'stbl');
  const stsd = findChildBox(segment, stbl.payloadStart, stbl.payloadEnd, 'stsd');
  const stsdHeaderSize = 8; // version(1) + flags(3) + entry_count(4)
  const sampleEntry = readBoxHeader(segment, stsd.payloadStart + stsdHeaderSize);
  const visualSampleEntryHeaderSize = 78;
  const configBox = readBoxHeader(segment, sampleEntry.payloadStart + visualSampleEntryHeaderSize);
  if (configBox.type !== configBoxType) {
    throw new Error(`expected config box '${configBoxType}', found '${configBox.type}'`);
  }
  return configBox;
}

describe('mp4Generator VP9/AV1 sample entries', () => {
  it('builds a vp09/vpcC sample entry with correctly packed vpcC fields', () => {
    const track: Mp4VideoTrackInfo = {
      id: 1,
      width: 1920,
      height: 1080,
      type: 'video',
      codecType: 'VP9',
      sps: [],
      pps: [],
      profile: 0,
      bitDepth: 8,
      colorSpace: 1, // CS_BT_601
      colorRange: 1,
      subsamplingX: 1,
      subsamplingY: 1
    };

    const segment = initSegment([track]);
    const vpcC = findVideoConfigBox(segment, 'vpcC');
    expect(vpcC.type).toBe('vpcC');

    const payload = segment.subarray(vpcC.payloadStart, vpcC.payloadEnd);
    expect(payload[0]).toBe(1); // version
    expect([payload[1], payload[2], payload[3]]).toEqual([0, 0, 0]); // flags
    expect(payload[4]).toBe(0); // profile
    expect(payload[5]).toBe(0); // level (always unspecified)
    // (bitDepth=8 << 4) | (chromaSubsampling=1, 4:2:0 colocated, since subsamplingX=subsamplingY=1) << 1 | colorRange=1
    expect(payload[6]).toBe((8 << 4) | (1 << 1) | 1);
    // CS_BT_601 -> {primaries: 5, transfer: 5, matrix: 5} per the VP9_CICP_COLOR_CONFIG table
    expect(payload[7]).toBe(5);
    expect(payload[8]).toBe(5);
    expect(payload[9]).toBe(5);
    expect([payload[10], payload[11]]).toEqual([0, 0]); // codecIntializationDataSize = 0
    expect(payload.length).toBe(12);
  });

  it('builds an av01/av1C sample entry with correctly packed av1C fields and verbatim configOBUs', () => {
    const configObu = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const track: Mp4VideoTrackInfo = {
      id: 1,
      width: 1280,
      height: 720,
      type: 'video',
      codecType: 'AV1',
      sps: [],
      pps: [],
      profile: 0,
      seqLevelIdx0: 8,
      seqTier0: 0,
      highBitdepth: 0,
      twelveBit: 0,
      monoChrome: 0,
      chromaSubsamplingX: 1,
      chromaSubsamplingY: 1,
      chromaSamplePosition: 2,
      configObu
    };

    const segment = initSegment([track]);
    const av1C = findVideoConfigBox(segment, 'av1C');
    expect(av1C.type).toBe('av1C');

    const payload = segment.subarray(av1C.payloadStart, av1C.payloadEnd);
    expect(payload[0]).toBe(0x81); // marker=1, version=1
    expect(payload[1]).toBe((0 << 5) | 8); // seq_profile=0, seq_level_idx_0=8
    // seq_tier_0=0, high_bitdepth=0, twelve_bit=0, monochrome=0, chroma_subsampling_x=1, chroma_subsampling_y=1, chroma_sample_position=2
    expect(payload[2]).toBe((1 << 3) | (1 << 2) | 2);
    expect(payload[3]).toBe(0); // reserved / initial_presentation_delay_present=0 / reserved nibble
    expect(Array.from(payload.subarray(4))).toEqual(Array.from(configObu));
    expect(payload.length).toBe(4 + configObu.length);
  });
});
