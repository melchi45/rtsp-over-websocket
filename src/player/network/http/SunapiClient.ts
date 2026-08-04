import CryptoJS from 'crypto-js';
import { RTSPOverWebSocketError } from '../../exceptions/RTSPOverWebSocketError';
import { AuthError } from '../../exceptions/AuthError';
import { fromHex } from '../../util/hex';
import { HTTP_STATUS_CODES } from './HttpStatusCode';

/**
 * Ported from the legacy player’s Network/http/sunapiClient — digest-auth REST
 * client used for SUNAPI (camera/NVR HTTP control) requests.
 *
 * `log(...)` calls are not reproduced (observability only, gated behind a
 * `debug` flag in legacy — same judgment as elsewhere in this migration).
 *
 * NOT ported, confirmed unreachable: legacy's `Constructor.prototype` only
 * exposes `get`/`post`/`setTimeout`/`getAuthInfo` — the internal `sunapiClient`
 * object additionally defines `mobile(...)` (~280 lines of duplicated Safari/
 * Chrome XHR branching) and `clearDigestCache()`, but neither is ever attached
 * to `Constructor.prototype`, so neither is reachable from `new SunapiClient(...)`
 * (confirmed via grep — no caller anywhere in the legacy player reaches them either).
 * `DetectBrowser()` and `checkStaleResponseIssue()` are likewise defined but
 * never called (the one call site is commented out). `Timeout` (Default/Long/
 * Short) and `RESTCLIENT_CONFIG.authType` are write-only — set but never read
 * by any reachable code path — so they are dropped rather than carried as dead
 * state, except `setTimeout()` itself, which stays as a real (if inert) public
 * method for API parity with the one still-reachable prototype method.
 */

export type SunapiAuthType = 0 | 1 | 2 | 3;
export const SunapiAuthTypeEnum = {
  None: 0,
  Basic: 1,
  Digest: 2,
  OAuth: 3
} as const satisfies Record<string, SunapiAuthType>;

export interface SunapiClientDeviceInfo {
  debug?: boolean;
  hostname?: string;
  cameraIp?: string;
  username?: string;
  user?: string;
  password?: string;
  authType?: SunapiAuthType;
  proxy?: boolean;
  serverType?: string;
  protocol?: string;
  port?: number | string;
  cors?: boolean;
  ClientIPAddress?: string;
}

interface SunapiDigestConfig {
  hostname?: string;
  port?: number | string;
  protocol?: string;
  rtspPort: number;
  ClientIPAddress?: string;
  username?: string;
  password?: string;
  timeout?: number;
}

interface SunapiRestClientConfig {
  clientVersion: string;
  serverType: string;
  cors: boolean;
  proxy: boolean;
  basic: { username?: string; password?: string };
  digest: SunapiDigestConfig;
  oauth: { username?: string };
}

interface DigestCache {
  scheme: string;
  realm: string | null;
  nonce: string | null;
  opaque: string | null;
  qop: string | null;
  nc: number | null;
  cnonce: string | null;
}

export type SunapiClientResult = { data: unknown };
export type SunapiClientError = { Code: number | string; message: unknown };
export type SunapiClientSuccessFn = (result: SunapiClientResult) => void;
export type SunapiClientFailFn = (error: SunapiClientError) => void;
export interface SunapiSpecialHeader {
  Type: string;
  Header: string;
}
export interface SunapiClientCallbackList {
  ProgressEvent?: (...args: unknown[]) => void;
  CompleteEvent?: (...args: unknown[]) => void;
  CancelEvent?: (...args: unknown[]) => void;
  FailEvent?: (...args: unknown[]) => void;
}

export interface XhrLike {
  status: number;
  readyState: number;
  response: unknown;
  responseType: string;
  responseXML: unknown;
  readonly UNSENT: number;
  readonly OPENED: number;
  readonly HEADERS_RECEIVED: number;
  readonly LOADING: number;
  readonly DONE: number;
  onreadystatechange: (() => void) | null;
  ontimeout: (() => void) | null;
  onerror: (() => void) | null;
  timeout: number;
  withCredentials: boolean;
  upload: { addEventListener(type: string, listener: (...args: unknown[]) => void, useCapture?: boolean): void };
  open(method: string, url: string, async?: boolean): void;
  setRequestHeader(name: string, value: string): void;
  getResponseHeader(name: string): string | null;
  addEventListener(type: string, listener: (...args: unknown[]) => void, useCapture?: boolean): void;
  send(body?: unknown): void;
}

