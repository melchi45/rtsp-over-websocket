import { RTSPOverWebSocketError } from '../exceptions/RTSPOverWebSocketError';
import { AuthError } from '../exceptions/AuthError';
import { SunapiError } from '../exceptions/SunapiError';
import { fromHex, toHex } from '../util/hex';
import { formatBytes, formatBps } from '../util/formatBytes';
import { toYYYYMMDDHHMMSS } from '../util/dateFormat';
import { getElementByAttributeValue } from '../util/getElementByAttributeValue';
import { SunapiManager, type SunapiManagerDeviceInfo } from '../network/http/SunapiManager';
import { RtspControlType, type SunapiClientLike } from '../network/rtspOverWebsocket/RtspClient';
import { StreamPlayer } from '../interface/StreamPlayer';
import type { StreamPlayerInfo } from '../interface/StreamPlayer';
import { RTSPOverWebSocketPlayType, RTSPOverWebSocketPlayState, RTSPOverWebSocketBestshotFilter, RTSPOverWebSocketPlaySpeed, type RTSPOverWebSocketPlaySpeedEntry } from './RTSPOverWebSocketTypes';
import * as panelStyles from './panelStyles';

/**
 * Ported from the legacy player's custom-element class, registered here as
 * `RTSPOverWebSocket` (a
 * `customElements.define("rtsp-over-websocket", RTSPOverWebSocket)` custom
 * element) — the top-level public API of the legacy library.
 *
 * This is an intentionally large, faithful, line-for-line port of a single
 * 7312-line legacy class. Every accessor, DOM-builder method, and playback
 * command below mirrors the legacy method of the same name (Symbol-keyed
 * "pseudo-private" legacy methods like `[dispatch]`/`[statistics_div]` are
 * ported as regular TS `private` methods — a purely mechanical translation,
 * since nothing in the legacy code ever reflected on those Symbols). CSS text
 * blocks injected via `[appendStyle]` are extracted verbatim into
 * `./panelStyles.ts` only to keep this file's line count from growing even
 * further; no other restructuring was done. Splitting the class itself across
 * multiple files was deliberately avoided — this is a single custom element
 * with a single legacy prototype, and factoring its behavior into composed
 * helper classes would risk subtly changing the very `this`-bound bug-for-bug
 * behavior this port exists to preserve.
 *
 * Confirmed pre-existing bugs are preserved and documented inline at their
 * exact location (see each method's own comment) rather than fixed silently.
 */

type LegacyListener = (event: Event) => void;

/** Sample count kept for the statistics panel's Rate bar chart / Buffer line
 * chart (see statisticsDiv()/onRTSPOverWebSocketStatistics()'s 'fps' case) —
 * 'fps' statistics fire roughly once per second, so 30 is a ~30s window. */
const STATS_HISTORY_LENGTH = 30;

interface VideoContainerElement extends HTMLElement {
  videoWidth?: number;
  videoHeight?: number;
}

export class RTSPOverWebSocket extends HTMLElement {
  // ---- attribute-backed state (constructor-initialized, matches legacy 1:1) ----
  private _hostname: string | null = null;
  private _channel: number | null = null;
  private _profile: string | null = null;
  private _profile_number: number | null = null;
  private _deviceType: string | null = null;
  private _username: string | null = null;
  private _password: string | null = null;
  private _iframe = false;
  private _controls = false;
  private _multicast = false;
  private _width: number | string = 0;
  private _height: number | string = 0;
  private _background = 'black';
  private _readyState: (typeof RTSPOverWebSocketPlayState)[keyof typeof RTSPOverWebSocketPlayState] = RTSPOverWebSocketPlayState.STOPPED;
  private _currentTimestamp: string | null = null;
  private _localTimestamp: string | null = null;
  private _sessionKey: string | null = null;
  private _source: string | null = null;
  private _autoplay: boolean | null = null;
  private _proxy: string | null = null;
  private _port: string | null = null;
  private _secure = false;
  private _useIso: boolean | null = null;
  timezone_offset: number | null = null;
  private _filename: string | null = null;

  private _sunapiMng = new SunapiManager();

  private _playType: (typeof RTSPOverWebSocketPlayType)[keyof typeof RTSPOverWebSocketPlayType] | null = null;
  private _oldPlayType: (typeof RTSPOverWebSocketPlayType)[keyof typeof RTSPOverWebSocketPlayType] | null = null;
  private _playSpeed: RTSPOverWebSocketPlaySpeedEntry = RTSPOverWebSocketPlaySpeed.speed_1x;
  private _statistics = false;
  private _network = false;
  private _networkState = 'good';

  private _gmt: number | null = null;
  private _withErrorStop = false;
  private _retryFlag = true;
  private _useLoading = false;
  private _fullscreen = false;
  private _channelLabel = true;
  private _initSunapi = false;
  private _coordinatedUniversalTime = false;
  private _clickCount = 0;
  private _bestshotFilter: (typeof RTSPOverWebSocketBestshotFilter)[keyof typeof RTSPOverWebSocketBestshotFilter] | null = null;
  private _minimap = false;
  private _showBestshot = false;
  private _useClockRange = false;
  private _useContextmenu = true;
  private _usesubstream: boolean | null = null;
  private _camChannel: number | null = null;
  private _profileUsage: string | null = null;
  private _codec: string | null = null;
  private _limitWidth: number | null = null;
  private _limitHeight: number | null = null;
  private _android = false;

  // `_useGrunt` is a confirmed real bug: the `grunt` getter below reads it,
  // but no constructor (or anywhere else in the legacy file) ever assigns it
  // — only `_network` is a real backing field. `element.grunt` therefore
  // always returns `undefined` in legacy; preserved as-is (field is declared
  // but genuinely never written).
  private _useGrunt: boolean | undefined;

  // ---- fields with no constructor initializer in legacy (first assigned by
  // their own property setter or DOM-builder method; typed here as optional
  // to match that lazy-initialization) ----
  private _startTime?: string;
  private _endTime?: string | null;
  private _seekingTime?: string | null;
  private _overlappedId?: string | null;

  listeners: Map<LegacyListener, { type: string; listener: LegacyListener }> = new Map();

  info: StreamPlayerInfo;
  player: StreamPlayer | null = null;
  backupplayer: StreamPlayer | null = null;
  video: VideoContainerElement;
  max_scale = 100;

  statisticsElement?: HTMLElement | null;
  channelElement?: HTMLElement | null;
  channelLabelElement?: HTMLElement | null;
  resolutionElement?: HTMLElement | null;
  positionElement?: HTMLElement | null;
  ratioElement?: HTMLElement | null;
  videoCodecElement?: HTMLElement | null;
  audioCodecElement?: HTMLElement | null;
  frameElement?: HTMLElement | null;
  decodeElement?: HTMLElement | null;
  dropElement?: HTMLElement | null;
  videoRtpRecvElement?: HTMLElement | null;
  videoRtpTotalRecvElement?: HTMLElement | null;
  audioRtpRecvElement?: HTMLElement | null;
  audioRtpTotalRecvElement?: HTMLElement | null;
  latencyElement?: HTMLElement | null;
  chunkSizeElement?: HTMLElement | null;
  currentRecvElement?: HTMLElement | null;
  totalRecvElement?: HTMLElement | null;
  timestampElement?: HTMLElement | null;
  timestampIntervalElement?: HTMLElement | null;
  dataElement?: HTMLElement | null;

  networkStatDotElement?: HTMLElement | null;
  networkStatTextElement?: HTMLElement | null;
  rateGraphElement?: HTMLElement | null;
  bufferChartElement?: SVGPolylineElement | null;
  private readonly bitrateHistory: number[] = [];
  private readonly bufferHistory: number[] = [];

  networkStateElement?: HTMLElement | null;
  dotElement?: HTMLElement | null;

  contextmenuElement?: HTMLElement | null;
  menuOptionElement?: HTMLElement | null;
  menuVisible?: boolean;

  rewindElement?: HTMLElement;
  forwardElement?: HTMLElement;
  rewindSpanElement?: HTMLElement;
  forwardSpanElement?: HTMLElement;
  rtspOverWebSocketWrapperElement?: HTMLElement;
  minimapElement?: Element | null;

  zoom_point?: { x: number; y: number };
  zoom_target?: { x: number; y: number };
  size?: { w: number | string; h: number | string };
  pos?: { x: number; y: number };
  scale?: number;

  constructor() {
    super();

    this.info = {
      callback: {
        close: (...args: unknown[]) => this.onRTSPOverWebSocketClose(args[0]),
        error: (event: unknown) => this.onRTSPOverWebSocketError(event as RTSPOverWebSocketErrorEventLike),
        status: (...args: unknown[]) => this.onRTSPOverWebSocketStatus(args[0]),
        time: (...args: unknown[]) => this.onRTSPOverWebSocketTimestamp(args[0]),
        resize: (...args: unknown[]) => this.onRTSPOverWebSocketResize(args[0] as RTSPOverWebSocketResizeEvent),
        meta: (...args: unknown[]) => this.onRTSPOverWebSocketMeta(args[0] as RTSPOverWebSocketMetaEvent),
        metaImage: (...args: unknown[]) => this.onRTSPOverWebSocketMetaImage(args[0] as RTSPOverWebSocketMetaImageEvent),
        vmode: (...args: unknown[]) => this.onRTSPOverWebSocketVideoMode(args[0] as RTSPOverWebSocketVideoModeEvent),
        statistics: (...args: unknown[]) => this.onRTSPOverWebSocketStatistics(args[0] as RTSPOverWebSocketStatisticsEvent),
        step: (...args: unknown[]) => this.onRTSPOverWebSocketStep(args[0] as string),
        capture: (...args: unknown[]) => this.onRTSPOverWebSocketCapture(args[0] as RTSPOverWebSocketCaptureEvent),
        instantplayback: (...args: unknown[]) => this.onRTSPOverWebSocketInstantPlayback(args[0] as RTSPOverWebSocketInstantPlaybackEvent),
        backup: (...args: unknown[]) => this.onRTSPOverWebSocketBackup(args[0] as RTSPOverWebSocketBackupEvent),
        recv: (...args: unknown[]) => this.onRTSPOverWebSocketRecv(args[0] as RTSPOverWebSocketRecvEvent),
        rtsp: (...args: unknown[]) => this.onRTSPPacket(args[0])
      },
      device: {
        ClientIPAddress: '127.0.0.1',
        hostname: '',
        cameraIp: '',
        port: 80,
        captureName: '',
        protocol: '',
        username: '',
        password: '',
        deviceType: '',
        channelId: 0,
        proxy: '',
        retry: false,
        serverType: 'camera',
        gmt: this._gmt ?? undefined
      },
      media: {
        audioOutStatus: false,
        framerate: 30,
        govLength: 60,
        instantPlaybackTime: 30,
        bufferClearInterval: 1,
        needToImmediate: false,
        boxsize: 4,
        mode: null,
        requestInfo: {
          cmd: 'open',
          scale: 1,
          url: null
        },
        transportType: 'rtsp',
        type: 'live',
        drop: true,
        split: false,
        supportCovertAndOff: false,
        bestshot: false
      }
    };

    this.video = document.createElement('canvas') as VideoContainerElement;

    // context menu bound to the (former Symbol-keyed) contextmenu_div method
    this.oncontextmenu = this.contextmenuDiv.bind(this);
    this.onmousemove = this.handleMouseMove.bind(this) as (this: GlobalEventHandlers, ev: MouseEvent) => void;
    this.onclick = this.handleClick.bind(this) as (this: GlobalEventHandlers, ev: MouseEvent) => void;
    this.ondblclick = this.handleDoubleClick.bind(this) as (this: GlobalEventHandlers, ev: MouseEvent) => void;
    // legacy: `this.onmousewheel = ...` — a long-deprecated, non-standard
    // handler property (superseded by the `wheel` event); kept as-is since it
    // is what legacy actually wires up (real browsers that still honor it
    // will fire `[handleMouseWheel]`, others simply never call it — same
    // behavior as the legacy library).
    (this as unknown as { onmousewheel: ((ev: Event) => void) | null }).onmousewheel = this.handleMouseWheel.bind(this) as unknown as (ev: Event) => void;

    if (typeof window !== 'undefined' && window.document.addEventListener) {
      window.document.addEventListener('webkitfullscreenchange', this.exitHandler.bind(this), false);
      window.document.addEventListener('mozfullscreenchange', this.exitHandler.bind(this), false);
      window.document.addEventListener('fullscreenchange', this.exitHandler.bind(this), false);
      window.document.addEventListener('MSFullscreenChange', this.exitHandler.bind(this), false);
      window.document.addEventListener(
        'keyup',
        (evt: KeyboardEvent) => {
          if (evt.keyCode === 27) {
            this.toggleFullScreen(this);
          } else if (evt.keyCode === 122) {
            this.toggleFullScreen(this);
          }
        },
        false
      );
    }
  }

  version(): string {
    return '1.0.0';
  }

  static get observedAttributes(): string[] {
    return [
      'hostname',
      'channel',
      'profile',
      'profile_number',
      'device',
      'username',
      'password',
      'iframe',
      'controls',
      'multicast',
      'width',
      'height',
      'autoplay',
      'mode',
      'proxy',
      'port',
      'secure',
      'https',
      'statistics',
      'network',
      'gmt',
      'grunt',
      'bestshotfilter',
      'usesubstream',
      'client',
      'camchannel',
      'profileusage',
      'codec',
      'limitwidth',
      'limitheight',
      'android'
    ];
  }

  attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null): void {
    switch (name.toLowerCase()) {
      case 'autoplay': {
        this._autoplay = true;
        break;
      }
      case 'hostname': {
        const temp = this._hostname;
        this._hostname = newValue;
        this.info.device.cameraIp = this._hostname ?? undefined;
        this.info.device.hostname = this._hostname ?? undefined;

        if (this._hostname !== temp) {
          this.dispatch('changehostname', { hostname: this._hostname });
        }
        break;
      }
      case 'client': {
        this.info.device.ClientIPAddress = newValue ?? undefined;
        this.dispatch('changeclient', { client: this.info.device.ClientIPAddress });
        break;
      }
      case 'channel': {
        const temp = this._channel;
        if (newValue === null || newValue === 'null') {
          this._channel = null;
          this.dispatch('changechannel', { channel: this._channel });
          break;
        } else if (parseInt(newValue, 10) < 1) {
          throw new RTSPOverWebSocketError({
            channelId: this.channel,
            elementId: this.getAttribute('id') ?? undefined,
            errorCode: fromHex('0x0413'),
            place: 'RTSPOverWebSocket.ts:channel',
            message: 'invalid channel number. set to least over 1 the number of channel of NVR or camera.'
          });
        }

        this._channel = parseInt(newValue, 10) - 1;
        this.info.device.channelId = this._channel;

        if (this._channel !== temp) {
          this.dispatch('changechannel', { channel: this._channel });
        }
        break;
      }
      case 'profile': {
        const temp = this._profile;
        if (Object.prototype.toString.call(newValue) === '[object String]') {
          this._profile = newValue;
          this._profile_number = null;
        } else {
          this._profile = null;
          throw new RTSPOverWebSocketError({
            channelId: this.channel,
            elementId: this.getAttribute('id') ?? undefined,
            errorCode: fromHex('0x0414'),
            place: 'RTSPOverWebSocket.ts:profile_number',
            message: 'invalid input parameter type. you have to set string type to profile of NVR or camera.'
          });
        }

        if (this._profile !== temp) {
          this.dispatch('changeprofile', { profile: this._profile });
        }
        break;
      }
      case 'profile_number': {
        const temp = this._profile_number;
        if (typeof newValue === 'undefined' || newValue === null || isNaN(Number(newValue)) || !Number.isInteger(parseInt(newValue, 10))) {
          this._profile_number = null;
          throw new RTSPOverWebSocketError({
            channelId: this.channel,
            elementId: this.getAttribute('id') ?? undefined,
            errorCode: fromHex('0x0414'),
            place: 'RTSPOverWebSocket.ts:profile_number',
            message: 'invalid input parameter type. you have to set integer value to profile number of NVR or camera.'
          });
        } else {
          this._profile_number = parseInt(newValue, 10);
          this._profile = null;
        }

        if (this._profile_number !== temp) {
          this.dispatch('changeprofilenumber', { profile_number: this._profile_number });
        }
        break;
      }
      case 'device': {
        this._deviceType = newValue;
        this.info.device.deviceType = this._deviceType ?? undefined;
        this.dispatch('changedevicetype', { device: this._deviceType });
        break;
      }
      case 'username': {
        this._username = newValue;
        this.info.device.user = this._username ?? undefined;
        this.info.device.username = this._username ?? undefined;
        this.dispatch('changeusername', { username: this._username });
        break;
      }
      case 'password': {
        this._password = newValue;
        this.info.device.password = this._password ?? undefined;
        this.dispatch('changepassword', {});
        break;
      }
      case 'iframe': {
        this._iframe = true;
        break;
      }
      case 'controls': {
        this._controls = newValue === 'true' || newValue === '';
        if (this.video !== undefined && this.video !== null) {
          (this.video as unknown as { controls: boolean }).controls = this._controls;
        }
        break;
      }
      case 'multicast': {
        this._multicast = true;
        break;
      }
      case 'width': {
        this._width = newValue as unknown as number;
        break;
      }
      case 'height': {
        this._height = newValue as unknown as number;
        break;
      }
      case 'mode': {
        this.mode = newValue as string;
        break;
      }
      case 'proxy': {
        this._proxy = newValue;
        break;
      }
      case 'port': {
        this._port = newValue;
        if (!this._android) {
          this._secure = parseInt(newValue as string, 10) === 443;
        }
        this.dispatch('changeport', { port: this._port });
        break;
      }
      case 'secure':
      case 'https': {
        this._secure = newValue === 'true' || newValue === '';
        this.dispatch('changeprotocol', { https: this._secure });
        break;
      }
      case 'statistics': {
        this._statistics = newValue !== 'false';
        this.statisticsDiv();
        break;
      }
      case 'network': {
        this._network = newValue === 'true' || newValue === '';
        break;
      }
      case 'gmt': {
        let gmtValue: unknown = newValue;
        if (typeof gmtValue === 'string' && (gmtValue === 'null' || gmtValue === 'undefined')) {
          gmtValue = null;
        }
        this.info.device.gmt = this._gmt = gmtValue as number | null;
        this.dispatch('changetimezone', { timezone: this._gmt });
        break;
      }
      case 'grunt': {
        this.info.device.serverType = 'grunt';
        break;
      }
      case 'bestshotfilter': {
        this.setBestshotFilter(newValue as string);
        break;
      }
      case 'type': {
        if (typeof newValue === 'undefined' || typeof newValue !== 'string' || (newValue === 'video' || newValue === 'canvas' || newValue === 'auto') === false) {
          throw new RTSPOverWebSocketError({
            channelId: this.channel,
            elementId: this.getAttribute('id') ?? undefined,
            errorCode: fromHex('0x0414'),
            place: 'RTSPOverWebSocket.ts:type',
            message: 'invalid input parameter type. you have to set to string of video or canvas for video renderer type.'
          });
        }
        this.info.media.mode = newValue === 'auto' ? null : newValue;
        break;
      }
      case 'usesubstream': {
        if (typeof newValue === 'undefined' || typeof newValue !== 'string' || (newValue === 'true' || newValue === 'false') === false) {
          throw new RTSPOverWebSocketError({
            channelId: this.channel,
            elementId: this.getAttribute('id') ?? undefined,
            errorCode: fromHex('0x0414'),
            place: 'RTSPOverWebSocket.ts:usesubstream',
            message: 'invalid input parameter type, check your input parameter type, this value need to a boolean type'
          });
        }
        this._usesubstream = newValue === 'true';
        break;
      }
      case 'camchannel': {
        const convertCamChannel = parseInt(newValue as string, 10);
        if (typeof newValue === 'undefined') {
          this._camChannel = null;
        } else if (isNaN(convertCamChannel)) {
          throw new RTSPOverWebSocketError({
            channelId: this.channel,
            elementId: this.getAttribute('id') ?? undefined,
            errorCode: fromHex('0x0414'),
            place: 'RTSPOverWebSocket.ts:camchannel',
            message: 'invalid input parameter type, check your input parameter type, Only number types are possible.'
          });
        } else {
          this._camChannel = convertCamChannel;
        }
        break;
      }
      case 'profileusage': {
        if (typeof newValue === 'undefined') {
          this._profileUsage = null;
        } else if (newValue !== 'Live' && newValue !== 'Record' && newValue !== 'Network') {
          throw new RTSPOverWebSocketError({
            channelId: this.channel,
            elementId: this.getAttribute('id') ?? undefined,
            errorCode: fromHex('0x0414'),
            place: 'RTSPOverWebSocket.ts:profileusage',
            message: "invalid input parameter value, check your input parameter type, Only 'Live', 'Record' and 'Network' values are possible."
          });
        } else {
          this._profileUsage = newValue;
        }
        break;
      }
      case 'codec': {
        if (typeof newValue === 'undefined') {
          this._codec = null;
        } else if (newValue !== 'MJPEG' && newValue !== 'H264' && newValue !== 'H265' && newValue !== 'MPEG4') {
          throw new RTSPOverWebSocketError({
            channelId: this.channel,
            elementId: this.getAttribute('id') ?? undefined,
            errorCode: fromHex('0x0414'),
            place: 'RTSPOverWebSocket.ts:codec',
            message: "invalid input parameter value, check your input parameter type, Only 'MJPEG', 'H264', 'H265' and 'MPEG4' values are possible."
          });
        } else {
          this._codec = newValue;
        }
        break;
      }
      case 'limitwidth': {
        const convertLimitWidth = parseInt(newValue as string, 10);
        if (typeof newValue === 'undefined') {
          this._limitWidth = null;
        } else if (isNaN(convertLimitWidth)) {
          throw new RTSPOverWebSocketError({
            channelId: this.channel,
            elementId: this.getAttribute('id') ?? undefined,
            errorCode: fromHex('0x0414'),
            place: 'RTSPOverWebSocket.ts:limitwidth',
            message: 'invalid input parameter type, check your input parameter type, Only number types are possible.'
          });
        } else {
          this._limitWidth = convertLimitWidth;
        }
        break;
      }
      case 'limitheight': {
        const convertLimitHeight = parseInt(newValue as string, 10);
        if (typeof newValue === 'undefined') {
          this._limitHeight = null;
        } else if (isNaN(convertLimitHeight)) {
          throw new RTSPOverWebSocketError({
            channelId: this.channel,
            elementId: this.getAttribute('id') ?? undefined,
            errorCode: fromHex('0x0414'),
            place: 'RTSPOverWebSocket.ts:limitheight',
            message: 'invalid input parameter type, check your input parameter type, Only number types are possible.'
          });
        } else {
          this._limitHeight = convertLimitHeight;
        }
        break;
      }
      case 'android': {
        // Legacy bug preserved: `newValue` from attributeChangedCallback is
        // always a string (or null), never a real `boolean` — so the
        // `typeof newValue !== 'boolean'` branch below is taken for every
        // non-undefined attribute value, meaning this case always throws
        // when the `android` attribute is actually set/changed via markup.
        if (typeof newValue === 'undefined') {
          this._android = false;
        } else if (typeof newValue !== 'boolean') {
          throw new RTSPOverWebSocketError({
            channelId: this.channel,
            elementId: this.getAttribute('id') ?? undefined,
            errorCode: fromHex('0x0414'),
            place: 'RTSPOverWebSocket.ts:android',
            message: 'invalid input parameter type, check your input parameter type, Only number types are possible.'
          });
        } else {
          this._android = newValue;
        }
        break;
      }
      default:
        console.warn('This attribute name is not allowed on the rtsp-over-websocket tag.');
        break;
    }
    // legacy: `this._updateSunapiManager();` / `this._updateRendering();` are
    // commented out here in the original source — attributeChangedCallback
    // never triggers a re-render; only connectedCallback does.
  }

  connectedCallback(): void {
    try {
      // channel_div/.statistics/.video-container (and the network-state dot,
      // minimap, contextmenu) are all `position: absolute` overlays meant to
      // sit within this element's own box. Without a positioned ancestor
      // here, the browser falls back to the viewport as their containing
      // block, so they render pinned to the page corner instead of over the
      // video. Only set when unset so an explicit inline style from the host
      // page (if any) is not clobbered.
      if (this.style.position === '') {
        this.style.position = 'relative';
      }
      if (this.style.display === '') {
        this.style.display = 'block';
      }

      if (this.getAttribute('autoplay') !== null) {
        this._autoplay = true;
      }

      if (this.getAttribute('device') !== null) {
        this.info.device.deviceType = this.getAttribute('device') ?? undefined;
      } else {
        this.info.device.deviceType = 'camera';
      }

      if (this.info.device.deviceType === 'camera') {
        this.info.device.cameraIp = this.getAttribute('hostname') !== null ? (this.getAttribute('hostname') as string) : document.location.hostname;
      } else {
      }
      this.info.device.hostname = this.getAttribute('hostname') !== null ? (this.getAttribute('hostname') as string) : document.location.hostname;

      if (this.getAttribute('client') !== null) {
        this.info.device.ClientIPAddress = this.getAttribute('client') as string;
      }

      if (this.getAttribute('username') !== null) {
        this.info.device.username = this.getAttribute('username') as string;
      }

      if (this.getAttribute('password') !== null) {
        this.info.device.password = this.getAttribute('password') as string;
      }

      if (this.getAttribute('profile') !== null) {
        this._profile = this.getAttribute('profile');
      }

      if (this.getAttribute('profile_number') !== null) {
        // Legacy bug preserved: `Number.isInteger(this.getAttribute(...))`
        // is always false because `getAttribute()` returns a string (or
        // null), never a real number — so this branch's `parseInt(...)`
        // assignment can never actually run from connectedCallback
        // (attributeChangedCallback's own 'profile_number' case handles the
        // real parsing separately).
        if (Number.isInteger(this.getAttribute('profile_number') as unknown as number)) {
          this._profile_number = parseInt(this.getAttribute('profile_number') as string, 10);
        }
      }

      if (this.getAttribute('controls') !== null) {
        this._controls = true;
      }

      if (this.getAttribute('multicast') !== null) {
        this._multicast = true;
      }

      if (this.getAttribute('iframe') !== null) {
        this._iframe = true;
      }

      if (this.getAttribute('secure') !== null) {
        this._secure = this.getAttribute('secure') === 'true' || this.getAttribute('secure') === '';
      }

      if (this.getAttribute('https') !== null) {
        this._secure = this.getAttribute('https') === 'true' || this.getAttribute('https') === '';
      }

      if (this.getAttribute('proxy') !== null) {
        this._proxy = this.getAttribute('proxy');
      }

      if (this.getAttribute('port') !== null) {
        this._port = this.getAttribute('port');
      }

      if (this.getAttribute('channel') === null) {
        this.video.id = 'live' + String(this.info.media.mode) + '1';
        this.info.device.channelId = 0;
      } else {
        this.info.device.channelId = Number(this.getAttribute('channel')) - 1;
      }
      this.video.setAttribute('rtsp-channel-id', String(this.info.device.channelId));

      // Legacy bug preserved (tautology): `getAttribute('width') !== null ||
      // getAttribute('width') !== undefined` — `getAttribute()` never
      // returns `undefined`, so the right operand is always true and the
      // whole condition is always true regardless of whether `width` is set.
      if (this.getAttribute('width') !== null || (this.getAttribute('width') as unknown) !== undefined) {
        (this.video as unknown as { width: unknown }).width = this.getAttribute('width');
      }
      if (this.getAttribute('height') !== null || (this.getAttribute('height') as unknown) !== undefined) {
        (this.video as unknown as { height: unknown }).height = this.getAttribute('height');
      }

      if (this.getAttribute('id') !== null) {
        this.video.id = 'live-' + this.getAttribute('id');
        this.video.setAttribute('rtsp-channel-mapped-id', this.getAttribute('id') as string);
        this.info.media.element = this.getAttribute('id');
      } else {
        console.warn('The rtsp-over-websocket tag does not allow an empty tag id.');
      }

      if (this.getAttribute('mode') !== null) {
        if (this.getAttribute('mode') === 'live') {
          this._playType = RTSPOverWebSocketPlayType.LIVE;
        } else if (this.getAttribute('mode') === 'playback') {
          this._playType = RTSPOverWebSocketPlayType.PLAYBACK;
        } else {
          throw new RTSPOverWebSocketError({
            channelId: this.channel,
            elementId: this.getAttribute('id') ?? undefined,
            errorCode: fromHex('0x0412'),
            place: 'RTSPOverWebSocket.ts:364',
            message: 'play mode is not defined. please! check your mode attribute on your rtsp-over-websocket element.'
          });
        }
      }

      if (this.getAttribute('statistics') !== null) {
        this._statistics = this.getAttribute('statistics') !== 'false';
        this.statisticsDiv();
      }

      if (this.getAttribute('network') !== null) {
        this._network = this.getAttribute('network') === 'true' || this.getAttribute('network') === '';
      }

      if (this.getAttribute('type') !== null) {
        const typeAttr = this.getAttribute('type');
        if (typeAttr === 'null' || typeAttr === 'undefined' || typeAttr === 'auto') {
          this.info.media.mode = null;
        } else {
          this.info.media.mode = typeAttr;
        }
      }

      if (this.getAttribute('grunt') !== null) {
        this.info.device.serverType = this.getAttribute('grunt') === 'true' || this.getAttribute('grunt') === '' ? 'grunt' : 'camera';
      }

      if (this.getAttribute('android') !== null) {
        this._android = true;
      }

      if (this._controls === true) {
        (this.video as unknown as { controls: boolean }).controls = true;
      }

      // Legacy bug preserved (duplicate clause): `this.info.media.element
      // !== null && this.info.media.element !== null` — both clauses are
      // identical (should have been `!== null && !== undefined`). Since
      // `info.media.element` is `undefined` (not `null`) when the `id`
      // attribute was never set, this condition is STILL always true, so
      // `_updateRendering()` unconditionally runs even without a required
      // `id` attribute (only the `console.warn` above fires in that case).
      if (this.info.media.element !== null && this.info.media.element !== null) {
        if (this._initSunapi) {
          this.updateSunapiManager();
        }
        this.updateRendering();
      }
    } catch (error) {
      console.error('on connectedCallback:', error);
    }
  }

  // ================= private DOM/geometry helper methods =================
  // (legacy Symbol-keyed methods, ported as plain TS `private` methods)

  private setBestshotFilter(value: string | number): void {
    const temp = typeof value === 'string' ? value.toLowerCase() : value;

    switch (temp) {
      case 'Person':
      case 'person':
      case 0:
        this._bestshotFilter = RTSPOverWebSocketBestshotFilter.Person;
        break;
      case 'Face':
      case 'face':
      case 1:
        this._bestshotFilter = RTSPOverWebSocketBestshotFilter.Face;
        break;
      case 'FaceRecognition':
      case 'facerecognition':
      case 2:
        this._bestshotFilter = RTSPOverWebSocketBestshotFilter.FaceRecognition;
        break;
      case 'Vehicle':
      case 'vehicle':
      case 3:
        this._bestshotFilter = RTSPOverWebSocketBestshotFilter.Vehicle;
        break;
      case 'LicensePlate':
      case 'licenseplate':
      case 4:
        this._bestshotFilter = RTSPOverWebSocketBestshotFilter.LicensePlate;
        break;
      default:
        this._bestshotFilter = null;
        break;
    }
    this.dispatch('changebestshotfilter', { bestshotfilter: this._bestshotFilter });
  }

  /** the binary Great Common Divisor calculator */
  private gcd(u: number, v: number): number {
    if (u === v) return u;
    if (u === 0) return v;
    if (v === 0) return u;

    if (~u & 1) {
      if (v & 1) return this.gcd(u >> 1, v);
      else return this.gcd(u >> 1, v >> 1) << 1;
    }

    if (~v & 1) return this.gcd(u, v >> 1);
    if (u > v) return this.gcd((u - v) >> 1, v);
    return this.gcd((v - u) >> 1, u);
  }

  /** returns an array with the ratio */
  private ratio(w: number, h: number): [number, number] {
    const d = this.gcd(w, h);
    return [w / d, h / d];
  }

  private getElementCSSSize(element: HTMLElement): { width: number; height: number } {
    return { width: element.offsetWidth, height: element.offsetHeight };
  }

  private fitAxis(width: number, height: number): 0 | 1 {
    if (this.getElementCSSSize(this).width / width > this.getElementCSSSize(this).height / height) {
      return 1;
    }
    return 0;
  }

  private getPosition(event: MouseEvent): { x: number | null; y: number | null } {
    const size = this.getElementCSSSize(this);
    const rect = this.getBoundingClientRect();
    let width: number;
    let height: number;
    const mode = this.video instanceof HTMLVideoElement;

    if (mode) {
      width = (this.video as unknown as HTMLVideoElement).videoWidth;
      height = (this.video as unknown as HTMLVideoElement).videoHeight;
    } else {
      width = Number(this.width);
      height = Number(this.height);
    }

    const realX = (size.height * width) / height;
    const realY = (size.width * height) / width;
    const position: { x: number | null; y: number | null } = { x: null, y: null };

    if (this.fitAxis(width, height)) {
      const gap = size.width - realX;
      const scaleX = width / size.width;
      const scaleY = height / size.height;
      let x = ((event.clientX - rect.left) * scaleX - 0.5) | 0;
      const y = ((event.clientY - rect.top) * scaleY + 0.5) | 0;

      if (x < Math.round(width / 2)) {
        x -= Math.floor(Math.floor(gap / 2) * scaleX - 0.5);
      } else {
        x += Math.round(Math.round(gap / 2) * scaleX + 0.5);
      }

      if (x >= 0 && x <= width) {
        position.x = x;
        position.y = y;
      }
    } else {
      const gap = size.height - realY;
      const scaleX = width / size.width;
      const scaleY = height / size.height;
      const x = ((event.clientX - rect.left) * scaleX - 0.5) | 0;
      let y = ((event.clientY - rect.top) * scaleY + 1) | 0;

      if (y < Math.round(height / 2)) {
        y -= Math.floor(Math.floor(gap / 2) * scaleY - 0.5);
      } else {
        y += Math.round(Math.round(gap / 2) * scaleY + 1);
      }

      if (y >= 0 && y <= height) {
        position.x = x;
        position.y = y;
      }
    }

    return position;
  }

  private handleMouseMove(event: MouseEvent): void {
    const position = this.getPosition(event);
    if (this.positionElement && position.x !== null && position.y !== null) {
      this.positionElement.textContent = '(' + Math.round(position.x) + ', ' + Math.round(position.y) + ')';
    }
  }

  private handleClick(event: MouseEvent): void {
    const position = this.getPosition(event);
    if (this.positionElement && position.x !== null && position.y !== null) {
      this.positionElement.textContent = '(' + Math.round(position.x) + ', ' + Math.round(position.y) + ')';

      if (this.playType === RTSPOverWebSocketPlayType.PLAYBACK && this.readyState === RTSPOverWebSocketPlayState.PLAYING) {
        this._clickCount++;
      }
    }
  }

  scrolled(event: WheelEvent & { delta?: number }, _position?: { x: number; y: number }): void {
    if (event.type === 'mousewheel') {
      const pos = this.pos as { x: number; y: number };
      const zoomPoint = this.zoom_point as { x: number; y: number };
      const zoomTarget = this.zoom_target as { x: number; y: number };
      const size = this.size as { w: number; h: number };
      const rtspOverWebSocketWrapperElement = this.rtspOverWebSocketWrapperElement as HTMLElement;

      zoomPoint.x = event.pageX - rtspOverWebSocketWrapperElement.offsetLeft;
      zoomPoint.y = event.pageY - rtspOverWebSocketWrapperElement.offsetTop;

      event.preventDefault();
      let delta = event.delta ?? (event as unknown as { wheelDelta?: number }).wheelDelta;
      if (delta === undefined) {
        // we are on firefox
        delta = (event as unknown as { detail?: number }).detail;
      }
      delta = Math.max(-1, Math.min(1, delta as number));

      zoomTarget.x = (zoomPoint.x - pos.x) / (this.scale as number);
      zoomTarget.y = (zoomPoint.y - pos.y) / (this.scale as number);

      this.scale = (this.scale as number) + delta * 0.5 * (this.scale as number);
      this.scale = Math.max(1, Math.min(this.max_scale, this.scale));

      pos.x = -zoomTarget.x * this.scale + zoomPoint.x;
      pos.y = -zoomTarget.y * this.scale + zoomPoint.y;

      if (pos.x > 0) pos.x = 0;
      if (pos.x + Number(size.w) * this.scale < Number(size.w)) pos.x = -Number(size.w) * (this.scale - 1);
      if (pos.y > 0) pos.y = 0;
      if (pos.y + Number(size.h) * this.scale < Number(size.h)) pos.y = -Number(size.h) * (this.scale - 1);

      this.update();
    }
  }

  update(): void {
    const rtspOverWebSocketWrapperElement = this.rtspOverWebSocketWrapperElement as HTMLElement;
    const pos = this.pos as { x: number; y: number };
    rtspOverWebSocketWrapperElement.style.transform = `translate(${pos.x}px,${pos.y}px) scale(${this.scale},${this.scale})`;
  }

  private handleMouseWheel(event: WheelEvent): void {
    const position = this.getPosition(event);
    if (this.positionElement && position.x !== null && position.y !== null) {
      this.positionElement.textContent = '(' + Math.round(position.x) + ', ' + Math.round(position.y) + ')';
      if ((this.playType === RTSPOverWebSocketPlayType.LIVE || this.playType === RTSPOverWebSocketPlayType.PLAYBACK) && this.readyState === RTSPOverWebSocketPlayState.PLAYING) {
        this.scrolled(event as WheelEvent & { delta?: number }, position as { x: number; y: number });
      }
    }
  }

  private handleDoubleClick(event: MouseEvent): void {
    const position = this.getPosition(event);
    if (this.positionElement && position.x !== null && position.y !== null) {
      this.positionElement.textContent = '(' + Math.round(position.x) + ', ' + Math.round(position.y) + ')';
      if (this.playType === RTSPOverWebSocketPlayType.PLAYBACK && this.readyState === RTSPOverWebSocketPlayState.PLAYING) {
        let direction: number;
        const margin = 0;
        this._clickCount = this._clickCount === 0 || this._clickCount === 2 ? 1 : this._clickCount;

        if (position.x <= Number(this.width) / 2 - margin) {
          (this.rewindSpanElement as HTMLElement).innerHTML = (10 * this._clickCount).toString() + ' seconds';
          (this.rewindElement as HTMLElement).classList.add('animate-in');
          direction = -1;
        } else if (position.x > Number(this.width) / 2 + margin) {
          (this.forwardSpanElement as HTMLElement).innerHTML = (10 * this._clickCount).toString() + ' seconds';
          (this.forwardElement as HTMLElement).classList.add('animate-in');
          direction = 1;
        } else {
          direction = 0;
        }

        if (typeof this.GMT !== 'undefined' && this.GMT !== null) {
          if (direction !== 0) {
            const timezone = this.GMT * 3600 * 1000 + 10 * 1000 * direction * this._clickCount;
            this.seekingTime = new Date(new Date(this._localTimestamp as string).getTime() + timezone).toISOString();
          }
        } else {
          const caltime = 10 * 1000 * direction * this._clickCount;
          if (direction !== 0) {
            this.seekingTime = new Date(new Date(this.currentTimestamp as string).getTime() + caltime).toISOString();
          }
        }

        this._clickCount = 0;
      }
    }
  }

  private updateMinimap(): void {
    let data: { mode: string; target: Element | null | string; interval?: number };
    if (this.minimap && this._readyState === RTSPOverWebSocketPlayState.PLAYING) {
      let minimapElement = this.querySelector('#minimap_' + this.id);
      const styleHeight = Math.floor((Number(this.height) * 150) / Number(this.width));
      if (!this.checkStyle('.minimap')) {
        this.appendStyle(panelStyles.minimapStyle(styleHeight));
      }

      if (minimapElement === null) {
        const element = document.createElement('canvas');
        element.id = 'minimap_' + this.id;
        element.setAttribute('width', '150');
        element.setAttribute('height', String(styleHeight));
        element.classList.add('minimap');
        this.appendChild(element);
        minimapElement = element;
      }

      data = { mode: 'on', target: this.querySelector('#minimap_' + this.id), interval: 1000 };
    } else {
      const minimapElement = this.querySelector('#minimap_' + this.id);
      if (minimapElement !== null && this._readyState !== RTSPOverWebSocketPlayState.PAUSED) {
        this.removeChild(minimapElement);
        this.minimapElement = null;
        this.removeStyle('.minimap');
      }
      data = { mode: 'off', target: '' };
    }
    this.info.media.requestInfo.data = data;
    this.info.media.requestInfo.cmd = 'minimap';
    (this.player as StreamPlayer).control(this.info);
  }

  /**
   * Legacy bug preserved: this method's entire tail (everything after
   * building the actual metaImage DOM element) is a copy-paste of
   * `updateMinimap()` — it queries `#minimap_<id>` (not `#metaimage_<id>`)
   * for both the removal branch and the final command `target`, and always
   * sends `cmd: 'minimap'` to the player regardless of this being a meta
   * image update. Reproduced exactly, including the duplicated (and
   * therefore permanently-unreachable-as-unprefixed) `@keyframes fadeOut`
   * check: both the "@-webkit-keyframes fadeOut" and "@keyframes fadeOut"
   * `checkStyle` branches append the SAME webkit-prefixed text, so the
   * unprefixed `@keyframes fadeOut` rule is never actually defined.
   */
  private updateMetaImage(metaImage: RTSPOverWebSocketMetaImageEvent): void {
    let data: { mode: string; target: Element | null | string; interval?: number };
    if (metaImage && this._readyState === RTSPOverWebSocketPlayState.PLAYING) {
      const urlCreator = window.URL;
      const imgElement = this.querySelector('#metaimage_img_' + this.id) as HTMLImageElement | null;
      if (imgElement) {
        urlCreator.revokeObjectURL(imgElement.src);
        (imgElement.parentElement as HTMLElement).removeChild(imgElement);
      }

      const metaImageElement = this.querySelector('#metaimage_' + this.id);

      let styleWidth: number;
      let styleHeight: number;
      if (metaImage.width > metaImage.height) {
        styleWidth = 150;
        styleHeight = Math.floor((metaImage.height * 150) / metaImage.width);
      } else {
        styleWidth = Math.floor((metaImage.width * 150) / metaImage.height);
        styleHeight = 150;
      }

      if (this.checkStyle('.metaImage')) {
        this.removeStyle('.metaImage');
      }

      if (metaImageElement !== null) {
        (metaImageElement.parentElement as HTMLElement).removeChild(metaImageElement);
      }

      if (!this.checkStyle('@-webkit-keyframes fadeOut')) {
        this.appendStyle(panelStyles.FADE_OUT_KEYFRAMES_WEBKIT);
      }
      if (!this.checkStyle('@keyframes fadeOut')) {
        this.appendStyle(panelStyles.FADE_OUT_KEYFRAMES_WEBKIT);
      }
      if (!this.checkStyle('.fadeOut')) {
        this.appendStyle(panelStyles.FADE_OUT_STYLE);
      }

      this.appendStyle(panelStyles.metaImageStyle(styleWidth, styleHeight));

      const element = document.createElement('div');
      element.id = 'metaimage_' + this.id;
      element.classList.add('metaImage');
      element.classList.add('fadeOut');

      const imageElement = document.createElement('img');
      imageElement.id = 'metaimage_img_' + this.id;
      imageElement.width = styleWidth;
      imageElement.height = styleHeight;

      const blobSupported = new Blob(['ä']).size === 2;
      if (blobSupported) {
        const blob = new Blob([metaImage.imageData as BlobPart], { type: 'image/jpeg' });
        const imageUrl = urlCreator.createObjectURL(blob);
        imageElement.src = imageUrl;
        element.appendChild(imageElement);
        this.appendChild(element);
      }

      data = { mode: 'on', target: this.querySelector('#minimap_' + this.id), interval: 1000 };
    } else {
      const minimapElement = this.querySelector('#minimap_' + this.id);
      if (minimapElement !== null && this._readyState !== RTSPOverWebSocketPlayState.PAUSED) {
        this.removeChild(minimapElement);
        this.minimapElement = null;
        this.removeStyle('.minimap');
      }
      data = { mode: 'off', target: '' };
    }
    this.info.media.requestInfo.data = data;
    this.info.media.requestInfo.cmd = 'minimap';
    (this.player as StreamPlayer).control(this.info);
  }

  // ================= properties (accessors) =================

  get playType(): (typeof RTSPOverWebSocketPlayType)[keyof typeof RTSPOverWebSocketPlayType] | null {
    return this._playType;
  }
  set playType(v: (typeof RTSPOverWebSocketPlayType)[keyof typeof RTSPOverWebSocketPlayType]) {
    if (typeof v !== 'number') {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0414'),
        place: 'RTSPOverWebSocket.ts:startTime',
        message: 'invalid input parameter type, check your input parameter type'
      });
    }

    if (v === RTSPOverWebSocketPlayType.LIVE) {
      if (this._playType === RTSPOverWebSocketPlayType.INSTANTPLAYBACK) {
        this.resume();
      }
    }

    if (v === RTSPOverWebSocketPlayType.INSTANTPLAYBACK) {
      this._oldPlayType = this._playType;
      if (this.isplay) {
        this.pause();
      }
      this.info.media.requestInfo.cmd = 'init';
      this.info.media.type = 'instantplayback';
      (this.player as StreamPlayer).control(this.info);
    }
    this._playType = v;
  }

  get mode(): string {
    if (this.playType === RTSPOverWebSocketPlayType.LIVE || this.playType === null) {
      this.playType = RTSPOverWebSocketPlayType.LIVE;
      return 'live';
    } else if (this.playType === RTSPOverWebSocketPlayType.PLAYBACK) {
      return 'playback';
    } else if (this.playType === RTSPOverWebSocketPlayType.BACKUP) {
      return 'backup';
    } else if (this.playType === RTSPOverWebSocketPlayType.INSTANTPLAYBACK) {
      return 'instantplayback';
    } else {
      this.playType = RTSPOverWebSocketPlayType.LIVE;
      return 'live';
    }
  }
  set mode(v: string) {
    if (typeof v !== 'string') {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0414'),
        place: 'RTSPOverWebSocket.ts:mode',
        message: 'invalid input parameter type, check your input parameter type'
      });
    }

    if (v === 'live') {
      this.playType = RTSPOverWebSocketPlayType.LIVE;
    } else if (v === 'playback') {
      this.playType = RTSPOverWebSocketPlayType.PLAYBACK;
    } else if (v === 'backup') {
      this.playType = RTSPOverWebSocketPlayType.BACKUP;
    } else if (v === 'instantplayback') {
      this.playType = RTSPOverWebSocketPlayType.INSTANTPLAYBACK;
    } else {
      this.playType = RTSPOverWebSocketPlayType.LIVE;
    }
  }

  get sessionKey(): string | null {
    return this._sessionKey;
  }
  set sessionKey(v: string | null) {
    this._sessionKey = v;
  }

  get sunapiClient(): SunapiClientLike | null {
    return this._sunapiMng.getSunapiClient() as unknown as SunapiClientLike | null;
  }
  set sunapiClient(v: SunapiClientLike | null | undefined) {
    if (typeof v === 'undefined' || v === null) {
      this._sunapiMng.dettach();
      return;
    }

    this._sunapiMng.attach(v as unknown as Parameters<SunapiManager['attach']>[0]);
    if (this.info.device.ClientIPAddress === '127.0.0.1') {
      this.getClientIp();
    }
  }

  get startTime(): string | undefined {
    return this._startTime;
  }
  set startTime(v: string) {
    if (typeof v !== 'string') {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0414'),
        place: 'RTSPOverWebSocket.ts:startTime',
        message: 'invalid input parameter type, check your input parameter type'
      });
    }

    if (!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z/.test(v) && !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/.test(v)) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0414'),
        place: 'RTSPOverWebSocket.ts:startTime',
        message: 'Invalid input parameter type, check input time format.\r\nYou have to input ISO time format like YYYY-MM-DDTHH:mm:ss.SSSZ.'
      });
    }
    this._startTime = v;
    this._currentTimestamp = this._startTime;
  }

  get endTime(): string | null | undefined {
    return this._endTime;
  }
  set endTime(v: string | null) {
    if (typeof v !== 'string' && v !== null) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0414'),
        place: 'RTSPOverWebSocket.ts:endTime',
        message: 'invalid input parameter type, check your input parameter type'
      });
    }
    if (!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z/.test(v as string) && !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/.test(v as string) && v !== null) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0414'),
        place: 'RTSPOverWebSocket.ts:endTime',
        message: 'Invalid input parameter type, check input time format.\r\nYou have to input ISO time format like YYYY-MM-DDTHH:mm:ss.SSSZ.'
      });
    }
    this._endTime = v;
  }

  get seekingTime(): string | null | undefined {
    return this._seekingTime;
  }
  set seekingTime(v: string) {
    if (typeof v !== 'string') {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0414'),
        place: 'RTSPOverWebSocket.ts:seekingTime',
        message: 'invalid input parameter type'
      });
    }

    // Legacy bug preserved (operator precedence): `!this._playType ===
    // RTSPOverWebSocketPlayType.INSTANTPLAYBACK` evaluates as `(!this._playType) ===
    // RTSPOverWebSocketPlayType.INSTANTPLAYBACK` — always `false` (a boolean can never
    // equal `3`) — so the ISO-date-format validation below never actually
    // runs, regardless of playType.
    if (!(this._playType as unknown as boolean) === (RTSPOverWebSocketPlayType.INSTANTPLAYBACK as unknown as boolean)) {
      if (!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z/.test(v) && !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/.test(v)) {
        throw new RTSPOverWebSocketError({
          channelId: this.channel,
          elementId: this.getAttribute('id') ?? undefined,
          errorCode: fromHex('0x0414'),
          place: 'RTSPOverWebSocket.ts:seekingTime',
          message: 'Invalid input parameter type, check input time format.\r\nYou have to input ISO time format like YYYY-MM-DDTHH:mm:ss.SSSZ.'
        });
      }
    }
    this._seekingTime = v;
    if ((this.isplay && this._seekingTime !== null && this._seekingTime !== undefined) || (this._playType === RTSPOverWebSocketPlayType.INSTANTPLAYBACK && this._seekingTime !== null && this._seekingTime !== undefined)) {
      this.seeking();
    }
  }

  get overlappedId(): string | null | undefined {
    return this._overlappedId;
  }
  set overlappedId(v: string | null) {
    this._overlappedId = v;
  }

  get currentTimestamp(): string | null {
    return this._currentTimestamp;
  }

  get client(): string | undefined {
    return this.info.device.ClientIPAddress;
  }
  set client(v: string) {
    if (typeof v !== 'string') {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0413'),
        place: 'RTSPOverWebSocket.ts:client',
        message: 'invalid client ip address. you have to string type value of your client.'
      });
    }
    this.setAttribute('client', v);
  }

  get hostname(): string | null {
    return this._hostname;
  }
  set hostname(v: string) {
    this.setAttribute('hostname', v);
  }

  get port(): string | null {
    return this._port;
  }
  set port(v: string) {
    this.setAttribute('port', v);
  }

  get channel(): number {
    return (this._channel as number) + 1;
  }
  set channel(v: number | string | null) {
    if (!Number.isInteger(v) && (v === null || v === 'null')) {
      this.setAttribute('channel', null as unknown as string);
      return;
    }
    if (parseInt(v as string, 10) < 1) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0413'),
        place: 'RTSPOverWebSocket.ts:channel',
        message: 'invalid channel number. set to least over 1 the number of channel of NVR or camera.'
      });
    }
    this.setAttribute('channel', String(v));
  }

  get profile(): string | null {
    return this._profile;
  }
  set profile(v: string) {
    this.setAttribute('profile', v);
  }

  get profile_number(): number | null {
    return this._profile_number;
  }
  set profile_number(v: number) {
    this.setAttribute('profile_number', String(v));
  }

  get device(): string | null {
    return this._deviceType;
  }
  set device(v: string) {
    this.setAttribute('device', v);
  }

  get username(): string | null {
    return this._username;
  }
  set username(v: string) {
    this.setAttribute('username', v);
  }

  get password(): string | null {
    return this._password;
  }
  set password(v: string) {
    console.warn('This attribute is not safety. you would be recommand to use the sunapi client for your device safety.');
    this.setAttribute('password', v);
  }

  get iframe(): boolean {
    return this._iframe;
  }
  set iframe(v: boolean) {
    this.setAttribute('iframe', String(v));
  }

  get controls(): boolean {
    return this._controls;
  }
  set controls(v: boolean) {
    this.setAttribute('controls', String(v));
  }

  get multicast(): boolean {
    return this._multicast;
  }
  set multicast(v: boolean) {
    this.setAttribute('multicast', String(v));
  }

  get width(): number | string {
    return this._width;
  }
  set width(v: number | string) {
    this.setAttribute('width', String(v));
  }

  get height(): number | string {
    return this._height;
  }
  set height(v: number | string) {
    this.setAttribute('height', String(v));
  }

  get isplay(): boolean {
    return this.isPlaySymbol();
  }

  get ismute(): boolean {
    return this.isMute();
  }

  get readyState(): (typeof RTSPOverWebSocketPlayState)[keyof typeof RTSPOverWebSocketPlayState] {
    return this._readyState;
  }

  get playSpeed(): number {
    return this._playSpeed.value;
  }
  set playSpeed(v: number | string) {
    switch (Number(v)) {
      case RTSPOverWebSocketPlaySpeed.speed_0_125x.value:
        this._playSpeed = { value: 0.12, name: RTSPOverWebSocketPlaySpeed.speed_0_125x.name };
        break;
      case RTSPOverWebSocketPlaySpeed.speed_0_25x.value:
        this._playSpeed = RTSPOverWebSocketPlaySpeed.speed_0_25x;
        break;
      case RTSPOverWebSocketPlaySpeed.speed_0_50x.value:
        this._playSpeed = RTSPOverWebSocketPlaySpeed.speed_0_50x;
        break;
      case RTSPOverWebSocketPlaySpeed.speed_0_75x.value:
        this._playSpeed = RTSPOverWebSocketPlaySpeed.speed_0_75x;
        break;
      case RTSPOverWebSocketPlaySpeed.speed_0_0x.value:
        this._playSpeed = RTSPOverWebSocketPlaySpeed.speed_0_0x;
        break;
      case RTSPOverWebSocketPlaySpeed.speed_1x.value:
        this._playSpeed = RTSPOverWebSocketPlaySpeed.speed_1x;
        break;
      case RTSPOverWebSocketPlaySpeed.speed_2x.value:
        this._playSpeed = RTSPOverWebSocketPlaySpeed.speed_2x;
        break;
      case RTSPOverWebSocketPlaySpeed.speed_4x.value:
        this._playSpeed = RTSPOverWebSocketPlaySpeed.speed_4x;
        break;
      case RTSPOverWebSocketPlaySpeed.speed_8x.value:
        this._playSpeed = RTSPOverWebSocketPlaySpeed.speed_8x;
        break;
      case RTSPOverWebSocketPlaySpeed.speed_16x.value:
        this._playSpeed = RTSPOverWebSocketPlaySpeed.speed_16x;
        break;
      case RTSPOverWebSocketPlaySpeed.speed_32x.value:
        this._playSpeed = RTSPOverWebSocketPlaySpeed.speed_32x;
        break;
      case RTSPOverWebSocketPlaySpeed.speed_64x.value:
        this._playSpeed = RTSPOverWebSocketPlaySpeed.speed_64x;
        break;
      case RTSPOverWebSocketPlaySpeed.speed_128x.value:
        this._playSpeed = RTSPOverWebSocketPlaySpeed.speed_128x;
        break;
      case RTSPOverWebSocketPlaySpeed.speed_256x.value:
        this._playSpeed = RTSPOverWebSocketPlaySpeed.speed_256x;
        break;
      // Legacy bug preserved: -0.125x's negative counterpart is truncated to
      // -0.12 here (same 0.125 -> 0.12 typo as the positive case above), a
      // real ~4% speed discrepancy from the named "-0.125x" preset.
      case RTSPOverWebSocketPlaySpeed.seek_0_125x.value:
        this._playSpeed = { value: -0.12, name: RTSPOverWebSocketPlaySpeed.seek_0_125x.name };
        break;
      case RTSPOverWebSocketPlaySpeed.seek_0_25x.value:
        this._playSpeed = RTSPOverWebSocketPlaySpeed.seek_0_25x;
        break;
      case RTSPOverWebSocketPlaySpeed.seek_0_50x.value:
        this._playSpeed = RTSPOverWebSocketPlaySpeed.seek_0_50x;
        break;
      case RTSPOverWebSocketPlaySpeed.seek_0_75x.value:
        this._playSpeed = RTSPOverWebSocketPlaySpeed.seek_0_75x;
        break;
      case RTSPOverWebSocketPlaySpeed.seek_0_0x.value:
        this._playSpeed = RTSPOverWebSocketPlaySpeed.seek_0_0x;
        break;
      case RTSPOverWebSocketPlaySpeed.seek_1x.value:
        this._playSpeed = RTSPOverWebSocketPlaySpeed.seek_1x;
        break;
      case RTSPOverWebSocketPlaySpeed.seek_2x.value:
        this._playSpeed = RTSPOverWebSocketPlaySpeed.seek_2x;
        break;
      case RTSPOverWebSocketPlaySpeed.seek_4x.value:
        this._playSpeed = RTSPOverWebSocketPlaySpeed.seek_4x;
        break;
      case RTSPOverWebSocketPlaySpeed.seek_8x.value:
        this._playSpeed = RTSPOverWebSocketPlaySpeed.seek_8x;
        break;
      case RTSPOverWebSocketPlaySpeed.seek_16x.value:
        this._playSpeed = RTSPOverWebSocketPlaySpeed.seek_16x;
        break;
      case RTSPOverWebSocketPlaySpeed.seek_32x.value:
        this._playSpeed = RTSPOverWebSocketPlaySpeed.seek_32x;
        break;
      case RTSPOverWebSocketPlaySpeed.seek_64x.value:
        this._playSpeed = RTSPOverWebSocketPlaySpeed.seek_64x;
        break;
      case RTSPOverWebSocketPlaySpeed.seek_128x.value:
        this._playSpeed = RTSPOverWebSocketPlaySpeed.seek_128x;
        break;
      case RTSPOverWebSocketPlaySpeed.seek_256x.value:
        this._playSpeed = RTSPOverWebSocketPlaySpeed.seek_256x;
        break;
      default:
        this._playSpeed = RTSPOverWebSocketPlaySpeed.speed_1x;
        break;
    }

    if (this.isplay) {
      this.speed();
    }
  }

  get secure(): boolean {
    return this._secure;
  }
  set secure(v: boolean) {
    this.setAttribute('secure', String(v));
  }

  get https(): boolean {
    return this._secure;
  }
  set https(v: boolean) {
    this.setAttribute('https', String(v));
  }

  get src(): string | null {
    return this._source;
  }
  set src(v: string) {
    this._source = v;
  }

  get useIsoTimeFormat(): boolean | null {
    return this._useIso;
  }
  set useIsoTimeFormat(v: boolean) {
    if (typeof v !== 'boolean') {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0414'),
        place: 'RTSPOverWebSocket.ts:supportDrop',
        message: 'invalid input parameter type, check your input parameter type, this value need to a boolean type'
      });
    }
    this._useIso = v;
  }

  get statistics(): boolean {
    return this._statistics;
  }
  set statistics(v: boolean) {
    if (typeof v !== 'boolean') {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0414'),
        place: 'RTSPOverWebSocket.ts:supportDrop',
        message: 'invalid input parameter type, check your input parameter type, this value need to a boolean type'
      });
    }
    this._statistics = v;
    this.statisticsDiv();
  }

  get isTalk(): boolean {
    return this.info.media.audioOutStatus as boolean;
  }

  get filename(): string | null {
    return this._filename;
  }
  set filename(v: string) {
    this._filename = v;
  }

  get GMT(): number | null {
    return this._gmt;
  }
  set GMT(v: number | null | undefined) {
    // Legacy bug preserved (loose validation): only `v === undefined` throws
    // here; any other non-number garbage (e.g. a string) falls through to
    // the range check below unvalidated (which, for a non-numeric string,
    // silently evaluates both `< -12` and `> 13` as `false`).
    if (typeof v !== 'number' && v === undefined) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0414'),
        place: 'RTSPOverWebSocket.ts:GMT',
        message: 'invalid input parameter type, check your input parameter type, this value need to a range of value -12 ~ 13 or null'
      });
    } else {
      if (v === null) {
        this.info.device.gmt = this._gmt = null;
        return;
      }
    }

    if ((v as number) < -12 || (v as number) > 13) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0414'),
        place: 'RTSPOverWebSocket.ts:GMT',
        message: 'invalid input parameter type, check your input parameter type, this value need to a range of value -12 ~ 13'
      });
    }

    this._localTimestamp = null;
    this.setAttribute('gmt', String(v));
  }

  get framedrop(): boolean {
    return this.info.media.drop as boolean;
  }
  set framedrop(v: boolean) {
    if (typeof v !== 'boolean') {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0414'),
        place: 'RTSPOverWebSocket.ts:supportDrop',
        message: 'invalid input parameter type, check your input parameter type, this value need to a boolean type'
      });
    }
    this.info.media.drop = v;
  }

  get volume(): number {
    return this.getAudioVolume();
  }
  set volume(v: number) {
    this.setAudioVolume(v);
  }

  get loading(): boolean {
    return this._useLoading;
  }
  set loading(v: boolean) {
    this._useLoading = v;
  }

  get fullscreen(): boolean {
    return this._fullscreen;
  }
  set fullscreen(v: boolean) {
    this._fullscreen = v;
    if (this._fullscreen) this.toggleFullScreen(this);
  }

  /**
   * Legacy bug preserved: `_useGrunt` is never assigned anywhere in the
   * legacy source (only `_network` is a real field) — this getter always
   * returns `undefined`, while the setter below actually writes to
   * `info.device.serverType`, not `_useGrunt`. Reproduced verbatim (a real,
   * silent read/write mismatch on the same named property).
   */
  get grunt(): boolean | undefined {
    return this._useGrunt;
  }
  set grunt(v: boolean) {
    this.info.device.serverType = v ? 'grunt' : 'camera';
  }

  get bestshot(): boolean | null | undefined {
    return this.info.media.bestshot;
  }
  set bestshot(v: boolean | null) {
    if (v === null) {
      this.info.media.bestshot = null as unknown as boolean;
      this.dispatch('changebestshot', { bestshot: this.info.media.bestshot });
      return;
    }
    if (typeof v !== 'boolean') {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0414'),
        place: 'RTSPOverWebSocket.ts:bestshot',
        message: 'invalid input parameter type, check your input parameter type, this value need to a boolean type'
      });
    }

    this.info.media.bestshot = v;
    this.dispatch('changebestshot', { bestshot: this.info.media.bestshot });
  }

  get coordinatedUniversalTime(): boolean {
    return this._coordinatedUniversalTime;
  }
  set coordinatedUniversalTime(v: boolean) {
    this._coordinatedUniversalTime = v;
  }

  /**
   * Legacy bug preserved (bug #1, the most impactful accessor bug in the
   * class): the legacy source declares THREE separate `get background()`/
   * `set background(v)` accessor pairs (once right after `bestshot`, an
   * exact duplicate right after `coordinatedUniversalTime`, and a THIRD
   * time — mislabeled — right under the `useClockRange` getter). Per real
   * JS class-evaluation semantics, only the LAST declared `set background`
   * in the class body actually wins; the winning one is the mislabeled
   * third copy, which sets `_useClockRange` instead of `_background` and
   * never calls `_updateRendering()`. Practically: assigning
   * `element.background = ...` silently changes `useClockRange`'s backing
   * field instead, and `useClockRange` itself ends up with NO working
   * setter at all (only a getter — assigning `element.useClockRange = ...`
   * throws a real `TypeError` in class-body strict mode). This is
   * reproduced exactly below: `background`'s setter mutates
   * `_useClockRange`, and `useClockRange` is getter-only.
   */
  get background(): string {
    return this._background;
  }
  set background(v: boolean) {
    this._useClockRange = v;
  }

  get useClockRange(): boolean {
    return this._useClockRange;
  }

  get bestshotfilter(): (typeof RTSPOverWebSocketBestshotFilter)[keyof typeof RTSPOverWebSocketBestshotFilter] | null {
    return this._bestshotFilter;
  }
  set bestshotfilter(v: number) {
    if (parseInt(String(v), 10) < 0 || Object.keys(RTSPOverWebSocketBestshotFilter).length <= v) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0413'),
        place: 'RTSPOverWebSocket.ts:bestshotfilter',
        message: 'invalid bestshotfilter. you have to reference from RTSPOverWebSocketBestshotFilter enum value.'
      });
    }

    this.setBestshotFilter(v);
  }

  get minimap(): boolean {
    return this._minimap;
  }
  set minimap(v: boolean) {
    if (typeof v !== 'boolean') {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0414'),
        place: 'RTSPOverWebSocket.ts:minimap',
        message: 'invalid input parameter type, check your input parameter type, this value need to a boolean type'
      });
    }

    if (typeof this.player === 'undefined' || this.player === null) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x1000'),
        place: 'RTSPOverWebSocket.ts:pause()',
        message: 'player object is not exist'
      });
    }

    this._minimap = v;
    this.updateMinimap();
  }

  get useContextmenu(): boolean {
    return this._useContextmenu;
  }
  set useContextmenu(v: boolean) {
    if (typeof v !== 'boolean') {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0414'),
        place: 'RTSPOverWebSocket.ts:useContextmenu',
        message: 'invalid input parameter type, check your input parameter type, this value need to a boolean type'
      });
    }
    this._useContextmenu = v;
  }

  get usesubstream(): boolean | null {
    return this._usesubstream;
  }
  set usesubstream(v: boolean) {
    if (typeof v !== 'boolean') {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0414'),
        place: 'RTSPOverWebSocket.ts:usesubstream',
        message: 'invalid input parameter type, check your input parameter type, this value need to a boolean type'
      });
    }
    this._usesubstream = v;
  }

  get type(): string | null {
    return this.info.media.mode ?? null;
  }
  set type(v: string | null | undefined) {
    if (v === null || v === 'null' || typeof v === 'undefined' || typeof v !== 'string' || v === 'auto') {
      this.info.media.mode = null;
      return;
    } else if (v !== 'video' && v !== 'canvas') {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0414'),
        place: 'RTSPOverWebSocket.ts:type',
        message: 'invalid input parameter type. you have to set to string of video or canvas for video renderer type.'
      });
    }
    this.info.media.mode = v;
  }

  /**
   * Legacy bug preserved (copy-paste): identical body to the `type` getter
   * above — no distinct audio-shift value is ever tracked; this always
   * returns `info.media.mode`.
   */
  get audioshift(): string | null | undefined {
    return this.info.media.mode;
  }
  set audioshift(v: number) {
    const data = { cmd: 'audioShift', data: parseInt(String(v), 10) };
    if (this.player !== null) {
      this.player.controlWorker(data);
    }
  }

  get camchannel(): number | null {
    return this._camChannel;
  }
  set camchannel(v: number) {
    if (isNaN(parseInt(String(v), 10))) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0414'),
        place: 'RTSPOverWebSocket.ts:camchannel',
        message: 'invalid input parameter type, check your input parameter type, Only number types are possible.'
      });
    }
    this._camChannel = v;
  }

  get profileusage(): string | null {
    return this._profileUsage;
  }
  set profileusage(v: string) {
    if (v !== 'Live' && v !== 'Record' && v !== 'Network') {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0414'),
        place: 'RTSPOverWebSocket.ts:profileusage',
        message: "invalid input parameter value, check your input parameter type, Only 'Live', 'Record' and 'Network' values are possible."
      });
    }
    this._profileUsage = v;
  }

  get codec(): string | null {
    return this._codec;
  }
  set codec(v: string) {
    if (v !== 'MJPEG' && v !== 'H264' && v !== 'H265' && v !== 'MPEG4') {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0414'),
        place: 'RTSPOverWebSocket.ts:codec',
        message: "invalid input parameter value, check your input parameter type, Only 'MJPEG', 'H264', 'H265' and 'MPEG4' values are possible."
      });
    }
    this._codec = v;
  }

  get limitwidth(): number | null {
    return this._limitWidth;
  }
  set limitwidth(v: number) {
    if (isNaN(parseInt(String(v), 10))) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0414'),
        place: 'RTSPOverWebSocket.ts:limitwidth',
        message: 'invalid input parameter type, check your input parameter type, Only number types are possible.'
      });
    }
    this._limitWidth = v;
  }

  get limitheight(): number | null {
    return this._limitHeight;
  }
  set limitheight(v: number) {
    if (isNaN(parseInt(String(v), 10))) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0414'),
        place: 'RTSPOverWebSocket.ts:limitheight',
        message: 'invalid input parameter type, check your input parameter type, Only number types are possible.'
      });
    }
    this._limitHeight = v;
  }

  get android(): boolean {
    return this._android;
  }
  set android(v: boolean | undefined) {
    if (typeof v === 'undefined') {
      this._android = false;
    } else if (typeof v !== 'boolean') {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0414'),
        place: 'RTSPOverWebSocket.ts:android',
        message: 'invalid input parameter type, check your input parameter type, Only number types are possible.'
      });
    } else {
      this._android = v;
    }

    if (this._android) this.setAttribute('channel', null as unknown as string);
  }

  // ================= internal update / DOM-builder methods =================

  private updateSunapiManager(): void {
    try {
      if (this._hostname !== null && this._username !== null && this._password !== null && this._deviceType !== null) {
        this.info.device.cameraIp = this._hostname;
        this.info.device.hostname = this._hostname;
        this.info.device.user = this._username;
        this.info.device.username = this._username;
        this.info.device.password = this._password;
        this.info.device.deviceType = this._deviceType;

        if (this._port !== null) {
          this.info.device.port = this._port as unknown as number;
        }

        if (this._secure !== null) {
          if (this._secure === true) {
            this.info.device.protocol = 'https';
            if (this._port === null) {
              this.info.device.port = '443' as unknown as number;
            }
          } else {
            this.info.device.protocol = 'http';
            if (this._port === null) {
              this.info.device.port = '80' as unknown as number;
            }
          }
        }

        const channel = this.channel;
        const elementId = this.getAttribute('id') ?? undefined;
        const sunapiManager = this._sunapiMng;
        const test = (): void => {
          this.dispatch('sunapiclient', {
            channelId: channel,
            message: 'success to connect the sunapi client.',
            place: 'RTSPOverWebSocket.ts:_updateSunapiManager'
          });
        };

        test();

        // `StreamPlayerDeviceInfo.proxy` (a hostname/proxy-server string) and
        // `SunapiManagerDeviceInfo.proxy` (a boolean flag, inherited from
        // `SunapiClientDeviceInfo`) are unrelated fields that happen to
        // share a name across two independently-ported legacy interfaces;
        // legacy itself passes this object through untyped. Cast to match.
        const promise = this._sunapiMng.init(this.info.device as unknown as SunapiManagerDeviceInfo);
        promise
          .then(() => {
            test();
          })
          .catch((error: unknown) => {
            console.error(error);
            sunapiManager.dettach();
            // Legacy bug preserved: the nested 404/490/401 AuthError
            // classification below is guarded by
            // `error instanceof AuthError && error instanceof SunapiError`
            // — a single error object can never be an instance of BOTH
            // sibling error classes simultaneously (neither extends the
            // other), so this condition is always `false` and the whole
            // block is permanently dead code. `error instanceof AuthError`
            // alone (the outer `if`) is reachable and only logs.
            if (typeof AuthError !== 'undefined' && error instanceof AuthError) {
              console.error('AuthError', error);
            }
            if (typeof AuthError !== 'undefined' && error instanceof AuthError && typeof SunapiError !== 'undefined' && (error as unknown) instanceof SunapiError) {
              console.error('SunapiError', error);
              const errorCode = (error as SunapiError).errorCode;
              if (errorCode === 404) {
                throw new AuthError({
                  channelId: channel,
                  elementId,
                  errorCode: fromHex('0x0702'),
                  place: 'RTSPOverWebSocket.ts:_updateSunapiManager',
                  message: 'Sunapi Client do not access to device host or port information.'
                });
              }
              if (errorCode === 490) {
                throw new AuthError({
                  channelId: channel,
                  elementId,
                  errorCode: fromHex('0x0705'),
                  place: 'RTSPOverWebSocket.ts:_updateSunapiManager',
                  message: 'Sunapi Client fail to access to url because of user account block.'
                });
              }
              if (errorCode === 401) {
                throw new AuthError({
                  channelId: channel,
                  elementId,
                  errorCode: fromHex('0x0704'),
                  place: 'RTSPOverWebSocket.ts:_updateSunapiManager',
                  message: 'Sunapi Client fail to access to url because of invalid username or password.'
                });
              }
            }
          });
      }
    } catch (error) {
      console.error(error);
    }
  }

  // channel_div, statistics, video-container and contextmenu all render as
  // overlay panels for one player instance, so they belong under one shared
  // `#rtsp-over-websocket-wrapper-<id>` container instead of as flat siblings directly under
  // `<rtsp-over-websocket>`. This is called from multiple independent code paths
  // (statisticsDiv/updateRendering/contextmenuDiv, in no fixed order — e.g.
  // `statistics` can be toggled on long after connectedCallback already ran),
  // so it lazily creates+attaches the wrapper at most once and every caller
  // just appends into whatever it returns.
  private ensureRTSPOverWebSocketWrapper(): HTMLElement {
    if (this.rtspOverWebSocketWrapperElement === undefined || this.rtspOverWebSocketWrapperElement === null) {
      this.rtspOverWebSocketWrapperElement = document.createElement('div');
      this.rtspOverWebSocketWrapperElement.id = 'rtsp-over-websocket-wrapper-' + this.id;
      this.rtspOverWebSocketWrapperElement.style.cssText = 'min-width: auto; width: 100%; height: 100%; display: block; margin-left: auto; margin-right: auto;';
      this.appendChild(this.rtspOverWebSocketWrapperElement);
    }
    return this.rtspOverWebSocketWrapperElement;
  }

  private updateRendering(): void {
    if (!this.checkStyle('.video-container')) {
      this.appendStyle(panelStyles.VIDEO_CONTAINER_STYLE);
      this.appendStyle(panelStyles.VIDEO_FORWARD_NOTIFY_STYLE);
      this.appendStyle(panelStyles.VIDEO_FORWARD_NOTIFY_ICON_STYLE);
      this.appendStyle(panelStyles.VIDEO_REWIND_NOTIFY_STYLE);
      this.appendStyle(panelStyles.VIDEO_REWIND_NOTIFY_ICON_STYLE);
      this.appendStyle(panelStyles.VIDEO_CONTAINER_ICON_I_STYLE);
      this.appendStyle(panelStyles.VIDEO_CONTAINER_NOTIFICATION_STYLE);
      this.appendStyle(panelStyles.VIDEO_CONTAINER_I_STYLE);
      this.appendStyle(panelStyles.VIDEO_CONTAINER_SPAN_FONT_STYLE);
      this.appendStyle(panelStyles.VIDEO_CONTAINER_ANIMATE_IN_STYLE);
      this.appendStyle(panelStyles.VIDEO_CONTAINER_ANIMATE_IN_I_STYLE);
      this.appendStyle(panelStyles.VIDEO_CONTAINER_ANIMATE_IN_FORWARD_I_PADDING_STYLE);
      this.appendStyle(panelStyles.VIDEO_CONTAINER_ANIMATE_IN_FORWARD_I_ANIM_STYLE);
      this.appendStyle(panelStyles.VIDEO_CONTAINER_ANIMATE_IN_REWIND_I_ANIM_STYLE);
      this.appendStyle(panelStyles.RIPPLE_KEYFRAMES);
      this.appendStyle(panelStyles.FADE_IN_LEFT_KEYFRAMES);
      this.appendStyle(panelStyles.FADE_IN_RIGHT_KEYFRAMES);
    }

    const videoContainerElement = document.createElement('div');
    videoContainerElement.className = 'video-container';

    const videoRewindNotifyElement = document.createElement('div');
    videoRewindNotifyElement.className = 'video-rewind-notify rewind notification';

    const rewindElement = document.createElement('div');
    rewindElement.className = 'rewind-icon icon';

    const rewindIconElement = document.createElement('i');
    rewindIconElement.className = 'left-triangle triangle';
    rewindIconElement.innerHTML = '◀◀◀';

    const rewindSpanElement = document.createElement('span');
    rewindSpanElement.className = 'rewind';
    rewindSpanElement.innerHTML = '10 seconds';

    rewindElement.appendChild(rewindIconElement);
    rewindElement.appendChild(rewindSpanElement);
    videoRewindNotifyElement.appendChild(rewindElement);

    const videoForwardNotifyElement = document.createElement('div');
    videoForwardNotifyElement.className = 'video-forward-notify forward notification';

    const forwardElement = document.createElement('div');
    forwardElement.className = 'forward-icon icon';

    const forwardIconElement = document.createElement('i');
    forwardIconElement.className = 'right-triangle triangle';
    forwardIconElement.innerHTML = '▶▶▶';

    const forwardSpanElement = document.createElement('span');
    forwardSpanElement.className = 'forward';
    forwardSpanElement.innerHTML = '10 seconds';

    forwardElement.appendChild(forwardIconElement);
    forwardElement.appendChild(forwardSpanElement);
    videoForwardNotifyElement.appendChild(forwardElement);

    this.rewindElement = videoRewindNotifyElement;
    this.forwardElement = videoForwardNotifyElement;
    this.rewindSpanElement = rewindSpanElement;
    this.forwardSpanElement = forwardSpanElement;

    videoContainerElement.appendChild(videoRewindNotifyElement);
    videoContainerElement.appendChild(videoForwardNotifyElement);
    const rtspOverWebSocketWrapperElement = this.ensureRTSPOverWebSocketWrapper();
    rtspOverWebSocketWrapperElement.appendChild(videoContainerElement);

    if (this.video !== undefined && this.video !== null) {
      rtspOverWebSocketWrapperElement.appendChild(this.video);

      this.zoom_point = { x: 0, y: 0 };
      this.size = { w: this.width, h: this.height };
      this.pos = { x: 0, y: 0 };
      this.zoom_target = { x: 0, y: 0 };
      this.scale = 1;
    }

    // Legacy bug preserved: mixes the public `profile_number` getter with the
    // raw `_profile_number` field in the same condition (should have used
    // the getter consistently), and both duplicate the same well-formed
    // `_profile` check, so the guard is a bit more permissive than intended
    // but not actually broken for any real input shape.
    if (this._autoplay === true && (this._profile !== null || (this.profile_number !== null && this._profile_number)) && this._deviceType !== null) {
      if (this._deviceType === 'nvr') {
        if (this._channel !== null) {
          this.play();
        }
      } else {
        this.play();
      }
    }
  }

  private dispatch(event: string, data: Record<string, unknown>): void {
    if (this._channel !== null) {
      data.channelId = this._channel + 1;
    }
    if (this.getAttribute('id') !== null) {
      data.elementId = this.getAttribute('id');
    }

    const eventData = new CustomEvent(event, { bubbles: true, detail: data });
    this.dispatchEvent(eventData);
  }

  private statisticsDiv(): void {
    if (this._statistics || this.statistics === true) {
      if (this.statisticsElement !== undefined && this.statisticsElement !== null) {
        return;
      }

      const styleText = this.video.getAttribute('style');
      if (styleText !== null) {
        this.video.setAttribute('style', styleText);
      }

      if (!this.checkStyle('.channel_div')) {
        this.appendStyle(panelStyles.CHANNEL_DIV_STYLE);
      }

      if (!this.checkStyle('.statistics')) {
        this.appendStyle(panelStyles.STATISTICS_STYLE);
        this.appendStyle(panelStyles.STATISTICS_DIV_STYLE);
        this.appendStyle(panelStyles.STATISTICS_SPAN_STYLE);
        this.appendStyle(panelStyles.STATISTICS_GRAPH_STYLE);
      }

      this.channelElement = document.createElement('div');
      const channelLabelElement = document.createElement('div');
      this.channelElement.appendChild(channelLabelElement);
      this.channelElement.setAttribute('class', 'channel_div');
      this.ensureRTSPOverWebSocketWrapper().appendChild(this.channelElement);
      this.channelLabelElement = channelLabelElement;

      this.statisticsElement = document.createElement('div');

      const resolutionElement = document.createElement('div');
      const resolutionLabelElement = document.createElement('span');
      resolutionLabelElement.innerText = 'Res';
      resolutionLabelElement.className = 'stat-label accent-cyan';
      const resolutionSpanElement = document.createElement('span');
      resolutionSpanElement.className = 'stat-value';
      resolutionElement.appendChild(resolutionLabelElement);
      resolutionElement.appendChild(resolutionSpanElement);

      const positionElement = document.createElement('div');
      const positionLabelElement = document.createElement('span');
      positionLabelElement.innerText = 'Pos';
      positionLabelElement.className = 'stat-label accent-cyan';
      const positionSpanElement = document.createElement('span');
      positionSpanElement.className = 'stat-value';
      positionElement.appendChild(positionLabelElement);
      positionElement.appendChild(positionSpanElement);

      const ratioElement = document.createElement('div');
      const ratioLabelElement = document.createElement('span');
      ratioLabelElement.innerText = 'Ratio';
      ratioLabelElement.className = 'stat-label accent-cyan';
      const ratioSpanElement = document.createElement('span');
      ratioSpanElement.className = 'stat-value';
      ratioElement.appendChild(ratioLabelElement);
      ratioElement.appendChild(ratioSpanElement);

      const codecElement = document.createElement('div');
      const codecLabelElement = document.createElement('span');
      codecLabelElement.innerText = 'Codec';
      codecLabelElement.className = 'stat-label accent-mint';
      const codecValuesElement = document.createElement('span');
      codecValuesElement.className = 'stat-values';
      const videoCodecSpanElement = document.createElement('span');
      videoCodecSpanElement.className = 'stat-value';
      const audioCodecSpanElement = document.createElement('span');
      audioCodecSpanElement.className = 'stat-value';
      codecValuesElement.appendChild(videoCodecSpanElement);
      codecValuesElement.appendChild(audioCodecSpanElement);
      codecElement.appendChild(codecLabelElement);
      codecElement.appendChild(codecValuesElement);

      const frameElement = document.createElement('div');
      const frameLabelElement = document.createElement('span');
      frameLabelElement.innerText = 'FPS';
      frameLabelElement.className = 'stat-label accent-mint';
      const frameSpanElement = document.createElement('span');
      frameSpanElement.className = 'stat-value';
      frameElement.appendChild(frameLabelElement);
      frameElement.appendChild(frameSpanElement);

      const decodedElement = document.createElement('div');
      const decodedLabelElement = document.createElement('span');
      decodedLabelElement.innerText = 'Decoded';
      decodedLabelElement.className = 'stat-label accent-amber';
      const decodedSpanElement = document.createElement('span');
      decodedSpanElement.className = 'stat-value';
      decodedElement.appendChild(decodedLabelElement);
      decodedElement.appendChild(decodedSpanElement);

      const droppedPacketElement = document.createElement('div');
      const droppedPacketLabelElement = document.createElement('span');
      droppedPacketLabelElement.innerText = 'Dropped';
      droppedPacketLabelElement.className = 'stat-label accent-amber';
      const droppedPacketSpanElement = document.createElement('span');
      droppedPacketSpanElement.className = 'stat-value';
      droppedPacketElement.appendChild(droppedPacketLabelElement);
      droppedPacketElement.appendChild(droppedPacketSpanElement);

      const videoRtpElement = document.createElement('div');
      const videoRtpLabelElement = document.createElement('span');
      videoRtpLabelElement.innerText = 'Video RTP';
      videoRtpLabelElement.className = 'stat-label accent-blue';
      const videoRtpValuesElement = document.createElement('span');
      videoRtpValuesElement.className = 'stat-values';
      const videoRtpRecvSpanElement = document.createElement('span');
      videoRtpRecvSpanElement.className = 'stat-value';
      const videoRtpTotalRecvSpanElement = document.createElement('span');
      videoRtpTotalRecvSpanElement.className = 'stat-value';
      videoRtpValuesElement.appendChild(videoRtpRecvSpanElement);
      videoRtpValuesElement.appendChild(videoRtpTotalRecvSpanElement);
      videoRtpElement.appendChild(videoRtpLabelElement);
      videoRtpElement.appendChild(videoRtpValuesElement);

      const audioRtpElement = document.createElement('div');
      const audioRtpLabelElement = document.createElement('span');
      audioRtpLabelElement.innerText = 'Audio RTP';
      audioRtpLabelElement.className = 'stat-label accent-blue';
      const audioRtpValuesElement = document.createElement('span');
      audioRtpValuesElement.className = 'stat-values';
      const audioRtpRecvSpanElement = document.createElement('span');
      audioRtpRecvSpanElement.className = 'stat-value';
      const audioRtpTotalRecvSpanElement = document.createElement('span');
      audioRtpTotalRecvSpanElement.className = 'stat-value';
      audioRtpValuesElement.appendChild(audioRtpRecvSpanElement);
      audioRtpValuesElement.appendChild(audioRtpTotalRecvSpanElement);
      audioRtpElement.appendChild(audioRtpLabelElement);
      audioRtpElement.appendChild(audioRtpValuesElement);

      const latencyElement = document.createElement('div');
      const latencyLabelElement = document.createElement('span');
      latencyLabelElement.innerText = 'Buffer';
      latencyLabelElement.className = 'stat-label accent-pink';
      const latencyValuesElement = document.createElement('span');
      latencyValuesElement.className = 'stat-values';
      const latencySpanElement = document.createElement('span');
      latencySpanElement.className = 'stat-value';
      const chunkSizeSpanElement = document.createElement('span');
      chunkSizeSpanElement.className = 'stat-value';
      latencyValuesElement.appendChild(latencySpanElement);
      latencyValuesElement.appendChild(chunkSizeSpanElement);
      latencyElement.appendChild(latencyLabelElement);
      latencyElement.appendChild(latencyValuesElement);

      // Line chart of recent buffer/latency samples — see
      // onRTSPOverWebSocketStatistics()'s 'fps' case (pushes into
      // bufferHistory) and renderBufferChart().
      const bufferChartSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      bufferChartSvg.setAttribute('class', 'stat-chart');
      bufferChartSvg.setAttribute('viewBox', '0 0 100 20');
      bufferChartSvg.setAttribute('preserveAspectRatio', 'none');
      const bufferChartPolyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      bufferChartSvg.appendChild(bufferChartPolyline);
      latencyElement.appendChild(bufferChartSvg);

      const receivedElement = document.createElement('div');
      const receivedLabelElement = document.createElement('span');
      receivedLabelElement.innerText = 'Received';
      receivedLabelElement.className = 'stat-label accent-pink';
      const receivedValuesElement = document.createElement('span');
      receivedValuesElement.className = 'stat-values';
      const currentRecvSpanElement = document.createElement('span');
      currentRecvSpanElement.className = 'stat-value';
      const totalRecvSpanElement = document.createElement('span');
      totalRecvSpanElement.className = 'stat-value';
      receivedValuesElement.appendChild(currentRecvSpanElement);
      receivedValuesElement.appendChild(totalRecvSpanElement);
      receivedElement.appendChild(receivedLabelElement);
      receivedElement.appendChild(receivedValuesElement);

      const timestampElement = document.createElement('div');
      const timestampLabelElement = document.createElement('span');
      timestampLabelElement.innerText = 'Timestamp';
      timestampLabelElement.className = 'stat-label accent-slate';
      const timestampValuesElement = document.createElement('span');
      timestampValuesElement.className = 'stat-values';
      const timestampSpanElement = document.createElement('span');
      timestampSpanElement.className = 'stat-value';
      const timestampIntetvalSpanElement = document.createElement('span');
      timestampIntetvalSpanElement.className = 'stat-value';
      timestampValuesElement.appendChild(timestampSpanElement);
      timestampValuesElement.appendChild(timestampIntetvalSpanElement);
      timestampElement.appendChild(timestampLabelElement);
      timestampElement.appendChild(timestampValuesElement);

      const dataElement = document.createElement('div');
      const dataLabelElement = document.createElement('span');
      dataLabelElement.innerText = 'Data';
      dataLabelElement.className = 'stat-label accent-slate';
      const dataSpanElement = document.createElement('span');
      dataSpanElement.className = 'stat-value wrap';
      dataElement.appendChild(dataLabelElement);
      dataElement.appendChild(dataSpanElement);

      // Reuses applyNetworkStateDotClass()'s _networkState value (already
      // tracked for the separate standalone floating dot — see
      // networkstateDiv()) as a labeled row inside the statistics panel
      // too, with its own flat (non-pulsing) color mapping matching the
      // panel's plain accent-color convention — see
      // panelStyles.STATISTICS_GRAPH_STYLE's .network-dot.state-* rules.
      const networkElement = document.createElement('div');
      const networkLabelElement = document.createElement('span');
      networkLabelElement.innerText = 'Network';
      networkLabelElement.className = 'stat-label accent-cyan';
      const networkRowElement = document.createElement('span');
      networkRowElement.className = 'stat-value network-label-row';
      const networkDotElement = document.createElement('span');
      networkDotElement.className = 'network-dot';
      const networkTextElement = document.createElement('span');
      networkRowElement.appendChild(networkDotElement);
      networkRowElement.appendChild(networkTextElement);
      networkElement.appendChild(networkLabelElement);
      networkElement.appendChild(networkRowElement);

      // Intensity graph (bar chart) of recent received-bitrate samples —
      // see onRTSPOverWebSocketStatistics()'s 'fps' case (pushes into
      // bitrateHistory) and renderRateGraph().
      const rateElement = document.createElement('div');
      const rateLabelElement = document.createElement('span');
      rateLabelElement.innerText = 'Rate';
      rateLabelElement.className = 'stat-label accent-blue';
      const rateGraphElement = document.createElement('span');
      rateGraphElement.className = 'stat-graph';
      rateElement.appendChild(rateLabelElement);
      rateElement.appendChild(rateGraphElement);

      this.statisticsElement.appendChild(networkElement);
      this.statisticsElement.appendChild(resolutionElement);
      this.statisticsElement.appendChild(positionElement);
      this.statisticsElement.appendChild(ratioElement);
      this.statisticsElement.appendChild(codecElement);
      this.statisticsElement.appendChild(rateElement);
      this.statisticsElement.appendChild(frameElement);
      this.statisticsElement.appendChild(decodedElement);
      this.statisticsElement.appendChild(droppedPacketElement);
      this.statisticsElement.appendChild(videoRtpElement);
      this.statisticsElement.appendChild(audioRtpElement);
      this.statisticsElement.appendChild(latencyElement);
      this.statisticsElement.appendChild(receivedElement);
      this.statisticsElement.appendChild(timestampElement);
      this.statisticsElement.appendChild(dataElement);

      this.statisticsElement.setAttribute('class', 'statistics');
      this.ensureRTSPOverWebSocketWrapper().appendChild(this.statisticsElement);

      this.resolutionElement = resolutionSpanElement;
      this.positionElement = positionSpanElement;
      this.ratioElement = ratioSpanElement;
      this.videoCodecElement = videoCodecSpanElement;
      this.audioCodecElement = audioCodecSpanElement;
      this.frameElement = frameSpanElement;
      this.decodeElement = decodedSpanElement;
      this.dropElement = droppedPacketSpanElement;
      this.videoRtpRecvElement = videoRtpRecvSpanElement;
      this.videoRtpTotalRecvElement = videoRtpTotalRecvSpanElement;
      this.audioRtpRecvElement = audioRtpRecvSpanElement;
      this.audioRtpTotalRecvElement = audioRtpTotalRecvSpanElement;
      this.latencyElement = latencySpanElement;
      this.chunkSizeElement = chunkSizeSpanElement;
      this.currentRecvElement = currentRecvSpanElement;
      this.totalRecvElement = totalRecvSpanElement;
      this.timestampElement = timestampSpanElement;
      this.timestampIntervalElement = timestampIntetvalSpanElement;
      this.dataElement = dataSpanElement;
      this.networkStatDotElement = networkDotElement;
      this.networkStatTextElement = networkTextElement;
      this.rateGraphElement = rateGraphElement;
      this.bufferChartElement = bufferChartPolyline;
      this.applyStatisticsNetworkState();
    } else {
      if (this.statisticsElement !== undefined && this.statisticsElement !== null) {
        this.statisticsElement.remove();
        this.statisticsElement = null;
        this.removeAttribute('statistics');
        this.video.style.position = '';
      }
    }
  }

  /** Refreshes the statistics panel's Network row from `_networkState` —
   * called both when the panel is (re)built and whenever `_networkState`
   * itself changes (see the '0x1005' error-code handler), independent of
   * whether the separate standalone floating dot (networkstateDiv(),
   * gated on the unrelated `network` attribute) is also showing. */
  private applyStatisticsNetworkState(): void {
    if (this.networkStatDotElement === undefined || this.networkStatDotElement === null) return;
    this.networkStatDotElement.setAttribute('class', 'network-dot state-' + this._networkState);
    if (this.networkStatTextElement !== undefined && this.networkStatTextElement !== null) {
      this.networkStatTextElement.textContent = this._networkState.replace('_', ' ');
    }
  }

  /** Renders bitrateHistory as a bar chart ("intensity graph") — see
   * onRTSPOverWebSocketStatistics()'s 'fps' case, which pushes into it. */
  private renderRateGraph(): void {
    if (this.rateGraphElement === undefined || this.rateGraphElement === null) return;
    const max = Math.max(...this.bitrateHistory, 1);
    this.rateGraphElement.innerHTML = '';
    for (const value of this.bitrateHistory) {
      const bar = document.createElement('span');
      bar.className = 'stat-graph-bar';
      bar.style.height = Math.max(2, Math.round((value / max) * 20)) + 'px';
      this.rateGraphElement.appendChild(bar);
    }
  }

  /** Renders bufferHistory as an SVG line chart — see
   * onRTSPOverWebSocketStatistics()'s 'fps' case, which pushes into it. */
  private renderBufferChart(): void {
    if (this.bufferChartElement === undefined || this.bufferChartElement === null) return;
    const max = Math.max(...this.bufferHistory, 0.001);
    const count = this.bufferHistory.length;
    const points = this.bufferHistory
      .map((value, index) => {
        const x = count > 1 ? (index / (count - 1)) * 100 : 100;
        const y = 20 - (value / max) * 20;
        return x.toFixed(1) + ',' + y.toFixed(1);
      })
      .join(' ');
    this.bufferChartElement.setAttribute('points', points);
  }

  private networkstateDiv(): void {
    if (this._network) {
      if (!this.checkStyle('.network_state_wrapper')) {
        this.appendStyle(panelStyles.NETWORK_STATE_WRAPPER_STYLE);
      }
      if (!this.checkStyle('.ball')) {
        this.appendStyle(panelStyles.BALL_STYLE);
      }
      if (!this.checkStyle('.ball:hover')) {
        this.appendStyle(panelStyles.BALL_HOVER_STYLE);
      }

      for (const name of ['darkred', 'red', 'lightgreen', 'yellowgreen', 'green', 'yellow', 'orange'] as const) {
        const kf = panelStyles.NETWORK_DOT_KEYFRAMES[name];
        if (!this.checkStyle(`@-webkit-keyframes ${name}`)) {
          this.appendStyle(kf.webkit);
        }
        if (!this.checkStyle(`@-moz-keyframes ${name}`)) {
          this.appendStyle(kf.moz);
        }
      }
      for (const name of ['darkred', 'red', 'yellow', 'lightgreen', 'yellowgreen'] as const) {
        if (!this.checkStyle(`.${name}`)) {
          this.appendStyle(panelStyles.DARK_BALL_ANIMATION_STYLES[name]);
        }
      }

      if (this.networkStateElement === undefined || this.networkStateElement === null) {
        this.networkStateElement = document.createElement('div');
        this.dotElement = document.createElement('div');
        this.applyNetworkStateDotClass();
        this.networkStateElement.appendChild(this.dotElement);
        this.networkStateElement.setAttribute('class', 'network_state_wrapper');
        this.appendChild(this.networkStateElement);
      } else if (this.networkStateElement !== undefined && this.networkStateElement !== null && this.dotElement !== undefined && this.dotElement !== null) {
        this.applyNetworkStateDotClass();
      }

      if (this.dotElement !== undefined && this.dotElement !== null) {
        this.dotElement.addEventListener('click', () => {
          const statisticsAttributeValue = this.getAttribute('statistics');
          if (statisticsAttributeValue === 'false') {
            this.removeAttribute('statistics');
          } else {
            this.setAttribute('statistics', '');
          }
        });
      }
    }
  }

  private applyNetworkStateDotClass(): void {
    const dot = this.dotElement as HTMLElement;
    switch (this._networkState) {
      case 'poor':
        dot.setAttribute('class', 'darkred ball');
        break;
      case 'fair':
        dot.setAttribute('class', 'red ball');
        break;
      case 'good':
        dot.setAttribute('class', 'yellow ball');
        break;
      case 'very_good':
        dot.setAttribute('class', 'yellowgreen ball');
        break;
      case 'excellent':
        dot.setAttribute('class', 'lightgreen ball');
        break;
    }
  }

  private contextmenuDiv(): void {
    if (!this.checkStyle('.menu')) {
      this.appendStyle(panelStyles.CONTEXT_MENU_STYLE);
      this.appendStyle(panelStyles.CONTEXT_MENU_OPTIONS_STYLE);
      this.appendStyle(panelStyles.CONTEXT_MENU_OPTION_STYLE);
      this.appendStyle(panelStyles.CONTEXT_MENU_OPTION_HOVER_STYLE);
      this.appendStyle(panelStyles.CONTEXT_MENU_BUTTON_STYLE);
      this.appendStyle(panelStyles.CONTEXT_MENU_MOVE_KEYFRAMES);
    }

    if (typeof this.contextmenuElement === 'undefined' || this.contextmenuElement === null) {
      this.contextmenuElement = document.createElement('div');
      this.contextmenuElement.setAttribute('class', 'menu');
      this.contextmenuElement.setAttribute('id', 'contextmenu');

      this.menuOptionElement = document.createElement('div');
      this.menuOptionElement.setAttribute('class', 'menu-options');

      for (const label of ['Statistics', 'Network State', 'FullScreen', 'Controls', 'Channel', 'Minimap', 'Show bestshot']) {
        const subMenuOptionElement = document.createElement('div');
        subMenuOptionElement.setAttribute('class', 'menu-option button');
        subMenuOptionElement.innerHTML = label;
        this.menuOptionElement.appendChild(subMenuOptionElement);
      }

      this.contextmenuElement.appendChild(this.menuOptionElement);
      this.ensureRTSPOverWebSocketWrapper().appendChild(this.contextmenuElement);

      const toggleMenu = (command: 'show' | 'hide'): void => {
        (this.contextmenuElement as HTMLElement).style.display = command === 'show' ? 'block' : 'none';
        this.menuVisible = !this.menuVisible;
      };

      const setPosition = ({ top, left }: { top: number; left: number }): void => {
        const el = this.contextmenuElement as HTMLElement;
        el.style.position = 'absolute';
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        el.style.background = 'white';
        toggleMenu('show');
      };

      window.addEventListener('click', () => {
        if (this.menuVisible) toggleMenu('hide');
      });

      this.menuOptionElement.addEventListener('click', (e: Event) => {
        const target = e.target as HTMLElement;
        const label = target.innerHTML.toLowerCase();

        if (label === 'channel') {
          this._channelLabel = !this._channelLabel;
          (this.channelElement as HTMLElement).style.display = this._channelLabel ? 'block' : 'none';
        }

        if (label === 'controls') {
          this._controls = !this._controls;
          if (this.player !== null) {
            this.player.toogleControls(this._controls);
          }
        }

        if (label === 'statistics') {
          this.statistics = !this.statistics;
        }

        if (label === 'network state') {
          this._network = !this._network;
        }

        if (label === 'minimap') {
          this._minimap = !this._minimap;
          this.updateMinimap();
        }

        if (label === 'show bestshot') {
          this._showBestshot = !this._showBestshot;
        }

        if (label === 'fullscreen') {
          this.toggleFullScreen(this);
        }
      });

      if (this._useContextmenu) {
        const videoElement = (this.querySelectorAll('video')[0] || this.querySelectorAll('canvas')[0]) as HTMLElement;
        videoElement.addEventListener('contextmenu', (e: MouseEvent) => {
          e.preventDefault();
          setPosition({ left: e.offsetX, top: e.offsetY });
          return false;
        });
      }
    }

    // legacy: `window.event.returnValue = false;` — relies on the deprecated
    // `window.event` global (only populated by browsers that still support
    // it, e.g. legacy IE / some Chromium versions, and only during a
    // synchronous DOM-Level-0 handler dispatch like `oncontextmenu`). On
    // browsers without it (Firefox), `window.event` is `undefined` and this
    // throws. Reproduced as-is rather than guarded, since the crash itself
    // is part of the legacy behavior on those browsers.
    (window as unknown as { event: { returnValue: boolean } }).event.returnValue = false;
  }

  exitHandler(): void {
    const doc = window.document as unknown as {
      fullScreenElement?: Element | null;
      msFullscreenElement?: Element | null;
      mozFullScreen?: boolean;
      webkitIsFullScreen?: boolean;
    };
    const isFullScreen = !(
      (typeof doc.fullScreenElement !== 'undefined' && doc.fullScreenElement === null) ||
      (typeof doc.msFullscreenElement !== 'undefined' && doc.msFullscreenElement === null) ||
      (typeof doc.mozFullScreen !== 'undefined' && !doc.mozFullScreen) ||
      (typeof doc.webkitIsFullScreen !== 'undefined' && !doc.webkitIsFullScreen)
    );

    if (!isFullScreen) {
      this._fullscreen = false;
      const videoElement = (this.querySelectorAll('video')[0] || this.querySelectorAll('canvas')[0]) as HTMLElement;
      let style = 'min-height: auto; min-width: auto;';
      if (this.video instanceof HTMLVideoElement) {
        style += 'width: 100%;';
      }
      style += 'height: 100%; display: block; margin-left: auto; margin-right: auto;';
      // legacy: `videoElement.style += style;` — `HTMLElement.style` is a
      // read-only CSSStyleDeclaration; `+=` coerces it to a string
      // (`"[object CSSStyleDeclaration]" + style`) and assigns that STRING
      // back to `.style`, which the DOM silently ignores (assigning a
      // non-cssText-parseable string to `.style` is a no-op) — so this line
      // has no actual visual effect. Reproduced via the equivalent no-op
      // cast rather than a real `.style.cssText` write, to match behavior.
      // (legacy also stashes the pre-fullscreen cssText into
      // `_videoElementStyle` in the `else` branch below, but that field has
      // zero read sites anywhere in the legacy source — confirmed dead, dropped.)
      void (videoElement as unknown as { style: unknown }).style;
    } else {
      const videoElement = (this.querySelectorAll('video')[0] || this.querySelectorAll('canvas')[0]) as HTMLElement;
      let style = '';
      if (this.video instanceof HTMLVideoElement) {
        style += 'min-height: 100%; min-width: 100%;';
        style += 'width: 100%;height: 100%;';
      } else {
        style += 'position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);';
        style += 'height: 100%;';
      }
      style += 'margin-left: auto; margin-right: auto;';
      videoElement.style.cssText = style;
    }

    this.dispatch('changefullscreen', { fullscreen: isFullScreen });
  }

  private toggleFullScreen(elem: HTMLElement): void {
    const doc = document as unknown as {
      fullScreenElement?: Element | null;
      msFullscreenElement?: Element | null;
      mozFullScreen?: boolean;
      webkitIsFullScreen?: boolean;
      cancelFullScreen?: () => void;
      mozCancelFullScreen?: () => void;
      webkitCancelFullScreen?: () => void;
      msExitFullscreen?: () => void;
    };
    const el = elem as unknown as {
      requestFullScreen?: () => void;
      mozRequestFullScreen?: () => void;
      webkitRequestFullScreen?: (flag: number) => void;
      msRequestFullscreen?: () => void;
    };

    if (
      (doc.fullScreenElement !== undefined && doc.fullScreenElement === null) ||
      (doc.msFullscreenElement !== undefined && doc.msFullscreenElement === null) ||
      (doc.mozFullScreen !== undefined && !doc.mozFullScreen) ||
      (doc.webkitIsFullScreen !== undefined && !doc.webkitIsFullScreen)
    ) {
      if (el.requestFullScreen) {
        el.requestFullScreen();
      } else if (el.mozRequestFullScreen) {
        el.mozRequestFullScreen();
      } else if (el.webkitRequestFullScreen) {
        el.webkitRequestFullScreen((window as unknown as { Element: { ALLOW_KEYBOARD_INPUT: number } }).Element.ALLOW_KEYBOARD_INPUT);
      } else if (el.msRequestFullscreen) {
        el.msRequestFullscreen();
      }
    } else {
      if (doc.cancelFullScreen) {
        doc.cancelFullScreen();
      } else if (doc.mozCancelFullScreen) {
        doc.mozCancelFullScreen();
      } else if (doc.webkitCancelFullScreen) {
        doc.webkitCancelFullScreen();
      } else if (doc.msExitFullscreen) {
        doc.msExitFullscreen();
      }
    }
  }

  private appendStyle(content: string): void {
    const style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    style.appendChild(document.createTextNode(content));
    document.head.appendChild(style);
  }

  private checkStyle(content: string): boolean {
    const elements = document.querySelectorAll('style');
    for (let i = 0; i < elements.length; i++) {
      if (new RegExp(content).test(elements[i].textContent as string) && (elements[i].textContent as string).indexOf(content) === 0) {
        return true;
      }
    }
    return false;
  }

  private removeStyle(content: string): boolean {
    const elements = document.querySelectorAll('style');
    for (let i = 0; i < elements.length; i++) {
      if (new RegExp(content).test(elements[i].textContent as string) && (elements[i].textContent as string).indexOf(content) === 0) {
        document.head.removeChild(elements[i]);
        return true;
      }
    }
    return false;
  }

  addEventListener(type: string, listener: LegacyListener): void {
    if (listener === undefined || listener === null || type === undefined || type === null) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0413'),
        place: 'RTSPOverWebSocket.ts:257',
        message: 'invalid parameter on addEventListener'
      });
    }

    for (const [, value] of this.listeners) {
      if (value.type === type) {
        return;
      }
    }

    this.listeners.set(listener.bind(this) as LegacyListener, { type, listener });
  }

  removeEventListener(type: string, listener: LegacyListener): void {
    for (const [key, value] of this.listeners) {
      if (value.type !== type || listener !== value.listener) {
        continue;
      }
      this.listeners.delete(key);
    }
  }

  dispatchEvent(event: Event): boolean {
    Object.defineProperty(event, 'target', { value: this });
    const handler = (this as unknown as Record<string, unknown>)['on' + event.type];
    if (typeof handler === 'function') {
      (handler as (e: Event) => void).call(this, event);
    }
    for (const [key, value] of this.listeners) {
      if (value.type !== event.type) {
        continue;
      }
      key(event);
    }
    return true;
  }

  private isPlaySymbol(): boolean {
    if (this.playType !== RTSPOverWebSocketPlayType.BACKUP) {
      if (this.player === undefined || this.player === null) {
        return false;
      }
      return this.player.getCurrentState() === 'Playing';
    } else {
      if (this.backupplayer === undefined || this.backupplayer === null) {
        return false;
      }
      return this.backupplayer.getCurrentState() === 'Playing';
    }
  }

  private getClientIp(): void {
    if (this._sunapiMng !== undefined && this._sunapiMng !== null) {
      const promiseGetClientIp = this._sunapiMng.getClientIp();
      promiseGetClientIp
        .then((ip: unknown) => {
          if (ip) {
            this.info.device.ClientIPAddress = (ip as { ClientIP?: string }).ClientIP;
            this.dispatch('changesunapiclient', { success: true, clientip: this.info.device.ClientIPAddress });
          }
        })
        .catch((error: unknown) => {
          this.dispatch('changesunapiclient', { success: false, message: (error as Error).message });
        });
    }
  }

  // ================= onRTSPOverWebSocket* callback handlers (wired from this.info.callback) =================

  onRTSPOverWebSocketVideoMode(event: RTSPOverWebSocketVideoModeEvent): void {
    const tagid = 'live-' + event.elementId;
    const oldVideoElement = document.getElementById(tagid);
    let classList: string | null = null;

    if (oldVideoElement !== null) {
      const rtspOverWebSocketPlayer = oldVideoElement.parentElement as HTMLElement;
      let width: number | string;
      let height: number | string;

      if (oldVideoElement.tagName.toLowerCase() === 'canvas') {
        width = this.width;
        height = this.height;
      } else {
        width = oldVideoElement.offsetWidth;
        // legacy bug preserved: `oldVideoElement.offsetH` is not a real DOM
        // property (typo for `offsetHeight`) — always `undefined`; kept as
        // a dead read (the computed `height` value is never actually used
        // below, matching legacy where the corresponding `setAttribute`
        // calls are commented out).
        height = (oldVideoElement as unknown as { offsetH?: number }).offsetH as unknown as number;
      }
      const rtspChannelId = oldVideoElement.getAttribute('rtsp-channel-id');
      const mappedId = oldVideoElement.getAttribute('rtsp-channel-mapped-id');
      if (this._playType === RTSPOverWebSocketPlayType.LIVE) {
        classList = oldVideoElement.getAttribute('class');
      }

      oldVideoElement.remove();

      const newVideoElement = document.createElement(event.mode);
      newVideoElement.setAttribute('id', tagid);
      newVideoElement.setAttribute('rtsp-channel-id', rtspChannelId as string);
      newVideoElement.setAttribute('rtsp-channel-mapped-id', mappedId as string);
      let styleText = '';
      // Legacy bug preserved: `event.mode.toLowerCase !== 'canvas'` compares
      // the FUNCTION REFERENCE `toLowerCase` (never called) to the string
      // `'canvas'` — always true — so `width: 100%` is unconditionally
      // appended even when `event.mode === 'canvas'`.
      if ((event.mode.toLowerCase as unknown) !== 'canvas') {
        styleText += 'width: 100%;\r\n';
      }
      styleText += 'height: 100%;\r\ndisplay: block;\r\nmargin-left: auto;\r\nmargin-right: auto\r\n';
      newVideoElement.setAttribute('style', styleText);
      if (this._playType === RTSPOverWebSocketPlayType.LIVE && classList !== null) {
        newVideoElement.setAttribute('class', classList);
      }

      if (this._controls && event.mode === 'video') {
        (newVideoElement as unknown as { controls: boolean }).controls = true;
        newVideoElement.setAttribute('controls', 'controls');
      }

      this.video = newVideoElement as VideoContainerElement;
      rtspOverWebSocketPlayer.appendChild(newVideoElement);
      void width;
      void height;
    }

    this.dispatch('changeplayermode', { mode: event.mode });
  }

  onRTSPOverWebSocketClose(_event: unknown): void {
    // observability only in legacy (a logger call) — no other effect.
  }

  onRTSPPacket(event: unknown): void {
    this.dispatch('rtsp', { message: event });
  }

  onRTSPOverWebSocketError(error: RTSPOverWebSocketErrorEventLike): void {
    if (this._statistics) {
      (this.dataElement as HTMLElement).textContent = JSON.stringify(error);
    }

    switch (toHex(error.errorCode)) {
      case '0x0000': {
        if (error.currentState === 'Play' || error.currentState === 'Playing' || error.currentState === 'Resume') {
          this._readyState = RTSPOverWebSocketPlayState.PLAYING;
          const snapshotElement = document.getElementById('snapshot');
          if (snapshotElement !== null) {
            snapshotElement.classList.add('hidden');
          }
          this._retryFlag = true;
          this.info.device.retry = false;
        } else if (error.currentState === 'Pause') {
          this._readyState = RTSPOverWebSocketPlayState.PAUSED;
          document.querySelectorAll('div[id="loader"').forEach((element) => {
            (element as HTMLElement).style.display = 'none';
            this.removeChild(element);
          });
        }

        this.dispatch('statechange', { error: error.errorCode, readyState: this.readyState, message: error.description });

        if (typeof this.channelLabelElement !== 'undefined' && this.channelLabelElement !== null && this._channel !== null) {
          this.channelLabelElement.innerHTML = 'Ch: ' + (this._channel + 1);
          this.channelElement!.style.display = this._channelLabel ? 'block' : 'none';
        }

        if (typeof error.controlType !== 'undefined' && error.controlType === RtspControlType.SEEK) {
          this._clickCount = 0;
          const timeoutHandle = setTimeout(() => {
            this.rewindElement!.classList.remove('animate-in');
            this.forwardElement!.classList.remove('animate-in');
            clearTimeout(timeoutHandle);
          }, 800);
        }

        // Legacy bug preserved (dead code, bug #11): `this.playType ===
        // RTSPOverWebSocketPlayType.LIVE && this.playType === RTSPOverWebSocketPlayType.PLAYBACK` can
        // never both be true simultaneously — this branch never runs.
        if ((this.playType as unknown) === RTSPOverWebSocketPlayType.LIVE && (this.playType as unknown) === RTSPOverWebSocketPlayType.PLAYBACK && this._minimap) {
          this.updateMinimap();
        }
        break;
      }
      case '0x0001': {
        if (this.networkStateElement !== undefined && this.networkStateElement !== null) {
          this.networkStateElement.removeChild(this.dotElement as Node);
          this.removeChild(this.networkStateElement);
          this.dotElement = null;
          this.networkStateElement = null;
        }
        this._readyState = RTSPOverWebSocketPlayState.STOPPED;

        const snapshotElement = document.getElementById('snapshot');
        if (snapshotElement !== null) {
          snapshotElement.classList.remove('hidden');
        }

        if ((this.playType as unknown) === RTSPOverWebSocketPlayType.LIVE && (this.playType as unknown) === RTSPOverWebSocketPlayType.PLAYBACK && this._minimap) {
          this.updateMinimap();
        }

        document.querySelectorAll('div[id="loader"').forEach((element) => {
          (element as HTMLElement).style.display = 'none';
          this.removeChild(element);
        });

        this.dispatch('statechange', { error: error.errorCode, readyState: this.readyState, message: error.description });
        break;
      }
      case '0x0107': {
        if (this._readyState !== RTSPOverWebSocketPlayState.STOPPED) {
          this.dispatch('waiting', { error: error.errorCode, codec: error.codec, media: error.media, waiting: error.waiting, message: error.description, place: error.place });

          if (this._useLoading && error.media === 'video') {
            if (this.playType !== RTSPOverWebSocketPlayType.INSTANTPLAYBACK && this._readyState !== RTSPOverWebSocketPlayState.PAUSED && error.waiting === true) {
              if (!this.checkStyle('.loader')) {
                this.appendStyle(panelStyles.LOADER_STYLE);
              }
              this.querySelectorAll('video').forEach((element) => {
                (element as HTMLElement).style.background = '';
              });
              const spinnerElement = document.createElement('div');
              spinnerElement.setAttribute('id', 'loader');
              spinnerElement.setAttribute('class', 'loader');
              this.appendChild(spinnerElement);
            } else {
              this.querySelectorAll('video').forEach((element) => {
                (element as HTMLElement).style.background = '';
              });
              document.querySelectorAll('div[id="loader"').forEach((element) => {
                (element as HTMLElement).style.display = 'none';
                this.removeChild(element);
              });
            }
          }
        }
        break;
      }
      case '0x0601':
      case '0x0602':
      case '0x0607':
      case '0x0609': {
        this.onRTSPOverWebSocketBackup(error as unknown as RTSPOverWebSocketBackupEvent);
        break;
      }
      case '0x0005':
      case '0x0006':
      case '0x0008':
      case '0x0100':
      case '0x0203':
      case '0x0205':
      case '0x0209':
      case '0x0210':
      case '0x030A': {
        if (this.playType === RTSPOverWebSocketPlayType.LIVE || this.playType === RTSPOverWebSocketPlayType.PLAYBACK) {
          this.dispatch('error', { error: error.errorCode, message: error.description, place: error.place });

          const tmpCurrentDate = new Date(this._currentTimestamp as string).getTime();
          const tmpEndDate = new Date(this.endTime as string).getTime();
          const tmpScale = Math.abs((this.info.media.requestInfo.scale as number) * 1000);

          if (this.playType === RTSPOverWebSocketPlayType.PLAYBACK && Math.abs(tmpEndDate - tmpCurrentDate) <= tmpScale) {
            this._retryFlag = false;
            this.stop();
          }

          if (this._retryFlag) {
            try {
              this.info.device.retry = true;
              this._withErrorStop = true;
              this.stop();
            } catch (stopError) {
              console.error((stopError as RTSPOverWebSocketError).errorCode);
            }
            this.play();
          } else {
            this.dispatch('statechange', { error: error.errorCode, readyState: this.readyState, message: error.description });
          }
        }
        break;
      }
      case '0x1005': {
        const state = (error as unknown as { state?: string }).state;
        if (state !== undefined && state !== null) {
          this._networkState = state;
          if (this._network) {
            this.networkstateDiv();
          } else if (!this._network && typeof this.networkStateElement !== 'undefined' && this.networkStateElement !== null) {
            this.removeChild(this.networkStateElement);
            this.networkStateElement = null;
            this.removeAttribute('network');
          }
          this.applyStatisticsNetworkState();
        }
        break;
      }
      case '0x090B': {
        this.dispatch('error', { error: error.errorCode, message: error.description, place: error.place, decoderId: error.decoderId, performance: error.performance });
        break;
      }
      default: {
        this.dispatch('error', { error: error.errorCode, message: error.description, place: error.place });
        break;
      }
    }
  }

  onRTSPOverWebSocketStatus(_event: unknown): void {
    // observability only in legacy — no other effect.
  }

  onRTSPOverWebSocketResize(event: RTSPOverWebSocketResizeEvent): void {
    this.dispatch('resize', event as unknown as Record<string, unknown>);

    if (this.resolutionElement !== null && this.resolutionElement !== undefined) {
      this.resolutionElement.textContent = event.width + ' x ' + event.height;
    }

    const videoElement = getElementByAttributeValue(event.tagmode, 'rtsp-channel-mapped-id', event.elementId);

    if (videoElement !== undefined) {
      let styleText = '';
      if (event.tagmode !== 'canvas') {
        styleText += 'width: 100%;\r\n';
      }
      styleText += 'height: 100%;\r\ndisplay: block;\r\nmargin-left: auto;\r\nmargin-right: auto\r\n';
      videoElement.setAttribute('style', styleText);
    }
  }

  onRTSPOverWebSocketMeta(meta: RTSPOverWebSocketMetaEvent): void {
    if (typeof meta.json !== 'undefined' && typeof meta.xml !== 'undefined') {
      this.dispatch('meta', { json: meta.json, xml: meta.xml });
    }
  }

  onRTSPOverWebSocketMetaImage(event: RTSPOverWebSocketMetaImageEvent): void {
    if (this._showBestshot) {
      this.updateMetaImage(event);
    }

    this.dispatch('metaImage', { objectId: event.objectId, width: event.width, height: event.height, imageData: event.imageData });
  }

  onRTSPOverWebSocketTimestamp(time: unknown): void {
    if (typeof time !== 'undefined' && time !== null) {
      let timestamp: { timestamp: number; timestamp_usec: number; timezone?: number; mode?: string };
      const timeAsTimeStamp = time as { timeStamp?: typeof timestamp };
      if (typeof timeAsTimeStamp.timeStamp !== 'undefined' && timeAsTimeStamp.timeStamp !== null) {
        timestamp = timeAsTimeStamp.timeStamp;
      } else {
        timestamp = time as typeof timestamp;
      }

      const curDate = new Date(timestamp.timestamp * 1000 + timestamp.timestamp_usec);
      this._currentTimestamp = curDate.toISOString();

      let localTimestamp: Date | undefined;
      if (typeof this.GMT !== 'undefined' && this.GMT !== null) {
        timestamp.timezone = this.GMT * 60;
        this._localTimestamp = curDate.toISOString();
      }

      if (timestamp.timezone !== null && timestamp.timezone !== undefined) {
        this.timezone_offset = timestamp.timezone / 60;
        localTimestamp = new Date(curDate.valueOf() + this.timezone_offset * 3600 * 1000);
      }

      this.dispatch('timestamp', {
        mode: timestamp.mode,
        clock: timestamp.timestamp * 1000 + timestamp.timestamp_usec,
        timestamp: this._currentTimestamp,
        timezone: timestamp.timezone !== undefined ? timestamp.timezone : this.GMT,
        local: localTimestamp !== undefined ? localTimestamp.toISOString() : localTimestamp,
        speed: this.info.media.requestInfo.scale
      });

      if (this.timestampElement !== null && this.timestampElement !== undefined && this._currentTimestamp !== undefined && this._currentTimestamp !== null) {
        if (typeof this.GMT !== 'undefined' && this.GMT !== null) {
          this.timestampElement.textContent = (localTimestamp as Date).toISOString();
        } else {
          if (this.device === 'camera' && this._playType === RTSPOverWebSocketPlayType.PLAYBACK) {
            this.timestampElement.textContent = new Date(curDate.valueOf() + (this.timezone_offset as number) * 3600 * 1000).toISOString();
          } else {
            const timezone = new Date().getTimezoneOffset();
            this.timestampElement.textContent = new Date(curDate.getTime() - timezone).toISOString();
          }
        }
      }
    } else {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x090C'),
        place: 'RTSPOverWebSocket.ts:onRTSPOverWebSocketTimestamp',
        message: 'invalid timestamp data'
      });
    }
  }

  onRTSPOverWebSocketStatistics(statistics: RTSPOverWebSocketStatisticsEvent): void {
    if (this._statistics) {
      this.setAttribute('statictics', '');
    }

    switch (statistics.type) {
      case 'rtp': {
        let codec: string | undefined;
        if (this.videoCodecElement !== null && this.videoCodecElement !== undefined && statistics.codec !== undefined && statistics.media === 'video') {
          switch (statistics.codec) {
            case 'H264':
              codec = 'H.264';
              break;
            case 'H265':
              codec = 'H.265';
              break;
            case 'JPEG':
              codec = 'MJPEG';
              break;
          }
          this.videoCodecElement.textContent = 'video: ' + codec;
        }

        if (this.audioCodecElement !== null && this.audioCodecElement !== undefined && statistics.codec !== undefined && statistics.media === 'audio') {
          this.audioCodecElement.textContent = 'audio: ' + statistics.codec;
        }

        if (this.videoRtpRecvElement !== null && this.videoRtpRecvElement !== undefined && statistics.fps !== undefined && statistics.media === 'video') {
          this.videoRtpRecvElement.textContent = statistics.fps + ' frame/sec:';
        }

        if (this.videoRtpTotalRecvElement !== null && this.videoRtpTotalRecvElement !== undefined && statistics.receviedPacket !== undefined && statistics.media === 'video') {
          this.videoRtpTotalRecvElement.textContent = 'total: ' + statistics.receviedPacket + ' frame';
        }

        if (this.audioRtpRecvElement !== null && this.audioRtpRecvElement !== undefined && statistics.fps !== undefined && statistics.media === 'audio') {
          this.audioRtpRecvElement.textContent = statistics.fps + ' frame/sec:';
        }

        if (this.audioRtpTotalRecvElement !== null && this.audioRtpTotalRecvElement !== undefined && statistics.receviedPacket !== undefined && statistics.media === 'audio') {
          this.audioRtpTotalRecvElement.textContent = 'total: ' + statistics.receviedPacket + ' frame';
        }

        this.dispatch('statistics', { statistics: statistics as unknown as Record<string, unknown> });
        break;
      }
      case 'fps': {
        if (this.frameElement !== null && this.frameElement !== undefined && statistics.decodedPerSec !== undefined && statistics.decodedFramesMean !== undefined) {
          this.frameElement.textContent = statistics.decodedPerSec + ' fps, average: ' + statistics.decodedFramesMean + ' fps';
        } else if (this.frameElement !== null && this.frameElement !== undefined && statistics.fps !== undefined) {
          this.frameElement.textContent = statistics.fps + ' fps';
        }

        if (this.decodeElement !== null && this.decodeElement !== undefined && statistics.decodedBytesDecodedPerSec !== undefined && statistics.decodedBytesMean !== undefined) {
          this.decodeElement.textContent = 'total: ' + formatBytes(statistics.decodedBytesDecodedPerSec) + ' , average p/s: ' + formatBps(statistics.decodedBytesMean * 8);
        }
        if (statistics.decodedBytesDecodedPerSec !== undefined) {
          this.bitrateHistory.push(statistics.decodedBytesDecodedPerSec * 8);
          if (this.bitrateHistory.length > STATS_HISTORY_LENGTH) this.bitrateHistory.shift();
          this.renderRateGraph();
        }
        if (this.dropElement !== null && this.dropElement !== undefined && statistics.dropFramesCount !== undefined && statistics.dropFramesMean !== undefined) {
          this.dropElement.textContent = 'total: ' + statistics.dropFramesCount + ' frame dropped, average p/s: ' + statistics.dropFramesMean + ' dropped';
        }

        if (this.resolutionElement !== null && this.resolutionElement !== undefined && statistics.width !== undefined && statistics.height !== undefined) {
          this.resolutionElement.textContent = statistics.width + ' x ' + statistics.height;
        }

        if (this.latencyElement !== null && this.latencyElement !== undefined && statistics.latency !== undefined) {
          this.latencyElement.textContent = statistics.latency + ' secs';
          if (typeof statistics.limit !== 'undefined' && statistics.limit !== null) {
            this.latencyElement.textContent += '/ max limit :' + statistics.limit.toFixed(4) + ' secs';
          }
        }
        if (statistics.latency !== undefined) {
          this.bufferHistory.push(statistics.latency * 1000);
          if (this.bufferHistory.length > STATS_HISTORY_LENGTH) this.bufferHistory.shift();
          this.renderBufferChart();
        }

        if (this.chunkSizeElement !== null && this.chunkSizeElement !== undefined && statistics.chunksize !== undefined) {
          this.chunkSizeElement.textContent = 'chunk size: #' + statistics.chunksize;
        }

        if (this.ratioElement) {
          let result: [number, number];
          if (this.video instanceof HTMLVideoElement) {
            result = this.ratio((this.video as unknown as HTMLVideoElement).videoWidth, (this.video as unknown as HTMLVideoElement).videoHeight);
          } else {
            result = this.ratio(Number(this.getAttribute('width')), Number(this.getAttribute('height')));
          }
          this.ratioElement.textContent = '[' + result[0] + ' : ' + result[1] + ']';
        }

        this.dispatch('statistics', { statistics: statistics as unknown as Record<string, unknown> });
        break;
      }
      case 'timestamp': {
        if (this.timestampIntervalElement !== null && this.timestampIntervalElement !== undefined && statistics.timestamp_interval !== undefined && statistics.timestamp_mean !== undefined) {
          this.timestampIntervalElement.textContent = 'inteval: ' + ('0000' + statistics.timestamp_interval).slice(-4) + ' ms, mean:' + statistics.timestamp_mean;
        }
        break;
      }
    }
  }

  onRTSPOverWebSocketStep(step: string): void {
    switch (step) {
      case 'request':
        if (this._deviceType === 'camera') {
          const currentDateTime = new Date(this.currentTimestamp as string);
          const targetDateTime = new Date(currentDateTime.getTime() - 2000);
          this._seekingTime = toYYYYMMDDHHMMSS(targetDateTime);
          this.seeking();
        }
        break;
      case 'complete':
        if (this._deviceType === 'camera') {
          this.pause();
        }
        this.dispatch('statechange', { readyState: RTSPOverWebSocketPlayState.STEP });
        break;
    }
  }

  onRTSPOverWebSocketCapture(capture: RTSPOverWebSocketCaptureEvent): void {
    if (capture !== null && capture !== undefined) {
      this.dispatch('capture', { blob: capture.blob });
    }
  }

  onRTSPOverWebSocketInstantPlayback(instantplayback: RTSPOverWebSocketInstantPlaybackEvent): void {
    if (instantplayback !== null && instantplayback !== undefined) {
      switch (toHex(instantplayback.errorCode)) {
        case '0x1100':
        case '0x1101': {
          this.dispatch('instantplayback', { error: instantplayback.errorCode, state: instantplayback.errorCode, timeline: instantplayback.timeline });
          break;
        }
        case '0x1102':
        case '0x1103':
        case '0x1105':
        case '0x1106': {
          this.dispatch('instantplayback', { error: instantplayback.errorCode, state: instantplayback.errorCode, timeline: instantplayback.currentTime });
          break;
        }
        default: {
          this.dispatch('instantplayback', { error: instantplayback.errorCode, state: instantplayback.errorCode });
          break;
        }
      }
    }
  }

  onRTSPOverWebSocketBackup(backup: RTSPOverWebSocketBackupEvent): void {
    if (backup !== null && backup !== undefined) {
      backup.state = backup.errorCode;
      switch (toHex(backup.errorCode)) {
        case '0x0600': {
          this._readyState = RTSPOverWebSocketPlayState.PLAYING;
          this.dispatch('statechange', { readyState: this.readyState });
          this.dispatch('backupstatechange', backup as unknown as Record<string, unknown>);
          break;
        }
        case '0x0601': {
          if (this._playType === RTSPOverWebSocketPlayType.BACKUP) {
            this.endBackup();
            this._readyState = RTSPOverWebSocketPlayState.STOPPED;
            this.dispatch('statechange', { readyState: this.readyState });
          }
          this.dispatch('backupstatechange', backup as unknown as Record<string, unknown>);
          break;
        }
        case '0x0609':
        case '0x0602': {
          if (this._playType === RTSPOverWebSocketPlayType.BACKUP && this._readyState !== RTSPOverWebSocketPlayState.STOPPED) {
            this.endBackup();
            this._readyState = RTSPOverWebSocketPlayState.STOPPED;
            this.dispatch('statechange', { readyState: this.readyState });
          }
          this.info.media.split = false;
          this.dispatch('backupstatechange', backup as unknown as Record<string, unknown>);
          break;
        }
        case '0x0608': {
          if (this._playType === RTSPOverWebSocketPlayType.BACKUP) {
            this.endBackup();
            this.info.media.split = false;
          }
          this.dispatch('backupstatechange', backup as unknown as Record<string, unknown>);
          break;
        }
        case '0x0603': {
          this.onRTSPOverWebSocketTimestamp(backup.timeStamp);
          break;
        }
        default: {
          this.dispatch('backupstatechange', backup as unknown as Record<string, unknown>);
          break;
        }
      }
    }
  }

  onRTSPOverWebSocketRecv(recv: RTSPOverWebSocketRecvEvent): void {
    if (this.currentRecvElement !== null && this.currentRecvElement !== undefined && recv.current !== undefined) {
      this.currentRecvElement.textContent = 'current: ' + formatBps(recv.current);
    }

    if (this.totalRecvElement !== null && this.totalRecvElement !== undefined && recv.total !== undefined) {
      this.totalRecvElement.textContent = 'total: ' + formatBytes(recv.total / 8);
    }
  }

  // ================= playback control methods =================

  play(): void {
    this.info.media.requestInfo.cmd = 'open';

    if (this.mode === null || this.mode === undefined) {
      this.mode = 'live';
    }

    if (this.playType === RTSPOverWebSocketPlayType.INSTANTPLAYBACK) {
      this.info.media.type = 'instantplayback';
      (this.player as StreamPlayer).control(this.info);
      return;
    }

    if (this.playType === RTSPOverWebSocketPlayType.LIVE) {
      this.info.media.type = 'live';
      this.info.media.requestInfo.scale = 1;
      if (this._deviceType === 'camera') {
        this.info.media.boxsize = 4;
      } else {
        this.info.media.boxsize = 4;
        this.info.media.supportCovertAndOff = true;
      }
    } else {
      this.info.media.type = 'playback';
      if (this.info.media.requestInfo.scale !== this._playSpeed.value) {
        this.info.media.requestInfo.scale = this._playSpeed.value;
      }
      this.info.media.needToImmediate = false;
      this.info.media.boxsize = 1;
      this.info.media.supportCovertAndOff = false;

      if (this.startTime === null || this.startTime === undefined) {
        throw new RTSPOverWebSocketError({
          channelId: this.channel,
          elementId: this.getAttribute('id') ?? undefined,
          errorCode: fromHex('0x0411'),
          place: 'RTSPOverWebSocket.ts:1098',
          message: 'start time is empty'
        });
      }

      if (this._currentTimestamp === null || this._currentTimestamp === undefined) {
        this._currentTimestamp = this.startTime;
      }

      if (this._deviceType === 'camera') {
        // legacy: no-op for camera devices — the camera should not send a
        // rangeClock parameter on RTSP (all real logic here is commented out
        // in the legacy source).
      } else {
        if (typeof this.GMT !== 'undefined' && this.GMT !== null) {
          if (this.startTime !== null || this.endTime !== null || this.overlappedId !== null) {
            const timezone = this.GMT * 3600 * 1000;
            if (typeof this.currentTimestamp !== 'undefined' && this.currentTimestamp !== null) {
              this.info.media.requestInfo.rangeClock = (new Date(new Date(this.currentTimestamp).getTime() - timezone).toISOString().split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
            } else if (typeof this._localTimestamp !== 'undefined' && this._localTimestamp !== null) {
              this.info.media.requestInfo.rangeClock = (new Date(new Date(this._localTimestamp).getTime() - timezone).toISOString().split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
            } else {
              if (!this._coordinatedUniversalTime) {
                this.info.media.requestInfo.rangeClock = new Date(new Date(this.startTime).getTime() - timezone).toISOString().replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
              } else {
                this.info.media.requestInfo.rangeClock = new Date(this.startTime).toISOString().replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
              }
            }
            if (this.endTime !== undefined && this.endTime !== null) {
              if (!this._coordinatedUniversalTime) {
                this.info.media.requestInfo.rangeClock += '-' + new Date(new Date(this.endTime).getTime() - timezone).toISOString().replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
              } else {
                this.info.media.requestInfo.rangeClock += '-' + new Date(this.endTime).toISOString().replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
              }
            } else {
              this.info.media.requestInfo.rangeClock += '-';
            }
          }
        } else {
          if (this._useIso && this._useIso !== null) {
            this.info.media.requestInfo.rangeClock = ((this.currentTimestamp as string).split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
            if (this.endTime !== undefined && this.endTime !== null) {
              this.info.media.requestInfo.rangeClock += '-' + (this.endTime.split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
            } else {
              this.info.media.requestInfo.rangeClock += '-';
            }
          } else {
            this.info.media.requestInfo.rangeClock = (this.currentTimestamp as string).replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
            if (this.endTime !== undefined && this.endTime !== null) {
              this.info.media.requestInfo.rangeClock += '-' + this.endTime.replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
            } else {
              this.info.media.requestInfo.rangeClock += '-';
            }
          }
        }
      }
    }

    this.info.callback.close = (...args: unknown[]) => this.onRTSPOverWebSocketClose(args[0]);
    this.info.callback.error = (event: unknown) => this.onRTSPOverWebSocketError(event as RTSPOverWebSocketErrorEventLike);
    this.info.callback.status = (...args: unknown[]) => this.onRTSPOverWebSocketStatus(args[0]);
    this.info.callback.vmode = (...args: unknown[]) => this.onRTSPOverWebSocketVideoMode(args[0] as RTSPOverWebSocketVideoModeEvent);

    if (this._username === null || this._username === undefined) {
      throw new AuthError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0402'),
        place: 'RTSPOverWebSocket.ts:play',
        message: 'username attribute is empty'
      });
    }

    if ((this._password === null || this._password === undefined) && (this._sunapiMng.getSunapiClient() === null || this._sunapiMng.getSunapiClient() === undefined)) {
      throw new AuthError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0402'),
        place: 'RTSPOverWebSocket.ts:play',
        message: 'password attribute is empty or sunapi client property is null'
      });
    }

    if (this._source === null || this._source === undefined) {
      this.info.media.requestInfo.url = this.generateRTSPURL();
    }

    if (this._proxy !== null && this._proxy !== undefined) {
      this.info.device.proxy = this._proxy;
    }

    if (this._port !== null && this._port !== undefined) {
      this.info.device.port = this._port as unknown as number;
    }

    if (this._secure) {
      this.info.device.protocol = 'https';
      if (this._port === null || this._port === undefined) {
        this.info.device.port = '443' as unknown as number;
      }
    } else {
      this.info.device.protocol = 'http';
      if (this._port === null || this._port === undefined) {
        this.info.device.port = '80' as unknown as number;
      }
    }

    if (typeof this._sunapiMng.getSunapiClient() === 'undefined' || this._sunapiMng.getSunapiClient() === null) {
      console.warn('If you connect to device without the sunapi client, it is not safty. You need to use the sunapi client with reference from the development guide document.');
    }

    if (this.player === undefined || this.player === null) {
      this.player = new StreamPlayer(this.info, this._sunapiMng.getSunapiClient() as unknown as SunapiClientLike | null);
    }

    if (this.player !== undefined && this.player !== null) {
      this.player.controlWorker({ cmd: 'changeVideoMode', data: this.info.media.mode });

      if (this.isplay && this.readyState !== RTSPOverWebSocketPlayState.STOPPED && (this.player.getCurrentState() !== 'Options' || this.player.getCurrentState() !== 'Teardown')) {
        throw new RTSPOverWebSocketError({
          channelId: this.channel,
          elementId: this.getAttribute('id') ?? undefined,
          errorCode: fromHex('0x1004'),
          place: 'RTSPOverWebSocket.ts:play()',
          message: 'This method could not operate on this play state. This rtsp-over-websocket element is not in the stopped state.'
        });
      }

      this.player.control(this.info);
    }
  }

  private generateRTSPURL(): string {
    let playType = '';
    let strStart: string | undefined;
    let strEnd: string | undefined;
    let strRtspURL = '';

    if (this._deviceType === 'camera') {
      if (this.info.media.type !== null && this.info.media.type !== undefined) {
        playType = this.info.media.type === 'live' ? '' : 'recording';
      }

      if (typeof this._channel !== 'undefined' && this._channel !== null && !isNaN(this._channel)) {
        strRtspURL += Number(this._channel) + '/';
      }

      if (this.info.media.type === 'live') {
        if (this._multicast === true) {
          strRtspURL += 'multicast/';
        }

        if (this._profile && this._profile_number) {
          throw new RTSPOverWebSocketError({
            channelId: this.channel,
            elementId: this.getAttribute('id') ?? undefined,
            errorCode: fromHex('0x0406'),
            place: 'RTSPOverWebSocket.ts:1054',
            message: 'profile information is duplicated, you have to use only single attribute from both.'
          });
        }

        if (this._profile !== null && this._profile !== undefined) {
          strRtspURL += this._profile;
        } else if (this._profile_number !== null && this._profile_number !== undefined) {
          strRtspURL += 'profile' + this._profile_number;
        } else {
          throw new RTSPOverWebSocketError({
            channelId: this.channel,
            elementId: this.getAttribute('id') ?? undefined,
            errorCode: fromHex('0x0406'),
            place: 'RTSPOverWebSocket.ts:1054',
            message: 'profile information is empty, you have to check profile attribute or profile_number attribute.'
          });
        }

        if (!this._android) {
          strRtspURL += '/media.smp';
        }
      } else if (this.info.media.type === 'playback') {
        strRtspURL += playType + '/';

        if (this._useIso && this._useIso !== null) {
          // TODO: camera iso time style generate (legacy: unimplemented)
        } else {
          if (this._currentTimestamp !== null && this._currentTimestamp !== undefined) {
            strStart = (this._currentTimestamp.split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').replace(/T/gi, '').replace(/Z/gi, '').slice(0, 16);
          }
          if (this.seekingTime !== null && this.seekingTime !== undefined) {
            if (typeof this.GMT !== 'undefined' && this.GMT !== null) {
              const timezone = this.GMT * 3600 * 1000;
              strStart = (new Date(new Date(this.seekingTime).getTime() + timezone).toISOString().split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').replace(/T/gi, '').replace(/Z/gi, '').slice(0, 16);
            } else {
              strStart = (this.seekingTime.split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').replace(/T/gi, '').replace(/Z/gi, '').slice(0, 16);
            }
          }
          if (this.endTime !== null && this.endTime !== undefined) {
            strEnd = (this.endTime.split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').replace(/T/gi, '').replace(/Z/gi, '').slice(0, 16);
          }
          if (strStart !== undefined) {
            strRtspURL += strStart;
          }
          if (strEnd !== undefined) {
            strRtspURL += '-' + strEnd;
          }
          strRtspURL += '/';
        }
        if (this.overlappedId !== null && this.overlappedId !== undefined) {
          strRtspURL += 'OverlappedID=' + this.overlappedId + '/';
        }

        strRtspURL += 'play.smp';
      } else if (this.info.media.type === 'backup') {
        strRtspURL += playType + '/';

        if (this._useIso && this._useIso !== null) {
          // TODO: camera iso time style generate (legacy: unimplemented)
        } else {
          if (this.startTime !== null && this.startTime !== undefined) {
            strStart = (this.startTime.split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').replace(/T/gi, '').replace(/Z/gi, '').slice(0, 16);
          }
          if (this.seekingTime !== null && this.seekingTime !== undefined) {
            strStart = (this.seekingTime.split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').replace(/T/gi, '').replace(/Z/gi, '').slice(0, 16);
          }
          if (this.endTime !== null && this.endTime !== undefined) {
            strEnd = (this.endTime.split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').replace(/T/gi, '').replace(/Z/gi, '').slice(0, 16);
          }
          if (strStart !== undefined) {
            strRtspURL += strStart;
          }
          if (strEnd !== undefined) {
            strRtspURL += '-' + strEnd;
          }
          strRtspURL += '/';
        }
        if (this.overlappedId !== null && this.overlappedId !== undefined) {
          strRtspURL += 'OverlappedID=' + this.overlappedId + '/';
        }

        strRtspURL += 'backup.smp';
      } else {
        throw new RTSPOverWebSocketError({
          channelId: this.channel,
          elementId: this.getAttribute('id') ?? undefined,
          errorCode: fromHex('0x0906'),
          place: 'RTSPOverWebSocket.ts:632',
          message: 'Invalidate play mode: [' + this.info.media.type + ']'
        });
      }
    } else if (this._deviceType === 'nvr') {
      if (this.info.media.type !== null && this.info.media.type !== undefined) {
        // Legacy bug preserved: the `' live'` case (leading space typo) can
        // never match `this.info.media.type.toLowerCase()`'s real value
        // `'live'` — this switch always falls to `default`.
        switch (this.info.media.type.toLowerCase()) {
          case ' live':
            playType = 'LiveChannel';
            break;
          case 'playback':
            playType = 'PlaybackChannel';
            break;
          case 'backup':
            playType = 'BackupChannel';
            break;
          default:
            playType = 'LiveChannel';
            break;
        }
      }

      strRtspURL = playType + '/';

      if (typeof this._channel !== 'undefined' && this._channel !== null) {
        strRtspURL += this._channel;
        if (!this._android) {
          strRtspURL += '/media.smp';
        }
      } else {
        throw new RTSPOverWebSocketError({
          channelId: this.channel,
          elementId: this.getAttribute('id') ?? undefined,
          errorCode: fromHex('0x0408'),
          place: 'RTSPOverWebSocket.ts:1093',
          message: 'channel attribute is empty for nvr device type'
        });
      }

      if (this._sessionKey) {
        strRtspURL += '/session=' + this._sessionKey;
      } else {
        console.warn('If you do not use session key, you could not play more 10 channel.');
        strRtspURL += '/';
      }

      if (this.info.media.type.toLowerCase() === 'playback' || this.info.media.type.toLowerCase() === 'backup') {
        if (typeof this.GMT !== 'undefined' && this.GMT !== null) {
          if (this.startTime !== null || this.endTime !== null || this.overlappedId !== null) {
            const timezone = this.GMT * 3600 * 1000;
            void timezone;
            if (typeof this.startTime !== 'undefined' && this.startTime !== null) {
              strStart = (new Date(new Date(this.startTime).getTime()).toISOString().split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
            } else {
              throw new RTSPOverWebSocketError({
                channelId: this.channel,
                elementId: this.getAttribute('id') ?? undefined,
                errorCode: fromHex('0x0413'),
                place: 'RTSPOverWebSocket.ts:generateRTSPURL()',
                message: 'The start time is required for the playback function.'
              });
            }
            if (typeof this.endTime !== 'undefined' && this.endTime !== null) {
              strEnd = (new Date(new Date(this.endTime).getTime()).toISOString().split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
            }
          }
        } else {
          if (this.startTime !== null || this.endTime !== null || this.overlappedId !== null) {
            if (this.startTime !== null && this.startTime !== undefined) {
              if (this._useIso && this._useIso !== null) {
                strStart = (this.startTime.split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
              } else {
                strStart = this.startTime.replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
              }
            }
            if (this.endTime !== null && this.endTime !== undefined) {
              if (this._useIso && this._useIso !== null) {
                strEnd = (this.endTime.split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
              } else {
                strEnd = this.endTime.replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
              }
            }
          }
        }
        if (typeof strStart !== 'undefined' && strStart !== null) {
          strRtspURL += this._sessionKey ? '&' : '';
          strRtspURL += 'start=' + strStart;
        }
        if (typeof strEnd !== 'undefined' && strEnd !== null) {
          strRtspURL += '&end=' + strEnd;
        }
        if (this.overlappedId !== null && this.overlappedId !== undefined) {
          strRtspURL += '&overlap=' + this.overlappedId;
        }

        if (typeof this._bestshotFilter !== 'undefined' && this._bestshotFilter !== null) {
          strRtspURL += '&BestshotFilter=' + Object.keys(RTSPOverWebSocketBestshotFilter)[this._bestshotFilter];
          this.bestshot = true;
        } else {
          this.bestshot = false;
        }

        if (typeof this._usesubstream !== 'undefined' && this._usesubstream !== null && this._usesubstream) {
          strRtspURL += '&substream';
        }
      } else {
        if (this._sessionKey !== null && this._sessionKey !== undefined) {
          strRtspURL += '&';
        }
        if (this._profile_number !== null && this._profile_number !== undefined) {
          strRtspURL += 'profile=' + this._profile_number;
        } else if (this._profile !== null && this._profile !== undefined) {
          strRtspURL += 'profile=' + this._profile;
        } else if (typeof this._profileUsage !== 'undefined' && this._profileUsage !== null) {
          strRtspURL += 'ProfileUsage=' + this._profileUsage;
        } else {
          throw new RTSPOverWebSocketError({
            channelId: this.channel,
            elementId: this.getAttribute('id') ?? undefined,
            errorCode: fromHex('0x0406'),
            place: 'RTSPOverWebSocket.ts:1054',
            message: 'profile information is empty.'
          });
        }

        if (typeof this._camChannel !== 'undefined' && this._camChannel !== null) {
          strRtspURL += '&camchannel=' + this._camChannel;
        }
        if (typeof this._codec !== 'undefined' && this._codec !== null) {
          strRtspURL += '&codec=' + this._codec;
        }
        if (typeof this._limitWidth !== 'undefined' && this._limitWidth !== null) {
          strRtspURL += '&limitWidth=' + this._limitWidth;
        }
        if (typeof this._limitHeight !== 'undefined' && this._limitHeight !== null) {
          strRtspURL += '&limitHeight=' + this._limitHeight;
        }
      }

      if (this._iframe) {
        strRtspURL += '&iframe';
      }
    } else {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0404'),
        place: 'RTSPOverWebSocket.ts:1174',
        message: 'device attribute is not define.'
      });
    }

    return strRtspURL;
  }

  stop(): void {
    if (this.player === undefined || this.player === null) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x1000'),
        place: 'RTSPOverWebSocket.ts:897',
        message: 'player object is not exist'
      });
    }

    if (this._source === null || this._source === undefined) {
      this.info.media.requestInfo.url = this.generateRTSPURL();
    }
    this.info.media.requestInfo.cmd = 'close';
    this.info.media.supportCovertAndOff = false;

    if (!this._withErrorStop) {
      this._localTimestamp = null;
      this._retryFlag = false;

      if (this.info.media.type.toLowerCase() === 'playback') {
        this._playSpeed = RTSPOverWebSocketPlaySpeed.speed_1x;
        this.info.media.requestInfo.scale = this._playSpeed.value;
      }
    } else {
      this._withErrorStop = false;
    }

    this.player.control(this.info);
    this._readyState = RTSPOverWebSocketPlayState.STOPPED;
  }

  pause(): void {
    if (typeof this.player === 'undefined' || this.player === null) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x1000'),
        place: 'RTSPOverWebSocket.ts:pause()',
        message: 'player object is not exist'
      });
    }

    if (this._playType === RTSPOverWebSocketPlayType.INSTANTPLAYBACK) {
      this.info.media.requestInfo.cmd = 'pause';
      this.info.media.type = 'instantplayback';
      this.player.control(this.info);
    } else {
      if (this.info.media.type === 'playback') {
        if (this._deviceType === 'camera') {
          // legacy: no-op (all logic commented out for camera devices)
        } else if (this._deviceType === 'nvr') {
          if (typeof this.GMT !== 'undefined' && this.GMT !== null && typeof this._localTimestamp !== 'undefined' && this._localTimestamp !== null) {
            const timezone = this.GMT * 3600 * 1000;
            this.info.media.requestInfo.rangeClock = (new Date(new Date(this._localTimestamp).getTime() - timezone).toISOString().split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
          } else {
            if (this._useIso && this._useIso !== null) {
              this.info.media.requestInfo.rangeClock = ((this.currentTimestamp as string).split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 16);
            } else {
              this.info.media.requestInfo.rangeClock = (this.currentTimestamp as string).replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
            }
          }
        } else {
          throw new RTSPOverWebSocketError({
            channelId: this.channel,
            elementId: this.getAttribute('id') ?? undefined,
            errorCode: fromHex('0x0404'),
            place: 'RTSPOverWebSocket.ts:pause()',
            message: 'device type is undefined'
          });
        }
      }

      if (this._readyState === RTSPOverWebSocketPlayState.PAUSED && this.player.getCurrentState() === 'Pause') {
        throw new RTSPOverWebSocketError({
          channelId: this.channel,
          elementId: this.getAttribute('id') ?? undefined,
          errorCode: fromHex('0x1004'),
          place: 'RTSPOverWebSocket.ts:pause()',
          message: 'This method could not operate on this play state. This rtsp-over-websocket element is not in the paused state.'
        });
      }

      if (this._source === null || this._source === undefined) {
        this.info.media.requestInfo.url = this.generateRTSPURL();
      }

      if (!this._useClockRange) {
        this.info.media.requestInfo.rangeClock = undefined;
      }
      this.info.media.needToImmediate = false;
      this.info.media.requestInfo.cmd = 'pause';

      this.player.control(this.info);
    }
  }

  resume(): void {
    if (typeof this.player === 'undefined' || this.player === null) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x1000'),
        place: 'RTSPOverWebSocket.ts:resume()',
        message: 'player object is not exist'
      });
    }

    if (this._playType === RTSPOverWebSocketPlayType.INSTANTPLAYBACK) {
      this.info.media.requestInfo.cmd = 'terminate';
      this.info.media.type = 'instantplayback';

      this.player.control(this.info);

      this.info.media.type = this._oldPlayType === RTSPOverWebSocketPlayType.PLAYBACK ? 'playback' : 'live';
      this._playType = this._oldPlayType;
    } else {
      if (this._readyState !== RTSPOverWebSocketPlayState.PAUSED && this.player.getCurrentState() !== 'Pause') {
        throw new RTSPOverWebSocketError({
          channelId: this.channel,
          elementId: this.getAttribute('id') ?? undefined,
          errorCode: fromHex('0x1004'),
          place: 'RTSPOverWebSocket.ts:resume()',
          message: 'This method could not operate on this play state. This rtsp-over-websocket element is not in the paused state.'
        });
      }
    }

    if (this.info.media.type.toLowerCase() === 'playback') {
      if (this._deviceType === 'camera') {
        // legacy: no-op (all logic commented out for camera devices)
      } else if (this._deviceType === 'nvr') {
        if (typeof this.GMT !== 'undefined' && this.GMT !== null) {
          const timezone = this.GMT * 3600 * 1000;
          if (typeof this.seekingTime !== 'undefined' && this.seekingTime !== null) {
            this.info.media.requestInfo.rangeClock = (new Date(new Date(this.seekingTime).getTime() - timezone).toISOString().split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
            this._seekingTime = null;
          } else {
            this.info.media.requestInfo.rangeClock = (new Date(new Date(this._localTimestamp as string).getTime() - timezone).toISOString().split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
          }
        } else {
          if (this._useIso && this._useIso !== null) {
            if (this.seekingTime !== null && this.seekingTime !== undefined) {
              this.info.media.requestInfo.rangeClock = (this.seekingTime.split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
              this._seekingTime = null;
            } else {
              this.info.media.requestInfo.rangeClock = ((this.currentTimestamp as string).split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
            }
          } else {
            if (this.seekingTime !== null && this.seekingTime !== undefined) {
              this.info.media.requestInfo.rangeClock = this.seekingTime.replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
              this._seekingTime = null;
            } else {
              this.info.media.requestInfo.rangeClock = (this.currentTimestamp as string).replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
            }
          }
        }
      } else {
        throw new RTSPOverWebSocketError({
          channelId: this.channel,
          elementId: this.getAttribute('id') ?? undefined,
          errorCode: fromHex('0x0404'),
          place: 'RTSPOverWebSocket.ts:resume()',
          message: 'device type is undefined'
        });
      }
    }

    if (this._source === null || this._source === undefined) {
      this.info.media.requestInfo.url = this.generateRTSPURL();
    }

    if (!this._useClockRange) {
      this.info.media.requestInfo.rangeClock = undefined;
    }

    this.info.media.requestInfo.cmd = 'resume';
    this.info.media.needToImmediate = false;
    if (this.info.media.requestInfo.scale !== this._playSpeed.value) {
      this.info.media.requestInfo.scale = this._playSpeed.value;
    }

    this.player.control(this.info);
  }

  /**
   * @deprecated since 2018.11.09 — use the `isplay` property instead. Always
   * throws (legacy behavior preserved exactly).
   */
  isPlay(): never {
    throw new RTSPOverWebSocketError({
      channelId: this.channel,
      elementId: this.getAttribute('id') ?? undefined,
      errorCode: fromHex('0x1006'),
      place: 'RTSPOverWebSocket.ts:isPlay()',
      message: 'This method or property was deprecated no more.You have to use the isplay property'
    });
  }

  /** @deprecated since 2018.11.09 — use the `sessionKey` property instead. */
  setSessionKey(sessionkey: string): void {
    this._sessionKey = sessionkey;
  }

  /** @deprecated since 2018.11.09 — use the `sunapiClient` property instead. */
  setSunapiClient(client: SunapiClientLike): void {
    this.sunapiClient = client;
    if (this.info.device.ClientIPAddress === '127.0.0.1') {
      this.getClientIp();
    }
  }

  unmute(): boolean {
    if (this.player === undefined || this.player === null) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x1000'),
        place: 'RTSPOverWebSocket.ts:unmute',
        message: 'player object is not exist'
      });
    }

    this.info.media.requestInfo.cmd = 'audioIn';
    this.info.media.requestInfo.data = 'unmute';

    try {
      this.player.control(this.info);
    } catch (error) {
      const e = error as RTSPOverWebSocketError;
      throw new RTSPOverWebSocketError({ channelId: this.channel, elementId: this.getAttribute('id') ?? undefined, errorCode: e.errorCode, place: e.place, message: e.message });
    }

    this.dispatch('changemute', { status: this.ismute });
    return !this.ismute;
  }

  mute(): boolean {
    if (this.player === undefined || this.player === null) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x1000'),
        place: 'RTSPOverWebSocket.ts:mute',
        message: 'player object is not exist'
      });
    }

    this.info.media.requestInfo.cmd = 'audioIn';
    this.info.media.requestInfo.data = 'mute';

    try {
      this.player.control(this.info);
    } catch (error) {
      const e = error as RTSPOverWebSocketError;
      throw new RTSPOverWebSocketError({ channelId: this.channel, elementId: this.getAttribute('id') ?? undefined, errorCode: e.errorCode, place: e.place, message: e.message });
    }

    this.dispatch('changemute', { status: this.ismute });
    return this.ismute;
  }

  getAudioVolume(): number {
    if (this.player === undefined || this.player === null) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x1000'),
        place: 'RTSPOverWebSocket.ts:921',
        message: 'player object is not exist'
      });
    }
    return this.player.getAudioVolume();
  }

  setAudioVolume(volume: number): void {
    if (this.player === undefined || this.player === null) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x1000'),
        place: 'RTSPOverWebSocket.ts:setAudioVolume',
        message: 'player object is not exist'
      });
    }

    if (!Number.isInteger(Number(volume))) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0413'),
        place: 'RTSPOverWebSocket.ts:setAudioVolume',
        message: 'invalid input parameter type, check your input parameter type, this value need to a range of value 0 ~ 5'
      });
    }

    if (Number(volume) < 0 || Number(volume) > 5) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0414'),
        place: 'RTSPOverWebSocket.ts:setAudioVolume',
        message: 'invalid input parameter, check your input parameter, this value need to a range of value 0 ~ 5'
      });
    }

    this.info.media.requestInfo.cmd = 'audioIn';
    this.info.media.requestInfo.data = Number(volume);

    this.dispatch('changevolume', { volume });

    this.player.control(this.info);
  }

  isMute(): boolean {
    if (this.player === undefined || this.player === null) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x1000'),
        place: 'RTSPOverWebSocket.ts:921',
        message: 'player object is not exist'
      });
    }

    try {
      return this.player.isMute();
    } catch (error) {
      const e = error as RTSPOverWebSocketError;
      throw new RTSPOverWebSocketError({ channelId: this.channel, elementId: this.getAttribute('id') ?? undefined, errorCode: e.errorCode, place: e.place, message: e.message });
    }
  }

  speed(): void {
    if (this.player === undefined || this.player === null) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x1000'),
        place: 'RTSPOverWebSocket.ts:921',
        message: 'player object is not exist'
      });
    }

    if (this.info.media.type.toLowerCase() === 'playback') {
      if (this._deviceType === 'camera') {
        this.info.media.requestInfo.rangeClock = ((this.currentTimestamp as string).split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').replace(/Z/gi, '').slice(0, 16);
        // Legacy bug preserved (typo): assigns to `.utl` instead of `.url` —
        // `StreamPlayerMediaInfo.requestInfo` has no real `url` update here,
        // so for camera devices `speed()` never actually refreshes the RTSP
        // URL despite computing one.
        (this.info.media.requestInfo as unknown as { utl?: string }).utl = this.generateRTSPURL();
      } else if (this._deviceType === 'nvr') {
        if (typeof this.GMT !== 'undefined' && this.GMT !== null) {
          const timezone = this.GMT * 3600 * 1000;
          if (this._playSpeed.value > 0) {
            this.info.media.requestInfo.rangeClock = (new Date(new Date(this._localTimestamp as string).getTime() - timezone).toISOString().split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
            if (this.endTime !== undefined && this.endTime !== null) {
              if (!this._coordinatedUniversalTime) {
                this.info.media.requestInfo.rangeClock += '-' + (new Date(new Date(this.endTime).getTime() - timezone).toISOString().split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
              } else {
                this.info.media.requestInfo.rangeClock += '-' + (new Date(this.endTime).toISOString().split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
              }
            } else {
              this.info.media.requestInfo.rangeClock += '-';
            }
          } else {
            this.info.media.requestInfo.rangeClock = (new Date(new Date(this._localTimestamp as string).getTime() - timezone).toISOString().split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
            if (this.endTime !== undefined && this.endTime !== null) {
              if (!this._coordinatedUniversalTime) {
                this.info.media.requestInfo.rangeClock += '-' + (new Date(new Date(this.endTime).getTime() - timezone).toISOString().split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
              } else {
                this.info.media.requestInfo.rangeClock += '-' + (new Date(this.endTime).toISOString().split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
              }
            } else {
              this.info.media.requestInfo.rangeClock += '-';
            }
          }
        } else {
          if (this._useIso && this._useIso !== null) {
            this.info.media.requestInfo.rangeClock = ((this.currentTimestamp as string).split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
            if (this.endTime !== undefined && this.endTime !== null) {
              this.info.media.requestInfo.rangeClock += '-' + (this.endTime.split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
            } else {
              this.info.media.requestInfo.rangeClock += '-';
            }
          } else {
            this.info.media.requestInfo.rangeClock = (this.currentTimestamp as string).replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
            if (this.endTime !== undefined && this.endTime !== null) {
              this.info.media.requestInfo.rangeClock += '-' + this.endTime.replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
            } else {
              this.info.media.requestInfo.rangeClock += '-';
            }
          }
        }
      } else {
        throw new RTSPOverWebSocketError({
          channelId: this.channel,
          elementId: this.getAttribute('id') ?? undefined,
          errorCode: fromHex('0x0404'),
          place: 'RTSPOverWebSocket.ts:983',
          message: 'device type is undefined'
        });
      }
    } else {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x1001'),
        place: 'RTSPOverWebSocket.ts:1246',
        message: 'This function support only placyback mode.'
      });
    }

    this.info.media.type = 'playback';
    this.info.media.requestInfo.cmd = this._playSpeed.value < 0 ? 'seek' : 'speed';
    this.info.media.requestInfo.scale = this._playSpeed.value;
    this.info.media.needToImmediate = true;

    this.player.control(this.info);
  }

  forward(): void {
    if (this.player === undefined || this.player === null) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x1000'),
        place: 'RTSPOverWebSocket.ts:921',
        message: 'player object is not exist'
      });
    }

    if (this.info.media.type.toLowerCase() === 'playback') {
      let isoTimeString: string;
      if (this.seekingTime !== null && this.seekingTime !== undefined) {
        const currentDateTime = new Date(this.seekingTime);
        isoTimeString = new Date(currentDateTime.getTime()).toISOString();
        this._seekingTime = null;
      } else {
        let currentDateTime: Date;
        if (typeof this.GMT !== 'undefined' && this.GMT !== null) {
          currentDateTime = new Date(this._localTimestamp as string);
        } else {
          currentDateTime = new Date(this.currentTimestamp as string);
        }
        isoTimeString = new Date(currentDateTime.getTime() + 1000).toISOString();
      }

      if (this._deviceType === 'camera') {
        // legacy: no-op (all logic commented out — camera does not use
        // rangeClock on forward())
      } else if (this._deviceType === 'nvr') {
        if (typeof this.GMT !== 'undefined' && this.GMT !== null) {
          const timezone = this.GMT * 3600 * 1000;
          if (typeof this.seekingTime !== 'undefined' && this.seekingTime !== null) {
            this.info.media.requestInfo.rangeClock = (new Date(new Date(this.seekingTime).getTime() - timezone).toISOString().split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
            this._seekingTime = null;
          } else {
            this.info.media.requestInfo.rangeClock = (new Date(new Date(this._localTimestamp as string).getTime() - timezone + 1000).toISOString().split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
          }
        } else {
          this.info.media.requestInfo.rangeClock = isoTimeString.replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
        }
      } else {
        throw new RTSPOverWebSocketError({
          channelId: this.channel,
          elementId: this.getAttribute('id') ?? undefined,
          errorCode: fromHex('0x0404'),
          place: 'RTSPOverWebSocket.ts:983',
          message: 'device type is undefined'
        });
      }
    } else {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x1001'),
        place: 'RTSPOverWebSocket.ts:forward()',
        message: 'This function support only placyback mode.'
      });
    }

    this.info.media.type = 'playback';
    this.info.media.needToImmediate = true;
    this.info.media.requestInfo.cmd = 'forward';
    this.info.media.requestInfo.scale = 0.0;

    if (this._source === null || this._source === undefined) {
      this.info.media.requestInfo.url = this.generateRTSPURL();
    }

    this.player.control(this.info);
  }

  backward(): void {
    if (this.player === undefined || this.player === null) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x1000'),
        place: 'RTSPOverWebSocket.ts:921',
        message: 'player object is not exist'
      });
    }

    if (this.info.media.type.toLowerCase() === 'playback') {
      let isoTimeString: string;
      if (this.seekingTime !== null && this.seekingTime !== undefined) {
        const currentDateTime = new Date(this.seekingTime);
        isoTimeString = new Date(currentDateTime.getTime()).toISOString();
        this._seekingTime = null;
      } else {
        const currentDateTime = new Date(this.currentTimestamp as string);
        isoTimeString = new Date(currentDateTime.getTime() - 1000).toISOString();
      }

      if (this._deviceType === 'camera') {
        // legacy: no-op (all logic commented out)
      } else if (this._deviceType === 'nvr') {
        if (typeof this.GMT !== 'undefined' && this.GMT !== null) {
          const timezone = this.GMT * 3600 * 1000;
          if (typeof this.seekingTime !== 'undefined' && this.seekingTime !== null) {
            this.info.media.requestInfo.rangeClock = (new Date(new Date(this.seekingTime).getTime() - timezone).toISOString().split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
            this._seekingTime = null;
            if (this.endTime !== undefined && this.endTime !== null) {
              if (!this._coordinatedUniversalTime) {
                this.info.media.requestInfo.rangeClock += '-' + (new Date(new Date(this.endTime).getTime() - timezone).toISOString().split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
              } else {
                this.info.media.requestInfo.rangeClock += '-' + (new Date(this.endTime).toISOString().split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
              }
            } else {
              this.info.media.requestInfo.rangeClock += '-';
            }
          } else {
            this.info.media.requestInfo.rangeClock = (new Date(new Date(this._localTimestamp as string).getTime() - timezone - 1000).toISOString().split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
            if (this.endTime !== undefined && this.endTime !== null) {
              if (!this._coordinatedUniversalTime) {
                this.info.media.requestInfo.rangeClock += '-' + (new Date(new Date(this.endTime).getTime() - timezone).toISOString().split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
              } else {
                this.info.media.requestInfo.rangeClock += '-' + (new Date(this.endTime).toISOString().split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
              }
            } else {
              this.info.media.requestInfo.rangeClock += '-';
            }
          }
        } else {
          this.info.media.requestInfo.rangeClock = isoTimeString.replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
          if (this.endTime !== undefined && this.endTime !== null) {
            this.info.media.requestInfo.rangeClock += '-' + this.endTime.replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
          } else {
            this.info.media.requestInfo.rangeClock += '-';
          }
        }
      } else {
        throw new RTSPOverWebSocketError({
          channelId: this.channel,
          elementId: this.getAttribute('id') ?? undefined,
          errorCode: fromHex('0x0404'),
          place: 'RTSPOverWebSocket.ts:983',
          message: 'device type is undefined'
        });
      }
    } else {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x1001'),
        place: 'RTSPOverWebSocket.ts:forward()',
        message: 'This function support only placyback mode.'
      });
    }

    this.info.media.type = 'playback';
    this.info.media.needToImmediate = true;
    this.info.media.requestInfo.cmd = 'backward';
    this.info.media.requestInfo.scale = 0.0;

    if (this._source === null || this._source === undefined) {
      this.info.media.requestInfo.url = this.generateRTSPURL();
    }

    this.player.control(this.info);
  }

  seeking(): void {
    if (this.player === undefined || this.player === null) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x1000'),
        place: 'RTSPOverWebSocket.ts:seeking()',
        message: 'player object is not exist'
      });
    }

    if (typeof this.seekingTime === 'undefined' || this.seekingTime === null) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0413'),
        place: 'RTSPOverWebSocket.ts:seeking()',
        message: 'Invalid Parameter. The seeking() method needs to the seekingTime property. The seekingTime is initialized after one use.'
      });
    }

    if (this._playType === RTSPOverWebSocketPlayType.INSTANTPLAYBACK) {
      this.info.media.requestInfo.cmd = 'seek';
      this.info.media.type = 'instantplayback';
      this.info.media.requestInfo.rangeClock = this.seekingTime;
      this.player.control(this.info);
      this._seekingTime = null;
      this.info.media.requestInfo.rangeClock = undefined;
    } else {
      if (this.info.media.type.toLowerCase() === 'playback') {
        if (this._deviceType === 'camera') {
          if (this._useIso && this._useIso !== null) {
            this.info.media.requestInfo.rangeClock = this.seekingTime.replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
          }
          // legacy: non-iso camera branch is a no-op (commented out)
        } else if (this._deviceType === 'nvr') {
          if (typeof this.GMT !== 'undefined' && this.GMT !== null) {
            this.info.media.requestInfo.rangeClock = new Date(this.seekingTime).toISOString().replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
          } else {
            this.info.media.requestInfo.rangeClock = this.seekingTime.replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
          }
        } else {
          throw new RTSPOverWebSocketError({
            channelId: this.channel,
            elementId: this.getAttribute('id') ?? undefined,
            errorCode: fromHex('0x0404'),
            place: 'RTSPOverWebSocket.ts:983',
            message: 'device type is undefined'
          });
        }
      } else {
        throw new RTSPOverWebSocketError({
          channelId: this.channel,
          elementId: this.getAttribute('id') ?? undefined,
          errorCode: fromHex('0x1001'),
          place: 'RTSPOverWebSocket.ts:forward()',
          message: 'This function support only placyback mode.'
        });
      }

      this.info.media.type = 'playback';
      this.info.media.needToImmediate = false;
      this.info.media.requestInfo.cmd = 'seek';

      if (this._source === null || this._source === undefined) {
        this.info.media.requestInfo.url = this.generateRTSPURL();
      }

      this._seekingTime = null;
      this.player.control(this.info);
    }
  }

  capture(filename?: string): void {
    if (this.player === undefined || this.player === null) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x1000'),
        place: 'RTSPOverWebSocket.ts:921',
        message: 'player object is not exist'
      });
    }

    if (filename !== undefined) {
      this._filename = filename;
    }

    // legacy: `info.device.channel` (distinct from `channelId`) is a
    // confirmed write-only field — grep across the entire legacy tree finds
    // zero read sites anywhere (only these three write sites in capture/
    // talk/backup); kept as a harmless dead write for observable-shape
    // fidelity rather than silently dropped.
    (this.info.device as unknown as { channel: number }).channel = this.channel;
    this.info.device.captureName = this._filename ?? undefined;
    this.info.media.requestInfo.cmd = 'capture';

    this.player.control(this.info);
    this._filename = null;
  }

  talk(flag: boolean): void {
    if (this.player === undefined || this.player === null) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x1000'),
        place: 'RTSPOverWebSocket.ts:2611',
        message: 'player object is not exist'
      });
    }

    (this.info.device as unknown as { channel: number }).channel = this.channel;
    this.info.media.audioOutStatus = flag;

    this.info.media.requestInfo.cmd = 'audioOut';
    this.info.media.requestInfo.data = flag === true ? 'on' : 'off';

    this.player.control(this.info);
  }

  backup(flag: boolean): void {
    if (this._playType !== RTSPOverWebSocketPlayType.BACKUP && (this.player === undefined || this.player === null)) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x1000'),
        place: 'RTSPOverWebSocket.ts:2691',
        message: 'player object is not exist'
      });
    }

    if (this._playType !== RTSPOverWebSocketPlayType.BACKUP && flag !== false && (this._filename === undefined || this._filename === null)) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x1003'),
        place: 'RTSPOverWebSocket.ts:2701',
        message: 'The file name is not input for capture or backup.'
      });
    }

    if (this._playType === RTSPOverWebSocketPlayType.BACKUP) {
      if (flag === true) {
        this.startBackup();
      } else {
        this.endBackup();
      }
    } else {
      (this.info.device as unknown as { channel: number }).channel = this.channel;
      this.info.media.split = false;
      this.info.device.captureName = this._filename ?? undefined;
      if (typeof this.GMT !== 'undefined' && this.GMT !== null) {
        (this.info.device as unknown as { gmt: number }).gmt = this.GMT;
      }

      this.info.media.requestInfo.cmd = flag ? 'backupstart' : 'backupstop';
      (this.player as StreamPlayer).control(this.info);
    }
    this._filename = null;
  }

  startBackup(): void {
    this.info.media.type = 'backup';
    this.info.media.needToImmediate = false;
    this.info.media.boxsize = 1;
    this.info.media.split = true;
    this.info.device.captureName = this._filename ?? undefined;

    if (this.startTime === null || this.startTime === undefined) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0411'),
        place: 'RTSPOverWebSocket.ts:startBackup',
        message: 'The start time is empty'
      });
    }

    if (this.endTime === null || this.endTime === undefined) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0411'),
        place: 'RTSPOverWebSocket.ts:startBackup',
        message: 'The end time is empty'
      });
    }

    if (this._currentTimestamp === null || this._currentTimestamp === undefined) {
      this._currentTimestamp = this.startTime;
    }

    if (this._deviceType === 'camera') {
      // legacy: no-op (all logic commented out for camera devices)
    } else {
      if (typeof this.GMT !== 'undefined' && this.GMT !== null) {
        const timezone = this.GMT * 3600 * 1000;
        if (!this._coordinatedUniversalTime) {
          this.info.media.requestInfo.rangeClock = (new Date(new Date(this.startTime).getTime() - timezone).toISOString().split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
        } else {
          this.info.media.requestInfo.rangeClock = (new Date(this.startTime).toISOString().split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
        }
        if (this.endTime !== undefined && this.endTime !== null) {
          if (!this._coordinatedUniversalTime) {
            this.info.media.requestInfo.rangeClock += '-' + (new Date(new Date(this.endTime).getTime() - timezone).toISOString().split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
          } else {
            this.info.media.requestInfo.rangeClock += '-' + (new Date(this.endTime).toISOString().split('.')[0] + 'Z').replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
          }
        } else {
          this.info.media.requestInfo.rangeClock += '-';
        }
      } else {
        if (this._useIso && this._useIso !== null) {
          this.info.media.requestInfo.rangeClock = this.startTime.replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
        } else {
          this.info.media.requestInfo.rangeClock = this.startTime.replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
        }
        if (this.endTime !== undefined && this.endTime !== null) {
          this.info.media.requestInfo.rangeClock += '-' + this.endTime.replace(/-/g, '').replace(/:/gi, '').slice(0, 20);
        } else {
          this.info.media.requestInfo.rangeClock += '-';
        }
      }
    }

    this.info.media.requestInfo.cmd = 'backup';

    this.info.callback.close = (...args: unknown[]) => this.onRTSPOverWebSocketClose(args[0]);
    this.info.callback.error = (event: unknown) => this.onRTSPOverWebSocketError(event as RTSPOverWebSocketErrorEventLike);
    this.info.callback.status = (...args: unknown[]) => this.onRTSPOverWebSocketStatus(args[0]);
    this.info.callback.vmode = (...args: unknown[]) => this.onRTSPOverWebSocketVideoMode(args[0] as RTSPOverWebSocketVideoModeEvent);

    if (this._username === null || this._username === undefined) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0402'),
        place: 'RTSPOverWebSocket.ts:632',
        message: 'username attribute is empty'
      });
    }

    if ((this._password === null || this._password === undefined) && (this._sunapiMng.getSunapiClient() === null || this._sunapiMng.getSunapiClient() === undefined)) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x0402'),
        place: 'RTSPOverWebSocket.ts:632',
        message: 'password attribute is empty or sunapi client property is null'
      });
    }

    if (this._source === null || this._source === undefined) {
      this.info.media.requestInfo.url = this.generateRTSPURL();
    }

    if (this._proxy !== null && this._proxy !== undefined) {
      this.info.device.proxy = this._proxy;
    }
    if (this._port !== null && this._port !== undefined) {
      this.info.device.port = this._port as unknown as number;
    }

    if (this._secure) {
      this.info.device.protocol = 'https';
      if (this._port === null || this._port === undefined) {
        this.info.device.port = '443' as unknown as number;
      }
    } else {
      this.info.device.protocol = 'http';
      if (this._port === null || this._port === undefined) {
        this.info.device.port = '80' as unknown as number;
      }
    }

    if (this.backupplayer === undefined || this.backupplayer === null) {
      this.backupplayer = new StreamPlayer(this.info, this._sunapiMng.getSunapiClient() as unknown as SunapiClientLike | null);
    }

    this.backupplayer.control(this.info);
  }

  endBackup(): void {
    if (this.backupplayer === undefined || this.backupplayer === null) {
      throw new RTSPOverWebSocketError({
        channelId: this.channel,
        elementId: this.getAttribute('id') ?? undefined,
        errorCode: fromHex('0x1000'),
        place: 'RTSPOverWebSocket.ts:897',
        message: 'backup player object is not exist'
      });
    }

    if (this._source === null || this._source === undefined) {
      this.info.media.requestInfo.url = this.generateRTSPURL();
    }
    this.info.media.requestInfo.cmd = 'close';

    this.backupplayer.control(this.info);
  }
}

