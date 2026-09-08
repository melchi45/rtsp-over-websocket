import { RTSPOverWebSocketError } from '../../exceptions/RTSPOverWebSocketError';

export interface WebCodecsAudioEncodeInput {
  /** Mono PCM samples, `-1..1` range -- the shape
   *  `G711AudioDecoder`/`G726xAudioDecoder` (`src/player/listen/decoder/`)
   *  already produce for the G.711/G.726-transcoded-to-AAC-in-browser path
   *  (always fixed at 8000Hz mono, see `VideoTagPlayer.ts`'s `setAudioInfo()`
   *  comment on why that's hardcoded rather than derived per-source). */
  pcm: Float32Array;
  /** Caller-assigned, monotonically increasing microsecond timestamp -- same
   *  convention as `WebCodecsVideoEncoder`'s `WebCodecsEncodeInput.timestampUs`:
   *  purely internal `AudioEncoder`/`AudioData` bookkeeping, echoed back
   *  unchanged in `WebCodecsAudioEncodedResult.timestampUs` so the caller can
   *  use it as a FIFO-desync check against its own pending-frame queue. */
  timestampUs: number;
}

export interface WebCodecsAudioEncodedResult {
  /** AAC (ADTS-less, raw access unit) bitstream bytes -- the same shape
   *  `AssemblyTranscoder.transcode()`'s WASM output already is, so both
   *  paths feed the exact same `createAudioSample(data, audioInfo, 'AAC')`
   *  re-entry point in `VideoTagPlayer.ts`. */
  frameData: Uint8Array;
  timestampUs: number;
  /** The AudioSpecificConfig bytes, present only on the chunk(s) that carry
   *  a decoder config (typically just the first one for an `AudioEncoder`
   *  that's never reconfigured). Unused by the current integration (the AAC
   *  track's `esds()` box is already built from `VideoTagPlayer.ts`'s own
   *  fixed 8000Hz-mono `audioInfo` fields, not from this), kept for parity
   *  with `WebCodecsVideoEncoder`'s `description` field and potential future
   *  use. */
  description: Uint8Array | null;
}

export interface WebCodecsAudioEncoderOptions {
  onEncodedChunk: (result: WebCodecsAudioEncodedResult) => void;
  /** The underlying `AudioEncoder`'s own `error` callback -- fires after
   *  `configure()` already succeeded. */
  onError?: (error: unknown) => void;
  /** Fires once, from `configure()`, if no supported `AudioEncoder`
   *  configuration was found for the requested sample rate/channel count --
   *  unlike `WebCodecsVideoEncoder` (which has no fallback tier and just
   *  `console.error`s), this class's caller (`VideoTagPlayer.ts`) has a real
   *  fallback (the existing WASM `AssemblyTranscoder` path) to switch to, so
   *  this needs to actually reach the caller rather than only be logged. */
  onUnsupported?: () => void;
}

const AAC_CODEC_STRING = 'mp4a.40.2';
const DEFAULT_BITRATE = 64000;

/**
 * Encodes PCM (already decoded from G.711/G.726 by the pure-JS
 * `G711AudioDecoder`/`G726xAudioDecoder` in `src/player/listen/decoder/` --
 * no WASM involved on this side either) to AAC via the browser's native
 * WebCodecs `AudioEncoder`, as an alternative to `VideoTagPlayer.ts`'s
 * existing WASM `AssemblyTranscoder`/`audiotranscoderWorker` path (selected
 * via the `audioencodermode` attribute/property -- see
 * `docs/player/05-video-tag-player.md`). Structurally the audio mirror
 * of `WebCodecsVideoEncoder.ts` (same constructor-throws-if-unsupported
 * guard, same `isConfigSupported()`-verified `configure()`, same
 * close()-guards-already-closed pattern) -- the one real difference is
 * `onUnsupported`, above: video's MJPEG tier has no fallback so it only logs,
 * but this class's caller always has WASM to fall back to, so unsupported
 * config needs to actually propagate.
 *
 * Runs on the main thread, same as `WebCodecsVideoEncoder` -- `AudioEncoder`/
 * `AudioData` are ordinary main-thread-available APIs, no dedicated Worker
 * needed (unlike the WASM path, which needs one to keep the Emscripten glue
 * off the main thread).
 */
