import { RTSPOverWebSocketError } from '../../exceptions/RTSPOverWebSocketError';
import { SunapiError } from '../../exceptions/SunapiError';
import { SunapiException } from './SunapiException';
import { fromHex } from '../../util/hex';
import { SunapiClient, type SunapiClientDeviceInfo, type SunapiClientError } from './SunapiClient';
import { HTTP_STATUS_CODES } from './HttpStatusCode';

/**
 * Ported from the legacy player’s Network/http/sunapiManager — a thin
 * promise-wrapping facade over `SunapiClient` exposing one method per SUNAPI
 * endpoint (device info, video profiles, recording search, etc).
 *
 * `log.debug(...)` calls are not reproduced (observability only). The
 * `useSunapiClient` legacy flag is a hardcoded `true` never reassigned
 * anywhere in the source file (confirmed via grep) — the `sunapiRestClient`
 * branch it guards is unreachable dead code and is dropped; `init()` always
 * constructs a `SunapiClient`.
 *
 * NOTE — fixed, was a confirmed real bug: `SunapiClient` (sunapiClient) has
 * no `join()` method (its prototype is only get/post/setTimeout/getAuthInfo).
 * Legacy's `getSessionKey`/`getStorageInfo`/`getRecordingSetup`/
 * `getSearchRecordingPeriod`/`getCalendarSearch`/`getOverlappedIdList`/
 * `getTimeline`/`getAITimeline` all called `sunapiClient.join()` right after
 * `sunapiClient.get(...)` inside their own try/catch — since `useSunapiClient`
 * is always true, `_sunapiClient` is always a `SunapiClient`, so this call
 * always threw synchronously, was caught, and re-thrown as a
 * `RTSPOverWebSocketError` (0x0700) — which, because it happened inside the
 * `new Promise(executor)` callback, always rejected the returned promise
 * immediately, regardless of whether the underlying GET itself would have
 * succeeded. Initially ported faithfully (these eight methods were
 * functionally broken in the legacy library too), then actually fixed here
 * — by removing the `join()` call and its `joinAfterGet` option entirely —
 * once a real consumer hit it against a real device: `getOverlappedIdList`
 * doing exactly what it should (device responds with valid
 * `OverlappedIDList` JSON) but still surfacing as a failure to the caller,
 * because the promise had already rejected before the GET's own
 * resolve/reject callbacks ever had a chance to fire.
 */

export interface SunapiManagerDeviceInfo extends SunapiClientDeviceInfo {
  ClientIPAddress?: string;
  captureName?: string;
  deviceType?: string;
  timeout?: number;
  async?: boolean;
}

export interface SunapiManagerError extends SunapiClientError {
  uri?: string;
  place?: string;
}

interface SunapiClientLike {
  get(
    uri: string,
    jsonData: unknown,
    successFn: (response: unknown) => void,
    failFn: (error: SunapiManagerError) => void,
    scope: unknown,
    isAsyncCall?: boolean,
    isText?: boolean,
    withoutSeqId?: boolean
  ): void;
  post?(...args: unknown[]): void;
  setTimeout(timeout: number): void;
  getAuthInfo(): unknown;
}

const URI = {
  URI_PROFILE: '/stw-cgi/media.cgi?msubmenu=videoprofile',
  URI_PROFILE_POLICY: '/stw-cgi/media.cgi?msubmenu=videoprofilepolicy',
  URI_STREAM_URI: '/stw-cgi/media.cgi?msubmenu=streamuri',
  URI_SESSION_KEY: '/stw-cgi/media.cgi?msubmenu=sessionkey',
  URI_STORAGE_INFO: '/stw-cgi/recording.cgi?msubmenu=storage',
  URI_RECORDING_SETUP: '/stw-cgi/recording.cgi?msubmenu=general',
  URI_SEARCH_RECORDING_PERIOD: '/stw-cgi/recording.cgi?msubmenu=general'
} as const;
void URI; // ported verbatim for completeness — confirmed unused anywhere in sunapiManager itself

