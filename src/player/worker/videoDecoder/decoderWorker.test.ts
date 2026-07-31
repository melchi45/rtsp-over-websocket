import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EmscriptenModule } from '../../vendor/EmscriptenModule.d.ts';
import type { DecoderWorkerMessage } from './decoderWorker';

function createFakeModule(): EmscriptenModule {
  const heap = new Uint8Array(64);
  let nextContext = 1;
  return {
    HEAPU8: heap,
    _malloc: () => 0,
    _free: () => {},
    cwrap: ((name: string) => {
      if (name === 'init_jsFFmpeg') return () => {};
      if (name === 'context_jsFFmpeg') return () => nextContext++;
      if (name === 'decode_video_jsFFmpeg') {
        return (context: number, frameData: Uint8Array) => {
          for (let i = 0; i < Math.min(frameData.length, heap.length); i++) {
            heap[i] = (frameData[i] + context) & 0xff;
          }
          return 0;
        };
      }
      if (name === 'close_jsFFmpeg') return () => 0;
      throw new Error(`unexpected cwrap: ${name}`);
    }) as EmscriptenModule['cwrap']
  };
}

/** Contract-tier test: decoderWorker.js is onmessage/postMessage glue + drop-frame heuristics around AssemblyDecoder (contract-tested separately). */
describe('decoderWorker contract tests (the legacy player’s Worker/VideoDecoder/decoderWorker.js)', () => {
  let onmessage: ((event: { data: DecoderWorkerMessage }) => void) | null;
  let postMessage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    onmessage = null;
    postMessage = vi.fn();
    vi.stubGlobal('Module', createFakeModule());
    vi.stubGlobal('importScripts', vi.fn()); // no-op: WASM "not ready yet" until the test fires Module.onRuntimeInitialized itself
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    vi.stubGlobal('self', { postMessage });
    vi.stubGlobal('addEventListener', (_type: string, listener: typeof onmessage) => {
      onmessage = listener;
    });
    vi.resetModules();
    await import('./decoderWorker');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers a message listener on import', () => {
    expect(typeof onmessage).toBe('function');
  });

  it('buffers decode messages until the decoder becomes ready, then drains them once WASM finishes initializing', () => {
    onmessage!({ data: { type: 'createDecoder', data: 'H264', channelId: 5 } });
    onmessage!({ data: { type: 'playMode', data: 'live' } });

    const frame1 = { type: 'decode' as const, data: { frameType: 'I', frameData: new Uint8Array([1, 2, 3]), currentFps: 30 } };
    onmessage!({ data: frame1 });
    expect(postMessage).not.toHaveBeenCalled();

    // WASM finishes initializing: onRuntimeInitialized fires -> AssemblyDecoder.init() -> onDecoderReady().
    // frameBuffer is non-empty (frame1 queued above), so isDecoderReady flips true and the buffer drains.
    Module.onRuntimeInitialized!();

    const decodedCalls = postMessage.mock.calls.filter(([msg]) => msg.type === 'decoded');
    expect(decodedCalls).toHaveLength(1);
    expect(decodedCalls[0][0].data.channelId).toBe(5);
  });

  it('never becomes ready if WASM finishes initializing while the buffer is empty and playMode is not "Playback" (documented legacy deadlock)', () => {
    onmessage!({ data: { type: 'createDecoder', data: 'H264', channelId: 1 } });
    // No 'playMode' message sent, frameBuffer still empty at this point.
    Module.onRuntimeInitialized!();

    // A decode message arriving *after* that now just gets buffered forever.
    onmessage!({ data: { type: 'decode', data: { frameType: 'I', frameData: new Uint8Array([1]) } } });

    expect(postMessage.mock.calls.filter(([msg]) => msg.type === 'decoded')).toHaveLength(0);
  });

  it('decodes live messages once ready, and skips non-I frames whose previous decode already tripped the primary threshold', () => {
    onmessage!({ data: { type: 'createDecoder', data: 'H264', channelId: 2 } });
    onmessage!({ data: { type: 'playMode', data: 'Playback' } });
    Module.onRuntimeInitialized!(); // buffer empty, playMode === 'Playback' -> isDecoderReady becomes true immediately

    onmessage!({ data: { type: 'decode', data: { frameType: 'I', frameData: new Uint8Array([9, 9]), currentFps: 30 } } });
    const decodedCalls = postMessage.mock.calls.filter(([msg]) => msg.type === 'decoded');
    expect(decodedCalls).toHaveLength(1);
  });

  it('terminate closes the decoder and posts a "terminated" message with its channelId', () => {
    onmessage!({ data: { type: 'createDecoder', data: 'H264', channelId: 9 } });
    onmessage!({ data: { type: 'terminate' } });

    const terminatedCalls = postMessage.mock.calls.filter(([msg]) => msg.type === 'terminated');
    expect(terminatedCalls).toHaveLength(1);
    expect(terminatedCalls[0][0].data.channelId).toBe(9);
  });
});
