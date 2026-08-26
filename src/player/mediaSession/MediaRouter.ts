import { H264SPSParser } from '../util/H264SPSParser';
import { H265SPSParser } from '../util/H265SPSParser';
import { parseVP8FrameHeader } from '../util/VP8HeaderParser';
import { parseVP9FrameHeader, type VP9FrameHeader } from '../util/VP9HeaderParser';
import { parseAV1SequenceHeader, type AV1FrameHeader } from '../util/AV1HeaderParser';
import { buildAV1CodecString, buildVP9CodecString, defaultRealMseCodecString } from '../util/codecString';
import { getElementByAttributeValue } from '../util/getElementByAttributeValue';
import { browserDetect } from '../util/BrowserDetect';
import { RTSPOverWebSocketError } from '../exceptions/RTSPOverWebSocketError';
import { fromHex } from '../util/hex';
import type { WaitingEvent, RtpStatistics } from './RtpSession';

/**
 * Ported from the legacy player’s MediaSession/mediaRouter — the hub that owns
 * the active video/audio player, routes depacketized RTP session data to it,
 * and dispatches UI commands (speed/pause/resume/step/minimap/backup/...).
 *
 * Debug-only logger calls are not reproduced. `Constructor.prototype.x = v`
 * assignments in legacy (audioVolume/minRemainTime/minTimerInterval/profile/
 * DOMElement) look like shared class state at first glance, but `MediaRouter`
 * is a plain factory *function* (not a singleton IIFE) — every `new
 * MediaRouter()` call creates its own fresh `Constructor` and therefore its
 * own fresh `.prototype`, so this is just unconventional instance-state
 * syntax, not real cross-instance sharing. Ported as plain instance fields.
 *
 * `onVideoData`/`onAudioData`/`onMetadata`/`onRtcpData` are registered in
 * RtpClient.ts as *raw, unbound* function references
 * (`rtpSession.addEventListener('video', mediaRouter.onVideoData)`), exactly
 * mirroring legacy — when the owning RTP/RTCP session later invokes
 * `this.eventVideoCallback(...)`, `this` inside these methods is the
 * *session*, not the router. Legacy captures the router itself as `_self`
 * for router-level state inside these four methods; this port does the same
 * via the `this: SessionContext` parameter annotation (TypeScript's way of
 * statically declaring "this method is called unbound") plus a captured
 * `self` reference. `onWaiting`/`onStatistics`, by contrast, are invoked via
 * RtpClient.ts's own wrapper functions as proper method calls
 * (`this.mediaRouter.onWaiting?.(waiting)`), so `this` is the router there —
 * matching legacy's identical distinction (see rtpClient's local
 * `onWaiting`/`onStatistics` wrappers).
 */

/* eslint-disable no-magic-numbers */
const MEGA_SIZE = 1 << 20;
const XGA_SIZE = 1024 * 768;
const FHD_SIZE = 1920 * 1080;
/* eslint-enable no-magic-numbers */

const LIMIT_SIZE: Record<string, number> = { Live: 1 * MEGA_SIZE, Playback: XGA_SIZE };
const ULTRA_SPEED = 4;
const DROP_OUT_LEVEL = 2;
const WIDTH_HD = 1920;
const HEIGHT_HD = 1080;
const LIMIT_SPEED_RESOLUTION = WIDTH_HD * HEIGHT_HD;
const DEFAULT_MINIMAP_REFRESH_INTERVAL = 3000;
const VIDEO_TAG_LIMIT_WIDTH = 4096;
const VIDEO_TAG_LIMIT_HEIGHT = 2688;
const VIDEO_TAG_LIMIT_HEIGHT_FOR_FIREFOX_OR_EDGE = 2304;

export interface TimeStampInfo {
  rtpTimeStamp?: number;
  rtpTimestamp?: number;
  timestamp?: number;
  timestamp_usec?: number;
  timezone?: number;
  utcTimeStamp?: number;
  utcDatetime?: Date;
}

export interface VideoStreamData {
  codecType: string;
  frameData: Uint8Array;
  objectId?: unknown;
  timeStamp: TimeStampInfo;
}

export interface VideoInfo {
  frameType?: string;
  spsPayload?: Uint8Array;
  ppsPayload?: Uint8Array;
  vpsPayload?: Uint8Array | null;
  framerate?: number;
  width?: number;
  height?: number;
  cropWidth?: number;
  cropHeight?: number;
  decodeSize?: number;
  dropOut?: number;
  codecInfo?: string | null;
  profileIdc?: unknown;
  levelIdc?: unknown;
  profileTierLevel?: number[];
  playMode?: string;
  /** Shared by VP9 and AV1 — the codec's own sequence/frame profile number. */
  profile?: number;
  /** VP9 only, from `VP9HeaderParser`'s `VP9FrameHeader`. */
  bitDepth?: number;
  colorSpace?: number;
  colorRange?: number;
  subsamplingX?: number;
  subsamplingY?: number;
  /** AV1 only, from `AV1HeaderParser`'s `AV1FrameHeader`. */
  seqLevelIdx0?: number;
  seqTier0?: number;
  highBitdepth?: number;
  twelveBit?: number;
  monoChrome?: number;
  chromaSubsamplingX?: number;
  chromaSubsamplingY?: number;
  chromaSamplePosition?: number;
  configObu?: Uint8Array;
}

export interface AudioStreamData {
  interleaved?: number;
  codecType: string;
  codecMime?: string;
  frameData: Uint8Array;
  channelId?: number;
  timeStamp: TimeStampInfo;
  rtcp_interleavedId?: number;
  ADTs?: Uint8Array;
}

export interface AudioInfo {
  bitrate?: number;
  channelCount?: number;
  samplingFrequencyIndex?: number;
  sampleRate?: number;
}

export interface MetadataFrame {
  frameData: Uint8Array;
  timeStamp: TimeStampInfo;
}

interface SessionContext {
  interleavedId: number;
  channelId: number;
  type?: string;
  rtcpSession?: unknown;
  timeData: { timestamp: number | null; timestamp_usec: number | null; timezone: number | null } | null;
  rtpTimestamp?: number | string;
  startStatisticsTimer(): void;
  stopStatisticsTimer(): void;
}

export interface VideoResizeInfo {
  channelId: number;
  elementId: unknown;
  videoElementId: string;
  tagmode: string;
  width: number;
  height: number;
  cropWidth: number;
  cropHeight: number;
}

export interface VideoPlayerLike {
  type: string;
  /** Unset until the first 'open'/'resume' assigns it (see VideoPlayer.ts). */
  playmode: string | undefined;
  channelId: number;
  deviceType?: string;
  /** Set by `handleVideoData` right before `init()` — the only point
   * `VideoTagPlayer.init()` can learn the codec before its first
   * `onVideoData` call, which it needs to decide real-MSE vs. WebCodecs-
   * bridge for VP8/VP9/AV1 (see `VideoTagPlayer.ts`'s `decideUseBridge`). */
  codec?: string;
  /** Set right before init(), same as `codec` above — see MediaRouter's
   * `audioCodecHint` field comment and `setAudioCodecHint()`. */
  audioCodecHint?: string;
  boxsize: number;
  framedrop: boolean;
  speed: number;
  rfps?: number;
  audioshift?: number;
  ControlVolume?(value: unknown): void;
  init(videoElement: unknown): void;
  close(): void;
  pause(): void;
  resume(): void;
  /** VideoTagPlayer's forward/backward are real no-ops (return undefined); only CanvasTagPlayer's return value is meaningfully read (`selectVideoPlayer` only reaches this dispatch in canvas mode). */
  forward(): boolean | void;
  backward(): boolean | void;
  clearBuffer(): void;
  capture(data: unknown): void;
  digitalZoom(data: unknown): void;
  instantplaybackCmd(data: unknown): void;
  toggleControls(flags: unknown): void;
  onWaitingPackets(waiting: WaitingEvent): void;
  onVideoData?(playMode: string, streamData: VideoStreamData, videoInfo: VideoInfo): void;
  onAudioData?(playMode: string, streamData: AudioStreamData, audioInfo: AudioInfo): void;
  bufferingVideoData(playMode: string, streamData: VideoStreamData, videoInfo: VideoInfo): boolean;
  controlStepPlay(lastRenderingTime: unknown, stepCmd: string): void;
  sendToBufferManager(playMode: string, streamData: VideoStreamData, videoInfo: VideoInfo, errorCallback: unknown): void;
  addEventListener(type: string, cb: unknown): void;
  updateMiniMapInfo(data: unknown): void;
  setTimeStampCallback(cb: unknown): void;
  setErrorCallback(cb: unknown): void;
  setResizeCallback(cb: unknown): void;
  setFrameRate(fr: number): void;
  setRequestTime?(t: unknown): void;
  setDefaultDelay(d: number): void;
  setMaxInstantPlayback(t: number): void;
  setBufferClearInterval(i: number): void;
}

