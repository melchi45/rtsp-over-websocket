import { MediaRouter, type MediaRouterFactories } from '../mediaSession/MediaRouter';
import { MetaDataParser, type ParsedMetaData } from '../mediaSession/MetaDataParser';
import { RtpClient, type MediaRouterLike } from '../mediaSession/RtpClient';
import {
  RtspClient,
  type RtspDeviceInfo,
  type RtspControlInfo,
  type SunapiClientLike,
  type RtpClientLike,
  type TransportFactory
} from '../network/rtspOverWebsocket/RtspClient';
import { CanvasTagPlayer } from '../video/player/canvas/CanvasTagPlayer';
import { VideoTagPlayer } from '../video/player/video/VideoTagPlayer';
import { AudioPlayerGxx } from '../listen/renderer/AudioPlayerGxx';
import { Talk } from '../talk/Talk';
import { BackupProvider } from '../backup/BackupProvider';
import { cloneArray } from '../util/cloneArray';
import { RTSPOverWebSocketError } from '../exceptions/RTSPOverWebSocketError';
import { fromHex } from '../util/hex';

export interface StreamPlayerDeviceInfo {
  channelId?: number;
  port?: number;
  protocol?: string;
  cameraIp?: string;
  hostname?: string;
  serverAddress?: string;
  proxy?: string;
  serverType?: string;
  use_pathname?: boolean;
  user?: string;
  username?: string;
  password?: string;
  deviceType?: string;
  captureName?: string;
  ClientIPAddress?: string;
  digest?: string;
  retry?: boolean;
  gmt?: unknown;
  zipPassword?: string;
}

export interface StreamPlayerMediaInfo {
  type: string;
  transportType?: string;
  requestInfo: {
    cmd: string;
    url?: string | null;
    scale?: number | string;
    rangeClock?: string;
    data?: unknown;
  };
  framerate?: number;
  govLength?: unknown;
  mode?: string | null;
  checkDelay?: boolean;
  element?: unknown;
  audioInStatus?: boolean;
  audioOutStatus?: boolean;
  audioInVolume?: number;
  instantPlaybackTime?: number;
  bufferClearInterval?: number;
  drop?: boolean;
  boxsize?: number;
  supportCovertAndOff?: boolean;
  bestshot?: boolean;
  rtpWaitingTimeout?: number;
  split?: unknown;
  needToImmediate?: boolean;
  streamControl?: boolean;
}

export interface StreamPlayerCallbacks {
  status?: (...args: unknown[]) => void;
  error?: (event: unknown) => void;
  rtsp?: (...args: unknown[]) => void;
  recv?: (...args: unknown[]) => void;
  close?: (...args: unknown[]) => void;
  time?: (...args: unknown[]) => void;
  resize?: (...args: unknown[]) => void;
  meta?: (...args: unknown[]) => void;
  metaImage?: (...args: unknown[]) => void;
  vmode?: (...args: unknown[]) => void;
  statistics?: (...args: unknown[]) => void;
  step?: (...args: unknown[]) => void;
  capture?: (...args: unknown[]) => void;
  instantplayback?: (...args: unknown[]) => void;
  backup?: (...args: unknown[]) => void;
  gotAudioSupport?: (...args: unknown[]) => void;
}

export interface StreamPlayerInfo {
  device: StreamPlayerDeviceInfo;
  media: StreamPlayerMediaInfo;
  callback: StreamPlayerCallbacks;
}

export interface StreamPlayerControlData {
  channelId?: number;
  elementId?: unknown;
  cmd: string;
  data: unknown;
}

function defaultMediaRouterFactories(): MediaRouterFactories {
  return {
    createCanvasPlayer: () => new CanvasTagPlayer(),
    createVideoPlayer: () => new VideoTagPlayer(),
    createAudioPlayer: () => new AudioPlayerGxx(),
    createTalk: () => new Talk(),
    createMetaDataParser: (cb) => new MetaDataParser(cb as (data: ParsedMetaData) => void),
    // legacy's `new BackupProvider()` never actually took the callback
    // MediaRouterFactories.createBackupProvider is handed (it flows into
    // backupProvider.init(data) separately) — matches BackupProvider.ts's
    // own constructor, which also takes no required callback.
    createBackupProvider: () => new BackupProvider(),
    cloneArray
  };
}

/**
 * Ported from the legacy player’s Interface/streamPlayer — the top-level
 * per-channel facade wiring RtspClient (WebSocket RTSP signaling) +
 * RtpClient/MediaRouter (RTP depacketizing, video/audio rendering, backup)
 * into the single `control()`/`controlWorker()` command surface that
 * `elements/RTSPOverWebSocket.ts` drives.
 */
export class StreamPlayer {
  playerId: unknown = null;

  private readonly channelId: number;
  private readonly mediaRouter: MediaRouter;
  private readonly rtspClient: RtspClient;
  private rtpClient: RtpClient | null = null;
  private isValidBackupCheck: boolean | null = null;

  private readonly connectionInfo: { protocol: string; hostname: string; port: number | string; proxy: string; ClientIPAddress?: string } = {
    protocol: '',
    hostname: '',
    port: 80,
    proxy: ''
  };

