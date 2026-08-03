/**
 * Ambient contracts for the legacyHostInterface layer.
 *
 * `streamInterface.ts`/`streamCanvas.ts` depend on several legacy host-framework
 * services (Attributes, UniversialManagerService, EventNotificationService,
 * DigitalZoomService, CAMERA_STATUS, EventDataParser, `isPhone`) and a
 * `rtspOverWebSocketStreamModule` host-framework module that are **not defined anywhere in this
 * repository**. They must be registered by the outer host application that
 * consumes this library via `<script src>`.
 *
 * Because the real implementations are unavailable, these interfaces are
 * **inferred solely from call-site usage** in the legacy source being
 * ported, not verified against a real implementation — this layer can only
 * be contract-tested against these inferred shapes.
 *
 * `StreamManagerHandle` and `SunapiClientHandle` are likewise stand-ins for
 * services expected to be provided by the host app / a future port; replace
 * these stubs with real imports once those layers land in this repository.
 */

/**
 * Minimal structural shape of the jQuery API surface actually used by
 * streamInterface.ts/streamCanvas.ts. Declared locally instead of pulling in
 * `jquery`/`@types/jquery` as a new dependency — jQuery isn't otherwise part
 * of this build, and the legacy `$` here is always a page-level global
 * supplied by the host app.
 */
export interface JQueryLike {
  readonly length: number;
  [index: number]: HTMLElement;
  css(prop: string): string;
  css(props: Record<string, string | number>): JQueryLike;
  css(prop: string, value: string | number): JQueryLike;
  attr(props: Record<string, string | number>): JQueryLike;
  attr(name: string, value: string | number): JQueryLike;
  attr(name: string): string | undefined;
  addClass(name: string): JQueryLike;
  removeClass(name: string): JQueryLike;
  removeAttr(name: string): JQueryLike;
  hasClass(name: string): boolean;
  find(selector: string): JQueryLike;
  parent(): JQueryLike;
  width(): number | undefined;
  height(): number | undefined;
  append(content: JQueryLike | HTMLElement | string): JQueryLike;
  remove(): JQueryLike;
}

export type JQueryStaticLike = (selector?: string | Element | Document | Window | null | undefined) => JQueryLike;

/**
 * Minimal structural shapes for the legacy host framework's `$rootScope`/`$interval`
 * services this layer injects. Declared locally rather than adding the host
 * framework's own type-definitions package as a new dependency, for the same
 * reason as `JQueryLike` above — only the members actually called in the
 * legacy source are typed.
 */
export interface RootScopeLike {
  $emit(name: string, ...args: unknown[]): void;
  curViewMode?: string;
}

export interface IntervalPromise {
  readonly __intervalPromiseBrand?: never;
}

export interface IntervalServiceLike {
  (fn: () => void, delay: number): IntervalPromise;
  cancel(promise: IntervalPromise): void;
}

/** Shape of the object passed between the legacy host app and rtspOverWebSocketStreamInterface. */
export interface RTSPOverWebSocketPlayerData {
  device: {
    channelId: number | null;
    zipPassword?: string;
    [key: string]: unknown;
  };
  media: {
    element: string;
    type?: string;
    requestInfo: {
      cmd?: string;
      data?: unknown;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
}

export interface ControlWorkerData {
  channelId?: number;
  elementId?: string;
  cmd: string;
  data?: unknown;
}

export interface ControlPlayerInfo {
  device: { channelId: number };
  media: {
    element: string;
    requestInfo: { cmd: string; data?: unknown };
  };
}

/** Stand-in for the legacy StreamManager service — not yet ported to this repository. */
export interface StreamManagerHandle {
  initStreamPlayer(info: RTSPOverWebSocketPlayerData, sunapiClient: SunapiClientHandle): void;
  controlPlayer(info: ControlPlayerInfo): void;
  destroyPlayer(channelId: number, elementId: string): void;
  controlWorker(controlData: ControlWorkerData): void;
  getVideoPlayer(): unknown;
}

export type StreamManagerCtor = new () => StreamManagerHandle;

/** Stand-in for the legacy SunapiClient service — not yet ported to this repository. */
export type SunapiClientHandle = unknown;

/** Inferred from `Attributes.get()` usage — actual shape is much larger. */
export interface AttributesShape {
  thermalColorPaletteOptions?: unknown;
  LensModelOptions?: unknown;
  MaxChannel?: number;
  AudioClipsGain?: unknown;
  SupportChannelExpansionFeature?: boolean;
  MaxAlarmOutput?: number;
  FisheyeLens?: boolean;
  SupportMinimap?: boolean;
  [key: string]: unknown;
}

/** External host-framework service, host-app-defined; not present in this repository. */
export interface AttributesService {
  get(): AttributesShape;
}

export interface ProfileInfo {
  Profile: number;
  Name: string;
  ViewModeIndex: number;
}

/** External host-framework service, host-app-defined; not present in this repository. */
export interface UniversialManagerServiceType {
  calcRatioPositionFromOverlay(offset: { offsetX: number; offsetY: number }): { x: number; y: number } | null | undefined;
  getVideoMode(): string;
  setViewModeType(mode: string): void;
  getStreamingMode(): unknown;
  getViewMode(): number;
  getIsCapturedScreen(): boolean;
  setIsCapturedScreen(value: boolean): void;
  getRotate(): number;
  getProfileInfo(): ProfileInfo | null | undefined;
  getPlayMode(): unknown;
  getFisheyeLens(): boolean;
  getLiveStreamStatus(): boolean;
  setLiveStreamStatus(value: boolean): void;
  getChannelId(): number;
  setVideoMode(mode: string): void;
}

export type UpdateEventStatusCallback = (...args: unknown[]) => void;

/** External host-framework service, host-app-defined; not present in this repository. */
export interface EventNotificationServiceType {
  getBorderSize(): number;
  setBorderElement(element: JQueryLike | Element | null | undefined, currentPage: string | null): void;
  setViewMode(mode: 'default' | 'fullScreen'): void;
  clearObjectDetectionMetaData(): void;
  initEventStatusList(): void;
  updateEventStatus: UpdateEventStatusCallback;
}

/** External host-framework service, host-app-defined; not present in this repository. */
export interface DigitalZoomServiceType {
  init(force?: boolean): void;
}

/** External host-framework constant, host-app-defined; not present in this repository. */
export interface CameraStatusConstant {
  STREAMING_MODE: { PLUGIN_MODE: unknown; [key: string]: unknown };
  PLAY_MODE: { LIVE: unknown; [key: string]: unknown };
}

/**
 * External global, host-app-defined; not present anywhere in this
 * repository. Referenced only as
 * `EventDataParser.parse.bind(null, EventNotificationService.updateEventStatus)`
 * in the legacy source — recorded here as a discovered pre-existing gap,
 * not fixed.
 */
export interface EventDataParserType {
  parse(updateEventStatus: UpdateEventStatusCallback, ...rawArgs: unknown[]): void;
}

export interface MinimapChangeData {
  mode: 'on' | 'off';
  target?: HTMLElement;
  channelId?: number;
  elementId?: string;
  originalSize?: { width: number; height: number };
  targetInfo?: { width: number; height: number };
  interval?: number;
}
