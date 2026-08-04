import { RTSPOverWebSocketError } from '../exceptions/RTSPOverWebSocketError';
import { fromHex } from '../util/hex';

/**
 * Ported from the legacy player’s Talk/Talk.js — captures microphone input via the
 * Web Audio API and streams PCM chunks to a caller-supplied callback for
 * outbound audio-talk transmission.
 *
 * `console.*` calls are not reproduced (observability only). `cleanBuffer()`
 * is dropped: confirmed dead code (defined, never called anywhere in the
 * legacy file), and it references `chunkCounter`/`bufferedArray`, two
 * variables never declared anywhere in the closure — under `"use strict"`,
 * calling it would throw a ReferenceError, but since nothing ever calls it,
 * that bug has never fired.
 *
 * The `navigator.mediaDevices.getUserMedia` polyfill block (defining
 * `mediaDevices`/`getUserMedia` via vendor-prefixed `navigator.webkitGetUserMedia`
 * /`mozGetUserMedia`/`msGetUserMedia` when absent) is dropped: those
 * vendor-prefixed APIs were removed from every currently-supported browser
 * years ago and no longer exist in TypeScript's DOM lib types either — this
 * migration targets modern evergreen browsers (Design doc §4), where
 * `navigator.mediaDevices.getUserMedia` is always natively present. The
 * "API not supported at all" rejection path is preserved.
 */
export class Talk {
  channelId = 0;

  private audioContext: AudioContext | null = null;
  private gainOutNode: GainNode | null = null;
  private readonly bufferSize = 4096;
  private scriptNode: ScriptProcessorNode | null = null;
  private localSampleRate: number | null = null;
  private isStreaming = false;
  private currentLocalStream: MediaStream | null = null;
  private streamNode: MediaStreamAudioSourceNode | null = null;
  private sendAudioBufferCallback: ((data: Float32Array) => void) | null = null;

  // NOTE: `mandatory.googAutoGainControl` is a legacy/pre-spec Chrome-only
  // constraint property; browsers silently ignore unrecognized constraint
  // keys, so this is preserved verbatim for fidelity rather than dropped.
  private readonly constraints = {
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    video: false,
    mandatory: { googAutoGainControl: false }
  } as unknown as MediaStreamConstraints;

  constructor(private readonly audioContextFactory: () => AudioContext = () => new AudioContext()) {}

  init(): boolean {
    if (typeof this.audioContext === 'undefined' || this.audioContext === null) {
      try {
        this.audioContext = this.audioContextFactory();
        this.audioContext.onstatechange = () => {};
      } catch {
        return false;
      }
    }
    return true;
  }

  initAudioOut(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const audioContext = this.audioContext!;
      if (this.gainOutNode === null || this.scriptNode === null) {
        this.gainOutNode = audioContext.createGain();
        this.scriptNode = audioContext.createScriptProcessor(this.bufferSize, 1, 1);
        this.scriptNode.onaudioprocess = (e) => {
          if (this.currentLocalStream !== null) {
            const recordChunk = e.inputBuffer.getChannelData(0);
            if (this.sendAudioBufferCallback !== null && this.isStreaming === true) {
              this.sendAudioBufferCallback(recordChunk);
            }
          }
        };
        this.gainOutNode.connect(this.scriptNode);
        this.scriptNode.connect(audioContext.destination);
        this.localSampleRate = audioContext.sampleRate;
        this.gainOutNode.gain.value = 1;
      }

      // NOTE: legacy's "getUserMedia truly unavailable" branch (a plain
      // `reject(new Error('Cannot open local media stream!...'))`, distinct
      // from the RTSPOverWebSocketError below) is *also* unreachable in practice there: it
      // unconditionally installs a `navigator.mediaDevices.getUserMedia`
      // polyfill first whenever one is missing, so by the time that branch's
      // guard runs, `getUserMedia` is always truthy — real absence (no
      // native implementation and no vendor-prefixed fallback, which is the
      // case in every currently-supported browser) surfaces through the
      // polyfill's own rejection instead, converging on the same `.catch()`
      // → RTSPOverWebSocketError path below. TypeScript's DOM types guarantee
      // `navigator.mediaDevices.getUserMedia` statically too, so this port
      // calls it directly rather than reproducing a branch neither side ever
      // actually takes.
      navigator.mediaDevices
        .getUserMedia(this.constraints)
        .then((stream) => {
          this.currentLocalStream = stream;
          this.streamNode = audioContext.createMediaStreamSource(stream);
          this.streamNode.connect(this.gainOutNode!);
          this.isStreaming = true;
          resolve(this.localSampleRate!);
        })
        .catch(() => {
          reject(
            new RTSPOverWebSocketError({
              channelId: this.channelId,
              errorCode: fromHex('0x0211'),
              place: 'Talk.js:initAudioOut',
              message: 'Talk service unavailable, Microphone device not found.'
            })
          );
        });
    });
  }

  controlVolumeOut(volume: number): void {
    const tVol = (volume / 20) * 2;
    if (tVol <= 0) {
      this.gainOutNode!.gain.value = 0;
    } else if (tVol >= 10) {
      this.gainOutNode!.gain.value = 10;
    } else {
      this.gainOutNode!.gain.value = tVol;
    }
  }

  /** After stopAudioOut, initAudioOut needs to be called to restart. */
  stopAudioOut(): void {
    if (this.currentLocalStream !== null && this.isStreaming) {
      try {
        const audioTracks = this.currentLocalStream.getAudioTracks();
        for (let i = 0; i < audioTracks.length; i++) {
          audioTracks[i].stop();
        }
        this.isStreaming = false;
        this.currentLocalStream = null;
      } catch {
        // legacy: console.log(e) only, no further effect.
      }
    }
  }

  terminate(): void {
    this.stopAudioOut();
    this.audioContext!.close();
    this.gainOutNode = null;
    this.scriptNode = null;
  }

  setSendAudioTalkBufferCallback(callbackFn: (data: Float32Array) => void): void {
    this.sendAudioBufferCallback = callbackFn;
  }
}
