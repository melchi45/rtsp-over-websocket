import { describe, it, expect } from 'vitest';
import { loadLegacyModule } from '../../test-support/loadLegacyModule';
import { createAudioDecoderLegacySandbox } from '../../test-support/legacyGlobals';
import { G726xAudioDecoder } from './G726xAudioDecoder';

interface LegacyG726xAudioDecoder {
  decode(buffer: ArrayLike<number>): Float32Array;
}

const g726xGlobals = {
  ...createAudioDecoderLegacySandbox(),
  G726_16_AudioDecoder: loadLegacyModule('Listen/Decoder/audioDecoderG726_16.js', 'G726_16_AudioDecoder', createAudioDecoderLegacySandbox()),
  G726_24_AudioDecoder: loadLegacyModule('Listen/Decoder/audioDecoderG726_24.js', 'G726_24_AudioDecoder', createAudioDecoderLegacySandbox()),
  G726_32_AudioDecoder: loadLegacyModule('Listen/Decoder/audioDecoderG726_32.js', 'G726_32_AudioDecoder', createAudioDecoderLegacySandbox()),
  G726_40_AudioDecoder: loadLegacyModule('Listen/Decoder/audioDecoderG726_40.js', 'G726_40_AudioDecoder', createAudioDecoderLegacySandbox())
};

const LegacyG726xAudioDecoderCtor = loadLegacyModule<new (bits: number) => LegacyG726xAudioDecoder>(
  'Listen/Decoder/audioDecoderG726x.js',
  'G726xAudioDecoder',
  g726xGlobals
);

const SAMPLE_BYTES = [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0x00, 0xff];

describe('G726xAudioDecoder parity with the legacy player’s Listen/Decoder/audioDecoderG726x.js', () => {
  it.each([16, 24, 32, 40])('dispatches to the %s-bit decoder identically', (bits) => {
    const legacy = new LegacyG726xAudioDecoderCtor(bits);
    const ported = new G726xAudioDecoder(bits as 16 | 24 | 32 | 40);
    expect(Array.from(ported.decode(SAMPLE_BYTES))).toEqual(Array.from(legacy.decode(SAMPLE_BYTES)));
  });

  it('throws on an unrecognized bit depth (legacy leaves decoder unset and crashes on use)', () => {
    // @ts-expect-error — exercising the legacy "wrong bits" fallback intentionally
    const legacy = new LegacyG726xAudioDecoderCtor(99);
    // @ts-expect-error — same
    const ported = new G726xAudioDecoder(99);
    expect(() => legacy.decode(SAMPLE_BYTES)).toThrow();
    expect(() => ported.decode(SAMPLE_BYTES)).toThrow();
  });
});
