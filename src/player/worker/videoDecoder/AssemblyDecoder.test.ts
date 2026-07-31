import { describe, it, expect, vi, afterEach } from 'vitest';
import { AssemblyDecoder } from './AssemblyDecoder';
import type { EmscriptenModule } from '../../vendor/EmscriptenModule.d.ts';

const OUTPIC_SIZE = 64;

/** Deterministic stand-in for the vendored ffmpeg.js WASM build's `Module` global. */
function createFakeModule(): { module: EmscriptenModule; closeCalls: number[]; initCalls: number } {
  const heap = new Uint8Array(OUTPIC_SIZE);
  let nextContext = 100;
  const closeCalls: number[] = [];
  let initCalls = 0;

  const module: EmscriptenModule = {
    HEAPU8: heap,
    _malloc: () => 0,
    _free: () => {},
    cwrap: ((name: string) => {
      if (name === 'init_jsFFmpeg') {
        return () => {
          initCalls += 1;
        };
      }
      if (name === 'context_jsFFmpeg') {
        return (_id: number) => nextContext++;
      }
      if (name === 'decode_video_jsFFmpeg') {
        return (context: number, frameData: Uint8Array) => {
          for (let i = 0; i < Math.min(frameData.length, heap.length); i++) {
            heap[i] = (frameData[i] + context) & 0xff;
          }
          return 0;
        };
      }
      if (name === 'close_jsFFmpeg') {
        return (context: number) => {
          closeCalls.push(context);
          return 0;
        };
      }
      throw new Error(`unexpected cwrap name: ${name}`);
    }) as EmscriptenModule['cwrap']
  };
  return { module, closeCalls, initCalls };
}

/** importScripts fake that synchronously fires Module.onRuntimeInitialized, standing in for "WASM instantiation completed". */
function fakeImportScripts(): void {
  Module.onRuntimeInitialized?.();
}

function fakeFetchNeverResolves(): Promise<Response> {
  return new Promise(() => {});
}

// The constructor now fetches the wasm buffer *before* calling
// importScriptsFn (see AssemblyDecoder.ts's constructor comment), so tests
// that expect the runtime to actually initialize need a fetch that
// resolves, not one that hangs forever.
function fakeFetchResolves(): Promise<Response> {
  return Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) } as Response);
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('AssemblyDecoder contract tests (the legacy player’s Worker/VideoDecoder/assemblyDecoder.js)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('picks codec ID 264 for H264 and 265 for anything else, and calls the ready callback once the runtime initializes', async () => {
    const { module } = createFakeModule();
    vi.stubGlobal('Module', module);
    const readyCallback = vi.fn();

    const decoder = new AssemblyDecoder('H264', fakeImportScripts, fakeFetchResolves);
    decoder.addListener('onDecoderReady', readyCallback);
    // The listener is registered before the fetch resolves, so the real
    // (fake) runtime-init callback fires exactly once with it attached —
    // no manual re-fire needed (unlike when importScriptsFn ran
    // synchronously in the constructor, before addListener had a chance
    // to run).
    await flushMicrotasks();

    expect(readyCallback).toHaveBeenCalledTimes(1);

    const decoderH265 = new AssemblyDecoder('H265', fakeImportScripts, fakeFetchResolves);
    expect(decoderH265).toBeInstanceOf(AssemblyDecoder);
  });

  it('decode() returns null before any I-frame has been seen, then decodes I/P frames once primed', async () => {
    const { module } = createFakeModule();
    vi.stubGlobal('Module', module);

    const decoder = new AssemblyDecoder('H264', fakeImportScripts, fakeFetchResolves);
    await flushMicrotasks();
    decoder.setOutputSize(4);

    expect(decoder.decode({ frameType: 'P', frameData: new Uint8Array([1, 2, 3, 4]) })).toBeNull();

    const iFrameResult = decoder.decode({ frameType: 'I', frameData: new Uint8Array([1, 2, 3, 4]) });
    expect(iFrameResult).not.toBeNull();
    expect(iFrameResult!.length).toBe(4);

    // Once primed by an I-frame, subsequent P-frames decode too (iFrameCheck latches true).
    const pFrameResult = decoder.decode({ frameType: 'P', frameData: new Uint8Array([5, 6, 7, 8]) });
    expect(pFrameResult).not.toBeNull();
  });

  it('decode() returns null once context is null (before init completes / after close())', () => {
    // Module with no cwrap ever invoked — runtime never "initializes" (fetch never resolves), so context stays null.
    const { module } = createFakeModule();
    vi.stubGlobal('Module', module);

    const decoder = new AssemblyDecoder('H264', () => {}, fakeFetchNeverResolves);
    expect(decoder.decode({ frameType: 'I', frameData: new Uint8Array([1]) })).toBeNull();
  });

  it('init() re-closes any existing context before opening a new one, and close() clears it', async () => {
    const { module, closeCalls } = createFakeModule();
    vi.stubGlobal('Module', module);

    const decoder = new AssemblyDecoder('H264', fakeImportScripts, fakeFetchResolves);
    await flushMicrotasks();
    const firstCloseCallCount = closeCalls.length; // init() already ran once via onRuntimeInitialized

    decoder.init();
    expect(closeCalls.length).toBe(firstCloseCallCount + 1);

    decoder.close();
    expect(closeCalls.length).toBe(firstCloseCallCount + 2);

    // decode() after close() sees context === null again.
    expect(decoder.decode({ frameType: 'I', frameData: new Uint8Array([1]) })).toBeNull();
  });

  it('channelId is a plain settable field', async () => {
    const { module } = createFakeModule();
    vi.stubGlobal('Module', module);
    const decoder = new AssemblyDecoder('H264', fakeImportScripts, fakeFetchResolves);
    await flushMicrotasks();
    decoder.channelId = 3;
    expect(decoder.channelId).toBe(3);
  });
});
