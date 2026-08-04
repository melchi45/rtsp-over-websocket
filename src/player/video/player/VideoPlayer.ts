import { CircularTypedArrayQueue } from '../../util/CircularTypedArrayQueue';
import { Median } from '../../util/Median';
import { fromHex } from '../../util/hex';
import type { VideoStreamData, VideoInfo, AudioStreamData, AudioInfo, WaitingEvent } from '../../mediaSession';

export interface NetworkStateErrorEvent {
  channelId: number;
  errorCode: number;
  state: string;
  place: string;
  description: string;
}

export type VideoPlayerErrorCallback = (event: Record<string, unknown>) => void;

/**
 * Ported from the legacy player’s Video/Player/videoPlayer.
 *
 * Legacy defines `type`/`channelId`/`playmode`/`instantplayback`/`rfps`/
 * `boxsize`/`deviceType`/`currentFrameCount`/`previousFrameCount`/`codec`/
 * `framedrop`/`audioshift`/`speed` via `Object.defineProperty(Constructor.prototype, ...)`
 * — real, working accessors (unlike canvasRenderer.js's `channelId`/
 * `userPaused`, which were defined on a *discarded* object — see
 * CanvasRenderer.ts's comment for that unrelated bug). Ported here as
 * genuine TS getters/setters so subclasses (CanvasTagPlayer, VideoTagPlayer)
 * inherit the exact same side-effecting behavior (`rfps`'s network-state
 * analysis, `audioshift`/`speed`'s onChange hooks) without redeclaring it.
 *
 * `onNetworkState`/`onChangeAudioShift`/`onChangeSpeed`/`capture`/
 * `toggleControls` have **no** base implementation in legacy at all (not
 * even a log-only default, unlike `init`/`onVideoData`/`play`/etc. below) —
 * `VideoPlayer` is never directly instantiated (grep-confirmed; only
 * `CanvasTagPlayer`/`VideoTagPlayer` do `inheritObject(new VideoPlayer(), ...)`
 * and both override every one of these), so they're modeled as `abstract`
 * here — a compile-time version of legacy's implicit "must override or
 * crash at runtime" contract. `bufferingVideoData`/`sendToBufferManager`/
 * `digitalZoom`/`controlStepPlay` were *not* included here despite looking
 * similarly universal at first: they're actually canvasTagPlayer.js-only
 * (its step-play/digital-zoom feature) — videoTagPlayer.js's own
 * Constructor.prototype genuinely never defines them, so calling e.g.
 * `.digitalZoom(...)` on a real VideoTagPlayer instance throws
 * `TypeError: ... is not a function` in legacy too. Declaring them abstract
 * here would have wrongly forced VideoTagPlayer to implement something it
 * never did.
 */
export abstract class VideoPlayer {
  boxsize = 4;
  currentFrameCount = 0;
  previousFrameCount = 0;
  framedrop = false;
  // Plain field, not an accessor: legacy's `type` getter/setter has no side
  // effects beyond storing the value (unlike rfps/audioshift/speed below),
  // so a plain field is behaviorally identical and simpler.
  type = 'unknown';

  frameRate = 30;
  minRemainTime = 30;
  minTimerInterval = 1;
  maxdelay = 0.3;
  currentdelay = this.maxdelay;

  // No default: legacy never assigns this until setErrorCallback() is
  // called, so `this.errorCallback(...)` (e.g. from the rfps setter below)
  // throws `TypeError: this.errorCallback is not a function` if a caller
  // never registered one first — preserved via the cast at each call site.
  errorCallback: VideoPlayerErrorCallback | undefined;
  eventStatisticsCallback?: (data: Record<string, unknown>) => void;
  eventCaptureCallback?: (data: unknown) => void;
  eventInstantPlaybackCallback?: (data: unknown) => void;

  private channelIdValue = 0;
  private playmodeValue: string | undefined;
  private instantplaybackValue: boolean | undefined;
  private rfpsValue: number | undefined;
  private deviceTypeValue = 'camera';
  private codecValue: string | undefined;
  private audioshiftValue = 0;
  private speedValue = 1;
  private readonly fpsQueue = new CircularTypedArrayQueue<number>(5, true);

  get channelId(): number {
    return this.channelIdValue;
  }

  set channelId(v: number) {
    this.channelIdValue = v;
  }

