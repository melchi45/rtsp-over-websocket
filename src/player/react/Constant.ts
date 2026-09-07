import { fromHex } from '../util/hex';
import type { RTSPOverWebSocketPlayState } from '../elements/RTSPOverWebSocketTypes';

// Same two RTSP-level 401 error codes src/index.html's "RTSP URL" tab treats
// as the reference implementation for this — see
// docs/player/01-elements-interface-exceptions.md's "401 / credential-retry"
// section. `RTSPOverWebSocket.ts`'s `onRTSPOverWebSocketError()` has no
// special-cased switch branch for either; both fall through to its default
// case, which just dispatches a plain `'error'` CustomEvent with
// `{error, message, place}` — recognizing these two codes and prompting for
// credentials is a consumer-side responsibility. Exported so a consumer's
// `onError` listener doesn't need to hardcode the raw hex itself.
/** No password/sunapiClient on hand to answer a 401 challenge with — the
 * authoritative "credentials needed" signal (`play()` no longer validates
 * username/password up front). Also synthesized by `Player.tsx` itself for a
 * failed *initial* SUNAPI REST login — see `PlayerHandle.retryAuthentication`. */
export const SUNAPI_CREDENTIALS_REQUIRED_ERROR_CODE = fromHex('0x0403');
/** A *second* 401 for the same challenge — the credentials that were
 * supplied are wrong, not missing. */
export const WRONG_CREDENTIALS_ERROR_CODE = fromHex('0x0206');

/**
 * React-wrapper-specific types for Player.tsx. Adapted from
 * react-wisenet-player's `components/ump-player/Constant/Constant.tsx` (only
 * the subset Player.tsx actually needs — that file's device-management UI
 * types (ISearchDevice, DeviceTableProps, deviceTypeOptions, etc.) and
 * statistics-event payload types (unused there — every `onStatistics` body
 * was commented out) aren't ported).
 */
export interface IDevice {
  id: string;
  hostname: string;
  port: number;
  username: string;
  profile: string;
  channel: number;
  device: string;
  password: string;
  autoplay: boolean;
  statistics: boolean;
  https: boolean;
  /** Defaults to `true` when omitted. See Player.tsx's useEffect for what
   * each mode does. */
  useSunapi?: boolean;
}

/** Every `RTSPOverWebSocket.ts` `dispatch(event, data)` call site attaches
 * these two whenever available (`this._channel`/`this.getAttribute('id')`)
 * — see `dispatch()`'s own implementation. */
interface RTSPOverWebSocketEventBase {
  channelId?: number;
  elementId?: string;
}

/** `onRTSPOverWebSocketError()`'s `default` case — every error code with no
 * special-cased switch branch, including the two credential ones
 * (`SUNAPI_CREDENTIALS_REQUIRED_ERROR_CODE`/`WRONG_CREDENTIALS_ERROR_CODE`
 * below) — dispatches exactly this shape. `Player.tsx` also synthesizes one
 * of these (matching `SUNAPI_CREDENTIALS_REQUIRED_ERROR_CODE`) for a failed
 * *initial* SUNAPI REST login, since that failure is functionally identical
 * from a consumer's point of view: no valid credentials on hand yet. */
export interface RTSPOverWebSocketErrorDetail extends RTSPOverWebSocketEventBase {
  error: number;
  message?: string;
  place?: string;
  decoderId?: string;
  performance?: unknown;
}

export interface RTSPOverWebSocketStateChangeDetail extends RTSPOverWebSocketEventBase {
  error?: number;
  readyState: RTSPOverWebSocketPlayState;
  message?: string;
}

export interface RTSPOverWebSocketWaitingDetail extends RTSPOverWebSocketEventBase {
  error?: number;
  codec?: string;
  media?: string;
  waiting?: boolean;
  message?: string;
  place?: string;
  playerClosed?: boolean;
}

export interface RTSPOverWebSocketMetaDetail extends RTSPOverWebSocketEventBase {
  json?: unknown;
  xml?: unknown;
}