  private readonly profileInfo: {
    device: {
      cameraIp: string;
      hostname: string;
      username: string;
      password: string;
      type: string;
      digest: string;
      use_pathname: boolean;
      retry?: boolean;
      gmt?: unknown;
    };
    media: {
      type: string;
      requestInfo: { cmd: string; url?: string | null; scale?: number | string; rangeClock?: string };
      framerate: number;
      govLength: unknown;
      mode: string | null;
      checkDelay: boolean;
      audioInStatus: unknown;
      audioOutStatus?: 'on' | 'off';
      element?: unknown;
      boxsize?: number;
      supportCovertAndOff?: boolean;
      bestshot?: boolean;
      rtpWaitingTimeout?: number;
      drop?: boolean;
      needToImmediate?: boolean;
    };
  } = {
    device: {
      cameraIp: '',
      hostname: '',
      username: 'admin',
      password: '',
      type: 'camera',
      digest: '',
      use_pathname: true
    },
    media: {
      type: 'live',
      requestInfo: { cmd: 'open', url: 'profile2', scale: 1 },
      framerate: 0,
      govLength: null,
      mode: null,
      checkDelay: true,
      audioInStatus: null
    }
  };

  private readonly timeInfo: { startTime: string | null; endTime: string | null } = { startTime: null, endTime: null };

  private readonly callbackInfo: {
    status?: (...args: unknown[]) => void;
    error?: (event: unknown) => void;
    recv?: (...args: unknown[]) => void;
    time?: (...args: unknown[]) => void;
    onResize?: (...args: unknown[]) => void;
    onMetaData?: (...args: unknown[]) => void;
    onMetaImageData?: (...args: unknown[]) => void;
    onVideoMode?: (...args: unknown[]) => void;
    onStatistics?: (...args: unknown[]) => void;
    onStepRequest?: (...args: unknown[]) => void;
    onCapture?: (...args: unknown[]) => void;
    onInstantPlayback?: (...args: unknown[]) => void;
    onBackup?: (...args: unknown[]) => void;
    gotAudioSupport?: (...args: unknown[]) => void;
  } = {};

  constructor(
    configInfo: StreamPlayerInfo,
    sunapiClient: SunapiClientLike | null,
    mediaRouterFactories: MediaRouterFactories = defaultMediaRouterFactories(),
    transportFactory?: TransportFactory
  ) {
    this.channelId = configInfo.device.channelId ?? 0;

    this.mediaRouter = new MediaRouter(mediaRouterFactories);
    this.mediaRouter.channelId = this.channelId;
    if (typeof configInfo.device.deviceType !== 'undefined' && typeof configInfo.device.deviceType === 'string' && configInfo.device.deviceType.toLowerCase() !== 'camera') {
      this.mediaRouter.deviceType = configInfo.device.deviceType;
    }
    if (typeof configInfo.media.audioInVolume !== 'undefined') {
      this.mediaRouter.setAudioVolume(configInfo.media.audioInVolume);
    }
    if (typeof configInfo.media.instantPlaybackTime !== 'undefined') {
      this.mediaRouter.setMaxInstantPlaybackTime(configInfo.media.instantPlaybackTime);
    }
    if (typeof configInfo.media.bufferClearInterval !== 'undefined') {
      this.mediaRouter.setBufferClearInterval(configInfo.media.bufferClearInterval);
    }
    if (typeof configInfo.media.element !== 'undefined') {
      this.mediaRouter.setElement(configInfo.media.element);
    }
    this.mediaRouter.framedrop = configInfo.media.drop ?? false;

    this.rtspClient = typeof transportFactory === 'undefined' ? new RtspClient() : new RtspClient(transportFactory);
    this.rtspClient.channelId = this.mediaRouter.channelId;
    this.rtspClient.SetSunapiClient(sunapiClient);
  }