const CGI = {
  ATTRIBUTES: 'attributes.cgi',
  SYSTEM_CGI: 'system.cgi',
  MEDIA_CGI: 'media.cgi',
  RECORDING_CGI: 'recording.cgi',
  VIDEO_CGI: 'video.cgi',
  AI_CGI: 'ai.cgi',
  EVENT_RULES_CGI: 'eventrules.cgi'
} as const;

const SUBMENU = {
  DEVICE_INFO: 'deviceinfo',
  DATE: 'date',
  PROFILE_ACCESS_INFO: 'profileaccessinfo',
  VIDEO_SOURCE: 'videosource',
  VIDEO_PROFILE: 'videoprofile',
  VIDEO_PROFILE_POLICY: 'videoprofilepolicy',
  VIDEO_STREAM_URI: 'streamuri',
  VIDEO_SESSION_KEY: 'sessionkey',
  RECORDING_STORAGE_INFO: 'storageinfo',
  RECORDING_SETUP: 'general',
  RECORDING_SEARCH_PERIOD: 'searchrecordingperiod',
  RECORDING_CALENDAR_SEARCH: 'calendarsearch',
  RECORDING_OVERLAPPED: 'overlapped',
  RECORDING_TIMELINE: 'timeline',
  RECORDING_AI_TIMELINE: 'aitimeline',
  SNAPSHOT: 'snapshot',
  GET_CLIENT_IP: 'getclientip',
  DYNAMIC_RULES_OPTIONS: 'dynamicrulesoptions',
  DYNAMIC_RULES: 'dynamicrules'
} as const;

const ACTION = { VIEW: 'view', SET: 'set', ADD: 'add', UPDATE: 'update', REMOVE: 'remove', CONTROL: 'control', MONITORDIFF: 'monitordiff', CHECK: 'check' } as const;
void ACTION.SET;
void ACTION.ADD;
void ACTION.UPDATE;
void ACTION.REMOVE;
void ACTION.CONTROL;
void ACTION.MONITORDIFF;
void ACTION.CHECK; // only ACTION.VIEW is ever used in sunapiManager — the rest ported for completeness of the const table

const PARAMS = { CHANNEL_ID_LIST: 'ChannelIDList', OVERLAPPED_ID: 'OverlappedID' } as const;

const LONG_POLLING_TIMEOUT = 15000;

function unwrapResponse(response: unknown): Record<string, unknown> {
  let result: unknown = typeof response === 'string' ? JSON.parse(response) : response;
  const asRecord = result as { data?: unknown };
  if (asRecord.data !== undefined) {
    result = asRecord.data;
  }
  return result as Record<string, unknown>;
}

/**
 * `getVideoProfile`/`getVideoProfileAll`/`getVideoProfilePolicy`/
 * `getVideoProfilePolicyAll` expect a flat array of
 * `{ Channel, Profile, ...fields }` (the `VideoProfiles`/
 * `VideoProfilePolicies` key on a modern JSON response). Some devices/
 * firmware instead return the legacy `Channel.<n>.<Group>.<m>.<Field>=<value>`
 * line format for these endpoints regardless of the `Accept: application/json`
 * request header — SunapiClient.parseResponse() already parses that into a
 * nested `{ Channel: { "<n>": { <Group>: { "<m>": { Field: value, ... } } } } }`
 * object rather than throwing (`<Group>` is `Profile` for the plain video-profile
 * endpoints — not verified for the *Policy variants, which may use a
 * different group name, so it's read from whatever single key each
 * `Channel.<n>` entry actually has rather than assumed), so this flattens
 * *that* shape into the same flat-array shape the modern response would
 * have had, instead of requiring every caller to handle both.
 */
