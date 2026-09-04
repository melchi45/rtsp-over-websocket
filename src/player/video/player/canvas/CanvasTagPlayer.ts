import { VideoPlayer, type VideoPlayerErrorCallback } from '../VideoPlayer';
import { CanvasRenderer } from './CanvasRenderer';
import { StepBufferList, type StepBufferNode } from './StepBufferList';
import { PlaybackBufferManager, type PopFrameInfo } from '../../../mediaSession/videoSession/PlaybackBufferManager';
import type { BufferControlMessage } from '../../../mediaSession/videoSession/BufferManagerStates';
import type { VideoStreamData, VideoInfo, WaitingEvent } from '../../../mediaSession';
import { RTSPOverWebSocketError } from '../../../exceptions/RTSPOverWebSocketError';
import { fromHex } from '../../../util/hex';
import type { DebugConfig } from '../../../util/debugLog';

export type DecoderWorkerFactory = () => Worker;

interface DecodedMessageData {
  width: number;
  height: number;
  frame: Uint8Array;
  receiveClock?: number | null;
  time: { type?: string; channelId?: number; timestamp?: number; timestamp_usec?: number; timezone?: number } | null;
}

type DecoderWorkerMessage =
  | { type: 'decoded'; data: DecodedMessageData }
  | { type: 'notReady'; data?: unknown }
  | { type: 'lowPerformance'; data: { decoderId?: unknown; performance?: unknown } }
  | { type: 'terminated'; data?: unknown }
  | { type: string; data?: unknown };

interface CanvasResizeInfo {
  channelId: number | undefined;
  elementId: unknown;
  videoElementId: string;
  tagmode: 'canvas';
  width: number;
  height: number;
}

const FRAME_SIZE = {
  UHD: 3840 * 2160,
  FHD: 1920 * 1080,
  HD: 1280 * 720
};

let decoderCount = 0;

/**
 * Ported from the legacy player’s Video/Player/Canvas/canvasTagPlayer.
 *
 * Legacy stores all state in closures over a single `_self` (the one
 * instance `CanvasTagPlayer()`'s factory ever produces) rather than on
 * `this`, and calls some methods "detached" (e.g.
 * `Constructor.prototype.popNextFrame(true)` from decoderWorkerMessage) —
 * but since every method here reads state through `_self`/module closures
 * rather than `this`, that detachment has no observable effect (confirmed
 * by reading every call site). Ordinary correctly-bound instance methods
 * are used here instead; no special `this`-preserving trick is needed.
 *
 * `document.decoderCount` (a page-global counter in legacy, reset once at
 * module load) is ported as a module-level counter for the same reason —
 * nothing outside this file reads it (grep-confirmed).
 */
export class CanvasTagPlayer extends VideoPlayer {
  private renderer: CanvasRenderer | null = null;
  private canvasElement: HTMLCanvasElement | null = null;
  private rendererCheck = false;

  private videoSizeCallback: ((info: CanvasResizeInfo) => void) | null = null;
  private timeStampCallback: ((timeStamp: unknown) => void) | null = null;

  private decoderWorker: Worker | null = null;
  private frameCount = 0;

  private stepVideoList: StepBufferList | null = null;
  private isStepPlaying = false;

  private bufferManager: PlaybackBufferManager | null = null;
  private mediaTimer: ReturnType<typeof setInterval> | null = null;

  private checkedPlayer = false;

  private readonly onHandleContextLost = (event?: Event): void => {
    if (typeof event !== 'undefined') {
      event.preventDefault();
    }
    (this.errorCallback as VideoPlayerErrorCallback)({
      channelId: this.channelId,
      errorCode: fromHex('0x0902'),
      place: 'CanvasTagPlayer.ts:178',
      description: 'CanvasTagPlayer: WebGL Context Lost detect'
    });
  };

  private readonly onMediaTimer = (): void => {
    if (typeof this.eventStatisticsCallback !== 'undefined' && this.eventStatisticsCallback !== null) {
      const canvasElement = this.canvasElement as HTMLCanvasElement;
      const fps = this.currentFrameCount - this.previousFrameCount;
      const data = {
        type: 'fps',
        channelId: this.channelId,
        width: canvasElement.width,
        height: canvasElement.height,
        fps,
        // video width * video height * chroma sub sampling * fps * 3 color channels
        // YUV420 (Y=4, U=2, V=0) => 12 bit/pixel
        bps:
          this.codec !== 'MJPEG'
            ? (((canvasElement.width * canvasElement.height * (8 + 4 + 0) * fps * 3) / (1 << 30)) as number).toFixed(2)
            : undefined
      };
      this.eventStatisticsCallback(data);
    }

    this.previousFrameCount = this.currentFrameCount;
  };

