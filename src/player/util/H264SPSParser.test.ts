import { describe, it, expect } from 'vitest';
import { loadLegacyModule } from '../test-support/loadLegacyModule';
import { H264SPSParser } from './H264SPSParser';

interface LegacyH264SPSParser {
  parse(spsPayload: Uint8Array): boolean;
  getSizeInfo(): unknown;
  getSpsValue(key: string): unknown;
  getCodecInfo(): string | null;
}

// h264SPSParser.js depends only on RTSPOverWebSocketMap (Util/hashMap.js), loaded first into the
// same sandbox so `new RTSPOverWebSocketMap()` resolves inside the legacy file's own scope.
const LegacyH264SPSParserCtor = loadLegacyModule<new () => LegacyH264SPSParser>(
  'Util/h264SPSParser.js',
  'H264SPSParser',
  { RTSPOverWebSocketMap: loadLegacyModule('Util/hashMap.js', 'RTSPOverWebSocketMap') }
);

// Bit-exact validity of these payloads as real H.264 SPS NAL units is not the point —
// both implementations run the identical bit-reading algorithm, so any fixed byte
// sequence exercises the same code paths in both and must produce the same output.
const BASELINE_PROFILE_SPS = Uint8Array.from([
  0x67, 0x42, 0x00, 0x1e, 0x8c, 0x8d, 0x40, 0x50, 0x1e, 0x90, 0x0f, 0x08, 0x84, 0x6a, 0x00, 0x00, 0x00
]);
const HIGH_PROFILE_SPS = Uint8Array.from([
  0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x40, 0x50, 0x1e, 0xd0, 0x0f, 0x12, 0x26, 0xa0, 0x00, 0x00, 0x00
]);

const SPS_KEYS = [
  'profile_idc',
  'level_idc',
  'chroma_format_idc',
  'pic_width_in_mbs_minus1',
  'pic_height_in_map_units_minus1',
  'frame_mbs_only_flag',
  'pic_order_cnt_type',
  'vui_parameters_present_flag'
];

describe('H264SPSParser parity with the legacy player’s Util/h264SPSParser.js', () => {
  it.each([
    ['baseline profile (skips the high-profile chroma block)', BASELINE_PROFILE_SPS],
    ['high profile (exercises the chroma_format_idc block)', HIGH_PROFILE_SPS]
  ])('%s: parse/getSizeInfo/getSpsValue/getCodecInfo all match', (_label, payload) => {
    const legacy = new LegacyH264SPSParserCtor();
    const ported = new H264SPSParser();

    expect(ported.parse(payload)).toBe(legacy.parse(payload));
    expect(ported.getSizeInfo()).toEqual(legacy.getSizeInfo());
    expect(ported.getCodecInfo()).toBe(legacy.getCodecInfo());

    for (const key of SPS_KEYS) {
      expect(ported.getSpsValue(key)).toEqual(legacy.getSpsValue(key));
    }
  });
});
