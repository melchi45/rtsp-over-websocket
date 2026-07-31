import { describe, it, expect } from 'vitest';
import { loadLegacyModule } from '../../test-support/loadLegacyModule';
import { G711AudioEncoder } from './G711AudioEncoder';

interface LegacyG711AudioEncoder {
  setSampleRate(rate: number): void;
  encode(buffer: Float32Array): Uint8Array;
  getCodecInfo(): unknown;
}

const LegacyG711AudioEncoderCtor = loadLegacyModule<new () => LegacyG711AudioEncoder>(
  'Talk/Encoder/audioEncoderG711.js',
  'G711AudioEncoder'
);

function makeSamples(length: number): Float32Array {
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    samples[i] = Math.sin(i / 4) * 0.5;
  }
  return samples;
}

describe('G711AudioEncoder parity with the legacy player’s Talk/Encoder/audioEncoderG711.js', () => {
  it('encode() downsamples from the default 48kHz to 8kHz identically', () => {
    const legacy = new LegacyG711AudioEncoderCtor();
    const ported = new G711AudioEncoder();
    const samples = makeSamples(64);
    expect(Array.from(ported.encode(samples))).toEqual(Array.from(legacy.encode(samples)));
  });

  it('encode() with matching sample rate (no downsampling) is identical, including remainder-buffer carry to a second call', () => {
    const legacy = new LegacyG711AudioEncoderCtor();
    const ported = new G711AudioEncoder();
    legacy.setSampleRate(8000);
    ported.setSampleRate(8000);

    const first = makeSamples(10);
    const second = makeSamples(10);
    expect(Array.from(ported.encode(first))).toEqual(Array.from(legacy.encode(first)));
    expect(Array.from(ported.encode(second))).toEqual(Array.from(legacy.encode(second)));
  });

  it('getCodecInfo() matches', () => {
    const legacy = new LegacyG711AudioEncoderCtor();
    const ported = new G711AudioEncoder();
    expect(ported.getCodecInfo()).toEqual(legacy.getCodecInfo());
  });
});
