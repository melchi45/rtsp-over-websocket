import { AudioPlayer } from './AudioPlayer';
import { G711AudioDecoder, type G711Mime } from '../decoder/G711AudioDecoder';
import { G726xAudioDecoder } from '../decoder/G726xAudioDecoder';
import { AACAudioDecoder } from '../decoder/AACAudioDecoder';
import { RTSPOverWebSocketError } from '../../exceptions/RTSPOverWebSocketError';
import { fromHex } from '../../util/hex';

/** Minimal shared shape across G711/G726x/AAC decoders, matching what this player actually calls. */
export interface AudioDecoderLike {
  channelId: number;
  mime?: string;
  decode(buffer: ArrayLike<number>): Float32Array;
  close?(): void;
}

export type AACAudioDecoderFactory = () => AudioDecoderLike;

// Constructing AACAudioDecoder requires the vendored ffmpegAAC.js asm.js
// build's `Module` global to already be loaded (see AACAudioDecoder.ts's
// class doc comment) — wiring that load step is `elements/RTSPOverWebSocket.ts`'s
// concern, not this factory's job.
const defaultAACAudioDecoderFactory: AACAudioDecoderFactory = () => new AACAudioDecoder();

/**
 * Ported from the legacy player’s Listen/Renderer/audioPlayerGxx — decodes and
 * plays G.711/G.726x/AAC audio via the Web Audio API's ScriptProcessor-free
 * AudioBufferSourceNode scheduling path.
 *
 * `log.debug`/`log.info`/`console.*` calls are not reproduced. Like Talk.ts,
 * the `window.AudioContext = window.AudioContext || window.webkitAudioContext
 * || ...` vendor-prefix polyfill is dropped — none of those prefixed globals
 * exist in any currently-supported browser or in TypeScript's DOM types.
 *
 * `aacAudioDecoderFactory` stays injectable (default constructs a real
 * AACAudioDecoder, ported in Layer 10) so tests can substitute a fake
 * without needing the real vendored asm.js `Module` global loaded.
 */
export class AudioPlayerGxx extends AudioPlayer {
  private audioContext: AudioContext | null = null;
  private gainInNode: GainNode | null = null;
  private biquadFilter: BiquadFilterNode | null = null;
  private saveVol = 0;

  private readonly codecInfo = { type: 'G.711', samplingRate: 8000, bitrate: '64000' };
  private nextStartTime = 0;
  private isRunning = false;
  private preTimeStamp = 0;
  private initVideoTimeStamp: number | string = 0;
  private videoDiffTime: number | null = null;

  private bufferingFlag = false;
  private playBuffer: Float32Array = new Float32Array(80000);
  private readLength = 0;
  private sourceNode: AudioBufferSourceNode | null = null;
  private audioDecoder: AudioDecoderLike | null = null;

  constructor(
    private readonly audioContextFactory: () => AudioContext = () => new AudioContext(),
    private readonly aacAudioDecoderFactory: AACAudioDecoderFactory = defaultAACAudioDecoderFactory
  ) {
    super();
  }

  private static isAppleSafari(): boolean {
    return /Apple Computer/.test(navigator.vendor) && /Safari/.test(navigator.userAgent);
  }

  private static appendBufferFloat32(currentBuffer: Float32Array, newBuffer: Float32Array, readLength: number): Float32Array {
    const BUFFER_SIZE = 80000;
    let buffer = currentBuffer;
    if (readLength + newBuffer.length >= buffer.length) {
      const tmp = new Float32Array(buffer.length + BUFFER_SIZE);
      tmp.set(buffer, 0);
      buffer = tmp;
    }
    buffer.set(newBuffer, readLength);
    return buffer;
  }

  private static upsampling8Kto32K(inputBuffer: Float32Array): Float32Array {
    const mu = 0.2;
    const mu2 = (1 - Math.cos(mu * Math.PI)) / 2;
    const buf = new Float32Array(inputBuffer.length * 4);
    for (let i = 0, j = 0; i < inputBuffer.length; i++) {
      j = i * 4;
      const point1 = inputBuffer[i];
      let point2 = i < inputBuffer.length - 1 ? inputBuffer[i + 1] : point1;
      let point3 = i < inputBuffer.length - 2 ? inputBuffer[i + 2] : point1;
      let point4 = i < inputBuffer.length - 3 ? inputBuffer[i + 3] : point1;
      point2 = point1 * (1 - mu2) + point2 * mu2;
      point3 = point2 * (1 - mu2) + point3 * mu2;
      point4 = point3 * (1 - mu2) + point4 * mu2;
      buf[j] = point1;
      buf[j + 1] = point2;
      buf[j + 2] = point3;
      buf[j + 3] = point4;
    }
    return buf;
  }

  private playAudioIn(data: Float32Array, rtpTimestamp: number): void {
    const audioContext = this.audioContext!;
    const timegap = rtpTimestamp - this.preTimeStamp;

    if (timegap > 200 || timegap < 0) {
      this.nextStartTime = 0;
      this.readLength = 0;
      this.bufferingFlag = true;
      if (this.sourceNode !== null) {
        this.sourceNode.stop();
      }
    }

    if (this.nextStartTime - audioContext.currentTime < 0) {
      this.nextStartTime = 0;
    }

    this.preTimeStamp = rtpTimestamp;

    this.playBuffer = AudioPlayerGxx.appendBufferFloat32(this.playBuffer, data, this.readLength);
    this.readLength += data.length;

    if (!this.bufferingFlag) {
      let startPos = 0;
      if (this.readLength / data.length > 1) {
        if (this.videoDiffTime !== null) {
          startPos = this.videoDiffTime * 8000;
        }
        if (startPos >= this.readLength || this.videoDiffTime === null) {
          this.readLength = 0;
          return;
        }
      }

      if (AudioPlayerGxx.isAppleSafari()) {
        this.playBuffer = AudioPlayerGxx.upsampling8Kto32K(this.playBuffer.subarray(startPos, this.readLength));
      } else {
        this.playBuffer = this.playBuffer.subarray(startPos, this.readLength);
      }
      const audioBuffer = audioContext.createBuffer(1, this.playBuffer.length, this.codecInfo.samplingRate);
      audioBuffer.getChannelData(0).set(this.playBuffer);

      this.readLength = 0;
      this.sourceNode = audioContext.createBufferSource();
      this.sourceNode.buffer = audioBuffer;
      this.sourceNode.connect(this.biquadFilter!);

      if (!this.nextStartTime) {
        this.nextStartTime = audioContext.currentTime + 0.1;
      }
      this.sourceNode.start(this.nextStartTime);
      this.nextStartTime += audioBuffer.duration;
    }
  }