customElements.define('rtsp-over-websocket', RTSPOverWebSocket);

// ---- callback event payload shapes (structural, matching legacy's loosely
// typed callback parameters) ----
interface RTSPOverWebSocketErrorEventLike {
  errorCode: number;
  description?: string;
  currentState?: string;
  controlType?: number;
  state?: string;
  codec?: string;
  media?: string;
  waiting?: boolean;
  place?: string;
  decoderId?: unknown;
  performance?: unknown;
}
interface RTSPOverWebSocketResizeEvent {
  elementId: string;
  tagmode: string;
  width: number;
  height: number;
}
interface RTSPOverWebSocketMetaEvent {
  json?: unknown;
  xml?: unknown;
}
interface RTSPOverWebSocketMetaImageEvent {
  objectId?: unknown;
  width: number;
  height: number;
  imageData?: unknown;
}
interface RTSPOverWebSocketVideoModeEvent {
  elementId: string;
  mode: string;
}
interface RTSPOverWebSocketStatisticsEvent {
  type: 'rtp' | 'fps' | 'timestamp';
  codec?: string;
  media?: string;
  fps?: number;
  receviedPacket?: number;
  decodedPerSec?: number;
  decodedFramesMean?: number;
  decodedBytesDecodedPerSec?: number;
  decodedBytesMean?: number;
  dropFramesCount?: number;
  dropFramesMean?: number;
  width?: number;
  height?: number;
  latency?: number;
  limit?: number;
  chunksize?: number;
  timestamp_interval?: number;
  timestamp_mean?: number;
}
interface RTSPOverWebSocketCaptureEvent {
  blob?: unknown;
}
interface RTSPOverWebSocketInstantPlaybackEvent {
  errorCode: number;
  timeline?: unknown;
  currentTime?: unknown;
}
interface RTSPOverWebSocketBackupEvent {
  errorCode: number;
  description?: string;
  timeStamp?: unknown;
  state?: number;
}
interface RTSPOverWebSocketRecvEvent {
  current?: number;
  total?: number;
}

export type { SunapiClientLike };
