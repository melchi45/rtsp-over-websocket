import { describe, it, expect, vi, afterEach } from 'vitest';
import { AssemblyTranscoder } from './AssemblyTranscoder';
import type { EmscriptenModule } from '../../vendor/EmscriptenModule.d.ts';

const OUTPUT_SIZE = 4096;

function createFakeModule(): { module: EmscriptenModule; closedDecoderContexts: number[]; closedEncoderContexts: number[] } {
  const heap = new Int8Array(OUTPUT_SIZE);
  let nextDecoderContext = 1;
  let nextEncoderContext = 500;
  const closedDecoderContexts: number[] = [];
  const closedEncoderContexts: number[] = [];

  const module: EmscriptenModule = {
    HEAP8: heap,
    _malloc: () => 0,
    cwrap: ((name: string) => {
      switch (name) {
        case 'openAudioDecoder':
          return () => nextDecoderContext++;
        case 'open_AACEncoder':
          return () => nextEncoderContext++;
        case 'trans2AAC_pushAudio':
          return (_decoderContext: number, _encoderContext: number, frameData: Uint8Array) => {
            for (let i = 0; i < Math.min(frameData.length, heap.length); i++) {
              heap[i] = frameData[i];
            }
            return 0;
          };
        case 'trans2AAC_getAAC':
          return (encoderContext: number) => (encoderContext < 0 ? -1 : 3); // pretend 3 encoded bytes are ready
        case 'close_audioDecoder':
          return (context: number) => {
            closedDecoderContexts.push(context);
            return 0;
          };
        case 'close_aacEncoder':
          return (context: number) => {
            closedEncoderContexts.push(context);
            return 0;
          };
        default:
          throw new Error(`unexpected cwrap name: ${name}`);
      }
    }) as EmscriptenModule['cwrap']
  };
  return { module, closedDecoderContexts, closedEncoderContexts };
}

function fakeImportScripts(): void {
  Module.onRuntimeInitialized?.();
}

// The constructor now fetches the wasm buffer *before* calling
// importScriptsFn (see AssemblyTranscoder.ts's constructor comment), so
// tests that expect the runtime to actually initialize need a fetch that
// resolves, not one that hangs forever.
function fakeFetchResolves(): Promise<Response> {
  return Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) } as Response);
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('AssemblyTranscoder contract tests (the legacy player’s Worker/AudioTranscoder/assemblyTranscoder.js)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls the ready callback once the runtime initializes, having opened both the AAC encoder and the requested audio decoder', async () => {
    const { module } = createFakeModule();
    vi.stubGlobal('Module', module);
    const ready = vi.fn();

    const transcoder = new AssemblyTranscoder({ codecType: 'G711', bitRate: 64 }, fakeImportScripts, fakeFetchResolves);
    transcoder.addListener('onTranscoderReady', ready);
    // The listener is registered before the fetch resolves, so the real
    // (fake) runtime-init callback fires exactly once with it attached —
    // no manual re-fire needed (unlike when importScriptsFn ran
    // synchronously in the constructor, before addListener had a chance
    // to run).
    await flushMicrotasks();

    expect(ready).toHaveBeenCalledTimes(1);
  });

  it('transcode() returns the encoded AAC bytes reported by trans2AAC_getAAC', async () => {
    const { module } = createFakeModule();
    vi.stubGlobal('Module', module);
    const transcoder = new AssemblyTranscoder({ codecType: 'G711', bitRate: 64 }, fakeImportScripts, fakeFetchResolves);
    await flushMicrotasks();

    const result = transcoder.transcode(new Uint8Array([1, 2, 3, 4]));

    expect(result).toBeInstanceOf(Uint8Array);
    expect(result!.length).toBe(3);
  });

  it('openDecoder() closes any existing decoder context before opening a new one', async () => {
    const { module, closedDecoderContexts } = createFakeModule();
    vi.stubGlobal('Module', module);
    const transcoder = new AssemblyTranscoder({ codecType: 'G711', bitRate: 64 }, fakeImportScripts, fakeFetchResolves);
    await flushMicrotasks();

    transcoder.openDecoder({ codecType: 'G726', bitRate: 32 });

    expect(closedDecoderContexts).toHaveLength(1);
  });

  it('close() closes both decoder and encoder contexts', async () => {
    const { module, closedDecoderContexts, closedEncoderContexts } = createFakeModule();
    vi.stubGlobal('Module', module);
    const transcoder = new AssemblyTranscoder({ codecType: 'G711', bitRate: 64 }, fakeImportScripts, fakeFetchResolves);
    await flushMicrotasks();

    transcoder.close();

    expect(closedDecoderContexts).toHaveLength(1);
    expect(closedEncoderContexts).toHaveLength(1);
  });
});