  private open(info: StreamPlayerInfo | null, audioOutStatus?: boolean): void {
    if (info !== null) {
      if (info.device.deviceType !== undefined && info.device.deviceType !== '') {
        this.profileInfo.device.type = info.device.deviceType;
      }

      if (this.profileInfo.device.type === 'nvr' && (info.device.hostname === undefined || (info.device.hostname === '' && (info.device.hostname as unknown) === null))) {
        throw new RTSPOverWebSocketError({ channelId: this.channelId, errorCode: fromHex('0x0401'), place: 'StreamPlayer.ts:102', message: 'hostname is empty from input parameter.' });
      } else if (this.profileInfo.device.type === 'camera' && (info.device.cameraIp === undefined || info.device.cameraIp === '')) {
        throw new RTSPOverWebSocketError({ channelId: this.channelId, errorCode: fromHex('0x0400'), place: 'StreamPlayer.ts:111', message: 'cameraIP is empty from input parameter.' });
      }

      this.connectionInfo.protocol = info.device.protocol as string;
      this.connectionInfo.hostname = info.device.hostname as string;
      this.connectionInfo.port = info.device.port as number;
      this.profileInfo.device.use_pathname = typeof info.device.use_pathname === 'boolean' ? info.device.use_pathname : info.device.serverType !== 'grunt';
      this.connectionInfo.ClientIPAddress = info.device.ClientIPAddress;
      if (info.device.serverAddress !== null && info.device.serverAddress !== undefined && info.device.serverAddress !== '') {
        this.connectionInfo.proxy = info.device.serverAddress;
      } else if (info.device.proxy !== null && info.device.proxy !== undefined && info.device.proxy !== '') {
        this.connectionInfo.proxy = info.device.proxy;
      }

      this.profileInfo.device.cameraIp = info.device.cameraIp as string;
      // No longer throws for a missing username (fixed 2026-08-26) — mirrors
      // the redesign RTSPOverWebSocket.ts's own play() already went through
      // (see docs/player's "401 / credential-retry" note): a session with
      // no credentials at all is legitimate — the RTSP-over-WebSocket bridge
      // may not require auth for that channel — and should reach the actual
      // WebSocket/RTSP layer and surface a real 401 there if one comes
      // back, not fail synchronously here before a connection is even
      // attempted. Confirmed live this throw could fire even for a
      // deliberately-cleared "no credentials" state (`applySrcAttribute()`'s
      // hostname-change credential clear, elsewhere in this file's sibling
      // class, sets `username` to `''` specifically so this check passes).
      if (typeof info.device.username !== 'undefined') {
        this.profileInfo.device.username = info.device.username;
      } else if (typeof info.device.user !== 'undefined') {
        this.profileInfo.device.username = info.device.user;
      } else {
        this.profileInfo.device.username = '';
      }
      if (info.device.password !== undefined) {
        this.profileInfo.device.password = info.device.password;
      }

      this.profileInfo.device.retry = info.device.retry;

      this.profileInfo.media.type = info.media.type;
      this.profileInfo.media.requestInfo.cmd = info.media.requestInfo.cmd;
      this.profileInfo.media.requestInfo.url = info.media.requestInfo.url;
      this.profileInfo.media.requestInfo.scale = info.media.requestInfo.scale;
      this.profileInfo.media.element = info.media.element;
      this.profileInfo.media.framerate = info.media.framerate as number;
      this.profileInfo.media.govLength = info.media.govLength;
      this.profileInfo.media.mode = info.media.mode ?? null;
      this.profileInfo.media.requestInfo.rangeClock = info.media.requestInfo.rangeClock;
      this.profileInfo.media.checkDelay = typeof info.media.checkDelay === 'undefined';
      this.profileInfo.device.digest = info.device.digest as string;
      this.profileInfo.media.drop = info.media.drop;

      if (info.media.audioInStatus) {
        this.mediaRouter.sendCommandData('audioIn', 'on');
      } else {
        this.mediaRouter.sendCommandData('audioIn', 'off');
      }

      if (info.media.audioOutStatus) {
        this.profileInfo.media.audioOutStatus = 'on';
      } else if (!info.media.audioOutStatus) {
        this.profileInfo.media.audioOutStatus = 'off';
      }

      if (info.media.type === 'backup') {
        this.isValidBackupCheck = false;
      }

      if (typeof info.media.boxsize !== 'undefined' && info.media.boxsize !== null) {
        this.profileInfo.media.boxsize = info.media.boxsize;
      }
      if (typeof info.media.supportCovertAndOff !== 'undefined' && info.media.supportCovertAndOff !== null) {
        this.profileInfo.media.supportCovertAndOff = info.media.supportCovertAndOff;
      }
      if (typeof info.media.bestshot !== 'undefined' && info.media.bestshot !== null) {
        this.profileInfo.media.bestshot = info.media.bestshot;
      }
      if (info.media.rtpWaitingTimeout) {
        this.profileInfo.media.rtpWaitingTimeout = info.media.rtpWaitingTimeout;
      }

      this.callbackInfo.status = info.callback.status;
      this.callbackInfo.error = info.callback.error;
      this.callbackInfo.recv = info.callback.recv;
      this.callbackInfo.time = info.callback.time;
      this.callbackInfo.onResize = info.callback.resize;
      this.callbackInfo.onMetaData = info.callback.meta;
      this.callbackInfo.onMetaImageData = info.callback.metaImage;
      this.callbackInfo.onVideoMode = info.callback.vmode;
      this.callbackInfo.onStatistics = info.callback.statistics;
      this.callbackInfo.onStepRequest = info.callback.step;
      this.callbackInfo.onCapture = info.callback.capture;
      this.callbackInfo.onInstantPlayback = info.callback.instantplayback;
      this.callbackInfo.onBackup = info.callback.backup;
      this.callbackInfo.gotAudioSupport = info.callback.gotAudioSupport;

      this.close(null, () => {
        if (this.rtspClient.getCurrentState() === 'Options' || this.rtspClient.getCurrentState() === 'Teardown') {
          this.startStreaming();
        }
      });

      if (info.media.type === 'backup') {
        const backupCallback = this.callbackInfo.onBackup !== null && this.callbackInfo.onBackup !== undefined ? this.callbackInfo.onBackup : this.callbackInfo.error;
        const command: Record<string, unknown> = {
          command: 'start',
          fileName: info.device.captureName,
          split: info.media.split,
          callback: backupCallback,
          timestamp: this.callbackInfo.time,
          gmt: info.device.gmt,
          deviceType: info.device.deviceType
        };
        if (info.device.zipPassword) {
          command.password = info.device.zipPassword;
        }
        this.mediaRouter.sendCommandData('backup', command);
        this.isValidBackupCheck = true;
      } else if (info.media.type === 'playback') {
        this.playbackSpeed(info.media.requestInfo.scale as number);
      }
    } else {
      this.profileInfo.media.audioOutStatus = audioOutStatus ? 'on' : 'off';
      this.close(null, () => {
        if (this.rtspClient && (this.rtspClient.getCurrentState() === 'Options' || this.rtspClient.getCurrentState() === 'Teardown')) {
          this.startStreaming();
        }
      });
    }
  }