  override audioInit(codecType: string, codecMime: string | undefined, bitrate: number | undefined, volume: number): boolean {
    this.nextStartTime = 0;

    this.audioDecoder = null;
    this.codecInfo.samplingRate = 8000;
    if (codecType === 'G711') {
      const decoder = new G711AudioDecoder();
      decoder.mime = codecMime as G711Mime;
      this.audioDecoder = decoder;
    } else if (codecType === 'AAC') {
      this.audioDecoder = this.aacAudioDecoderFactory();
      this.codecInfo.samplingRate = 16000;
    } else {
      this.audioDecoder = new G726xAudioDecoder(Number(bitrate) as 16 | 24 | 32 | 40) as unknown as AudioDecoderLike;
    }

    // NOTE: write-only for the G.726x path — G726xAudioDecoder has no
    // `channelId` field (confirmed: audioDecoderG726x never references
    // one either) — preserved as legacy's single unconditional assignment
    // covering all three decoder types, rather than special-casing it away.
    this.audioDecoder.channelId = this.channelId;

    if (AudioPlayerGxx.isAppleSafari()) {
      this.codecInfo.samplingRate = this.codecInfo.samplingRate * 4;
    }

    this.codecInfo.type = codecType;

    if (typeof this.audioContext !== 'undefined' && this.audioContext !== null) {
      return false;
    }

    try {
      this.audioContext = this.audioContextFactory();
      this.audioContext.onstatechange = () => {
        if (this.audioContext !== null && this.audioContext !== undefined) {
          if (this.audioContext.state === 'running') {
            this.isRunning = true;
          } else if (this.audioContext.state === 'closed') {
            this.isRunning = false;
            this.audioContext = null;
          }
        }
      };

      if (this.audioContext !== undefined && this.audioContext !== null) {
        this.gainInNode = this.audioContext.createGain();
        this.biquadFilter = this.audioContext.createBiquadFilter();
        this.biquadFilter.connect(this.gainInNode);
        this.biquadFilter.type = 'lowpass';
        this.biquadFilter.frequency.value = 1000;
        this.biquadFilter.gain.value = 25;
        this.gainInNode.connect(this.audioContext.destination);
      }

      this.ControlVolume(volume);
      return true;
    } catch (error) {
      const err = error as { code?: unknown; name?: string; message?: string };
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: fromHex('0x030F'),
        place: 'AudioPlayerGxx.ts:201',
        message: `Audio error  [${err.code}], name [${err.name}, message [${err.message}]`
      });
    }
  }

  override isInit(): boolean {
    return this.audioDecoder !== null === true;
  }

  override Play(): void {
    this.ControlVolume(this.saveVol);
  }

  override Stop(): void {
    this.saveVol = 0;
    if (this.gainInNode !== undefined && this.gainInNode !== null) {
      this.gainInNode.gain.value = 0;
    }
    this.nextStartTime = 0;
  }

  override BufferAudio(data: ArrayLike<number>, rtpTimestamp: number): void {
    if (this.isRunning) {
      const decodedBuffer = this.audioDecoder!.decode(data);
      this.playAudioIn(decodedBuffer, rtpTimestamp);
    }
  }

  override ControlVolume(vol: number): void {
    if (this.gainInNode !== undefined && this.gainInNode !== null) {
      this.saveVol = vol;
      const tVol = vol / 5;
      if (tVol <= 0) {
        this.gainInNode.gain.value = 0;
        this.nextStartTime = 0;
      } else if (tVol >= 1) {
        this.gainInNode.gain.value = 1;
      } else {
        this.gainInNode.gain.value = tVol;
      }
    }
  }

  GetVolume(): number {
    return this.saveVol;
  }

  terminate(): void {
    if (typeof this.audioContext !== 'undefined' && this.audioContext !== null) {
      if (this.audioContext.state !== 'closed') {
        this.nextStartTime = 0;
        this.isRunning = false;
        void this.audioContext.close();
      }
    }

    if (this.codecInfo.type === 'AAC') {
      this.audioDecoder!.close?.();
    }
  }

  setBufferingFlag(videoTime: number | string, videoStatus: string): void {
    if (videoStatus === 'init') {
      this.initVideoTimeStamp = videoTime;
    } else if (this.bufferingFlag) {
      if (videoTime === 0 || videoTime === 'undefined' || videoTime === null) {
        this.videoDiffTime = null;
      } else {
        this.videoDiffTime = Number(videoTime) - Number(this.initVideoTimeStamp);
        this.initVideoTimeStamp = 0;
      }
      this.bufferingFlag = false;
    }
  }

  getBufferingFlag(): boolean {
    return this.bufferingFlag;
  }

  setInitVideoTimeStamp(time: number | string): void {
    this.initVideoTimeStamp = time;
  }

  getInitVideoTimeStamp(): number | string {
    return this.initVideoTimeStamp;
  }
}
