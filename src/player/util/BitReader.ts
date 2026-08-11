/**
 * Minimal MSB-first bit reader over a byte buffer, with a persistent cursor
 * across calls — used by VP9HeaderParser/AV1HeaderParser to walk bitstream
 * syntax elements that aren't byte-aligned (matches the bit-numbering both
 * codecs' specs use, `f(n)` reads MSB first). Out-of-range reads return `0`
 * rather than throwing, so a truncated/malformed input degrades to "parsed
 * zeros" instead of crashing the caller — callers that need to detect
 * truncation should check `bitsRemaining()` after reading.
 */
export class BitReader {
  private bitPosition = 0;

  constructor(private readonly data: Uint8Array) {}

  readBit(): number {
    const byteIndex = this.bitPosition >> 3;
    const bitOffset = this.bitPosition & 0x7;
    this.bitPosition += 1;
    if (byteIndex >= this.data.length) {
      return 0;
    }
    return (this.data[byteIndex] >> (7 - bitOffset)) & 0x1;
  }

  readBits(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      value = (value << 1) | this.readBit();
    }
    return value >>> 0;
  }

  /** AV1 spec §4.10.3 `uvlc()` — Exp-Golomb-style unsigned variable-length code. */
  readUvlc(): number {
    let leadingZeros = 0;
    while (this.readBit() === 0) {
      leadingZeros += 1;
      if (leadingZeros >= 32) {
        return 0xffffffff;
      }
    }
    return this.readBits(leadingZeros) + 2 ** leadingZeros - 1;
  }

  bitsRemaining(): number {
    return this.data.length * 8 - this.bitPosition;
  }
}
