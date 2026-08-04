import CryptoJS from 'crypto-js';

function undefinedGlobalError(name: string): ReferenceError {
  return new ReferenceError(`${name} is not defined`);
}

export interface SunapiTaskDeviceInfo {
  protocol: string;
  hostname: string;
  port?: string | number;
  serverType?: string;
  username: string;
  password: string;
  timeout?: number;
}

export interface SunapiTaskRequestData {
  method: string;
  uri: string;
  scope?: SunapiCallbackList;
  body?: Record<string, unknown>;
  async?: boolean;
  isText?: boolean;
  auth?: DigestCache;
  deviceInfo: SunapiTaskDeviceInfo;
}

export interface SunapiCallbackList {
  ProgressEvent?: (event: ProgressEvent) => void;
  CompleteEvent?: (event: Event) => void;
  CancelEvent?: (event: Event) => void;
  FailEvent?: (event: Event) => void;
}

export interface DigestCache {
  scheme: string;
  realm: string | null;
  nonce: string | null;
  opaque?: string | null;
  qop: string | null;
  nc: number | null;
  cnonce: string | null;
}

export interface SunapiTaskResult {
  id: 'auth' | 'response' | 'error';
  success: boolean;
  auth?: DigestCache | false;
  status?: number;
  response?: unknown;
  code?: unknown;
  message?: string;
}

export type SunapiTaskXHRFactory = () => XMLHttpRequest;
export type SunapiTaskPostMessageFn = (data: SunapiTaskResult) => void;

/**
 * Ported from the legacy player’s Worker/sunapi/sunapiRequestTask — the Worker
 * entry SunapiRestClient.ts (Network/http) offloads each SUNAPI REST call to.
 *
 * Legacy declares module-scope state via `this.digestInfo = undefined; ...`
 * at the file's own top level — since this runs as a classic (non-strict,
 * non-arrow) Worker script, top-level `this` **is** the Worker global scope,
 * so those are equivalent to `self.digestInfo = ...` and every later bare
 * reference (`digestInfo`, `data`, `working`) reads/writes the same global
 * properties. Ported here as plain instance fields instead — same sharing
 * behavior, since this class instance is the moral equivalent of that global
 * scope, and every method that read/wrote a bare identifier now reads/writes
 * `this.<field>`.
 *
 * **Confirmed real bugs preserved faithfully (not fixed):**
 * - `onMessage()`'s first statement calls `fastJsonStringfy(event.data)` —
 *   that function is a *main-thread-only* global (`window.fastJsonStringfy`
 *   from Util/util.js) never available in this Worker's own global scope, so
 *   it throws `ReferenceError` immediately, every single time a message is
 *   received. This makes the entire dispatch logic below it unreachable in
 *   the currently-running app — but it's still ported faithfully (not
 *   deleted), both because it's one upstream statement away from being live
 *   again, and to keep this a genuine line-for-line port rather than a
 *   silent feature removal. `getDotEqualStrLineToObj` has the exact same
 *   `fastJsonStringfy` bug in its own (separately reachable, if `onMessage`
 *   didn't crash first) result-logging line.
 * - `setAuthorizationHeader`'s `'basic'` auth-scheme branch reads
 *   `RESdata.deviceInfo.username` — `RESdata` (capital "RES", presumably
 *   meant to be `this`/`data`) is never declared anywhere in the file, so
 *   this throws `ReferenceError` whenever a server challenges with Basic auth.
 */
export class SunapiRequestTask {
  digestInfo: DigestCache | undefined = undefined;
  data: SunapiTaskRequestData | null = null;
  working = false;
  postMethodTimeout = 10000;
  getMethodTimeout = 1000;

  private xhr: XMLHttpRequest | null = null;

  constructor(
    private readonly xhrFactory: SunapiTaskXHRFactory = () => new XMLHttpRequest(),
    private readonly postMessageFn: SunapiTaskPostMessageFn = (data) => postMessage(data)
  ) {}

