import { AudioDecoder as AudioDecoderBase } from './AudioDecoder';
import { RTSPOverWebSocketError } from '../../exceptions';

// AAC-LC always codes 1024 PCM samples per access unit (ISO/IEC 14496-3) --
// the same constant AACSession.ts's own ADTS generation targets. Used only to
// keep the WebCodecs EncodedAudioChunk timestamps monotonically increasing
// before the first real output reports the actual per-frame sample count.
const AAC_FRAME_SAMPLES = 1024;

/**
 * Decodes AAC access units to PCM via the browser's native WebCodecs
 * `AudioDecoder` — the same approach `OPUSAudioDecoder.ts` already takes for
 * Opus, and the alternative to `AACAudioDecoder.ts`'s vendored ffmpeg asm.js
 * build (`vendor/ffmpegAAC.decoder.js`, which reserves a fixed 160MiB
 * `TOTAL_MEMORY` heap on load and decodes synchronously on the main thread).
 * `AudioPlayerGxx.audioInit()` chooses between the two per the
 * `audioencodermode` attribute — see its own AAC branch.
 *
 * **No `description` is supplied to `configure()` on purpose.** Chrome
 * interprets an `AudioDecoderConfig` without one as declaring ADTS-framed
 * input, which is exactly what arrives here: `AACSession.genADTSAAC()` builds
 * the 7-byte ADTS header (from the SDP fmtp `config=`'s AudioSpecificConfig —
 * real `samplingFrequencyIndex`/`channelConfiguration`, not assumed values)
 * and `MediaRouter.handleAudioData()` prepends it to the raw access unit
 * before calling `BufferAudio()`. So the bytes reaching `decode()` are already
 * in the one format WebCodecs accepts without separate out-of-band config —
 * no AudioSpecificConfig plumbing from the SDP down to this layer is needed.
 *
 * Same async-to-sync bridge as `OPUSAudioDecoder`: WebCodecs delivers decoded
 * output via its `output` callback, but `AudioDecoderLike.decode()` (and
 * `AudioPlayerGxx.BufferAudio()`'s call site) expects a synchronous
 * `Float32Array` back, so `decode()` feeds the new packet in and returns
 * whatever earlier packets have already produced — empty on the first few
 * calls, which `AudioPlayerGxx.playAudioIn()` already handles safely.
 */
export class AACWebCodecsAudioDecoder extends AudioDecoderBase {
  private readonly decoder: AudioDecoder;
  private readonly pending: Float32Array[] = [];
  private readonly configuredSampleRate: number;
  private nextTimestampUs = 0;
  private lastFrameSamples = AAC_FRAME_SAMPLES;

  /** `sampleRate`/`numberOfChannels` describe the *playback* pipeline
   *  `AudioPlayerGxx` is set up for (`codecInfo.samplingRate`, and its
   *  mono-only `playAudioIn()` buffer), so the two stay consistent; the real
   *  per-frame rate still comes from each frame's own ADTS header, and the
   *  decoder reports it back on every `AudioData`. */
  constructor(sampleRate: number, numberOfChannels: number = 1) {
    super();
    this.configuredSampleRate = sampleRate;

    if (typeof window === 'undefined' || typeof window.AudioDecoder === 'undefined') {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: 0x0311,
        place: 'AACWebCodecsAudioDecoder.ts:constructor',
        message: 'WebCodecs AudioDecoder API is not supported!'
      });
    }

    this.decoder = new window.AudioDecoder({
      output: (audioData) => this.onDecodedOutput(audioData),
      error: () => {
        // Matches OPUSAudioDecoder's own rationale: the sibling decoders
        // (G711/G726x/AAC-asm.js) have no failure path back to BufferAudio()
        // either, so an undecodable packet just yields no output for that one
        // call, same as an empty queue.
      }
    });
    // Throws synchronously (NotSupportedError) if the browser has WebCodecs
    // but no AAC decode support -- AudioPlayerGxx.audioInit() catches that and
    // falls back to the asm.js decoder, which is why this is left to propagate.
    this.decoder.configure({
      codec: 'mp4a.40.2',
      sampleRate,
      numberOfChannels
    });
  }

  private onDecodedOutput(audioData: AudioData): void {
    try {
      this.lastFrameSamples = audioData.numberOfFrames;
      const pcm = new Float32Array(audioData.numberOfFrames);
      audioData.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' });
      this.pending.push(pcm);
    } finally {
      audioData.close();
    }
  }

  decode(buffer: ArrayLike<number>): Float32Array {
    const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this.decoder.decode(
      new window.EncodedAudioChunk({
        type: 'key',
        timestamp: this.nextTimestampUs,
        data
      })
    );
    // Only used to keep the synthetic chunk timestamps monotonic (WebCodecs
    // requires increasing timestamps; ADTS carries no presentation time of its
    // own), so the configured rate is close enough -- the real output timing
    // comes from `AudioPlayerGxx.playAudioIn()`'s own RTP-timestamp scheduling.
    this.nextTimestampUs += (this.lastFrameSamples / this.configuredSampleRate) * 1e6;

    return this.pending.shift() ?? new Float32Array(0);
  }

  override close(): void {
    this.pending.length = 0;
    if (this.decoder.state !== 'closed') {
      this.decoder.close();
    }
  }
}
