import { RTCPSession } from './RTCPSession';
import type { RtpSession, WaitingEvent, RtpStatistics } from './RtpSession';
import { H264Session } from './videoSession/H264Session';
import { H265Session } from './videoSession/H265Session';
import { MjpegSession } from './videoSession/MjpegSession';
import { AudioTalkSession } from './audioSession/AudioTalkSession';
import { G711Session } from './audioSession/G711Session';
import { G726Session } from './audioSession/G726Session';
import { AACSession } from './audioSession/AACSession';
import { MetaSession } from './textSession/MetaSession';
import type { SdpInfoEntry } from '../network/rtspOverWebsocket';

export type MediaRouterMessageType = 'close' | 'backup' | 'stepPlay' | 'bufferFree' | 'audioBackup';

export interface MediaRouterLike {
  channelId: number;
  deviceType?: string;
  onWaiting?: (waiting: WaitingEvent) => void;
  onStatistics?: (statistics: RtpStatistics) => void;
  onRtcpData?: (...args: unknown[]) => void;
  onVideoData?: (...args: unknown[]) => void;
  onAudioData?: (...args: unknown[]) => void;
  onMetadata?: (...args: unknown[]) => void;
  gotAudioSupport(supported: boolean): void;
  addListener(type: 'rtpClient', callback: (msgType: MediaRouterMessageType, data: unknown) => void): void;
  /**
   * Resolves with the negotiated sample rate. The callback receives raw
   * PCM samples (Float32Array, straight from Talk's ScriptProcessorNode
   * `onaudioprocess`), not yet RTP-encoded — matches Talk.ts's
   * `setSendAudioTalkBufferCallback`.
   */
  startAudioTalk(callback: (stream: Float32Array) => void): Promise<number>;
}

type AnySession = RtpSession | RTCPSession;

function isRtpSession(session: AnySession): session is RtpSession {
  return 'rtcpSession' in session;
}

/**
 * Ported from the legacy player’s MediaSession/rtpClient.js — creates and manages
 * the per-track RTP/RTCP session objects for one channel, and routes
 * incoming interleaved RTP data to the right one.
 *
 * Debug/info-only logger calls (and the plain `console.log` in
 * `getRtpSession`) are not reproduced. `rtcpSession.rtpSession = rtpSession`
 * is dropped — confirmed write-only in legacy too (grep finds no read site
 * anywhere in the codebase), so it isn't worth carrying as dead state on
 * `RTCPSession`. The commented-out MP4V-ES codec branch was already dead
 * and is dropped along with it.
 */
export class RtpClient {
  private sessionArray: AnySession[] = [];
  /** Receives the RTP-encoded (Uint8Array) packet built from the raw Float32Array PCM stream. */
  private sendAudioTalkDataCallback: ((data: Uint8Array) => void) | null = null;
  private audioTalkSession: AudioTalkSession | null = null;
  private _running = false;
  channelId: number;
  /** Never assigned anywhere in legacy rtpClient.js itself — only ever set (if at all) by an external caller directly on the instance. Preserved as a plain public field for that same escape hatch. */
  rtpWaitingTimeout?: number;

  constructor(private readonly mediaRouter: MediaRouterLike) {
    this.channelId = mediaRouter.channelId;
    mediaRouter.addListener('rtpClient', (msgType, data) => this.mediaRouterMessage(msgType, data));
  }

  private mediaRouterMessage(msgType: MediaRouterMessageType, _data: unknown): void {
    switch (msgType) {
      case 'close':
        if (this.sessionArray.length > 0) {
          this.sessionArray.forEach((session) => session.close());
          this.sessionArray = [];
        }
        break;
      case 'backup':
      case 'stepPlay':
      case 'bufferFree':
      case 'audioBackup':
        break;
      default:
        break;
    }
  }

  private sendAudioTalkData(stream: Float32Array): void {
    const rtpPacket = this.audioTalkSession!.getRTPPacket(stream);
    this.sendAudioTalkDataCallback?.(rtpPacket);
  }

  private onWaiting(waiting: WaitingEvent): void {
    this.mediaRouter.onWaiting?.(waiting);
  }

  private onStatistics(statistics: RtpStatistics): void {
    this.mediaRouter.onStatistics?.(statistics);
  }

