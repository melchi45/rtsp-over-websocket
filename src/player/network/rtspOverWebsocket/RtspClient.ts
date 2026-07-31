import { RTSPOverWebSocketError } from '../../exceptions/RTSPOverWebSocketError';
import { RTSPError } from '../../exceptions/RTSPError';
import { RtspStatusCode } from '../RtspStatusCode';
import { DigestGenerator, type AuthenticateData, type ParsedWwwAuthenticate } from '../../util/DigestGenerator';
import { fromHex, decimalToHex } from '../../util/hex';
import { Transport } from '../transport/Transport';

/**
 * Ported from the legacy player’s Network/RTSPoverWebsocket/rtspClient.js.
 *
 * Console/`rtspclient_log` calls from the legacy file are not reproduced
 * (observability only, no effect on behavior — same judgment as Transport.ts).
 * The `window.addEventListener('beforeunload', ...)` side effect inside
 * `Connect()` is also dropped: it is a page-lifecycle browser glue concern
 * with no bearing on this class's observable contract (it fires a TEARDOWN
 * request on page unload, fire-and-forget) and requires a real `window` to
 * even exist; if desired, it belongs in the top-level custom element instead.
 */

export type ControlType = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const RtspControlType = {
  NONE: 0,
  RESUME: 1,
  SEEK: 2,
  FORWARD: 3,
  BACKWARD: 4,
  PAUSE: 5,
  SPEED: 6,
  BACKUP: 7
} as const satisfies Record<string, ControlType>;

export interface SdpOriginInfo {
  UserName?: string;
  SessionId?: string;
  SessionVersion?: string;
  NetworkType?: string;
  AddressType?: string;
  UnicastAddress?: string;
}

export interface SdpConnectionDataInfo {
  NetworkType?: string;
  AddressType?: string;
  ConnectionAddress?: string;
}

export interface SdpParsedSession {
  Type?: string;
  Port?: string;
  Payload?: string;
  ControlURL?: string;
  PayloadType?: string;
  CodecMime?: string;
  ClockFreq?: string;
  EncodingParams?: string;
  Width?: string;
  Height?: string;
  Framerate?: string;
  DTLS_Param?: string;
  DTLS_SRTP?: string;
  BandwidthType?: string;
  Bandwidth?: string;
  Bitrate?: string;
  mode?: string;
  config?: string;
  profile_level_id?: string;
  streamtype?: string;
  SizeLength?: string;
  IndexLength?: string;
  IndexDeltaLength?: string;
  profile?: string;
  bitrate?: string;
  VPS?: string;
  SPS?: string;
  PPS?: string;
  information?: string;
}

/**
 * `Origin`/`ConnectionData` are, verbatim to the legacy file, empty arrays
 * with extra string-keyed properties bolted on (`result.Origin = []` then
 * `result.Origin.UserName = ...`) rather than plain objects — preserved as
 * `unknown[] &` intersections so parity tests can deep-equal the exact shape.
 */
export interface DescribeResponse {
  Origin: unknown[] & SdpOriginInfo;
  ConnectionData: unknown[] & SdpConnectionDataInfo;
  Sessions: SdpParsedSession[];
  version?: number;
  sessionInformation?: string;
  BaseURL?: string;
}

export interface RtpInfoEntry {
  URL?: string;
  Seq?: number;
}

export interface RtspResponseData {
  ResponseCode?: number;
  ResponseMessage?: string;
  MethodsSupported?: string[];
  CSeq?: number;
  ContentType?: string;
  SDPData?: DescribeResponse;
  ContentLength?: number;
  ContentBase?: string;
  SessionID?: string;
  TimeOut?: string;
  RtpInterlevedID?: number;
  RtcpInterlevedID?: number;
  RTPInfoList?: RtpInfoEntry[];
  WWWAuthenticate?: ParsedWwwAuthenticate[];
}

export interface SdpInfoEntry {
  Type: string;
  codecName?: string;
  codecMime?: string;
  trackID: string;
  ClockFreq?: string;
  Port?: number;
  Framerate?: number;
  information?: string;
  Bitrate?: number;
  config?: string;
  RtpInterlevedID?: number;
  RtcpInterlevedID?: number;
  SessionID?: string;
}

export interface RtspClientErrorEvent {
  channelId?: number;
  errorCode: number;
  type?: string;
  oldErrorCode?: string | number;
  currentState?: string;
  rtspCode?: number;
  description?: string;
  name?: string;
  place: string;
  pause?: boolean;
  controlType?: ControlType;
  message?: string;
}
export type RtspErrorCallback = (info: RtspClientErrorEvent) => void;
export type RtspTextCallback = (rtspData: string) => void;
export type RtspStatusCallback = (statusObject: unknown) => void;
export type RtspRecvCallback = (event: unknown) => void;

export interface RtpStatisticsTimerLike {
  pause(): void;
  resume(): void;
}

export interface RtpSessionLike {
  type: string;
  sessionId?: string | number | null;
  getStatisticsTimer(): RtpStatisticsTimerLike | null | undefined;
}

export interface RtpClientLike {
  running: boolean;
  getRtpSession(interleavedId: number): RtpSessionLike | null | undefined;
  getRtpSessionWithType(type: string): RtpSessionLike | null | undefined;
  sendSdpInfo(sdpInfo: SdpInfoEntry[]): void;
  addListener(event: string, callback: (...args: unknown[]) => void): void;
  sendRtpData(interleave: Uint8Array, header: Uint8Array, payload: Uint8Array): void;
  close(): void;
}

export interface SunapiDigestAuthResponse {
  data?: { Response?: unknown };
  Response?: unknown;
}

export interface SunapiClientLike {
  get(
    uri: string,
    data: AuthenticateData & { Nc?: string; Cnonce?: string },
    onSuccess: (response: SunapiDigestAuthResponse) => void,
    onError: (errorCode: unknown) => void,
    param3: string,
    param4: boolean
  ): void;
}

export type TransportConnectionStatus = 'open' | 'close' | 'error';

export interface TransportLike {
  index?: number;
  channelId?: number;
  autoconnection?: boolean;
  readyState?: number;
  SetCallback(
    connectionCbFunc: (status: TransportConnectionStatus, data: unknown) => void,
    rtspCbFunc: RtspTextCallback | null,
    rtpCbFunc: (interleave: Uint8Array, header: Uint8Array, payload: Uint8Array) => void,
    errorCbFunc: RtspErrorCallback,
    receivedBytesCbFunc?: (data: { channelId: number | undefined; current: number; total: number }) => void
  ): void;
  Connect(): void;
  Disconnect(): void;
  SendRtspCommand(message: string | null, response?: (response: string | Error) => void): unknown;
  SendRtpData(data: unknown): void;
  init(): void;
}

export interface RtspDeviceInfo {
  id: string;
  pw: string;
  wsUrl: string;
  rtspUrl: string;
  mode: string;
  rangeClock?: string;
  scale?: number | string;
  useragent: string;
  deviceType: string;
  audioOutStatus?: 'on' | 'off';
  retry?: boolean;
  bestshot?: boolean;
}

export interface RtspControlRequestInfo {
  cmd: 'resume' | 'seek' | 'forward' | 'backward' | 'pause' | 'speed' | 'backup';
  url?: string | null;
  scale?: number | string;
  rangeClock?: string;
}

export interface RtspControlMedia {
  requestInfo: RtspControlRequestInfo;
  type?: string;
  needToImmediate?: boolean;
}

export interface RtspControlInfo {
  media: RtspControlMedia;
}

export interface RtspDisconnectResult {
  current: string;
  next?: string;
  transport: TransportLike | null;
  state?: unknown;
}
export type RtspDisconnectCallback = (data: RtspDisconnectResult) => void;

const NO_SESSION = -1;

/** Overridable factory so tests can inject a fake transport instead of opening a real WebSocket. */
export type TransportFactory = (serverAddr: string) => TransportLike;

export class RtspClient {
  private readonly transportFactory: TransportFactory;

  private rtspUrl?: string;
  private id?: string;
  private pw?: string;
  private userAgent?: string;
  private wsUrl?: string;
  private audioOutStatus: 'on' | 'off' | undefined = 'off';
  private readonly checkAliveCommand = 'GET_PARAMETER';
  private Authentication = '';
  private SDPinfo: SdpInfoEntry[] = [];
  private ContentBase: string | null = null;
  private transport: TransportLike | null = null;
  private readonly digestGenerator = new DigestGenerator();
  private CSeq = 1;
  private sunapiClient: SunapiClientLike | null = null;
  private isConnected = false;
  private aliveCounter = 0;
  private indexOfTransport = 0;
  private wwwAuthenticate: string | null = null;

  private errorCallbackFunc!: RtspErrorCallback;
  private rtspCallbackFunc?: RtspTextCallback;
  private responseDisconnectCallback: RtspDisconnectCallback | null = null;

  private currentState = 'Options';
  private nextState?: string;
  private setupSDPIndex = 0;
  private SessionId: string | null = null;
  private mode = '';
  private rangeClock?: string;
  private scale?: number | string;
  private deviceType?: string;
  private audioTalkServiceStatus = false;
  private getParameterIntervalHandler: ReturnType<typeof setInterval> | null = null;
  private checkAliveIntervalHandler: ReturnType<typeof setInterval> | null = null;
  private isRTPRunning = false;
  private isPausing = false;
  private checkRtspAlive = false;
  private isGetParameterRequest = false;
  private unahtuorizedCount = 0;
  private _controlType: ControlType = RtspControlType.NONE;

  private rtspQueue: { method: string; requestURL: string | null | undefined; extHeader: string | null | undefined }[] = [];
  private isRequested = false;

  channelId?: number;
  instantplayback = false;
  backupBandwidth = 2600000;
  bestshot = false;
  recvCallback: RtspRecvCallback | null = null;
  autoconnection?: boolean;
  rtpClient?: RtpClientLike;

  constructor(transportFactory: TransportFactory = (serverAddr) => new Transport(serverAddr)) {
    this.transportFactory = transportFactory;
  }