export interface RTSPOverWebSocketMetaImageDetail extends RTSPOverWebSocketEventBase {
  objectId?: string;
  width?: number;
  height?: number;
  imageData?: unknown;
}

export interface RTSPOverWebSocketTimestampDetail extends RTSPOverWebSocketEventBase {
  mode?: unknown;
  clock?: number;
  timestamp?: string | null;
  timezone?: number;
  local?: string | null;
  speed?: number;
}

export interface RTSPOverWebSocketStatisticsDetail extends RTSPOverWebSocketEventBase {
  statistics: Record<string, unknown>;
}

export interface RTSPOverWebSocketCaptureDetail extends RTSPOverWebSocketEventBase {
  blob: Blob;
}

export interface RTSPOverWebSocketInstantPlaybackDetail extends RTSPOverWebSocketEventBase {
  error?: number;
  state?: number;
  timeline?: unknown;
}

export type RTSPOverWebSocketBackupStateDetail = RTSPOverWebSocketEventBase & Record<string, unknown>;

export interface RTSPOverWebSocketGeneratedUrlDetail extends RTSPOverWebSocketEventBase {
  url: string;
}

/** The element's own internal `_sunapiMng` succeeding a login triggered via
 * `updateSunapiManager()` — distinct from `changesunapiclient` below, and
 * from `Player.tsx`'s own standalone-`SunapiManager` login flow, which never
 * drives this event (see `PlayerHandle.retryAuthentication`'s doc comment). */
export interface RTSPOverWebSocketSunapiClientDetail extends RTSPOverWebSocketEventBase {
  message: string;
  place: string;
}

export interface RTSPOverWebSocketChangeSunapiClientDetail extends RTSPOverWebSocketEventBase {
  success: boolean;
  clientip?: string;
  message?: string;
}

export interface RTSPOverWebSocketPlayerAvailabilityDetail extends RTSPOverWebSocketEventBase {
  available: boolean;
}

/**
 * One optional callback per event `RTSPOverWebSocket.ts`'s `dispatch()` can
 * fire (see that file's full `this.dispatch(...)` call-site list) — lets a
 * consumer of `<Player>`/`mountReactPlayer()` observe every one of them
 * without reaching into the underlying custom element itself. `Player.tsx`
 * registers exactly one native listener per event and forwards its detail
 * to the matching callback here; it no longer interprets any of them
 * on the consumer's behalf (e.g. deciding when to show a credentials
 * prompt) beyond the minimum needed to keep its own rendering correct
 * (`playState`, used for the `active` CSS class).
 */