  private startStreaming(): void {
    let deviceIp: string;
    if (this.profileInfo.device.type === 'camera') {
      deviceIp = this.connectionInfo.hostname ? this.connectionInfo.hostname : this.profileInfo.device.cameraIp;
    } else if (this.profileInfo.device.type === 'nvr') {
      deviceIp = this.connectionInfo.hostname ? this.connectionInfo.hostname : this.profileInfo.device.hostname;
    } else {
      deviceIp = this.connectionInfo.hostname ? this.connectionInfo.hostname : this.profileInfo.device.cameraIp;
    }
    const port = this.connectionInfo.port === '' ? this.connectionInfo.port : `:${this.connectionInfo.port}`;
    const protocol = this.connectionInfo.protocol === 'http' || this.connectionInfo.protocol === undefined || (this.connectionInfo.protocol as string) === '' ? 'ws://' : 'wss://';
    const rtspUrl = `rtsp://${deviceIp}/${this.profileInfo.media.requestInfo.url}`;

    let pathName = '';
    if (this.profileInfo.device.use_pathname) {
      pathName = window.location.pathname;
      if (pathName !== '/') {
        pathName = pathName.replace('/index.html', '/');
        pathName = pathName.replace('/wmf', '');
        const n = pathName.lastIndexOf('/');
        pathName = pathName.substring(0, n);
      } else {
        pathName = '';
      }
    }

    let address: string;
    if ((navigator.userAgent.indexOf('Trident') !== -1 || navigator.userAgent.indexOf('Edge') !== -1) && this.connectionInfo.proxy.indexOf(':') !== -1) {
      let addr = this.connectionInfo.proxy !== '' ? `${this.connectionInfo.proxy}${port}` : `${deviceIp}${port}`;
      addr = addr.replace(/:/gi, '-');
      addr = addr.replace(/::/gi, '--');
      addr = addr.replace('[', '');
      addr = addr.replace(']', '');
      addr = addr + '.ipv6-literal.net';
      address = `${protocol}${addr}/StreamingServer${pathName}`;
    } else {
      if (this.connectionInfo.proxy !== '') {
        address = `${protocol}${this.connectionInfo.proxy}${port}/StreamingServer${pathName}`;
      } else {
        address = `${protocol}${deviceIp}${port}/StreamingServer${pathName}`;
      }
    }

    const deviceInfo: RtspDeviceInfo = {
      wsUrl: address,
      id: this.profileInfo.device.username,
      pw: this.profileInfo.device.password,
      rtspUrl,
      mode: this.profileInfo.media.type,
      deviceType: this.profileInfo.device.type,
      useragent: `UWC[${this.connectionInfo.ClientIPAddress}]`,
      audioOutStatus: this.profileInfo.media.audioOutStatus,
      rangeClock: this.profileInfo.media.requestInfo.rangeClock,
      scale: this.profileInfo.media.requestInfo.scale,
      retry: this.profileInfo.device.retry,
      bestshot: this.profileInfo.media.bestshot
    };
    this.rtspClient.SetDeviceInfo(deviceInfo);

    if (typeof this.callbackInfo.error !== 'undefined' && this.callbackInfo.error !== null) {
      this.rtspClient.addEventListener('error', this.callbackInfo.error as (event: unknown) => void);
      this.mediaRouter.addListener('error', this.callbackInfo.error as (...args: unknown[]) => void);
    }
    if (typeof this.callbackInfo.recv !== 'undefined' && this.callbackInfo.recv !== null) {
      this.rtspClient.addEventListener('recv', this.callbackInfo.recv as (event: unknown) => void);
    }
    if (typeof this.callbackInfo.status !== 'undefined' && this.callbackInfo.status !== null) {
      this.rtspClient.addEventListener('status', this.callbackInfo.status as (event: unknown) => void);
    }
    if (typeof this.callbackInfo.time !== 'undefined' && this.callbackInfo.time !== null) {
      this.mediaRouter.addListener('timeStamp', this.callbackInfo.time);
    }
    if (typeof this.callbackInfo.onResize !== 'undefined' && this.callbackInfo.onResize !== null) {
      this.mediaRouter.addListener('resize', this.callbackInfo.onResize);
    }
    if (typeof this.callbackInfo.onMetaData !== 'undefined' && this.callbackInfo.onMetaData !== null) {
      this.mediaRouter.addListener('metaEvent', this.callbackInfo.onMetaData);
    }
    if (typeof this.callbackInfo.onMetaImageData !== 'undefined' && this.callbackInfo.onMetaImageData !== null) {
      this.mediaRouter.addListener('metaImageEvent', this.callbackInfo.onMetaImageData);
    }
    if (typeof this.callbackInfo.onVideoMode !== 'undefined' && this.callbackInfo.onVideoMode !== null) {
      this.mediaRouter.addListener('videoMode', this.callbackInfo.onVideoMode);
    }
    if (typeof this.callbackInfo.onStepRequest !== 'undefined' && this.callbackInfo.onStepRequest !== null) {
      this.mediaRouter.addListener('stepRequest', this.callbackInfo.onStepRequest);
    }
    if (typeof this.callbackInfo.onStatistics !== 'undefined' && this.callbackInfo.onStatistics !== null) {
      this.mediaRouter.addListener('statistics', this.callbackInfo.onStatistics);
    }
    if (typeof this.callbackInfo.onCapture !== 'undefined' && this.callbackInfo.onCapture !== null) {
      this.mediaRouter.addListener('capture', this.callbackInfo.onCapture);
    }
    if (typeof this.callbackInfo.onInstantPlayback !== 'undefined' && this.callbackInfo.onInstantPlayback !== null) {
      this.mediaRouter.addListener('instantplayback', this.callbackInfo.onInstantPlayback);
    }
    if (this.callbackInfo.gotAudioSupport) {
      this.mediaRouter.addListener('gotAudioSupport', this.callbackInfo.gotAudioSupport);
    }

    if (typeof this.profileInfo.media.boxsize !== 'undefined' && this.profileInfo.media.boxsize !== null) {
      this.mediaRouter.boxsize = this.profileInfo.media.boxsize;
    }
    if (typeof this.profileInfo.media.supportCovertAndOff !== 'undefined' && this.profileInfo.media.supportCovertAndOff !== null) {
      this.mediaRouter.supportCovertAndOff = this.profileInfo.media.supportCovertAndOff;
    }
    if (typeof this.profileInfo.media.mode !== 'undefined' && this.profileInfo.media.mode !== null) {
      this.mediaRouter.defaultVideoTagMode = this.profileInfo.media.mode;
    }

    this.mediaRouter.framedrop = this.profileInfo.media.drop ?? false;
    this.mediaRouter.deviceType = this.profileInfo.device.type;

    // MediaRouter's onVideoData/onAudioData/onMetadata/onRtcpData are typed
    // with their real, specific parameter lists (see MediaRouter.ts's own
    // doc comment on those fields), while MediaRouterLike declares them with
    // the generic (...args: unknown[]) => void shape Session.addEventListener
    // actually stores callbacks as — RtpSession always fires each event with
    // exactly the args the matching specific handler expects, so this is a
    // safe duck-typing boundary, not a real mismatch.
    this.rtpClient = new RtpClient(this.mediaRouter as unknown as MediaRouterLike);
    this.mediaRouter.rtpClient = this.rtpClient;
    // RtpSession.type is only optional structurally (inherited from the
    // shared Session base, which many non-RTP session kinds also extend);
    // every concrete RTP session subclass (H264Session, G711Session, ...)
    // sets it unconditionally in its own constructor/init().
    this.rtspClient.rtpClient = this.rtpClient as unknown as RtpClientLike;

    if (this.profileInfo.media.rtpWaitingTimeout) {
      (this.rtpClient as unknown as { rtpWaitingTimeout?: number }).rtpWaitingTimeout = this.profileInfo.media.rtpWaitingTimeout;
    }

    this.mediaRouter.initializeNTPTimestamp();

    this.rtspClient.Connect();
  }

