import { RTSPOverWebSocketError } from '../../exceptions/RTSPOverWebSocketError';
import { mjpegEncoderCandidateCodecStrings } from '../../util/codecString';

export interface WebCodecsEncodeInput {
  /** Raw JPEG bytes for one MJPEG frame. */
  frameData: Uint8Array;
  /** Caller-assigned, monotonically increasing microsecond timestamp -- purely
   *  internal `VideoEncoder`/`VideoFrame` bookkeeping, not derived from any
   *  real wall-clock/RTP time. `WebCodecsEncodedResult.timestampUs` below
   *  echoes it back unchanged (per the WebCodecs spec), so the caller can use
   *  it as a cheap FIFO-desync check against its own pending-frame queue --
   *  see `VideoTagPlayer.ts`'s `onMjpegEncodedChunk()`. */
  timestampUs: number;
  forceKeyFrame: boolean;
}

export interface WebCodecsEncodedResult {
  type: 'key' | 'delta';
  timestampUs: number;
  /** Length-prefixed (AVCC) H264 bitstream bytes -- `VideoEncoder` configured
   *  with `avc: { format: 'avc' }` (the default for `avc1.*`), so this is
   *  already in the shape `mp4Generator.js`'s samples need, unlike the
   *  Annex-B network bitstream `createSampleFrameData()` normally rewrites. */
  frameData: Uint8Array;
  /** The AVCDecoderConfigurationRecord ("avcC") bytes, present only on the
   *  chunk(s) that carry a config (typically just the very first one for a
   *  `VideoEncoder` that's never reconfigured) -- see `avcConfigParser.ts`. */
  description: Uint8Array | null;
}

export interface WebCodecsVideoEncoderOptions {
  onEncodedChunk: (result: WebCodecsEncodedResult) => void;
  onError?: (error: unknown) => void;
}

/**
 * Encodes MJPEG's per-frame JPEG images to H264 via the browser's native
 * WebCodecs `VideoEncoder`, for `VideoTagPlayer.ts`'s MJPEG-real-MSE tier
 * (`decideUseMjpegEncoder()`/`setupMjpegEncoder()`) -- structurally the
 * mirror image of `WebCodecsVideoDecoder.ts` (same constructor-throws-if-
 * unsupported guard, same `isConfigSupported()`-verified candidate-string
 * loop in `configure()`, same close()-guards-decoder-already-closed
 * pattern), but owns encode direction instead of decode, and (unlike that
 * class's `'buffer'` mode) has no synchronous-pull queue: `encode()` is
 * genuinely fire-and-forget, real output only ever arrives async via
 * `onEncodedChunk`.
 *
 * Runs on the main thread, same as `WebCodecsVideoDecoder`'s `'bridge'` mode
 * usage in `VideoTagPlayer.ts` (imported directly there, no `new Worker(...)`
 * spawned for it either) -- `VideoEncoder`/`VideoFrame`/`createImageBitmap`
 * are all ordinary main-thread-available APIs, and this class has no need
 * for a dedicated Worker of its own.
 */
export class WebCodecsVideoEncoder {
  channelId = 0;