  private CommandConstructor(method: string, requestURL?: string | null, extHeader?: string | null): string | null {
    let sendMessage = '';
    const AudioBackChannel = 'Require: www.onvif.org/ver20/backchannel\r\n';
    const UserAgentField = 'User-Agent: ' + this.userAgent + '\r\n';

    if ((typeof this.transport === 'undefined' || this.transport === null) && method !== 'OPTIONS') {
      this.errorCallbackFunc({
        errorCode: fromHex('0x0006'),
        type: 'rtsp',
        description: 'tranport is not exist',
        place: 'RtspClient.js:534',
        channelId: this.channelId
      });
      return null;
    }

    switch (method) {
      case 'OPTIONS':
        sendMessage = method + ' ' + this.rtspUrl + ' RTSP/1.0\r\n';
        sendMessage += 'CSeq: ' + this.CSeq + '\r\n';
        sendMessage += this.Authentication + UserAgentField;
        break;
      case 'TEARDOWN':
      case 'GET_PARAMETER':
      case 'SET_PARAMETERS':
        if (this.ContentBase && this.deviceType === 'nvr') {
          sendMessage = method + ' ' + this.ContentBase + ' RTSP/1.0\r\n';
          sendMessage += 'CSeq: ' + this.CSeq + '\r\n';
          sendMessage += 'Session: ' + this.SessionId + '\r\n';
          sendMessage += this.Authentication + UserAgentField;
        } else {
          sendMessage = method + ' ' + this.rtspUrl + ' RTSP/1.0\r\n';
          sendMessage += 'CSeq: ' + this.CSeq + '\r\n';
          sendMessage += 'Session: ' + this.SessionId + '\r\n';
          sendMessage += this.Authentication + UserAgentField;
        }
        break;
      case 'DESCRIBE':
        if (this.audioOutStatus === 'on') {
          sendMessage = method + ' ' + this.rtspUrl + ' RTSP/1.0\r\n';
          sendMessage += 'CSeq: ' + this.CSeq + '\r\n';
          sendMessage += this.Authentication + AudioBackChannel + UserAgentField;
        } else {
          sendMessage = method + ' ' + this.rtspUrl + ' RTSP/1.0\r\n';
          sendMessage += 'CSeq: ' + this.CSeq + '\r\n';
          sendMessage += this.Authentication + UserAgentField;
        }
        if (typeof extHeader !== 'undefined' && extHeader !== null && extHeader !== '') {
          sendMessage += extHeader;
        }
        break;
      case 'SETUP':
        if (
          typeof requestURL !== 'undefined' &&
          requestURL !== null &&
          requestURL !== '' &&
          requestURL.toLowerCase().indexOf('rtsp:') !== -1
        ) {
          sendMessage = method + ' ' + requestURL + ' RTSP/1.0\r\n';
          sendMessage += 'CSeq: ' + this.CSeq + '\r\n';
          sendMessage += this.Authentication + UserAgentField;
        } else if (this.ContentBase) {
          sendMessage = method + ' ' + this.ContentBase + requestURL + ' RTSP/1.0\r\n';
          sendMessage += 'CSeq: ' + this.CSeq + '\r\n';
          sendMessage += this.Authentication + UserAgentField;
        } else {
          sendMessage = method + ' ' + this.rtspUrl + '/' + requestURL + ' RTSP/1.0\r\n';
          sendMessage += 'CSeq: ' + this.CSeq + '\r\n';
          sendMessage += this.Authentication + UserAgentField;
        }

        if (typeof this.SessionId !== 'undefined' && this.SessionId !== null) {
          sendMessage += 'Session: ' + this.SessionId + '\r\n';
        }
        if (typeof extHeader !== 'undefined' && extHeader !== null && extHeader !== '') {
          sendMessage += extHeader;
        }
        break;
      case 'PLAY':
        if (
          typeof requestURL !== 'undefined' &&
          requestURL !== null &&
          requestURL !== '' &&
          requestURL.toLowerCase().indexOf('rtsp:') !== -1
        ) {
          if (this.ContentBase && this.deviceType === 'nvr') {
            sendMessage = method + ' ' + this.ContentBase + ' RTSP/1.0\r\n';
          } else {
            sendMessage = method + ' ' + requestURL + ' RTSP/1.0\r\n';
            this.rtspUrl = requestURL;
          }
        } else if (this.ContentBase && this.deviceType === 'nvr') {
          sendMessage = method + ' ' + this.ContentBase + ' RTSP/1.0\r\n';
        } else {
          sendMessage = method + ' ' + this.rtspUrl + ' RTSP/1.0\r\n';
        }
        sendMessage += 'CSeq: ' + this.CSeq + '\r\n';
        sendMessage += 'Session: ' + this.SessionId + '\r\n';
        sendMessage += UserAgentField;
        if (this.mode === 'playback' || this.mode === 'backup') {
          if (this.deviceType === 'camera') {
            sendMessage += 'Require: samsung-replay-timezone' + '\r\n';
          } else {
            sendMessage += 'Require: onvif-replay' + '\r\n';
          }
        }
        if (typeof extHeader !== 'undefined' && extHeader !== null && extHeader !== '') {
          sendMessage += extHeader;
        }
        break;
      case 'PAUSE':
        if (
          typeof requestURL !== 'undefined' &&
          requestURL !== null &&
          requestURL !== '' &&
          requestURL.toLowerCase().indexOf('rtsp:') !== -1
        ) {
          if (this.ContentBase && this.deviceType === 'nvr') {
            sendMessage = method + ' ' + this.ContentBase + ' RTSP/1.0\r\n';
          } else {
            sendMessage = method + ' ' + requestURL + ' RTSP/1.0\r\n';
            this.rtspUrl = requestURL;
          }
        } else if (this.ContentBase && this.deviceType === 'nvr') {
          sendMessage = method + ' ' + this.ContentBase + ' RTSP/1.0\r\n';
        } else {
          sendMessage = method + ' ' + this.rtspUrl + ' RTSP/1.0\r\n';
        }
        sendMessage += 'CSeq: ' + this.CSeq + '\r\n';
        sendMessage += 'Session: ' + this.SessionId + '\r\n';
        sendMessage += UserAgentField;
        if (typeof extHeader !== 'undefined' && extHeader !== null && extHeader !== '') {
          sendMessage += extHeader;
        }
        break;
      default:
        break;
    }
    sendMessage += '\r\n';
    return sendMessage;
  }

  private _request(method: string, requestURL?: string | null, extHeader?: string | null): void {
    try {
      const newObj = { method, requestURL, extHeader };

      if (method === 'TEARDOWN') {
        if (this.isRequested) {
          this.rtspQueue.splice(1, 0, newObj);
        } else {
          this.rtspQueue.unshift(newObj);
        }
      } else {
        this.rtspQueue.push(newObj);
      }

      if (this.rtspQueue.length === 1) {
        this._send(method, requestURL, extHeader);
      }
    } catch {
      // legacy: console.error(error) only, no further effect.
    }
  }

