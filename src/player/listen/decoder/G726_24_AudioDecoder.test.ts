import { describe, it, expect } from 'vitest';
import { loadLegacyModule } from '../../test-support/loadLegacyModule';
import { createAudioDecoderLegacySandbox } from '../../test-support/legacyGlobals';
import { G726_24_AudioDecoder } from './G726_24_AudioDecoder';

interface LegacyG726Decoder {
  decode(buffer: ArrayLike<number>): Int16Array;
}

const LegacyCtor = loadLegacyModule<new () => LegacyG726Decoder>(
  'Listen/Decoder/audioDecoderG726_24.js',
  'G726_24_AudioDecoder',
  createAudioDecoderLegacySandbox()
);

const SAMPLE_BYTES = [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0x00, 0xff, 0x11, 0x22];

describe('G726_24_AudioDecoder parity with the legacy player’s Listen/Decoder/audioDecoderG726_24.js', () => {
  it('decodes an identical Int16Array for the same input, evolving state the same way', () => {
    const legacy = new LegacyCtor();
    const ported = new G726_24_AudioDecoder();
    expect(Array.from(ported.decode(SAMPLE_BYTES))).toEqual(Array.from(legacy.decode(SAMPLE_BYTES)));
  });
});