export interface RTSPOverWebSocketEventListeners {
  /** `'error'` — includes the `0x0403`/`0x0206` credential codes; see
   * `PlayerHandle.retryAuthentication`'s doc comment for the intended
   * response. */
  onError?: (detail: RTSPOverWebSocketErrorDetail) => void;
  onMeta?: (detail: RTSPOverWebSocketMetaDetail) => void;
  onResize?: (detail: Record<string, unknown>) => void;
  onStateChange?: (detail: RTSPOverWebSocketStateChangeDetail) => void;
  onTimestamp?: (detail: RTSPOverWebSocketTimestampDetail) => void;
  onCapture?: (detail: RTSPOverWebSocketCaptureDetail) => void;
  onStatistics?: (detail: RTSPOverWebSocketStatisticsDetail) => void;
  onBackupStateChange?: (detail: RTSPOverWebSocketBackupStateDetail) => void;
  onPlayerModeChanged?: (detail: RTSPOverWebSocketEventBase & { mode?: unknown }) => void;
  onInstantPlayback?: (detail: RTSPOverWebSocketInstantPlaybackDetail) => void;
  onWaiting?: (detail: RTSPOverWebSocketWaitingDetail) => void;
  onMetaImage?: (detail: RTSPOverWebSocketMetaImageDetail) => void;
  onUsernameChanged?: (detail: RTSPOverWebSocketEventBase & { username: string }) => void;
  onDeviceTypeChanged?: (detail: RTSPOverWebSocketEventBase & { device: string }) => void;
  onProfileNumberChanged?: (detail: RTSPOverWebSocketEventBase & { profile_number: string | null }) => void;
  onProfileNameChanged?: (detail: RTSPOverWebSocketEventBase & { profile: string | null }) => void;
  onChannelNumberChanged?: (detail: RTSPOverWebSocketEventBase & { channel: number | null }) => void;
  onHostnameChanged?: (detail: RTSPOverWebSocketEventBase & { hostname: string | null }) => void;
  onVolumeLevelChanged?: (detail: RTSPOverWebSocketEventBase & { volume: number }) => void;
  onPortNumberChanged?: (detail: RTSPOverWebSocketEventBase & { port: string | null }) => void;
  onFullscreenModeChanged?: (detail: RTSPOverWebSocketEventBase & { fullscreen: boolean }) => void;
  onSunapiClientChanged?: (detail: RTSPOverWebSocketChangeSunapiClientDetail) => void;
  onBestshotFilterChanged?: (detail: RTSPOverWebSocketEventBase & { bestshotfilter: unknown }) => void;
  onBestshot?: (detail: RTSPOverWebSocketEventBase & { bestshot: unknown }) => void;
  onTimezoneChanged?: (detail: RTSPOverWebSocketEventBase & { timezone: number }) => void;
  onClientChanged?: (detail: RTSPOverWebSocketEventBase & { client: string }) => void;
  onMuteChanged?: (detail: RTSPOverWebSocketEventBase & { status: boolean }) => void;
  onPasswordChanged?: (detail: RTSPOverWebSocketEventBase) => void;
  onProtocolChanged?: (detail: RTSPOverWebSocketEventBase & { https: boolean }) => void;
  onSpeedChanged?: (detail: RTSPOverWebSocketEventBase & { speed: number }) => void;
  onSunapiClient?: (detail: RTSPOverWebSocketSunapiClientDetail) => void;
  onGeneratedUrl?: (detail: RTSPOverWebSocketGeneratedUrlDetail) => void;
  onRtspMessage?: (detail: RTSPOverWebSocketEventBase & { message: unknown }) => void;
  onPlayerAvailabilityChanged?: (detail: RTSPOverWebSocketPlayerAvailabilityDetail) => void;
}

export interface PlayerProps {
  device: IDevice;
  /** See `RTSPOverWebSocketEventListeners`'s own doc comment. All optional —
   * omit whichever events a given consumer doesn't care about. */
  listeners?: RTSPOverWebSocketEventListeners;
}

/**
 * Imperative escape hatch exposed via `forwardRef`/`useImperativeHandle` (and,
 * for non-React consumers, `mountReactPlayer()`'s return value) — for actions
 * a consumer triggers on demand rather than reacts to.
 */
export interface PlayerHandle {
  /**
   * Answers a `0x0403` ("no credentials to answer the 401 challenge with")
   * or `0x0206` ("credentials rejected") `onError` event with a new
   * username/password — the intended caller flow: listen for one of those
   * two codes via `listeners.onError`, collect credentials from the user
   * however the consumer sees fit (a modal, a form, a `prompt()`, ...), then
   * call this.
   *
   * Routes through whichever connection mode this `<Player>` is actually
   * using (mirrors `src/index.html`'s "RTSP URL" tab's own
   * `attemptSunapiConnect()`/`retryAuthentication()` split):
   * - `useSunapi` in effect: redoes the standalone SUNAPI REST login
   *   (`SunapiManager.init()`) with the new credentials, then re-attaches
   *   `sunapiClient`/`password` and calls `play()` — same path the initial
   *   mount-time connect attempt itself goes through, so "SUNAPI login" and
   *   "credential retry" are one code path, not two.
   * - otherwise: calls the underlying element's own `retryAuthentication()`,
   *   which re-answers the *same* still-open connection's cached challenge
   *   with no reconnect (`RtspClient.ts`'s `retryWithCredentials()`).
   */
  retryAuthentication: (username: string, password: string) => void;
}
