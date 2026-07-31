import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EmscriptenModule } from '../../vendor/EmscriptenModule.d.ts';
import type { AudiotranscoderWorkerMessage } from './audiotranscoderWorker';

function createFakeModule(getAacReturn: () => number = () => 3): EmscriptenModule {
  const heap = new Int8Array(4096);
  let nextContext = 1;
  return {
    HEAP8: heap,
    _malloc: () => 0,
    cwrap: ((name: string) => {
      switch (name) {
        case 'openAudioDecoder':
        case 'open_AACEncoder':
          return () => nextContext++;
        case 'trans2AAC_pushAudio':
          return () => 0;
        case 'trans2AAC_getAAC':
          return getAacReturn;
        case 'close_audioDecoder':
        case 'close_aacEncoder':
          return () => 0;
        default:
          throw new Error(`unexpected cwrap: ${name}`);
      }
    }) as EmscriptenModule['cwrap']
  };
}

function fakeImportScripts(): void {
  Module.onRuntimeInitialized?.();
}

/** Contract-tier test: audiotranscoderWorker.js is onmessage/postMessage glue around AssemblyTranscoder (contract-tested separately). */
describe('audiotranscoderWorker contract tests (the legacy player’s Worker/AudioTranscoder/audiotranscoderWorker.js)', () => {
  let onmessage: ((event: { data: AudiotranscoderWorkerMessage }) => void) | null;
  let postMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onmessage = null;
    postMessage = vi.fn();
    vi.stubGlobal('importScripts', fakeImportScripts);
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    vi.stubGlobal('postMessage', postMessage);
    vi.stubGlobal('addEventListener', (_type: string, listener: typeof onmessage) => {
      onmessage = listener;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function loadWorker(module: EmscriptenModule): Promise<void> {
    vi.stubGlobal('Module', module);
    vi.resetModules();
    await import('./audiotranscoderWorker');
  }

  it('registers a message listener on import', async () => {
    await loadWorker(createFakeModule());
    expect(typeof onmessage).toBe('function');
  });

  /**
   * `fakeImportScripts` fires `Module.onRuntimeInitialized` synchronously
   * *during* `new AssemblyTranscoder(...)` — before `receiveMessage`'s
   * 'init' case has a chance to run `transcoder.addListener(...)` right
   * after. Real WASM instantiation is asynchronous, so in practice
   * `onRuntimeInitialized` always fires well after both calls complete; this
   * re-fires it to simulate that same realistic ordering for the test.
   */
  function initAndBecomeReady(data: { codecType: string; bitRate: number }): void {
    onmessage!({ data: { type: 'init', data } });
    Module.onRuntimeInitialized!();
  }

  it('transcodes once the transcoder becomes ready, posting the encoded bytes with the frame buffer transferred', async () => {
    await loadWorker(createFakeModule());
    initAndBecomeReady({ codecType: 'G711', bitRate: 64 });

    const streamData = { frameData: new Uint8Array([1, 2, 3, 4]) };
    onmessage!({ data: { type: 'transcode', data: streamData } });

    const transcodedCalls = postMessage.mock.calls.filter(([msg]) => msg.type === 'transcoded');
    expect(transcodedCalls).toHaveLength(1);
    expect(transcodedCalls[0][0].data.frameData.length).toBe(3);
    expect(transcodedCalls[0][1]).toEqual([transcodedCalls[0][0].data.frameData.buffer]);
  });

  it('does not send anything for a zero-length transcode result', async () => {
    await loadWorker(createFakeModule(() => 0));
    initAndBecomeReady({ codecType: 'G711', bitRate: 64 });

    onmessage!({ data: { type: 'transcode', data: { frameData: new Uint8Array([1, 2, 3]) } } });

    expect(postMessage.mock.calls.filter(([msg]) => msg.type === 'transcoded')).toHaveLength(0);
  });

  it('throws identically to legacy when transcode() fails (ret < 0 -> transcode() returns undefined -> reading .length throws)', async () => {
    await loadWorker(createFakeModule(() => -1));
    initAndBecomeReady({ codecType: 'G711', bitRate: 64 });

    expect(() => onmessage!({ data: { type: 'transcode', data: { frameData: new Uint8Array([1, 2, 3]) } } })).toThrow();
  });

  it('terminate closes the transcoder and posts a "terminated" message', async () => {
    await loadWorker(createFakeModule());
    initAndBecomeReady({ codecType: 'G711', bitRate: 64 });
    onmessage!({ data: { type: 'terminate' } });

    const terminatedCalls = postMessage.mock.calls.filter(([msg]) => msg.type === 'terminated');
    expect(terminatedCalls).toHaveLength(1);
  });

  it('a second "init" reuses the existing transcoder via openDecoder() instead of creating a new one', async () => {
    await loadWorker(createFakeModule());
    initAndBecomeReady({ codecType: 'G711', bitRate: 64 });
    // Second init should not throw, and the transcoder should still be usable afterward.
    expect(() => onmessage!({ data: { type: 'init', data: { codecType: 'G726', bitRate: 32 } } })).not.toThrow();

    onmessage!({ data: { type: 'transcode', data: { frameData: new Uint8Array([9]) } } });
    expect(postMessage.mock.calls.filter(([msg]) => msg.type === 'transcoded')).toHaveLength(1);
  });
});