function flattenChannelGroupedFields(data: Record<string, unknown>, wrapperKey: string): unknown {
  const wrapped = data[wrapperKey];
  if (wrapped !== undefined) {
    return wrapped;
  }
  const channels = data.Channel as Record<string, Record<string, Record<string, Record<string, unknown>>>> | undefined;
  if (typeof channels !== 'object' || channels === null) {
    return undefined;
  }
  const flattened: Array<Record<string, unknown>> = [];
  for (const channelKey of Object.keys(channels)) {
    const channelEntry = channels[channelKey];
    if (typeof channelEntry !== 'object' || channelEntry === null) continue;
    // Whatever single key groups the per-index entries under this channel
    // (e.g. "Profile") — not assumed by name, since it may differ between
    // the plain video-profile and *Policy variants of this response shape.
    for (const groupKey of Object.keys(channelEntry)) {
      const group = channelEntry[groupKey];
      if (typeof group !== 'object' || group === null) continue;
      for (const indexKey of Object.keys(group)) {
        flattened.push({ Channel: Number(channelKey), Profile: Number(indexKey), ...group[indexKey] });
      }
    }
  }
  return flattened;
}

export class SunapiManager {
  private _sunapiClient: SunapiClientLike | null = null;
  private device: SunapiManagerDeviceInfo = {
    ClientIPAddress: '127.0.0.1',
    cameraIp: '',
    captureName: '',
    username: '',
    password: '',
    port: 80,
    protocol: (typeof window !== 'undefined' ? window.location.protocol : 'http:').split(':')[0],
    hostname: '',
    deviceType: 'nvr',
    timeout: 10,
    debug: true,
    async: false
  };

  get sunapiClient(): SunapiClientLike | null {
    return this._sunapiClient;
  }
  set sunapiClient(v: SunapiClientLike | null) {
    this._sunapiClient = v;
  }

  getSunapiClient(): SunapiClientLike | null {
    return this._sunapiClient;
  }

  attach(v: SunapiClientLike): void {
    this._sunapiClient = v;
  }

  dettach(): void {
    this._sunapiClient = null;
  }

  init(info: SunapiManagerDeviceInfo): Promise<unknown> {
    this.device = info;

    // Only sync device.protocol to the host page's own protocol when that
    // page protocol is actually 'http'/'https' — matching the device's own
    // origin to the page's is meaningful for a normal browser tab (avoids
    // mixed-content issues), but window.location.protocol can be something
    // else entirely for non-http(s) hosts (e.g. 'chrome-extension:' for a
    // Chrome extension page), which is never a valid protocol to reach a
    // SUNAPI device on and must not overwrite an explicit device.protocol.
    const splitProt = window.location.protocol.split(':');
    if ((splitProt[0] === 'http' || splitProt[0] === 'https') && this.device.protocol !== splitProt[0]) {
      this.device.protocol = splitProt[0];
    }

    if (info.deviceType !== 'nvr') {
      info.hostname = info.cameraIp;
      info.username = info.user;
    }

    if (info.port !== window.location.port) {
      this.device.port = info.port;
    }

    // NOTE: legacy quirk preserved — this unconditionally clears
    // `_sunapiClient` right before the `if (!this._sunapiClient)` check below,
    // which makes that check's `else` branch (a `SunapiError` for
    // "already initialized") permanently unreachable. Dropped here since it
    // can never fire; only the always-taken branch is kept.
    this._sunapiClient = null;
    this._sunapiClient = new SunapiClient(this.device as SunapiClientDeviceInfo);

    const sunapiClient = this._sunapiClient;
    return new Promise((resolve, reject) => {
      sunapiClient.get(
        '/stw-cgi/attributes.cgi',
        '',
        (response) => resolve(unwrapResponse(response)),
        (error) =>
          reject(
            new SunapiError({
              errorCode: Number(error.Code),
              place: 'SunapiManager.ts:init',
              message: HTTP_STATUS_CODES[String(error.Code)]
            })
          ),
        '',
        this.device.async ? true : false,
        false,
        true
      );
    });
  }

  getAttributes(): Promise<unknown> {
    return this.request(() => `/stw-cgi/${CGI.ATTRIBUTES}/attributes`, 'getAttributes', { includeUriPlaceInCatch: true });
  }

  getDeviceInfo(): Promise<unknown> {
    return this.request(() => `/stw-cgi/${CGI.SYSTEM_CGI}?msubmenu=${SUBMENU.DEVICE_INFO}&action=${ACTION.VIEW}`, 'getDeviceInfo');
  }

