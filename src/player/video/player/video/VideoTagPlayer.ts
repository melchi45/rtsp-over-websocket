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
import { WebCodecsVideoDecoder } from '../../../worker/videoDecoder/WebCodecsVideoDecoder';
import { WebCodecsVideoEncoder, type WebCodecsEncodedResult } from '../../../worker/videoEncoder/WebCodecsVideoEncoder';
import { defaultRealMseCodecString } from '../../../util/codecString';
import { parseAvcConfigurationRecord, buildAvc1CodecString, type AvcConfigurationRecord } from '../../../util/avcConfigParser';
import type { MediaStreamVideoTrackGenerator } from '../../../types/mediaStreamTrackGenerator';

export type AudiotranscoderWorkerFactory = () => Worker;

export interface BrowserInfo {
  os: string;
  browser: string;
  osVersion: string;
  browserVersion: string;
}

/**
 * Reads `window.jscd` (the legacy player’s Util/util's `window.jscd =
 * getJsClientDetection();`, a ~200-line browser-sniffing function). It's
 * genuinely defined in legacy (found at util:91, called at util:280 —
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
// Opus's most common frame size (20ms @ 48000Hz, RFC 7587's fixed clock) —
// same default OPUSAudioDecoder.ts uses before it knows the real per-packet
// sample count. Opus packets can carry other durations (2.5-60ms), so this
// is only a fallback for computing an initial samplingDuration, same role
// AAC_FRAME_SAMPLES plays below.
const OPUS_FRAME_SAMPLES = 960;
const MAX_PLAYBACK_DIFF = 1500;
const MAX_CUE_COUNT = 100;
const PREFIX_SIZE = 4;
// Roughly a 2s GOP at a common ~30fps MJPEG source -- MJPEG itself has no
// GOP concept (every source frame is already a complete JPEG "I-frame"), so
// this is purely for the *encoded H264* stream's own seekability/error-
// resilience, same reasoning any live H264 encoder GOP setting would use.
const MJPEG_ENCODER_KEYFRAME_INTERVAL = 60;
// encodeQueueSize threshold past which onVideoData() starts dropping new
// MJPEG frames rather than submitting them to the encoder -- small and
// real-time-oriented, matching this tier's live-playback intent rather than
// buffering for eventual catch-up.
const MJPEG_ENCODER_MAX_QUEUE_SIZE = 2;

/** One JPEG frame already handed to `mjpegEncoder.encode()`, awaiting that
 *  frame's own async `EncodedVideoChunk` output -- see
 *  `onMjpegEncodedChunk()`. Keeps the *original* RTP-derived `streamData`/
 *  `videoInfo` (real presentation timing), not the encoder's own
 *  `timestampUs` (a purely internal WebCodecs bookkeeping value used only
 *  to match a chunk back to this entry). */