export type XhrFactory = () => XhrLike;

const XHR_READY_STATE = { UNSENT: 0, OPENED: 1, HEADERS_RECEIVED: 2, LOADING: 3, DONE: 4 } as const;

export class SunapiClient {
  private readonly xhrFactory: XhrFactory;
  private readonly restClientConfig: SunapiRestClientConfig = {
    clientVersion: '1.00_20160404',
    serverType: 'camera',
    cors: true,
    proxy: false,
    basic: {},
    digest: {
      hostname: '',
      port: 80,
      protocol: 'http',
      rtspPort: 554,
      ClientIPAddress: '127.0.0.1',
      username: '',
      password: ''
    },
    oauth: {}
  };

  private authInfo: DigestCache | null | undefined = null;
  private authCount = 0;

  constructor(deviceInfo: SunapiClientDeviceInfo, xhrFactory: XhrFactory = () => new XMLHttpRequest() as unknown as XhrLike) {
    this.xhrFactory = xhrFactory;

    // if host name is exist and camera ip is not exist, set to camera ip
    if (
      typeof deviceInfo.hostname !== 'undefined' &&
      deviceInfo.hostname !== '' &&
      deviceInfo.hostname !== null &&
      (typeof deviceInfo.cameraIp === 'undefined' || deviceInfo.cameraIp === null || deviceInfo.cameraIp === '')
    ) {
      deviceInfo.cameraIp = deviceInfo.hostname;
    }

    // if username is exist on input parameter, we will use username instead user
    if (
      typeof deviceInfo.username !== 'undefined' &&
      deviceInfo.username !== null &&
      deviceInfo.username !== '' &&
      (typeof deviceInfo.user === 'undefined' || deviceInfo.user === null || deviceInfo.user === '')
    ) {
      deviceInfo.user = deviceInfo.username;
      this.restClientConfig.digest.username = deviceInfo.username;
      this.restClientConfig.basic.username = deviceInfo.username;
    }

    if (
      this.restClientConfig.serverType === 'camera' &&
      (deviceInfo.cameraIp === undefined || deviceInfo.cameraIp === '' || deviceInfo.cameraIp === null)
    ) {
      throw new RTSPOverWebSocketError({
        errorCode: fromHex('0x0400'),
        place: 'SunapiClient.ts:60',
        message: 'cameraIP is empty from input parameter.'
      });
    } else if ((this.restClientConfig.serverType as string | undefined) === undefined || this.restClientConfig.serverType === null) {
      throw new RTSPOverWebSocketError({
        errorCode: fromHex('0x0404'),
        place: 'SunapiClient.ts:67',
        message: 'device type is undefined.'
      });
    }

    if (
      this.restClientConfig.serverType === 'camera' &&
      (deviceInfo.user === undefined || deviceInfo.user === '' || deviceInfo.user === null)
    ) {
      throw new RTSPOverWebSocketError({
        errorCode: fromHex('0x0402'),
        place: 'SunapiClient.ts:78',
        message: 'user id is empty from input parameter.'
      });
    }

    this.restClientConfig.proxy = deviceInfo.proxy === true;
    this.restClientConfig.serverType = deviceInfo.serverType === 'grunt' ? 'grunt' : 'camera';

    if (this.restClientConfig.serverType === 'grunt') {
      if (this.restClientConfig.proxy) {
        this.restClientConfig.digest.hostname = window.location.hostname;
        this.restClientConfig.digest.port = window.location.port;
      } else {
        this.restClientConfig.digest.hostname = deviceInfo.hostname;
        this.restClientConfig.digest.port = deviceInfo.port;
      }
      this.restClientConfig.digest.protocol = deviceInfo.protocol;
    } else {
      this.restClientConfig.digest.hostname = window.location.hostname;
      this.restClientConfig.digest.port = window.location.port;
      this.restClientConfig.digest.protocol = window.location.protocol;
    }

    if (typeof deviceInfo.user !== 'undefined' && deviceInfo.user !== null && deviceInfo.user !== '') {
      this.restClientConfig.digest.username = deviceInfo.user;
      this.restClientConfig.basic.username = deviceInfo.user;
      this.restClientConfig.oauth.username = deviceInfo.user;
    } else {
      throw new AuthError({
        errorCode: fromHex('0x0402'),
        place: 'SunapiClient.ts:Constructor',
        message: 'user id is empty from input parameter.'
      });
    }

    if (typeof deviceInfo.password !== 'undefined' && deviceInfo.password !== null && deviceInfo.password !== '') {
      this.restClientConfig.basic.password = deviceInfo.password;
      this.restClientConfig.digest.password = deviceInfo.password;
    } else {
      throw new AuthError({
        errorCode: fromHex('0x0403'),
        place: 'SunapiClient.ts:Constructor',
        message: 'password is empty from input parameter.'
      });
    }

    this.restClientConfig.digest.ClientIPAddress = deviceInfo.ClientIPAddress;
    if (typeof deviceInfo.cors !== 'undefined') {
      this.restClientConfig.cors = deviceInfo.cors;
    }
  }

