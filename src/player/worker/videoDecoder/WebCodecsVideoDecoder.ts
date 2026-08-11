import { RTSPOverWebSocketError } from '../../exceptions';

export interface WebCodecsDecoderFrame {
  frameType: string;
  frameData: Uint8Array;
}

export type DecoderReadyCallback = () => void;

export interface WebCodecsVideoDecoderOptions {
  /** `'buffer'` (default) is the original canvas-path behavior: each decoded
   * `VideoFrame` is `copyTo()`'d into a flat `Uint8Array` and closed, queued
   * for `decode()`'s synchronous-pull return value. `'bridge'` is for the
   * MSE-bridge `<video>` tier (`VideoTagPlayer.ts`) — the live `VideoFrame`
   * is handed to `onBridgeFrame` unmodified (no `copyTo()`/plane-copy at
   * all) and NOT closed here; ownership passes to the caller, which writes
   * it into a `MediaStreamTrackGenerator`'s `.writable` and is responsible
   * for closing it if that write doesn't consume it (e.g. the writer
   * rejects). `decode()`'s return value is meaningless in this mode (always
   * `null` — nothing is ever pushed to `pending`); bridge-mode callers
   * don't read it.
   */
  outputMode?: 'buffer' | 'bridge';
  onBridgeFrame?: (frame: VideoFrame) => void;
}

const YUV420_CHROMA_SHIFT = 2; // chromaSize = lumaSize >> 2, matches YUVWebGLCanvas.drawCanvas

/**
 * Ordered fallback candidate codec strings for `VideoDecoder.configure()`.
 * Unlike `AssemblyDecoder`'s static `H264 → 264`/`H265 → 265` mapping, VP9/
 * AV1's codec string needs a profile/bit-depth WebCodecs has no way to infer
 * on its own — and this class can't derive the real value from the
 * bitstream ahead of time either: `decoderWorker.ts` only ever calls
 * `decode()` once `onDecoderReady` has already fired (frames arriving
 * earlier are buffered *outside* this class, in `decoderWorker.ts`'s own
 * `frameBuffer`), so there is no encoded frame available yet at configure
 * time to inspect. Profile 0 / 8-bit / 4:2:0 is overwhelmingly the common
 * case for camera-generated RTP streams, so it's tried first; every
 * candidate is verified with `VideoDecoder.isConfigSupported()` before being
 * committed to, rather than assumed blindly.
 */
function candidateCodecStrings(codecType: string): string[] {
  switch (codecType) {
    case 'VP8':
      return ['vp8'];
    case 'VP9':
      return ['vp09.00.10.08', 'vp09.02.10.10'];
    case 'AV1':
      return ['av01.0.04M.08', 'av01.1.04M.08'];
    default:
      return [];
  }
}

/**
 * Decodes VP8/VP9/AV1 video frames via the browser's native WebCodecs
 * `VideoDecoder`, inside the decoder Worker (see decoderWorker.ts) —
 * structurally parallel to `AssemblyDecoder` (same `decode()`/`close()`/
 * `channelId`/`addListener('onDecoderReady', cb)` surface, so
 * `decoderWorker.ts` can use either interchangeably) but wraps a browser API
 * instead of the vendored ffmpeg.wasm build, since there is no vendored WASM
 * decoder for these three codecs in this repo and WebCodecs decodes all
 * three natively in every currently-supported browser. `VideoDecoder`/
 * `EncodedVideoChunk`/`VideoFrame` are ordinary `dom`-lib ambient globals
 * (same mechanism `OPUSAudioDecoder.ts` relies on for `AudioDecoder`) and
 * resolve correctly at runtime inside a Worker's global scope too, the same
 * way unqualified `postMessage`/`MessageEvent` already do elsewhere in this
 * directory — no `self.`-prefixed access needed.
 *
 * WebCodecs' `VideoDecoder` is asynchronous (decoded output arrives via its
 * `output` callback, not `decode()`'s return value), but
 * `decoderWorker.ts`'s `decodeLiveMessage`/`onDecoderReady` expect a
 * synchronous `Uint8Array | null` back from `decode()` — bridged with the
 * same internal FIFO pattern `OPUSAudioDecoder.ts` uses for Opus/WebCodecs
 * `AudioDecoder`: `decode()` submits the new packet and returns whatever's
 * already been decoded and queued from *earlier* packets (matching
 * `AssemblyDecoder`'s own "null when nothing is ready yet" contract).
 */
export class WebCodecsVideoDecoder {
  channelId = 0;

  private decoder: VideoDecoder | null = null;
  private readonly pending: Uint8Array[] = [];
  private decoderReadyCallback: DecoderReadyCallback | null = null;
  private nextTimestampUs = 0;
  private closed = false;