  constructor(
    private readonly decoderWorkerFactory: DecoderWorkerFactory = () =>
      new Worker(new URL('../../../worker/videoDecoder/decoderWorker.ts', import.meta.url))
  ) {
    super();
  }

  /** Live-refresh (added 2026-09-04, requested directly by the user): `init()` wires
   *  `debugConfig` into `renderer`/`stepVideoList` once, at construction -- overridden here so a
   *  later `setDebugConfig()` call (`MediaRouter`'s own live-refresh, see its `set debug()`)
   *  reaches whichever of the two already exist too, not just the base `VideoPlayer` fields. */
  override setDebugConfig(config: DebugConfig | null, componentName: string): void {
    super.setDebugConfig(config, componentName);
    if (this.renderer !== null) {
      this.renderer.debug = config;
    }
    if (this.stepVideoList !== null) {
      this.stepVideoList.debug = config;
    }
  }

  private createDecoderWorker(codecType: string, videoInfo: VideoInfo, playMode: string): void {
    this.decoderWorker = this.decoderWorkerFactory();
    this.decoderWorker.onmessage = (event: MessageEvent<DecoderWorkerMessage>) => this.decoderWorkerMessage(event);

    this.decoderWorker.postMessage({ channelId: this.channelId, type: 'createDecoder', data: codecType });

    // reference size from getAPI_ff3.c
    const width = videoInfo.width as number;
    const height = videoInfo.height as number;
    this.decoderWorker.postMessage({ type: 'setOutputSize', data: width * height + (width * height) / 4 + (width * height) / 4 });
    this.decoderWorker.postMessage({ type: 'setFrameRate', data: this.getFrameRate() });
    this.decoderWorker.postMessage({ type: 'setDecoderIndex', data: decoderCount });
    this.decoderWorker.postMessage({ type: 'useDropPacket', data: this.framedrop });
    this.decoderWorker.postMessage({ type: 'playMode', data: playMode });
    decoderCount++;
  }

  private checkPlayer(streamData: VideoStreamData, videoInfo: VideoInfo, playMode: string): void {
    if (this.checkedPlayer === true) {
      return;
    }
    if (streamData.codecType !== 'MJPEG') {
      this.createDecoderWorker(streamData.codecType, videoInfo, playMode);
    }
    (this.renderer as CanvasRenderer).setCanvas(streamData.codecType, videoInfo);
    this.checkedPlayer = true;
    this.codec = streamData.codecType;
  }

  private checkFrameDrop(codec: string | undefined, dropOut: number | undefined): boolean {
    if (codec === 'MJPEG') {
      if (dropOut === 1) {
        this.frameCount = 0;
      } else {
        this.frameCount += 1;
      }
      if (dropOut !== undefined && dropOut > 1 && this.frameCount % dropOut === 0) {
        return true;
      }
    }
    return false;
  }