  private isJSON(str: unknown): boolean {
    try {
      return Boolean(JSON.parse(str as string)) && Boolean(str);
    } catch {
      return false;
    }
  }

  /** Ported from sunapiClient.js's getDotEqualStrLineToObj — parses NVR's `a.b.c=value` line-based responses. */
  private getDotEqualStrLineToObj(data: string): Record<string, unknown> {
    const res: Record<string, unknown> = {};
    const getOrInit = (obj: Record<string, unknown>, key: string): Record<string, unknown> => {
      if (!obj[key]) {
        obj[key] = {};
      }
      return obj[key] as Record<string, unknown>;
    };
    const strRes = data.split('\r\n');
    for (let i = 0; i < strRes.length; i++) {
      if (!strRes[i]) continue;
      const strKeyArr = strRes[i].split('=');
      const strDotArr = strKeyArr[0].split('.');
      if (strDotArr.length === 1) {
        res[strDotArr[0]] = strKeyArr[1];
      } else {
        let tmRes = getOrInit(res, strDotArr[0]);
        for (let j = 1; j < strDotArr.length - 1; j++) {
          tmRes = getOrInit(tmRes, strDotArr[j]);
        }
        tmRes[strDotArr[strDotArr.length - 1]] = strKeyArr[1];
      }
    }
    return res;
  }

  private parseResponse(xhr: XhrLike, successFn: SunapiClientSuccessFn, failFn: SunapiClientFailFn, isText?: boolean): void {
    if (xhr.responseType === 'blob' || xhr.responseType === 'arraybuffer' || xhr.responseXML !== null || isText) {
      successFn({ data: xhr.response });
      return;
    }

    const resp = this.isJSON(xhr.response) === false ? this.getDotEqualStrLineToObj(xhr.response as string) : JSON.parse(xhr.response as string);

    if (typeof resp === 'object' && resp !== null) {
      const data = resp as { Response?: string; Error?: { Code: number | string; Details: unknown } };
      if (data.Response === 'Fail') {
        failFn({ Code: data.Error!.Code, message: data.Error!.Details });
      } else {
        successFn({ data: resp });
      }
    } else {
      successFn({ data: xhr.response });
    }
  }

  private handleAccountBlock(failFn: SunapiClientFailFn, xhr: XhrLike): void {
    failFn({ Code: xhr.status, message: HTTP_STATUS_CODES[String(xhr.status)] });
  }

  private setupAsyncCall(
    xhr: XhrLike,
    method: string,
    callbackList: SunapiClientCallbackList | null | undefined,
    uri: string,
    failFn: SunapiClientFailFn
  ): XhrLike {
    const onErrorEvent = () => failFn({ Code: -2, message: 'Network Error' });

    if (typeof callbackList !== 'undefined' && callbackList !== null && (callbackList as unknown) !== '') {
      if (typeof callbackList.ProgressEvent !== 'undefined') {
        xhr.upload.addEventListener('progress', callbackList.ProgressEvent, false);
      }
      if (typeof callbackList.CompleteEvent !== 'undefined') {
        xhr.addEventListener('load', callbackList.CompleteEvent, false);
      }
      if (typeof callbackList.CancelEvent !== 'undefined') {
        xhr.addEventListener('abort', callbackList.CancelEvent, false);
      }
      if (typeof callbackList.FailEvent !== 'undefined') {
        xhr.addEventListener('error', callbackList.FailEvent, false);
      } else {
        xhr.addEventListener('error', onErrorEvent, false);
      }
    }

    xhr.timeout = method === 'POST' ? 300000 : 5000;

    if (uri.indexOf('snapshot') !== -1) {
      xhr.responseType = 'blob';
    }
    if (uri.indexOf('configbackup') !== -1) {
      xhr.responseType = 'arraybuffer';
    }
    if (uri.indexOf('opensdk') !== -1) {
      xhr.withCredentials = true;
    }

    return xhr;
  }