export interface AudioPlayerLike {
  channelId: number;
  isInit(): boolean;
  setInitVideoTimeStamp(v: number): void;
  audioInit(codecType: string, codecMime: string | undefined, bitrate: number | undefined, volume: number): void;
  Play(): void;
  Stop(): void;
  terminate(): void;
  BufferAudio(frameData: Uint8Array, rtpTimestamp: unknown): void;
  setBufferingFlag(rtpTimestamp: unknown, mode: string): void;
  ControlVolume(value: unknown): void;
}

export interface TalkLike {
  channelId: number;
  init(): boolean;
  /** Raw PCM samples straight from the ScriptProcessorNode, not yet RTP-encoded. */
  setSendAudioTalkBufferCallback(cb: (data: Float32Array) => void): void;
  initAudioOut(): Promise<number>;
  terminate(): void;
}

export interface MetaDataParserLike {
  channelId: number;
  deviceType?: string;
  parse(frameData: Uint8Array): void;
}

export interface BackupProviderLike {
  channelId: number;
  deviceType?: string;
  init(data: unknown): void;
  closeStream(): void;
  onVideoData(streamData: VideoStreamData, videoInfo: VideoInfo): void;
  receiveAudioData(streamData: AudioStreamData, audioInfo: AudioInfo): void;
}

export type VideoPlayerFactory = () => VideoPlayerLike;
export type AudioPlayerFactory = () => AudioPlayerLike;
export type TalkFactory = () => TalkLike;
export type MetaDataParserFactory = (cb: (...args: unknown[]) => void) => MetaDataParserLike;
export type BackupProviderFactory = (cb: unknown) => BackupProviderLike;

export interface MediaRouterErrorEvent {
  channelId?: number;
  errorCode: number;
  oldErrorCode?: string | number;
  isLimit?: boolean;
  description?: string;
  place?: string;
  codec?: string;
  media?: string;
  waiting?: boolean;
  duration?: number;
  mode?: string;
  newProfileType?: string;
}

export type MediaRouterListenerType =
  | 'timeStamp'
  | 'resize'
  | 'stepRequest'
  | 'metaEvent'
  | 'metaImageEvent'
  | 'videoMode'
  | 'rtpClient'
  | 'error'
  | 'statistics'
  | 'capture'
  | 'instantplayback'
  | 'gotAudioSupport';

export type MediaRouterCommandType =
  | 'capture'
  | 'backup'
  | 'forward'
  | 'backward'
  | 'speed'
  | 'pause'
  | 'resume'
  | 'seek'
  | 'audioIn'
  | 'digitalZoom'
  | 'clearBuffer'
  | 'minimap'
  | 'requestTimeChanged'
  | 'instantplayback';

export interface BackupCommandData {
  command: 'start' | 'stop';
  callback?: unknown;
  [key: string]: unknown;
}

export interface MinimapCommandData {
  mode: 'on' | 'off';
  target?: unknown;
  interval?: number;
}

interface CurrentProfile {
  codec: string;
  size: number;
  isLimitSpeed: boolean | null;
}

interface ActiveSessionSlot {
  rtp: SessionContext | null;
  rtcp: unknown;
}

export interface MediaRouterFactories {
  createCanvasPlayer: VideoPlayerFactory;
  createVideoPlayer: VideoPlayerFactory;
  createAudioPlayer: AudioPlayerFactory;
  createTalk: TalkFactory;
  createMetaDataParser: MetaDataParserFactory;
  createBackupProvider: BackupProviderFactory;
  /** Deep-clones an array/typed-array (legacy `cloneArray` global). */
  cloneArray: (data: Uint8Array) => Uint8Array;
}

export class MediaRouter {
  /**
   * Detached-callback handlers, assigned in the constructor (not declared as
   * ordinary prototype methods) so each closes over `self` — matching
   * legacy's `_self` closure capture exactly. RtpClient.ts registers these
   * directly as `rtpSession.addEventListener('video', mediaRouter.onVideoData)`
   * (an unbound reference); when the owning session later invokes
   * `this.eventVideoCallback(...)`, `this` inside the function is the
   * *session* — these signatures declare that via `this: SessionContext`,
   * while `self` (captured here, not derived from `this`) gives router-level
   * access. This is the direct TS equivalent of legacy's `_self`.
   */
  readonly onVideoData: (this: SessionContext, playMode: string, streamData: VideoStreamData, videoInfo: VideoInfo, isMetaImage?: boolean) => void;
  readonly onAudioData: (this: SessionContext, playMode: string, streamData: AudioStreamData, audioInfo: AudioInfo) => void;
  readonly onMetadata: (this: SessionContext, metadata: MetadataFrame) => void;
  readonly onRtcpData: (this: SessionContext) => void;

  private readonly browserType = browserDetect();

  private videoCodec: string | null = null;
  private videoSize: number | null = null;
  private videoWidth: number | null = null;
  private videoHeight: number | null = null;
  private spsParser: H264SPSParser | H265SPSParser | null = null;

  private tagMode: 'canvas' | 'video' = 'canvas';
  private lastRenderingTime: unknown = null;
  private speedValue = 1;
  private dropOut = 1;
  private requestTime: unknown = null;
  private videoElement: Element | undefined;

  private videoNTPDateTime: { timestamp: number | null; timestamp_usec: number | null; utc: Date } | null = null;
  private rtcpTSvideo: number | string | undefined;
  private audioNTPDateTime: { timestamp: number | null; timestamp_usec: number | null; utc: Date } | null = null;
  private rtcpTSaudio: number | string | undefined;
  // NOTE: legacy also tracks `metaNTPDateTime`/`rtcpTSmeta` (the 'meta' branch
  // of onRtcpData, and cleared in initializeNTPTimestamp) but — unlike the
  // video/audio equivalents — never reads either anywhere (confirmed via
  // grep): meta/text tracks don't get the same live NTP-sync treatment as
  // video/audio. Dropped as confirmed dead state.

  private audioPlayer: AudioPlayerLike | null = null;
  private audioCodec: string | null = null;
  // Learned from SDP (RtpClient.sendSdpInfo(), well before any RTP data
  // arrives) via setAudioCodecHint() — unlike `audioCodec` above, which is
  // only set reactively from the first real onAudioData call. Passed to a
  // newly-created VideoPlayerLike right before init() so it can make a
  // SourceBuffer-codecs decision (Opus vs. AAC-shaped) that doesn't depend
  // on whether the first video I-frame or the first audio packet happens to
  // arrive first — see VideoTagPlayer.ts's init()/setAudioInfo().
  private audioCodecHint: string | null = null;
  private audioBitrate: number | null = null;
  private audioTalker: TalkLike | null = null;

