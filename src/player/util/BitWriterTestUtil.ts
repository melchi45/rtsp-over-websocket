/**
 * Test-only MSB-first bit writer, the exact inverse of `BitReader` (bit `i`
 * within a byte is written/read at the same position, `0x80 >> (i & 7)`) —
 * used by `VP9HeaderParser.test.ts`/`AV1HeaderParser.test.ts` to construct
 * synthetic bitstream fixtures without hand-computing hex bytes.
 */
export class BitWriterTestUtil {
  private readonly bits: number[] = [];

  writeBits(value: number, count: number): this {
    for (let i = count - 1; i >= 0; i--) {
      this.bits.push((value >>> i) & 0x1);
    }
    return this;
  }

  toBytes(): Uint8Array {
    const bytes = new Uint8Array(Math.ceil(this.bits.length / 8));
    for (let i = 0; i < this.bits.length; i++) {
      if (this.bits[i]) {
        bytes[i >> 3] |= 0x80 >> (i & 0x7);
      }
    }
    return bytes;
  }
}
