import { AudioPlayer } from './AudioPlayer';
import { RTSPOverWebSocketError } from '../../exceptions/RTSPOverWebSocketError';
import { fromHex } from '../../util/hex';

/**
 * Ported from the legacy player’s Listen/Renderer/audioPlayerAAC.js — plays AAC
 * audio via a hidden `<audio>` element backed by a MediaSource Extensions
 * `SourceBuffer`.
 *
 * `console.*` calls are not reproduced. The `window.MediaSource =
 * window.MediaSource || window.WebKitMediaSource` vendor-prefix fallback is
 * dropped (same judgment as Talk.ts/AudioPlayerGxx.ts — `WebKitMediaSource`
 * doesn't exist in any currently-supported browser or in TypeScript's DOM
 * types); `window.MediaSource` is referenced directly.
 */
export class AudioPlayerAAC extends AudioPlayer {
  private mimeCodec = '';
  private mediaSource: MediaSource | null = null;
  private audio: HTMLAudioElement | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private saveVol = 0;
  private segmentBuffer = new Uint8Array();

  private preTimeStamp = 0;
  private initVideoTimeStamp: number | string = 0;
  private videoDiffTime: number | null = null;

  private bufferingFlag = false;
  private startPosArray: number[] | null = null;
  private startPos = 0;

  private static isAppleSafari(): boolean {
    return /Apple Computer/.test(navigator.vendor) && /Safari/.test(navigator.userAgent);
  }

  private static appendBuffer(buffer1: Uint8Array<ArrayBuffer>, buffer2: ArrayLike<number>): Uint8Array<ArrayBuffer> {
    const tmp = new Uint8Array(buffer1.byteLength + buffer2.length);
    tmp.set(buffer1, 0);
    tmp.set(new Uint8Array(buffer2 as ArrayLike<number> as number[]), buffer1.byteLength);
    return tmp;
  }

  private createAudio(): void {
    this.mimeCodec = AudioPlayerAAC.isAppleSafari() ? 'audio/x-aac' : 'audio/aac';

    this.audio = document.createElement('audio');
    document.body.appendChild(this.audio);
    this.audio.addEventListener('error', this.audioErrorCallback);
  }

  private createMediaSource(): boolean {
    let availablePlay = false;
    if (!window.MediaSource) {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: fromHex('0x030D'),
        place: 'mediaRouter.js:440',
        message: 'MediaSource API is not supported!'
      });
    } else if (window.MediaSource.isTypeSupported(this.mimeCodec)) {
      this.mediaSource = new MediaSource();
      this.mediaSource.addEventListener('sourceopen', this.sourceOpenedCallback);
      this.mediaSource.addEventListener('sourceclose', this.sourceCloseCallback);
      this.mediaSource.addEventListener('sourceended', this.sourceEndedCallback);
      this.mediaSource.addEventListener('error', this.sourceErrorCallback);
      this.mediaSource.addEventListener('abort', this.sourceAbortCallback);
      availablePlay = true;
    }
    return availablePlay;
  }

  private audioErrorCallback = (): void => {
    // legacy: console.error(...) branching by e.target.error.code, no other effect.
  };

  // NOTE: `sourceOpened`/`isStopped` are write-only in legacy too (confirmed
  // via grep — set but never read anywhere in audioPlayerAAC.js), dropped
  // here as dead state rather than carried as inert fields.
  private sourceOpenedCallback = (): void => {
    if (this.sourceBuffer === null) {
      try {
        this.sourceBuffer = this.mediaSource!.addSourceBuffer(this.mimeCodec);
        this.sourceBuffer.addEventListener('updateend', this.sourceUpdatedCallback);
      } catch {
        // legacy: console.error(...) only, no further effect.
      }
    }
  };

  private sourceUpdatedCallback = (): void => {
    if (this.audio!.paused) {
      void this.audio!.play();
    }
  };

  private sourceCloseCallback = (): void => {};

  private sourceEndedCallback = (): void => {};
  private sourceErrorCallback = (): void => {};
  private sourceAbortCallback = (): void => {};

  override audioInit(_codecType: string, _codecMime: string | undefined, _bitrate: number | undefined, volume: number): boolean {
    this.createAudio();
    const availablePlay = this.createMediaSource();
    if (availablePlay && this.audio !== null) {
      this.audio.src = window.URL.createObjectURL(this.mediaSource!);
      this.ControlVolume(volume);
      this.audio.pause();
    }
    return availablePlay;
  }

  override isInit(): boolean {
    return this.sourceBuffer !== null === true;
  }

  override Play(): void {
    this.ControlVolume(this.saveVol);
  }

  override Stop(): void {
    this.audio!.volume = 0;
    this.saveVol = 0;
  }

  override BufferAudio(data: ArrayLike<number>, rtpTimestamp: number): void {
    const timegap = rtpTimestamp - this.preTimeStamp;

    if (timegap > 200 || timegap < 0) {
      this.segmentBuffer = new Uint8Array();
      this.startPosArray = [];
      this.bufferingFlag = true;
    }

    if (this.bufferingFlag) {
      this.startPosArray!.push(this.startPos);
      this.startPos += data.length;
    }

    this.preTimeStamp = rtpTimestamp;
    this.segmentBuffer = AudioPlayerAAC.appendBuffer(this.segmentBuffer, data);

    if (this.sourceBuffer !== null && !this.bufferingFlag) {
      if (!this.sourceBuffer.updating) {
        try {
          if (this.startPosArray !== null) {
            if (this.videoDiffTime !== null) {
              if (parseInt(String(this.startPosArray.length / 16)) - parseInt(String(this.videoDiffTime)) >= 2) {
                this.videoDiffTime += 1;
              }
              this.startPos = parseInt(String(this.videoDiffTime * 16), 10);
              if (this.startPos < this.startPosArray.length) {
                this.sourceBuffer.appendBuffer(this.segmentBuffer.subarray(this.startPosArray[this.startPos], this.segmentBuffer.length));
                if (this.sourceBuffer.buffered.length > 0) {
                  this.audio!.currentTime = this.sourceBuffer.buffered.end(0);
                }
              } else if (this.sourceBuffer.buffered.length > 0) {
                this.audio!.currentTime = this.sourceBuffer.buffered.end(0) - 0.3;
              }
            }
          } else {
            this.sourceBuffer.appendBuffer(this.segmentBuffer);
          }

          this.segmentBuffer = new Uint8Array();
          this.startPosArray = null;
          this.startPos = 0;
        } catch {
          // legacy: console.error(...) only, no further effect.
        }
      }
    }
  }

  override ControlVolume(vol: number): void {
    this.saveVol = vol;
    if (this.audio !== null) {
      const tVol = vol / 5;
      if (tVol <= 0) {
        this.audio.volume = 0;
      } else if (tVol >= 1) {
        this.audio.volume = 1;
      } else {
        this.audio.volume = tVol;
      }
    }
  }

  GetVolume(): number {
    return this.saveVol;
  }

  terminate(): void {
    // legacy: `audio = null;` is commented out — a genuine no-op, preserved.
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
