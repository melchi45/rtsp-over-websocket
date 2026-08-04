/// <reference path="../../vendor/EmscriptenModule.d.ts" />
import { AudioDecoder } from './AudioDecoder';

const OUTPIC_SIZE = 4096;

/**
 * Ported from the legacy player’s Listen/Decoder/audioDecoderAAC — wraps the
 * vendored ffmpegAAC.js asm.js build (see vendor/ffmpegAAC.decoder.js) to
 * decode AAC frames to PCM on the main thread.
 *
 * Like Minizip (zipWorker.ts), the vendor build attaches a bare global
 * `Module` and relies on running as its own classic top-level script — this
 * class assumes `Module` is already loaded (legacy's own HTML pages include
 * it via a `<script>` tag before constructing AACAudioDecoder; wiring the
 * equivalent load step into the new build is `elements/RTSPOverWebSocket.ts`'s
 * concern, not something this class does itself).
 *
 * `console.log` calls are literal (not the suppressed `xxx_log.*` wrapped
 * logger elsewhere in this port) and are preserved faithfully.
 */
export class AACAudioDecoder extends AudioDecoder {
  private context: number | null = null;
  private outpic: Float32Array = new Float32Array();

  private readonly initDecoder: () => number;
  private readonly decodeAacByFfmpeg: (context: number, buffer: ArrayLike<number>, bufferLength: number, outpicPtr: number, outpicSize: number) => number;
  private readonly closeContext: (context: number) => number;

  constructor() {
    super();
    // eslint-disable-next-line no-console
    console.log('Construct AAC Codec');

    this.initDecoder = Module.cwrap('init_aac_jsFFmpeg', 'void', []);
    this.decodeAacByFfmpeg = Module.cwrap('decode_aac_jsFFmpeg', 'number', ['number', 'array', 'number', 'number', 'number']);
    this.closeContext = Module.cwrap('close_jsFFmpeg', 'number', ['number']);

    this.init();
  }

  init(): void {
    // eslint-disable-next-line no-console
    console.log('AAC Decoder init');
    if (this.context !== null) {
      this.closeContext(this.context);
      this.context = null;
    }
    this.context = this.initDecoder();

    const outpicptr = Module._malloc(OUTPIC_SIZE);
    this.outpic = new Float32Array(Module.HEAPF32!.buffer, outpicptr, OUTPIC_SIZE);
  }

  decode(buffer: ArrayLike<number>): Float32Array {
    if (this.context === null) {
      // legacy: `if (context === null) return null;` — a real possible
      // return value once `close()` has run, kept faithfully via this cast
      // rather than widening the shared AudioDecoderLike.decode() contract
      // (G711/G726x never return null; AudioPlayerGxx's own call site
      // doesn't null-check either, so this preserves the same crash-if-
      // called-after-close behavior legacy has).
      return null as unknown as Float32Array;
    }

    this.decodeAacByFfmpeg(this.context, buffer, buffer.length, this.outpic.byteOffset, OUTPIC_SIZE);
    const rawData = new Float32Array(this.outpic);
    const pcmData = new Float32Array(1024);
    pcmData.set(rawData.subarray(0, 1024), 0);

    return pcmData;
  }

  override close(): void {
    if (this.context !== null) {
      this.closeContext(this.context);
      this.context = null;
    }
  }
}