  getClientIp(): Promise<unknown> {
    return this.request(() => `/stw-cgi/${CGI.SYSTEM_CGI}?msubmenu=${SUBMENU.GET_CLIENT_IP}&action=${ACTION.VIEW}`, 'getClientIp');
  }

  getTimezoneInfo(): Promise<unknown> {
    return this.request(() => `/stw-cgi/${CGI.SYSTEM_CGI}?msubmenu=${SUBMENU.DATE}&action=${ACTION.VIEW}&TimeZoneList`, 'getTimezoneInfo');
  }

  getDateInfo(): Promise<unknown> {
    return this.request(() => `/stw-cgi/${CGI.SYSTEM_CGI}?msubmenu=${SUBMENU.DATE}&action=${ACTION.VIEW}`, 'getDateInfo');
  }

  getSnapshot(profile?: number | string, channel?: number | string): Promise<unknown> {
    const sunapiClient = this._sunapiClient!;
    return new Promise((resolve, reject) => {
      // NOTE: matching legacy exactly, all URI-building/validation below runs
      // *inside* the executor — a throw here rejects the promise rather than
      // propagating synchronously to the caller (see `request()`'s doc comment).
      let sunapiURI = `/stw-cgi/${CGI.VIDEO_CGI}?msubmenu=${SUBMENU.SNAPSHOT}&action=${ACTION.VIEW}`;
      if (profile !== null && profile !== undefined) {
        if (Number.isInteger(Number(profile))) {
          sunapiURI += '&Profile=' + profile;
        } else {
          throw new RTSPOverWebSocketError({ errorCode: fromHex('0x0409'), message: 'Invalid profile number' });
        }
      }
      if (channel !== null && channel !== undefined) {
        if (Number.isInteger(Number(channel))) {
          sunapiURI += '&Channel=' + channel;
        } else {
          // NOTE: legacy copy-paste bug preserved — the message says "Invalid
          // profile number" here too, even though this branch validates `channel`.
          throw new RTSPOverWebSocketError({ errorCode: fromHex('0x0409'), message: 'Invalid profile number' });
        }
      } else {
        sunapiURI += '&Channel=0';
      }

      try {
        sunapiClient.get(
          sunapiURI,
          {},
          (response) => {
            const raw = typeof response === 'string' ? (JSON.parse(response) as { data?: { size?: number } }) : (response as { data?: { size?: number } });
            // NOTE: legacy bug preserved — if this guard is false, the promise
            // is never resolved *or* rejected here (it just silently hangs,
            // unless the caller-visible timeout/error path fires separately).
            if (raw.data !== undefined && raw.data.size !== 0) {
              resolve(raw);
            }
          },
          (errorData) => {
            errorData.uri = sunapiURI;
            errorData.place = 'sunapiManager.js:getSnapshot';
            reject(errorData);
          },
          '',
          true
        );
      } catch (error) {
        throw new RTSPOverWebSocketError({ errorCode: fromHex('0x0700'), message: (error as Error).message });
      }
    });
  }

  /** `viewgroup` is ported verbatim but — like legacy — never actually used: the source references an undeclared `channel` instead (a parameter-name typo bug), so the Channel query param is never appended. */
  getSystemProfileAccessInfo(viewgroup?: string): Promise<unknown> {
    void viewgroup;
    return this.request(
      () => `/stw-cgi/${CGI.SYSTEM_CGI}?msubmenu=${SUBMENU.PROFILE_ACCESS_INFO}&action=${ACTION.VIEW}`,
      'getSystemProfileAccessInfo',
      { extract: (data) => (data as { Profile?: unknown }).Profile }
    );
  }

  getVideoSource(): Promise<unknown> {
    return this.request(() => `/stw-cgi/${CGI.MEDIA_CGI}?msubmenu=${SUBMENU.VIDEO_SOURCE}&action=${ACTION.VIEW}`, 'getVideoSource', {
      extract: (data) => (data as { VideoSources?: unknown }).VideoSources
    });
  }