  private close(info: StreamPlayerInfo | null, response: (event: unknown) => void): void {
    console.log('[StreamPlayer] close() called');
    if (this.isValidBackupCheck === true) {
      this.mediaRouter.sendCommandData('backup', { command: 'stop' });
    }
    this.rtspClient.Disconnect((event) => {
      console.log('[StreamPlayer] close() -> rtspClient.Disconnect callback fired, calling mediaRouter.terminate()');
      this.mediaRouter.terminate(() => {
        console.log('[StreamPlayer] close() -> mediaRouter.terminate() finished');
        response(event);
      });
    });
    void info;
  }

  private terminate(): never {
    throw new RTSPOverWebSocketError({ channelId: this.channelId, errorCode: fromHex('0x090A'), place: 'StreamPlayer.ts:347', message: 'this method was deplicated.' });
  }

  private resume(info: StreamPlayerInfo): void {
    this.mediaRouter.sendCommandData('resume', info.media.needToImmediate);
    if (info.media.streamControl === true) {
      return;
    }
    this.profileInfo.media.type = info.media.type;
    this.profileInfo.media.requestInfo.cmd = 'resume';
    this.profileInfo.media.requestInfo.url = `rtsp://${this.profileInfo.device.cameraIp}:554/${info.media.requestInfo.url}`;
    this.profileInfo.media.requestInfo.scale = info.media.requestInfo.scale;
    this.profileInfo.media.requestInfo.rangeClock = info.media.requestInfo.rangeClock;
    this.profileInfo.media.needToImmediate = info.media.needToImmediate;
    if (info.media.type === 'live') {
      this.rtspClient.instantplayback = false;
    }
    this.rtspClient.ControlStream(this.profileInfo as unknown as RtspControlInfo);
    this.playbackSpeed(info.media.requestInfo.scale as number);
  }