export class WebCodecsAudioEncoder {
  channelId = 0;

  private encoder: AudioEncoder | null = null;
  private closed = false;

  constructor(
    private readonly sampleRate: number,
    private readonly numberOfChannels: number,
    private readonly options: WebCodecsAudioEncoderOptions,
    private readonly bitrate: number = DEFAULT_BITRATE
  ) {
    if (typeof AudioEncoder === 'undefined') {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: 0x0315,
        place: 'WebCodecsAudioEncoder.ts:constructor',
        message: 'WebCodecs AudioEncoder API is not supported!'
      });
    }

    void this.configure();
  }

  get isConfigured(): boolean {
    return this.encoder !== null && this.encoder.state === 'configured';
  }

  private async configure(): Promise<void> {
    const config: AudioEncoderConfig = {
      codec: AAC_CODEC_STRING,
      sampleRate: this.sampleRate,
      numberOfChannels: this.numberOfChannels,
      bitrate: this.bitrate
    };

    let supported = false;
    try {
      supported = (await AudioEncoder.isConfigSupported(config)).supported === true;
    } catch {
      supported = false;
    }
    if (this.closed) {
      return;
    }
    if (!supported) {
      this.options.onUnsupported?.();
      return;
    }

    this.encoder = new AudioEncoder({
      output: (chunk, metadata) => this.onEncodedOutput(chunk, metadata),
      error: (error) => {
        this.options.onError?.(error);
      }
    });
    this.encoder.configure(config);
  }

  private onEncodedOutput(chunk: EncodedAudioChunk, metadata?: EncodedAudioChunkMetadata): void {
    const buffer = new Uint8Array(chunk.byteLength);
    chunk.copyTo(buffer);

    const descriptionSource = metadata?.decoderConfig?.description;
    const description = descriptionSource ? new Uint8Array(descriptionSource as ArrayBuffer) : null;

    this.options.onEncodedChunk({
      frameData: buffer,
      timestampUs: chunk.timestamp,
      description
    });
  }

  /** Fire-and-forget, same convention as `WebCodecsVideoEncoder.encode()` --
   *  the real result arrives later via `onEncodedChunk`. No-ops (drops this
   *  one chunk) if the encoder isn't configured yet/anymore, same as that
   *  class's own guard -- the caller is expected to check `isConfigured`
   *  before routing frames here at all (see `VideoTagPlayer.ts`'s
   *  `createAudioSample()`), this is a defensive second guard against a
   *  state change racing between that check and this call. */
  encode(input: WebCodecsAudioEncodeInput): void {
    if (this.closed || this.encoder === null || this.encoder.state !== 'configured') {
      return;
    }

    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate: this.sampleRate,
      numberOfFrames: input.pcm.length,
      numberOfChannels: this.numberOfChannels,
      timestamp: input.timestampUs,
      // `AudioDataInit.data` is typed as plain `BufferSource` (an
      // `ArrayBuffer`-backed view only) -- `Float32Array`'s own TS type is
      // generic over `ArrayBufferLike` (which also admits `SharedArrayBuffer`),
      // so it doesn't structurally satisfy that even though `input.pcm` is
      // always a real, non-shared `Float32Array` in practice (`decode()`
      // always constructs one fresh, see G711AudioDecoder.ts/
      // G726xAudioDecoder.ts).
      data: input.pcm as unknown as BufferSource
    });

    try {
      this.encoder.encode(audioData);
    } catch {
      // The underlying AudioEncoder may have moved to 'closed' between the
      // state check above and this call (its async `error` callback can fire
      // at any time) -- dropping this one chunk is the safer failure mode,
      // matching WebCodecsVideoEncoder.ts's own encode()-time guard.
    } finally {
      audioData.close();
    }
  }

  close(): void {
    this.closed = true;
    if (this.encoder !== null && this.encoder.state !== 'closed') {
      this.encoder.close();
    }
  }
}