  getVideoProfileAll(): Promise<unknown> {
    return this.request(() => `/stw-cgi/${CGI.MEDIA_CGI}?msubmenu=${SUBMENU.VIDEO_PROFILE}&action=${ACTION.VIEW}`, 'getVideoProfileAll', {
      extract: (data) => flattenChannelGroupedFields(data, 'VideoProfiles')
    });
  }

  getVideoProfile(channel?: number | string): Promise<unknown> {
    return this.request(
      () => {
        let sunapiURI = `/stw-cgi/${CGI.MEDIA_CGI}?msubmenu=${SUBMENU.VIDEO_PROFILE}&action=${ACTION.VIEW}`;
        if (typeof channel !== 'undefined') {
          sunapiURI += '&Channel=' + channel;
        }
        return sunapiURI;
      },
      'getVideoProfile',
      { extract: (data) => flattenChannelGroupedFields(data, 'VideoProfiles') }
    );
  }

  getVideoProfilePolicyAll(): Promise<unknown> {
    return this.request(() => `/stw-cgi/${CGI.MEDIA_CGI}?msubmenu=${SUBMENU.VIDEO_PROFILE_POLICY}&action=${ACTION.VIEW}`, 'getVideoProfilePolicyAll', {
      extract: (data) => flattenChannelGroupedFields(data, 'VideoProfilePolicies')
    });
  }

  getVideoProfilePolicy(channel?: number | string): Promise<unknown> {
    return this.request(
      () => {
        let sunapiURI = `/stw-cgi/${CGI.MEDIA_CGI}?msubmenu=${SUBMENU.VIDEO_PROFILE_POLICY}&action=${ACTION.VIEW}`;
        if (typeof channel !== 'undefined') {
          sunapiURI += '&Channel=' + channel;
        }
        return sunapiURI;
      },
      'getVideoProfilePolicy',
      { extract: (data) => flattenChannelGroupedFields(data, 'VideoProfilePolicies') }
    );
  }

  getRtspStreamURL(channel?: number | string, profile?: number | string, mediaType?: string, mode?: string): Promise<unknown> {
    return this.request(() => {
      let sunapiURI = `/stw-cgi/${CGI.MEDIA_CGI}?msubmenu=${SUBMENU.VIDEO_STREAM_URI}&action=${ACTION.VIEW}`;
      if (typeof channel !== 'undefined') sunapiURI += '&Channel=' + channel;
      if (typeof profile !== 'undefined') sunapiURI += '&Profile=' + profile;
      if (typeof mode !== 'undefined') sunapiURI += '&Mode=' + mode;
      if (typeof mediaType !== 'undefined') sunapiURI += '&MediaType=' + mediaType;
      sunapiURI += '&StreamType=RTPUnicast&TransportProtocol=TCP&RTSPOverHTTP=False&ClientType=PC';
      return sunapiURI;
    }, 'getRtspStreamURL');
  }

  getSessionKey(): Promise<unknown> {
    return this.request(() => `/stw-cgi/${CGI.MEDIA_CGI}?msubmenu=${SUBMENU.VIDEO_SESSION_KEY}&action=${ACTION.VIEW}`, 'getSessionKey');
  }

  /**
   * Fetches what event rules a device is *capable of* (`/stw-cgi/
   * eventrules.cgi?msubmenu=dynamicrulesoptions`) — per channel, every
   * event source (motion/AI/alarm-input/etc detection), its available
   * rule slots, and which action types it supports. Contrast with
   * `getDynamicRules()` below, which returns the rules actually
   * *configured*. `language` is optional: SUNAPI defaults to the
   * device's own configured language when omitted, so it's only appended
   * when the caller actually wants a specific one (e.g. `'English'`),
   * matching every other optional query param in this class (see
   * `getVideoProfile`'s `channel`, `getTimeline`'s `overlappedId`).
   */
  getDynamicRulesOptions(language?: string): Promise<unknown> {
    return this.request(
      () => {
        let sunapiURI = `/stw-cgi/${CGI.EVENT_RULES_CGI}?msubmenu=${SUBMENU.DYNAMIC_RULES_OPTIONS}&action=${ACTION.VIEW}`;
        if (typeof language !== 'undefined') {
          sunapiURI += '&Language=' + language;
        }
        return sunapiURI;
      },
      'getDynamicRulesOptions',
      { extract: (data) => (data as { DynamicRulesOptions?: unknown }).DynamicRulesOptions }
    );
  }

