import { describe, expect, it } from 'vitest';
import { BitReader } from './BitReader';
import { BitWriterTestUtil } from './BitWriterTestUtil';

describe('BitReader', () => {
  it('reads back values written MSB-first at arbitrary bit widths', () => {
    const writer = new BitWriterTestUtil();
    writer.writeBits(0b10, 2);
    writer.writeBits(0x49, 8);
    writer.writeBits(0x3ff, 10);
    writer.writeBits(1, 1);

    const reader = new BitReader(writer.toBytes());
    expect(reader.readBits(2)).toBe(0b10);
    expect(reader.readBits(8)).toBe(0x49);
    expect(reader.readBits(10)).toBe(0x3ff);
    expect(reader.readBit()).toBe(1);
  });

  it('returns 0 for reads past the end of the buffer instead of throwing', () => {
    const reader = new BitReader(new Uint8Array([0xff]));
    reader.readBits(8);
    expect(reader.readBits(16)).toBe(0);
  });

  it('bitsRemaining goes negative once reads have run past the end', () => {
    const reader = new BitReader(new Uint8Array([0xff]));
    reader.readBits(16);
    expect(reader.bitsRemaining()).toBeLessThan(0);
  });

  it('readUvlc decodes the Exp-Golomb-style code per AV1 spec §4.10.3', () => {
    // done=1 immediately -> leadingZeros=0 -> value=0
    expect(new BitReader(new Uint8Array([0b10000000])).readUvlc()).toBe(0);
    // 0,1, then 1 payload bit=1 -> leadingZeros=1, value=1+ (1<<1)-1 = 1+1=2
    expect(new BitReader(new Uint8Array([0b01100000])).readUvlc()).toBe(2);
  });
});
