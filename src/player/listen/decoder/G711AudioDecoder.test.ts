import { describe, it, expect } from 'vitest';
import { loadLegacyModule } from '../../test-support/loadLegacyModule';
import { createAudioDecoderLegacySandbox } from '../../test-support/legacyGlobals';
import { G711AudioDecoder } from './G711AudioDecoder';

interface LegacyG711AudioDecoder {
  mime: string;
  decode(buffer: ArrayLike<number>): Float32Array;
}

const LegacyG711AudioDecoderCtor = loadLegacyModule<new () => LegacyG711AudioDecoder>(
  'Listen/Decoder/audioDecoderG711.js',
  'G711AudioDecoder',
  createAudioDecoderLegacySandbox()
);

const SAMPLE_BYTES = [0x00, 0x1f, 0x55, 0x80, 0xaa, 0xff, 0x7f, 0x40];

describe('G711AudioDecoder parity with the legacy player’s Listen/Decoder/audioDecoderG711.js', () => {
  it('decodes identically in the default PCMU mode', () => {
    const legacy = new LegacyG711AudioDecoderCtor();
    const ported = new G711AudioDecoder();
    expect(Array.from(ported.decode(SAMPLE_BYTES))).toEqual(Array.from(legacy.decode(SAMPLE_BYTES)));
  });

  it('decodes identically in PCMA mode', () => {
    const legacy = new LegacyG711AudioDecoderCtor();
    legacy.mime = 'PCMA';
    const ported = new G711AudioDecoder();
    ported.mime = 'PCMA';
    expect(Array.from(ported.decode(SAMPLE_BYTES))).toEqual(Array.from(legacy.decode(SAMPLE_BYTES)));
  });
});