  private metaDataParser: MetaDataParserLike | null = null;

  private backupProvider: BackupProviderLike | null = null;
  private isBackup = false;

  private errorCallback: ((event: MediaRouterErrorEvent) => void) | null = null;
  private timeStampCallback: ((timeStamp: unknown, stepFlag: boolean) => void) | null = null;
  private resizeCallback: ((info: VideoResizeInfo) => void) | null = null;
  private stepRequestCallback: ((status: string, data?: unknown) => void) | null = null;
  private videoModeCallback: ((data: unknown) => void) | null = null;
  private rtpClientCallback: ((msgType: string, data: unknown) => void) | null = null;
  private metaImageCallback: ((data: unknown) => void) | null = null;
  private statisticsCallback: ((statistics: RtpStatistics) => void) | undefined;
  private captureCallback: ((...args: unknown[]) => void) | undefined;
  private instantplaybackCallback: ((...args: unknown[]) => void) | undefined;
  private gotAudioSupportCallback: ((supported: boolean) => void) | null = null;
  private stepObj: unknown = null;

  private stepFlag = false;
  private stepCmd: 'forward' | 'backward' = 'forward';
  private stepStatus: 'request' | 'complete' = 'request';

  private minimapTarget: unknown = null;
  private minimapUpdateTimer: ReturnType<typeof setInterval> | null = null;

  private readonly currentProfile: CurrentProfile = { codec: '', size: 0, isLimitSpeed: false };

  private readonly activeSessions: { video: ActiveSessionSlot; audio: ActiveSessionSlot; meta: ActiveSessionSlot } = {
    video: { rtp: null, rtcp: null },
    audio: { rtp: null, rtcp: null },
    meta: { rtp: null, rtcp: null }
  };

  private _channel = 0;
  private _mute = true;
  private _boxsize = 4;
  private _deviceType = 'camera';
  private _supportCovertAndOff = false;
  private _defaultVideoTagMode: string | null = null;
  private _videoPlayer: VideoPlayerLike | null = null;
  private _minimapRefreshInterval = DEFAULT_MINIMAP_REFRESH_INTERVAL;
  private _drop = false;
  private _rtpclient: unknown;
  private _audioshift = 0;

  private audioVolume = 0;
  private minRemainTime = 20;
  private minTimerInterval = 1;
  private profile: unknown;
  private domElement: unknown;
  framedropInit = false;

  constructor(private readonly factories: MediaRouterFactories) {
    const self = this;
    this.onVideoData = function (playMode, streamData, videoInfo, isMetaImage) {
      self.handleVideoData(this, playMode, streamData, videoInfo, isMetaImage);
    };
    this.onAudioData = function (playMode, streamData, audioInfo) {
      self.handleAudioData(this, playMode, streamData, audioInfo);
    };
    this.onMetadata = function (metadata) {
      self.handleMetadata(this, metadata);
    };
    this.onRtcpData = function () {
      self.handleRtcpData(this);
    };
  }

  get channelId(): number {
    return this._channel;
  }
  set channelId(v: number) {
    this._channel = v;
  }

  get mute(): boolean {
    return this._mute;
  }
  set mute(v: boolean) {
    this._mute = v;
    if (this._mute) {
      if (this.player && this.player.type === 'canvas') {
        this.deleteAudioPlayer();
      }
    } else {
      if (this.player && this.player.type === 'canvas') {
        this.createAudioPlayer();
      }
    }
  }

  get boxsize(): number {
    return this._boxsize;
  }
  set boxsize(v: number) {
    this._boxsize = v;
  }

  get deviceType(): string {
    return this._deviceType;
  }
  set deviceType(v: string) {
    this._deviceType = v;
  }

  get supportCovertAndOff(): boolean {
    return this._supportCovertAndOff;
  }
  set supportCovertAndOff(v: boolean) {
    this._supportCovertAndOff = v;
  }

  get defaultVideoTagMode(): string | null {
    return this._defaultVideoTagMode;
  }
  set defaultVideoTagMode(v: string | null) {
    this._defaultVideoTagMode = v;
  }

  get player(): VideoPlayerLike | null {
    return this._videoPlayer;
  }
  set player(v: VideoPlayerLike | null) {
    this._videoPlayer = v;
  }

  get minimapRefreshInterval(): number {
    return this._minimapRefreshInterval;
  }
  set minimapRefreshInterval(v: number) {
    this._minimapRefreshInterval = v;
  }

  get framedrop(): boolean {
    return this._drop;
  }
  set framedrop(v: boolean) {
    this._drop = typeof v === 'undefined' || v === null ? false : v;
  }

  get rtpClient(): unknown {
    return this._rtpclient;
  }
  set rtpClient(v: unknown) {
    this._rtpclient = v;
  }

  get audioshift(): number {
    return this._audioshift;
  }
  set audioshift(v: number) {
    this._audioshift = v;
    if (this._videoPlayer && this._videoPlayer.type === 'video') {
      this._videoPlayer.audioshift = this._audioshift;
    }
  }

  private getMaxResolutionSize(): number {
    const jscdBrowser = (globalThis as unknown as { window?: { jscd?: { browser?: string } } }).window?.jscd?.browser ?? '';
    if (jscdBrowser.indexOf('Firefox') !== -1) {
      return VIDEO_TAG_LIMIT_WIDTH * VIDEO_TAG_LIMIT_HEIGHT_FOR_FIREFOX_OR_EDGE;
    }
    return VIDEO_TAG_LIMIT_WIDTH * VIDEO_TAG_LIMIT_HEIGHT;
  }