interface MjpegPendingFrame {
  timestampUs: number;
  streamData: VideoStreamData;
  videoInfo: VideoInfo;
}

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
  /** Composition-time-offset (PTS - DTS), TIME_SCALE units — see getVideoCompositionTimeOffset(). */
  compositionTimeOffset?: number;
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
  // onSeeking, grep-confirmed never read anywhere in videoTagPlayer
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
  // variables too: videoPlayer's `_speedValue` (behind the `speed`
  // accessor) and videoTagPlayer's own `speedValue`, kept in sync only
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

  // WebCodecs-bridge tier (VP8/VP9/AV1, when a real-MSE `vp09`/`av01` stsd
  // entry isn't supported, or never exists at all for VP8 — see
  // decideUseBridge()). Runs entirely on the main thread: `MediaStreamTrackGenerator`
  // is confirmed NOT constructible inside a dedicated Worker in at least one
  // real Chromium build, despite the spec allowing that exposure. No MSE
  // machinery (sourceBuffer/mediaSource above) is used in this mode at all —
  // `videoElement.srcObject` is set directly from `bridgeTrackGenerator`,
  // and decoded frames flow into it via `bridgeWriter`, bypassing the
  // MP4-muxing path (createSampleFrameData/createVideoSample/createInitSegment)
  // entirely.
  private useBridge = false;
  private bridgeDecoder: WebCodecsVideoDecoder | null = null;
  private bridgeTrackGenerator: MediaStreamVideoTrackGenerator | null = null;
  private bridgeWriter: WritableStreamDefaultWriter<VideoFrame> | null = null;

  // MJPEG real-MSE tier via H264 re-encoding (see decideUseMjpegEncoder()/
  // setupMjpegEncoder()/onMjpegEncodedChunk()). Unlike the bridge tier above,
  // this one DOES use the same MP4-muxing machinery every other real-MSE
  // codec does (sourceBuffer/mediaSource/createVideoSample()/
  // createInitSegment()) -- the only difference is an extra async encode
  // step between a raw JPEG frame arriving and a muxable H264 sample
  // existing. mjpegPendingFrames bridges that gap: WebCodecsVideoEncoder's
  // encode() is fire-and-forget, so onVideoData() can't just call
  // createVideoSample() synchronously the way it does for every other
  // codec -- it has to wait for that same frame's own EncodedVideoChunk to
  // arrive via onMjpegEncodedChunk(), in order (single VideoEncoder
  // instances preserve encode() call order in their output as long as no
  // B-frames are requested, which this class never does).
  private useMjpegEncoder = false;
  private mjpegEncoder: WebCodecsVideoEncoder | null = null;
  private mjpegAvcConfig: AvcConfigurationRecord | null = null;
  private readonly mjpegPendingFrames: MjpegPendingFrame[] = [];
  private mjpegNextTimestampUs = 0;
  private mjpegFramesSinceKeyFrame = 0;

  private segmentArray: Uint8Array[] = [];
  private sequenseNum = 1;
  private videoSamples: VideoSample[] = [];
  private audioSamples: AudioSample[] = [];
  private baseVideoTime = 0;
  private baseAudioTime = 0;
  private baseNTPTimestamp = 0;
  /** Live-mode CTS base: the first video sample's rtpTimestamp, so presentation time can be
   * measured on the same origin as baseVideoTime (a running sum of frameDuration values).
   * See getVideoCompositionTimeOffset(). */
  private presentationBaseRtpTimestamp: number | null = null;
  private boxStartTime: number[] = [];
  private lastBoxSize = 0;
  private fileName = '';
  private captureFlag = false;
  private timestampTextTrackId = -1;
  // Real gap, reported live: in Playback mode at a high requested device
  // Scale, timestamp cues can go missing far more often than at 1x. Playback
  // samples never actually go through getVideoFrameDuration() (that's only
  // called from createVideoSample()'s *Live* branch -- Playback's own path,
  // createSegment(), derives frameDuration purely from consecutive
  // videoSamples[].rtpTimestamp deltas, with no localSpeedValue involvement
  // at all) -- so a faster Playback speed only actually plays back faster if
  // the *device* itself reports compressed rtpTimestamp deltas, which this
  // class faithfully reproduces into an equally compressed muxed PTS. Each
  // resulting cue's real wall-clock span then shrinks the same way, and can
  // become narrower than the browser's own "time marches on" cue-dispatch
  // granularity -- a well-known WebVTT/TextTrack limitation (see
  // `startTimestampCuePolling()`'s own comment for why the obvious fix,
  // reading `TextTrack.activeCues` more often, doesn't actually help).
  // `lastReportedCue` dedupes `checkTimestampCueAtCurrentTime()`'s own
  // polling loop against onCueEnter() already having reported the same cue
  // normally -- both paths funnel through reportCueTimestamp(), which sets
  // this field.
  private lastReportedCue: VTTCue | null = null;
  private timestampCuePollHandle: number | null = null;
  private clearBufferFlag = false;
  // Temporary tracing for the Live-mode SourceBuffer-growth investigation --
  // see the 'updateend' case in sourceBufferEventListener and
  // checkBufferSize() below. To be stripped once the investigation
  // concludes.
  private traceDurationChangeCount = 0;
  private traceUpdateEndCount = 0;
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
  // Same idea as realAacActive, for Opus: unlike G.711/G.726, there's no
  // transcode-to-AAC fallback for it (Opus is muxed natively into the fMP4
  // — see mp4Generator.js's opusSample()/dOps()), so this is really just
  // "is the current audio track Opus" rather than "real vs. transcoded".
  private opusActive = false;
  // True when opusActive above was pre-seeded from audioCodecHint (see
  // init()) rather than confirmed by a real onAudioData call yet. Needed as
  // an extra switchingCodec input in setAudioInfo() so the *first* real Opus
  // audio-info call still runs its normal population branch (real
  // channelCount/sampleRate, createInitSegment()) — without this, comparing
  // only against opusActive would see "no change" (it already matches, from
  // the hint) and wrongly skip that branch. Only affects the Opus path;
  // AAC/G711/G726 are unaffected (their switchingCodec check never depended
  // on this).
  private opusActiveIsHintOnly = false;
  // What setSourceBuffer()/addSourceBuffer() actually declared the
  // SourceBuffer's audio codecs string as, at the moment it was created —
  // see setAudioInfo()'s use of this: MSE doesn't allow changing a
  // SourceBuffer's codecs after creation, and — unlike the video codec,
  // which is already known before the SourceBuffer is first created —
  // there's no ordering guarantee that the real audio codec is known that
  // early too, so this can legitimately end up permanently mismatched
  // against `opusActive` for a given connection.
  private sourceBufferAudioIsOpus = false;

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
        // Real bug, found live in Playback mode -- confirmed via a direct
        // trace that `durationchange` (this class's only other trigger for
        // videoUpdating(), via onDurationChange()) stops firing entirely
        // after the first handful of appended segments, even though
        // appendBuffer() keeps succeeding here on every subsequent
        // 'updateend' -- an MSE implementation detail for a continuously-
        // growing fragmented-MP4 stream, not something this class controls.
        // videoUpdating()'s Playback branch is the only place that
        // auto-resumes playback if the <video> element ever pauses itself
        // (a native buffering/waiting stall); it's also the only path that
        // invokes checkBufferSize()'s `sourceBuffer.remove()` trimming. Once
        // durationchange goes quiet, both stop -- which read live in
        // Playback as playback getting stuck/oscillating near a stale
        // position, and is suspected (pending the trace below) to cause
        // unbounded SourceBuffer growth in Live mode the same way, since
        // Live's only videoUpdating() trigger was still durationchange-only
        // until this change. 'updateend' fires reliably on every successful
        // append (confirmed by the same trace), so it's a much sturdier
        // trigger than durationchange ever was -- now used unconditionally
        // for both Live and Playback, rather than gated on playbackFlag
        // (videoUpdating() itself still branches on playbackFlag
        // internally for the rest of its behavior).
        this.traceUpdateEndCount++;
        // eslint-disable-next-line no-console
        this.debugLog.debug(`[trace] updateend #${this.traceUpdateEndCount} (playbackFlag=${this.playbackFlag}, durationchangeCount=${this.traceDurationChangeCount})`);
        this.videoUpdating();
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

  /**
   * Decides real-MSE vs. WebCodecs-bridge for VP8/VP9/AV1 (H264/H265/MJPEG
   * always use real MSE, matching this class's pre-existing behavior). Uses
   * `this.codec`, which `MediaRouter.handleVideoData` sets right before
   * calling `init()` specifically so this decision can be made this early —
   * before any `onVideoData` call, hence before any real keyframe has been
   * parsed. Only a coarse, profile-0/8-bit `MediaSource.isTypeSupported`
   * probe is possible at this point (see `defaultRealMseCodecString`); the
   * *exact* codec string built from the real parsed keyframe (once
   * available) is only needed later, for the real-MSE tier's actual
   * `SourceBuffer` mimeCodec (setSourceBuffer()), which already reads
   * `this.videoCodecInfo` — unaffected by this coarse probe.
   */
  private decideUseBridge(codecType: string | undefined): boolean {
    const hasBridgeSupport = typeof MediaStreamTrackGenerator !== 'undefined';
    if (codecType === 'VP8') {
      // No real-MSE tier for VP8 at all — see defaultRealMseCodecString.
      return hasBridgeSupport;
    }
    if (codecType === 'VP9' || codecType === 'AV1') {
      const candidate = defaultRealMseCodecString(codecType);
      const realMseSupported = candidate !== null && typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(`video/mp4;codecs="${candidate}"`);
      return !realMseSupported && hasBridgeSupport;
    }
    return false;
  }

  private setupBridge(codecType: string): void {
    this.bridgeTrackGenerator = new MediaStreamTrackGenerator({ kind: 'video' });
    this.bridgeWriter = this.bridgeTrackGenerator.writable.getWriter();
    this.bridgeDecoder = new WebCodecsVideoDecoder(codecType, {
      outputMode: 'bridge',
      onBridgeFrame: (frame) => {
        this.bridgeWriter?.write(frame).catch(() => {
          // The writer rejected (e.g. already closed/errored during
          // teardown) — the stream never took ownership of this frame, so
          // this class must close it itself to avoid leaking decoder
          // resources.
          frame.close();
        });
      }
    });
    (this.videoElement as HTMLVideoElement).srcObject = new MediaStream([this.bridgeTrackGenerator]);
  }

  private closeBridge(): void {
    if (this.bridgeDecoder !== null) {
      this.bridgeDecoder.close();
      this.bridgeDecoder = null;
    }
    if (this.bridgeWriter !== null) {
      this.bridgeWriter.close().catch(() => {});
      this.bridgeWriter = null;
    }
    this.bridgeTrackGenerator = null;
  }

  /** MJPEG-only counterpart to decideUseBridge() above. Simpler than that
   *  one: there's no bridge-style fallback tier for an *encode* direction
   *  (MediaStreamTrackGenerator bridges decoded frames into a <video>, it
   *  can't produce the H264 bitstream this tier needs), so this either can
   *  run or this class shouldn't have been selected as the player at all --
   *  MediaRouter.ts's selectVideoPlayer() already made that same
   *  VideoEncoder-support check once to decide tagMode itself, before this
   *  player was constructed; this re-derives it independently rather than
   *  trusting that decision blindly, matching decideUseBridge()'s own style. */
  private decideUseMjpegEncoder(codecType: string | undefined): boolean {
    return codecType === 'MJPEG' && typeof VideoEncoder !== 'undefined';
  }

  private setupMjpegEncoder(width: number, height: number): void {
    this.mjpegEncoder = new WebCodecsVideoEncoder(width, height, {
      onEncodedChunk: (result) => this.onMjpegEncodedChunk(result),
      onError: (error) => {
        // eslint-disable-next-line no-console
        console.error('[VideoTagPlayer] MJPEG WebCodecsVideoEncoder error:', error);
      }
    });
  }

  /** The async-replay half of the MJPEG-encoder tier -- matches an
   *  `EncodedVideoChunk` result back to the `mjpegPendingFrames` entry it
   *  belongs to (by the `timestampUs` this class itself assigned when
   *  calling `encode()`), then feeds it through the SAME real-MSE ingestion
   *  every other codec's `onVideoData()` branch uses (`setVideoInfo()` +
   *  `initBaseNTPTimestamp()` + `createInitSegment()` once, on the first
   *  keyframe; `createVideoSample()` every time) -- see `ingestVideoSample()`. */
  private onMjpegEncodedChunk(result: WebCodecsEncodedResult): void {
    const pendingIndex = this.mjpegPendingFrames.findIndex((entry) => entry.timestampUs === result.timestampUs);
    if (pendingIndex === -1) {
      // No matching pending entry -- the encoder's output order desynced
      // from what was submitted (e.g. a mid-flight `error` callback silently
      // dropped one or more `encode()` calls' output entirely). Dropping
      // this one chunk is safer than guessing which frame it actually
      // belongs to and muxing it with the wrong timing/videoInfo.
      // eslint-disable-next-line no-console
      console.error('[VideoTagPlayer] MJPEG encoder output has no matching pending frame (timestampUs mismatch) -- dropping chunk');
      return;
    }
    const [pending] = this.mjpegPendingFrames.splice(pendingIndex, 1);

    if (result.description !== null) {
      const avcConfig = parseAvcConfigurationRecord(result.description);
      if (avcConfig !== null) {
        this.mjpegAvcConfig = avcConfig;
      }
    }

    if (this.mjpegAvcConfig === null) {
      // The very first chunk should always carry a description (WebCodecs
      // attaches decoderConfig whenever a VideoEncoder first starts
      // producing output) -- if it somehow didn't, there's nothing safe to
      // mux yet (setVideoInfo()'s H264 branch needs real sps/pps/profileIdc/
      // levelIdc), so this frame is dropped rather than muxed with garbage.
      // eslint-disable-next-line no-console
      console.error('[VideoTagPlayer] MJPEG encoder produced a chunk before any avcC config was seen -- dropping');
      return;
    }

    const streamData: VideoStreamData = { ...pending.streamData, codecType: 'H264', frameData: result.frameData };
    const videoInfo: VideoInfo = {
      ...pending.videoInfo,
      frameType: result.type === 'key' ? 'I' : 'P',
      spsPayload: this.mjpegAvcConfig.sps[0],
      ppsPayload: this.mjpegAvcConfig.pps[0],
      profileIdc: this.mjpegAvcConfig.profileIdc,
      levelIdc: this.mjpegAvcConfig.levelIdc,
      codecInfo: buildAvc1CodecString(this.mjpegAvcConfig)
    };

    this.ingestVideoSample(streamData, videoInfo, /* isEncoderSourced */ true);
  }

  private closeMjpegEncoder(): void {
    this.mjpegEncoder?.close();
    this.mjpegEncoder = null;
    this.mjpegAvcConfig = null;
    this.mjpegPendingFrames.length = 0;
    this.mjpegNextTimestampUs = 0;
    this.mjpegFramesSinceKeyFrame = 0;
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

  /** Shared by onCueEnter() (normal path -- the browser actually witnessed
   *  this cue's start) and checkTimestampCueAtCurrentTime() (pull-based
   *  fallback for a cue whose enter/exit got skipped, see
   *  `lastReportedCue`'s own comment). `place` is threaded through purely so
   *  a thrown RTSPOverWebSocketError still points at whichever call site
   *  actually invoked this, matching every other error in this class. */
  private reportCueTimestamp(cue: VTTCue, place: string): void {
    if (typeof cue.text === 'undefined' || cue.text === null) {
      return;
    }
    try {
      const timeStamp: TimestampData = JSON.parse(cue.text);
      timeStamp.type = 'timestamp';
      timeStamp.channelId = this.channelId;
      timeStamp.currentTimeDiff = parseInt(String(((this.videoElement as HTMLVideoElement).currentTime - cue.startTime) * 1000), 10);
      timeStamp.videoSize = this.videoSize;
      this.lastReportedCue = cue;
      (this.timeStampCallback as (t: unknown) => void)(timeStamp);
    } catch (error) {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: (error as { code?: number }).code,
        place,
        message: (error as Error).message
      });
    }
  }

  /** Pull-based fallback, polled by `startTimestampCuePolling()`'s
   *  `requestAnimationFrame` loop -- see `lastReportedCue`'s own comment for
   *  why onCueEnter() alone can silently miss cues at a high Playback speed.
   *
   *  Deliberately searches `track.cues` (the *full*, static cue list) for
   *  whichever cue's `[startTime, endTime)` contains the live
   *  `videoElement.currentTime` right now, instead of reading
   *  `TextTrack.activeCues` -- confirmed live (via `[DEBUG-CUE]` tracing
   *  during this fix's own investigation) that `activeCues` is *itself* only
   *  recomputed by the same coarse "time marches on" algorithm responsible
   *  for onenter/onexit in the first place, so polling it more often (even
   *  every rAF tick) gains nothing: a cue whose entire lifetime falls inside
   *  one scheduling gap of that algorithm never appears in `activeCues` at
   *  any observed instant either, the exact same blind spot as onenter/
   *  onexit. `videoElement.currentTime` itself is a plain, always-current
   *  property with no such batching, so searching the cue list directly
   *  against it is what actually gains ground -- still bounded by how often
   *  this polling loop itself runs (rAF, ~60Hz, far finer than "time marches
   *  on"'s historical ~250ms cadence but not infinite), so this narrows the
   *  real-world gap without being able to guarantee catching literally every
   *  frame at extreme speeds -- a hard limit of firing cue-shaped events off
   *  a `<video>` element's own timeline at all, not fixable from here. */
  private checkTimestampCueAtCurrentTime(): void {
    const videoElement = this.videoElement as HTMLVideoElement;
    const track = videoElement.textTracks[this.timestampTextTrackId];
    if (typeof track === 'undefined' || track === null || track.cues === null) {
      return;
    }
    const currentTime = videoElement.currentTime;
    const cues = track.cues;
    // Cues are appended in chronological order (createVideoSample()/
    // createSegment() always add the next sample's cue after the previous
    // one's), so scanning from the end finds the most recent match fastest,
    // and hitting `lastReportedCue` first means everything before it was
    // already reported -- safe to stop.
    for (let i = cues.length - 1; i >= 0; i--) {
      const cue = cues[i] as VTTCue;
      if (cue === this.lastReportedCue) {
        return;
      }
      if (currentTime >= cue.startTime && currentTime < cue.endTime) {
        this.reportCueTimestamp(cue, 'VideoTagPlayer.ts:checkTimestampCueAtCurrentTime');
        return;
      }
    }
  }

  /** Drives checkTimestampCueAtCurrentTime() every rendered frame via
   *  `requestAnimationFrame` -- see that method's own comment for why this
   *  needs to run independently of onTimeUpdate()/`TextTrack.activeCues`
   *  rather than being folded into either. Started once from init(),
   *  self-reschedules for the life of the player, and only actually does
   *  work while `playbackFlag` is set (the reported gap is Playback-
   *  specific -- Live mode's own timestamp cues aren't affected the same
   *  way, since Live never compresses frameDuration by a requested speed at
   *  all). Stopped from close(). */
  private startTimestampCuePolling(): void {
    if (this.timestampCuePollHandle !== null) {
      return;
    }
    const loop = (): void => {
      if (this.playbackFlag) {
        this.checkTimestampCueAtCurrentTime();
      }
      this.timestampCuePollHandle = requestAnimationFrame(loop);
    };
    this.timestampCuePollHandle = requestAnimationFrame(loop);
  }

  private stopTimestampCuePolling(): void {
    if (this.timestampCuePollHandle !== null) {
      cancelAnimationFrame(this.timestampCuePollHandle);
      this.timestampCuePollHandle = null;
    }
  }

  private makeOnCueEnter(): (this: VTTCue) => void {
    const player = this;
    return function onCueEnter(this: VTTCue): void {
      // legacy declares `var track = videoElement.textTracks[...]` here but
      // never actually uses it (grep-confirmed dead local) — omitted.
      if (typeof this.text !== 'undefined' && this.text !== null) {
        player.reportCueTimestamp(this, 'VideoTagPlayer.ts:onCueEnter');
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
      // Not forced to `false` here (unlike preload/autoplay/muted/volume
      // below, which really are fresh-element defaults this app always
      // wants): RTSPOverWebSocket.ts already applies the `controls`
      // attribute/property to this exact element before init() runs (see
      // its connectedCallback and onRTSPOverWebSocketVideoMode) — forcing
      // it off here silently discarded that, so a `controls` attribute set
      // up front (or toggled via the context menu right before the first
      // video frame landed) never actually showed native controls.
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
      let lastBoxTime = this.boxStartTime[this.boxStartTime.length - 1 - boxTimeIndex];
      // Real bug, found live: `onVisibilityChange()` (this method's only
      // caller) fires whenever the tab regains visibility, and this jump
      // target -- a *few* `createSegment()`/`createVideoSegment()` calls
      // back from `boxStartTime`'s current length, not validated against
      // what's actually still buffered -- assumed `boxStartTime` always
      // trails close behind `currentTime`. That's false after a real tab was
      // backgrounded for a while: browsers commonly throttle/freeze a
      // background tab's `<video>` playback (`currentTime` stops advancing),
      // but RTP/WebSocket delivery and this tier's own segment creation can
      // keep running regardless, so `boxStartTime` keeps growing the whole
      // time. On refocus, `lastBoxTime` then points at a segment appended
      // *during* the background period -- which may be well past whatever
      // has actually finished decoding/rendering by the time this runs -- so
      // the jump can overshoot past the real playable frontier exactly like
      // `onWaiting()`'s catch-up jump or `videoUpdating()`'s boxsize-snap
      // could (see those fixes above), stalling playback (a negative
      // "Statistics" `Latency`) until real buffered content actually catches
      // up to where this jumped to. Clamped here to never target past what's
      // actually buffered right now, backing off by `defaultDelay` same as
      // every other currentTime correction in this class.
      if (this.sourceBuffer !== null && this.sourceBuffer.buffered.length > 0) {
        const bufferedEnd = this.sourceBuffer.buffered.end(this.sourceBuffer.buffered.length - 1) * 1;
        lastBoxTime = Math.min(lastBoxTime, bufferedEnd - this.defaultDelay);
      }
      if (videoElement.currentTime < lastBoxTime) {
        videoElement.currentTime = lastBoxTime;
      }
    }
  }

  private onVisibilityChange(): void {
    if (document.visibilityState !== 'visible') {
      return;
    }
    if (this.playbackFlag) {
      this.changeCurrentTime();
      return;
    }
    // Real bug, found live (reported by the user): minimizing the browser
    // then restoring it left Live playback permanently stopped. This
    // handler used to be a no-op for Live mode entirely -- while hidden,
    // the browser throttles/freezes the <video> element's own playback
    // (currentTime stops advancing) while RTP/WebSocket delivery and
    // SourceBuffer appends keep going regardless (same underlying browser
    // behavior Playback's changeCurrentTime() comment above already
    // documents), so by the time the tab/window becomes visible again,
    // currentTime has fallen far behind the buffered/live edge. Nothing
    // used to force a catch-up check at that exact moment for Live --
    // recovery depended entirely on the next durationchange/updateend
    // happening to fire on its own, which could take a while (or, before
    // durationchange's known stall was worked around, might never happen
    // again at all). videoUpdating() already contains Live's own
    // catch-up/resume logic (jump currentTime to endTime - defaultDelay,
    // call videoPlay() if paused, when latency exceeds this.delay) -- just
    // never had a reason to run right on visibility restore. Reused here
    // instead of duplicating that logic.
    this.videoUpdating();
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
          (videoElement.currentTime < endTime - this.getMaxInstantPlaybackTime() || (endTime !== 0 && videoElement.currentTime === 0)) &&
          endTime - this.defaultDelay > 0 &&
          this.userPaused === false &&
          this.localSpeedValue === 1
        ) {
          videoElement.currentTime = endTime - this.defaultDelay;
        } else {
          // Real bug, found live: this used to unconditionally truncate
          // `currentTime` down to the floor integer second
          // (`parseInt(String(currentTime), 10)`) on *every* 'waiting'
          // event reaching this branch -- which is the normal, expected
          // case (a brief buffering pause nowhere near the
          // getMaxInstantPlaybackTime()-sized backlog the branch above handles),
          // not just some rare recovery scenario. Confirmed live via native
          // <video> event tracing: a real MJPEG Playback session hitting
          // ordinary 'waiting' pauses every ~0.5-0.9s (its own segments
          // arrive in small, frequent bursts) got `currentTime` rewound by
          // up to a full second on *every one* of them -- e.g. 4.79 -> 4.0
          // -> plays forward to ~4.79 again -> 'waiting' -> rewound to 4.0
          // again, repeating indefinitely. That's exactly what read live as
          // a burned-in OSD timestamp oscillating back and forth instead of
          // advancing, and as "latency" building up (real playback progress
          // was being discarded every cycle, not actually stalled). Now
          // only rewinds when `currentTime` is genuinely out of the valid
          // buffered range (at/past `endTime`, or non-finite) -- the
          // scenario a defensive correction here should actually be
          // guarding against; a `currentTime` that's simply waiting for a
          // few more frames at the buffered edge is left alone entirely,
          // letting the browser's own buffered-position recovery resume it
          // naturally once more data arrives.
          if (!Number.isFinite(videoElement.currentTime) || videoElement.currentTime >= endTime) {
            videoElement.currentTime = parseInt(String(videoElement.currentTime), 10);
          }
          if (this.userPaused === false && videoElement.readyState >= 2) {
            if (!this.instantplayback) {
              this.videoPlay();
            }
          }
        }

        // Real bug, found live via direct instrumentation (temporary
        // `[DEBUG-RESET]`/`[DEBUG-UE2]` logging): this A/V-drift resync used
        // to run unconditionally, comparing the real, monotonically-advancing
        // `baseVideoTime` against `baseAudioTime` even when the audio track
        // is entirely synthetic (`dummyAudio` -- MJPEG's re-encoder tier has
        // no real audio at all, see `makeDummyAudio()`). Dummy audio's
        // duration accounting is only an approximation to satisfy MSE's
        // technical requirement for an audio track, not a real timing
        // signal, so it routinely drifts >2s from real video progress with
        // no actual desync having occurred. Confirmed live: this fired on
        // nearly every 'waiting' event during MJPEG Playback (e.g.
        // baseVideoTime=85000 vs baseAudioTime=58880, a ~2.6s gap that's
        // just normal dummy-audio slop), each time zeroing `baseVideoTime`
        // back to 0 via resetBaseDecodingTime() -- discarding several real
        // seconds of already-buffered progress and causing every
        // subsequently-muxed segment's PTS to land back inside the
        // already-buffered range instead of extending past it. That's
        // exactly the buffered-range freeze/sawtooth traced via
        // `[DEBUG-UE2]` (bufferedEnd growing then abruptly dropping back)
        // and the mismatched-fps/oscillating-OSD symptom reported live. Now
        // skipped entirely while `dummyAudio` is true -- this resync only
        // makes sense for a real second audio track, which real-audio
        // sessions (dummyAudio false) still get exactly as before.
        if (this.localSpeedValue === 1 && !this.dummyAudio && Math.abs(this.baseVideoTime - this.baseAudioTime) > 20000) {
          this.resetBaseDecodingTime();
        }
      } else {
        if (this.bufferedFrameCount < MAX_BUFFER_FRAME_COUNT) {
          this.bufferedFrameCount += 5;
        }
        // Real bug, found live (reported by the user): unlike the Playback
        // branch above (explicit currentTime jump + videoPlay() when
        // stalled), this Live branch used to only tune bufferedFrameCount
        // here -- nothing actually moved currentTime forward or resumed
        // playback on a native 'waiting' stall (e.g. after the tab/window
        // was minimized and currentTime fell far behind the buffered/live
        // edge while appends kept happening in the background). Reuses
        // videoUpdating()'s own Live catch-up/resume logic (jump
        // currentTime to endTime - defaultDelay, call videoPlay() if
        // paused, when latency exceeds this.delay) instead of duplicating
        // it here -- same fix as onVisibilityChange()'s Live branch above,
        // covering the case where 'waiting' fires before/without a
        // visibilitychange event.
        this.videoUpdating();
      }
    }
  }

  private onDurationChange(): void {
    this.traceDurationChangeCount++;
    this.debugLog.debug(`[trace] durationchange #${this.traceDurationChangeCount} (playbackFlag=${this.playbackFlag}, updateEndCount=${this.traceUpdateEndCount})`);
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

  private createSampleFrameData(frameData: Uint8Array, codecType: string, isEncoderSourced: boolean): Uint8Array {
    // VP8/VP9/AV1 have no Annex-B start-code/NAL-length layer at all — their
    // ISOBMFF sample data is the raw coded bitstream as-is (per the WebM VP
    // Codec and AV1 Codec ISOBMFF bindings). The NAL-length rewrite below is
    // H264/H265-specific; running it unconditionally would corrupt these
    // codecs' first 4 bytes (it always calls setNalLength at least once,
    // even when no 0x00000001 start code was ever found, since
    // `nalUnitIndex` starts at 0 rather than being left unset).
    //
    // `isEncoderSourced` (WebCodecsVideoEncoder.ts's MJPEG-encode tier) is
    // the same kind of exception even though its `codecType` reads 'H264'
    // (needed so mp4Generator.js's box-type dispatch treats it as real
    // H264) -- a `VideoEncoder` configured with `avc: { format: 'avc' }`
    // (the default) already emits length-prefixed AVCC bytes, not Annex-B
    // start codes, so running this rewrite on it would corrupt already-
    // correct data rather than fix anything.
    if (isEncoderSourced || (codecType !== 'H264' && codecType !== 'H265')) {
      return new Uint8Array(frameData);
    }

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
    this.presentationBaseRtpTimestamp = null;
    this.baseNTPTimestamp = videoTimestamp.utcTimeStamp
      ? videoTimestamp.utcTimeStamp
      : (videoTimestamp.timestamp as number) * 1000 + (videoTimestamp.timestamp_usec as number);
  }

  /**
   * Composition-time-offset (PTS - DTS) for a live-mode video sample, TIME_SCALE units.
   *
   * getVideoFrameDuration() derives each sample's `frameDuration` from consecutive
   * rtpTimestamp deltas in *arrival* order, `Math.abs()`-clamped to stay positive — correct
   * for encoders that never reorder (arrival order === decode order === display order, true
   * of every real Hanwha camera stream observed), but not for an encoder using B-frames
   * (RTP packets arrive in decode order; each packet's own rtpTimestamp is still its true
   * presentation time per RFC 3550, so the arrival-order timestamp sequence is inherently
   * non-monotonic whenever a B-frame is in flight). `Mp4Sample`/`mp4Generator.js` has no
   * composition-time-offset concept beyond what this method now supplies, so without it every
   * sample's presentation time was implicitly forced equal to its decode time — confirmed live
   * via chrome://media-internals to make Chrome's own MSE pipeline reject and drop most frames
   * of a B-frame H.265 stream ("Decoded frame ... is out of order" / "Dropping frame ...").
   *
   * Computed independently of frameDuration/baseVideoTime's own (already delicate, live-edge-
   * buffering-relevant) logic rather than by changing it: `decodeTime` is this sample's position
   * on the existing running decode-time clock (baseVideoTime plus any samples already buffered
   * in this.videoSamples but not yet flushed to a segment); `presentationTime` is this sample's
   * own rtpTimestamp relative to the first sample's (both scaled identically to frameDuration's
   * `* TEN`, so they share units). For non-reordered streams the two clocks track each other
   * almost exactly, so this evaluates to ~0 (no observable behavior change); for a B-frame
   * stream it captures the true, bounded reordering offset.
   */
  private getVideoCompositionTimeOffset(streamData: VideoStreamData): number {
    const rtpTimestamp = Number(streamData.timeStamp.rtpTimestamp);
    if (this.presentationBaseRtpTimestamp === null) {
      this.presentationBaseRtpTimestamp = rtpTimestamp;
    }
    const presentationTime = (rtpTimestamp - this.presentationBaseRtpTimestamp) * TEN;

    let decodeTime = this.baseVideoTime;
    for (const bufferedSample of this.videoSamples) {
      decodeTime += bufferedSample.frameDuration;
    }

    return presentationTime - decodeTime;
  }

  private initBaseAudioTime(audioTimestamp: TimestampData): boolean {
    // Real bug, found live (MJPEG Playback with dummy audio, but not
    // MJPEG-specific -- this whole function is shared by every codec's
    // Playback path): this used to reassign `this.baseVideoTime` here (not
    // `baseAudioTime`, despite the function's name) from an *absolute*
    // wall-clock-anchored formula (`receiveTimeStamp.utcTimeStamp` scaled by
    // `baseNTPTimestamp`) whenever `baseVideoTime` was falsy. `baseVideoTime`
    // is *always* a purely relative, monotonically self-accumulating clock
    // everywhere else in this class (`updateVideoTimestamp()`'s own
    // `baseVideoTime += frameDuration`, starting from 0) -- fine the very
    // first time this function ever runs (baseVideoTime is 0 by its field
    // default either way), but `resetBaseDecodingTime()` (the A/V-drift
    // resync this function is called from, via `checkAudioTimestamp()`)
    // *also* zeroes `baseVideoTime` itself before this runs, for Playback
    // mode specifically -- so every drift-triggered resync mid-session hit
    // this branch again and clobbered the relative clock with an absolute
    // millisecond-scale value (confirmed live: baseVideoTime jumped from a
    // normal ~65000 to ~75,000,000 mid-session), which every subsequent
    // `updateVideoTimestamp()` call then kept accumulating on top of --
    // surfacing as `currentTime` jumping to a nonsensical multi-thousand-
    // second value and the buffered edge effectively never being reached
    // again (reported directly by the user as a burned-in OSD timestamp
    // stuck oscillating, and separately as "video latency 20+ seconds").
    // Live mode's own equivalent resync never zeroes `baseVideoTime` first
    // (see `resetBaseDecodingTime()`'s own `if (this.playbackFlag)` guard),
    // so it never hit this branch with a stale-but-still-relative value to
    // corrupt -- which is why this went unnoticed until Playback exercised
    // it. `baseVideoTime` is always already valid by the time this runs
    // (either its 0 default, or whatever `resetBaseDecodingTime()`/prior
    // accumulation already set) -- nothing needs deriving here at all; the
    // fallback at `this.baseVideoTime` a few lines below (for a dummy/zero-
    // timestamp audio sample) already reads it correctly as-is.
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
  // videoTagPlayer (createAudioSample computes audio sample duration
  // inline via `preAudioTimeStamp` instead). Confirmed 100% dead code,
  // dropped rather than ported as unreachable weight.

  /** Shared real-MSE video-sample ingestion: builds the init segment once,
   *  on the first keyframe (`videoCodecInfo === null` gate), then always
   *  queues the sample. Extracted out of `onVideoData()` so the MJPEG-
   *  encoder tier's async `onMjpegEncodedChunk()` can reuse the exact same
   *  init-segment-building path (`setVideoInfo()`/`initBaseNTPTimestamp()`/
   *  `createInitSegment()`) as every synchronous real-MSE codec, rather
   *  than duplicating it — including `this.videoCodecInfo`'s own
   *  population, which `setSourceBuffer()` requires and is otherwise easy
   *  to forget to set from a new call site. */
  private ingestVideoSample(streamData: VideoStreamData, videoInfo: VideoInfo, isEncoderSourced: boolean): void {
    if (this.mediaSource === null || this.mediaSource.readyState === 'ended') {
      return;
    }
    if (this.videoCodecInfo === null && videoInfo.frameType === 'I') {
      this.videoCodecInfo = videoInfo.codecInfo as string;
      this.setVideoInfo(videoInfo, streamData.codecType);
      this.initBaseNTPTimestamp(streamData.timeStamp as TimestampData);
      this.createInitSegment();
      // Retry: `setSourceBuffer()`'s only other call site is the
      // `'sourceopen'` listener, which can fire before `videoCodecInfo` was
      // known yet (see that method's own comment) -- if that already
      // happened, `this.sourceBuffer` is still `null` here even though
      // `mediaSource` itself is open, and nothing would ever create it
      // otherwise. Calling it again now that the real codec is known is a
      // safe no-op if a SourceBuffer already exists (`setSourceBuffer()`'s
      // own `mediaSource.sourceBuffers.length === 0` guard).
      if (this.sourceBuffer === null) {
        this.setSourceBuffer();
      }
    }
    this.createVideoSample(streamData, videoInfo, isEncoderSourced);
  }

  /** MJPEG-encoder tier's `onVideoData()` entry point: hands the raw JPEG
   *  frame to `mjpegEncoder` (lazily created here, on the first call, since
   *  `VideoEncoder.configure()` needs real width/height that aren't known
   *  before this) and records a `mjpegPendingFrames` entry so
   *  `onMjpegEncodedChunk()` can match that frame's own async output back
   *  to its original (real, RTP-derived) `streamData`/`videoInfo` later. */
  private submitMjpegFrame(streamData: VideoStreamData, videoInfo: VideoInfo): void {
    if (this.mjpegEncoder === null) {
      this.setupMjpegEncoder(videoInfo.width as number, videoInfo.height as number);
    }
    if (this.mjpegEncoder === null || !this.mjpegEncoder.isConfigured) {
      // Encoder not ready yet (still async-configuring after just being
      // constructed above, or genuinely unsupported despite MediaRouter's
      // earlier pre-flight check) — this frame is simply skipped, not
      // queued; MJPEG delivers a fresh frame on essentially every RTP
      // marker bit, so playback picks back up on its own once configure()
      // resolves, never a total stall.
      return;
    }

    // Never drop a frame while there's no init segment yet
    // (mjpegAvcConfig === null) — that's the only frame that can ever start
    // playback; dropping it would stall forever, not just skip one frame.
    const forceKeyFrame = this.mjpegAvcConfig === null || this.mjpegFramesSinceKeyFrame >= MJPEG_ENCODER_KEYFRAME_INTERVAL;
    if (this.mjpegAvcConfig !== null && !forceKeyFrame && this.mjpegEncoder.encodeQueueSize >= MJPEG_ENCODER_MAX_QUEUE_SIZE) {
      return;
    }
    this.mjpegFramesSinceKeyFrame = forceKeyFrame ? 0 : this.mjpegFramesSinceKeyFrame + 1;

    const timestampUs = this.mjpegNextTimestampUs;
    this.mjpegNextTimestampUs += 1;
    this.mjpegPendingFrames.push({ timestampUs, streamData, videoInfo });
    void this.mjpegEncoder.encode({ frameData: streamData.frameData, timestampUs, forceKeyFrame });
  }

  private createVideoSample(streamData: VideoStreamData, videoInfo: VideoInfo, isEncoderSourced: boolean = false): void {
    const sample: VideoSample = {
      size: streamData.frameData.byteLength,
      frameData: this.createSampleFrameData(streamData.frameData, streamData.codecType, isEncoderSourced),
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
      sample.compositionTimeOffset = this.getVideoCompositionTimeOffset(streamData);
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

    // Defensive: a session was observed reaching here with streamData.frameData undefined
    // (Cannot read properties of undefined (reading 'byteLength')), killing the whole
    // MediaRouter session over one malformed/empty audio sample — root cause not yet
    // isolated (only reproduced against this repo's own VP9-video + AAC-audio transcoding
    // demo so far; unconfirmed whether upstream RTP depacketizing or ffmpeg's experimental
    // VP9 RTSP muxer is what's actually producing it). Skip the sample rather than let it
    // take down video playback too.
    if (!streamData.frameData) {
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
    // Guards a real race: setAudioInfo() also calls this (to re-declare the init segment
    // whenever the real audio codec is first learned or changes), but audio RTP can arrive
    // before the first video I-frame does — the only place videoInfoBox actually gets set
    // (onVideoData(), right before its own createInitSegment() call). Building an init segment
    // with a null video track previously reached mp4Generator.js's box-concatenation code with
    // an undefined child box, throwing "Cannot read properties of undefined (reading
    // 'byteLength')" and killing the whole MediaRouter session — observed live with VP9/AV1
    // (this repo's own transcoding demo), where audio apparently reaches the player before the
    // first keyframe more readily than it does for H264/H265. Deferring here is enough: once
    // the first video I-frame does arrive, onVideoData()'s own createInitSegment() call runs
    // with the already-current this.audioInfo, so nothing is lost — the audio codec info just
    // gets declared a little later than in the (invalid) alternative of declaring it without a
    // real video track at all.
    if (this.videoInfoBox === null) {
      return;
    }
    this.segmentArray.unshift(initSegment([this.videoInfoBox, this.audioInfo]));
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

    // Real bug, found live: keep the periodic ~1.5s (MAX_PLAYBACK_DIFF)
    // flush check alive regardless of what triggered *this* call --
    // previously only createVideoSample()'s own I-frame-boundary code ever
    // scheduled this timeout, so once a timeout-triggered flush consumed
    // the pending one, nothing rescheduled another until the *next real
    // keyframe* arrived. Confirmed live: a real WebCodecs `VideoEncoder`
    // inserts its own keyframes on its own internal cadence, independent of
    // this class's own `forceKeyFrame` request hint (observed ~17 frames
    // apart in one browser, ignoring a 60-frame request from
    // submitMjpegFrame()) -- so relying on the next I-frame to resume
    // flushing produced multi-second playback stalls between whatever
    // cadence the encoder happened to choose, visible as `currentTime`
    // sitting near the stale buffered edge (reported directly by the user
    // as a burned-in OSD timestamp visibly bouncing back and forth, e.g.
    // "27 -> 28 -> 27 -> 28", rather than advancing smoothly) instead of a
    // crash or an empty buffer. Rescheduling here, unconditionally, on
    // every call regardless of outcome, closes the gap for good -- a safe
    // no-op flush attempt when there's nothing new to send yet.
    if (this.mediaSource !== null && this.mediaSource.readyState !== 'ended') {
      this.createVideoSegmentTimeout = setTimeout(() => this.createSegment(), MAX_PLAYBACK_DIFF);
    }

    // Real bug, found live (MJPEG playback via the WebCodecs-encoder tier,
    // but not specific to it -- this method is shared with every real-MSE
    // codec's Playback path). The *only* other place dummy audio gets
    // seeded is createVideoSample()'s playbackFlag branch, and only once
    // `this.videoSamples.length > 1` (i.e. from the *second* I-frame
    // boundary onward) -- so the very first flush this method is asked to
    // do (via its own MAX_PLAYBACK_DIFF timeout fallback, or an I-frame
    // that arrives before a second one ever does) can hit the guard below
    // with `audioSamples` still empty, and then silently no-op forever if
    // no real audio track exists and no second I-frame arrives in time --
    // a real possibility for a short clip, or any codec/config with an
    // infrequent keyframe cadence (confirmed live: MJPEG's re-encoded H264
    // stream only forces a keyframe every 60 frames, easily longer than a
    // whole short Playback clip). Seeding here too, gated on the same
    // `dummyAudio` flag and only when nothing's queued yet, closes that gap
    // for every caller of this method, not just the one that already seeds
    // it. Falls back to exactly one `audioInfo.samplingDuration` worth when
    // there's no real rtpTimestamp delta to compute from yet (a single
    // buffered video sample) -- makeDummyAudio(0) would otherwise push
    // nothing at all, since its own `audioTime += 0` never crosses the
    // while-loop's `>= samplingDuration` threshold.
    if (this.dummyAudio && this.audioSamples.length === 0 && this.videoSamples.length > 0) {
      // makeDummyAudio()'s own `updateDuration > 100000` branch re-derives a
      // duration from consecutive video-sample rtpTimestamp deltas and
      // requires the recomputed total to land in `(0, 10000]` or it returns
      // without creating anything at all -- fine for its original target (a
      // single dropped-frame gap) but not for the potentially large span
      // that can accumulate here (many samples since the last flush, e.g.
      // MJPEG's own multi-frame re-encode keyframe interval). Capping at
      // exactly 100000 keeps this call on the function's direct-add path
      // (no recompute, no silent no-op) -- trades exact duration fidelity
      // for a guaranteed non-empty `audioSamples`, acceptable since this is
      // silent placeholder audio, not real content.
      const firstSample = this.videoSamples[0];
      const lastSample = this.videoSamples[this.videoSamples.length - 1];
      const rawDelta = ((lastSample.rtpTimestamp ?? 0) - (firstSample.rtpTimestamp ?? 0)) * 10;
      const safeDelta = Math.min(Math.max(rawDelta, this.audioInfo.samplingDuration), 100_000);
      this.makeDummyAudio(safeDelta);
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
    // Guard against a real race, not just a defensive nicety: setting `duration` requires
    // readyState === 'open' per the MSE spec, and this is only ever called from the
    // 'sourceopen' listener — which should already guarantee that — but a late-firing/stale
    // event (observed live, following session teardown/reconnect churn from an unrelated crash)
    // can still reach here after the MediaSource has already moved on to 'closed'/'ended',
    // throwing an uncaught InvalidStateError ("Failed to set the 'duration' property...").
    if (mediaSource.readyState !== 'open') {
      return;
    }
    if (mediaSource.sourceBuffers.length === 0) {
      mediaSource.duration = 0;

      try {
        const mimeCodec = `video/mp4;codecs="${this.videoCodecInfo}, ${this.opusActive ? 'opus' : 'mp4a.40.2'}"`;
        if (MediaSource.isTypeSupported(mimeCodec)) {
          this.sourceBuffer = mediaSource.addSourceBuffer(mimeCodec);
          this.sourceBufferAudioIsOpus = this.opusActive;
        }
      } catch (error) {
        throw new RTSPOverWebSocketError({
          channelId: this.channelId,
          errorCode: (error as { code?: number }).code,
          place: 'VideoTagPlayer.ts:setSourceBuffer',
          message: (error as Error).message
        });
      }

      // Real bug, found live: `videoCodecInfo` can still be `null` the first
      // time `sourceopen` fires (this method's only call site) if it hasn't
      // been captured from a real video frame yet -- `MediaSource.
      // isTypeSupported('video/mp4;codecs="null, ...')` then returns `false`
      // and `this.sourceBuffer` is never assigned. `addBufferEventListener()`
      // used to run unconditionally regardless, throwing `Cannot read
      // properties of null (reading 'addEventListener')` and aborting this
      // whole handler. Confirmed live: MJPEG's new WebCodecsVideoEncoder tier
      // (ingestVideoSample()/onMjpegEncodedChunk()) makes this race far more
      // likely to actually manifest than it was for H264/H265/VP9/AV1 --
      // building the first sample now requires an async JPEG-decode +
      // VideoEncoder.configure() round trip first, giving the browser's own
      // 'sourceopen' event a real chance to fire before any frame has been
      // muxed at all, instead of arriving after by sheer synchronous-path
      // timing luck like every other codec's frame usually did. Guarded here
      // (skip attaching listeners to a SourceBuffer that doesn't exist) and
      // retried once the real codec is known (see ingestVideoSample()'s own
      // setSourceBuffer() retry) -- fixes the race for every codec, not just
      // MJPEG, since the underlying ordering assumption was never codec-
      // specific to begin with.
      if (this.sourceBuffer !== null) {
        this.addBufferEventListener();
      }
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

      const mimeCodec = `video/mp4;codecs="${this.videoCodecInfo}, ${this.opusActive ? 'opus' : 'mp4a.40.2'}"`;
      if (MediaSource.isTypeSupported(mimeCodec)) {
        this.sourceBuffer = mediaSource.addSourceBuffer(mimeCodec);
        this.sourceBufferAudioIsOpus = this.opusActive;
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
          const isColdStart = videoElement.currentTime === 0;
          const latency = isColdStart ? endTime - startTime : endTime - videoElement.currentTime;

          // Real bug, found live: this used to require a full
          // `PLAYBACK_BUFFERING_TIME` (1s) margin before *every* resume,
          // not just the initial cold start -- reasonable for H264/H265
          // cameras, whose Playback segments typically carry several
          // seconds of buffer-ahead margin per append, but a permanent
          // deadlock for a source whose segments arrive in small,
          // real-time-paced increments (confirmed live: MJPEG's re-encoded
          // H264 stream, ~0.5-1.5s of new content per append). Once already
          // mid-playback, `currentTime` naturally catches up close to the
          // buffered edge between appends -- if the browser then pauses
          // for a normal buffering wait right as `latency` dips under 1s,
          // every `videoPlay()` attempt afterward kept refusing to resume
          // until buffer-ahead cleared a full second, which a slow,
          // real-time-matched trickle of small segments may never do,
          // stalling the session forever even though new data kept
          // arriving and appending successfully the whole time. The 1s
          // margin is still enforced for the genuine cold-start case
          // (`currentTime === 0`, where waiting for a decent initial
          // buffer before ever starting is still the right call and only
          // applies once) -- only the *resume* case now just requires any
          // positive amount of new buffer ahead of the current position.
          if (this.localSpeedValue === 1 && (isColdStart ? latency < PLAYBACK_BUFFERING_TIME : latency <= 0)) {
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

      if (Math.abs(endTime - startTime) > this.getMaxInstantPlaybackTime()) {
        if (!sourceBuffer.updating) {
          if (this.boxsize !== 1) {
            const removeEnd = Math.abs(Math.min(endTime, (this.videoElement as HTMLVideoElement).currentTime) - this.getMaxInstantPlaybackTime());
            // eslint-disable-next-line no-console
            this.debugLog.debug(`[trace] checkBufferSize trimming: buffered=${(endTime - startTime).toFixed(2)}s, remove(0, ${removeEnd.toFixed(2)})`);
            sourceBuffer.remove(0, removeEnd);
          } else {
            const removeEnd = Math.abs(Math.min(endTime, (this.videoElement as HTMLVideoElement).currentTime) - this.getMaxInstantPlaybackTime()) - 60;
            if (removeEnd > 0) {
              // eslint-disable-next-line no-console
              this.debugLog.debug(`[trace] checkBufferSize trimming: buffered=${(endTime - startTime).toFixed(2)}s, remove(0, ${removeEnd.toFixed(2)})`);
              sourceBuffer.remove(0, removeEnd);
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
              // Real risk, found investigating a real MJPEG Playback session
              // stalling with a negative "Latency" stat (`currentTime` past
              // the actual buffered end): this used to snap `currentTime`
              // to the raw buffered `endTime` with *zero* safety margin --
              // every other currentTime-correction in this class (this
              // function's own `tempCurrentTime = endTime - this.delay`
              // below, `onWaiting()`'s catch-up jump) backs off by at least
              // `defaultDelay`/`this.delay` first, precisely because a
              // `SourceBuffer`'s reported `buffered.end()` can be right at
              // the edge of what's actually already fully decodable,
              // especially for this tier's unusually small, frequent,
              // mostly-single-sample segments. Landing exactly on that edge
              // risks the same currentTime-ahead-of-decodable-data stall as
              // an outright overshoot. Now backs off by `defaultDelay`, same
              // margin `onWaiting()` already uses, clamped to not go behind
              // `startTime`.
              const targetTime = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1) * 1;
              videoElement.currentTime = Math.max(startTime, targetTime - this.defaultDelay);
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
        if (!this.realAacActive && !this.opusActive) {
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

    // Seed opusActive from the SDP-derived hint (see VideoPlayer.ts's
    // audioCodecHint field) so the *first* SourceBuffer creation — which
    // happens at the first video I-frame in onVideoData(), not necessarily
    // after the first audio packet — already declares the right MSE codecs
    // string. Without this, a video I-frame arriving before the first Opus
    // audio packet locks the SourceBuffer into a non-Opus ('mp4a.40.2')
    // declaration that setAudioInfo() can then never switch away from (MSE
    // forbids changing a SourceBuffer's codecs after creation), silently and
    // permanently dropping audio for the rest of the connection — see
    // setAudioInfo()'s codec-mismatch guard. `opusActiveIsHintOnly` (see
    // setAudioInfo()) still forces the first real Opus setAudioInfo() call to
    // run its normal audioInfo-population branch even though opusActive
    // already matches here, so real channelCount/sampleRate values are never
    // skipped.
    this.opusActive = this.audioCodecHint === 'OPUS';
    this.opusActiveIsHintOnly = this.opusActive;

    this.elementSetting();
    this.useBridge = this.decideUseBridge(this.codec);
    this.useMjpegEncoder = this.decideUseMjpegEncoder(this.codec);
    if (this.useBridge) {
      this.setupBridge(this.codec as string);
    } else {
      // MJPEG-encoder tier still needs a real MediaSource/SourceBuffer, same
      // as every other real-MSE codec — mjpegEncoder itself is created
      // lazily in submitMjpegFrame() (needs real width/height from the
      // first frame, unlike setupBridge() above which only needs a codec
      // string).
      this.createMediaSource();
    }
    this.instantplayback = false;
    this.startTimestampCuePolling();
  }

  override onVideoData(playMode: string, streamData: VideoStreamData, videoInfo: VideoInfo): void {
    this.codec = streamData.codecType;
    this.videoSize = (videoInfo.width as number) * (videoInfo.height as number);

    if (playMode === 'Playback') {
      this.playbackFlag = true;
      if (this.deviceType === 'camera') {
        this.checkPlaybackEnd(streamData.timeStamp as TimestampData);
      }
    }
    this.receiveTimeStamp = streamData.timeStamp as TimestampData;

    if (this.useBridge) {
      // No MP4 muxing at all in this tier — the raw coded bitstream goes
      // straight into the WebCodecs decoder, which writes decoded
      // `VideoFrame`s into `bridgeTrackGenerator` (see setupBridge()).
      this.bridgeDecoder?.decode({ frameType: videoInfo.frameType ?? 'P', frameData: streamData.frameData });
    } else if (this.useMjpegEncoder) {
      // No synchronous createVideoSample() here — the encoder's own
      // EncodedVideoChunk output (async) is what actually reaches
      // ingestVideoSample(), via onMjpegEncodedChunk().
      this.submitMjpegFrame(streamData, videoInfo);
    } else {
      this.ingestVideoSample(streamData, videoInfo, false);
    }

    if (this.minimapInfo.isUpdate && this.minimapInfo.element) {
      this.minimapInfo.element.getContext('2d')?.drawImage(this.videoElement as HTMLVideoElement, 0, 0, this.minimapInfo.element.width, this.minimapInfo.element.height);
      this.minimapInfo.isUpdate = false;
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
      // setAudioInfo() may have declined the switch above (SourceBuffer
      // already created for the other audio codec — see its comment); don't
      // queue this sample in that case, since createAudioSegment() would mux
      // it into a track still declared for the mismatched codec.
      if ((streamData.codecType === 'OPUS') === this.sourceBufferAudioIsOpus) {
        this.createAudioSample(streamData, audioInfo, streamData.codecType);
      }
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
    this.debugLog.debug('close() called');
    this.debugLog.debug(
      `[trace] close() queue sizes before clearing: segmentArray=${this.segmentArray.length}, videoSamples=${this.videoSamples.length}, audioSamples=${this.audioSamples.length}, boxStartTime=${this.boxStartTime.length}, mjpegPendingFrames=${this.mjpegPendingFrames.length}`
    );
    this.videoPause();
    this.stopTimestampCuePolling();

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
      // Previously left referenced after teardown -- `segmentArray`/
      // `videoSamples`/`audioSamples` can hold a real backlog of queued
      // Uint8Array frame data (e.g. if appendSegmentToSourceBuffer() was
      // ever stalled), and none of them get GC'd until this instance itself
      // does -- which may not happen promptly if something still holds a
      // reference to this player. Drop them immediately here instead of
      // waiting on that.
      this.segmentArray = [];
      this.videoSamples = [];
      this.audioSamples = [];
      this.boxStartTime = [];
      this.closeBridge();
      this.useBridge = false;
      this.closeMjpegEncoder();
      this.useMjpegEncoder = false;
      // Previously left dangling after the removeSourceBuffer() above — a
      // stale reference to a SourceBuffer no longer attached to any
      // MediaSource, which throws "This SourceBuffer has been removed from
      // the parent media source" the next time anything (e.g. a reconnect
      // reusing this same VideoTagPlayer instance) tries to append to it.
      this.sourceBuffer = null;
      this.sourceBufferAudioIsOpus = false;
      this.realAacActive = false;
      this.opusActive = false;
      this.opusActiveIsHintOnly = false;

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
        this.videoElement.srcObject = null;

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
      // `this.mediaSource` was previously never nulled after endOfStream()/
      // removeSourceBuffer() above -- left until here (after
      // removeAllEventListener(), which still needs a non-null
      // `this.mediaSource` to actually detach its own listeners) so the
      // reference is dropped rather than dangling until this instance is
      // GC'd, without skipping that cleanup.
      this.mediaSource = null;
      this.debugLog.debug('close() finished cleanup successfully');
    } catch (error) {
      console.error('[VideoTagPlayer] close() cleanup threw:', error);
    }
  }

  override forward(): void {}

  override backward(): void {}

  // digitalZoom/bufferingVideoData/controlStepPlay/sendToBufferManager: the
  // `VideoPlayerLike` structural contract MediaRouter.ts's `this.player`
  // field is typed against (shared with CanvasTagPlayer, which genuinely
  // implements all four for its step-play/digital-zoom features) requires
  // these unconditionally — but videoTagPlayer's own Constructor.prototype
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
    const isRealAac = audioinfo.codecType === 'AAC';
    const isOpus = audioinfo.codecType === 'OPUS';
    // Opus needs a different SourceBuffer codecs string ('opus' vs.
    // 'mp4a.40.2') than real-AAC/transcoded-G711/G726 (which both declare
    // 'mp4a.40.2', so switching between those two never needs this check).
    // MSE doesn't allow changing a SourceBuffer's codecs after creation, and
    // unlike the video codec (already known before the SourceBuffer is
    // first created), the real audio codec used to only be knowable once the
    // first RTP audio packet arrived — init() now pre-seeds opusActive from
    // audioCodecHint (SDP, known well before either the first video I-frame
    // or the first audio packet), so in the normal case this guard's two
    // sides already agree and it's a no-op. It still matters as a fallback
    // for a missing/wrong hint, or if this stream's audio codec genuinely
    // isn't decided until mid-connection: if the buffer's already been
    // created for the other one, there's no safe way to switch mid-stream
    // (attempting a remove+recreate here previously wedged the whole
    // MediaSource — see git history), so this stream's audio is dropped
    // rather than crash video along with it.
    if (this.sourceBuffer !== null && isOpus !== this.sourceBufferAudioIsOpus) {
      return;
    }
    const switchingCodec = isRealAac !== this.realAacActive || isOpus !== this.opusActive || (isOpus && this.opusActiveIsHintOnly);
    if (switchingCodec) {
      this.appendSegmentToSourceBuffer();

      if (isOpus) {
        // Opus is muxed natively (no transcode-to-AAC fallback — see
        // mp4Generator.js's opusSample()/dOps()); audioobjecttype/
        // samplingfrequencyindex are AAC-only concepts (esds()) that
        // opusSample()/dOps() never reads, so they're left at 0 here.
        this.audioInfo = {
          id: 2,
          channelcount: audioinfo.channelCount ?? 1,
          samplesize: 8,
          type: 'audio',
          codecType: 'OPUS',
          audioobjecttype: 0,
          samplingfrequencyindex: 0,
          samplingDuration: audioinfo.sampleRate ? Math.round((OPUS_FRAME_SAMPLES / audioinfo.sampleRate) * TIME_SCALE) : Math.round((OPUS_FRAME_SAMPLES / 48000) * TIME_SCALE),
          interleavedId: audioinfo.interleavedId
        };
      } else {
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
      }
      this.realAacActive = isRealAac;
      this.opusActive = isOpus;
      this.opusActiveIsHintOnly = false;

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
      codecType
    };

    if (codecType === 'H264') {
      videoInfoBox.sps = [videoinfo.spsPayload];
      videoInfoBox.pps = [videoinfo.ppsPayload];
      videoInfoBox.profileIdc = videoinfo.profileIdc as number;
      videoInfoBox.profileCompatibility = 0;
      videoInfoBox.levelIdc = videoinfo.levelIdc as number;
    } else if (codecType === 'H265') {
      videoInfoBox.sps = [videoinfo.spsPayload];
      videoInfoBox.pps = [videoinfo.ppsPayload];
      videoInfoBox.profileTierLevel = videoinfo.profileTierLevel;
      videoInfoBox.vps = [videoinfo.vpsPayload as Uint8Array | undefined];
    } else if (codecType === 'VP9') {
      videoInfoBox.profile = videoinfo.profile;
      videoInfoBox.bitDepth = videoinfo.bitDepth;
      videoInfoBox.colorSpace = videoinfo.colorSpace;
      videoInfoBox.colorRange = videoinfo.colorRange;
      videoInfoBox.subsamplingX = videoinfo.subsamplingX;
      videoInfoBox.subsamplingY = videoinfo.subsamplingY;
    } else if (codecType === 'AV1') {
      videoInfoBox.profile = videoinfo.profile;
      videoInfoBox.seqLevelIdx0 = videoinfo.seqLevelIdx0;
      videoInfoBox.seqTier0 = videoinfo.seqTier0;
      videoInfoBox.highBitdepth = videoinfo.highBitdepth;
      videoInfoBox.twelveBit = videoinfo.twelveBit;
      videoInfoBox.monoChrome = videoinfo.monoChrome;
      videoInfoBox.chromaSubsamplingX = videoinfo.chromaSubsamplingX;
      videoInfoBox.chromaSubsamplingY = videoinfo.chromaSubsamplingY;
      videoInfoBox.chromaSamplePosition = videoinfo.chromaSamplePosition;
      videoInfoBox.configObu = videoinfo.configObu;
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
