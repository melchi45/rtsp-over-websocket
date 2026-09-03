import { describe, expect, it } from 'vitest';
import { buildAvc1CodecString, parseAvcConfigurationRecord } from './avcConfigParser';

/** Builds a synthetic `AVCDecoderConfigurationRecord` byte array for test fixtures,
 *  mirroring the real layout `avcConfigParser.ts` parses. */
function buildAvcC(profileIdc: number, profileCompatibility: number, levelIdc: number, spsList: Uint8Array[], ppsList: Uint8Array[]): Uint8Array {
  const bytes: number[] = [
    1, // configurationVersion
    profileIdc,
    profileCompatibility,
    levelIdc,
    0xff, // lengthSizeMinusOne (low 2 bits = 3) with reserved high bits set, matching real encoders
    0xe0 | spsList.length // numSPS (low 5 bits) with reserved high bits set
  ];
  for (const sps of spsList) {
    bytes.push((sps.length >> 8) & 0xff, sps.length & 0xff, ...sps);
  }
  bytes.push(ppsList.length);
  for (const pps of ppsList) {
    bytes.push((pps.length >> 8) & 0xff, pps.length & 0xff, ...pps);
  }
  return new Uint8Array(bytes);
}

describe('avcConfigParser', () => {
  it('parses a single SPS/PPS record', () => {
    const sps = new Uint8Array([0x67, 0x42, 0x00, 0x1f, 0xaa, 0xbb]);
    const pps = new Uint8Array([0x68, 0xce, 0x3c, 0x80]);
    const record = parseAvcConfigurationRecord(buildAvcC(0x42, 0x00, 0x1f, [sps], [pps]));

    expect(record).not.toBeNull();
    expect(record?.profileIdc).toBe(0x42);
    expect(record?.profileCompatibility).toBe(0x00);
    expect(record?.levelIdc).toBe(0x1f);
    expect(record?.sps).toHaveLength(1);
    expect(record?.sps[0]).toEqual(sps);
    expect(record?.pps).toHaveLength(1);
    expect(record?.pps[0]).toEqual(pps);
  });

  it('parses multiple SPS entries', () => {
    const sps1 = new Uint8Array([0x67, 0x01, 0x02]);
    const sps2 = new Uint8Array([0x67, 0x03, 0x04, 0x05]);
    const pps = new Uint8Array([0x68, 0x06]);
    const record = parseAvcConfigurationRecord(buildAvcC(0x64, 0x00, 0x28, [sps1, sps2], [pps]));

    expect(record?.sps).toHaveLength(2);
    expect(record?.sps[0]).toEqual(sps1);
    expect(record?.sps[1]).toEqual(sps2);
  });

  it('parses a record with zero SPS/PPS entries', () => {
    const record = parseAvcConfigurationRecord(buildAvcC(0x42, 0x00, 0x1f, [], []));

    expect(record?.sps).toHaveLength(0);
    expect(record?.pps).toHaveLength(0);
  });

  it('reads correctly from a Uint8Array with a non-zero byteOffset (subarray of a larger buffer)', () => {
    const sps = new Uint8Array([0x67, 0xaa]);
    const pps = new Uint8Array([0x68, 0xbb]);
    const record = buildAvcC(0x42, 0x00, 0x1f, [sps], [pps]);
    const padded = new Uint8Array(record.length + 5);
    padded.set(record, 5);
    const view = padded.subarray(5);

    const parsed = parseAvcConfigurationRecord(view);
    expect(parsed?.profileIdc).toBe(0x42);
    expect(parsed?.sps[0]).toEqual(sps);
  });

  it('returns null (not throw) for truncated input', () => {
    const truncated = new Uint8Array([1, 0x42, 0x00, 0x1f, 0xff, 0xe1, 0x00]); // claims 1 SPS but has no length/bytes
    expect(parseAvcConfigurationRecord(truncated)).toBeNull();
  });

  it('returns null (not throw) for an empty input', () => {
    expect(parseAvcConfigurationRecord(new Uint8Array([]))).toBeNull();
  });
});

describe('buildAvc1CodecString', () => {
  it('builds an avc1.PPCCLL string with zero-padded hex components', () => {
    expect(buildAvc1CodecString({ profileIdc: 0x42, profileCompatibility: 0x00, levelIdc: 0x1f, sps: [], pps: [] })).toBe('avc1.42001f');
  });

  it('matches H264SPSParser.getCodecInfo()\'s format for a High-profile/level-4.0 record', () => {
    expect(buildAvc1CodecString({ profileIdc: 0x64, profileCompatibility: 0x00, levelIdc: 0x28, sps: [], pps: [] })).toBe('avc1.640028');
  });
});