  private generateCnonce(): string {
    const characters = 'abcdef0123456789';
    let token = '';
    for (let i = 0; i < 16; i++) {
      const randNum = Math.round(Math.random() * characters.length);
      token += characters.substr(randNum, 1);
    }
    return token;
  }

  private formulateResponse(
    username: string | undefined,
    password: string | undefined,
    uri: string,
    realm: string | null,
    method: string,
    nonce: string | null,
    nc: number | null,
    cnonce: string | null,
    qop: string | null
  ): string {
    const HA1 = CryptoJS.MD5(`${username}:${realm}:${password}`).toString();
    const HA2 = CryptoJS.MD5(`${method}:${uri}`).toString();
    return CryptoJS.MD5(`${HA1}:${nonce}:${this.decimalToHex(nc, 8)}:${cnonce}:${qop}:${HA2}`).toString();
  }

  private getAuthInfoInWwwAuthenticate(wwwAuthenticate: string | null): DigestCache | undefined {
    if (wwwAuthenticate === null) {
      return undefined;
    }

    let realm: string | null = null;
    let nonce: string | null = null;
    let opaque: string | null = null;
    let qop: string | null = null;
    let nc: number | null = null;

    const digestHeaders = wwwAuthenticate.split(',');
    const scheme = digestHeaders[0].split(/\s/)[0];

    for (let i = 0; i < digestHeaders.length; i++) {
      const keyVal = digestHeaders[i].split('=');
      const key = keyVal[0];
      const val = keyVal[1].replace(/"/g, '').trim();

      if (key.match(/realm/i) !== null) {
        realm = val;
      }
      if (key.match(/nonce/i) !== null) {
        nonce = val;
      }
      if (key.match(/opaque/i) !== null) {
        opaque = val;
      }
      if (key.match(/qop/i) !== null) {
        qop = val;
      }
    }

    const cnonce = this.generateCnonce();
    // NOTE: legacy bug preserved — `nc` is never parsed out of the header
    // (only realm/nonce/opaque/qop are), so `nc++` always runs against its
    // `null` initializer here and resolves to `1` every time (Number(null)
    // is 0, then incremented), regardless of the server's actual nc value.
    (nc as unknown as number)!++;

    return { scheme, realm, nonce, opaque, qop, cnonce, nc };
  }

  /** Ported from sunapiClient.js's local `decimalToHex` — kept separate from util/hex.ts's shared one since the two have diverging default-padding semantics in legacy and this is what setDigestHeader/formulateResponse actually call. */
  private decimalToHex(d: number | null, padding: number | undefined): string {
    let hex = Number(d).toString(16);
    const effectivePadding = typeof padding === 'undefined' || padding === null ? 2 : padding;
    while (hex.length < effectivePadding) {
      hex = '0' + hex;
    }
    return hex;
  }

  private jsonToText(json: Record<string, unknown>): string {
    let uri = '';
    for (const key in json) {
      if (typeof json[key] === 'boolean') {
        uri += '&' + key + '=' + (json[key] === true ? 'True' : 'False');
      } else {
        uri += '&' + key + '=' + json[key];
      }
    }
    return uri;
  }

  /** Shared string-builder for the identical header format both `digest`/`xdigest`-scheme requests and the freshly-initialized (no prior cache) request use — pure formatting, no behavior of its own. */
  private buildDigestAuthHeader(cache: DigestCache, uri: string, method: string): string {
    const config = this.restClientConfig.digest;
    const responseValue = this.formulateResponse(
      config.username,
      config.password,
      uri,
      cache.realm,
      method.toUpperCase(),
      cache.nonce,
      cache.nc,
      cache.cnonce,
      cache.qop
    );
    return (
      cache.scheme +
      ' ' +
      'username="' +
      config.username +
      '", ' +
      'realm="' +
      cache.realm +
      '", ' +
      'nonce="' +
      cache.nonce +
      '", ' +
      'uri="' +
      uri +
      '", ' +
      'cnonce="' +
      cache.cnonce +
      '" ' +
      'nc=' +
      this.decimalToHex(cache.nc, 8) +
      ', ' +
      'qop=' +
      cache.qop +
      ', ' +
      'response="' +
      responseValue +
      '"'
    );
  }

  private setDigestHeader(xhr: XhrLike, method: string, uri: string, digestCache: DigestCache | null | undefined): XhrLike {
    const config = this.restClientConfig.digest;

    if (digestCache) {
      const scheme = digestCache.scheme.toLowerCase();
      if (scheme === 'digest' || scheme === 'xdigest') {
        digestCache.nc = (digestCache.nc ?? 0) + 1;
        digestCache.cnonce = this.generateCnonce();
        xhr.setRequestHeader('Authorization', this.buildDigestAuthHeader(digestCache, uri, method));
      } else if (scheme === 'basic') {
        xhr.setRequestHeader('Authorization', digestCache.scheme + ' ' + btoa(`${config.username}:${config.password}`));
      }
      // legacy falls through silently for any other scheme value.
    } else {
      // NOTE: legacy quirk preserved — this freshly-built cache's `nc`/`cnonce`
      // are NOT incremented/regenerated the way the digest/xdigest branch does;
      // they stay at their `null` initializers (decimalToHex(null, 8) => "00000000").
      const freshCache: DigestCache = { scheme: 'Digest', realm: '', nonce: null, opaque: null, qop: 'auth', nc: null, cnonce: null };
      xhr.setRequestHeader('Authorization', this.buildDigestAuthHeader(freshCache, uri, method));
    }

    return xhr;
  }

  private makeNewRequest(
    method: string,
    uri: string,
    isAsync: boolean,
    wwwAuthenticate: string | null,
    isText: boolean | undefined,
    existingXhr: XhrLike | null | undefined
  ): XhrLike {
    const config = this.restClientConfig.digest;
    let server = `${config.protocol}://${config.hostname}`;
    if (typeof config.port !== 'undefined' && config.port !== null && (config.port as unknown) !== '') {
      server += ':' + config.port;
    }

    const xhr = existingXhr ?? this.xhrFactory();
    xhr.open(method, server + uri, isAsync);

    if (this.restClientConfig.serverType === 'camera' && this.restClientConfig.cors) {
      xhr.setRequestHeader('XClient', 'XMLHttpRequest');
    }
    if (!isText) {
      xhr.setRequestHeader('Accept', 'application/json');
    }

    if (wwwAuthenticate !== '' && wwwAuthenticate !== undefined && wwwAuthenticate !== null) {
      this.authInfo = this.getAuthInfoInWwwAuthenticate(wwwAuthenticate);
    }

    if (typeof this.authInfo !== 'undefined' && this.authInfo !== null && this.authInfo.scheme === 'Digest') {
      return this.setDigestHeader(xhr, method, uri, this.authInfo);
    }
    return xhr;
  }

  private send(
    method: string,
    uri: string,
    successFn: SunapiClientSuccessFn,
    failFn: SunapiClientFailFn,
    isAsyncCall: boolean,
    scope: SunapiClientCallbackList | null | undefined,
    fileData: unknown,
    specialHeaders: SunapiSpecialHeader[] | null | undefined,
    isText: boolean | undefined
  ): void {
    let xhr = this.makeNewRequest(method, uri, isAsyncCall, '', isText, null);

    if (isAsyncCall) {
      xhr = this.setupAsyncCall(xhr, method, scope, uri, failFn);
      if (typeof specialHeaders !== 'undefined' && specialHeaders !== null) {
        for (let hdrindex = 0; hdrindex < specialHeaders.length; hdrindex += 1) {
          xhr.setRequestHeader(specialHeaders[hdrindex].Type, specialHeaders[hdrindex].Header);
        }
      }
    }

    xhr.onreadystatechange = () => {
      if (xhr.readyState === XHR_READY_STATE.DONE) {
        switch (xhr.status) {
          case 490:
            this.handleAccountBlock(failFn, xhr);
            break;
          case 401: {
            this.authCount += 1;
            if (this.authCount < 2) {
              const wwwAuthenticate = xhr.getResponseHeader('WWW-Authenticate');
              xhr = this.makeNewRequest(method, uri, isAsyncCall, wwwAuthenticate, isText, xhr);
              if (isAsyncCall) {
                xhr = this.setupAsyncCall(xhr, method, scope, uri, failFn);
                if (typeof specialHeaders !== 'undefined' && specialHeaders !== null) {
                  for (let hdrindex = 0; hdrindex < specialHeaders.length; hdrindex += 1) {
                    xhr.setRequestHeader(specialHeaders[hdrindex].Type, specialHeaders[hdrindex].Header);
                  }
                }
              }
              xhr.send();
            } else {
              failFn({ Code: xhr.status, message: HTTP_STATUS_CODES[String(xhr.status)] });
              this.authCount = 0;
            }
            break;
          }
          case 200:
            if (typeof xhr.response !== 'undefined' && xhr.response !== '') {
              this.parseResponse(xhr, successFn, failFn, isText);
              this.authCount = 0;
            } else {
              failFn({ Code: -1, message: 'No response' });
            }
            break;
          default:
            failFn({ Code: xhr.status, message: HTTP_STATUS_CODES[String(xhr.status)] });
            break;
        }
      }
    };

    xhr.ontimeout = () => failFn({ Code: 408, message: HTTP_STATUS_CODES['408'] });
    xhr.onerror = () => {
      // legacy: console.error(...) only, no further effect.
    };

    if (typeof fileData !== 'undefined' && fileData !== null && fileData !== '') {
      xhr.send(fileData);
    } else {
      xhr.send();
    }
  }

  private ajaxSync(method: string, uri: string, successFn: SunapiClientSuccessFn, failFn: SunapiClientFailFn, isText?: boolean): void {
    this.send(method, uri, successFn, failFn, false, null, null, null, isText);
  }

  private ajaxAsync(
    method: string,
    uri: string,
    successFn: SunapiClientSuccessFn,
    failFn: SunapiClientFailFn,
    scope: SunapiClientCallbackList | null | undefined,
    fileData: unknown,
    specialHeaders: SunapiSpecialHeader[] | null | undefined,
    isText?: boolean
  ): void {
    this.send(method, uri, successFn, failFn, true, scope, fileData, specialHeaders, isText);
  }

  get(
    uri: string,
    jsonData: Record<string, unknown> | undefined,
    successFn: SunapiClientSuccessFn,
    failFn: SunapiClientFailFn,
    scope: SunapiClientCallbackList | null | undefined,
    isAsyncCall?: boolean,
    isText?: boolean,
    withoutSeqId?: boolean
  ): void {
    let resolvedUri = encodeURI(uri);
    if (typeof jsonData !== 'undefined') {
      resolvedUri += this.jsonToText(jsonData);
      if (
        resolvedUri.indexOf('attributes.cgi') === -1 &&
        resolvedUri.indexOf('.cgi') !== -1 &&
        (typeof withoutSeqId === 'undefined' || withoutSeqId === null || withoutSeqId === false)
      ) {
        const sequencenum = new Date().getTime();
        resolvedUri += '&SunapiSeqId=' + sequencenum;
      }
    }

    if (resolvedUri.indexOf('configbackup') !== -1 || isAsyncCall === true) {
      this.ajaxAsync('GET', resolvedUri, successFn, failFn, scope, '', null, isText);
    } else {
      this.ajaxSync('GET', resolvedUri, successFn, failFn, isText);
    }
  }

  post(
    uri: string,
    jsonData: Record<string, unknown> | undefined,
    successFn: SunapiClientSuccessFn,
    failFn: SunapiClientFailFn,
    scope: SunapiClientCallbackList | null | undefined,
    fileData: unknown,
    specialHeaders: SunapiSpecialHeader[] | null | undefined
  ): void {
    let resolvedUri = uri;
    if (typeof jsonData !== 'undefined') {
      resolvedUri += this.jsonToText(jsonData);
    }
    this.ajaxAsync('POST', resolvedUri, successFn, failFn, scope, fileData, specialHeaders);
  }

  setTimeout(timeout: number): void {
    if ((timeout as unknown) !== 'undefined') {
      this.restClientConfig.digest.timeout = timeout;
    }
  }

  getAuthInfo(): DigestCache | null | undefined {
    return this.authInfo;
  }
}