  constructor(
    private readonly codecType: string,
    private readonly options: WebCodecsVideoDecoderOptions = {}
  ) {
    if (typeof VideoDecoder === 'undefined') {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: 0x0312,
        place: 'WebCodecsVideoDecoder.ts:constructor',
        message: 'WebCodecs VideoDecoder API is not supported!'
      });
    }

    void this.configure();
  }

  addListener(eventType: 'onDecoderReady', callback: DecoderReadyCallback): void {
    if (eventType === 'onDecoderReady') {
      this.decoderReadyCallback = callback;
    }
  }

  /** No-op — kept only so this class's public surface matches
   * `AssemblyDecoder`'s closely enough for `decoderWorker.ts` to use either
   * interchangeably without branching on every call site. WebCodecs'
   * `VideoDecoder` manages its own output-frame memory; there is no
   * malloc'd output buffer size to configure the way the WASM decoder
   * needs (see `AssemblyDecoder.setOutputSize`). */
  setOutputSize(_size: number): void {}

  private async configure(): Promise<void> {
    for (const codec of candidateCodecStrings(this.codecType)) {
      let supported = false;
      try {
        supported = (await VideoDecoder.isConfigSupported({ codec })).supported === true;
      } catch {
        supported = false;
      }
      if (!supported || this.closed) {
        continue;
      }

      this.decoder = new VideoDecoder({
        output: (frame) => this.onDecodedOutput(frame),
        error: () => {
          // No error-reporting channel exists on this class today (matches
          // AssemblyDecoder/OPUSAudioDecoder, neither of which surface
          // decode errors either) — a dropped/undecodable frame here just
          // yields no output for this one call, same as an empty queue.
        }
      });
      this.decoder.configure({ codec });
      this.decoderReadyCallback?.();
      return;
    }

    // eslint-disable-next-line no-console
    console.error(`WebCodecsVideoDecoder: no supported VideoDecoder configuration found for codecType=${this.codecType}`);
  }

  private onDecodedOutput(frame: VideoFrame): void {
    if (this.options.outputMode === 'bridge') {
      this.options.onBridgeFrame?.(frame);
      return;
    }

    // Chrome's copyTo() rejects any explicit non-RGB `format` option outright
    // ("copyTo() doesn't support explicit copy to non-RGB formats" —
    // confirmed live) — there is no way to request a conversion *to* I420,
    // only to read a frame that's already in a plain planar 4:2:0 format
    // (I420 is by far the most common output for 8-bit VP8/VP9 profile-0/
    // AV1 profile-0 decode, confirmed live). Frames in any other format
    // (10-/12-bit, 4:2:2/4:4:4, NV12's interleaved chroma, etc.) are dropped
    // here rather than fed through YUVWebGLCanvas's hardcoded tightly-packed
    // I420 plane-slicing assumption, which they'd corrupt silently.
    if (frame.format !== 'I420') {
      // eslint-disable-next-line no-console
      console.error(`WebCodecsVideoDecoder: unsupported VideoFrame pixel format=${frame.format} for codecType=${this.codecType} (only I420 is supported)`);
      frame.close();
      return;
    }

    // frame.codedWidth/codedHeight can be padded to the decoder's internal
    // alignment (confirmed live: 928×480 coded vs 854×480 actually-encoded
    // for a real VP9 stream) — displayWidth/displayHeight is the frame's
    // real, unpadded size (matching what VP9HeaderParser/VP8HeaderParser/
    // AV1HeaderParser already extracted from the bitstream itself, and what
    // YUVWebGLCanvas's textures were sized to in setCanvas()); copyTo()'s
    // default (no `rect`/`layout` options) already copies this unpadded
    // display region tightly packed, so the destination buffer must be
    // sized to match it exactly, not the padded coded dimensions.
    const lumaSize = frame.displayWidth * frame.displayHeight;
    const chromaSize = lumaSize >> YUV420_CHROMA_SHIFT;
    const buffer = new Uint8Array(lumaSize + 2 * chromaSize);

    frame
      .copyTo(buffer)
      .then(() => {
        this.pending.push(buffer);
      })
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error(
          `WebCodecsVideoDecoder: VideoFrame.copyTo failed for codecType=${this.codecType} codedWidth=${frame.codedWidth} codedHeight=${frame.codedHeight} bufferLength=${buffer.length}: ${String(err)}`
        );
      })
      .finally(() => {
        frame.close();
      });
  }

  decode(data: WebCodecsDecoderFrame): Uint8Array | null {
    if (this.decoder === null || this.decoder.state !== 'configured') {
      return null;
    }

    try {
      this.decoder.decode(
        new EncodedVideoChunk({
          type: data.frameType === 'I' ? 'key' : 'delta',
          timestamp: this.nextTimestampUs,
          data: data.frameData
        })
      );
    } catch {
      // The underlying VideoDecoder may have moved to 'closed' between the
      // state check above and this call (its async `error` callback can
      // fire at any time) — decoderWorker.ts has no surrounding try/catch of
      // its own, so a throw here would crash the worker's message handler
      // outright; dropping this one frame is the safer failure mode,
      // matching AssemblyDecoder's precondition-failure paths (which return
      // `null` rather than throwing).
      return null;
    }
    this.nextTimestampUs += 1;

    return this.pending.shift() ?? null;
  }

  close(): void {
    this.closed = true;
    this.pending.length = 0;
    if (this.decoder !== null && this.decoder.state !== 'closed') {
      this.decoder.close();
    }
  }
}