  onMessage(event: { data: SunapiTaskRequestData }): void {
    // legacy: `console.debug("event" + fastJsonStringfy(event.data));` — see
    // class doc comment. Everything below is a faithful port of the real
    // dispatch logic, kept even though it's unreachable given this throw.
    throw undefinedGlobalError('fastJsonStringfy');

    // eslint-disable-next-line no-unreachable
    this.data = event.data;
    // eslint-disable-next-line no-unreachable
    this.digestInfo = event.data.auth;

    // eslint-disable-next-line no-unreachable
    const data = event.data;
    // eslint-disable-next-line no-unreachable
    if (!this.working) {
      let uri = data.uri;
      const body = data.body;
      if (data.method.toLowerCase() === 'post') {
        if (typeof body !== 'undefined') {
          uri += this.jsonToText(body as Record<string, unknown>);
        }
        this.ajaxAsync('POST', uri, data.scope, undefined, undefined);
      } else if (data.method.toLowerCase() === 'get') {
        uri = encodeURI(data.uri);
        if (typeof body !== 'undefined') {
          uri += this.jsonToText(body as Record<string, unknown>);
          if (uri.indexOf('attributes.cgi') === -1) {
            const sequencenum = new Date().getTime();
            uri += '&SunapiSeqId=' + sequencenum;
          }
        }

        if (uri.indexOf('configbackup') !== -1 || data.async === true) {
          this.ajaxAsync('GET', uri, data.scope, '', undefined, data.isText);
        } else {
          this.ajaxSync('GET', uri, data.isText);
        }
      }
    }
  }

  onError(err: unknown): void {
    // eslint-disable-next-line no-console
    console.debug(err);
  }