  private pause(info: StreamPlayerInfo): void {
    this.mediaRouter.sendCommandData('pause', undefined);
    if (info.media.streamControl === true) {
      return;
    }
    this.profileInfo.media.type = info.media.type;
    this.profileInfo.media.requestInfo.cmd = 'pause';
    this.profileInfo.media.requestInfo.url = `rtsp://${this.profileInfo.device.cameraIp}:554/${info.media.requestInfo.url}`;
    this.profileInfo.media.requestInfo.rangeClock = info.media.requestInfo.rangeClock;
    this.profileInfo.media.needToImmediate = info.media.needToImmediate;
    if (info.media.type === 'live') {
      this.rtspClient.instantplayback = true;
    }
    this.rtspClient.ControlStream(this.profileInfo as unknown as RtspControlInfo);
  }

  private speed(info: StreamPlayerInfo): void {
    const type = this.profileInfo.media.type;
    if (type === 'live') {
      return;
    }
    this.profileInfo.media.type = info.media.type;
    this.profileInfo.media.requestInfo.cmd = 'speed';
    this.profileInfo.media.requestInfo.scale = info.media.requestInfo.scale;
    this.profileInfo.media.requestInfo.url = `rtsp://${this.profileInfo.device.cameraIp}:554/${info.media.requestInfo.url}`;
    this.profileInfo.media.requestInfo.rangeClock = info.media.requestInfo.rangeClock;
    this.profileInfo.media.needToImmediate = info.media.needToImmediate;

    if (type === 'backup') {
      this.profileInfo.media.requestInfo.rangeClock = undefined;
    }

    this.rtspClient.ControlStream(this.profileInfo as unknown as RtspControlInfo);
    this.playbackSpeed(info.media.requestInfo.scale as number);
  }

  private seek(info: StreamPlayerInfo): void {
    const type = this.profileInfo.media.type;
    if (type === 'live') {
      return;
    }
    this.profileInfo.media.type = info.media.type;
    this.profileInfo.media.requestInfo.cmd = 'seek';
    this.profileInfo.media.requestInfo.scale = info.media.requestInfo.scale;
    this.profileInfo.media.requestInfo.url = `rtsp://${this.profileInfo.device.cameraIp}:554/${info.media.requestInfo.url}`;
    this.profileInfo.media.requestInfo.rangeClock = info.media.requestInfo.rangeClock;
    this.profileInfo.media.needToImmediate = info.media.needToImmediate;

    this.rtspClient.ControlStream(this.profileInfo as unknown as RtspControlInfo);

    if (info.media.requestInfo.scale !== 1) {
      this.playbackSpeed(info.media.requestInfo.scale as number);
    }

    this.playbackSeek(info.media.requestInfo.scale as number);
  }

  private backward(info?: StreamPlayerInfo): void {
    this.mediaRouter.sendCommandData('backward', undefined);
    if (typeof info !== 'undefined' && info !== null && info.device.deviceType === 'nvr') {
      this.profileInfo.media.type = info.media.type;
      this.profileInfo.media.requestInfo.cmd = 'backward';
      this.profileInfo.media.requestInfo.url = `rtsp://${this.profileInfo.device.cameraIp}:554/${info.media.requestInfo.url}`;
      this.profileInfo.media.requestInfo.rangeClock = info.media.requestInfo.rangeClock;
      this.profileInfo.media.needToImmediate = info.media.needToImmediate;
      this.profileInfo.media.requestInfo.scale = info.media.requestInfo.scale;
      this.rtspClient.ControlStream(this.profileInfo as unknown as RtspControlInfo);
    }
  }

  private forward(info?: StreamPlayerInfo): void {
    this.mediaRouter.sendCommandData('forward', undefined);
    if (typeof info !== 'undefined' && info !== null && info.device.deviceType === 'nvr') {
      this.profileInfo.media.type = info.media.type;
      this.profileInfo.media.requestInfo.cmd = 'forward';
      this.profileInfo.media.requestInfo.url = `rtsp://${this.profileInfo.device.cameraIp}:554/${info.media.requestInfo.url}`;
      this.profileInfo.media.requestInfo.rangeClock = info.media.requestInfo.rangeClock;
      this.profileInfo.media.needToImmediate = info.media.needToImmediate;
      this.profileInfo.media.requestInfo.scale = info.media.requestInfo.scale;
      this.rtspClient.ControlStream(this.profileInfo as unknown as RtspControlInfo);
    }
  }

  // legacy's `step(info)` is declared but has no call site in
  // streamPlayer's own `control()` switch (only 'forward'/'backward'/
  // 'step' *cases* exist, and the 'step' case calls stepRequest(), not this
  // function) — grep-confirmed unreachable. Kept off this port as confirmed
  // dead code.

