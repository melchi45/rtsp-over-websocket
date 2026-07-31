import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadLegacyModule, type LegacySandbox } from '../../test-support/loadLegacyModule';
import { createBaseLegacySandbox, createAudioDecoderLegacySandbox } from '../../test-support/legacyGlobals';
import { AACAudioDecoder } from './AACAudioDecoder';
import type { EmscriptenModule } from '../../vendor/EmscriptenModule.d.ts';

interface LegacyAACAudioDecoder {
  channelId: number;
  init(): void;
  decode(buffer: ArrayLike<number>): Float32Array | null;
  close(): void;
}

const OUTPIC_SIZE = 4096;

/** Deterministic stand-in for the vendored ffmpegAAC.js asm.js `Module` global, driven purely by call sequence/inputs (not real AAC decoding). */
function createFakeModule(): EmscriptenModule {
  const heap = new Float32Array(OUTPIC_SIZE);
  let nextContext = 1;

  return {
    HEAPF32: heap,
    _malloc: () => 0,
    cwrap: ((name: string) => {
      if (name === 'init_aac_jsFFmpeg') {
        return () => nextContext++;
      }
      if (name === 'decode_aac_jsFFmpeg') {
        return (context: number, buffer: ArrayLike<number>) => {
          for (let i = 0; i < Math.min(buffer.length, heap.length); i++) {
            heap[i] = (buffer[i] + context) / 1000;
          }
          return 0;
        };
      }
      if (name === 'close_jsFFmpeg') {
        return (_context: number) => 0;
      }
      throw new Error(`unexpected cwrap name: ${name}`);
    }) as EmscriptenModule['cwrap']
  };
}

function newLegacy(fakeModule: EmscriptenModule): LegacyAACAudioDecoder {
  const base = createBaseLegacySandbox();
  const sandbox: LegacySandbox = {
    ...base,
    ...createAudioDecoderLegacySandbox(),
    Module: fakeModule
  };
  const Ctor = loadLegacyModule<new () => LegacyAACAudioDecoder>('Listen/Decoder/audioDecoderAAC.js', 'AACAudioDecoder', sandbox);
  return new Ctor();
}

describe('AACAudioDecoder parity with the legacy player’s Listen/Decoder/audioDecoderAAC.js', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('decodes identically given the same Module stub (same input bytes -> same 1024-sample PCM output)', () => {
    vi.stubGlobal('Module', createFakeModule());
    const ported = new AACAudioDecoder();

    const legacy = newLegacy(createFakeModule());

    const input = new Uint8Array([1, 2, 3, 4, 5]);
    const legacyResult = legacy.decode(input);
    const portedResult = ported.decode(input);

    expect(Array.from(portedResult)).toEqual(Array.from(legacyResult as Float32Array));
    expect(portedResult.length).toBe(1024);
  });

  it('returns null identically once close() has been called (legacy: `if (context === null) return null;`)', () => {
    vi.stubGlobal('Module', createFakeModule());
    const ported = new AACAudioDecoder();
    ported.close();

    const legacy = newLegacy(createFakeModule());
    legacy.close();

    const input = new Uint8Array([9, 9, 9]);
    expect(legacy.decode(input)).toBeNull();
    expect(ported.decode(input)).toBeNull();
  });

  it('re-init after close (calling init() again) resumes decoding identically', () => {
    vi.stubGlobal('Module', createFakeModule());
    const ported = new AACAudioDecoder();
    ported.close();
    ported.init();

    const legacy = newLegacy(createFakeModule());
    legacy.close();
    legacy.init();

    const input = new Uint8Array([7, 8]);
    const legacyResult = legacy.decode(input);
    const portedResult = ported.decode(input);

    expect(legacyResult).not.toBeNull();
    expect(Array.from(portedResult)).toEqual(Array.from(legacyResult as Float32Array));
  });

  it('channelId defaults to 0, identically', () => {
    vi.stubGlobal('Module', createFakeModule());
    const ported = new AACAudioDecoder();
    const legacy = newLegacy(createFakeModule());

    expect(ported.channelId).toBe(legacy.channelId);
    expect(ported.channelId).toBe(0);
  });
});
