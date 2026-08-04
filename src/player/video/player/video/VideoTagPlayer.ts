import moment from 'moment-timezone';
import { VideoPlayer, type VideoPlayerErrorCallback } from '../VideoPlayer';
import { CircularTypedArrayQueue } from '../../../util/CircularTypedArrayQueue';
import { Median } from '../../../util/Median';
import { Mean } from '../../../util/Mean';
import { IntervalTimer } from '../../../util/IntervalTimer';
import { fromHex } from '../../../util/hex';
import { fastJsonStringfy } from '../../../util/fastJsonStringfy';
import { RTSPOverWebSocketError } from '../../../exceptions/RTSPOverWebSocketError';
import type { VideoStreamData, VideoInfo, AudioStreamData, AudioInfo, WaitingEvent } from '../../../mediaSession';
import { saveAs } from 'file-saver';
import { initSegment, mediaSegment, dualTrackMediaSegment, type Mp4VideoTrackInfo, type Mp4AudioTrackInfo, type Mp4BoxInfo, type Mp4Sample, type Mp4TimeStamp } from '../../../vendor/mp4Generator';

export type AudiotranscoderWorkerFactory = () => Worker;

export interface BrowserInfo {
  os: string;
  browser: string;
  osVersion: string;
  browserVersion: string;
}

/**
 * Reads `window.jscd` (the legacy player’s Util/util.js's `window.jscd =
 * getJsClientDetection();`, a ~200-line browser-sniffing function). It's
 * genuinely defined in legacy (found at util.js:91, called at util.js:280 —
 * not one of this migration's confirmed-broken globals), but re-deriving
 * the full user-agent parser here isn't worthwhile: it needs real
 * `navigator`/`screen` (unavailable under Vitest's Node environment) and
 * MediaRouter.ts already established the same defensive-optional-chaining
 * treatment for the same global in an earlier layer. Injectable for tests.
 */
function defaultGetBrowserInfo(): BrowserInfo {
  const jscd = (globalThis as unknown as { window?: { jscd?: Partial<BrowserInfo> } }).window?.jscd;
  return {
    os: jscd?.os ?? '',
    browser: jscd?.browser ?? '',
    osVersion: jscd?.osVersion ?? '',
    browserVersion: jscd?.browserVersion ?? ''
  };
}

const CHROME_DEFAULT_FRAME_BUFFER_COUNT = 10;
const CHROME_DEFAULT_DELAY_TIME = 0.3;
const OTHER_DEFAULT_FRAME_BUFFER_COUNT = 20;
const OTHER_DEFAULT_DELAY_TIME = 0.7;
const SAFARI_DEFAULT_FRAME_BUFFER_COUNT = 15;
const SAFARI_DEFAULT_DELAY_TIME = 0.4;
const MAX_BUFFER_FRAME_COUNT = 50;
const PLAYBACK_BUFFERING_TIME = 1;
const STALLING_TIMEOUT = 3000;
const VIDEO_MAX_VARIANCE_VALUE = 10;
const VIDEO_MAX_TIMESTAMP_QUEUE = 10;
const TEN = 10;
const TIME_SCALE = 10000;
const AAC_FRAME_SAMPLES = 1024;
const MAX_PLAYBACK_DIFF = 1500;
const MAX_CUE_COUNT = 100;
const PREFIX_SIZE = 4;

interface TimestampData extends Mp4TimeStamp {
  type?: string;
  channelId?: number;
  currentTimeDiff?: number;
  videoSize?: number | null;
  utcDatetime?: number | Date;
}

interface VideoSample {
  size: number;
  frameData: Uint8Array;
  frameInfo: VideoInfo;
  timeStamp: TimestampData;
  frameDuration: number;
  rtpTimestamp?: number;
}

interface AudioSample {
  size: number;
  frameData: Uint8Array;
  frameInfo: AudioInfo;
  timeStamp: TimestampData;
  duration?: number;
  rtpTimestamp?: number;
}

interface FrameDurationResult {
  streamData: VideoStreamData;
  videoInfo: VideoInfo;
  frameDuration: number;
}

interface MinimapInfo {
  isUpdate: boolean;
  element: (HTMLCanvasElement & { getContext(id: '2d'): CanvasRenderingContext2D | null }) | null;
}

interface AudioTranscoderMessage {
  type: 'transcoded' | 'terminated' | string;
  data?: { frameData: Uint8Array; [key: string]: unknown };
}

/**
 * Ported from the legacy player’s Video/Player/Video/videoTagPlayer.
 *
 * The single largest, most stateful file in this migration: a `<video>`
 * tag driven by MediaSource Extensions, fed fragmented-MP4 segments built
 * on the fly (via the vendored mp4Generator.js) from RTP-depacketized
 * H264/H265 + AAC/G711/G726 frames, with A/V sync driven by VTTCue text
 * tracks carrying JSON timestamps. Kept as one cohesive class (matching
 * legacy's single factory-function closure) rather than split into
 * artificially-separate modules: virtually every method reads/mutates the
 * same ~50 fields (sourceBuffer, segment queues, base decode times, delay
 * tuning), so splitting would just relocate shared mutable state rather
 * than actually decouple anything.
 *
 * Confirmed-dead code dropped: `addBuffer`/`buildWaveHeader` (a WAV-dump
 * debug recorder) is declared but never called anywhere in the file
 * (grep-confirmed) — omitted entirely rather than ported as dead weight.
 */
export class VideoTagPlayer extends VideoPlayer {
  background_img?: string;

  private videoElement: HTMLVideoElement | null = null;
  private videoTagPromise: Promise<void> | undefined;
  private videoSize: number | null = null;
  private videoCodecInfo: string | null = null;
  private audioCodecInfo: { codecType: string | number; bitrate: number } = { codecType: 0, bitrate: 0 };
  private minimapInfo: MinimapInfo = { isUpdate: false, element: null };

  private bufferedFrameCount = 4;
  private playbackFlag = false;
  private prefixSize = PREFIX_SIZE;
  // NOTE: legacy also declares preAudioFrameData/bAudioUnstableTimestamp/
  // _audioTimestampIntervalQueue as the audio-side counterparts of the
  // fields below them, all exclusively consumed by getAudioFrameDuration()
  // — grep-confirmed dead (see the NOTE where that function was omitted).
  // Since that's their only reader (preAudioFrameData is still *written* by
  // resetBaseDecodingTime, but never read afterward), they're dropped here
  // too rather than kept as write-only weight.
  private preVideoFrameData: FrameDurationResult | null = null;
  private prevBoxsize = 1;
  private statisticsTimer: IntervalTimer | null = null;
  private networkWeight = 1;
  private bVideoUnstableTimestamp = false;
  private readonly videoTimestampIntervalQueue = new CircularTypedArrayQueue<number>(VIDEO_MAX_TIMESTAMP_QUEUE, true);

  private defaultDelay = CHROME_DEFAULT_DELAY_TIME;
  private delay = CHROME_DEFAULT_DELAY_TIME;
  // NOTE: legacy's own `isCanPlay` is write-only too (set in onCanPlay/
  // onSeeking, grep-confirmed never read anywhere in videoTagPlayer.js
  // itself — a pre-existing legacy quirk, not something this port
  // introduced) — dropped along with its two write sites.
  private preVideoTimeStamp: TimestampData | null = null;
  private preAudioTimeStamp: TimestampData | null = null;

  private decodedFrames = 0;
  private decodedPerSec = 0;
  private videoBytesDecoded = 0;
  private videoBytesDecodedPerSec = 0;
  private droppedFrames = 0;
  private droppedFramesPerSec = 0;
  private readonly decodedMean = new Mean();
  private readonly videoMean = new Mean();
  private readonly dropMean = new Mean();
  private timerID: ReturnType<typeof setTimeout> | null = null;
  private isStalling = false;

  // NOTE: legacy's `videoSizeCallback` is also write-only — setResizeCallback()
  // stores it, but every call site that would invoke it is commented out
  // (both in videoElementEventListener's 'resize' case and elsewhere) —
  // grep-confirmed. setResizeCallback() is kept below (public API surface
  // other callers may rely on existing) but no longer stores anything.
  private timeStampCallback: ((timeStamp: unknown) => void) | null = null;

  private videoEventListenerArray: string[] | null = null;
  private bufferEventListenerArray: string[] | null = null;
  private mediaSourceEventListenerArray: string[] | null = null;

  private userPaused = false;
  // A separate field from the inherited `speed` accessor's own private
  // backing store (VideoPlayer.ts's `speedValue`, TS forbids reusing that
  // name here anyway) — legacy genuinely has two independent closure
  // variables too: videoPlayer.js's `_speedValue` (behind the `speed`
  // accessor) and videoTagPlayer.js's own `speedValue`, kept in sync only
  // because onChangeSpeed() (called by the `speed` setter, before it
  // updates its own backing field) assigns this one too.
  private localSpeedValue = 1;
  private speedChanged = false;

  private receiveTimeStamp: TimestampData = { timestamp: 0, timestamp_usec: 0, timezone: 0, channelId: 0 };
  // NOTE: legacy's `receiveAudioTimeStamp` is also write-only (set in
  // onAudioData, grep-confirmed never read anywhere) — dropped.
  private requestTime: { endTime?: string } | null = null;

  private sourceBuffer: SourceBuffer | null = null;
  private mediaSource: MediaSource | null = null;

  private segmentArray: Uint8Array[] = [];
  private sequenseNum = 1;
  private videoSamples: VideoSample[] = [];
  private audioSamples: AudioSample[] = [];
  private baseVideoTime = 0;
  private baseAudioTime = 0;
  private baseNTPTimestamp = 0;
  private boxStartTime: number[] = [];
  private lastBoxSize = 0;
  private fileName = '';
  private captureFlag = false;
  private timestampTextTrackId = -1;
  private clearBufferFlag = false;
  private audioInfo: Mp4AudioTrackInfo = {
    id: 2,
    channelcount: 1,
    samplesize: 8,
    type: 'audio',
    codecType: 'AAC',
    audioobjecttype: 2,
    samplingfrequencyindex: 11,
    samplingDuration: 1280,
    interleavedId: 0
  };
  private videoInfoBox: Mp4VideoTrackInfo | null = null;
  private dummyAudio = true;
  // Tracks whether this.audioInfo currently reflects a real AAC source
  // (vs. the G711/G726-transcoded-in-browser config) — see setAudioInfo().
  // Explicit state instead of overloading samplingfrequencyindex as a
  // sentinel, since that value is now derived from the real stream and can
  // legitimately land on any table index, including ones a sentinel check
  // would have collided with.
  private realAacActive = false;

  private audiotranscoderWorker: Worker | null = null;
  private createVideoSegmentTimeout: ReturnType<typeof setTimeout> | null = null;
  private createAudioSegmentTimeout: ReturnType<typeof setTimeout> | null = null;
  // NOTE: legacy's `transcodestart` is written (performance.now(), on the
  // G711/G726 transcode-request path) and read once, but only inside an
  // `isDebugEnabled()`-guarded debug log — a call this port drops like
  // every other console/log-only branch (see the file header) — so this
  // port doesn't need to track it at all.
  private audio = false;
  private audioTime = 0;

  private readonly onVisibilityChangeBound = (): void => this.onVisibilityChange();