  private decoderWorkerMessage(event: MessageEvent<DecoderWorkerMessage>): void {
    const message = event.data;
    switch (message.type) {
      case 'decoded': {
        const data = (message as { type: 'decoded'; data: DecodedMessageData }).data;
        this.currentFrameCount++;
        if (this.renderer!.userPaused && !this.isStepPlaying) {
          break;
        }
        if (this.bufferManager !== null) {
          if (!this.bufferManager.checkRestart()) {
            this.popNextFrame(true);
          }
        }

        if (this.canvasElement !== null && this.canvasElement !== undefined) {
          if (data.width === this.canvasElement.width && data.height === this.canvasElement.height) {
            // draw()'s 2nd (videoInfo) param is only read on the MJPEG path;
            // 'decoded' worker messages only ever occur for H264/H265 (MJPEG
            // never creates a decoder worker — see checkPlayer()), so
            // passing {} here matches legacy's own `renderer.draw(message.data.frame)`
            // (videoInfo/callback both omitted) exactly.
            (this.renderer as CanvasRenderer).draw(data.frame, {});
            if (this.isStepPlaying) {
              this.isStepPlaying = false;
            }
            this.resizeCheck(data.width, data.height);
            // legacy: if (displayDecodingTime) { if (receiveClock set) { latency
            // = performance.now() - receiveClock; log it if debug-enabled } }
            // displayDecodingTime has no external setter anywhere in legacy
            // (grep-confirmed always false) and the computed `latency` was
            // only ever read by the (dropped, per this port's console.*
            // convention) debug log call — so this whole branch is both
            // unreachable and, even if reached, write-only. Dropped as
            // confirmed dead rather than kept as an inert field.
          } else {
            this.canvasElement.setAttribute('width', String(data.width));
            this.canvasElement.setAttribute('height', String(data.height));
          }
        } else {
          throw new RTSPOverWebSocketError({
            channelId: this.channelId,
            errorCode: fromHex('0x0904'),
            place: 'CanvasTagPlayer.ts:113',
            message: 'The canvas element do not exist. Check your canvas element or canvas element was released.'
          });
        }

        if (data.time !== null) {
          data.time.type = 'timestamp';
          data.time.channelId = this.channelId;
          (this.timeStampCallback as (timeStamp: unknown) => void)(data.time);
        }
        break;
      }
      case 'notReady':
        if (this.bufferManager !== null) {
          this.bufferManager.front();
          setTimeout(() => this.popNextFrame(false), 500);
        }
        break;
      case 'lowPerformance': {
        const data = (message as { type: 'lowPerformance'; data: { decoderId?: unknown; performance?: unknown } }).data;
        if (this.bufferManager !== null) {
          if (!this.bufferManager.checkRestart()) {
            this.popNextFrame(true);
          }
        }
        (this.errorCallback as VideoPlayerErrorCallback)({
          channelId: this.channelId,
          errorCode: fromHex('0x090B'),
          place: 'CanvasTagPlayer.ts:decoderWorkerMessage',
          description: 'You need hight performance CPU better than now.',
          decoderId: data.decoderId,
          performance: data.performance
        });
        break;
      }
      case 'terminated':
        if (this.decoderWorker !== null && typeof this.decoderWorker !== 'undefined') {
          this.decoderWorker.terminate();
          this.decoderWorker = null;
        }
        break;
      default:
        throw new RTSPOverWebSocketError({
          channelId: this.channelId,
          errorCode: fromHex('0x0905'),
          place: 'CanvasTagPlayer.ts:decoderWorkerMessage',
          message: 'The decoder worker returned unknown data'
        });
    }
  }

  private stepPlay(cmd: 'forward' | 'backward'): boolean {
    const node: StepBufferNode | null = cmd === 'forward' ? (this.stepVideoList as StepBufferList).forward() : (this.stepVideoList as StepBufferList).backward();

    if (node === null) {
      if (this.deviceType === 'camera') {
        (this.renderer as CanvasRenderer).renewCanvas();
      }
      return false;
    }

    this.onVideoData(node.playMode, node.streamData, node.videoInfo);
    return true;
  }

  private resizeCheck(width: number, height: number): void {
    if (this.rendererCheck === false) {
      this.rendererCheck = true;
      const jQueryWindow = window as unknown as { jQuery?: unknown; $?: (target: unknown) => { trigger: (name: string) => void } };
      if (jQueryWindow.jQuery) {
        (jQueryWindow.$ as (target: unknown) => { trigger: (name: string) => void })(window).trigger('resize');
      } else {
        const evt = document.createEvent('HTMLEvents');
        evt.initEvent('resize', true, false);
        window.dispatchEvent(evt);
      }
      if (this.videoSizeCallback) {
        const videoResizeInfo: CanvasResizeInfo = {
          channelId: this.channelId,
          // legacy reads the bare global `parent` (window.parent — always
          // exists in a browser, but has no `.id` property, so this is
          // always undefined in practice; not a crash, just inert data).
          elementId: (window.parent as unknown as { id?: string }).id,
          videoElementId: (this.canvasElement as HTMLCanvasElement).id,
          tagmode: 'canvas',
          width,
          height
        };
        this.videoSizeCallback(videoResizeInfo);
      }
    }
  }