  private spsParse(sps: Uint8Array | undefined, codecType: string): void {
    if (this.videoCodec !== codecType) {
      this.spsParser = codecType === 'H264' ? new H264SPSParser() : new H265SPSParser();
    }
    if (sps === null || typeof sps === 'undefined') {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: fromHex('0x0304'),
        place: 'MediaRouter.ts:spsParse',
        message:
          'SPS payload is not available for channel ' +
          this.channelId +
          '. The encoder may be sending SPS/PPS through an aggregation packet type that is not supported, or SPS has not arrived yet. codecType = ' +
          codecType
      });
    }
    this.spsParser!.parse(sps);
  }

  /** VP8/VP9/AV1 have no SPS-equivalent parameter set — each parses a
   * different part of the codec's own self-describing keyframe header
   * instead (see the three `util/*HeaderParser.ts` modules). Returns `null`
   * on any non-keyframe/truncated input; that's the expected common case
   * (this is called on every frame, not just keyframes), not an error. */
  private parseNonSpsFrameSize(codecType: string, frameData: Uint8Array): VP9FrameHeader | AV1FrameHeader | { width: number; height: number } | null {
    switch (codecType) {
      case 'VP8':
        return parseVP8FrameHeader(frameData);
      case 'VP9':
        return parseVP9FrameHeader(frameData);
      case 'AV1':
        return parseAV1SequenceHeader(frameData);
      default:
        return null;
    }
  }

  private getFrameSizeInfo(
    codecType: string,
    videoInfo: VideoInfo,
    frameData: Uint8Array
  ): { width: number; height: number; decodeSize: number; cropWidth: number; cropHeight: number } {
    const sizeInfo = { width: 0, height: 0, decodeSize: 0, cropWidth: 0, cropHeight: 0 };
    if (codecType === 'MJPEG') {
      sizeInfo.width = videoInfo.width ?? 0;
      sizeInfo.height = videoInfo.height ?? 0;
      sizeInfo.decodeSize = (videoInfo.width ?? 0) * (videoInfo.height ?? 0);
    } else if (codecType === 'VP8' || codecType === 'VP9' || codecType === 'AV1') {
      const header = this.parseNonSpsFrameSize(codecType, frameData);
      if (header !== null) {
        sizeInfo.width = header.width;
        sizeInfo.height = header.height;
        sizeInfo.decodeSize = header.width * header.height;
        videoInfo.width = sizeInfo.width;
        videoInfo.height = sizeInfo.height;
        videoInfo.cropWidth = 0;
        videoInfo.cropHeight = 0;

        if (codecType === 'VP9') {
          const vp9Header = header as VP9FrameHeader;
          videoInfo.profile = vp9Header.profile;
          videoInfo.bitDepth = vp9Header.bitDepth;
          videoInfo.colorSpace = vp9Header.colorSpace;
          videoInfo.colorRange = vp9Header.colorRange;
          videoInfo.subsamplingX = vp9Header.subsamplingX;
          videoInfo.subsamplingY = vp9Header.subsamplingY;
        } else if (codecType === 'AV1') {
          const av1Header = header as AV1FrameHeader;
          videoInfo.profile = av1Header.profile;
          videoInfo.seqLevelIdx0 = av1Header.seqLevelIdx0;
          videoInfo.seqTier0 = av1Header.seqTier0;
          videoInfo.highBitdepth = av1Header.highBitdepth;
          videoInfo.twelveBit = av1Header.twelveBit;
          videoInfo.monoChrome = av1Header.monoChrome;
          videoInfo.chromaSubsamplingX = av1Header.chromaSubsamplingX;
          videoInfo.chromaSubsamplingY = av1Header.chromaSubsamplingY;
          videoInfo.chromaSamplePosition = av1Header.chromaSamplePosition;
          videoInfo.configObu = frameData.slice(av1Header.obuStart, av1Header.obuEnd);
        }
      }
    } else {
      this.spsParse(videoInfo.spsPayload, codecType);
      const parsedSizeInfo = this.spsParser!.getSizeInfo();
      sizeInfo.width = parsedSizeInfo.width;
      sizeInfo.height = parsedSizeInfo.height;
      sizeInfo.decodeSize = parsedSizeInfo.decodeSize;
      sizeInfo.cropWidth = parsedSizeInfo.cropWidth;
      sizeInfo.cropHeight = parsedSizeInfo.cropHeight;
      videoInfo.width = sizeInfo.width;
      videoInfo.height = sizeInfo.height;
      videoInfo.cropWidth = sizeInfo.cropWidth;
      videoInfo.cropHeight = sizeInfo.cropHeight;
    }
    return sizeInfo;
  }

  private checkValidSpeed(codecType: string, size: number): void {
    if (this.currentProfile.codec === codecType && this.currentProfile.size === size) {
      return;
    }
    if (codecType === 'MJPEG' && size > LIMIT_SPEED_RESOLUTION) {
      if (this.currentProfile.isLimitSpeed === null || this.currentProfile.isLimitSpeed === false) {
        this.currentProfile.isLimitSpeed = true;
        this.errorCallback?.({
          errorCode: fromHex('0x0302'),
          oldErrorCode: '103',
          isLimit: true,
          description: 'limit speed',
          place: 'MediaRouter.ts:197',
          channelId: this.channelId
        });
      }
    } else {
      if (this.currentProfile.isLimitSpeed === null || this.currentProfile.isLimitSpeed === true) {
        this.currentProfile.isLimitSpeed = false;
        this.errorCallback?.({
          errorCode: fromHex('0x0302'),
          oldErrorCode: '103',
          isLimit: false,
          description: 'default speed list',
          place: 'MediaRouter.ts:210',
          channelId: this.channelId
        });
      }
    }
    this.currentProfile.codec = codecType;
    this.currentProfile.size = size;
  }

  private sendTimeStamp(timeStamp: unknown): void {
    if (this.timeStampCallback !== null) {
      this.lastRenderingTime = timeStamp;
      this.timeStampCallback(timeStamp, this.stepFlag);
    }
  }

  private checkBufferManagerAvailable(playMode: string, codecType: string): boolean {
    return playMode === 'Playback' && codecType === 'H265' && this.tagMode === 'canvas';
  }

  private handleVideoData(session: SessionContext, playMode: string, streamData: VideoStreamData, videoInfo: VideoInfo, isMetaImage?: boolean): void {
    const self = this;
    if (isMetaImage && self.metaImageCallback) {
      self.metaImageCallback({
        channelId: self.channelId,
        elementId: self.getElement(),
        objectId: streamData.objectId,
        width: videoInfo.width,
        height: videoInfo.height,
        imageData: streamData.frameData
      });
      return;
    }

    if (self.activeSessions.video.rtp !== null && self.activeSessions.video.rtp.interleavedId !== session.interleavedId) {
      self.activeSessions.video.rtp.stopStatisticsTimer();
      session.startStatisticsTimer();
    }
    self.activeSessions.video.rtp = session;
    self.activeSessions.video.rtcp = session.rtcpSession;

    let sizeInfo: { width: number; height: number; decodeSize: number; cropWidth: number; cropHeight: number } | null = null;
    let backupData: Uint8Array | null = null;
    if (self.isBackup === true && self.backupProvider !== null) {
      backupData = self.factories.cloneArray(streamData.frameData);
    }

    if (self.videoNTPDateTime && self.rtcpTSvideo && streamData.timeStamp.rtpTimestamp && playMode === 'Live') {
      streamData.timeStamp.utcTimeStamp = self.videoNTPDateTime.utc.valueOf() + (streamData.timeStamp.rtpTimestamp - Number(self.rtcpTSvideo));
      streamData.timeStamp.timestamp = Math.trunc(streamData.timeStamp.utcTimeStamp / 1000);
      streamData.timeStamp.timestamp_usec = streamData.timeStamp.utcTimeStamp % 1000;
      streamData.timeStamp.utcDatetime = new Date(streamData.timeStamp.utcTimeStamp);
    }

    if (videoInfo.frameType === 'I') {
      sizeInfo = self.getFrameSizeInfo(streamData.codecType, videoInfo, streamData.frameData);

      if ((playMode === 'Live' || playMode === 'Playback') && !self.isBackup) {
        if (
          self.videoCodec !== streamData.codecType ||
          sizeInfo.decodeSize !== self.videoSize ||
          videoInfo.width !== self.videoWidth ||
          videoInfo.height !== self.videoHeight ||
          self.player === null
        ) {
          self.player = self.selectVideoPlayer(self.channelId, playMode, streamData.codecType, sizeInfo.decodeSize, videoInfo.framerate);
          if (self.player === null || typeof self.player === 'undefined') {
            return;
          }

          const checkResult = self.checkVideoResolution(streamData.codecType, videoInfo);
          if (checkResult !== true) {
            self.errorCallback?.({
              channelId: self.channelId,
              errorCode: fromHex('0x030C'),
              description: 'Not enough decoding for currnet profile, Change UWA profile',
              place: 'mediaRouter:onVideoData',
              newProfileType: checkResult === 'Over4K' ? '4K' : 'BASIC'
            });
          }

          self.player.playmode = playMode.toString().toLowerCase();
          self.player.channelId = self.channelId;
          self.player.deviceType = self.deviceType;
          self.player.codec = streamData.codecType;
          self.player.audioCodecHint = self.audioCodecHint ?? undefined;
          self.player.setTimeStampCallback((ts: unknown) => self.sendTimeStamp(ts));
          if (self.errorCallback) self.player.setErrorCallback(self.errorCallback);
          if (self.resizeCallback) self.player.setResizeCallback(self.resizeCallback);
          self.player.setFrameRate(typeof videoInfo.framerate === 'undefined' ? 0 : videoInfo.framerate);

          if (self.player.speed !== self.speedValue) {
            self.player.speed = self.speedValue;
          }
          self.selectVideoElement(self.tagMode);

          if (typeof self.videoElement === 'undefined') {
            if (self.tagMode === 'video') {
              throw new RTSPOverWebSocketError({
                channelId: self.channelId,
                errorCode: fromHex('0x0900'),
                place: 'MediaRouter.ts:onVideoData',
                message: 'The video element do not exist. Check your video element or video element was released.'
              });
            } else {
              throw new RTSPOverWebSocketError({
                channelId: self.channelId,
                errorCode: fromHex('0x0901'),
                place: 'MediaRouter.ts:onVideoData',
                message: 'The canvas element do not exist. Check your canvas element or canvas element was released.'
              });
            }
          }
          self.player.init(self.videoElement);
          self.player.ControlVolume?.(self.mute ? 'off' : 'on');
          self.player.ControlVolume?.(self.getAudioVolume());
          self.videoCodec = streamData.codecType;
          self.videoSize = sizeInfo.decodeSize;

          if (videoInfo.width !== self.videoWidth || videoInfo.height !== self.videoHeight) {
            self.videoWidth = videoInfo.width ?? null;
            self.videoHeight = videoInfo.height ?? null;

            const videoResizeInfo: VideoResizeInfo = {
              channelId: self.channelId,
              elementId: self.getElement(),
              videoElementId: (self.videoElement as unknown as { id: string } | undefined)?.id ?? '',
              tagmode: self.tagMode,
              width: sizeInfo.width,
              height: sizeInfo.height,
              cropWidth: sizeInfo.cropWidth,
              cropHeight: sizeInfo.cropHeight
            };
            self.resizeCallback?.(videoResizeInfo);
          }
        }
      }
    } else {
      sizeInfo = self.getFrameSizeInfo(streamData.codecType, videoInfo, streamData.frameData);
      if (self.videoWidth !== null) {
        videoInfo.width = self.videoWidth;
        videoInfo.height = self.videoHeight ?? undefined;
      }
    }

    if (self.player !== null) {
      videoInfo.dropOut = self.dropOut;
      if (self.tagMode === 'video' && videoInfo.frameType === 'I') {
        // VP9/AV1: no spsParser-equivalent instance to reuse (see
        // parseNonSpsFrameSize) — the codec-info string is built directly
        // from the fields getFrameSizeInfo already parsed onto videoInfo,
        // via the same builder WebCodecsVideoDecoder-adjacent code uses.
        if (streamData.codecType === 'VP9') {
          videoInfo.codecInfo = buildVP9CodecString(videoInfo.profile ?? 0, videoInfo.bitDepth ?? 8);
        } else if (streamData.codecType === 'AV1') {
          const bitDepth = videoInfo.highBitdepth === 1 ? (videoInfo.twelveBit === 1 ? 12 : 10) : 8;
          videoInfo.codecInfo = buildAV1CodecString(videoInfo.profile ?? 0, videoInfo.seqLevelIdx0 ?? 0, videoInfo.seqTier0 ?? 0, bitDepth);
        } else if (streamData.codecType === 'VP8') {
          // VP8 never reaches a real-MSE tier (no vp08 stsd branch in
          // mp4Generator.js — VP8-in-MP4 was never a real browser-invested
          // combination) — tagMode 'video' here means bridge-only, which
          // doesn't need an MSE codecs string at all.
        } else if (streamData.codecType === 'H264') {
          videoInfo.codecInfo = self.spsParser!.getCodecInfo();
          videoInfo.profileIdc = (self.spsParser as H264SPSParser).getSpsValue('profile_idc');
          videoInfo.levelIdc = (self.spsParser as H264SPSParser).getSpsValue('level_idc');
        } else if (streamData.codecType === 'H265') {
          videoInfo.codecInfo = self.spsParser!.getCodecInfo();
          videoInfo.profileTierLevel = (self.spsParser as H265SPSParser).getProfileTierLevel();
        }
      }
      const isBufferManagerAvailable = self.checkBufferManagerAvailable(playMode, streamData.codecType);
      if (self.stepFlag === true) {
        if (self.deviceType === 'camera') {
          const ret = self.player.bufferingVideoData(playMode, streamData, videoInfo);
          if (ret === false && self.stepStatus === 'request') {
            self.stepStatus = 'complete';
            self.stepRequestCallback?.('complete');
            self.player.controlStepPlay(self.lastRenderingTime, self.stepCmd);
          }
        } else {
          self.player.onVideoData?.(playMode, streamData, videoInfo);
          self.stepStatus = 'complete';
          self.stepRequestCallback?.('complete');
        }
      } else if (self.stepFlag === false && isBufferManagerAvailable === false) {
        self.player.onVideoData?.(playMode, streamData, videoInfo);
      } else {
        self.player.sendToBufferManager(playMode, streamData, videoInfo, self.errorCallback);
      }
    }

    if (backupData !== null) {
      streamData.frameData = backupData;
      videoInfo.playMode = playMode;
      self.backupProvider?.onVideoData(streamData, videoInfo);
    }
  }

  private handleAudioData(session: SessionContext, playMode: string, streamData: AudioStreamData, audioInfo: AudioInfo): void {
    const self = this;
    if (self.activeSessions.audio.rtp !== null && self.activeSessions.audio.rtp.interleavedId !== session.interleavedId) {
      self.activeSessions.audio.rtp.stopStatisticsTimer();
      session.startStatisticsTimer();
    }
    self.activeSessions.audio.rtp = session;
    self.activeSessions.audio.rtcp = session.rtcpSession;

    if (self.audioNTPDateTime && self.rtcpTSaudio && streamData.timeStamp.rtpTimestamp && playMode === 'Live') {
      streamData.timeStamp.utcTimeStamp = self.audioNTPDateTime.utc.valueOf() + (streamData.timeStamp.rtpTimestamp - Number(self.rtcpTSaudio));
      streamData.timeStamp.timestamp = Math.trunc(streamData.timeStamp.utcTimeStamp / 1000);
      streamData.timeStamp.timestamp_usec = streamData.timeStamp.utcTimeStamp % 1000;
      streamData.timeStamp.utcDatetime = new Date(streamData.timeStamp.utcTimeStamp);
    }

    let backupData: Uint8Array | null = null;
    try {
      if (self.isBackup === true && self.backupProvider !== null) {
        backupData = self.factories.cloneArray(streamData.frameData);
      }

      if (self.player && self.player.onAudioData) {
        self.player.onAudioData(playMode, streamData, audioInfo);
      } else if (!self.mute) {
        if (self.audioPlayer === null || typeof self.audioPlayer === 'undefined') {
          self.createAudioPlayer();
        }
        if (
          self.audioPlayer !== null &&
          (self.audioCodec !== streamData.codecType || (streamData.codecType === 'G726' && self.audioBitrate !== audioInfo.bitrate))
        ) {
          self.audioCodec = streamData.codecType;
          self.audioBitrate = audioInfo.bitrate ?? null;
          self.audioPlayer.setInitVideoTimeStamp(0);
          self.audioPlayer.audioInit(streamData.codecType, streamData.codecMime, audioInfo.bitrate, self.getAudioVolume());
          self.audioPlayer.channelId = self.channelId;
          self.audioPlayer.Play();
        }
      }

      if (self.audioPlayer !== null && self.audioPlayer.isInit() === true && self.audioPlayer.channelId === self.channelId) {
        if (self.isBackup === false || playMode === 'Live') {
          if (streamData.codecType === 'AAC' && streamData.ADTs) {
            const tmp = new Uint8Array(streamData.ADTs.length + streamData.frameData.length);
            tmp.set(streamData.ADTs, 0);
            tmp.set(streamData.frameData, streamData.ADTs.length);
            streamData.frameData = tmp;
          }
          self.audioPlayer.BufferAudio(streamData.frameData, streamData.timeStamp.rtpTimestamp);
          self.audioPlayer.setBufferingFlag(streamData.timeStamp.rtpTimestamp, 'currentTime');
        }
      }
      if (backupData !== null) {
        streamData.frameData = backupData;
        self.backupProvider?.receiveAudioData(streamData, audioInfo);
      }
    } catch (error) {
      const err = error as { errorCode?: unknown; message?: string };
      throw new RTSPOverWebSocketError({
        channelId: self.channelId,
        errorCode: fromHex('0x030B'),
        place: 'MediaRouter.ts:onAudioData',
        message: 'onAudioData from mediaRouter: errorcode [' + err.errorCode + '], message [' + err.message + ']'
      });
    }
  }

  private handleMetadata(session: SessionContext, metadata: MetadataFrame): void {
    if (this.activeSessions.meta.rtp !== null && this.activeSessions.meta.rtp.interleavedId !== session.interleavedId) {
      this.activeSessions.meta.rtp.stopStatisticsTimer();
      session.startStatisticsTimer();
    }
    this.activeSessions.meta.rtp = session;
    this.activeSessions.meta.rtcp = session.rtcpSession;

    if (this.metaDataParser !== null) {
      this.metaDataParser.parse(metadata.frameData);
    }
  }

  private handleRtcpData(session: SessionContext): void {
    const timeData = session.timeData!;
    const utcDatetime = new Date((timeData.timestamp ?? 0) * 1000 + (timeData.timestamp_usec ?? 0));

    if (session.type === 'video') {
      this.videoNTPDateTime = { timestamp: timeData.timestamp, timestamp_usec: timeData.timestamp_usec, utc: utcDatetime };
      this.rtcpTSvideo = session.rtpTimestamp;
    } else if (session.type === 'audio') {
      this.audioNTPDateTime = { timestamp: timeData.timestamp, timestamp_usec: timeData.timestamp_usec, utc: utcDatetime };
      this.rtcpTSaudio = session.rtpTimestamp;
    }
    // NOTE: legacy's `else if (this.type === 'meta')` branch here just
    // records into the confirmed-dead metaNTPDateTime/rtcpTSmeta fields
    // (see field comment above) — dropped along with them.
  }

  onWaiting(waiting: WaitingEvent): void {
    if (this.player !== null && typeof this.player !== 'undefined') {
      this.player.onWaitingPackets(waiting);
    }

    this.errorCallback?.({
      channelId: this.channelId,
      errorCode: fromHex('0x0107'),
      codec: waiting.codec,
      media: waiting.media,
      waiting: waiting.islost,
      duration: waiting.duration,
      description: 'rtp packet lost message',
      place: 'MediaRouter.ts:onWaiting'
    });

    if (this.player !== null && typeof this.player !== 'undefined' && waiting.media === 'video' && this.supportCovertAndOff) {
      this.player.close();
      this.player = null;
    }
  }

  controlAudioPlayer(data: 'on' | 'off' | 'mute' | 'unmute' | number | string): void {
    if (this.audioPlayer !== null) {
      if (data === 'on' || data === 'unmute') {
        this.mute = false;
      } else if (data === 'off' || data === 'mute') {
        this.mute = true;
      } else if (Number.isInteger(Number(data))) {
        this.setAudioVolume(Number(data));
        this.audioPlayer.ControlVolume(data);
      } else {
        throw new RTSPOverWebSocketError({ channelId: this.channelId, errorCode: fromHex('0x030E'), place: 'MediaRouter.ts:362', message: 'audio volume do not set' });
      }
    } else {
      this.player?.ControlVolume?.(data);
      if (data === 'on' || data === 'unmute') {
        this.mute = false;
      } else if (data === 'off' || data === 'mute') {
        this.mute = true;
      }
      if (!(data === 'on' || data === 'off' || data === 'mute' || data === 'unmute')) {
        if (Number.isInteger(Number(data))) {
          this.setAudioVolume(Number(data));
        } else {
          throw new RTSPOverWebSocketError({ channelId: this.channelId, errorCode: fromHex('0x030E'), place: 'MediaRouter.ts:389', message: 'audio volume do not set' });
        }
      }
    }
  }

  createAudioPlayer(): void {
    if (this.audioPlayer === null) {
      this.audioPlayer = this.factories.createAudioPlayer();
      this.audioPlayer.channelId = this.channelId;
      if (this.getAudioVolume() !== 0) {
        this.audioPlayer.ControlVolume(this.getAudioVolume());
      }
    }
  }

  deleteAudioPlayer(): void {
    if (this.audioPlayer !== null) {
      this.audioPlayer.Stop();
      this.audioPlayer.terminate();
      this.audioPlayer = null;
      this.audioCodec = null;
      this.audioBitrate = null;
    }
  }

  startAudioTalk(sendAudioTalkBuffer: (data: Float32Array) => void): Promise<number> {
    const self = this;
    return new Promise<number>((resolve, reject) => {
      self.audioTalker = self.factories.createTalk();
      self.audioTalker.channelId = self.channelId;

      if (self.audioTalker.init()) {
        self.audioTalker.setSendAudioTalkBufferCallback(sendAudioTalkBuffer);
        self.audioTalker
          .initAudioOut()
          .then((sampleRate) => resolve(sampleRate))
          .catch((error: unknown) => {
            if (error instanceof RTSPOverWebSocketError) {
              self.errorCallback?.({
                errorCode: fromHex('0x0211'),
                description: 'Talk service unavailable, Microphone device not found.',
                place: 'mediaRouter:startAudioTalk',
                channelId: self.channelId
              });
            } else {
              self.errorCallback?.({
                errorCode: fromHex('0x020A'),
                description: 'Talk service unavailable',
                place: 'mediaRouter:startAudioTalk',
                channelId: self.channelId
              });
              reject(new Error('Failure'));
            }
          });
      } else {
        self.errorCallback?.({
          errorCode: fromHex('0x020A'),
          description: 'Talk service unavailable',
          place: 'mediaRouter:startAudioTalk',
          channelId: self.channelId
        });
        reject(new Error('Web Audio API is not supported in this web browser'));
      }
    });
  }

  onStatistics(statistics: RtpStatistics): void {
    if (statistics.media === 'video') {
      if (this.player !== undefined && this.player !== null) {
        this.player.rfps = statistics.fps;
      }
      this.changeBoxSize(statistics.fps);
    }
    this.statisticsCallback?.(statistics);
  }

  changeBoxSize(fps: number): void {
    if (this.player !== undefined && this.player !== null) {
      /* eslint-disable no-magic-numbers */
      if (fps > 55 && this.player.boxsize !== Math.trunc(fps / 5)) {
        this.player.boxsize = Math.trunc(fps / 5);
      } else if (fps > 45 && fps <= 55 && this.player.boxsize !== 6) {
        this.player.boxsize = 6;
      } else if (fps > 35 && fps <= 45 && this.player.boxsize !== 5) {
        this.player.boxsize = 5;
      } else if (fps > 25 && fps <= 35 && this.player.boxsize !== 4) {
        this.player.boxsize = 4;
      } else if (fps > 15 && fps <= 25 && this.player.boxsize !== 3) {
        this.player.boxsize = 3;
      } else if (fps > 5 && fps <= 15 && this.player.boxsize !== 2) {
        this.player.boxsize = 2;
      } else if (fps < 5 && this.player.boxsize !== 1) {
        this.player.boxsize = 1;
      }
      /* eslint-enable no-magic-numbers */
    }
  }

  sendCommandData(type: MediaRouterCommandType, data: unknown): boolean | void {
    switch (type) {
      case 'capture':
        if (this.player !== null) {
          if (this.captureCallback) this.player.addEventListener('capture', this.captureCallback);
          this.player.capture(data);
        }
        break;
      case 'backup': {
        const backupData = data as BackupCommandData;
        if (backupData.command === 'start') {
          this.isBackup = true;
          this.backupProvider = this.factories.createBackupProvider(backupData.callback);
          this.backupProvider.channelId = this.channelId;
          this.backupProvider.deviceType = this.deviceType;
          this.backupProvider.init(backupData);
        } else if (this.backupProvider !== null && backupData.command === 'stop') {
          this.isBackup = false;
          this.backupProvider.closeStream();
        }
        break;
      }
      case 'forward':
        this.stepCmd = 'forward';
        if (this.stepFlag === false) {
          this.stepRequest();
        } else if (!this.player!.forward()) {
          this.stepStatus = 'request';
          this.stepRequestCallback?.('request', this.stepObj);
        }
        break;
      case 'backward':
        this.stepCmd = 'backward';
        if (this.stepFlag === false) {
          this.stepRequest();
        } else if (!this.player!.backward()) {
          this.stepStatus = 'request';
          this.stepRequestCallback?.('request', this.stepObj);
        }
        break;
      case 'speed':
        this.speedValue = data as number;
        if (this.player !== null && this.tagMode === 'video') {
          this.player.speed = data as number;
        }
        this.dropOut = 1;
        if (this.speedValue >= ULTRA_SPEED || this.speedValue <= -1 * ULTRA_SPEED) {
          this.dropOut = DROP_OUT_LEVEL;
        }
        break;
      case 'pause':
        if (this.player !== null) {
          this.player.pause();
          return true;
        }
        return false;
      case 'resume':
        if (this.stepFlag === true) {
          this.stepFlag = false;
          this.initVideoPlayer();
        } else {
          if (this.player !== null) {
            this.player.resume();
          }
          if (data === true) {
            this.initVideoPlayer();
          }
        }
        break;
      case 'seek':
        if (this.player && this.player.speed !== data) {
          this.player.speed = data as number;
        }
        this.speedValue = data as number;
        this.dropOut = 1;
        this.initVideoPlayer();
        break;
      case 'audioIn':
        this.controlAudioPlayer(data as 'on' | 'off' | 'mute' | 'unmute' | number | string);
        break;
      case 'digitalZoom':
        if (this.player !== null && this.tagMode !== 'video') {
          this.player.digitalZoom(data);
        }
        break;
      case 'clearBuffer':
        if (this.stepFlag === true) {
          this.player!.clearBuffer();
          this.stepFlag = false;
        }
        break;
      case 'minimap':
        this.handleMinimapCommand(data as MinimapCommandData);
        break;
      case 'requestTimeChanged':
        if (this.browserType !== 'firefox') {
          this.requestTime = data;
        }
        break;
      case 'instantplayback':
        if (this.player !== null) {
          this.player.instantplaybackCmd(data);
        }
        break;
      default:
        break;
    }
    return undefined;
  }

  private handleMinimapCommand(data: MinimapCommandData): void {
    if (data.mode === 'on') {
      if (typeof data.interval !== 'undefined' && data.interval !== null) {
        this.minimapRefreshInterval = data.interval;
      }
      if (this.player !== null) {
        this.player.updateMiniMapInfo({ mode: 'draw', target: this.minimapTarget });
      }
      if (this.minimapUpdateTimer) {
        clearInterval(this.minimapUpdateTimer);
        this.minimapUpdateTimer = null;
      }
      this.minimapUpdateTimer = setInterval(() => {
        if (this.player) {
          this.player.updateMiniMapInfo({ mode: 'draw', target: this.minimapTarget });
        }
      }, this.minimapRefreshInterval);
      this.minimapTarget = data.target || null;
    } else if (data.mode === 'off') {
      if (this.minimapUpdateTimer) clearInterval(this.minimapUpdateTimer);
      this.minimapUpdateTimer = null;
      this.minimapTarget = null;
      this.minimapRefreshInterval = DEFAULT_MINIMAP_REFRESH_INTERVAL;
    }
    if (this.player !== null) {
      this.player.updateMiniMapInfo(data);
    }
  }

  addListener(type: MediaRouterListenerType, func: (...args: unknown[]) => void, data?: unknown): void {
    switch (type) {
      case 'timeStamp':
        this.timeStampCallback = func as (timeStamp: unknown, stepFlag: boolean) => void;
        break;
      case 'resize':
        this.resizeCallback = func as (info: VideoResizeInfo) => void;
        break;
      case 'stepRequest':
        this.stepRequestCallback = func as (status: string, data?: unknown) => void;
        this.stepObj = data;
        break;
      case 'metaEvent':
        this.metaDataParser = this.factories.createMetaDataParser(func);
        this.metaDataParser.channelId = this.channelId;
        this.metaDataParser.deviceType = this.deviceType;
        break;
      case 'metaImageEvent':
        this.metaImageCallback = func;
        break;
      case 'videoMode':
        this.videoModeCallback = func;
        break;
      case 'rtpClient':
        this.rtpClientCallback = func as (msgType: string, data: unknown) => void;
        break;
      case 'error':
        this.errorCallback = func as (event: MediaRouterErrorEvent) => void;
        break;
      case 'statistics':
        this.statisticsCallback = func as (statistics: RtpStatistics) => void;
        break;
      case 'capture':
        this.captureCallback = func;
        break;
      case 'instantplayback':
        this.instantplaybackCallback = func;
        break;
      case 'gotAudioSupport':
        this.gotAudioSupportCallback = func as (supported: boolean) => void;
        break;
      default:
        break;
    }
  }

  terminate(func?: () => void): void {
    if (this.player !== null) {
      this.player.close();
      this.player = null;
      this.videoCodec = null;
      this.videoSize = null;
      this.videoWidth = null;
      this.videoHeight = null;
    }

    this.deleteAudioPlayer();

    if (this.audioTalker !== null) {
      this.audioTalker.terminate();
      this.audioTalker = null;
    }
    if (this.rtpClientCallback !== null) {
      this.rtpClientCallback('close', '');
    }
    if (this.currentProfile.isLimitSpeed === true) {
      this.currentProfile.isLimitSpeed = false;
      this.errorCallback?.({
        errorCode: fromHex('0x0302'),
        oldErrorCode: '103',
        isLimit: false,
        description: 'default speed list',
        place: 'MediaRouter.ts:1011',
        channelId: this.channelId
      });
    }
    this.videoElement = undefined;
    this.stepFlag = false;
    this.resizeCallback = null;
    this.defaultVideoTagMode = null;
    this.audioshift = 0;

    if (typeof func === 'function') {
      func();
    }
  }

  getVideoPlayer(): VideoPlayerLike | null {
    return this.player;
  }
  getVideoWidth(): number | null {
    return this.videoWidth;
  }
  getVideoHeight(): number | null {
    return this.videoHeight;
  }
  getVideoCodecType(): string | null {
    return this.videoCodec;
  }
  setMaxInstantPlaybackTime(thresholdInstantPlayback: number): void {
    this.minRemainTime = thresholdInstantPlayback;
  }
  getMaxInstantPlaybackTime(): number {
    return this.minRemainTime;
  }
  setBufferClearInterval(interval: number): void {
    this.minTimerInterval = interval;
  }
  getBufferClearInterval(): number {
    return this.minTimerInterval;
  }
  gotAudioSupport(audioSupport: boolean): void {
    this.gotAudioSupportCallback?.(audioSupport);
  }
  setAudioVolume(volume: number): void {
    this.audioVolume = volume;
  }
  getAudioVolume(): number {
    return this.audioVolume;
  }
  setProfile(profile: unknown): void {
    this.profile = profile;
  }
  getProfile(): unknown {
    return this.profile;
  }
  setElement(element: unknown): void {
    this.domElement = element;
  }
  getElement(): unknown {
    return this.domElement;
  }
  initializeNTPTimestamp(): void {
    this.videoNTPDateTime = null;
    this.rtcpTSvideo = undefined;
    this.rtcpTSaudio = undefined;
    this.audioNTPDateTime = null;
  }
  toogleControls(flags: unknown): void {
    if (typeof this.player !== 'undefined' && this.player !== null) {
      this.player.toggleControls(flags);
    }
  }

  selectVideoElement(mode: string): Element | undefined {
    this.videoModeCallback?.({ type: 'videomode', channelId: this.channelId, elementId: this.getElement(), mode });

    if (mode === 'canvas') {
      this.videoElement =
        getElementByAttributeValue('canvas', 'rtsp-channel-mapped-id', this.getElement()) ??
        getElementByAttributeValue('canvas', 'rtsp-channel-mapped-id', this.channelId) ??
        getElementByAttributeValue('canvas', 'rtsp-channel-id', this.channelId);
    } else {
      this.videoElement =
        getElementByAttributeValue('video', 'rtsp-channel-mapped-id', this.getElement()) ??
        getElementByAttributeValue('video', 'rtsp-channel-mapped-id', this.channelId) ??
        getElementByAttributeValue('video', 'rtsp-channel-id', this.channelId);
    }

    if (typeof this.videoElement === 'undefined' || this.videoElement === null) {
      this.errorCallback?.({
        errorCode: mode === 'video' ? fromHex('0x0900') : fromHex('0x0901'),
        mode: mode === 'video' ? 'video' : 'canvas',
        description: 'The video tag player does not find from your document.',
        place: 'MediaRouter.ts:setVideoMode',
        channelId: this.channelId
      });
    }
    return this.videoElement;
  }

  selectVideoPlayer(channelid: number, playMode: string, codecType: string, size: number, framerate: number | undefined): VideoPlayerLike | null {
    if (this.player !== null) {
      this.player.close();
      this.player = null;
    }
    void channelid;
    void framerate;

    this.tagMode = 'canvas';
    if (this.stepFlag === true) {
      return this.factories.createCanvasPlayer();
    }
    if (playMode === 'Playback') {
      this.checkValidSpeed(codecType, size);
    }

    switch (codecType) {
      case 'MJPEG':
        this.tagMode = 'canvas';
        break;
      case 'H264':
      case 'H265': {
        const mimeType = `video/mp4;codecs="${this.spsParser!.getCodecInfo()}"`;
        const mediaSourceIsTypeSupported = (globalThis as unknown as { MediaSource?: { isTypeSupported(t: string): boolean } }).MediaSource
          ?.isTypeSupported;
        if (mediaSourceIsTypeSupported?.(mimeType)) {
          if (codecType === 'H264') {
            if (this.defaultVideoTagMode !== null) {
              this.tagMode = this.defaultVideoTagMode as 'canvas' | 'video';
            } else if (this.deviceType === 'nvr') {
              this.tagMode = 'video';
            } else {
              this.tagMode = size > LIMIT_SIZE[playMode] ? 'video' : 'canvas';
            }
          } else {
            this.tagMode = 'video';
          }
        } else {
          if ((codecType === 'H264' && size > FHD_SIZE) || (codecType === 'H265' && (this.spsParser as H265SPSParser).getProfileName() !== 'Main')) {
            this.errorCallback?.({
              errorCode: fromHex('0x0301'),
              oldErrorCode: '996',
              description: 'Not enough decoding for currnet profile, Change UWA profile',
              place: 'MediaRouter.ts:331',
              channelId: this.channelId
            });
          } else if (this.deviceType === 'nvr' && codecType === 'H264') {
            this.tagMode = 'video';
          } else {
            this.tagMode = 'canvas';
          }
        }
        break;
      }
      case 'VP9':
      case 'AV1': {
        const mediaSourceIsTypeSupported = (globalThis as unknown as { MediaSource?: { isTypeSupported(t: string): boolean } }).MediaSource
          ?.isTypeSupported;
        const hasBridgeSupport = typeof (globalThis as unknown as { MediaStreamTrackGenerator?: unknown }).MediaStreamTrackGenerator !== 'undefined';
        const candidateCodec = defaultRealMseCodecString(codecType);
        const realMseSupported = candidateCodec !== null && mediaSourceIsTypeSupported?.(`video/mp4;codecs="${candidateCodec}"`) === true;
        this.tagMode = realMseSupported || hasBridgeSupport ? 'video' : 'canvas';
        break;
      }
      case 'VP8': {
        // No real-MSE tier for VP8 (see defaultRealMseCodecString) — only
        // ever reaches 'video' via the WebCodecs-bridge tier.
        const hasBridgeSupport = typeof (globalThis as unknown as { MediaStreamTrackGenerator?: unknown }).MediaStreamTrackGenerator !== 'undefined';
        this.tagMode = hasBridgeSupport ? 'video' : 'canvas';
        break;
      }
      default:
        break;
    }

    let player: VideoPlayerLike;
    if (this.tagMode === 'video') {
      player = this.factories.createVideoPlayer();
      this.deleteAudioPlayer();
      if (this.requestTime && player.setRequestTime) {
        player.setRequestTime(this.requestTime);
      }
    } else {
      player = this.factories.createCanvasPlayer();
    }

    if (this.deviceType === 'nvr') {
      player.setDefaultDelay(1.0);
    }

    player.type = this.tagMode;
    player.framedrop = this.framedropInit;
    if (this.statisticsCallback) player.addEventListener('statistics', this.statisticsCallback);
    if (this.captureCallback) player.addEventListener('capture', this.captureCallback);
    if (this.instantplaybackCallback) player.addEventListener('instantplayback', this.instantplaybackCallback);

    player.setMaxInstantPlayback(this.getMaxInstantPlaybackTime());
    player.setBufferClearInterval(this.getBufferClearInterval());
    player.boxsize = this.boxsize;

    return player;
  }

  checkVideoResolution(codec: string, info: VideoInfo): boolean | 'Over4K' {
    const width = info.width ?? 0;
    const height = info.height ?? 0;
    const size = width * height;

    if (this.tagMode === 'video') {
      if (size > this.getMaxResolutionSize()) {
        return 'Over4K';
      } else if (width > VIDEO_TAG_LIMIT_WIDTH) {
        return 'Over4K';
      } else if (
        codec === 'H265' &&
        ((globalThis as unknown as { window?: { jscd?: { browser?: string } } }).window?.jscd?.browser ?? '').indexOf('Chromium') !== -1 &&
        (width > VIDEO_TAG_LIMIT_WIDTH || height > VIDEO_TAG_LIMIT_HEIGHT_FOR_FIREFOX_OR_EDGE)
      ) {
        return false;
      }
      return true;
    }
    return true;
  }

  initVideoPlayer(): void {
    if (this.player !== null) {
      this.player.close();
    }
    this.player = null;
    this.videoSize = null;
    this.videoCodec = null;
    this.audioCodecHint = null;
    this.tagMode = 'canvas';
  }

  /** Learned from SDP (well before any RTP data arrives) — see the
   * `audioCodecHint` field comment. `codecType` matches the strings
   * `AudioStreamData.codecType`/`setAudioInfo()` use ('OPUS'/'AAC'/'G711'/
   * 'G726'), not the raw SDP codec name. */
  setAudioCodecHint(codecType: string): void {
    this.audioCodecHint = codecType;
  }

  stepRequest(): void {
    this.stepStatus = 'request';
    this.stepFlag = true;
    this.initVideoPlayer();
    this.stepRequestCallback?.('request', this.stepObj);
  }
}