  /**
   * Fetches the event rules actually *configured* on the device
   * (`/stw-cgi/eventrules.cgi?msubmenu=dynamicrules`) — each rule's name,
   * schedule, enabled/available state, triggering event source(s), and
   * resulting action(s) (record, alarm output, etc). Contrast with
   * `getDynamicRulesOptions()` above, which returns what the device
   * merely *supports*. `language` is optional, same as
   * `getDynamicRulesOptions()`.
   */
  getDynamicRules(language?: string): Promise<unknown> {
    return this.request(
      () => {
        let sunapiURI = `/stw-cgi/${CGI.EVENT_RULES_CGI}?msubmenu=${SUBMENU.DYNAMIC_RULES}&action=${ACTION.VIEW}`;
        if (typeof language !== 'undefined') {
          sunapiURI += '&Language=' + language;
        }
        return sunapiURI;
      },
      'getDynamicRules',
      { extract: (data) => (data as { Rules?: unknown }).Rules }
    );
  }

  getStorageInfo(): Promise<unknown> {
    return this.request(() => `/stw-cgi/${CGI.SYSTEM_CGI}?msubmenu=${SUBMENU.RECORDING_STORAGE_INFO}&action=${ACTION.VIEW}`, 'getStorageInfo');
  }

  getRecordingSetup(): Promise<unknown> {
    return this.request(() => `/stw-cgi/${CGI.RECORDING_CGI}?msubmenu=${SUBMENU.RECORDING_SETUP}&action=${ACTION.VIEW}`, 'getRecordingSetup');
  }

  getSearchRecordingPeriod(): Promise<unknown> {
    return this.request(
      () => `/stw-cgi/${CGI.RECORDING_CGI}?msubmenu=${SUBMENU.RECORDING_SEARCH_PERIOD}&action=${ACTION.VIEW}`,
      'getSearchRecordingPeriod'
    );
  }

  getCalendarSearch(month?: string, channelIdList?: string): Promise<unknown> {
    return this.request(
      () => {
        let sunapiURI = `/stw-cgi/${CGI.RECORDING_CGI}?msubmenu=${SUBMENU.RECORDING_CALENDAR_SEARCH}&action=${ACTION.VIEW}`;
        if (typeof month !== 'undefined') {
          const strArray = month.split('-');
          sunapiURI += '&Month=' + strArray[0] + '-' + strArray[1];
        }
        if (typeof channelIdList !== 'undefined') {
          sunapiURI += '&' + PARAMS.CHANNEL_ID_LIST + '=' + channelIdList;
        } else {
          this._sunapiClient?.setTimeout(LONG_POLLING_TIMEOUT);
        }
        return sunapiURI;
      },
      'getCalendarSearch'
    );
  }

  getOverlappedIdList(fromDate?: string, toDate?: string, channelIdList?: string): Promise<unknown> {
    return this.request(
      () => {
        let sunapiURI = `/stw-cgi/${CGI.RECORDING_CGI}?msubmenu=${SUBMENU.RECORDING_OVERLAPPED}&action=${ACTION.VIEW}`;
        if (typeof fromDate !== 'undefined' && typeof toDate !== 'undefined') {
          sunapiURI += '&FromDate=' + fromDate;
          sunapiURI += '&ToDate=' + toDate;
        } else {
          throw new SunapiException();
        }
        if (typeof channelIdList !== 'undefined') {
          sunapiURI += '&' + PARAMS.CHANNEL_ID_LIST + '=' + channelIdList;
        }
        return sunapiURI;
      },
      'getOverlappedIdList'
    );
  }

