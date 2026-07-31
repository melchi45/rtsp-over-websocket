/// <reference path="../../vendor/EmscriptenModule.d.ts" />

export interface AssemblyDecoderFrame {
  frameType: string;
  frameData: Uint8Array;
}

export type DecoderReadyCallback = () => void;

declare function importScripts(...urls: string[]): void;

/**
 * Ported from the legacy player’s Worker/VideoDecoder/assemblyDecoder.js — wraps
 * the vendored ffmpeg.js/ffmpeg.wasm WASM build (see vendor/ffmpeg.js) to
 * decode H.264/H.265 video frames inside the decoder Worker
 * (see decoderWorker.ts).
 *
 * `checkPerformance` is a legacy module-scope constant hardcoded to `false`
 * and never reassigned anywhere in the file — the `if (checkPerformance)`
 * branches (an alternate 5-arg `cwrap` signature and an extra interval-timing
 * `Module._malloc`/`console.log` path in `decode()`) are confirmed 100% dead
 * and dropped; only the always-taken `else` paths are kept.
 *
 * The unreachable `return null;` after `throw new RTSPOverWebSocketError(...)` in
 * `decode()`'s context-missing branch is dropped (dead code after a throw).
 *
 * Like AACAudioDecoder.ts, this assumes the vendor `Module` global's async
 * WASM bootstrapping (`importScripts(...)` + `fetch(...)` +
 * `Module.onRuntimeInitialized`) runs the same way it does in legacy. The
 * asset URLs use `new URL('...', import.meta.url)` so Vite emits
 * vendor/ffmpeg.{js,wasm} as build assets and rewrites these calls to the
 * final hashed path. `importScripts`/`fetch` are still constructor-injectable
 * (defaulting to the real globals) purely so tests can substitute fakes
 * without needing a real Worker/WASM environment.
 */
export class AssemblyDecoder {
  channelId = 0;

  private context: number | null = null;
  private readonly ID: number;
  private outpicsize = 0;
  private iFrameCheck = false;
  private decoderReadyCallback: DecoderReadyCallback | null = null;

  private initDecoderFn!: () => void;
  private decoderContextFn!: (id: number) => number;
  private decodeByFFMPEGFn!: (context: number, frameData: Uint8Array, length: number, outPtr: number) => number;
  private closeContextFn!: (context: number) => number;

  constructor(
    codecType: string,
    importScriptsFn: (...urls: string[]) => void = importScripts,
    fetchFn: typeof fetch = fetch
  ) {
    this.ID = codecType === 'H264' ? 264 : 265;

    Module.onRuntimeInitialized = () => {
      this.initDecoderFn = Module.cwrap('init_jsFFmpeg', 'void', []);
      this.decoderContextFn = Module.cwrap('context_jsFFmpeg', 'number', ['number']);
      this.decodeByFFMPEGFn = Module.cwrap('decode_video_jsFFmpeg', 'number', ['number', 'array', 'number', 'number']);
      this.closeContextFn = Module.cwrap('close_jsFFmpeg', 'number', ['number']);
      this.initDecoderFn();

      this.init();
      this.setOutputSize(0);
    };

    // eslint-disable-next-line no-console
    console.log('Construct H' + this.ID + ' Codec');
    // `Module.wasmBinary` must be assigned *before* the glue script runs:
    // its own `createWasm()` reads `Module["wasmBinary"]` synchronously at
    // the top of its own (synchronous) execution, falling back to fetching
    // a same-named "ffmpeg.wasm" next to itself if unset — a real file that
    // doesn't exist once the vendored wasm is bundled/inlined by Vite (see
    // AssemblyDecoder.test.ts's fetch-before-importScripts test).
    fetchFn(new URL('../../vendor/ffmpeg.wasm', import.meta.url).href)
      .then((response) => response.arrayBuffer())
      .then((buffer) => {
        Module.wasmBinary = buffer;
        importScriptsFn(new URL('../../vendor/ffmpeg.js', import.meta.url).href);
      });
  }

  addListener(eventType: 'onDecoderReady', callback: DecoderReadyCallback): void {
    if (eventType === 'onDecoderReady') {
      this.decoderReadyCallback = callback;
    }
  }

  init(): void {
    // eslint-disable-next-line no-console
    console.log('H' + this.ID + ' Decoder init');
    if (this.context !== null) {
      this.closeContextFn(this.context);
      this.context = null;
    }
    this.context = this.decoderContextFn(this.ID);
    if (this.decoderReadyCallback !== null && typeof this.decoderReadyCallback === 'function') {
      this.decoderReadyCallback();
    }
  }

  close(): void {
    // eslint-disable-next-line no-console
    console.log('H' + this.ID + ' Decoder close');
    if (this.context !== null) {
      this.closeContextFn(this.context);
      this.context = null;
      // eslint-disable-next-line no-console
      console.log('close webassembly codec context');
    }
  }

  setOutputSize(size: number): void {
    // eslint-disable-next-line no-console
    console.log('H' + this.ID + ' Decoder setOutputSize');
    if (size > 0) {
      this.outpicsize = size;
    }
  }

  decode(data: AssemblyDecoderFrame): Uint8Array | null {
    if (this.context === null) {
      return null;
    }

    if (!(this.iFrameCheck === true || data.frameType === 'I')) {
      return null;
    }
    this.iFrameCheck = true;

    // legacy re-checks `context !== null` here with an `else` throwing
    // rtspOverWebSocketError (plus an unreachable `return null;` after it) — both branches
    // are provably dead: `context` is a synchronous, single-threaded local
    // that can't change between the entry guard above and here, and nothing
    // else in this call path mutates it. Dropped along with the unused
    // RTSPOverWebSocketError/fromHex imports that branch alone would have needed.
    const outpicptr = Module._malloc(this.outpicsize);
    const outpic = new Uint8Array(Module.HEAPU8!.buffer, outpicptr, this.outpicsize);

    this.decodeByFFMPEGFn(this.context, data.frameData, data.frameData.length, outpic.byteOffset);

    const copyOutput = new Uint8Array(outpic);
    Module._free!(outpic.byteOffset);

    return copyOutput;
  }
}
