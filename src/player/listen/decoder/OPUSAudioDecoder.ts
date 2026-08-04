import { AudioDecoder as AudioDecoderBase } from './AudioDecoder';
import { RTSPOverWebSocketError } from '../../exceptions';

// RFC 7587 §4.1: Opus-over-RTP always runs at a fixed 48000Hz clock, whatever
// the codec's actual internal sample rate is encoding at.
const OPUS_SAMPLE_RATE = 48000;
// The SDP-level channel count for Opus (the "2" in "opus/48000/2") is
// mandated to always read 2 regardless of the real channel count (RFC 7587
// §7) — the actual value lives in the `stereo`/`sprop-stereo` fmtp
// attributes instead, which this player doesn't currently parse for any
// codec's fmtp beyond AAC's SizeLength/IndexLength/IndexDeltaLength. Cameras'
// microphones are overwhelmingly mono in practice, so this decodes as mono
// until fmtp `stereo=` parsing is added — revisit if a real stereo Opus
// source shows up.
const OPUS_CHANNELS = 1;
// Opus packets don't carry their own duration; used only to keep the
// WebCodecs EncodedAudioChunk timestamps monotonically increasing before the
// first real output tells us the actual per-packet sample count (20ms is
// Opus's most common frame size, e.g. ffmpeg's default).
const DEFAULT_FRAME_SAMPLES = 960;

/**
 * Decodes Opus RTP payloads (see mediaSession/audioSession/OPUSSession.ts)
 * to PCM via the browser's native WebCodecs `AudioDecoder` — unlike
 * AACAudioDecoder/G711AudioDecoder/G726xAudioDecoder, there's no vendored
 * WASM/asm.js decoder for Opus in this repo, and WebCodecs decodes it
 * natively in every currently-supported browser (Chrome/Edge 100+,
 * Firefox 133+, Safari 26+) without one.
 *
 * WebCodecs' AudioDecoder is asynchronous (decoded output arrives via its
 * `output` callback, not as `decode()`'s return value), but
 * `AudioDecoderLike.decode()` — and AudioPlayerGxx.ts's `BufferAudio()` call
 * site — expects a synchronous `Float32Array` back. This bridges the gap
 * with an internal FIFO: `decode()` feeds the new packet into the WebCodecs
 * decoder and returns whatever's already been decoded and queued from
 * *earlier* packets (possibly empty on the first few calls, before the
 * first `output` callback has fired — AudioPlayerGxx.playAudioIn() already
 * handles a zero-length chunk safely by treating it as a reset/skip rather
 * than throwing).
 */
export class OPUSAudioDecoder extends AudioDecoderBase {
  private readonly decoder: AudioDecoder;
  private readonly pending: Float32Array[] = [];
  private nextTimestampUs = 0;
  private lastFrameSamples = DEFAULT_FRAME_SAMPLES;

  constructor() {
    super();

    if (typeof window === 'undefined' || typeof window.AudioDecoder === 'undefined') {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: 0x0311,
        place: 'OPUSAudioDecoder.ts:constructor',
        message: 'WebCodecs AudioDecoder API is not supported!'
      });
    }

    this.decoder = new window.AudioDecoder({
      output: (audioData) => this.onDecodedOutput(audioData),
      error: () => {
        // legacy sibling decoders (G711/G726x/AAC) don't surface decode
        // errors to the caller either — BufferAudio() has no failure path,
        // so a dropped/undecodable packet here just yields no output for
        // this one call, same as an empty queue.
      }
    });
    this.decoder.configure({
      codec: 'opus',
      sampleRate: OPUS_SAMPLE_RATE,
      numberOfChannels: OPUS_CHANNELS
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
    this.nextTimestampUs += (this.lastFrameSamples / OPUS_SAMPLE_RATE) * 1e6;

    return this.pending.shift() ?? new Float32Array(0);
  }

  override close(): void {
    this.pending.length = 0;
    if (this.decoder.state !== 'closed') {
      this.decoder.close();
    }
  }
}