  private setSampleRate(sampleRate: number): void {
    this.audioTalkSession!.setSampleRate(sampleRate);
  }

  private onError(error: Error): void {
    void error;
    // legacy: console.log("error" + error.message) only, no further effect.
  }

  sendSdpInfo(sdpInfo: SdpInfoEntry[]): void {
    for (let sdpIndex = 0; sdpIndex < sdpInfo.length; sdpIndex++) {
      let rtpSession: RtpSession | null = null;
      const entry = sdpInfo[sdpIndex];

      switch (entry.codecName) {
        case 'H264': {
          const session = new H264Session();
          session.init();
          session.setFramerate(typeof entry.Framerate === 'undefined' ? 0 : entry.Framerate);
          rtpSession = session;
          break;
        }
        case 'H265': {
          const session = new H265Session();
          session.init();
          session.setFramerate(typeof entry.Framerate === 'undefined' ? 0 : entry.Framerate);
          rtpSession = session;
          break;
        }
        case 'JPEG': {
          const session = new MjpegSession();
          session.init();
          rtpSession = session;
          break;
        }
        case 'G.711': {
          if (entry.trackID.search('trackID=t') === -1 && entry.trackID.search('trackID=back') === -1) {
            const session = new G711Session();
            session.init({ clockFreq: Number(entry.ClockFreq), bitrate: entry.Bitrate || 64 });
            session.mime = entry.codecMime ?? '';
            rtpSession = session;
          } else {
            this.audioTalkSession = new AudioTalkSession(entry.RtpInterlevedID!);
            this.mediaRouter
              .startAudioTalk((stream) => this.sendAudioTalkData(stream))
              .then((sampleRate) => this.setSampleRate(sampleRate))
              .catch((error) => this.onError(error as Error));
          }
          break;
        }
        case 'G.726-16':
        case 'G.726-24':
        case 'G.726-32':
        case 'G.726-40': {
          if (entry.trackID.search('trackID=t') === -1 && entry.trackID.search('trackID=back') === -1) {
            const session = new G726Session();
            session.init({
              clockFreq: Number(entry.ClockFreq),
              bitrate: entry.Bitrate ? entry.Bitrate : parseInt(entry.codecName!.substr(6, 2), 10)
            });
            session.mime = entry.codecMime ?? '';
            rtpSession = session;
          }
          break;
        }
        case 'mpeg4-generic': {
          if (entry.trackID.search('trackID=t') === -1 && entry.trackID.search('trackID=back') === -1) {
            const session = new AACSession();
            session.init({
              config: entry.config ?? '',
              clockFreq: Number(entry.ClockFreq),
              bitrate: entry.Bitrate || 48,
              sizeLength: entry.SizeLength ? Number(entry.SizeLength) : undefined,
              indexLength: entry.IndexLength ? Number(entry.IndexLength) : undefined,
              indexDeltaLength: entry.IndexDeltaLength ? Number(entry.IndexDeltaLength) : undefined
            });
            session.mime = entry.codecMime ?? '';
            rtpSession = session;
          }
          break;
        }
        case 'MetaData': {
          const session = new MetaSession();
          session.init();
          rtpSession = session;
          break;
        }
        default:
          break;
      }

      if (rtpSession !== null) {
        const rtcpSession = new RTCPSession();
        rtcpSession.interleavedId = entry.RtcpInterlevedID!;
        rtcpSession.deviceType = this.mediaRouter.deviceType;
        rtcpSession.channelId = this.channelId;
        if (this.mediaRouter.onRtcpData) {
          rtcpSession.addEventListener('rtcp', this.mediaRouter.onRtcpData);
        }
        rtcpSession.type = entry.Type;

        rtpSession.addEventListener('statistics', (...args) => this.onStatistics(args[0] as RtpStatistics));
        rtpSession.addEventListener('waiting', (...args) => this.onWaiting(args[0] as WaitingEvent), { waitingTimeout: this.rtpWaitingTimeout });
        rtpSession.deviceType = this.mediaRouter.deviceType;
        rtpSession.codec = entry.codecName ?? '';
        rtpSession.interleavedId = entry.RtpInterlevedID!;
        rtpSession.channelId = this.channelId;
        rtpSession.rtcpSession = rtcpSession;
        rtpSession.sessionId = entry.SessionID ?? null;
        rtpSession.type = entry.Type;

        switch (entry.Type) {
          case 'video':
            if (this.mediaRouter.onVideoData) rtpSession.addEventListener('video', this.mediaRouter.onVideoData);
            break;
          case 'audio':
            if (this.mediaRouter.onAudioData) rtpSession.addEventListener('audio', this.mediaRouter.onAudioData);
            break;
          case 'application':
            if (this.mediaRouter.onMetadata) rtpSession.addEventListener('text', this.mediaRouter.onMetadata);
            break;
          default:
            break;
        }

        if (entry.ClockFreq) {
          rtpSession.clock = rtcpSession.clock = parseInt(entry.ClockFreq, 10) / 1000;
        }

        if (typeof entry.information !== 'undefined') {
          // NOTE: legacy also assigns `rtcpSession.information` here, but
          // RTCPSession has no `information` field and nothing anywhere in
          // the legacy player ever reads `.information` off an RTCPSession
          // instance (confirmed via grep) — only RtpSession's own
          // onStatisticsTimer reads it. Dropped as confirmed dead state,
          // same judgment as the `rtcpSession.rtpSession` cross-reference above.
          rtpSession.information = entry.information;
        }

        if (rtpSession.type === 'video' || rtpSession.type === 'audio') {
          rtpSession.startStatisticsTimer();
        }

        this.sessionArray[parseInt(String(entry.RtpInterlevedID))] = rtpSession;
        this.sessionArray[parseInt(String(entry.RtcpInterlevedID))] = rtcpSession;
      }
    }

    const audioSupport = this.sessionArray.some((session) => session.type === 'audio');
    this.mediaRouter.gotAudioSupport(audioSupport);
  }

