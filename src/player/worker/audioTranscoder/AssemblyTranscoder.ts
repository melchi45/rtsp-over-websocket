/// <reference path="../../vendor/EmscriptenModule.d.ts" />

export interface TranscoderCodecInfo {
  codecType: 'G711' | 'G726' | string;
  bitRate: number;
}

export type TranscoderReadyCallback = () => void;

declare function importScripts(...urls: string[]): void;

const OUTPUT_BUFFER_SIZE = 4096;

/**
 * Ported from the legacy player’s Worker/AudioTranscoder/assemblyTranscoder —
 * wraps the vendored vendor/ffmpegAAC.transcoder.js (Worker/wasm build; NOT
 * the same file as the main-thread asm.js build vendored for
 * AACAudioDecoder.ts) to transcode G.711/G.726 backup audio to AAC inside
 * the audio-transcode Worker (see audiotranscoderWorker.ts).
 *
 * `outputSize` is a legacy module-scope var initialized to `0` and never
 * reassigned anywhere in the file — `transcode()`'s `trans2AAC_getAAC(...,
 * outputSize)` call always passes `0` as the output buffer's size limit to
 * native code, despite `output` itself being a real 4096-byte buffer.
 * Preserved faithfully (not "fixed" to 4096) since it's what legacy actually
 * does.
 *
 * `init()`'s legacy `audioBitRate` local is computed but never read (it's
 * recomputed independently inside `openDecoder()` from the same `info`) —
 * confirmed write-only and dropped.
 *
 * Like AssemblyDecoder.ts, `importScripts`/`fetch` are constructor-injectable
 * (defaulting to the real globals) purely for testability. The asset URLs
 * passed to them use `new URL('...', import.meta.url)` so Vite emits
 * vendor/ffmpegAAC.transcoder.{js,wasm} as build assets and rewrites these
 * calls to the final hashed path, regardless of which page embeds the
 * built Worker chunk.
 */
export class AssemblyTranscoder {
  private encoderContext: number | null = null;
  private decoderContext: number | null = null;
  private output: Uint8Array | null = null;
  private transcoderReadyCallback: TranscoderReadyCallback | null = null;

  private openAudioDecoderFn!: (codec: number, bitRate: number) => number;
  private openAACEncoderFn!: () => number;
  private trans2AACPushAudioFn!: (decoderContext: number, encoderContext: number, frameData: Uint8Array, length: number) => number;
  private trans2AACGetAACFn!: (encoderContext: number, outputPtr: number, outputSize: number) => number;
  private closeAudioDecoderFn!: (context: number) => number;
  private closeAACEncoderFn!: (context: number) => number;

  constructor(
    codecType: TranscoderCodecInfo,
    importScriptsFn: (...urls: string[]) => void = importScripts,
    fetchFn: typeof fetch = fetch
  ) {
    Module.onRuntimeInitialized = () => {
      this.openAudioDecoderFn = Module.cwrap('openAudioDecoder', 'number', ['number', 'number']);
      this.openAACEncoderFn = Module.cwrap('open_AACEncoder', 'number', []);
      this.trans2AACPushAudioFn = Module.cwrap('trans2AAC_pushAudio', 'number', ['number', 'number', 'array', 'number']);
      this.trans2AACGetAACFn = Module.cwrap('trans2AAC_getAAC', 'number', ['number', 'number', 'number']);
      this.closeAudioDecoderFn = Module.cwrap('close_audioDecoder', 'number', ['number']);
      this.closeAACEncoderFn = Module.cwrap('close_aacEncoder', 'number', ['number']);

      this.init(codecType);

      // eslint-disable-next-line no-console
      console.log('Audio transcoder module onRuntimeInitialized');
    };

    // eslint-disable-next-line no-console
    console.log('Construct Audio transcoder wasm');
    // `Module.wasmBinary` must be assigned *before* the glue script runs:
    // its own `createWasm()` reads `Module["wasmBinary"]` synchronously at
    // the top of its own (synchronous) execution, falling back to fetching
    // a same-named "ffmpegAAC.wasm" next to itself if unset — a real file
    // that doesn't exist once the vendored wasm is bundled/inlined by Vite
    // (see AssemblyTranscoder.test.ts's fetch-before-importScripts test).
    fetchFn(new URL('../../vendor/ffmpegAAC.transcoder.wasm', import.meta.url).href)
      .then((response) => response.arrayBuffer())
      .then((buffer) => {
        Module.wasmBinary = buffer;
        importScriptsFn(new URL('../../vendor/ffmpegAAC.transcoder.js', import.meta.url).href);
      });
  }

  addListener(eventType: 'onTranscoderReady', callback: TranscoderReadyCallback): void {
    if (eventType === 'onTranscoderReady') {
      this.transcoderReadyCallback = callback;
    }
  }

  init(info: TranscoderCodecInfo): void {
    this.encoderContext = this.openAACEncoderFn();
    this.openDecoder(info);
    const outputPtr = Module._malloc(OUTPUT_BUFFER_SIZE);
    this.output = new Uint8Array(Module.HEAP8!.buffer, outputPtr, OUTPUT_BUFFER_SIZE);

    this.transcoderReadyCallback?.();
  }

  openDecoder(info: TranscoderCodecInfo): void {
    if (this.decoderContext !== null) {
      this.closeAudioDecoderFn(this.decoderContext);
      this.decoderContext = null;
    }
    const audioBitRate = info.bitRate * 1000;
    // eslint-disable-next-line no-console
    console.log('AudioTranscoder openDecoder codec : ' + info.codecType + ' bps : ' + audioBitRate);
    if (info.codecType === 'G711') {
      this.decoderContext = this.openAudioDecoderFn(1, audioBitRate);
    } else if (info.codecType === 'G726') {
      this.decoderContext = this.openAudioDecoderFn(3, audioBitRate);
    }
  }

  close(): void {
    if (this.output !== null && this.output.byteOffset) {
      this.output = null;
    }
    if (this.decoderContext !== null) {
      this.closeAudioDecoderFn(this.decoderContext);
      this.decoderContext = null;
    }
    if (this.encoderContext !== null) {
      this.closeAACEncoderFn(this.encoderContext);
      this.encoderContext = null;
    }
    // eslint-disable-next-line no-console
    console.log('Audio transcoder close');
  }

  transcode(data: Uint8Array): Uint8Array | undefined {
    const frameData = data;

    this.trans2AACPushAudioFn(this.decoderContext!, this.encoderContext!, frameData, frameData.length);
    // legacy: `outputSize` here is always 0 — see class doc comment.
    const ret = this.trans2AACGetAACFn(this.encoderContext!, this.output!.byteOffset, 0);

    if (ret < 0) {
      // eslint-disable-next-line no-console
      console.log('transcode2AAC error ret = ', ret);
      return undefined;
    }

    const encodedData = new Uint8Array(this.output!);
    const aacData = new Uint8Array(ret);
    aacData.set(encodedData.subarray(0, ret), 0);

    return aacData;
  }
}