  override init(element?: HTMLCanvasElement): void {
    if (typeof element === 'undefined' || typeof element.cloneNode === 'undefined') {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: fromHex('0x0904'),
        place: 'CanvasTagPlayer.ts:init',
        message: 'The canvas element do not exist. Check your canvas element or canvas element was released.'
      });
    }
    this.canvasElement = element.cloneNode(true) as HTMLCanvasElement;
    (element.parentNode as ParentNode).replaceChild(this.canvasElement, element);

    this.debugLog.debug('init()');
    this.renderer = new CanvasRenderer();
    this.renderer.channelId = this.channelId;
    this.renderer.debug = this.debugConfig;
    this.renderer.addEventListener('capture', this.eventCaptureCallback as (data: unknown) => void);
    this.renderer.init(this.canvasElement);
    this.stepVideoList = new StepBufferList();
    this.stepVideoList.debug = this.debugConfig;
    this.canvasElement.addEventListener('webglcontextlost', this.onHandleContextLost, false);

    this.mediaTimer = setInterval(this.onMediaTimer, 1000);
    this.currentFrameCount = 0;
  }

  private popNextFrame(isDecoderReady: boolean): void {
    void isDecoderReady;
    if (this.bufferManager === null || this.bufferManager.isReadyToPop() === false) {
      return;
    }
    const ret = this.bufferManager.pop();
    if (typeof ret === 'object' && ret !== null) {
      const frame = ret as PopFrameInfo;
      this.onVideoData(frame.playMode, frame.streamData as VideoStreamData, frame.videoInfo as VideoInfo);
    }
  }

  override onVideoData(playMode: string, streamData: VideoStreamData, videoInfo: VideoInfo): void {
    this.checkPlayer(streamData, videoInfo, playMode);

    // VideoTagPlayer tags every sample's timeStamp with 'live'/'playback'
    // before handing it to its own timeStampCallback (see its
    // updateVideoTimestamp()/onVideoSourceUpdateEnd() `.mode =` assignments);
    // this player never did, so the consuming app's mode-keyed 'timestamp'
    // event handler (switching on `event.detail.mode`) silently no-ops for
    // every canvas-rendered frame -- reported directly by the user as
    // "#timestamp_date/#timestamp_time never show up in canvas Playback"
    // (Live happened to still be going through VideoTagPlayer at the time,
    // masking the same gap there). Tagged once here, on the same
    // `streamData.timeStamp` object instance that both the frame-drop
    // early-return below and the MJPEG/decoder-worker paths further down
    // forward on unchanged -- the H264/H265 decoder-worker path structured
    // -clones this object into the worker and echoes it straight back as
    // the 'decoded' message's `data.time`, so this single assignment covers
    // that round trip too.
    streamData.timeStamp.mode = this.playmode;

    if (this.checkFrameDrop(streamData.codecType, videoInfo.dropOut) === true) {
      (this.timeStampCallback as (timeStamp: unknown) => void)(streamData.timeStamp);
      return;
    }

    if (this.renderer !== null) {
      if (streamData.codecType === 'MJPEG') {
        const mjpegDraw = (): void => {
          this.currentFrameCount++;
          (this.renderer as CanvasRenderer).draw(streamData.frameData, videoInfo, () => (this.timeStampCallback as (t: unknown) => void)(streamData.timeStamp));
          this.resizeCheck(videoInfo.width as number, videoInfo.height as number);
          if (playMode === 'Playback') {
            (streamData.timeStamp as unknown as { channelId?: number }).channelId = this.channelId;
          }
        };
        const videoSize = (videoInfo.width as number) * (videoInfo.height as number);
        let timeoutValue: number;
        if (videoSize <= FRAME_SIZE.HD) {
          timeoutValue = 200;
        } else if (videoSize <= FRAME_SIZE.FHD) {
          timeoutValue = 160;
        } else if (videoSize <= FRAME_SIZE.UHD) {
          timeoutValue = 120;
        } else {
          timeoutValue = 80;
        }
        setTimeout(mjpegDraw, timeoutValue);
      } else {
        (this.decoderWorker as Worker).postMessage({
          type: 'decode',
          data: {
            playMode,
            timeStamp: streamData.timeStamp,
            frameData: streamData.frameData,
            frameType: videoInfo.frameType,
            width: videoInfo.width,
            height: videoInfo.height,
            cropWidth: videoInfo.cropWidth,
            cropHeight: videoInfo.cropHeight,
            receiveClock: (streamData as unknown as { receiveClock?: unknown }).receiveClock,
            currentFps: this.rfps !== undefined ? this.rfps : this.getFrameRate()
          }
        });
      }
    } else {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: fromHex('0x0903'),
        place: 'CanvasTagPlayer.ts:290',
        message: 'CanvasTagPlayer: canvas tag renderer is null'
      });
    }
  }

  override onWaitingPackets(_event: WaitingEvent): void {}

  bufferingVideoData(playMode: string, streamData: VideoStreamData, videoInfo: VideoInfo): boolean {
    this.checkPlayer(streamData, videoInfo, playMode);
    return (this.stepVideoList as StepBufferList).push(playMode, streamData, videoInfo);
  }

  sendToBufferManager(playMode: string, streamData: VideoStreamData, videoInfo: VideoInfo, errorCallback: unknown): void {
    if (this.bufferManager === null) {
      this.bufferManager = new PlaybackBufferManager();
      this.bufferManager.init(errorCallback as (message: BufferControlMessage) => void);
      this.bufferManager.channelId = this.channelId;
    }
    this.checkPlayer(streamData, videoInfo, playMode);
    // PlaybackBufferManager's own PushBufferInfo type (ported separately,
    // Layer 5) models timeStamp.timestamp as `number | null`, while
    // MediaRouter's TimeStampInfo (Layer 7) models it as `number | undefined`
    // — a typing mismatch between two independently-ported modules, not a
    // real behavioral difference (both just mean "may be absent").
    const results = this.bufferManager.push({ streamData, videoInfo } as unknown as Parameters<PlaybackBufferManager['push']>[0]);

    if (results === true || this.deviceType === 'nvr') {
      this.popNextFrame(false);
    }
  }

  capture(fileName: string): void {
    (this.renderer as CanvasRenderer).addEventListener('capture', this.eventCaptureCallback as (data: unknown) => void);
    (this.renderer as CanvasRenderer).capture(fileName);
  }

  setTimeStampCallback(func: (timeStamp: unknown) => void): void {
    this.timeStampCallback = func;
  }

  setResizeCallback(func: (info: CanvasResizeInfo) => void): void {
    this.videoSizeCallback = func;
  }

  override play(): void {
    (this.renderer as CanvasRenderer).userPaused = false;
  }

  override pause(): void {
    (this.renderer as CanvasRenderer).userPaused = true;
    if (this.bufferManager !== null) {
      this.bufferManager.pause();
    }
  }

  override resume(): void {
    (this.renderer as CanvasRenderer).userPaused = false;
    if (this.bufferManager !== null) {
      const ret = this.bufferManager.resume();
      if (ret === true) {
        this.popNextFrame(false);
      }
    }
  }

  override stop(): void {
    (this.renderer as CanvasRenderer).userPaused = true;
  }

  controlStepPlay(timestamp: { timestamp?: number; timestamp_usec?: number }, stepCmd: string): void {
    (this.stepVideoList as StepBufferList).searchTimestamp(timestamp);
    const node = (this.stepVideoList as StepBufferList).findIFrame(stepCmd) as StepBufferNode;
    this.isStepPlaying = true;
    this.onVideoData(node.playMode, node.streamData, node.videoInfo);
  }

  override forward(): boolean {
    this.isStepPlaying = true;
    return this.stepPlay('forward');
  }

  override backward(): boolean {
    this.isStepPlaying = true;
    return this.stepPlay('backward');
  }

  toggleControls(): void {}

  override clearBuffer(): void {
    (this.stepVideoList as StepBufferList).bufferClear();
  }

  digitalZoom(bufferData: unknown): void {
    if (this.renderer !== null && this.rendererCheck) {
      this.renderer.digitalZoom(bufferData);
    }
  }

  override updateMiniMapInfo(data: { mode: string; target?: HTMLCanvasElement | null }): void {
    (this.renderer as CanvasRenderer).updateMinimapInfo(data);
  }

  override close(): void {
    if (this.canvasElement !== null && this.canvasElement !== undefined) {
      this.canvasElement.removeEventListener('webglcontextlost', this.onHandleContextLost, false);
      this.canvasElement = null;
    }

    if (typeof this.mediaTimer !== 'undefined' && this.mediaTimer !== null) {
      clearInterval(this.mediaTimer);
    }

    if (this.renderer !== null && typeof this.renderer !== 'undefined') {
      this.renderer.userPaused = true;
      this.renderer.renewCanvas();
      this.renderer.destroy();
    }

    if (this.decoderWorker !== null) {
      this.decoderWorker.postMessage({ channelId: this.channelId, type: 'terminate' });
    }

    if (this.bufferManager !== null && typeof this.bufferManager !== 'undefined') {
      this.bufferManager = null;
    }
  }

  onNetworkState(_variance: number, _mean: number): void {
    // Canvas Tag is not use this method
  }

  onChangeAudioShift(): void {}

  onChangeSpeed(): void {}
}