  private stepRequest(info: StreamPlayerInfo): void {
    this.profileInfo.media.type = info.media.type;
    this.profileInfo.media.requestInfo.cmd = 'seek';
    this.profileInfo.media.requestInfo.scale = info.media.requestInfo.scale;
    this.profileInfo.media.requestInfo.url = `rtsp://${this.profileInfo.device.cameraIp}:554/${info.media.requestInfo.url}`;
    this.rtspClient.ControlStream(this.profileInfo as unknown as RtspControlInfo);
  }

  private backup(info: StreamPlayerInfo): void {
    if (info.media.type === 'live') {
      const backupCallback = this.callbackInfo.onBackup !== null && this.callbackInfo.onBackup !== undefined ? this.callbackInfo.onBackup : info.callback.close;
      const command: Record<string, unknown> = {
        command: info.media.requestInfo.cmd === 'backupstart' ? 'start' : 'stop',
        fileName: info.device.captureName,
        split: info.media.split,
        callback: backupCallback,
        timestamp: info.callback.time,
        gmt: info.device.gmt
      };
      if (info.device.zipPassword) {
        command.password = info.device.zipPassword;
      }
      this.mediaRouter.sendCommandData('backup', command);
      this.isValidBackupCheck = true;
    } else if (info.media.type === 'backup') {
      this.open(info);
    }
  }

  private capture(info: StreamPlayerInfo): void {
    this.mediaRouter.addListener('capture', info.callback.capture as (...args: unknown[]) => void);
    this.mediaRouter.sendCommandData(info.media.requestInfo.cmd as 'capture', info.device.captureName);
  }

  private digitalZoom(info: StreamPlayerInfo): void {
    this.mediaRouter.sendCommandData('digitalZoom', info.media.requestInfo.data);
  }

  private controlAudioIn(info: StreamPlayerInfo): void {
    if (this.rtspClient.getCurrentState() === 'Playing') {
      const audioFlag = (this.rtpClient as RtpClient).checkRtpSession('audio');
      if (!audioFlag) {
        throw new RTSPOverWebSocketError({ channelId: this.channelId, errorCode: fromHex('0x0303'), place: 'StreamPlayer.ts:controlAudioIn', message: 'The current profile is not support audio in.' });
      }
    }
    this.mediaRouter.sendCommandData('audioIn', info.media.requestInfo.data);
  }

  private controlAudioOut(info: StreamPlayerInfo): void {
    const data = info.media.requestInfo.data;
    if (data === 'on' || data === 'off') {
      this.open(null, data === 'on');
    }
  }

  private changeStackCount(_info: StreamPlayerInfo): void {
    // legacy: `data = parseInt(data, 10); // workerManager.setStackCount(data);`
    // — the only effect (workerManager) is already commented out; confirmed
    // no-op, kept as a reachable but empty handler for the 'changeStackCount' cmd.
  }

  private updateMinimap(info: StreamPlayerInfo): void {
    this.mediaRouter.sendCommandData('minimap', info.media.requestInfo.data);
  }

  private playbackSpeed(speed: number): void {
    this.mediaRouter.sendCommandData('speed', speed);
  }

  private playbackSeek(speed: number): void {
    this.mediaRouter.sendCommandData('seek', speed);
  }

  private checkRequestTimeChanged(requestInfo: { url?: string | null; endTime?: string }): void {
    const url = requestInfo.url ?? '';
    const parts = url.split('/');
    if (parts[0] !== 'recording' || parts.length < 2) {
      return;
    }
    const rangeParts = parts[1].split('-');
    const startTime = rangeParts[0];
    const endTime = rangeParts.length > 1 ? rangeParts[1] : null;
    if (startTime !== this.timeInfo.startTime || endTime !== this.timeInfo.endTime) {
      this.timeInfo.startTime = startTime;
      this.timeInfo.endTime = endTime || (requestInfo.endTime as string);
      this.mediaRouter.sendCommandData('requestTimeChanged', this.timeInfo);
    }
  }