  constructor(
    private readonly audiotranscoderWorkerFactory: AudiotranscoderWorkerFactory = () =>
      new Worker(new URL('../../../worker/audioTranscoder/audiotranscoderWorker.ts', import.meta.url)),
    private readonly getBrowserInfo: () => BrowserInfo = defaultGetBrowserInfo
  ) {
    super();
    this.rfps = 30;
    this.boxsize = 1;

    const info = this.getBrowserInfo();
    if (info.os.indexOf('Windows') !== -1 && info.osVersion !== '7' && (info.browser.indexOf('Chrome') !== -1 || info.browser.indexOf('Chromium') !== -1)) {
      this.bufferedFrameCount = CHROME_DEFAULT_FRAME_BUFFER_COUNT;
      this.defaultDelay = CHROME_DEFAULT_DELAY_TIME;
    } else if (info.os.indexOf('Mac') !== -1 && info.browser.indexOf('Safari') !== -1) {
      const version = info.osVersion.split('.');
      if (parseInt(version[0], 10) === 10 && parseInt(version[1], 10) < 13) {
        throw new RTSPOverWebSocketError({
          channelId: this.channelId,
          errorCode: fromHex('0x090D'),
          place: 'VideoTagPlayer.ts:Constructor',
          message: 'This osx version do not support for video tag.'
        });
      } else {
        this.bufferedFrameCount = SAFARI_DEFAULT_FRAME_BUFFER_COUNT;
        this.defaultDelay = SAFARI_DEFAULT_DELAY_TIME;
      }
    } else {
      this.bufferedFrameCount = OTHER_DEFAULT_FRAME_BUFFER_COUNT;
      this.defaultDelay = OTHER_DEFAULT_DELAY_TIME;
    }
    this.delay = this.defaultDelay;

    this.audiotranscoderWorker = this.audiotranscoderWorkerFactory();
    this.audiotranscoderWorker.onmessage = (event: MessageEvent<AudioTranscoderMessage>) => this.audiotranscoderWorkerMessage(event);
  }

  private addVideoEventListener(): void {
    this.videoEventListenerArray = [
      'durationchange', 'playing', 'error', 'pause', 'timeupdate', 'resize', 'seeked',
      'progress', 'seeking', 'loadstart', 'abort', 'emptied', 'stalled', 'loadedmetadata', 'loadeddata', 'canplay',
      'canplaythrough', 'waiting', 'ended', 'play', 'ratechange', 'volumechange', 'addtrack', 'removetrack'
    ];
    for (const type of this.videoEventListenerArray) {
      (this.videoElement as HTMLVideoElement).addEventListener(type, this.videoElementEventListener);
    }
  }

  private addBufferEventListener(): void {
    this.bufferEventListenerArray = ['error', 'abort', 'updatestart', 'update', 'updateend', 'updating'];
    for (const type of this.bufferEventListenerArray) {
      (this.sourceBuffer as SourceBuffer).addEventListener(type, this.sourceBufferEventListener);
    }
  }

  private addMediaSourceEventListener(): void {
    this.mediaSourceEventListenerArray = ['sourceopen', 'error', 'sourceended', 'sourceclose'];
    for (const type of this.mediaSourceEventListenerArray) {
      (this.mediaSource as MediaSource).addEventListener(type, this.mediaSourceEventListener);
    }
  }

  private readonly mediaSourceEventListener = (event: Event): void => {
    switch (event.type) {
      case 'sourceopen':
        this.mediaSource = event.target as MediaSource;
        this.setSourceBuffer();
        break;
      case 'error':
      case 'abort':
      case 'sourceended':
      case 'sourceclose':
      default:
        break;
    }
  };