  get playmode(): string | undefined {
    return this.playmodeValue;
  }

  set playmode(v: string | undefined) {
    this.playmodeValue = v;
  }

  get instantplayback(): boolean | undefined {
    return this.instantplaybackValue;
  }

  set instantplayback(v: boolean | undefined) {
    this.instantplaybackValue = v;
  }

  get deviceType(): string {
    return this.deviceTypeValue;
  }

  set deviceType(v: string) {
    this.deviceTypeValue = v;
  }

  get codec(): string | undefined {
    return this.codecValue;
  }

  set codec(v: string | undefined) {
    this.codecValue = v;
  }

  get rfps(): number | undefined {
    return this.rfpsValue;
  }

  set rfps(v: number | undefined) {
    this.rfpsValue = v;
    this.fpsQueue.enQueue(v as number);

    if (this.fpsQueue.isFull()) {
      const samples = this.fpsQueue.toArray() as number[];
      const variance = Median.variance(samples);
      let state: string;
      if (variance > 5.0) {
        state = 'poor';
      } else if (variance > 3.0 && variance <= 5.0) {
        state = 'fair';
      } else if (variance > 1.0 && variance <= 3.0) {
        state = 'good';
      } else if (variance > 0.0 && variance <= 1.0) {
        state = 'very_good';
      } else if (variance === 0) {
        state = 'excellent';
      } else {
        state = 'poor';
      }

      (this.errorCallback as VideoPlayerErrorCallback)({
        channelId: this.channelId,
        errorCode: fromHex('0x1005'),
        state,
        place: 'VideoPlayer.ts:set rfps',
        description: `network state (${variance})`
      });

      this.onNetworkState(Median.variance(samples), Median.mean(samples));
    }
  }

  get audioshift(): number {
    return this.audioshiftValue;
  }

  set audioshift(v: number) {
    this.onChangeAudioShift(v);
    this.audioshiftValue = v;
  }

  get speed(): number {
    return this.speedValue;
  }

  set speed(v: number) {
    this.onChangeSpeed(v);
    this.speedValue = v;
  }

  init(_element: unknown): void {}

  onVideoData(_playMode: string, _streamData: VideoStreamData | AudioStreamData, _videoInfo: VideoInfo | AudioInfo, _codecInfo?: string): void {}

  onWaitingPackets(_event: WaitingEvent): void {}

  play(): void {}

  pause(): void {}

  resume(): void {}

  stop(): void {}

  close(): void {}

  clearBuffer(): void {}

  addEventListener(event: string, callback: (data: unknown) => void): void {
    switch (event) {
      case 'statistics':
        this.eventStatisticsCallback = callback as (data: Record<string, unknown>) => void;
        break;
      case 'capture':
        this.eventCaptureCallback = callback;
        break;
      case 'instantplayback':
        this.eventInstantPlaybackCallback = callback;
        break;
    }
  }

  setFrameRate(fps: number): void {
    this.frameRate = fps;
  }

  getFrameRate(): number {
    return this.frameRate;
  }

  setMaxInstantPlayback(thresholdInstantPlaybackTime: number): void {
    this.minRemainTime = thresholdInstantPlaybackTime;
  }

  getMaxInstantPlayback(): number {
    return this.minRemainTime;
  }

  setBufferClearInterval(interval: number): void {
    this.minTimerInterval = interval;
  }

  getBufferClearInterval(): number {
    return this.minTimerInterval;
  }

  updateMiniMapInfo(_elem: unknown): void {}

  forward(): boolean | void {}

  backward(): boolean | void {}

  setDefaultDelay(v: number): void {
    this.maxdelay = v;
  }

  getDefaultDelay(): number {
    return this.maxdelay;
  }

  setCurrentDelay(v: number): void {
    this.currentdelay = v;
  }

  getCurrentDelay(): number {
    return this.currentdelay;
  }

  instantplaybackCmd(data: { cmd: string }): void {
    switch (data.cmd) {
      case 'play':
        this.play();
        break;
    }
  }

  setErrorCallback(func: VideoPlayerErrorCallback): void {
    this.errorCallback = func;
  }

  abstract onNetworkState(variance: number, mean: number): void;
  abstract onChangeAudioShift(v: number): void;
  abstract onChangeSpeed(v: number): void;
  abstract capture(fileName: string): void;
  abstract toggleControls(flags?: unknown): void;
}