  /** Ported from Constructor.prototype.control. */
  control(info: StreamPlayerInfo | null | undefined): void {
    if (typeof info === 'undefined' || info === null) {
      return;
    }

    const controlType = info.media.requestInfo.cmd;

    if (typeof info.callback !== 'undefined' && typeof info.callback.error !== 'undefined') {
      this.rtspClient.addEventListener('error', info.callback.error as (event: unknown) => void);
    }
    if (typeof info.callback !== 'undefined' && typeof info.callback.rtsp !== 'undefined') {
      this.rtspClient.addEventListener('rtsp', info.callback.rtsp as (event: unknown) => void);
    }
    if (info.media.requestInfo.url !== null && typeof info.media.requestInfo.url !== 'undefined') {
      this.checkRequestTimeChanged(info.media.requestInfo);
    }
    if (typeof info.callback !== 'undefined' && typeof info.callback.recv !== 'undefined') {
      this.rtspClient.addEventListener('recv', info.callback.recv as (event: unknown) => void);
    }

    if (info.media.type === 'instantplayback') {
      switch (controlType) {
        case 'init':
          this.mediaRouter.sendCommandData('instantplayback', { cmd: 'init' });
          break;
        case 'open':
          this.mediaRouter.sendCommandData('instantplayback', { cmd: 'play' });
          break;
        case 'pause':
          this.mediaRouter.sendCommandData('instantplayback', { cmd: 'pause' });
          break;
        case 'seek':
          this.mediaRouter.sendCommandData('instantplayback', { cmd: 'seek', currentTime: info.media.requestInfo.rangeClock });
          break;
        case 'terminate':
          this.mediaRouter.sendCommandData('instantplayback', { cmd: 'terminate' });
          break;
      }
      return;
    }

    switch (controlType) {
      case 'open':
        this.open(info);
        break;
      case 'close': {
        const currentState = this.rtspClient.getCurrentState();
        if (this.rtspClient && currentState !== 'Teardown') {
          this.close(info, () => {});
        }
        break;
      }
      case 'terminate':
        this.terminate();
        break;
      case 'resume':
        this.resume(info);
        break;
      case 'pause':
        this.pause(info);
        break;
      case 'speed':
        this.speed(info);
        break;
      case 'seek':
        this.seek(info);
        break;
      case 'capture':
        this.capture(info);
        break;
      case 'dZoom':
        this.digitalZoom(info);
        break;
      case 'audioIn':
        this.controlAudioIn(info);
        break;
      case 'audioOut':
        this.controlAudioOut(info);
        break;
      case 'forward':
        this.forward(info);
        break;
      case 'backward':
        this.backward(info);
        break;
      case 'step':
        this.stepRequest(info);
        break;
      case 'backup':
      case 'backupstart':
      case 'backupstop':
        this.backup(info);
        break;
      case 'changeStackCount':
        this.changeStackCount(info);
        break;
      case 'minimap':
        this.updateMinimap(info);
        break;
      default:
        break;
    }
  }

  /** Ported from Constructor.prototype.controlWorker. */
  controlWorker(controlData: StreamPlayerControlData): void {
    switch (controlData.cmd) {
      case 'setCallback': {
        const dataArray = controlData.data as [string, (...args: unknown[]) => void, unknown?];
        if (dataArray.length === 2) {
          this.mediaRouter.addListener(dataArray[0] as never, dataArray[1]);
        } else {
          this.mediaRouter.addListener(dataArray[0] as never, dataArray[1], dataArray[2]);
        }
        break;
      }
      // timeStamp/initVideo/setLiveMode/openFPSmeter/closeFPSmeter/
      // setFpsFrame/playToggle/setPlaybackservice/reassignCanvas: legacy's
      // own handlers are empty bodies (their only content is a commented-out
      // `workerManager.X(...)` call to a now-removed subsystem) —
      // grep-confirmed no other effect. Reachable (controlWorker still
      // dispatches to them) but genuinely no-ops, so inlined as such here.
      case 'timeStamp':
      case 'initVideo':
      case 'setLiveMode':
      case 'openFPSmeter':
      case 'closeFPSmeter':
      case 'setFpsFrame':
      case 'playToggle':
      case 'setPlaybackservice':
      case 'reassignCanvas':
        break;
      case 'playbackSpeed':
        this.playbackSpeed(controlData.data as number);
        break;
      case 'playbackSeek':
        this.playbackSeek(controlData.data as number);
        break;
      case 'clearBuffer':
        this.mediaRouter.sendCommandData('clearBuffer', undefined);
        break;
      case 'changeVideoMode':
        this.mediaRouter.defaultVideoTagMode = controlData.data as string;
        break;
      case 'audioShift':
        this.mediaRouter.audioshift = controlData.data as number;
        break;
      default:
        break;
    }
  }

  getCurrentState(): string {
    return this.rtspClient.getCurrentState();
  }

  getVideoPlayer(): ReturnType<MediaRouter['getVideoPlayer']> {
    return this.mediaRouter.getVideoPlayer();
  }

  getVideoWidth(): number | null {
    return this.mediaRouter.getVideoWidth();
  }

  getVideoHeight(): number | null {
    return this.mediaRouter.getVideoHeight();
  }

  getVideoCodecType(): string | null {
    return this.mediaRouter.getVideoCodecType();
  }

  isMute(): boolean {
    if (this.rtspClient.getCurrentState() === 'Playing') {
      const audioFlag = (this.rtpClient as RtpClient).checkRtpSession('audio');
      if (!audioFlag) {
        throw new RTSPOverWebSocketError({ channelId: this.channelId, errorCode: fromHex('0x0303'), place: 'StreamPlayer.ts:isMute', message: 'The current profile is not support audio in.' });
      }
    }
    return this.mediaRouter.mute;
  }

  getAudioVolume(): number {
    return this.mediaRouter.getAudioVolume();
  }

  setAudioVolume(volume: number): void {
    this.mediaRouter.setAudioVolume(volume);
  }

  // Real legacy typo, preserved (matches MediaRouter.ts's own `toogleControls`).
  toogleControls(flags: unknown): void {
    this.mediaRouter.toogleControls(flags);
  }

  /** See RtspClient.ts's retryWithCredentials() — re-answers a cached 401
   * challenge with new credentials over the same still-open connection. */
  retryAuthentication(username: string, password: string): void {
    this.rtspClient.retryWithCredentials(username, password);
  }
}