  sendRtpData(rtspinterleave: Uint8Array, rtpheader: Uint8Array, rtpPacketArray: Uint8Array): void {
    const interleavedId = rtspinterleave[1];
    const session = this.sessionArray[interleavedId];
    if (typeof session !== 'undefined') {
      session.depacketize(rtspinterleave, rtpheader, rtpPacketArray);
    }
  }

  addListener(type: 'audioTalk', func: (data: Uint8Array) => void): void {
    switch (type) {
      case 'audioTalk':
        this.sendAudioTalkDataCallback = func;
        break;
      default:
        break;
    }
  }

  checkRtpSession(type: string): boolean {
    let found = false;
    if (this.sessionArray.length > 0) {
      this.sessionArray.forEach((session) => {
        if (isRtpSession(session) && type === session.type && session.rtcpSession !== undefined && session.rtcpSession !== null) {
          found = true;
        }
      });
    }
    return found;
  }

  getRtpSession(interleavedId: number): RtpSession | null {
    let result: RtpSession | null = null;
    if (this.sessionArray.length > 0) {
      this.sessionArray.forEach((session) => {
        if (isRtpSession(session) && session.interleavedId === interleavedId) {
          result = session;
        }
      });
    }
    return result;
  }

  getRtpSessionWithType(type: string | number): RtpSession | null {
    let result: RtpSession | null = null;
    if (this.sessionArray.length > 0) {
      this.sessionArray.forEach((session) => {
        if (!isRtpSession(session)) {
          return;
        }
        const hasRtcp = session.rtcpSession !== undefined && session.rtcpSession !== null;
        if (typeof type === 'string') {
          if (session.type === type && hasRtcp) {
            result = session;
          }
          if (session.codec === type && hasRtcp) {
            result = session;
          }
        } else if (typeof type === 'number') {
          if (session.interleavedId === type && hasRtcp) {
            result = session;
          }
        }
      });
    }
    return result;
  }

  close(): void {
    if (this.sessionArray.length > 0) {
      this.sessionArray.forEach((session) => session.close());
      this.sessionArray = [];
    }
  }

  get running(): boolean {
    return this._running;
  }

  set running(v: boolean) {
    this._running = v;
    if (this.sessionArray.length > 0) {
      this.sessionArray.forEach((session) => {
        session.running = v;
      });
    }
  }
}