  private encoder: VideoEncoder | null = null;
  private closed = false;
  // Real bug, found live against a real 2048x1536 camera: `encode()` awaits
  // `createImageBitmap()` (real, resolution-scaled CPU cost -- easily
  // hundreds of ms for a real, high-entropy JPEG frame, not the near-free
  // decode a flat/synthetic test frame gets) *before* ever reaching
  // `this.encoder.encode()`, but the caller's backpressure check
  // (`VideoTagPlayer.ts`'s `submitMjpegFrame()`) only ever inspects
  // `encodeQueueSize` -- which used to reflect only the underlying
  // `VideoEncoder`'s own queue, a count that stays 0 for every frame still
  // stuck awaiting `createImageBitmap()`. Since `encode()` is intentionally
  // fire-and-forget (never awaited by the caller), nothing throttled *this*
  // stage at all: a new frame arriving every ~500ms while the previous one's
  // `createImageBitmap()` was still resolving just launched another
  // concurrent decode on top of it, unbounded, each one competing for the
  // same CPU and taking even longer as a result -- confirmed live via direct
  // instrumentation (a synthetic 2048x1536 noise-JPEG Playback trace): the
  // gap between real received content and actually-muxed/buffered content
  // grew from ~1s to ~28s within the first real minute, entirely invisible
  // to the backpressure check the whole time (`encodeQueueSize` read 0
  // throughout). Now counted here too, so the caller's existing
  // `encodeQueueSize >= MJPEG_ENCODER_MAX_QUEUE_SIZE` check actually throttles
  // new frames once enough are mid-decode, not just once enough are
  // mid-encode.
  private pendingDecodeCount = 0;

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly options: WebCodecsVideoEncoderOptions
  ) {
    if (typeof VideoEncoder === 'undefined') {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: 0x0314,
        place: 'WebCodecsVideoEncoder.ts:constructor',
        message: 'WebCodecs VideoEncoder API is not supported!'
      });
    }

    void this.configure();
  }

  /** Lets callers implement backpressure (skip `encode()` calls when the
   *  encoder is falling behind) -- this class does not drop frames on its
   *  own, since it has no visibility into caller-side state like whether an
   *  init segment has been built yet (a frame that's needed for that must
   *  never be dropped, only the caller knows that). */
  get encodeQueueSize(): number {
    return (this.encoder?.encodeQueueSize ?? 0) + this.pendingDecodeCount;
  }

  get isConfigured(): boolean {
    return this.encoder !== null && this.encoder.state === 'configured';
  }

  private async configure(): Promise<void> {
    for (const codec of mjpegEncoderCandidateCodecStrings(this.width * this.height, DEFAULT_FRAMERATE_HINT)) {
      const config: VideoEncoderConfig = {
        codec,
        width: this.width,
        height: this.height,
        // A real-time-ish default, scaled by resolution rather than a single
        // fixed constant (matching the spirit of CanvasTagPlayer.ts's own
        // resolution-bucketed MJPEG draw throttle) -- a starting heuristic,
        // not independently tuned against real camera footage.
        bitrate: Math.round(this.width * this.height * BITRATE_BITS_PER_PIXEL),
        framerate: DEFAULT_FRAMERATE_HINT,
        avc: { format: 'avc' }
      };

      let supported = false;
      try {
        supported = (await VideoEncoder.isConfigSupported(config)).supported === true;
      } catch {
        supported = false;
      }
      if (!supported || this.closed) {
        continue;
      }

      this.encoder = new VideoEncoder({
        output: (chunk, metadata) => this.onEncodedOutput(chunk, metadata),
        error: (error) => {
          this.options.onError?.(error);
        }
      });
      this.encoder.configure(config);
      return;
    }

    // eslint-disable-next-line no-console
    console.error(`WebCodecsVideoEncoder: no supported VideoEncoder configuration found for ${this.width}x${this.height}`);
  }

  private onEncodedOutput(chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata): void {
    const buffer = new Uint8Array(chunk.byteLength);
    chunk.copyTo(buffer);

    const descriptionSource = metadata?.decoderConfig?.description;
    const description = descriptionSource ? new Uint8Array(descriptionSource as ArrayBuffer) : null;

    this.options.onEncodedChunk({
      type: chunk.type,
      timestampUs: chunk.timestamp,
      frameData: buffer,
      description
    });
  }

  /** Fire-and-forget: the caller never awaits a return value from this --
   *  the real result arrives later via `onEncodedChunk`. Returns a Promise
   *  only so `createImageBitmap()`'s own async JPEG decode step can be
   *  awaited internally before submitting to the encoder. */
  async encode(data: WebCodecsEncodeInput): Promise<void> {
    if (this.closed || this.encoder === null || this.encoder.state !== 'configured') {
      return;
    }

    this.pendingDecodeCount++;
    try {
      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(new Blob([data.frameData as BlobPart], { type: 'image/jpeg' }));
      } catch (error) {
        // A partial/corrupt JPEG (RTP packet loss) rejects here -- dropping
        // this one frame is the safe failure mode, matching
        // WebCodecsVideoDecoder.ts's own decode-error swallow.
        // eslint-disable-next-line no-console
        console.error(`WebCodecsVideoEncoder: createImageBitmap failed for a JPEG frame: ${String(error)}`);
        return;
      }

      if (this.closed || this.encoder.state !== 'configured') {
        bitmap.close();
        return;
      }

      const frame = new VideoFrame(bitmap, { timestamp: data.timestampUs });
      try {
        this.encoder.encode(frame, { keyFrame: data.forceKeyFrame });
      } catch {
        // The underlying VideoEncoder may have moved to 'closed' between the
        // state check above and this call (its async `error` callback can
        // fire at any time) -- dropping this one frame is the safer failure
        // mode, matching WebCodecsVideoDecoder.ts's own decode()-time guard.
      } finally {
        frame.close();
        bitmap.close();
      }
    } finally {
      this.pendingDecodeCount--;
    }
  }

  close(): void {
    this.closed = true;
    if (this.encoder !== null && this.encoder.state !== 'closed') {
      this.encoder.close();
    }
  }
}

const BITRATE_BITS_PER_PIXEL = 2;
const DEFAULT_FRAMERATE_HINT = 30;