  private ajaxAsync(method: string, uri: string, scope: SunapiCallbackList | undefined, fileData?: unknown, specialHeaders?: { Type: string; Header: string }[], isText?: boolean): void {
    this.working = true;
    this.xhr = this.makeNewRequest(method, uri, true, '', isText);

    this.setupAsyncCall(this.xhr, method, scope, uri);

    if (typeof specialHeaders !== 'undefined') {
      for (let hdrindex = 0; hdrindex < specialHeaders.length; hdrindex += 1) {
        this.xhr.setRequestHeader(specialHeaders[hdrindex].Type, specialHeaders[hdrindex].Header);
      }
    }

    try {
      if (typeof fileData !== 'undefined' && fileData !== null && fileData !== '') {
        this.xhr.send(fileData as Document | XMLHttpRequestBodyInit);
      } else {
        this.xhr.send();
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Error', error);
      this.parserError(this.xhr, error);
    }
  }

  private ajaxSync(method: string, uri: string, isText?: boolean): void {
    this.working = true;
    this.xhr = this.makeNewRequest(method, uri, false, '', isText);

    // eslint-disable-next-line no-console
    console.debug('=====================================>', this.xhr);
    try {
      this.xhr.send();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Error', error);
      this.parserError(this.xhr, error);
    }
  }

  private onReadyStateChangeEventHandler = (): void => {
    const xhrEvt = this.xhr as XMLHttpRequest;
    const data = this.data as SunapiTaskRequestData;
    switch (xhrEvt.readyState) {
      case XMLHttpRequest.DONE: {
        // eslint-disable-next-line no-console
        console.debug('Done');
        if (xhrEvt.status === 401) {
          const wwwAuthenticate = xhrEvt.getResponseHeader('www-authenticate');
          let digestInfo: DigestCache | false | undefined;
          if (wwwAuthenticate !== null) {
            // eslint-disable-next-line no-console
            console.log('wwwAuthenticate : ', wwwAuthenticate);
            digestInfo = this.getDigestInfoInWwwAuthenticate(wwwAuthenticate);
            this.postMessageFn({ id: 'auth', success: true, auth: digestInfo });
          }
          this.xhr = this.makeNewRequest(data.method, data.uri, true, wwwAuthenticate ?? undefined, data.isText);
          if (typeof digestInfo !== 'undefined' && digestInfo !== null && digestInfo !== false) {
            this.setAuthorizationHeader(this.xhr, data.method, data.uri, digestInfo);
          }
          this.setupAsyncCall(this.xhr, data.method, data.scope, data.uri);
          try {
            this.xhr.send();
          } catch (error) {
            // eslint-disable-next-line no-console
            console.error('Error', error);
          }
        } else {
          this.parseResponse(xhrEvt);
        }
        break;
      }
      case XMLHttpRequest.LOADING:
        // eslint-disable-next-line no-console
        console.debug('Loading');
        break;
      case XMLHttpRequest.OPENED:
        // eslint-disable-next-line no-console
        console.debug('Opened');
        break;
      case XMLHttpRequest.HEADERS_RECEIVED: {
        // eslint-disable-next-line no-console
        console.debug('Header received');
        const wwwAuthenticate = xhrEvt.getResponseHeader('www-authenticate');
        let digestInfo: DigestCache | false | undefined;
        if (wwwAuthenticate !== null) {
          // eslint-disable-next-line no-console
          console.log('wwwAuthenticate : ', wwwAuthenticate);
          digestInfo = this.getDigestInfoInWwwAuthenticate(wwwAuthenticate);
          this.postMessageFn({ id: 'auth', success: true, auth: digestInfo });
        }
        // eslint-disable-next-line no-console
        console.debug('allResponseHeaders: ', xhrEvt.getAllResponseHeaders());
        this.xhr = this.makeNewRequest(data.method, data.uri, true, wwwAuthenticate ?? undefined, data.isText);
        if (typeof digestInfo !== 'undefined' && digestInfo !== null && digestInfo !== false) {
          this.setAuthorizationHeader(this.xhr, data.method, data.uri, digestInfo);
        }
        this.setupAsyncCall(this.xhr, data.method, data.scope, data.uri);
        try {
          this.xhr.send();
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error('Error', error);
          this.parserError(this.xhr, error);
        }
        break;
      }
      case XMLHttpRequest.UNSENT:
        // eslint-disable-next-line no-console
        console.debug('Unsent');
        break;
      default:
        break;
    }
  };

  private updateProgress(event: ProgressEvent): void {
    if (event.lengthComputable) {
      const percentComplete = (event.loaded / event.total) * 100;
      // eslint-disable-next-line no-console
      console.log('percent ' + percentComplete);
    }
  }

  private parseResponse(xhr: XMLHttpRequest): void {
    const result: SunapiTaskResult = { id: 'response', success: false };
    const data = this.data as SunapiTaskRequestData;

    if (xhr.readyState !== XMLHttpRequest.DONE) {
      return;
    }
    if (xhr.status !== 200) {
      result.id = 'error';
      result.success = false;
      result.status = xhr.status;
      this.xhr = null;
      this.postMessageFn(result);
      return;
    }

    if (typeof xhr.response === 'undefined' || xhr.response === '') {
      return;
    }

    if (xhr.responseType === 'arraybuffer' || xhr.responseXML !== null || data.isText) {
      result.id = 'response';
      result.success = true;
      result.status = xhr.status;
      result.response = xhr.response;
      this.xhr = null;
      this.postMessageFn(result);
      return;
    }

    const resp = this.isJSON(xhr.response) === false ? this.getDotEqualStrLineToObj(xhr.response) : JSON.parse(xhr.response);
    if (typeof resp === 'object') {
      // legacy checks `result.Response === "Fail"` — `result` here is the
      // freshly-created `{}` this function starts with, which never has a
      // `Response` property set before this check, so this branch is
      // confirmed unreachable (always falls to the `else`). Kept as a
      // faithful structural no-op rather than removed.
      if ((result as unknown as { Response?: string }).Response === 'Fail') {
        result.id = 'error';
        result.success = false;
        result.status = xhr.status;
        this.xhr = null;
        this.postMessageFn(result);
      } else {
        result.id = 'response';
        result.success = true;
        result.status = xhr.status;
        result.response = resp;
        this.xhr = null;
        this.postMessageFn(result);
      }
    } else {
      result.id = 'response';
      result.success = true;
      result.status = xhr.status;
      result.response = xhr.response;
      this.xhr = null;
      this.postMessageFn(result);
    }
  }

  private parserError(xhr: XMLHttpRequest | null, error: unknown): void {
    const err = error as { code?: unknown; message?: string };
    this.postMessageFn({
      id: 'error',
      success: false,
      code: err.code,
      status: xhr?.status,
      message: err.message
    });
  }

  private makeNewRequest(method: string, uri: string, isAsync: boolean, wwwAuthenticate?: string, isText?: boolean): XMLHttpRequest {
    const restClientConfig = (this.data as SunapiTaskRequestData).deviceInfo;
    let server = restClientConfig.protocol + '://' + restClientConfig.hostname;
    if (typeof restClientConfig.port !== 'undefined' && restClientConfig.port !== null && (restClientConfig.port as unknown) !== '') {
      server += ':' + restClientConfig.port;
    }
    const xhr = this.xhrFactory();
    xhr.open(method, server + uri, isAsync);
    if (restClientConfig.serverType === 'camera') {
      xhr.setRequestHeader('XClient', 'XMLHttpRequest');
    }
    if (!isText || typeof isText === 'undefined') {
      xhr.setRequestHeader('Accept', 'application/json');
    }

    if (typeof wwwAuthenticate !== 'undefined' && wwwAuthenticate !== '' && wwwAuthenticate !== null) {
      const digestInfo = this.getDigestInfoInWwwAuthenticate(wwwAuthenticate);
      this.postMessageFn({ id: 'auth', success: true, auth: digestInfo });
      if (digestInfo !== false) {
        this.setAuthorizationHeader(xhr, method, uri, digestInfo);
      }
    } else if (typeof this.digestInfo !== 'undefined' && this.digestInfo !== null) {
      this.setAuthorizationHeader(xhr, method, uri, this.digestInfo);
    }
    xhr.onreadystatechange = this.onReadyStateChangeEventHandler;
    xhr.onprogress = (event) => this.updateProgress(event);

    return xhr;
  }

  private setAuthorizationHeader(xhr: XMLHttpRequest, method: string, uri: string, digestCacheInput: DigestCache): void {
    // `deviceInfo` is intentionally read lazily (per-branch, via this
    // getter) rather than hoisted to the top of the method: legacy only
    // ever touches `data.deviceInfo` *inside* whichever scheme branch is
    // taken, and the 'basic' branch crashes on the undeclared `RESdata`
    // before it ever reaches `data` at all — hoisting would read
    // `this.data.deviceInfo` unconditionally and crash earlier than legacy
    // does whenever `this.data` isn't set yet.
    const deviceInfo = (): SunapiTaskDeviceInfo => (this.data as SunapiTaskRequestData).deviceInfo;
    let digestCache = digestCacheInput;
    let responseValue: string;
    let digestAuthHeader: string;
    if (digestCache) {
      if (digestCache.scheme.toLowerCase() === 'digest') {
        digestCache.nc = (digestCache.nc as number) + 1;
        digestCache.cnonce = this.generateCnonce();
        responseValue = this.formulateResponse(deviceInfo().username, deviceInfo().password, uri, digestCache.realm, method.toUpperCase(), digestCache.nonce, digestCache.nc, digestCache.cnonce, digestCache.qop);
        digestAuthHeader = `${digestCache.scheme} username="${deviceInfo().username}", realm="${digestCache.realm}", nonce="${digestCache.nonce}", uri="${uri}", cnonce="${digestCache.cnonce}" nc=${this.decimalToHex(digestCache.nc, 8)}, qop=${digestCache.qop}, response="${responseValue}"`;
        xhr.setRequestHeader('Authorization', digestAuthHeader);
      } else if (digestCache.scheme.toLowerCase() === 'xdigest') {
        digestCache.nc = (digestCache.nc as number) + 1;
        digestCache.cnonce = this.generateCnonce();
        responseValue = this.formulateResponse(deviceInfo().username, deviceInfo().password, uri, digestCache.realm, method.toUpperCase(), digestCache.nonce, digestCache.nc, digestCache.cnonce, digestCache.qop);
        digestAuthHeader = `${digestCache.scheme} username="${deviceInfo().username}", realm="${digestCache.realm}", nonce="${digestCache.nonce}", uri="${uri}", cnonce="${digestCache.cnonce}" nc=${this.decimalToHex(digestCache.nc, 8)}, qop=${digestCache.qop}, response="${responseValue}"`;
        xhr.setRequestHeader('Authorization', digestAuthHeader);
      } else if (digestCache.scheme.toLowerCase() === 'basic') {
        // legacy: `btoa(RESdata.deviceInfo.username + ':' + data.deviceInfo.password)`
        // — `RESdata` is never declared anywhere in the file; confirmed
        // ReferenceError (thrown while resolving the callee-argument
        // expression, before `data.deviceInfo` is ever reached), preserved
        // faithfully rather than "fixed" to `data`.
        throw undefinedGlobalError('RESdata');
      }
    } else {
      digestCache = { scheme: 'Digest', realm: '', nonce: null, opaque: null, qop: 'auth', nc: null, cnonce: null };
      responseValue = this.formulateResponse(deviceInfo().username, deviceInfo().password, uri, digestCache.realm, method.toUpperCase(), digestCache.nonce, digestCache.nc, digestCache.cnonce, digestCache.qop);
      digestAuthHeader = `${digestCache.scheme} username="${deviceInfo().username}", realm="${digestCache.realm}", nonce="${digestCache.nonce}", uri="${uri}", cnonce="${digestCache.cnonce}" nc=${this.decimalToHex(digestCache.nc, 8)}, qop=${digestCache.qop}, response="${responseValue}"`;
      xhr.setRequestHeader('Authorization', digestAuthHeader);
    }
  }

  getDigestInfoInWwwAuthenticate(wwwAuthenticate: string | null): DigestCache | false {
    let digestHeaders = wwwAuthenticate;
    let scheme: string | null = null;
    let realm: string | null = null;
    let nonce: string | null = null;
    let opaque: string | null = null;
    let qop: string | null = null;
    let nc: number | null = null;

    if (digestHeaders === null) {
      return false;
    }

    const parts = digestHeaders.split(',');
    scheme = parts[0].split(/\s/)[0];

    for (let i = 0; i < parts.length; i++) {
      const keyVal = parts[i].split('=');
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
    // legacy: `nc++` on a `null` initial value — `null++` coerces to `0`,
    // then increments to `1` (the assignment result), matching `Number(null)
    // + 1`. Preserved via the same coercion here rather than special-cased.
    nc = (nc as unknown as number) + 1;

    void digestHeaders;
    return { scheme: scheme as string, realm, nonce, opaque, qop, cnonce, nc };
  }

  private setupAsyncCall(xhr: XMLHttpRequest, method: string, callbackList: SunapiCallbackList | undefined, uri: string): void {
    const onErrorEvent = (): void => {
      throw new Error('Network Error');
    };
    if (typeof callbackList !== 'undefined' && (callbackList as unknown) !== '') {
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

    if (method === 'POST') {
      xhr.timeout = this.postMethodTimeout;
    } else {
      xhr.timeout = this.getMethodTimeout;
    }

    const deviceInfo = (this.data as SunapiTaskRequestData).deviceInfo;
    if ((deviceInfo.timeout as unknown) !== 'undefined') {
      xhr.timeout = deviceInfo.timeout as number;
    }

    if (uri.indexOf('configbackup') !== -1) {
      xhr.responseType = 'arraybuffer';
    }
    if (uri.indexOf('opensdk') !== -1) {
      xhr.withCredentials = true;
    }
  }

  private formulateResponse(username: string, password: string, uri: string, realm: string | null, method: string, nonce: string | null, nc: number | null, cnonce: string | null, qop: string | null): string {
    const HA1 = CryptoJS.MD5(`${username}:${realm}:${password}`).toString();
    const HA2 = CryptoJS.MD5(`${method}:${uri}`).toString();
    return CryptoJS.MD5(`${HA1}:${nonce}:${this.decimalToHex(nc as number, 8)}:${cnonce}:${qop}:${HA2}`).toString();
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

  private decimalToHex(d: number | null, padding?: number): string {
    let hex = Number(d).toString(16);
    const pad = typeof padding === 'undefined' || padding === null ? 2 : padding;
    while (hex.length < pad) {
      hex = '0' + hex;
    }
    return hex;
  }

  // legacy also defines `clearDigestCache` here — confirmed zero call sites
  // anywhere in sunapiRequestTask.js, dropped as genuinely dead code.

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

  /** by neighbor21 duks — response fields differ between camera and NVR; parses '.'-delimited-key/'='-value lines (e.g. "aaa.bbb.ccc=value"). */
  getDotEqualStrLineToObj(data: string): Record<string, unknown> {
    const res: Record<string, unknown> = {};
    const getOrInit = (obj: Record<string, unknown>, key: string): Record<string, unknown> => (obj[key] as Record<string, unknown>) || (obj[key] = {});
    const strRes = data.split('\r\n');
    for (let i = 0; i < strRes.length; i++) {
      if (!strRes[i]) {
        continue;
      }
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
    // legacy: `console.log('result : '+fastJsonStringfy(res));` — the same
    // undefined-global bug as onMessage() (see class doc comment). This
    // function is only reachable at all if onMessage's own earlier crash is
    // fixed, at which point this line would *also* throw before returning.
    throw undefinedGlobalError('fastJsonStringfy');
  }

  private isJSON(str: unknown): boolean {
    try {
      return Boolean(JSON.parse(str as string)) && Boolean(str);
    } catch {
      return false;
    }
  }
}