  getTimeline(fromDate: string, toDate: string, channelIdList?: string, overlappedId?: string, type?: string): Promise<unknown> {
    return this.request(
      () => this.buildTimelineUri(`/stw-cgi/${CGI.RECORDING_CGI}?msubmenu=${SUBMENU.RECORDING_TIMELINE}&action=${ACTION.VIEW}`, fromDate, toDate, channelIdList, overlappedId, type, 'Type', 'All'),
      'getTimeline'
    );
  }

  getAITimeline(fromDate: string, toDate: string, channelIdList?: string, overlappedId?: string, type?: string): Promise<unknown> {
    return this.request(
      () => this.buildTimelineUri(`/stw-cgi/${CGI.AI_CGI}?msubmenu=${SUBMENU.RECORDING_AI_TIMELINE}&action=${ACTION.VIEW}`, fromDate, toDate, channelIdList, overlappedId, type, 'ClassType', 'Person'),
      'getTimeline'
    );
  }

  private buildTimelineUri(
    sunapiURI: string,
    fromDate: string,
    toDate: string,
    channelIdList: string | undefined,
    overlappedId: string | undefined,
    type: string | undefined,
    typeParamName: string,
    defaultType: string
  ): string {
    let uri = sunapiURI;
    let from = fromDate;
    let to = toDate;
    if (this.device.deviceType === 'camera') {
      from = from.replace(/T/gi, ' ').replace(/Z/g, '');
      to = to.replace(/T/gi, ' ').replace(/Z/g, '');
    }

    if (from !== undefined) {
      uri += '&FromDate=' + from;
    } else {
      throw new SunapiException();
    }
    if (to !== undefined) {
      uri += '&ToDate=' + to;
    } else {
      throw new SunapiException();
    }
    if (channelIdList !== undefined) {
      uri += '&' + PARAMS.CHANNEL_ID_LIST + '=' + channelIdList;
    }
    if (typeof overlappedId !== 'undefined') {
      uri += '&' + PARAMS.OVERLAPPED_ID + '=' + overlappedId;
    }
    uri += typeof type !== 'undefined' ? `&${typeParamName}=${type}` : `&${typeParamName}=${defaultType}`;
    return uri;
  }

  /**
   * `buildUri` runs *inside* the Promise executor, not before it — matching
   * legacy, where URI construction (and any parameter-validation throw
   * within it, e.g. getOverlappedIdList/getTimeline's SunapiException) lives
   * directly inside `new Promise(function (resolve, reject) {...})`. A throw
   * there doesn't propagate to the caller: the Promise constructor's own
   * implicit try/catch converts it into a rejected promise. Moving URI
   * construction outside the executor (as an earlier draft of this port did)
   * would incorrectly turn that into a synchronous throw instead.
   */
  private request<T = unknown>(
    buildUri: () => string,
    place: string,
    opts: { extract?: (data: Record<string, unknown>) => T; includeUriPlaceInCatch?: boolean } = {}
  ): Promise<T> {
    const sunapiClient = this._sunapiClient!;
    return new Promise<T>((resolve, reject) => {
      const sunapiURI = buildUri();
      try {
        sunapiClient.get(
          sunapiURI,
          {},
          (response) => {
            const data = unwrapResponse(response);
            resolve(opts.extract ? opts.extract(data) : (data as unknown as T));
          },
          (errorData) => {
            errorData.uri = sunapiURI;
            errorData.place = 'sunapiManager.js:' + place;
            reject(errorData);
          },
          '',
          this.device.async ? true : false
        );
      } catch (error) {
        // NOTE: legacy also sets a `uri` field on this RTSPOverWebSocketError's options in
        // getAttributes's catch block specifically — but RTSPOverWebSocketBaseError's
        // constructor never reads or stores an `options.uri`, so it's a
        // no-op dropped here rather than carried as dead state.
        throw new RTSPOverWebSocketError(
          opts.includeUriPlaceInCatch
            ? { errorCode: fromHex('0x0700'), place: 'SunapiManager.ts:' + place, message: (error as Error).message }
            : { errorCode: fromHex('0x0700'), message: (error as Error).message }
        );
      }
    });
  }
}
