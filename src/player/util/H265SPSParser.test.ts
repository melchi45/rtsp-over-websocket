import { describe, it, expect } from 'vitest';
import { loadLegacyModule } from '../test-support/loadLegacyModule';
import { H265SPSParser } from './H265SPSParser';

interface LegacyH265SPSParser {
  parse(spsPayload: Uint8Array): boolean;
  getSizeInfo(): unknown;
  getSpsValue(key: string): unknown;
  getProfileName(): string;
  getCodecInfo(): string;
  getProfileTierLevel(): number[];
}

// h265SPSParser.js also depends on the global RTSPOverWebSocketMap (Util/hashMap.js).
const LegacyH265SPSParserCtor = loadLegacyModule<new () => LegacyH265SPSParser>(
  'Util/h265SPSParser.js',
  'H265SPSParser',
  { RTSPOverWebSocketMap: loadLegacyModule('Util/hashMap.js', 'RTSPOverWebSocketMap') }
);

const FIXTURE_A = Uint8Array.from([
  0x40, 0x01, 0x0c, 0x01, 0xff, 0xff, 0x01, 0x60, 0x00, 0x00, 0x03, 0x00, 0x90, 0x00, 0x00, 0x03,
  0x00, 0x00, 0x03, 0x00, 0x99, 0xa0, 0x01, 0xe0, 0x20, 0x02, 0x1c, 0x59, 0x99
]);
const FIXTURE_B = Uint8Array.from([
  0x42, 0x01, 0x02, 0x21, 0x00, 0x00, 0x03, 0x00, 0x90, 0x00, 0x00, 0x03, 0x00, 0x00, 0x03, 0x00,
  0x7b, 0xa0, 0x03, 0xc0, 0x80, 0x11, 0x1f, 0x36, 0x02, 0x00, 0x00, 0x03, 0x00, 0x00
]);

const SPS_KEYS = [
  'general_profile_idc',
  'general_level_idc',
  'chroma_format_idc',
  'pic_width_in_luma_samples',
  'pic_height_in_luma_samples',
  'conformance_window_flag',
  'general_tier_flag'
];

describe('H265SPSParser parity with the legacy player’s Util/h265SPSParser.js', () => {
  it.each([
    ['fixture A', FIXTURE_A],
    ['fixture B', FIXTURE_B]
  ])('%s: parse/getSizeInfo/getSpsValue/getProfileName/getCodecInfo/getProfileTierLevel all match', (_label, payload) => {
    const legacy = new LegacyH265SPSParserCtor();
    const ported = new H265SPSParser();

    expect(ported.parse(payload)).toBe(legacy.parse(payload));
    expect(ported.getSizeInfo()).toEqual(legacy.getSizeInfo());
    expect(ported.getProfileName()).toBe(legacy.getProfileName());
    expect(ported.getCodecInfo()).toBe(legacy.getCodecInfo());
    expect(ported.getProfileTierLevel()).toEqual(legacy.getProfileTierLevel());

    for (const key of SPS_KEYS) {
      expect(ported.getSpsValue(key)).toEqual(legacy.getSpsValue(key));
    }
  });
});