  private readonly sourceBufferEventListener = (event: Event): void => {
    switch (event.type) {
      case 'error':
      case 'abort':
      case 'updatestart':
      case 'update':
      case 'updating':
        break;
      case 'updateend': {
        const sourceBuffer = this.sourceBuffer;
        if (this.clearBufferFlag && sourceBuffer !== null && !sourceBuffer.updating && sourceBuffer.buffered.length > 1) {
          const endTime = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1) * 1;
          sourceBuffer.remove(0, endTime);
          this.clearBufferFlag = false;
        }
        this.appendSegmentToSourceBuffer();
        break;
      }
      default:
        break;
    }
  };

  private readonly videoElementEventListener = (event: Event): void => {
    switch (event.type) {
      case 'resize': {
        const jQueryWindow = (globalThis as unknown as { window?: { jQuery?: unknown; $?: (target: unknown) => { trigger: (name: string) => void } } }).window;
        if (jQueryWindow?.jQuery) {
          (jQueryWindow.$ as (target: unknown) => { trigger: (name: string) => void })(jQueryWindow).trigger('resize');
        } else {
          const evt = document.createEvent('HTMLEvents');
          evt.initEvent('resize', true, false);
          window.dispatchEvent(evt);
        }
        break;
      }
      default:
        break;
    }
  };

  private removeAllEventListener(): void {
    if (this.sourceBuffer !== null && this.bufferEventListenerArray !== null) {
      for (const type of this.bufferEventListenerArray) {
        this.sourceBuffer.removeEventListener(type, this.sourceBufferEventListener);
      }
      this.sourceBuffer = null;
    }
    if (this.mediaSource !== null && this.mediaSourceEventListenerArray !== null) {
      for (const type of this.mediaSourceEventListenerArray) {
        this.mediaSource.removeEventListener(type, this.mediaSourceEventListener);
      }
      this.mediaSource = null;
    }
    if (this.videoEventListenerArray !== null) {
      for (const type of this.videoEventListenerArray) {
        (this.videoElement as HTMLVideoElement).removeEventListener(type, this.videoElementEventListener);
      }
    }
    if (typeof (document as unknown as { webkitHidden?: unknown }).webkitHidden !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChangeBound);
    }
  }

  private createMediaSource(): void {
    if (this.mediaSource === null || this.mediaSource.readyState === 'ended') {
      this.mediaSource = new MediaSource();
      (this.videoElement as HTMLVideoElement).src = window.URL.createObjectURL(this.mediaSource);
      this.addMediaSourceEventListener();
    }
  }

  // onCueChange/onCueEnter/onCueExit are assigned directly as
  // `track.oncuechange = ...`/`cue.onenter = ...`/`cue.onexit = ...` in
  // legacy, so `this` inside them is the TextTrack/VTTCue that fired the
  // event, not the player — preserved here via plain (non-arrow, unbound)
  // functions that close over `player = this` for the state they still
  // need, exactly mirroring that dual-`this` legacy pattern.
  private makeOnCueChange(): (this: TextTrack) => void {
    const player = this;
    return function onCueChange(this: TextTrack): void {
      const cues = this.cues;
      if (cues !== null && cues.length > MAX_CUE_COUNT) {
        for (let i = 0; i < MAX_CUE_COUNT; i++) {
          try {
            if (cues.length < i) {
              this.removeCue(cues[i] as VTTCue);
            }
          } catch (error) {
            throw new RTSPOverWebSocketError({
              channelId: player.channelId,
              errorCode: (error as { code?: number }).code,
              place: 'VideoTagPlayer.ts:onCueChange',
              message: (error as Error).message
            });
          }
        }
      }
    };
  }

  private makeOnCueEnter(): (this: VTTCue) => void {
    const player = this;
    return function onCueEnter(this: VTTCue): void {
      // legacy declares `var track = videoElement.textTracks[...]` here but
      // never actually uses it (grep-confirmed dead local) — omitted.
      if (typeof this.text !== 'undefined' && this.text !== null) {
        try {
          const timeStamp: TimestampData = JSON.parse(this.text);
          timeStamp.type = 'timestamp';
          timeStamp.channelId = player.channelId;
          timeStamp.currentTimeDiff = parseInt(String(((player.videoElement as HTMLVideoElement).currentTime - this.startTime) * 1000), 10);
          timeStamp.videoSize = player.videoSize;
          (player.timeStampCallback as (t: unknown) => void)(timeStamp);
        } catch (error) {
          throw new RTSPOverWebSocketError({
            channelId: player.channelId,
            errorCode: (error as { code?: number }).code,
            place: 'VideoTagPlayer.ts:onCueEnter',
            message: (error as Error).message
          });
        }
      }
    };
  }

  private makeOnCueExit(): (this: VTTCue) => void {
    const player = this;
    return function onCueExit(this: VTTCue): void {
      if (player.videoElement) {
        const track = player.videoElement.textTracks[player.timestampTextTrackId];
        if (typeof track !== 'undefined' && track !== null) {
          try {
            track.removeCue(this);
          } catch (error) {
            throw new RTSPOverWebSocketError({
              channelId: player.channelId,
              errorCode: (error as { code?: number }).code,
              place: 'VideoTagPlayer.ts:onCueExit',
              message: (error as Error).message
            });
          }
        }
      } else {
        throw new RTSPOverWebSocketError({
          channelId: player.channelId,
          errorCode: fromHex('0x0900'),
          place: 'VideoTagPlayer.ts:onCueExit',
          message: 'video tag element was not initialized.'
        });
      }
    };
  }

  private removeAllCues(textTrack: TextTrack | null | undefined): void {
    if (!textTrack || !textTrack.cues) {
      return;
    }
    while (textTrack.cues.length > 0) {
      textTrack.removeCue(textTrack.cues[0]);
    }
  }

  private elementSetting(): void {
    if (this.videoElement) {
      const videoElement = this.videoElement;
      videoElement.controls = false;
      videoElement.preload = 'auto';
      videoElement.autoplay = false;
      videoElement.muted = this.audio ? false : true;
      videoElement.volume = 0;

      videoElement.style.background = `url(${this.background_img}) no-repeat center center${videoElement.style.background}`;
      videoElement.style.backgroundSize = '48px 48px';
      videoElement.onplaying = () => this.onPlaying();
      videoElement.onpause = () => this.onPause();
      (videoElement as unknown as { onclose: (() => void) | null }).onclose = () => this.onClose();
      videoElement.oncanplay = (evt: Event) => this.onCanPlay(evt);
      videoElement.onwaiting = () => this.onWaiting();
      videoElement.ondurationchange = () => this.onDurationChange();
      videoElement.onloadeddata = () => this.onLoadedData();
      videoElement.onprogress = (evt: Event) => this.onProgress(evt);
      videoElement.onseeking = (evt: Event) => this.onSeeking(evt);
      videoElement.onseeked = (evt: Event) => this.onSeeked(evt);
      videoElement.ontimeupdate = (evt: Event) => this.onTimeUpdate(evt);
      videoElement.onstalled = () => this.onStalled();
      videoElement.oncanplaythrough = (evt: Event) => this.onCanPlayThrough(evt);
      videoElement.onemptied = () => this.onEmptied();
      videoElement.textTracks.onaddtrack = (evt: Event) => this.onAddTextTrack(evt as TrackEvent);
      videoElement.textTracks.onremovetrack = () => this.onRemoveTextTrack();

      videoElement.setAttribute('oncontextmenu', 'return false;');

      if (videoElement.textTracks.length === 0 && this.timestampTextTrackId < 0) {
        const textTrack = videoElement.addTextTrack('captions', 'English', 'en');
        (textTrack as unknown as { name?: string }).name = 'timestamp';
      }
      this.timestampTextTrackId = videoElement.textTracks.length - 1;

      this.addVideoEventListener();

      const doc = document as unknown as { hidden?: unknown; msHidden?: unknown; webkitHidden?: unknown };
      let hidden: string | undefined;
      let visibilityChange: string | undefined;
      if (typeof doc.hidden !== 'undefined') {
        hidden = 'hidden';
        visibilityChange = 'visibilitychange';
      } else if (typeof doc.msHidden !== 'undefined') {
        hidden = 'msHidden';
        visibilityChange = 'msvisibilitychange';
      } else if (typeof doc.webkitHidden !== 'undefined') {
        hidden = 'webkitHidden';
        visibilityChange = 'webkitvisibilitychange';
      }

      if (typeof document.addEventListener !== 'undefined' && hidden !== undefined && typeof (doc as Record<string, unknown>)[hidden] !== 'undefined') {
        document.addEventListener(visibilityChange as string, this.onVisibilityChangeBound);
      }
    } else {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: fromHex('0x0900'),
        place: 'VideoTagPlayer.ts:elementSetting',
        message: 'video tag element was not initialized.'
      });
    }
  }

  private getCurrentVideoFrame(): void {
    this.recalcRates();
    const videoElement = this.videoElement as HTMLVideoElement & { webkitDecodedFrameCount?: number; webkitVideoDecodedByteCount?: number; webkitDroppedFrameCount?: number };
    const curTime = videoElement.currentTime;
    let fps: number;
    if (typeof videoElement.webkitDecodedFrameCount === 'undefined') {
      this.currentFrameCount = Math.floor(curTime * this.getFrameRate());
      fps = this.currentFrameCount - this.previousFrameCount;
    } else {
      fps = this.decodedPerSec;
    }

    if (this.instantplayback && !videoElement.paused) {
      const data = { channelId: this.channelId, errorCode: fromHex('0x1102'), currentTime: curTime };
      if (typeof this.eventInstantPlaybackCallback !== 'undefined' && this.eventInstantPlaybackCallback !== null) {
        this.eventInstantPlaybackCallback(data);
      }
    }

    if (
      typeof this.eventStatisticsCallback !== 'undefined' &&
      this.eventStatisticsCallback !== null &&
      typeof this.sourceBuffer !== 'undefined' &&
      this.sourceBuffer !== null &&
      typeof this.sourceBuffer.buffered !== 'undefined' &&
      this.sourceBuffer.buffered !== null &&
      this.sourceBuffer.buffered.length !== 0 &&
      !this.instantplayback
    ) {
      const startTime = this.sourceBuffer.buffered.start(this.sourceBuffer.buffered.length - 1) * 1;
      const endTime = this.sourceBuffer.buffered.end(this.sourceBuffer.buffered.length - 1) * 1;
      const latency = videoElement.currentTime === 0 ? endTime - startTime : endTime - videoElement.currentTime;

      const decodedMeanVal = Number(this.decodedMean.mean());
      const videoMeanVal = Number(this.videoMean.mean());
      const dropMeanVal = Number(this.dropMean.mean());
      const data = {
        type: 'fps',
        channelId: this.channelId,
        width: videoElement.videoWidth,
        height: videoElement.videoHeight,
        fps,
        decodedPerSec: isNaN(this.decodedPerSec) ? undefined : this.decodedPerSec,
        decodedFrames: videoElement.webkitDecodedFrameCount,
        decodedFramesMean: isNaN(decodedMeanVal) ? undefined : decodedMeanVal,
        decodedBytesDecodedPerSec: videoElement.webkitVideoDecodedByteCount,
        decodedBytesMean: isNaN(videoMeanVal) ? undefined : videoMeanVal,
        dropFramesCount: videoElement.webkitDroppedFrameCount,
        dropFramesMean: isNaN(dropMeanVal) ? undefined : dropMeanVal,
        bps: ((videoElement.videoWidth * videoElement.videoHeight * fps * 0.07) / (1024 * 1024)).toFixed(2),
        latency: latency.toFixed(4),
        limit: this.delay,
        chunksize: this.boxsize
      };
      this.eventStatisticsCallback(data);
    }
    this.previousFrameCount = this.currentFrameCount;
  }

  private recalcRates(): void {
    const videoElement = this.videoElement as HTMLVideoElement & { webkitDecodedFrameCount?: number; webkitVideoDecodedByteCount?: number; webkitDroppedFrameCount?: number };
    if (videoElement.readyState <= HTMLMediaElement.HAVE_CURRENT_DATA || videoElement.paused || videoElement.ended) {
      return;
    }
    const decodedFrameCount = videoElement.webkitDecodedFrameCount as number;
    const videoDecodedByteCount = videoElement.webkitVideoDecodedByteCount as number;
    const droppedFrameCount = videoElement.webkitDroppedFrameCount as number;
    this.decodedPerSec = decodedFrameCount - this.decodedFrames;
    this.decodedFrames = decodedFrameCount;
    this.videoBytesDecodedPerSec = videoDecodedByteCount - this.videoBytesDecoded;
    this.videoBytesDecoded = videoDecodedByteCount;
    this.droppedFramesPerSec = droppedFrameCount - this.droppedFrames;
    this.droppedFrames = droppedFrameCount;
    this.decodedMean.record(this.decodedPerSec);
    this.videoMean.record(this.videoBytesDecodedPerSec);
    this.dropMean.record(this.droppedFramesPerSec);
  }

  private changeCurrentTime(): void {
    const videoElement = this.videoElement as HTMLVideoElement;
    if (videoElement.paused) {
      return;
    }
    const boxTimeIndex = this.lastBoxSize <= 4 ? 2 : 1;
    if (boxTimeIndex < this.boxStartTime.length) {
      const lastBoxTime = this.boxStartTime[this.boxStartTime.length - 1 - boxTimeIndex];
      if (videoElement.currentTime < lastBoxTime) {
        videoElement.currentTime = lastBoxTime;
      }
    }
  }

  private onVisibilityChange(): void {
    if (!this.playbackFlag || document.visibilityState !== 'visible') {
      return;
    }
    this.changeCurrentTime();
  }

  private onPlaying(): void {
    if (typeof this.statisticsTimer === 'undefined' || this.statisticsTimer === null) {
      this.statisticsTimer = new IntervalTimer(() => this.getCurrentVideoFrame(), 1000);
    } else {
      this.statisticsTimer.resume();
    }
  }

  private onCanPlay(_evt: Event): void {
    const videoElement = this.videoElement as HTMLVideoElement;
    if (videoElement.paused) {
      if (!this.instantplayback) {
        this.videoPlay();
      } else {
        const data = {
          channelId: this.channelId,
          errorCode: fromHex('0x1107'),
          currentTime: videoElement.currentTime,
          description: 'on can play seeked position.'
        };
        if (typeof this.eventInstantPlaybackCallback !== 'undefined' && this.eventInstantPlaybackCallback !== null) {
          this.eventInstantPlaybackCallback(data);
        }
      }
    }
  }

  private onClose(): void {
    this.previousFrameCount = this.currentFrameCount = 0;
    if (this.statisticsTimer !== undefined && this.statisticsTimer !== null) {
      this.statisticsTimer.pause();
      this.statisticsTimer = null;
    }
  }

  private onPause(): void {
    const sourceBuffer = this.sourceBuffer;
    if (this.instantplayback && this.userPaused && sourceBuffer !== null && typeof sourceBuffer.buffered !== 'undefined' && sourceBuffer.buffered !== null && sourceBuffer.buffered.length > 0) {
      const videoElement = this.videoElement;
      if (this.instantplayback && typeof videoElement !== 'undefined' && videoElement !== null) {
        const data = { channelId: this.channelId, errorCode: fromHex('0x1103'), currentTime: videoElement.currentTime };
        if (typeof this.eventInstantPlaybackCallback !== 'undefined' && this.eventInstantPlaybackCallback !== null) {
          this.eventInstantPlaybackCallback(data);
        }
      }

      const startTime = sourceBuffer.buffered.start(sourceBuffer.buffered.length - 1) * 1;
      const endTime = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1) * 1;
      const data = {
        channelId: this.channelId,
        errorCode: fromHex('0x1100'),
        timeline: {
          startTime,
          endTime,
          currentTime: (this.videoElement as HTMLVideoElement).currentTime,
          description: 'Instant playback mode start with timeline range.'
        }
      };
      if (typeof this.eventInstantPlaybackCallback !== 'undefined' && this.eventInstantPlaybackCallback !== null) {
        this.eventInstantPlaybackCallback(data);
      }
    }
  }

  private resetBaseDecodingTime(): void {
    this.baseAudioTime = -1;
    this.preAudioTimeStamp = null;
    if (this.playbackFlag) {
      this.baseVideoTime = 0;
    }
  }

  private onWaiting(): void {
    const videoElement = this.videoElement as HTMLVideoElement;
    let endTime: number | null = null;
    if (this.speedChanged) {
      const diff = videoElement.duration - videoElement.currentTime;
      if (diff > 1) {
        videoElement.currentTime = videoElement.duration;
      }
    }

    if (this.instantplayback) {
      const sourceBuffer = this.sourceBuffer as SourceBuffer;
      const startTime = sourceBuffer.buffered.start(sourceBuffer.buffered.length - 1) * 1;
      endTime = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1) * 1;

      const data = {
        channelId: this.channelId,
        errorCode: fromHex('0x1105'),
        currentTime: videoElement.currentTime,
        message: 'on waiting from instantplayback because of do not exist video data on this current time.'
      };
      if (typeof this.eventInstantPlaybackCallback !== 'undefined' && this.eventInstantPlaybackCallback !== null) {
        this.eventInstantPlaybackCallback(data);
      }
      void startTime;
    } else {
      if (this.playbackFlag) {
        const sourceBuffer = this.sourceBuffer as SourceBuffer;
        endTime = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1) * 1;

        if (
          (videoElement.currentTime < endTime - this.getMaxInstantPlayback() || (endTime !== 0 && videoElement.currentTime === 0)) &&
          endTime - this.defaultDelay > 0 &&
          this.userPaused === false &&
          this.localSpeedValue === 1
        ) {
          videoElement.currentTime = endTime - this.defaultDelay;
        } else {
          videoElement.currentTime = parseInt(String(videoElement.currentTime), 10);
          if (this.userPaused === false && videoElement.readyState >= 2) {
            if (!this.instantplayback) {
              this.videoPlay();
            }
          }
        }

        if (this.localSpeedValue === 1 && Math.abs(this.baseVideoTime - this.baseAudioTime) > 20000) {
          this.resetBaseDecodingTime();
        }
      } else {
        if (this.bufferedFrameCount < MAX_BUFFER_FRAME_COUNT) {
          this.bufferedFrameCount += 5;
        }
      }
    }
  }

  private onDurationChange(): void {
    this.videoUpdating();
  }

  private onLoadedData(): void {}

  private onProgress(_event: Event): void {}

  private onSeeking(_event: Event): void {
    const info = this.getBrowserInfo();
    if (info.os.indexOf('Mac') !== -1 && info.browser.indexOf('Safari') !== -1 && this.playmode === 'live' && !this.instantplayback) {
      this.onWaiting();
    }

    if (this.instantplayback) {
      const data = { channelId: this.channelId, errorCode: fromHex('0x1106'), currentTime: (this.videoElement as HTMLVideoElement).currentTime };
      if (typeof this.eventInstantPlaybackCallback !== 'undefined' && this.eventInstantPlaybackCallback !== null) {
        this.eventInstantPlaybackCallback(data);
      }
    }
  }

  private onSeeked(_event: Event): void {
    if (!this.instantplayback) {
      this.removeAllCues((this.videoElement as HTMLVideoElement).textTracks[this.timestampTextTrackId]);
      this.videoPlay();
    }
  }

  private onTimeUpdate(_event: Event): void {
    if (this.timerID !== null) {
      clearTimeout(this.timerID);
    }
    this.isStalling = false;
    this.timerID = setTimeout(() => this.reportStalling(), STALLING_TIMEOUT);

    if (this.captureFlag === true) {
      this.download(this.videoElement as HTMLVideoElement);
    }
  }

  private onStalled(): void {
    this.isStalling = true;
  }

  private reportStalling(): void {
    const videoElement = this.videoElement as HTMLVideoElement;
    if ((!videoElement.paused && !videoElement.ended) || this.isStalling) {
      this.videoPause();
    }
  }

  private onCanPlayThrough(_event: Event): void {}

  private onEmptied(): void {}

  private onAddTextTrack(event: TrackEvent): void {
    const track = event.track as (TextTrack & { name?: string }) | null;
    if (typeof track?.name !== 'undefined' && track.name === 'timestamp') {
      track.mode = 'hidden';
      track.oncuechange = this.makeOnCueChange();
    }
  }

  private onRemoveTextTrack(): void {}

  private updateVideoTimestamp(boxSamples: VideoSample[]): void {
    const length = boxSamples.length;
    const cueList: [number, number, string][] = [];
    for (let i = 0; i < length; i += 1) {
      let diff: number | null = null;
      if (i === 0 && this.preVideoTimeStamp) {
        diff = Math.abs((boxSamples[i].rtpTimestamp as number) - Number(this.preVideoTimeStamp.rtpTimestamp));
      } else if (i < length - 1) {
        diff = Math.abs((boxSamples[i + 1].rtpTimestamp as number) - (boxSamples[i].rtpTimestamp as number));
      } else if (this.videoSamples.length > 0) {
        diff = Math.abs((this.videoSamples[0].rtpTimestamp as number) - (boxSamples[i].rtpTimestamp as number));
      } else if (length > 1) {
        diff = Math.abs((boxSamples[i].rtpTimestamp as number) - (boxSamples[i - 1].rtpTimestamp as number));
      } else if (this.preVideoTimeStamp) {
        diff = Math.abs((boxSamples[i].rtpTimestamp as number) - Number(this.preVideoTimeStamp.rtpTimestamp));
      }
      boxSamples[i].frameDuration = (diff as number) * TEN;
    }

    for (let i = 0; i < length; i += 1) {
      if (!boxSamples[i].frameDuration) {
        boxSamples[i].frameDuration = Math.floor(500 / length) * TEN;
      } else if (boxSamples[i].frameDuration > MAX_PLAYBACK_DIFF * TEN) {
        boxSamples[i].frameDuration = boxSamples[i - 1] ? boxSamples[i - 1].frameDuration : boxSamples[i + 1] ? boxSamples[i + 1].frameDuration : Math.floor(500 / length) * TEN;
      }
      let startTime = this.baseVideoTime / TIME_SCALE;
      this.baseVideoTime += boxSamples[i].frameDuration;
      const endTime = this.baseVideoTime / TIME_SCALE;
      boxSamples[i].timeStamp.mode = 'playback';
      cueList.push([startTime, endTime, fastJsonStringfy(boxSamples[i].timeStamp)]);
      startTime = endTime;

      this.preVideoTimeStamp = boxSamples[i].timeStamp;
    }

    cueList.forEach((element) => {
      try {
        if (element[0] !== null && element[1] !== null && element[2] !== null) {
          const VTTCueCtor = (globalThis as unknown as { VTTCue: new (start: number, end: number, text: string) => VTTCue }).VTTCue;
          const cue = new VTTCueCtor(element[0], element[1], element[2]);
          cue.id = String((JSON.parse(element[2]) as TimestampData).rtpTimestamp);
          cue.onenter = this.makeOnCueEnter() as unknown as (this: TextTrackCue, ev: Event) => void;
          cue.onexit = this.makeOnCueExit() as unknown as (this: TextTrackCue, ev: Event) => void;
          (this.videoElement as HTMLVideoElement).textTracks[this.timestampTextTrackId].addCue(cue);
        }
      } catch {
        // legacy: videotag_log.error("error", error) only, no further effect.
      }
    });
  }

  private updateAudioTimestamp(boxSamples: AudioSample[]): void {
    const length = boxSamples.length;
    for (let i = 0; i < length; i += 1) {
      this.baseAudioTime += boxSamples[i].duration as number;
      boxSamples[i].timeStamp.mode = 'playback';
      this.preAudioTimeStamp = boxSamples[i].timeStamp;
    }
  }

  private setNalLength(index: number, size: number, array: Uint8Array): void {
    array[index + 0] = (size & 0xff000000) >> 24;
    array[index + 1] = (size & 0xff0000) >> 16;
    array[index + 2] = (size & 0xff00) >> 8;
    array[index + 3] = size & 0xff;
  }

  private createSampleFrameData(frameData: Uint8Array): Uint8Array {
    const length = frameData.byteLength;
    let nalUnitIndex = 0;
    let i = 0;

    while (i + 4 < length) {
      if (frameData[i + 0] === 0x00 && frameData[i + 1] === 0x00 && frameData[i + 2] === 0x00 && frameData[i + 3] === 0x01) {
        if (i > 0) {
          this.setNalLength(nalUnitIndex, i - nalUnitIndex - this.prefixSize, frameData);
        }
        nalUnitIndex = i;
        i += this.prefixSize;
      } else {
        i += 1;
      }
    }

    this.setNalLength(nalUnitIndex, length - nalUnitIndex - this.prefixSize, frameData);

    return new Uint8Array(frameData);
  }

  private initBaseNTPTimestamp(videoTimestamp: TimestampData): void {
    this.baseAudioTime = 0;
    this.baseVideoTime = 0;
    this.baseNTPTimestamp = videoTimestamp.utcTimeStamp
      ? videoTimestamp.utcTimeStamp
      : (videoTimestamp.timestamp as number) * 1000 + (videoTimestamp.timestamp_usec as number);
  }

  private initBaseAudioTime(audioTimestamp: TimestampData): boolean {
    if (!this.baseVideoTime) {
      this.baseVideoTime = this.receiveTimeStamp.utcTimeStamp
        ? (this.receiveTimeStamp.utcTimeStamp - this.baseNTPTimestamp) * 10
        : ((this.receiveTimeStamp.timestamp as number) * 1000 +
            (this.receiveTimeStamp.timestamp_usec as number) -
            ((this.receiveTimeStamp.timestamp as number) * 1000 + (this.receiveTimeStamp.timestamp_usec as number) - this.baseNTPTimestamp < 0
              ? (this.baseNTPTimestamp = (this.receiveTimeStamp.timestamp as number) * 1000 + (this.receiveTimeStamp.timestamp_usec as number))
              : this.baseNTPTimestamp)) *
            10;
    }
    this.baseAudioTime = audioTimestamp.utcTimeStamp
      ? (audioTimestamp.utcTimeStamp - this.baseNTPTimestamp) * 10
      : audioTimestamp.timestamp === 0 && audioTimestamp.timestamp_usec === 0
        ? this.baseVideoTime
        : ((audioTimestamp.timestamp as number) * 1000 + (audioTimestamp.timestamp_usec as number) - this.baseNTPTimestamp) * 10;

    if (this.baseAudioTime !== -1) {
      return false;
    }
    return true;
  }

  private checkAudioTimestamp(audioTimestamp: TimestampData): boolean {
    return this.baseAudioTime >= 0 ? true : this.initBaseAudioTime(audioTimestamp);
  }

  private getVideoFrameDuration(streamData: VideoStreamData, videoInfo: VideoInfo, preFrameData: FrameDurationResult | null): FrameDurationResult {
    let frameDuration = 0;
    if (preFrameData === null) {
      return { streamData, videoInfo, frameDuration };
    }

    let preVideoFrameTimeStamp = Number(preFrameData.streamData.timeStamp.rtpTimestamp);
    let curVideoFrameTimeStamp = Number(streamData.timeStamp.rtpTimestamp);
    if (curVideoFrameTimeStamp - preVideoFrameTimeStamp < 0) {
      if (this.rfps === 0) {
        this.rfps = 1;
      }
      preVideoFrameTimeStamp = curVideoFrameTimeStamp - parseInt((1000 / (this.rfps as number)).toFixed(0), 10);
    }

    if (this.bVideoUnstableTimestamp && this.rfps !== 0) {
      const tempTimestamp = parseInt(String(preFrameData.streamData.timeStamp.rtpTimestamp), 10);
      (streamData.timeStamp as unknown as { rtpTimestamp: number }).rtpTimestamp = tempTimestamp + parseInt((1000 / (this.rfps as number)).toFixed(0), 10);
      this.networkWeight = 2.0;
    }

    if (curVideoFrameTimeStamp - preVideoFrameTimeStamp === 0) {
      (this.errorCallback as VideoPlayerErrorCallback)({
        errorCode: fromHex('0x0106'),
        description:
          `channel: ${this.channelId}, You should be check the rtp timestamp of your device. ` +
          `The rtp timestamp could not be same value between current frame and previous frame. ` +
          `previous rtp timestamp: ${preVideoFrameTimeStamp}current rtp timestamp: ${curVideoFrameTimeStamp}interval: ${curVideoFrameTimeStamp - preVideoFrameTimeStamp}`,
        place: 'VideoTagPlayer.ts:getVideoFrameDuration',
        channelId: this.channelId
      });
      this.bVideoUnstableTimestamp = true;
    }

    this.videoTimestampIntervalQueue.enQueue(curVideoFrameTimeStamp - preVideoFrameTimeStamp);

    if (typeof this.eventStatisticsCallback !== 'undefined' && this.eventStatisticsCallback !== null) {
      const samples = this.videoTimestampIntervalQueue.toArray() as number[];
      const data = {
        type: 'timestamp',
        channelId: this.channelId,
        queue_size: `00${this.videoTimestampIntervalQueue.getLength()}`.slice(-2),
        queue_data: samples,
        current_timestamp: curVideoFrameTimeStamp,
        previous_timestamp: preVideoFrameTimeStamp,
        mean_duration: parseInt(String(Median.mean(samples)), 10),
        timestamp_interval: curVideoFrameTimeStamp - preVideoFrameTimeStamp,
        timestamp_mean: Median.mean(samples).toFixed(2),
        timestamp_median: Median.median(samples).toFixed(3),
        timestamp_variance: (Median.variance(samples) / VIDEO_MAX_TIMESTAMP_QUEUE).toFixed(3),
        cofficient_of_range: Median.findRangeAndCoefficient(samples).toFixed(4)
      };
      this.eventStatisticsCallback(data);
    }

    if (
      this.videoTimestampIntervalQueue.getLength() >= VIDEO_MAX_TIMESTAMP_QUEUE &&
      Median.variance(this.videoTimestampIntervalQueue.toArray() as number[]) / VIDEO_MAX_TIMESTAMP_QUEUE > VIDEO_MAX_VARIANCE_VALUE
    ) {
      const samples = this.videoTimestampIntervalQueue.toArray() as number[];
      const meanDuration = parseInt(String(Median.mean(samples)), 10);
      curVideoFrameTimeStamp = parseInt(String(preFrameData.streamData.timeStamp.rtpTimestamp), 10) + meanDuration;
    }

    if (this.localSpeedValue === 1) {
      frameDuration = Math.abs(curVideoFrameTimeStamp - preVideoFrameTimeStamp) * TEN;
    } else if (this.localSpeedValue > 1) {
      frameDuration = TIME_SCALE / Math.abs(this.localSpeedValue);
    } else {
      frameDuration = Math.abs(curVideoFrameTimeStamp - preVideoFrameTimeStamp) * TEN;
    }

    const frameDurationCheckTime = 10000;
    if (frameDuration > frameDurationCheckTime) {
      frameDuration = frameDurationCheckTime;
    }

    this.delay = this.defaultDelay + (frameDuration / 10000) * this.bufferedFrameCount * this.networkWeight;

    return { streamData, videoInfo, frameDuration };
  }

  // NOTE: legacy also defines a symmetric `getAudioFrameDuration` function
  // right after this one — grep-confirmed it has zero call sites anywhere in
  // videoTagPlayer.js (createAudioSample computes audio sample duration
  // inline via `preAudioTimeStamp` instead). Confirmed 100% dead code,
  // dropped rather than ported as unreachable weight.

  private createVideoSample(streamData: VideoStreamData, videoInfo: VideoInfo): void {
    const sample: VideoSample = {
      size: streamData.frameData.byteLength,
      frameData: this.createSampleFrameData(streamData.frameData),
      frameInfo: videoInfo,
      timeStamp: streamData.timeStamp as TimestampData,
      frameDuration: 0
    };

    if (this.playbackFlag) {
      sample.rtpTimestamp = parseInt(String(sample.timeStamp.rtpTimestamp), 10);
      this.videoSamples.push(sample);
      if (videoInfo.frameType === 'I') {
        if (this.videoSamples.length > 1) {
          if (this.dummyAudio) {
            this.makeDummyAudio((this.videoSamples[this.videoSamples.length - 1].rtpTimestamp! - this.videoSamples[0].rtpTimestamp!) * 10);
          } else {
            this.audioTime = 0;
          }
          this.createSegment(this.videoSamples.length - 1);
        }
        this.createVideoSegmentTimeout = setTimeout(() => this.createSegment(), MAX_PLAYBACK_DIFF);
      }
    } else {
      this.preVideoFrameData = this.getVideoFrameDuration(streamData, videoInfo, this.preVideoFrameData);
      sample.frameDuration = this.preVideoFrameData.frameDuration;
      if (this.dummyAudio) {
        this.makeDummyAudio(sample.frameDuration);
      } else {
        this.audioTime = 0;
      }
      this.videoSamples.push(sample);

      if (this.videoSamples.length >= this.boxsize) {
        this.createVideoSegment(this.boxsize);
      }
    }
  }

  private makeDummyAudio(updateDuration: number): void {
    let tempTime = 0;
    if (updateDuration < 0 || updateDuration > 100000) {
      for (let i = 0; i < this.videoSamples.length - 1; i++) {
        const cur = this.videoSamples[i].rtpTimestamp as number;
        const next = this.videoSamples[i + 1]?.rtpTimestamp;
        const nextNext = this.videoSamples[i + 2]?.rtpTimestamp;
        const prev = this.videoSamples[i - 1]?.rtpTimestamp;
        if (typeof next === 'number' && next - cur >= 0 && next - cur < 100000) {
          tempTime += next - cur;
        } else if (this.videoSamples[i + 2] && typeof nextNext === 'number' && typeof next === 'number' && nextNext - next >= 0 && nextNext - next < 100000) {
          tempTime += nextNext - next;
        } else if (this.videoSamples[i - 1] && typeof prev === 'number' && cur - prev >= 0 && cur - prev < 100000) {
          tempTime += cur - prev;
        }
      }

      if (tempTime <= 0 || tempTime > 10000) {
        return;
      }
    }

    this.audioTime += tempTime ? tempTime * 10 : updateDuration;

    while (this.audioTime >= this.audioInfo.samplingDuration) {
      const dummyData: AudioStreamData = {
        codecType: 'AAC',
        frameData: new Uint8Array([0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c]),
        timeStamp: { timestamp: 0, timestamp_usec: 0, timezone: 0, utcTimeStamp: 0 }
      };
      this.createAudioSample(dummyData, this.audioInfo as unknown as AudioInfo, 'AAC');

      this.audioTime -= this.audioInfo.samplingDuration;
    }
  }

  private createAudioSample(streamData: AudioStreamData, audioinfo: AudioInfo, chunkCodec: string): void {
    if (chunkCodec === 'G711' || chunkCodec === 'G726') {
      (this.audiotranscoderWorker as Worker).postMessage({ type: 'transcode', data: streamData });
      return;
    }

    if (!this.checkAudioTimestamp(streamData.timeStamp as TimestampData)) return;

    const sample: AudioSample = {
      size: streamData.frameData.byteLength,
      frameData: streamData.frameData,
      frameInfo: audioinfo,
      timeStamp: streamData.timeStamp as TimestampData,
      // Live mode's else branch below only computes a duration once a
      // *previous* sample exists to diff against — the very first audio
      // sample queued after (re)init never takes that branch and used to be
      // flushed by createAudioSegment(1) on the *next* call with duration
      // still unset. An MP4 sample with duration 0 makes Chrome's MSE audio
      // decoder fail (PipelineStatus::PIPELINE_ERROR_DECODE), which sets the
      // <video> element's error and makes every appendBuffer() after it
      // throw InvalidStateError — surfacing as playback dying right after
      // the first frame. Seed a sane fallback here so that first sample is
      // never left without one; the delta-based calculation below still
      // overwrites it with a more precise value once a previous timestamp
      // is available.
      duration: this.audioInfo.samplingDuration
    };

    this.audioSamples.push(sample);

    if (this.playbackFlag) {
      sample.duration = this.audioInfo.samplingDuration;
      sample.rtpTimestamp = parseInt(String(sample.timeStamp.rtpTimestamp), 10);
    } else {
      if (this.audioSamples.length >= 1 && this.preAudioTimeStamp) {
        if (typeof sample.timeStamp.rtpTimestamp !== 'undefined' && typeof this.preAudioTimeStamp.rtpTimestamp !== 'undefined') {
          sample.duration = (Number(sample.timeStamp.rtpTimestamp) - Number(this.preAudioTimeStamp.rtpTimestamp)) * TEN;
        }
        if (!sample.duration || sample.duration <= 0) {
          sample.duration = this.audioInfo.samplingDuration;
        }
        this.createAudioSegment(1);
      }
      this.preAudioTimeStamp = streamData.timeStamp as TimestampData;
    }
  }

  private createInitSegment(): void {
    this.segmentArray.unshift(initSegment([this.videoInfoBox as Mp4VideoTrackInfo, this.audioInfo]));
    this.appendSegmentToSourceBuffer();
  }

  private createFrameDataBuffer(samples: (VideoSample | AudioSample)[]): Uint8Array {
    if (samples.length === 1) {
      return samples[0].frameData;
    }

    const bufferSize = samples.reduce((acc, sample) => acc + sample.size, 0);
    const buffer = new Uint8Array(bufferSize);
    let bufferIndex = 0;
    samples.forEach((sample) => {
      buffer.set(sample.frameData, bufferIndex);
      bufferIndex += sample.size;
    });
    return buffer;
  }

  private createVideoSegment(boxSize?: number): void {
    if (this.createVideoSegmentTimeout) {
      clearTimeout(this.createVideoSegmentTimeout);
      this.createVideoSegmentTimeout = null;
    }

    const samples = boxSize ? this.videoSamples.splice(0, boxSize) : this.videoSamples.splice(0);
    const boxInfo: Mp4BoxInfo = { id: 1, samples: samples as unknown as Mp4Sample[], baseMediaDecodeTime: this.baseVideoTime, type: 'video' };
    const frameDataBuffer = this.createFrameDataBuffer(samples);
    this.boxStartTime.push(boxInfo.baseMediaDecodeTime / TIME_SCALE);
    this.lastBoxSize = samples.length;

    if (this.playbackFlag) {
      this.updateVideoTimestamp(samples);
    } else {
      samples.forEach((sample, index) => {
        if (sample.frameDuration === 0 && index + 1 < samples.length && typeof samples[index + 1].frameDuration !== 'undefined') {
          sample.frameDuration = samples[index + 1].frameDuration;
        }
        const timestampTrack = (this.videoElement as HTMLVideoElement).textTracks[this.timestampTextTrackId];
        const startTime = boxInfo.baseMediaDecodeTime / TIME_SCALE;
        this.baseVideoTime += sample.frameDuration;
        const endTime = this.baseVideoTime / TIME_SCALE;
        sample.timeStamp.mode = 'live';

        const VTTCueCtor = (globalThis as unknown as { VTTCue: new (start: number, end: number, text: string) => VTTCue }).VTTCue;
        const cue = new VTTCueCtor(startTime, endTime, fastJsonStringfy(sample.timeStamp));
        cue.id = String(sample.timeStamp.rtpTimestamp);
        cue.onenter = this.makeOnCueEnter() as unknown as (this: TextTrackCue, ev: Event) => void;
        cue.onexit = this.makeOnCueExit() as unknown as (this: TextTrackCue, ev: Event) => void;
        timestampTrack.addCue(cue);
      });
    }

    this.segmentArray.push(mediaSegment(this.sequenseNum, [boxInfo], frameDataBuffer));
    this.sequenseNum++;

    this.appendSegmentToSourceBuffer();
  }

  private createAudioSegment(boxSize?: number): void {
    if (this.createAudioSegmentTimeout) {
      clearTimeout(this.createAudioSegmentTimeout);
      this.createAudioSegmentTimeout = null;
    }

    const samples = boxSize ? this.audioSamples.splice(0, boxSize) : this.audioSamples.splice(0);
    const boxInfo: Mp4BoxInfo = { id: 2, samples: samples as unknown as Mp4Sample[], baseMediaDecodeTime: this.baseAudioTime, type: 'audio' };
    const frameDataBuffer = this.createFrameDataBuffer(samples);

    if (this.playbackFlag) {
      this.updateAudioTimestamp(samples);
    } else {
      samples.forEach((sample) => {
        if (!sample.duration) return;
        this.baseAudioTime += sample.duration;
      });
    }

    this.segmentArray.push(mediaSegment(this.sequenseNum, [boxInfo], frameDataBuffer));
    this.sequenseNum++;

    this.appendSegmentToSourceBuffer();
  }

  private createSegment(boxSize?: number): void {
    if (this.createVideoSegmentTimeout) {
      clearTimeout(this.createVideoSegmentTimeout);
      this.createVideoSegmentTimeout = null;
    }

    if (this.videoSamples.length === 0 || this.audioSamples.length === 0) return;

    const videoSamples = boxSize ? this.videoSamples.splice(0, boxSize) : this.videoSamples.splice(0);
    const videoBoxInfo: Mp4BoxInfo = { id: 1, samples: videoSamples as unknown as Mp4Sample[], baseMediaDecodeTime: this.baseVideoTime, type: 'video' };
    const audioSamples = this.audioSamples.splice(0, this.audioSamples.length);
    const audioBoxInfo: Mp4BoxInfo = {
      id: 2,
      samples: audioSamples as unknown as Mp4Sample[],
      baseMediaDecodeTime: this.baseAudioTime,
      type: 'audio',
      defaultSampleDuration: this.audioInfo.samplingDuration
    };
    const videoFrameDataBuffer = this.createFrameDataBuffer(videoSamples);
    const audioFrameDataBuffer = this.createFrameDataBuffer(audioSamples);
    this.boxStartTime.push(videoBoxInfo.baseMediaDecodeTime / TIME_SCALE);
    this.lastBoxSize = videoSamples.length;

    if (this.playbackFlag) {
      this.updateVideoTimestamp(videoSamples);
      this.updateAudioTimestamp(audioSamples);
    } else {
      this.baseVideoTime = videoBoxInfo.baseMediaDecodeTime;
      videoSamples.forEach((sample) => {
        const timestampTrack = (this.videoElement as HTMLVideoElement).textTracks[this.timestampTextTrackId];
        const startTime = this.baseVideoTime / TIME_SCALE;
        this.baseVideoTime += sample.frameDuration;
        const endTime = this.baseVideoTime / TIME_SCALE;
        sample.timeStamp.mode = 'live';

        const VTTCueCtor = (globalThis as unknown as { VTTCue: new (start: number, end: number, text: string) => VTTCue }).VTTCue;
        const cue = new VTTCueCtor(startTime, endTime, fastJsonStringfy(sample.timeStamp));
        cue.id = String(sample.timeStamp.rtpTimestamp);
        cue.onenter = this.makeOnCueEnter() as unknown as (this: TextTrackCue, ev: Event) => void;
        cue.onexit = this.makeOnCueExit() as unknown as (this: TextTrackCue, ev: Event) => void;
        timestampTrack.addCue(cue);
      });

      this.baseAudioTime = audioBoxInfo.baseMediaDecodeTime;
      audioSamples.forEach((sample) => {
        if (!sample.duration) return;
        this.baseAudioTime += sample.duration;
      });
    }

    this.segmentArray.push(dualTrackMediaSegment(this.sequenseNum, [videoBoxInfo, audioBoxInfo], [videoFrameDataBuffer, audioFrameDataBuffer]));
    this.sequenseNum++;

    this.appendSegmentToSourceBuffer();
  }

  private appendSegmentToSourceBuffer(): void {
    if (this.sourceBuffer === null || this.sourceBuffer.updating) {
      return;
    }

    if (this.segmentArray.length === 0) {
      if (this.videoSamples.length === 0 && this.mediaSource && (this.mediaSource as unknown as { willEnd?: boolean }).willEnd) {
        this.mediaSource.endOfStream();
      }
      return;
    }

    const segment = this.segmentArray.shift();

    if (segment) {
      try {
        this.sourceBuffer.appendBuffer(segment as Uint8Array<ArrayBuffer>);
      } catch (error) {
        throw new RTSPOverWebSocketError({
          channelId: this.channelId,
          errorCode: fromHex('0x030A'),
          place: 'VideoTagPlayer.ts:appendSegmentToSourceBuffer',
          message: `Fail to append frame buffer to source buffer from videoTagPlayer. [${(error as { code?: number }).code}, message${(error as Error).message}]`
        });
      }
    } else {
      (this.mediaSource as MediaSource).endOfStream('network');
    }
  }

  private setSourceBuffer(): void {
    const mediaSource = this.mediaSource as MediaSource;
    if (mediaSource.sourceBuffers.length === 0) {
      mediaSource.duration = 0;

      try {
        const mimeCodec = `video/mp4;codecs="${this.videoCodecInfo}, mp4a.40.2"`;
        if (MediaSource.isTypeSupported(mimeCodec)) {
          this.sourceBuffer = mediaSource.addSourceBuffer(mimeCodec);
        }
      } catch (error) {
        throw new RTSPOverWebSocketError({
          channelId: this.channelId,
          errorCode: (error as { code?: number }).code,
          place: 'VideoTagPlayer.ts:setSourceBuffer',
          message: (error as Error).message
        });
      }

      this.addBufferEventListener();
    }
  }

  private readonly sourceOpen = (): void => {
    this.addSourceBuffer();
    this.appendSegmentToSourceBuffer();
  };

  private addSourceBuffer(): void {
    const mediaSource = this.mediaSource as MediaSource;
    try {
      if (this.sourceBuffer !== null) {
        mediaSource.removeSourceBuffer(this.sourceBuffer);
        for (const type of this.bufferEventListenerArray as string[]) {
          this.sourceBuffer.removeEventListener(type, this.sourceBufferEventListener);
        }
        this.sourceBuffer = null;
      }

      const mimeCodec = `video/mp4;codecs="${this.videoCodecInfo}, mp4a.40.2"`;
      if (MediaSource.isTypeSupported(mimeCodec)) {
        this.sourceBuffer = mediaSource.addSourceBuffer(mimeCodec);
      }

      mediaSource.removeEventListener('sourceopen', this.sourceOpen);
    } catch (error) {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: (error as { code?: number }).code,
        place: 'VideoTagPlayer.ts:addSourceBuffer',
        message: (error as Error).message
      });
    }

    this.addBufferEventListener();
  }

  // NOTE: legacy also declares `changeSourceBuffer()` — grep-confirmed its
  // only "call site" is commented out (`// changeSourceBuffer();` in
  // onVideoData). Confirmed 100% dead code, dropped.

  private videoPlay(): void {
    try {
      const videoElement = this.videoElement;
      if (videoElement && videoElement.paused) {
        if (this.playbackFlag && (this.sourceBuffer as SourceBuffer).buffered.length > 0) {
          const sourceBuffer = this.sourceBuffer as SourceBuffer;
          const startTime = sourceBuffer.buffered.start(sourceBuffer.buffered.length - 1) * 1;
          const endTime = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1) * 1;
          const latency = videoElement.currentTime === 0 ? endTime - startTime : endTime - videoElement.currentTime;

          if (this.localSpeedValue === 1 && latency < PLAYBACK_BUFFERING_TIME) {
            return;
          }
        }

        this.videoTagPromise = videoElement.play();
        if (typeof this.videoTagPromise !== 'undefined') {
          this.videoTagPromise.then(() => {}).catch(() => {});
        }
      }
    } catch {
      // legacy: videotag_log.error(error) only, no further effect.
    }
  }

  private videoPause(): void {
    try {
      const videoElement = this.videoElement;
      if (videoElement && videoElement.paused === false) {
        videoElement.pause();
      }
    } catch {
      // legacy: videotag_log.error(error) only, no further effect.
    }
  }

  private checkBufferSize(): void {
    try {
      const sourceBuffer = this.sourceBuffer as SourceBuffer;
      const startTime = sourceBuffer.buffered.start(sourceBuffer.buffered.length - 1) * 1;
      const endTime = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1) * 1;

      if (Math.abs(endTime - startTime) > this.getMaxInstantPlayback()) {
        if (!sourceBuffer.updating) {
          if (this.boxsize !== 1) {
            sourceBuffer.remove(0, Math.abs(Math.min(endTime, (this.videoElement as HTMLVideoElement).currentTime) - this.getMaxInstantPlayback()));
          } else {
            if (Math.abs(Math.min(endTime, (this.videoElement as HTMLVideoElement).currentTime) - this.getMaxInstantPlayback()) - 60 > 0) {
              sourceBuffer.remove(0, Math.abs(Math.min(endTime, (this.videoElement as HTMLVideoElement).currentTime) - this.getMaxInstantPlayback()) - 60);
            }
          }
        }
      }
    } catch {
      // legacy: videotag_log.error(...) only, no further effect.
    }
  }

  private videoUpdating(): void {
    try {
      if (this.mediaSource === null || !this.sourceBuffer || typeof this.sourceBuffer.buffered === 'undefined') {
        return;
      }

      if (this.sourceBuffer.buffered.length > 0) {
        const sourceBuffer = this.sourceBuffer;
        const videoElement = this.videoElement as HTMLVideoElement;
        const startTime = sourceBuffer.buffered.start(sourceBuffer.buffered.length - 1) * 1;
        const endTime = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1) * 1;
        const info = this.getBrowserInfo();

        if (this.playbackFlag) {
          if (this.prevBoxsize !== this.boxsize && this.boxsize === 1 && this.deviceType === 'camera') {
            if (sourceBuffer.buffered.length > 0) {
              videoElement.currentTime = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1) * 1;
            }
          }
          if (info.browser === 'Safari' && videoElement.currentTime < startTime) {
            videoElement.currentTime = endTime;
          }
          if (this.userPaused === false && videoElement.paused) {
            this.videoPlay();
          }
          this.prevBoxsize = this.boxsize;
          this.checkBufferSize();
          return;
        }

        let tempCurrentTime: number;

        const latency = videoElement.currentTime === 0 ? endTime - startTime : endTime - videoElement.currentTime;
        if (latency > this.delay) {
          tempCurrentTime = endTime - this.defaultDelay;
          if (tempCurrentTime > startTime && tempCurrentTime < endTime) {
            if (!(info.browser === 'Safari' && parseInt(info.browserVersion, 10) >= 14)) {
              videoElement.currentTime = tempCurrentTime;
            }
            if (videoElement.paused) {
              this.videoPlay();
            }
          }
          if (this.deviceType === 'nvr' && this.bufferedFrameCount < MAX_BUFFER_FRAME_COUNT) {
            this.bufferedFrameCount += 5;
          }
        } else {
          const defaultFrameBufferCount =
            info.os.indexOf('Windows') !== -1 && info.osVersion !== '7' && (info.browser.indexOf('Chrome') !== -1 || info.browser.indexOf('Chromium') !== -1)
              ? CHROME_DEFAULT_FRAME_BUFFER_COUNT
              : info.os.indexOf('Mac') !== -1 && info.browser.indexOf('Safari') !== -1
                ? SAFARI_DEFAULT_FRAME_BUFFER_COUNT
                : OTHER_DEFAULT_FRAME_BUFFER_COUNT;
          const defaultDelayTime =
            info.os.indexOf('Windows') !== -1 && info.osVersion !== '7' && (info.browser.indexOf('Chrome') !== -1 || info.browser.indexOf('Chromium') !== -1)
              ? CHROME_DEFAULT_DELAY_TIME
              : info.os.indexOf('Mac') !== -1 && info.browser.indexOf('Safari') !== -1
                ? SAFARI_DEFAULT_DELAY_TIME
                : OTHER_DEFAULT_DELAY_TIME;

          if (latency < defaultDelayTime && this.bufferedFrameCount > defaultFrameBufferCount) {
            this.bufferedFrameCount -= 1;
          }
        }

        if (this.prevBoxsize !== this.boxsize) {
          this.prevBoxsize = this.boxsize;
          tempCurrentTime = endTime - this.delay;
          if (tempCurrentTime > startTime && tempCurrentTime < endTime) {
            if (videoElement.paused) {
              this.videoPlay();
            }
          }
        }

        if (info.browser === 'Safari' && this.boxsize === 1) {
          if (this.userPaused === false && videoElement.paused) {
            this.videoPlay();
          }
        }

        if (!this.instantplayback) {
          this.checkBufferSize();
        }
      }
    } catch {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: fromHex('0x0900'),
        place: 'VideoTagPlayer.ts:videoUpdating',
        message: 'fail to detect the video tag element.'
      });
    }
  }

  // NOTE: legacy's convertTimeString has an `if (moment) {...} else { manual
  // pad()-based YYYYMMDDHHmmss formatting }` fallback for when the moment.js
  // CDN script isn't loaded — moment-timezone is now a real bundled
  // dependency (always available), so that fallback (and the `pad()` helper
  // it alone used) is unreachable here and has been dropped.
  private convertTimeString(seconds: number): string {
    return moment(seconds * 1000).format('YYYYMMDDHHmmss');
  }

  private checkPlaybackEnd(streamTimeStamp: TimestampData): void {
    if (
      this.receiveTimeStamp.timestamp === streamTimeStamp.timestamp ||
      !this.requestTime ||
      !this.requestTime.endTime ||
      typeof streamTimeStamp.timezone === 'undefined' ||
      streamTimeStamp.timezone === null
    ) {
      return;
    }

    const seconds = (streamTimeStamp.timestamp as number) + streamTimeStamp.timezone * 60;
    const timeString = this.convertTimeString(seconds);

    if (timeString >= (this.requestTime.endTime as string)) {
      setTimeout(() => {
        if (this.mediaSource) {
          (this.mediaSource as unknown as { willEnd?: boolean }).willEnd = true;
        }
      }, MAX_PLAYBACK_DIFF);
    }
  }

  private download(videoElem: HTMLVideoElement): void {
    const canvas = document.createElement('canvas');
    canvas.width = videoElem.videoWidth;
    canvas.height = videoElem.videoHeight;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    try {
      ctx.restore();
      ctx.save();
      ctx.drawImage(videoElem, 0, 0, canvas.width, canvas.height);
    } catch {
      // legacy: console.error(e) only, no further effect.
    }

    this.captureFlag = false;
    canvas.toBlob((blob) => {
      if (this.fileName !== null && this.fileName !== undefined) {
        saveAs(blob as Blob, this.fileName + '.png');
      } else {
        if (this.eventCaptureCallback !== null && this.eventCaptureCallback !== undefined) {
          this.eventCaptureCallback({ channelId: this.channelId, blob });
        } else {
          throw new RTSPOverWebSocketError({
            channelId: this.channelId,
            errorCode: fromHex('0x0909'),
            place: 'VideoTagPlayer.ts:1887',
            message: 'can not return capture blob'
          });
        }
      }
    });
  }

  private audiotranscoderWorkerMessage(event: MessageEvent<AudioTranscoderMessage>): void {
    const message = event.data;
    switch (message.type) {
      case 'transcoded':
        if (!this.realAacActive) {
          this.createAudioSample(message.data as unknown as AudioStreamData, this.audioInfo as unknown as AudioInfo, 'AAC');
        }
        break;
      case 'terminated':
        if (this.audiotranscoderWorker !== null && typeof this.audiotranscoderWorker !== 'undefined') {
          this.audiotranscoderWorker.terminate();
          this.audiotranscoderWorker = null;
        }
        break;
      default:
        throw new RTSPOverWebSocketError({
          channelId: this.channelId,
          errorCode: fromHex('0x0905'),
          place: 'VideoTagPlayer.ts:audiotranscoderWorkerMessage',
          message: 'The audiotranscoderWorker returned unknown data'
        });
    }
  }

  override init(element: HTMLVideoElement): void {
    window.addEventListener('beforeunload', (event: Event) => {
      event.preventDefault();
      if (this.sourceBuffer !== null && !this.sourceBuffer.updating && this.sourceBuffer.buffered.length > 0 && this.mediaSource?.readyState === 'open') {
        this.mediaSource.endOfStream();
      }
      this.close();
    });

    this.background_img = './base/images/loading.svg';
    const jQueryWindow = (globalThis as unknown as { window?: { jQuery?: unknown; $?: (selector: string) => { length: number } } }).window;
    if (jQueryWindow?.jQuery) {
      const $ = jQueryWindow.$ as (selector: string) => { length: number };
      if ($('channel_player.full-screen').length || $('#channellist-containner').length) {
        this.background_img = './base/images/loading_b.svg';
      }
    }

    this.videoElement = element;

    this.elementSetting();
    this.createMediaSource();
    this.instantplayback = false;
  }

  override onVideoData(playMode: string, streamData: VideoStreamData, videoInfo: VideoInfo): void {
    this.codec = streamData.codecType;
    this.videoSize = (videoInfo.width as number) * (videoInfo.height as number);
    if (this.mediaSource !== null && this.mediaSource.readyState !== 'ended') {
      if (playMode === 'Playback') {
        this.playbackFlag = true;
        if (this.deviceType === 'camera') {
          this.checkPlaybackEnd(streamData.timeStamp as TimestampData);
        }
      }

      if (this.videoCodecInfo === null && videoInfo.frameType === 'I') {
        this.videoCodecInfo = videoInfo.codecInfo as string;
        this.setVideoInfo(videoInfo, streamData.codecType);
        this.initBaseNTPTimestamp(streamData.timeStamp as TimestampData);
        this.createInitSegment();
      }
      this.receiveTimeStamp = streamData.timeStamp as TimestampData;
      this.createVideoSample(streamData, videoInfo);

      if (this.minimapInfo.isUpdate && this.minimapInfo.element) {
        this.minimapInfo.element.getContext('2d')?.drawImage(this.videoElement as HTMLVideoElement, 0, 0, this.minimapInfo.element.width, this.minimapInfo.element.height);
        this.minimapInfo.isUpdate = false;
      }
    }
  }

  // `playMode` is accepted (matching onVideoData's signature) but never
  // actually read in legacy's own onAudioData body either.
  onAudioData(_playMode: string, streamData: AudioStreamData, audioInfo: AudioInfo): void {
    this.codec = streamData.codecType;
    if (this.mediaSource !== null && this.mediaSource.readyState !== 'ended') {
      if (this.dummyAudio && this.localSpeedValue === 1) {
        this.dummyAudio = false;
      }
      if (this.audioCodecInfo.codecType !== streamData.codecType || this.audioCodecInfo.bitrate !== audioInfo.bitrate) {
        this.setAudioInfo({
          codecMime: streamData.codecMime,
          codecType: streamData.codecType,
          bitrate: audioInfo.bitrate as number,
          interleavedId: streamData.interleaved as number,
          channelCount: audioInfo.channelCount,
          samplingFrequencyIndex: audioInfo.samplingFrequencyIndex,
          sampleRate: audioInfo.sampleRate
        });
      }
      this.createAudioSample(streamData, audioInfo, streamData.codecType);
    }
  }

  override onWaitingPackets(event: WaitingEvent): void {
    if (this.audioInfo.interleavedId === event.interleavedId) {
      if (event.media === 'audio') {
        this.dummyAudio = event.islost;
      }
    }
  }

  capture(fileName: string): void {
    this.fileName = fileName;
    if ((this.videoElement as HTMLVideoElement).paused) {
      this.download(this.videoElement as HTMLVideoElement);
    } else {
      this.captureFlag = true;
    }
  }

  setTimeStampCallback(func: (timeStamp: unknown) => void): void {
    this.timeStampCallback = func;
  }

  // legacy stores this callback but every call site that would invoke it is
  // commented out (see the field-removal NOTE above) — kept as a public
  // no-op so external callers matching the CanvasTagPlayer API shape can
  // still call it without error.
  setResizeCallback(_func: (info: unknown) => void): void {}

  setRequestTime(data: { endTime?: string }): void {
    this.requestTime = data;
  }

  override updateMiniMapInfo(data: { mode: string; target?: MinimapInfo['element'] }): void {
    const command = data.mode;
    if (this.minimapInfo.element === null && typeof data.target !== 'undefined') {
      this.minimapInfo.element = data.target as MinimapInfo['element'];
    }
    if (command === 'on') {
      this.minimapInfo.element = data.target as MinimapInfo['element'];
    } else if (command === 'draw') {
      this.minimapInfo.isUpdate = true;
    } else {
      this.minimapInfo = { isUpdate: false, element: null };
    }
  }

  override play(): void {
    this.userPaused = false;
    if (this.instantplayback && this.sourceBuffer !== null && !this.sourceBuffer.updating && this.sourceBuffer.buffered.length > 0 && this.mediaSource?.readyState === 'open') {
      this.mediaSource.endOfStream();
    }

    this.videoTagPromise = (this.videoElement as HTMLVideoElement).play();
    if (typeof this.videoTagPromise !== 'undefined') {
      this.videoTagPromise
        .then(() => {
          (this.videoElement as HTMLVideoElement).play();
        })
        .catch(() => {
          (this.videoElement as HTMLVideoElement).pause();
        });
    }
  }

  override pause(): void {
    this.userPaused = true;
    if (this.videoElement && !this.videoElement.paused) {
      this.videoElement.pause();
      if (this.statisticsTimer !== undefined && this.statisticsTimer !== null) {
        this.statisticsTimer.pause();
      }
    }
  }

  override resume(): void {
    if (typeof this.statisticsTimer !== 'undefined' && this.statisticsTimer !== null) {
      this.statisticsTimer.resume();
    }

    if (this.playmode === 'live' && this.instantplayback) {
      this.instantplayback = false;

      const data = { channelId: this.channelId, errorCode: fromHex('0x1101') };
      if (typeof this.eventInstantPlaybackCallback !== 'undefined' && this.eventInstantPlaybackCallback !== null) {
        this.eventInstantPlaybackCallback(data);
      }
    }

    this.userPaused = false;
    if ((this.videoElement as HTMLVideoElement).paused) {
      this.videoPlay();
    }
  }

  override stop(): void {}

  override close(): void {
    this.videoPause();

    try {
      if (this.audiotranscoderWorker) {
        this.audiotranscoderWorker.postMessage({ type: 'terminate', data: null });
      }

      if (this.mediaSource !== null && this.mediaSource !== undefined) {
        if (this.mediaSource.sourceBuffers.length > 0) {
          this.mediaSource.removeSourceBuffer(this.mediaSource.sourceBuffers[0]);
        }

        if (this.mediaSource.readyState !== 'ended') {
          this.mediaSource.endOfStream();
        }
      }

      this.videoCodecInfo = null;
      this.audioCodecInfo = { codecType: 0, bitrate: 0 };

      this.previousFrameCount = this.currentFrameCount = 0;
      if (this.statisticsTimer !== undefined && this.statisticsTimer !== null) {
        this.statisticsTimer.pause();
        this.statisticsTimer = null;
      }

      if (this.videoElement !== undefined && this.videoElement !== null) {
        window.URL.revokeObjectURL(this.videoElement.src);
        this.videoElement.removeAttribute('src');

        if (!this.playbackFlag) {
          this.videoElement.load();
        }

        this.removeAllCues(this.videoElement.textTracks[this.timestampTextTrackId]);
        this.videoElement.textTracks[this.timestampTextTrackId].oncuechange = null;
        this.removeAllEventListener();

        this.videoElement.onpause = null;
        (this.videoElement as unknown as { onclose: null }).onclose = null;
        this.videoElement.oncanplay = null;
        this.videoElement.onwaiting = null;
        this.videoElement.ondurationchange = null;
        this.videoElement.onloadeddata = null;
        this.videoElement.onprogress = null;
        this.videoElement.onseeking = null;
        this.videoElement.onseeked = null;
        this.videoElement.ontimeupdate = null;
        this.videoElement.onstalled = null;
        this.videoElement.oncanplaythrough = null;
        this.videoElement.onemptied = null;

        this.videoElement.style.background = '';
        window.URL.revokeObjectURL(this.videoElement.src);
      }
    } catch {
      // legacy: videotag_log.error(...) only, no further effect.
    }
  }

  override forward(): void {}

  override backward(): void {}

  // digitalZoom/bufferingVideoData/controlStepPlay/sendToBufferManager: the
  // `VideoPlayerLike` structural contract MediaRouter.ts's `this.player`
  // field is typed against (shared with CanvasTagPlayer, which genuinely
  // implements all four for its step-play/digital-zoom features) requires
  // these unconditionally — but videoTagPlayer.js's own Constructor.prototype
  // never defines any of them (grep-confirmed, same finding that drove
  // VideoPlayer.ts to *not* declare them abstract). Calling any of these on
  // a real VideoTagPlayer instance genuinely throws `TypeError: ... is not
  // a function` in legacy. MediaRouter.ts's own call sites already guard
  // every one of them behind `tagMode === 'canvas'` (digitalZoom directly;
  // bufferingVideoData/controlStepPlay behind `stepFlag === true`, which
  // selectVideoPlayer() forces to always pick the canvas player; sendToBufferManager
  // behind checkBufferManagerAvailable()'s own `tagMode === 'canvas'` check) —
  // so in the actual wired-up system these are provably unreachable on this
  // class. They're stubbed here (rather than left off `VideoTagPlayer`) only
  // so its type structurally satisfies `VideoPlayerLike` for the
  // createVideoPlayer() factory wiring in StreamPlayer.ts, while still
  // throwing if anything ever did call them — preserving the real crash.
  digitalZoom(_bufferData: unknown): void {
    throw new TypeError('this.player.digitalZoom is not a function');
  }

  bufferingVideoData(_playMode: string, _streamData: VideoStreamData, _videoInfo: VideoInfo): boolean {
    throw new TypeError('this.player.bufferingVideoData is not a function');
  }

  controlStepPlay(_lastRenderingTime: unknown, _stepCmd: string): void {
    throw new TypeError('this.player.controlStepPlay is not a function');
  }

  sendToBufferManager(_playMode: string, _streamData: VideoStreamData, _videoInfo: VideoInfo, _errorCallback: unknown): void {
    throw new TypeError('this.player.sendToBufferManager is not a function');
  }

  toggleControls(flags?: boolean): void {
    const videoElement = this.videoElement;
    if (typeof flags !== 'undefined' && flags !== null && typeof videoElement !== 'undefined' && videoElement !== null) {
      if (flags && !videoElement.hasAttribute('controls')) {
        videoElement.setAttribute('controls', 'controls');
      } else {
        videoElement.removeAttribute('controls');
      }
    } else {
      if (typeof videoElement !== 'undefined' && videoElement !== null) {
        if (videoElement.hasAttribute('controls')) {
          videoElement.removeAttribute('controls');
        } else {
          videoElement.setAttribute('controls', 'controls');
        }
      }
    }
  }

  override clearBuffer(): void {
    this.clearBufferFlag = true;
  }

  override instantplaybackCmd(data: { cmd: string; currentTime?: number | string }): void {
    switch (data.cmd) {
      case 'init':
        if (this.playmode === 'live') {
          try {
            this.instantplayback = true;
            if (this.mediaSource && (this.mediaSource as unknown as { willEnd?: boolean }).willEnd) {
              this.mediaSource.endOfStream();
            }
          } catch {
            // legacy: console.error("error", error) only, no further effect.
          }
        }
        break;
      case 'play':
        this.play();
        break;
      case 'pause':
        this.pause();
        break;
      case 'seek': {
        const seekTime = parseFloat(String(data.currentTime));
        const videoElement = this.videoElement as HTMLVideoElement;
        if (seekTime >= 0 && seekTime <= videoElement.duration) {
          videoElement.currentTime = Number(data.currentTime);
        }
        break;
      }
      case 'terminate':
        try {
          this.clearBuffer();
        } catch {
          throw new RTSPOverWebSocketError({
            channelId: this.channelId,
            errorCode: fromHex('0x1104'),
            place: 'VideoTagPlayer.ts:instantplaybackCmd:terminated',
            message: 'fail to terminate instant playback mode.'
          });
        }
        break;
    }
  }

  onNetworkState(variance: number, _mean: number): void {
    if ((variance >= 0.1 && this.delay > 15) || this.delay < this.defaultDelay) {
      this.networkWeight = 1;
    } else if (variance > 5 && this.delay <= 15) {
      this.networkWeight = 2;
    } else if (variance > 3 && variance <= 5) {
      this.networkWeight = 1.1;
    } else if (variance >= 0.1 && variance <= 3) {
      this.networkWeight = 1;
    } else if (variance === 0) {
      this.networkWeight = 0.9;
    } else {
      this.networkWeight = 1;
    }
  }

  getAudioInfo(): Mp4AudioTrackInfo {
    return this.audioInfo;
  }

  setAudioInfo(audioinfo: {
    codecMime?: string;
    codecType: string;
    bitrate: number;
    interleavedId: number;
    channelCount?: number;
    samplingFrequencyIndex?: number;
    sampleRate?: number;
  }): void {
    this.audioCodecInfo.codecType = audioinfo.codecType;
    this.audioCodecInfo.bitrate = audioinfo.bitrate;
    this.audioInfo.interleavedId = audioinfo.interleavedId;
    this.resetBaseDecodingTime();
    if (audioinfo.codecType === 'G711' || audioinfo.codecType === 'G726') {
      (this.audiotranscoderWorker as Worker).postMessage({ type: 'init', data: { codecType: audioinfo.codecType, bitRate: audioinfo.bitrate } });
    }
    const switchingToRealAac = !this.realAacActive && audioinfo.codecType === 'AAC';
    const switchingAwayFromRealAac = this.realAacActive && audioinfo.codecType !== 'AAC';
    if (switchingToRealAac || switchingAwayFromRealAac) {
      this.appendSegmentToSourceBuffer();

      const isRealAac = audioinfo.codecType === 'AAC';
      // For real AAC source audio, use the actual channel_configuration /
      // samplingFrequencyIndex / frame duration (this repo's own demo server
      // encodes 48000Hz stereo AAC, not the 16000Hz mono a real IP camera
      // typically sends) — declaring the wrong ones makes the browser's AAC
      // decoder reject the audio track partway into playback (see
      // AACSession.ts's init()). G711/G726 is transcoded to AAC in-browser
      // at a fixed 8000Hz mono, so that path keeps the hardcoded values.
      this.audioInfo = {
        id: 2,
        channelcount: isRealAac ? (audioinfo.channelCount ?? 1) : 1,
        samplesize: 8,
        type: 'audio',
        codecType: 'AAC',
        audioobjecttype: 2,
        samplingfrequencyindex: isRealAac ? (audioinfo.samplingFrequencyIndex ?? 8) : 11,
        samplingDuration: isRealAac && audioinfo.sampleRate ? Math.round((AAC_FRAME_SAMPLES / audioinfo.sampleRate) * TIME_SCALE) : isRealAac ? 640 : 1280,
        interleavedId: audioinfo.interleavedId
      };
      this.realAacActive = isRealAac;

      this.segmentArray = [];
      this.audioSamples = [];
      this.createInitSegment();
    }
  }

  setVideoInfo(videoinfo: VideoInfo, codecType: string): void {
    let targetWidth = videoinfo.width as number;
    let targetHeight = videoinfo.height as number;

    if ((videoinfo.cropWidth as number) > 0 || (videoinfo.cropHeight as number) > 0) {
      const specialWidth = [192, 368, 608, 1088, 1472, 1952, 3008];
      const isDividedBy16 = { width: true, height: true };
      for (const w of specialWidth) {
        if (targetWidth === w) {
          isDividedBy16.width = false;
        }
        if (targetHeight === w) {
          isDividedBy16.height = false;
        }
      }
      if (!isDividedBy16.width) {
        targetWidth -= videoinfo.cropWidth as number;
      }
      if (!isDividedBy16.height) {
        targetHeight -= videoinfo.cropHeight as number;
      }
    }

    const videoInfoBox: Mp4VideoTrackInfo = {
      id: 1,
      width: targetWidth,
      height: targetHeight,
      type: 'video',
      codecType,
      sps: [videoinfo.spsPayload],
      pps: [videoinfo.ppsPayload]
    };

    if (codecType === 'H264') {
      videoInfoBox.profileIdc = videoinfo.profileIdc as number;
      videoInfoBox.profileCompatibility = 0;
      videoInfoBox.levelIdc = videoinfo.levelIdc as number;
    } else if (codecType === 'H265') {
      videoInfoBox.profileTierLevel = videoinfo.profileTierLevel;
      videoInfoBox.vps = [videoinfo.vpsPayload as Uint8Array | undefined];
    }

    this.videoInfoBox = videoInfoBox;
  }

  ControlVolume(vol: number | 'on' | 'off' | 'unmute' | 'mute'): void {
    const videoElement = this.videoElement as HTMLVideoElement;
    if (vol === 'on' || vol === 'unmute') {
      this.audio = true;
      videoElement.muted = false;
    } else if (vol === 'off' || vol === 'mute') {
      this.audio = false;
      videoElement.muted = true;
      this.dummyAudio = true;
    } else {
      videoElement.volume = (vol as number) * 0.2;
    }
  }

  onChangeAudioShift(v: number): void {
    if (this.baseAudioTime !== -1 && v !== this.audioshift) {
      const direction = v - this.audioshift >= 0 ? 1 : -1;
      const distance = direction * Math.sqrt(Math.pow(this.audioshift - v, 2));
      this.baseAudioTime += distance * TEN;
    }
  }

  onChangeSpeed(v: number | string): void {
    let parsed: number;
    if (typeof v === 'string') {
      parsed = v.indexOf('.') !== -1 ? parseFloat(v) : parseInt(v, 10);
    } else {
      parsed = v;
    }

    if (parsed !== this.localSpeedValue) {
      this.speedChanged = true;
      setTimeout(() => {
        this.speedChanged = false;
      }, 5000);
    }

    if (parsed !== 1) {
      this.dummyAudio = true;
    }
    this.localSpeedValue = parsed;
  }
}