  private _send(method: string, requestURL?: string | null, extHeader?: string | null): void {
    try {
      const message = this.CommandConstructor(method, requestURL, extHeader);
      if (message) {
        if (this.rtspCallbackFunc) {
          this.rtspCallbackFunc(message);
        }
        this.isRequested = true;
        if (typeof this.transport !== 'undefined' && this.transport !== null) {
          this.transport.SendRtspCommand(message, (response) => {
            this.isRequested = false;
            if (response instanceof RTSPError) {
              this.errorCallbackFunc({
                channelId: this.channelId,
                errorCode: fromHex('0x0210'),
                place: 'RtspClient.js:_send',
                message: 'RTSP command control error'
              });
            }
            this.RtspResponseHandler(response as unknown as string);

            if (this.rtspQueue.length) {
              this.rtspQueue.shift();
            }
            if (this.rtspQueue.length > 0) {
              setTimeout(() => {
                this._send(this.rtspQueue[0].method, this.rtspQueue[0].requestURL, this.rtspQueue[0].extHeader);
              });
            }
          });
        }

        if (message === null || method === 'TEARDOWN') {
          this.nextState = 'Teardown';
          const checkIntervalHandler = setInterval(() => {
            if (this.currentState === 'Playing' && this.nextState === 'Teardown') {
              clearInterval(checkIntervalHandler);
              if (typeof this.transport !== 'undefined' && this.transport !== null) {
                this.clearTransport();
              }
            }
          }, 500);
        }
      }
    } catch {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: fromHex('0x0210'),
        place: 'rtspClient.js:_send()',
        message: 'RTSP command control error'
      });
    }
  }

  private clearRTSPQueue(): void {
    this.rtspQueue = [];
  }

  /* eslint-disable no-magic-numbers */
  parseDescribeResponse(response: string): DescribeResponse {
    const result: DescribeResponse = {
      Origin: [] as unknown[] & SdpOriginInfo,
      ConnectionData: [] as unknown[] & SdpConnectionDataInfo,
      Sessions: []
    };

    let params: string[] | null = null;

    const token = response.split('\r\n\r\n');
    const sdpTokens = (token[1] || response).split(/(?=m=)/);

    const version = sdpTokens[0].match(/v=(\S+)/);
    if (version && parseInt(version[1], 10) !== 0) {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: fromHex('0x0208'),
        place: 'rtspClient:parseDescribeResponse',
        message: 'This sdp version is not support. version: ' + version[1]
      });
    }
    if (version) {
      result.version = parseInt(version[1], 10);
    }

    const origin = sdpTokens[0].match(/o=(\S+) (\S+) (\S+) (\S+) (\S+) (\S+)/);
    if (origin) {
      result.Origin.UserName = origin[1];
      result.Origin.SessionId = origin[2];
      result.Origin.SessionVersion = origin[3];
      result.Origin.NetworkType = origin[4];
      result.Origin.AddressType = origin[5];
      result.Origin.UnicastAddress = origin[6];
    }
    const sessionInformation = sdpTokens[0].match(/i=(\S+)/);
    if (sessionInformation) {
      result.sessionInformation = sessionInformation[1];
    }
    const connectionData = sdpTokens[0].match(/c=(\S+) (\S+) (\S+)/);
    if (connectionData) {
      result.ConnectionData.NetworkType = connectionData[1];
      result.ConnectionData.AddressType = connectionData[2];
      result.ConnectionData.ConnectionAddress = connectionData[3];
    }

    let found: RegExpMatchArray | null = sdpTokens[0].match(/a=control:(\S+)/);
    if (found) {
      result.BaseURL = found[1];
    }

    for (let i = 1; i < sdpTokens.length; i += 1) {
      const session: SdpParsedSession = {};

      found = sdpTokens[i].match(/m=(\S+) (\S+) \S+ (\S+)/);
      if (found) {
        session.Type = found[1];
        session.Port = found[2];
        session.Payload = found[3];
      }

      found = sdpTokens[i].match(/a=control:(\S+)/);
      if (found) {
        session.ControlURL = found[1];
      }

      found = sdpTokens[i].match(/a=rtpmap:(\S+) (\S+)/);
      if (found) {
        session.PayloadType = found[1];
        params = found[2].split('/');
        session.CodecMime = params[0];
        session.ClockFreq = params[1];
        if (params[2]) {
          session.EncodingParams = params[2];
        }
      }

      found = sdpTokens[i].match(/a=framesize:\S+ (\d+)-(\d+)/);
      if (found) {
        session.Width = found[1];
        session.Height = found[2];
      }

      found = sdpTokens[i].match(/a=framerate:([0-9.]+)/);
      if (found) {
        session.Framerate = found[1];
      }

      found = sdpTokens[i].match(/a=fingerprint:(\S+) (\S+)/);
      if (found) {
        session.DTLS_Param = found[1];
        session.DTLS_SRTP = found[2];
      }

      found = sdpTokens[i].match(/b=(\w+):(\d+)/);
      if (found) {
        session.BandwidthType = found[1];
        session.Bandwidth = found[2];
        switch (session.BandwidthType) {
          case 'AS':
            session.Bitrate = session.Bandwidth;
            break;
          case 'RS':
          case 'RR':
            break;
          default:
            break;
        }
      }

      found = sdpTokens[i].match(/a=fmtp:\S+ (.+)/);
      if (found) {
        const fmtpParams = found[1];
        let fmtpFound: RegExpMatchArray | null;

        fmtpFound = fmtpParams.match(/mode=(\S+?)(?=;|$)/);
        if (fmtpFound) session.mode = fmtpFound[1];

        fmtpFound = fmtpParams.match(/config=(\S+)(?=;|$)/);
        if (fmtpFound) session.config = fmtpFound[1];

        fmtpFound = fmtpParams.match(/profile-level-id=(\S+)(?=;|$)/);
        if (fmtpFound) session.profile_level_id = fmtpFound[1].match(/\d+/g)![0];

        fmtpFound = fmtpParams.match(/streamtype=(\S+)(?=;|$)/);
        if (fmtpFound) session.streamtype = fmtpFound[1];

        fmtpFound = fmtpParams.match(/SizeLength=(\S+)(?=;|$)/);
        if (fmtpFound) session.SizeLength = fmtpFound[1];

        fmtpFound = fmtpParams.match(/IndexLength=(\S+)(?=;|$)/);
        if (fmtpFound) session.IndexLength = fmtpFound[1];

        fmtpFound = fmtpParams.match(/IndexDeltaLength=(\S+)(?=;|$)/);
        if (fmtpFound) session.IndexDeltaLength = fmtpFound[1];

        fmtpFound = fmtpParams.match(/profile=(\S+)(?=;|$)/);
        if (fmtpFound) session.profile = fmtpFound[1];

        fmtpFound = fmtpParams.match(/bitrate=(\S+)(?=;|$)/);
        if (fmtpFound) session.bitrate = fmtpFound[1];

        fmtpFound = fmtpParams.match(/sprop-vps=(\S+)(?=;|$)/);
        if (fmtpFound) session.VPS = fmtpFound[1];

        fmtpFound = fmtpParams.match(/sprop-sps=(\S+)(?=;|$)/);
        if (fmtpFound) session.SPS = fmtpFound[1];

        fmtpFound = fmtpParams.match(/sprop-pps=(\S+)(?=;|$)/);
        if (fmtpFound) session.PPS = fmtpFound[1];

        fmtpFound = fmtpParams.match(/sprop-parameter-sets=(\S+),(\S+)(?=;|$)/);
        if (fmtpFound) {
          session.SPS = fmtpFound[1];
          session.PPS = fmtpFound[2];
        }
      }

      found = sdpTokens[i].match(/i=(.+)/);
      if (found) {
        session.information = found[1];
      }

      result.Sessions.push(session);
    }

    return result;
  }
  /* eslint-enable no-magic-numbers */

  toStringExtensionScale(value: number | string, direction?: 'forward' | 'backward'): string {
    let extraheader = '';
    if (typeof value === 'string') {
      extraheader += 'Scale: ' + value + '\r\n';
    } else if (Number(value) === 0) {
      if (direction === 'forward') {
        extraheader += 'Scale: ' + '+' + value.toFixed(2).toString() + '\r\n';
      } else if (direction === 'backward') {
        extraheader += 'Scale: ' + '-' + value.toFixed(2).toString() + '\r\n';
      } else {
        extraheader += 'Scale: ' + value.toFixed(2).toString() + '\r\n';
      }
    } else {
      extraheader += 'Scale: ' + value.toFixed(2).toString() + '\r\n';
    }
    return extraheader;
  }

  parseRtspResponse(message1: string): RtspResponseData {
    const RtspResponseData: RtspResponseData = {};

    let message: string;
    if (message1.search('Content-Type: application/sdp') !== -1) {
      const messageTok = message1.split('\r\n\r\n');
      message = messageTok[0];
    } else {
      message = message1;
    }

    const TokenziedResponseLines = message.split('\r\n');

    const ResponseCodeTokens = TokenziedResponseLines[0].split(' ');
    if (ResponseCodeTokens.length > 2) {
      RtspResponseData.ResponseCode = parseInt(ResponseCodeTokens[1]);
      RtspResponseData.ResponseMessage = ResponseCodeTokens[2];
    }

    if (RtspResponseData.ResponseCode === 200) {
      for (let cnt = 1; cnt < TokenziedResponseLines.length; cnt++) {
        const LineTokens = TokenziedResponseLines[cnt].split(':');
        if (LineTokens[0] === 'Public') {
          RtspResponseData.MethodsSupported = LineTokens[1].split(',');
        } else if (LineTokens[0] === 'CSeq') {
          RtspResponseData.CSeq = parseInt(LineTokens[1]);
        } else if (LineTokens[0] === 'Content-Type') {
          RtspResponseData.ContentType = LineTokens[1];
          if (RtspResponseData.ContentType.search('application/sdp') !== -1) {
            RtspResponseData.SDPData = this.parseDescribeResponse(message1);
          }
        } else if (LineTokens[0] === 'Content-Length') {
          RtspResponseData.ContentLength = parseInt(LineTokens[1]);
        } else if (LineTokens[0] === 'Content-Base') {
          const ppos = TokenziedResponseLines[cnt].search('Content-Base:');
          if (ppos !== -1) {
            RtspResponseData.ContentBase = TokenziedResponseLines[cnt].substr(ppos + 14);
          }
        } else if (LineTokens[0] === 'Session') {
          const SessionTokens = LineTokens[1].split(';');
          RtspResponseData.SessionID = SessionTokens[0].replace(' ', '');
          if (
            typeof SessionTokens[1] !== 'undefined' &&
            SessionTokens[1] !== null &&
            SessionTokens[1].search('timeout') !== -1
          ) {
            RtspResponseData.TimeOut = SessionTokens[1].split('=')[1];
          }
        } else if (LineTokens[0] === 'Transport') {
          const TransportTokens = LineTokens[1].split(';');
          for (let cnt1 = 0; cnt1 < TransportTokens.length; cnt1++) {
            const tpos = TransportTokens[cnt1].search('interleaved=');
            if (tpos !== -1) {
              const interleaved = TransportTokens[cnt1].substr(tpos + 12);
              const interleavedTokens = interleaved.split('-');
              if (interleavedTokens.length > 1) {
                RtspResponseData.RtpInterlevedID = parseInt(interleavedTokens[0]);
                RtspResponseData.RtcpInterlevedID = parseInt(interleavedTokens[1]);
              }
            }
          }
        } else if (LineTokens[0] === 'RTP-Info') {
          const rtpInfoValue = TokenziedResponseLines[cnt].substr(9);
          const RTPInfoTokens = rtpInfoValue.split(',');
          RtspResponseData.RTPInfoList = [];
          for (let cnt1 = 0; cnt1 < RTPInfoTokens.length; cnt1++) {
            const RtpTokens = RTPInfoTokens[cnt1].split(';');
            const RtpInfo: RtpInfoEntry = {};
            for (let cnt2 = 0; cnt2 < RtpTokens.length; cnt2++) {
              let poss = RtpTokens[cnt2].search('url=');
              if (poss !== -1) {
                RtpInfo.URL = RtpTokens[cnt2].substr(poss + 4);
              }
              poss = RtpTokens[cnt2].search('seq=');
              if (poss !== -1) {
                RtpInfo.Seq = parseInt(RtpTokens[cnt2].substr(poss + 4));
              }
            }
            RtspResponseData.RTPInfoList.push(RtpInfo);
          }
        }
      }
    } else if (RtspResponseData.ResponseCode === 401) {
      RtspResponseData.WWWAuthenticate = [];
      let authticateCount = 0;
      for (let cnt = 1; cnt < TokenziedResponseLines.length; cnt++) {
        const LineTokens = TokenziedResponseLines[cnt].split(':');
        if (LineTokens[0] === 'CSeq') {
          RtspResponseData.CSeq = parseInt(LineTokens[1]);
        } else if (LineTokens[0] === 'WWW-Authenticate') {
          RtspResponseData.WWWAuthenticate[authticateCount] = this.parseWWWAuthenticate(LineTokens[1]);
          authticateCount++;
        }
      }
    }

    return RtspResponseData;
  }

  parseWWWAuthenticate(authenticateString: string): ParsedWwwAuthenticate {
    const parserData: ParsedWwwAuthenticate = {
      method: null,
      realm: null,
      nonce: null,
      opaque: null,
      algorithm: null,
      qop: null
    };
    authenticateString.split(' ').forEach((element) => {
      let pos: number;
      if ((pos = element.search(/Basic/gi)) !== -1) {
        parserData.method = element;
      }
      if ((pos = element.search(/Digest/gi)) !== -1) {
        parserData.method = element;
      }
      if ((pos = element.search(/realm="/gi)) !== -1) {
        parserData.realm = element.substr(pos + 5).split('"')[1];
      }
      if ((pos = element.search(/nonce="/gi)) !== -1) {
        parserData.nonce = element.substr(pos + 5).split('"')[1];
      }
      if ((pos = element.search(/opaque="/gi)) !== -1) {
        parserData.opaque = element.substr(pos + 6).split('"')[1];
      }
      if ((pos = element.search(/algorithm="/gi)) !== -1) {
        parserData.algorithm = element.substr(pos + 9).split('"')[1];
      }
      if ((pos = element.search(/qop="/gi)) !== -1) {
        parserData.qop = element.substr(pos + 3).split('"')[1];
      }
    });
    return parserData;
  }

  private formDigestAuthHeader(uri: string): void {
    const digestInfo = this.digestGenerator.getDigestInfoInWwwAuthenticate(this.wwwAuthenticate!);
    const data: AuthenticateData & { Nc?: string; Cnonce?: string } = {
      Method: this.currentState.toUpperCase(),
      Uri: encodeURIComponent(uri),
      username: this.id!,
      password: this.pw!,
      Realm: '',
      Nonce: ''
    };

    if (digestInfo.length > 0) {
      digestInfo.forEach((element) => {
        if (
          typeof element.qop !== 'undefined' &&
          element.qop !== null &&
          typeof element.algorithm !== 'undefined' &&
          element.algorithm !== null &&
          typeof element.opaque !== 'undefined' &&
          element.opaque !== null
        ) {
          data.Qop = element.qop;
          data.Algorithm = element.algorithm;
          data.Opaque = element.opaque;
        }
        data.Realm = element.realm ?? '';
        data.Nonce = element.nonce ?? '';
      });
    }

    if (
      typeof this.pw !== 'undefined' &&
      this.pw !== null &&
      typeof this.pw === 'string' &&
      this.pw !== '' &&
      (typeof this.sunapiClient === 'undefined' || this.sunapiClient === null)
    ) {
      this.Authentication = this.digestGenerator.getAuthenticate(data);
      this.SendUnauthorizedRtspCmd();
    } else if (this.sunapiClient !== null && this.sunapiClient !== undefined) {
      this.digestGenerator.generateClientNonce();
      data.Nc = decimalToHex(this.digestGenerator.nc, 8);
      data.Cnonce = this.digestGenerator.cnonce;
      const sunapiUri = '/stw-cgi/security.cgi?msubmenu=digestauth&action=view';

      this.sunapiClient.get(
        sunapiUri,
        data,
        (response) => {
          let responseValue: unknown;
          if (this.deviceType === 'camera') {
            responseValue = response.data?.Response;
          } else if (response.data !== undefined) {
            responseValue = response.data.Response;
          } else {
            responseValue = response.Response;
          }
          this.Authentication = this.digestGenerator.getAuthenticate(data, responseValue as string);
          this.SendUnauthorizedRtspCmd();
        },
        (errorCode) => this.sunapiErrorResponse(errorCode),
        '',
        true
      );
    } else {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: fromHex('0x0403'),
        place: 'rtspClient.js:404',
        message:
          'The sunapi client & password is not exist. If you want to connect deivce, you have to put the user password or sunapi client for device connect'
      });
    }
  }

  private sunapiErrorResponse(errorCode: unknown): void {
    let errorHexCode: string;
    let oldErrorCode: string | undefined;
    switch (Number.parseInt(String(errorCode), 10)) {
      case 401:
        errorHexCode = '0x0206';
        oldErrorCode = '401';
        break;
      case 490:
        errorHexCode = '0x020B';
        oldErrorCode = '490';
        break;
      default:
        errorHexCode = '0x0701';
        break;
    }
    this.errorCallbackFunc({
      errorCode: fromHex(errorHexCode),
      oldErrorCode,
      currentState: this.currentState,
      place: 'RtspClient.js:formDigestAuthHeader',
      channelId: this.channelId
    });

    if (this.transport) {
      this.clearTransport();
    }
  }

  private SendUnauthorizedRtspCmd(): void {
    let extraheader = '';
    if (this.currentState === 'Options') {
      this._request('OPTIONS', null, null);
    } else if (this.currentState === 'Describe') {
      extraheader += 'Accept: application/sdp\r\n';
      this._request('DESCRIBE', null, extraheader);
    } else if (this.currentState === 'Setup') {
      extraheader =
        'Transport: RTP/AVP/TCP;unicast;interleaved=' +
        (2 * this.setupSDPIndex).toString() +
        '-' +
        (2 * this.setupSDPIndex + 1).toString() +
        '\r\n';
      extraheader += 'Accept: application/sdp\r\n';
      this._request('SETUP', this.SDPinfo[this.setupSDPIndex].trackID, extraheader);
    } else if (this.currentState === 'Play') {
      if (this.mode === 'playback') {
        extraheader = 'Immediate: yes' + '\r\n' + 'Scale: ' + '1.000000' + '\r\n' + 'Range: npt=0.000-' + '\r\n' + 'Rate-Control: yes' + '\r\n';
      } else if (this.mode === 'backup') {
        extraheader += 'Rate-Control: no' + '\r\n';
        if (this.deviceType === 'nvr') {
          extraheader += 'BackupBandwidth: ' + this.backupBandwidth + '\r\n';
        }
      }
      this._request('PLAY', null, extraheader);
      this.isPausing = false;
    } else if (this.currentState === 'Pause') {
      this._request('PAUSE', null, null);
      this.isPausing = true;
    }
  }

  private checkIsAvaliablePlayback(mode: string): void {
    let playbackAliveCount = 0;
    if (mode === 'backup' || mode === 'playback') {
      if (this.checkAliveIntervalHandler === null) {
        this.checkAliveIntervalHandler = setInterval(() => {
          this.rtpClient!.running = this.isRTPRunning;
          if (!this.isRTPRunning) {
            if (playbackAliveCount > 3) {
              clearInterval(this.checkAliveIntervalHandler!);
              this.checkAliveIntervalHandler = null;
              this.errorCallbackFunc({
                errorCode: fromHex('0x0609'),
                oldErrorCode: '990',
                description: 'end of backup',
                place: 'RtspClient.js:checkIsAvaliablePlayback',
                channelId: this.channelId
              });
              return;
            }
            playbackAliveCount++;
          } else {
            playbackAliveCount = 0;
          }
          this.isRTPRunning = false;
        }, 1000);
      }
    }
  }

  private getParameterIntervalHandlerFunc(): ReturnType<typeof setInterval> {
    return setInterval(() => {
      if (this.transport) {
        this._request(this.checkAliveCommand, null, null);
        this.isGetParameterRequest = true;
      }
    }, 10000);
  }

  private checkAliveIntervalHandlerFunc(): ReturnType<typeof setInterval> {
    return setInterval(() => {
      this.rtpClient!.running = this.isRTPRunning;

      if (!this.isRTPRunning) {
        if (this.aliveCounter > 6) {
          if (this.checkAliveIntervalHandler !== null) {
            clearInterval(this.checkAliveIntervalHandler);
            this.checkAliveIntervalHandler = null;
          }
          if (this.getParameterIntervalHandler !== null) {
            clearInterval(this.getParameterIntervalHandler);
            this.getParameterIntervalHandler = null;
          }

          if (this.isConnected) {
            try {
              this._request(this.checkAliveCommand, null, null);
              this.checkRtspAlive = true;

              setTimeout(() => {
                if (this.checkRtspAlive) {
                  this.checkRtspAlive = false;
                  this.errorCallbackFunc({
                    errorCode: fromHex('0x0209'),
                    oldErrorCode: '999',
                    description: 'no rtsp response',
                    place: 'RtspClient.js:515',
                    channelId: this.channelId
                  });
                  const videoSession = this.rtpClient!.getRtpSessionWithType('video');
                  if (videoSession !== null && typeof videoSession !== 'undefined' && videoSession.type === 'video') {
                    const videoTimer = videoSession.getStatisticsTimer();
                    if (videoTimer !== null && typeof videoTimer !== 'undefined') {
                      videoTimer.pause();
                    }
                  }
                  const audioSession = this.rtpClient!.getRtpSessionWithType('audio');
                  if (audioSession !== null && typeof audioSession !== 'undefined' && audioSession.type === 'audio') {
                    const audioTimer = audioSession.getStatisticsTimer();
                    if (audioTimer !== null && typeof audioTimer !== 'undefined') {
                      audioTimer.pause();
                    }
                  }
                }
              }, 5000);
            } catch {
              this.errorCallbackFunc({
                errorCode: fromHex('0x0209'),
                oldErrorCode: '999',
                description: 'no rtsp response',
                place: 'RtspClient.js:525',
                channelId: this.channelId
              });
            }
          } else {
            this.errorCallbackFunc({
              errorCode: fromHex('0x0006'),
              type: 'rtsp',
              description: 'tranport is not exist',
              place: 'RtspClient.js:534',
              channelId: this.channelId
            });
          }
          return;
        }
        this.aliveCounter++;
      }

      if (!this.instantplayback) {
        if (this.isPausing || this.mode === 'live') {
          this.isRTPRunning = false;
        }
      }
    }, 1000);
  }

  getSessionId(interleavedId?: number): string | number {
    if (typeof this.rtpClient === 'undefined' || this.rtpClient === null) {
      return NO_SESSION;
    }

    let session: RtpSessionLike | null | undefined;
    if (typeof interleavedId !== 'undefined' && interleavedId !== null) {
      session = this.rtpClient.getRtpSession(interleavedId);
    } else {
      const videoSession = this.rtpClient.getRtpSessionWithType('video');
      const audioSession = this.rtpClient.getRtpSessionWithType('audio');
      const metaSession = this.rtpClient.getRtpSessionWithType('meta');

      if (typeof videoSession !== 'undefined' && videoSession !== null) {
        session = videoSession;
      } else if (typeof audioSession !== 'undefined' && audioSession !== null) {
        session = audioSession;
      } else if (typeof metaSession !== 'undefined' && metaSession !== null) {
        session = metaSession;
      }
    }

    if (
      typeof session !== 'undefined' &&
      session !== null &&
      typeof session.sessionId !== 'undefined' &&
      session.sessionId !== null
    ) {
      return session.sessionId;
    }

    return NO_SESSION;
  }

  RtspResponseHandler(stringMessage: string): void {
    if (typeof stringMessage !== 'string') {
      this.errorCallbackFunc({
        errorCode: fromHex('0x020F'),
        oldErrorCode: '999',
        description: 'rtsp response is not string type, it has error.',
        place: 'RtspClient.js:RtspResponseHandler',
        channelId: this.channelId
      });
      return;
    }

    if (this.rtspCallbackFunc) {
      this.rtspCallbackFunc(stringMessage);
    }

    const seekPoint = stringMessage.search('CSeq: ') + 5;
    const _CSeq = parseInt(stringMessage.slice(seekPoint, seekPoint + 10));

    if (this.CSeq !== _CSeq) {
      this.errorCallbackFunc({
        errorCode: fromHex('0x020F'),
        oldErrorCode: '999',
        description: 'rtsp sequence number is not matched. it has error',
        place: 'RtspClient.js:RtspResponseHandler',
        channelId: this.channelId
      });
    } else {
      this.CSeq = this.CSeq + 1;
    }

    const rtspResponseMsg = this.parseRtspResponse(stringMessage);
    if (rtspResponseMsg.ContentBase) {
      this.ContentBase = rtspResponseMsg.ContentBase;
    }

    if (this.checkRtspAlive) {
      this.checkRtspAlive = false;
      if (rtspResponseMsg.ResponseCode === 200) {
        this.getParameterIntervalHandler = this.getParameterIntervalHandlerFunc();
        this.checkAliveIntervalHandler = this.checkAliveIntervalHandlerFunc();
      } else {
        this.errorCallbackFunc({
          errorCode: fromHex('0x0209'),
          oldErrorCode: '999',
          description: 'no rtsp response',
          place: 'RtspClient.js:RtspResponseHandler',
          channelId: this.channelId
        });
      }
    }

    let status: RtspStatusCode;

    if (rtspResponseMsg.ResponseCode === 401) {
      this.unahtuorizedCount++;
      this.wwwAuthenticate = stringMessage.slice(stringMessage.search('WWW-Authenticate'), stringMessage.length);
      this.formDigestAuthHeader(this.rtspUrl!);

      if (this.unahtuorizedCount > 2) {
        status = new RtspStatusCode(rtspResponseMsg.ResponseCode);
        this.errorCallbackFunc({
          errorCode: fromHex('0x0206'),
          currentState: this.currentState,
          oldErrorCode: '401',
          rtspCode: status.getStatusCode(),
          description: 'RTSP Play Streaming: ' + status.getStatusCode() + ', error message: ' + status.getDescription(),
          name: status.getName(),
          place: 'RtspClient.js:RtspResponseHandler',
          channelId: this.channelId
        });
        if (this.transport) {
          this.clearTransport();
        }
      }
      return;
    } else if (rtspResponseMsg.ResponseCode === 200) {
      this.handleResponse200(rtspResponseMsg);
      if (this.isGetParameterRequest) {
        this.isGetParameterRequest = false;
      }
      return;
    } else if (rtspResponseMsg.ResponseCode === 503) {
      if (
        this.currentState === 'Setup' &&
        (this.SDPinfo[this.setupSDPIndex].trackID.search('trackID=t') !== -1 ||
          this.SDPinfo[this.setupSDPIndex].trackID.search('trackID=back') !== -1)
      ) {
        this.handleResponse503Setup();
        return;
      }
      status = new RtspStatusCode(rtspResponseMsg.ResponseCode);
      this.errorCallbackFunc({
        errorCode: fromHex('0x0201'),
        oldErrorCode: '503',
        rtspCode: status.getStatusCode(),
        description: 'RTSP error code: ' + status.getStatusCode() + ', error message: ' + status.getDescription(),
        name: status.getName(),
        place: 'RtspClient.js:RtspResponseHandler',
        channelId: this.channelId
      });
    } else if (rtspResponseMsg.ResponseCode === 560) {
      status = new RtspStatusCode(rtspResponseMsg.ResponseCode);
      this.errorCallbackFunc({
        errorCode: fromHex('0x0204'),
        rtspCode: status.getStatusCode(),
        description: 'RTSP error code: ' + status.getStatusCode() + ', error message: ' + status.getDescription(),
        name: status.getName(),
        place: 'RtspClient.js:RtspResponseHandler',
        channelId: this.channelId
      });
    } else if (rtspResponseMsg.ResponseCode === 404) {
      status = new RtspStatusCode(rtspResponseMsg.ResponseCode);
      this.errorCallbackFunc({
        errorCode: fromHex('0x0205'),
        oldErrorCode: '404',
        rtspCode: status.getStatusCode(),
        description: 'RTSP error code: ' + status.getStatusCode() + ', error message: ' + status.getDescription(),
        name: status.getName(),
        place: 'RtspClient.js:RtspResponseHandler',
        channelId: this.channelId
      });
    } else if (rtspResponseMsg.ResponseCode === 490) {
      status = new RtspStatusCode(rtspResponseMsg.ResponseCode);
      this.errorCallbackFunc({
        errorCode: fromHex('0x020B'),
        oldErrorCode: '490',
        rtspCode: status.getStatusCode(),
        description: 'RTSP error code: ' + status.getStatusCode() + ', error message: ' + status.getDescription(),
        name: status.getName(),
        place: 'RtspClient.js:RtspResponseHandler',
        channelId: this.channelId
      });
    } else {
      status = new RtspStatusCode(rtspResponseMsg.ResponseCode);
      this.errorCallbackFunc({
        errorCode: fromHex('0x0203'),
        rtspCode: status.getStatusCode(),
        description: 'RTSP error code: ' + status.getStatusCode() + ', error message: ' + status.getDescription(),
        name: status.getName(),
        place: 'RtspClient.js:RtspResponseHandler',
        channelId: this.channelId
      });
    }

    if (this.transport !== null) {
      this.clearTransport();
    }
  }

  private handleResponse503Setup(): void {
    this.SDPinfo[this.setupSDPIndex].RtpInterlevedID = -1;
    this.SDPinfo[this.setupSDPIndex].RtcpInterlevedID = -1;

    this.setupSDPIndex += 1;
    this.audioTalkServiceStatus = false;

    this.errorCallbackFunc({
      errorCode: fromHex('0x020A'),
      oldErrorCode: '504',
      description: 'Talk Service Unavilable',
      place: 'RtspClient.js:RtspResponseHandler',
      channelId: this.channelId
    });

    let extraheader = '';
    if (this.setupSDPIndex < this.SDPinfo.length) {
      extraheader =
        'Transport: RTP/AVP/TCP;unicast;interleaved=' +
        (2 * this.setupSDPIndex).toString() +
        '-' +
        (2 * this.setupSDPIndex + 1).toString() +
        '\r\n';
      this._request('SETUP', this.SDPinfo[this.setupSDPIndex].trackID, extraheader);
    } else {
      this.currentState = 'Play';
      if (this.mode === 'playback') {
        extraheader = 'Immediate: yes' + '\r\n' + 'Rate-Control: yes' + '\r\n';
        if (this.deviceType === 'camera') {
          extraheader += 'Scale: ' + '1.000000' + '\r\n';
        } else {
          extraheader += this.toStringExtensionScale(this.scale!);
        }
        if (typeof this.rangeClock !== 'undefined' && this.rangeClock !== null) {
          extraheader += 'Range: clock=' + this.rangeClock;
          if (this.rangeClock.search('-') === -1) {
            extraheader += '-';
          }
          extraheader += '\r\n';
        } else {
          extraheader += 'Range: npt=0.000-\r\n';
        }
      }
      this._request('PLAY', null, extraheader);
      this.nextState = 'Playing';
    }
  }

  private handleResponse200(rtspResponseMsg: RtspResponseData): void {
    let extraheader = '';
    let status: RtspStatusCode;

    if (this.currentState === 'Options') {
      this.currentState = 'Describe';
      let extHeader = 'Accept: application/sdp\r\n';
      if (this.bestshot) {
        extHeader = 'Require: Bestshot\r\n';
      }
      this._request('DESCRIBE', null, extHeader);
      this.nextState = 'Setup';
    } else if (this.currentState === 'Describe' && this.nextState !== 'Teardown') {
      this.currentState = 'Setup';
      if (typeof rtspResponseMsg.SDPData === 'undefined' || rtspResponseMsg.SDPData === null) {
        throw new RTSPOverWebSocketError({
          channelId: this.channelId,
          errorCode: fromHex('0x0210'),
          place: 'rtspClient.js:RtspResponseHandler',
          message: 'RTSP command control error'
        });
      }
      this.audioTalkServiceStatus = false;
      this.unahtuorizedCount = 0;
      const rtspSDPData = rtspResponseMsg.SDPData;

      for (let idx = 0; idx < rtspSDPData.Sessions.length; idx += 1) {
        const sdpInfoObj: SdpInfoEntry = { Type: rtspSDPData.Sessions[idx].Type ?? '', trackID: '' };
        const codecMime = rtspSDPData.Sessions[idx].CodecMime ?? '';
        if (codecMime === 'JPEG' || codecMime === 'H264' || codecMime === 'H265') {
          sdpInfoObj.codecName = codecMime;
          sdpInfoObj.trackID = rtspSDPData.Sessions[idx].ControlURL ?? '';
          sdpInfoObj.ClockFreq = rtspSDPData.Sessions[idx].ClockFreq;
          sdpInfoObj.Port = parseInt(rtspSDPData.Sessions[idx].Port ?? '');
          if (rtspSDPData.Sessions[idx].Framerate !== undefined) {
            sdpInfoObj.Framerate = parseInt(rtspSDPData.Sessions[idx].Framerate!);
          }
          if (typeof rtspSDPData.Sessions[idx].information !== 'undefined') {
            sdpInfoObj.information = rtspSDPData.Sessions[idx].information;
          }
          this.SDPinfo.push(sdpInfoObj);
        } else if (
          codecMime === 'PCMU' ||
          codecMime === 'PCMA' ||
          codecMime.search('G726-16') !== -1 ||
          codecMime.search('G726-24') !== -1 ||
          codecMime.search('G726-32') !== -1 ||
          codecMime.search('G726-40') !== -1
        ) {
          const controlUrl = rtspSDPData.Sessions[idx].ControlURL ?? '';
          if (controlUrl.search('trackID=t') !== -1 || controlUrl.search('trackID=back') !== -1) {
            sdpInfoObj.codecName = 'G.711';
            sdpInfoObj.codecMime = codecMime;
            sdpInfoObj.trackID = controlUrl;
            sdpInfoObj.Port = parseInt(rtspSDPData.Sessions[idx].Port ?? '');
            sdpInfoObj.Bitrate = parseInt(rtspSDPData.Sessions[idx].Bitrate ?? '');
            this.SDPinfo.push(sdpInfoObj);
            this.audioTalkServiceStatus = true;
            this.transport!.autoconnection = true;
          } else {
            if (codecMime === 'PCMU' || codecMime === 'PCMA') {
              sdpInfoObj.codecName = 'G.711';
            } else if (codecMime === 'G726-16') {
              sdpInfoObj.codecName = 'G.726-16';
            } else if (codecMime === 'G726-24') {
              sdpInfoObj.codecName = 'G.726-24';
            } else if (codecMime === 'G726-32') {
              sdpInfoObj.codecName = 'G.726-32';
            } else if (codecMime === 'G726-40') {
              sdpInfoObj.codecName = 'G.726-40';
            }
            sdpInfoObj.codecMime = codecMime;
            sdpInfoObj.trackID = controlUrl;
            sdpInfoObj.ClockFreq = rtspSDPData.Sessions[idx].ClockFreq;
            sdpInfoObj.Port = parseInt(rtspSDPData.Sessions[idx].Port ?? '');
            sdpInfoObj.Bitrate = parseInt(rtspSDPData.Sessions[idx].Bitrate ?? '');
            this.SDPinfo.push(sdpInfoObj);
          }
        } else if (codecMime.toLowerCase() === 'mpeg4-generic') {
          sdpInfoObj.codecName = 'mpeg4-generic';
          sdpInfoObj.codecMime = codecMime;
          sdpInfoObj.trackID = rtspSDPData.Sessions[idx].ControlURL ?? '';
          sdpInfoObj.ClockFreq = rtspSDPData.Sessions[idx].ClockFreq;
          sdpInfoObj.Port = parseInt(rtspSDPData.Sessions[idx].Port ?? '');
          sdpInfoObj.Bitrate = parseInt(rtspSDPData.Sessions[idx].Bitrate ?? '');
          sdpInfoObj.config = rtspSDPData.Sessions[idx].config;
          this.SDPinfo.push(sdpInfoObj);
        } else if (codecMime === 'vnd.onvif.metadata') {
          sdpInfoObj.codecName = 'MetaData';
          sdpInfoObj.trackID = rtspSDPData.Sessions[idx].ControlURL ?? '';
          sdpInfoObj.ClockFreq = rtspSDPData.Sessions[idx].ClockFreq;
          sdpInfoObj.Port = parseInt(rtspSDPData.Sessions[idx].Port ?? '');
          this.SDPinfo.push(sdpInfoObj);
        } else {
          this.errorCallbackFunc({
            errorCode: fromHex('0x0300'),
            description: 'Unknown codec type:' + codecMime + ', Control URL:' + rtspSDPData.Sessions[idx].ControlURL,
            place: 'RtspClient.js:RtspResponseHandler',
            channelId: this.channelId
          });
        }
      }

      this.setupSDPIndex = 0;
      extraheader =
        'Transport: RTP/AVP/TCP;unicast;interleaved=' +
        (2 * this.setupSDPIndex).toString() +
        '-' +
        (2 * this.setupSDPIndex + 1).toString() +
        '\r\n';
      if (this.ContentBase !== this.rtspUrl && this.wwwAuthenticate !== null) {
        this.formDigestAuthHeader(this.ContentBase!);
      } else {
        this._request('SETUP', this.SDPinfo[this.setupSDPIndex].trackID, extraheader);
      }
      this.nextState = this.SDPinfo.length > 1 ? 'Setup' : 'Play';
    } else if (this.currentState === 'Setup' && this.nextState !== 'Teardown') {
      if (this.setupSDPIndex < this.SDPinfo.length) {
        this.SDPinfo[this.setupSDPIndex].RtpInterlevedID = rtspResponseMsg.RtpInterlevedID;
        this.SDPinfo[this.setupSDPIndex].RtcpInterlevedID = rtspResponseMsg.RtcpInterlevedID;
        this.SDPinfo[this.setupSDPIndex].SessionID = rtspResponseMsg.SessionID;

        this.SessionId = (this.getSessionId() !== NO_SESSION ? this.getSessionId() : rtspResponseMsg.SessionID) as string;

        this.setupSDPIndex += 1;
        if (this.setupSDPIndex !== this.SDPinfo.length) {
          extraheader =
            'Transport: RTP/AVP/TCP;unicast;interleaved=' +
            (2 * this.setupSDPIndex).toString() +
            '-' +
            (2 * this.setupSDPIndex + 1).toString() +
            '\r\n';
          this._request('SETUP', this.SDPinfo[this.setupSDPIndex].trackID, extraheader);
        } else {
          this.rtpClient!.sendSdpInfo(this.SDPinfo);
          if (this.audioTalkServiceStatus) {
            this.rtpClient!.addListener('audioTalk', (...args: unknown[]) =>
              this.SendAudioTalkData(args[0] as unknown)
            );
          }
          this.currentState = 'Play';
          if (this.mode === 'playback') {
            extraheader = 'Immediate: yes' + '\r\n';
            if (this.deviceType === 'camera') {
              extraheader += 'Scale: ' + '1.000000' + '\r\n';
            } else {
              extraheader += this.toStringExtensionScale(this.scale!);
            }
            if (typeof this.rangeClock !== 'undefined' && this.rangeClock !== null) {
              extraheader += 'Range: clock=' + this.rangeClock;
              if (this.rangeClock.search('-') === -1) {
                extraheader += '-';
              }
              extraheader += '\r\n';
            } else {
              extraheader += 'Range: npt=0.000-\r\n';
            }
          } else if (this.mode === 'backup') {
            if (this.deviceType === 'nvr') {
              if (typeof this.rangeClock !== 'undefined' && this.rangeClock !== null) {
                extraheader += 'Range: clock=' + this.rangeClock;
                if (this.rangeClock.search('-') === -1) {
                  extraheader += '-';
                }
                extraheader += '\r\n';
              }
              extraheader += 'Rate-Control: no' + '\r\n';
              extraheader += 'BackupBandwidth: ' + this.backupBandwidth + '\r\n';
            } else {
              extraheader += 'Rate-Control: no' + '\r\n';
            }
          }

          this.SessionId = (this.getSessionId() !== NO_SESSION ? this.getSessionId() : rtspResponseMsg.SessionID) as string;

          this._request('PLAY', null, extraheader);
          this.nextState = 'Playing';
          if (this.mode === 'backup') {
            setTimeout(() => {
              this.checkIsAvaliablePlayback(this.mode);
            }, 1000);
          }
        }
      }
    } else if (this.currentState === 'Play' && this.nextState !== 'Teardown') {
      status = new RtspStatusCode(rtspResponseMsg.ResponseCode!);
      this.SessionId = (this.getSessionId() !== NO_SESSION ? this.getSessionId() : rtspResponseMsg.SessionID) as string;

      this.getParameterIntervalHandler = this.getParameterIntervalHandlerFunc();

      if (this.mode === 'live') {
        this.checkAliveIntervalHandler = this.checkAliveIntervalHandlerFunc();
      } else if (this.mode === 'backup' || this.mode === 'playback') {
        this.checkIsAvaliablePlayback(this.mode);
      }

      this.currentState = 'Playing';
      this.isPausing = false;

      if (typeof this.transport !== 'undefined' && this.transport !== null) {
        this.transport.autoconnection = true;
        this.autoconnection = false;
      }

      this.errorCallbackFunc({
        errorCode: fromHex('0x0000'),
        currentState: this.currentState,
        oldErrorCode: '200',
        rtspCode: status.getStatusCode(),
        description: 'RTSP Play Streaming: ' + status.getStatusCode() + ', error message: ' + status.getDescription(),
        name: status.getName(),
        place: 'RtspClient.js:RtspResponseHandler',
        channelId: this.channelId
      });
    } else if (this.currentState === 'Playing' && this.nextState !== 'Teardown') {
      if (this.isPausing) {
        this.currentState = 'Pause';
        const videoSession = this.rtpClient!.getRtpSessionWithType('video');
        if (videoSession !== null && typeof videoSession !== 'undefined' && videoSession.type === 'video') {
          const timer = videoSession.getStatisticsTimer();
          if (timer !== null && typeof timer !== 'undefined') {
            timer.pause();
          }
        }
        const audioSession = this.rtpClient!.getRtpSessionWithType('audio');
        if (audioSession !== null && typeof audioSession !== 'undefined' && audioSession.type === 'audio') {
          const timer = audioSession.getStatisticsTimer();
          if (timer !== null && typeof timer !== 'undefined') {
            timer.pause();
          }
        }

        status = new RtspStatusCode(rtspResponseMsg.ResponseCode!);
        this.SessionId = (this.getSessionId() !== NO_SESSION ? this.getSessionId() : rtspResponseMsg.SessionID) as string;
        this.errorCallbackFunc({
          errorCode: fromHex('0x0000'),
          oldErrorCode: '200',
          currentState: this.currentState,
          pause: this.isPausing,
          rtspCode: status.getStatusCode(),
          description: 'RTSP Pause Streaming: ' + status.getStatusCode() + ', error message: ' + status.getDescription(),
          name: status.getName(),
          place: 'RtspClient.js:RtspResponseHandler',
          channelId: this.channelId
        });
      } else if (this.mode === 'playback') {
        if (!this.isGetParameterRequest) {
          status = new RtspStatusCode(rtspResponseMsg.ResponseCode!);
          this.SessionId = (this.getSessionId() !== NO_SESSION ? this.getSessionId() : rtspResponseMsg.SessionID) as string;
          this.errorCallbackFunc({
            errorCode: fromHex('0x0000'),
            oldErrorCode: '200',
            currentState: this.currentState,
            pause: this.isPausing,
            rtspCode: status.getStatusCode(),
            controlType: this._controlType,
            description: 'RTSP Seek Streaming: ' + status.getStatusCode() + ', error message: ' + status.getDescription(),
            name: status.getName(),
            place: 'RtspClient.js:RtspResponseHandler',
            channelId: this.channelId
          });
        }
      }
      this._controlType = RtspControlType.NONE;
    } else if (this.currentState === 'Pause') {
      if (!this.isPausing) {
        this.currentState = 'Playing';
        const videoSession = this.rtpClient!.getRtpSessionWithType('video');
        if (videoSession !== null && typeof videoSession !== 'undefined') {
          const timer = videoSession.getStatisticsTimer();
          if (timer !== null && typeof timer !== 'undefined') {
            timer.resume();
          }
        }
        const audioSession = this.rtpClient!.getRtpSessionWithType('audio');
        if (audioSession !== null && typeof audioSession !== 'undefined') {
          const timer = audioSession.getStatisticsTimer();
          if (timer !== null && typeof timer !== 'undefined') {
            timer.resume();
          }
        }

        status = new RtspStatusCode(rtspResponseMsg.ResponseCode!);
        this.SessionId = (this.getSessionId() !== NO_SESSION ? this.getSessionId() : rtspResponseMsg.SessionID) as string;
        this.errorCallbackFunc({
          errorCode: fromHex('0x0000'),
          oldErrorCode: '200',
          currentState: 'Resume',
          pause: this.isPausing,
          rtspCode: status.getStatusCode(),
          description: 'RTSP Resume Streaming: ' + status.getStatusCode() + ', error message: ' + status.getDescription(),
          name: status.getName(),
          place: 'RtspClient.js:RtspResponseHandler',
          channelId: this.channelId
        });
      } else if (this.nextState === 'Teardown') {
        if (this.transport !== null) {
          this.clearTransport();
        }
      }
    } else if (this.currentState === 'Playing' && this.nextState === 'Teardown') {
      if (this.transport !== null) {
        this.clearTransport();
      }
    } else {
      if (this.transport !== null) {
        this.clearTransport();
      }
    }
  }

  receivedBytesCallback(evt: unknown): void {
    if (typeof this.recvCallback !== 'undefined' && this.recvCallback !== null) {
      this.recvCallback(evt);
    }
  }

  RtpDataHandler(rtspinterleave: Uint8Array, rtpheader: Uint8Array, rtpPacketArray: Uint8Array): void {
    this.rtpClient!.sendRtpData(rtspinterleave, rtpheader, rtpPacketArray);
    this.isRTPRunning = true;
    if (this.aliveCounter !== 0) {
      this.aliveCounter = 0;
    }
  }

  SendAudioTalkData(rtpdata: unknown): void {
    if (this.transport && this.audioTalkServiceStatus && this.audioOutStatus === 'on') {
      this.transport.SendRtpData(rtpdata);
    }
  }

  connectionCbFunc(type: TransportConnectionStatus, statusObject: unknown): void {
    try {
      const status = statusObject as { getStatusCode(): number | string; getName(): string; getDescription(): string; getObject?: () => unknown };
      if (type === 'open') {
        this.CSeq = 1;
        this.clearRTSPQueue();
        this.currentState = 'Options';
        this.nextState = 'Describe';
        if (typeof this.transport !== 'undefined' && this.transport !== null) {
          this._request('OPTIONS', null, null);
        } else {
          this.errorCallbackFunc({
            errorCode: fromHex('0x0006'),
            description: 'transport was closed',
            place: 'RtspClient.js:connectionCbFunc',
            channelId: this.channelId
          });
        }
      } else if (type === 'error') {
        if (this.currentState === 'Playing') {
          if (status.getStatusCode() === '999') {
            // websocket disconnect: no-op, matches legacy.
          } else if (this.mode === 'backup' && this.deviceType === 'nvr') {
            if (status.getStatusCode() === 1000 || status.getStatusCode() === 1001) {
              this.autoconnection = false;
              this.errorCallbackFunc({
                errorCode: fromHex('0x0601'),
                oldErrorCode: '990',
                description: 'end of backup',
                place: 'RtspClient.js:connectionCbFunc',
                channelId: this.channelId
              });
            } else {
              this.errorCallbackFunc({
                errorCode: fromHex('0x0602'),
                oldErrorCode: -5,
                description: 'backup has error',
                place: 'RtspClient.js:connectionCbFunc',
                channelId: this.channelId
              });
            }
          } else {
            this.errorCallbackFunc({
              errorCode: fromHex('0x0005'),
              oldErrorCode: '990',
              description: 'retry connect to device from playing state.',
              place: 'RtspClient.js:connectionCbFunc',
              channelId: this.channelId
            });
          }
        } else if (
          typeof this.transport !== 'undefined' &&
          this.transport !== null &&
          this.transport.autoconnection
        ) {
          this.errorCallbackFunc({
            errorCode: fromHex('0x0005'),
            oldErrorCode: '990',
            description: 'retry connect to device from reconnection request.',
            place: 'RtspClient.js:connectionCbFunc',
            channelId: this.channelId
          });
        } else {
          this.errorCallbackFunc({
            errorCode: fromHex('0x0002'),
            oldErrorCode: '990',
            description:
              'The device refuse the connection from client with 50x/40x error or you check again your device ip or port.',
            place: 'RtspClient.js:connectionCbFunc',
            channelId: this.channelId
          });
        }
      } else if (type === 'close') {
        if (this.currentState === 'Playing' || this.currentState === 'Teardown') {
          if (this.mode === 'backup') {
            this.autoconnection = false;
            this.errorCallbackFunc({
              errorCode: fromHex('0x0609'),
              oldErrorCode: 990,
              description: 'backup socket closed',
              place: 'RtspClient.js:1072',
              channelId: this.channelId
            });
          } else if (status.getStatusCode() === 1001 && this.deviceType === 'nvr') {
            this.autoconnection = false;
            this.errorCallbackFunc({
              channelId: this.channelId,
              errorCode: fromHex('0x0008'),
              oldErrorCode: '990',
              place: 'transport.js:connectionCbFunc',
              description: 'Error Code: ' + status.getStatusCode() + ', Name: ' + status.getName() + ', Desc: ' + status.getDescription()
            });
          } else {
            const statusWithIndex = statusObject as { indexOfTransport?: number };
            if (statusWithIndex.indexOfTransport !== this.indexOfTransport) {
              this.errorCallbackFunc({
                errorCode: fromHex('0x0005'),
                oldErrorCode: '990',
                description: 'retry connect to device from playing state.',
                place: 'RtspClient.js:connectionCbFunc',
                channelId: this.channelId
              });
            } else if (status.getStatusCode() !== 1000) {
              this.errorCallbackFunc({
                channelId: this.channelId,
                errorCode: fromHex('0x0005'),
                oldErrorCode: '990',
                place: 'transport.js:connectionCbFunc',
                description: 'Error Code: ' + status.getStatusCode() + ', Name: ' + status.getName() + ', Desc: ' + status.getDescription()
              });
            } else {
              this.errorCallbackFunc({
                errorCode: fromHex('0x0001'),
                description: 'websocket closed: status code (' + status.getStatusCode() + '), Message: ' + status.getDescription(),
                place: 'RtspClient.js:connectionCbFunc',
                channelId: this.channelId
              });
            }
          }
        }

        if (this.transport !== null && typeof this.transport.readyState !== 'undefined') {
          this.clearTransport();
        }
      }

      if (typeof this.responseDisconnectCallback !== 'undefined' && this.responseDisconnectCallback !== null) {
        const data: RtspDisconnectResult = {
          current: this.currentState,
          next: this.nextState,
          transport: this.transport,
          state: status.getStatusCode()
        };
        this.responseDisconnectCallback(data);
        this.responseDisconnectCallback = null;
      }
    } catch {
      // legacy: console.error(...) only, no further effect.
    }
  }

  SetErrorCallback(callbackFunc: RtspErrorCallback): void {
    this.errorCallbackFunc = callbackFunc;
  }

  addEventListener(
    event: 'error' | 'rtsp' | 'status' | 'recv',
    callbackFunc?: RtspErrorCallback | RtspTextCallback | RtspStatusCallback | RtspRecvCallback
  ): void {
    switch (event) {
      case 'error':
        if (typeof callbackFunc !== 'undefined') {
          this.errorCallbackFunc = callbackFunc as RtspErrorCallback;
        }
        break;
      case 'rtsp':
        if (typeof callbackFunc !== 'undefined') {
          this.rtspCallbackFunc = callbackFunc as RtspTextCallback;
        }
        break;
      case 'status':
        // NOTE: write-only in the legacy file too — statusCallbackFunc is
        // assigned but never invoked anywhere. Kept as a no-op for API
        // parity rather than storing genuinely dead state.
        break;
      case 'recv':
        if (typeof callbackFunc !== 'undefined') {
          this.recvCallback = callbackFunc as RtspRecvCallback;
        }
        break;
      default:
        break;
    }
  }

  SetSunapiClient(sunapiClientObj: SunapiClientLike | null): void {
    this.sunapiClient = sunapiClientObj;
  }

  SetDeviceInfo(deviceInfo: RtspDeviceInfo): void {
    this.id = deviceInfo.id;
    this.pw = deviceInfo.pw;
    this.wsUrl = deviceInfo.wsUrl;
    this.rtspUrl = deviceInfo.rtspUrl;
    this.mode = deviceInfo.mode;
    this.rangeClock = deviceInfo.rangeClock;
    this.scale = deviceInfo.scale;
    this.userAgent = deviceInfo.useragent;
    this.deviceType = deviceInfo.deviceType;
    this.audioOutStatus = deviceInfo.audioOutStatus;
    this.autoconnection = typeof deviceInfo.retry !== 'undefined' && deviceInfo.retry !== null ? deviceInfo.retry : false;
    this.bestshot = deviceInfo.bestshot ?? false;
  }

  Connect(): void {
    try {
      if (this.transport === null || typeof this.transport === 'undefined') {
        this.indexOfTransport = this.indexOfTransport + 1;
        const transport = this.transportFactory(this.wsUrl!);
        transport.index = this.indexOfTransport;
        transport.channelId = this.channelId;
        transport.autoconnection = this.autoconnection;
        this.transport = transport;
        transport.SetCallback(
          (status, data) => this.connectionCbFunc(status, data),
          null,
          (interleave, header, payload) => this.RtpDataHandler(interleave, header, payload),
          this.errorCallbackFunc,
          (data) => this.receivedBytesCallback(data)
        );
      }

      if (typeof this.transport !== 'undefined') {
        this.transport.Connect();
        this.isConnected = true;
      }
    } catch {
      // legacy: rtspclient_log.error(...) only, no further effect.
    }
  }

  Disconnect(response?: RtspDisconnectCallback): void {
    this.responseDisconnectCallback = response ?? null;
    if (typeof this.transport !== 'undefined' && this.transport !== null && this.transport.readyState === Transport.OPEN) {
      if (this.currentState === 'Playing' || this.currentState === 'Pause' || this.currentState === 'Setup') {
        this._request('TEARDOWN', null, null);
      } else {
        this.clearTransport();
      }
    } else {
      if (this.transport !== null) {
        this.clearTransport();
      }
      if (typeof this.responseDisconnectCallback !== 'undefined' && this.responseDisconnectCallback !== null) {
        const data: RtspDisconnectResult = {
          current: this.currentState,
          next: this.nextState,
          transport: this.transport
        };
        this.responseDisconnectCallback(data);
        this.responseDisconnectCallback = null;
      }
    }

    if (this.getParameterIntervalHandler !== null) {
      clearInterval(this.getParameterIntervalHandler);
      this.getParameterIntervalHandler = null;
    }
    if (this.checkAliveIntervalHandler !== null) {
      clearInterval(this.checkAliveIntervalHandler);
      this.checkAliveIntervalHandler = null;
    }

    this.unahtuorizedCount = 0;
    this.SessionId = null;
  }

  clearTransport(): void {
    if (typeof this.transport !== 'undefined' && this.transport !== null && this.transport.readyState === Transport.OPEN) {
      if (this.currentState === 'Playing') {
        this._request('TEARDOWN', null, null);
      }
      this.transport.Disconnect();
    } else if (typeof this.transport !== 'undefined' && this.transport !== null) {
      this.transport.init();
    }

    this.clearRTSPQueue();

    if (typeof this.rtpClient !== 'undefined' && this.rtpClient !== null) {
      this.rtpClient.close();
      this.rtpClient = undefined;
    }

    if (this.getParameterIntervalHandler !== null) {
      clearInterval(this.getParameterIntervalHandler);
      this.getParameterIntervalHandler = null;
    }
    if (this.checkAliveIntervalHandler !== null) {
      clearInterval(this.checkAliveIntervalHandler);
      this.checkAliveIntervalHandler = null;
    }
    this.isConnected = false;
    this.SDPinfo = [];
    this.Authentication = '';
    this.transport = null;
    this.currentState = 'Teardown';
    this.nextState = 'Options';
    this.CSeq = 1;
  }

  ControlStream(controlInfo: RtspControlInfo): void {
    let extraheader = '';
    let cmd: string | null = null;

    if (this.transport !== null && this.transport !== undefined) {
      const requestInfo = controlInfo.media.requestInfo;
      if (requestInfo.cmd === 'resume') {
        cmd = 'PLAY';
        if (controlInfo.media.type === 'playback') {
          extraheader += 'Rate-Control: yes' + '\r\n';
          extraheader += this.scaleHeaderOrDefault(requestInfo.scale);
          extraheader += this.rangeHeaderOrDefault(requestInfo.rangeClock);
          if (controlInfo.media.needToImmediate === true) {
            extraheader += 'Immediate: yes' + '\r\n';
          }
        } else if (controlInfo.media.type === 'backup') {
          extraheader += 'Rate-Control: no' + '\r\n';
        }
        this._controlType = RtspControlType.RESUME;
        this._request(cmd, requestInfo.url, extraheader);
        this.isPausing = false;
      } else if (requestInfo.cmd === 'seek') {
        cmd = 'PLAY';
        if (controlInfo.media.type === 'playback' || controlInfo.media.type === 'step') {
          extraheader += 'Rate-Control: yes' + '\r\n';
          extraheader += this.scaleHeaderOrDefault(requestInfo.scale);
          extraheader += this.rangeHeaderOrDefault(requestInfo.rangeClock);
          if (controlInfo.media.needToImmediate === true) {
            extraheader += 'Immediate: yes' + '\r\n';
          }
        } else if (controlInfo.media.type === 'backup') {
          extraheader += 'Rate-Control: no' + '\r\n' + 'Immediate: yes' + '\r\n';
        }
        this._controlType = RtspControlType.SEEK;
        this._request(cmd, requestInfo.url, extraheader);
        this.isPausing = false;
      } else if (requestInfo.cmd === 'forward') {
        cmd = 'PLAY';
        if (controlInfo.media.type === 'playback' || controlInfo.media.type === 'step') {
          extraheader += 'Rate-Control: yes' + '\r\n';
          extraheader += this.scaleHeaderOrDefault(requestInfo.scale, 'forward');
          extraheader += this.rangeHeaderOrDefault(requestInfo.rangeClock);
          if (controlInfo.media.needToImmediate === true) {
            extraheader += 'Immediate: yes' + '\r\n';
          }
        } else if (controlInfo.media.type === 'backup') {
          extraheader += 'Rate-Control: no' + '\r\n' + 'Immediate: yes' + '\r\n';
        }
        this._controlType = RtspControlType.FORWARD;
        this._request(cmd, requestInfo.url, extraheader);
      } else if (requestInfo.cmd === 'backward') {
        cmd = 'PLAY';
        if (controlInfo.media.type === 'playback' || controlInfo.media.type === 'step') {
          extraheader += 'Rate-Control: yes' + '\r\n';
          extraheader += this.scaleHeaderOrDefault(requestInfo.scale, 'backward');
          extraheader += this.rangeHeaderOrDefault(requestInfo.rangeClock);
          if (controlInfo.media.needToImmediate === true) {
            extraheader += 'Immediate: yes' + '\r\n';
          }
        } else if (controlInfo.media.type === 'backup') {
          extraheader += 'Rate-Control: no' + '\r\n' + 'Immediate: yes' + '\r\n';
        }
        this._controlType = RtspControlType.BACKWARD;
        this._request(cmd, requestInfo.url, extraheader);
      } else if (requestInfo.cmd === 'pause') {
        cmd = 'PAUSE';
        extraheader += 'Scale: ' + '1.000000' + '\r\n';
        extraheader += this.rangeHeaderOrDefault(requestInfo.rangeClock);
        this._controlType = RtspControlType.PAUSE;
        this._request(cmd, requestInfo.url, extraheader);
        this.isPausing = true;
      } else if (requestInfo.cmd === 'speed') {
        cmd = 'PLAY';
        if (controlInfo.media.type === 'playback' || controlInfo.media.type === 'step') {
          extraheader += 'Rate-Control: yes' + '\r\n';
          extraheader += this.scaleHeaderOrDefault(requestInfo.scale);
          extraheader += this.rangeHeaderOrDefault(requestInfo.rangeClock);
          if (controlInfo.media.needToImmediate === true) {
            extraheader += 'Immediate: yes' + '\r\n';
          }
          if (this.deviceType === 'camera') {
            const scaleNum = Number(requestInfo.scale);
            if (scaleNum < -1 || scaleNum > 1) {
              extraheader += 'Frames: intra' + '\r\n';
            }
          }
        } else if (controlInfo.media.type === 'backup') {
          extraheader += 'Rate-Control: no' + '\r\n' + 'Immediate: yes' + '\r\n';
        }
        this._controlType = RtspControlType.SPEED;
        this._request(cmd, requestInfo.url, extraheader);
      } else if (requestInfo.cmd === 'backup') {
        cmd = 'PLAY';
        extraheader += 'Rate-Control: no' + '\r\n';
        this._controlType = RtspControlType.BACKUP;
        this._request(cmd, requestInfo.url, extraheader);
      }
    } else {
      this.errorCallbackFunc({
        errorCode: fromHex('0x0006'),
        type: 'rtsp',
        description: 'tranport is not exist',
        place: 'RtspClient.js:ControlStream()',
        channelId: this.channelId
      });
    }
  }

  private scaleHeaderOrDefault(scale: number | string | undefined, direction?: 'forward' | 'backward'): string {
    if (typeof scale !== 'undefined' && scale !== null) {
      return this.toStringExtensionScale(scale, direction);
    }
    return 'Scale: ' + '1.00000' + '\r\n';
  }

  private rangeHeaderOrDefault(rangeClock: string | undefined): string {
    if (typeof rangeClock !== 'undefined' && rangeClock !== null) {
      let header = 'Range: clock=' + rangeClock;
      if (rangeClock.search('-') === -1) {
        header += '-';
      }
      header += '\r\n';
      return header;
    }
    return 'Range: npt=0.000-\r\n';
  }

  getCurrentState(): string {
    return this.currentState;
  }
}
