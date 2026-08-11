import { RTSPOverWebSocketError } from '../../exceptions/RTSPOverWebSocketError';
import { fromHex } from '../../util/hex';

/**
 * Ported from the legacy player’s Network/http/sunapiRestClient — a digest-auth
 * REST client that offloads each request to a dedicated Web Worker
 * (`sunapiRequestTask`, not yet ported — Layer 10).
 *
 * `log.debug`/`log.info`/`console.warn` calls are not reproduced (observability
 * only, same judgment as Transport.ts/RtspClient.ts). The two nearly-identical
 * `worker.onmessage` promise executors in legacy's `get`/`post` are extracted
 * into a single private helper (`runWorkerRequest`) — pure DRY, no behavior
 * change, since the two blocks were byte-for-byte identical logic.
 */

function createSunapiRequestWorker(): Worker {
  return new Worker(new URL('../../worker/sunapi/sunapiRequestTask.ts', import.meta.url));
}

export interface SunapiDeviceConfig {
  serverType: string;
  hostname: string;
  port: number;
  protocol: string;
  rtspPort: number;
  ClientIPAddress: string;
  username: string;
  password: string;
  timeout?: number;
}

export interface SunapiInitDeviceInfo {
  deviceType?: string;
  hostname?: string;
  cameraIp?: string;
  username?: string;
  user?: string;
  password?: string;
  port?: number;
  ClientIPAddress?: string;
}

export interface SunapiWorkerMessage {
  id: 'auth' | 'response' | string;
  auth?: Record<string, unknown>;
  success?: boolean;
  response?: unknown;
  status?: unknown;
}

export type SunapiSuccessFn = (response: unknown) => void;
export type SunapiErrorFn = (error: unknown) => void;

export class SunapiRestClient {
  private readonly deviceConfig: SunapiDeviceConfig = {
    serverType: 'camera',
    hostname: '',
    port: 80,
    protocol: 'http',
    rtspPort: 554,
    ClientIPAddress: '127.0.0.1',
    username: '',
    password: ''
  };

  private authInfo: Record<string, unknown> | undefined;
  private readonly promiseMode = true;
  private successFn?: SunapiSuccessFn;
  private errorFn?: SunapiErrorFn;
  private worker?: Worker;
  private promise?: Promise<void>;

  private runWorkerRequest(worker: Worker): Promise<void> {
    return new Promise<void>((resolve) => {
      worker.onmessage = (event: MessageEvent<SunapiWorkerMessage>) => {
        const data = event.data;
        if (data !== undefined && data !== null && (data as unknown) !== '') {
          if (data.id === 'auth') {
            if (typeof data.auth === 'object') {
              this.authInfo = data.auth;
            }
          } else {
            if (data.success && data.id === 'response') {
              this.successFn?.(data.response);
            } else {
              this.errorFn?.(data);
            }
            resolve();
            worker.terminate();
          }
        }
      };
      worker.onerror = () => {
        // legacy: log.error(...) only, no further effect.
      };
    });
  }

  private sendPost(uri: string, jsonData: unknown, scope: unknown, fileData: unknown, specialHeaders: unknown): void {
    const data = {
      async: true,
      deviceInfo: this.deviceConfig,
      method: 'post',
      uri,
      body: jsonData,
      scope,
      file: fileData,
      header: specialHeaders,
      auth: this.authInfo,
      promise: this.promiseMode
    };

    this.worker = createSunapiRequestWorker();
    this.promise = this.runWorkerRequest(this.worker);
    this.worker.postMessage(data);
  }

  private sendGet(uri: string, jsonData: unknown, scope: unknown, isAsyncCall: boolean, isText: boolean): void {
    const data = {
      async: Boolean(isAsyncCall),
      deviceInfo: this.deviceConfig,
      method: 'get',
      uri,
      body: jsonData,
      scope,
      isText,
      auth: this.authInfo,
      promise: this.promiseMode
    };

    this.worker = createSunapiRequestWorker();
    this.promise = this.runWorkerRequest(this.worker);
    this.worker.postMessage(data);
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

  /** Ported from sunapiRestClient's `jsonToText`, exposed for parity testing (it was internal-only in legacy but pure/stateless). */
  toQueryString(json: Record<string, unknown>): string {
    return this.jsonToText(json);
  }

  init(deviceInfo: SunapiInitDeviceInfo): void {
    if (deviceInfo.deviceType !== undefined && deviceInfo.deviceType !== '' && deviceInfo.deviceType !== null) {
      this.deviceConfig.serverType = deviceInfo.deviceType;
    }

    if (
      this.deviceConfig.serverType === 'nvr' &&
      (deviceInfo.hostname === undefined || (deviceInfo.hostname === '' && (deviceInfo.hostname as unknown) === null))
    ) {
      throw new RTSPOverWebSocketError({
        errorCode: fromHex('0x0401'),
        place: 'SunapiRestClient.ts:52',
        message: 'hostname is empty from input parameter.'
      });
    } else if (
      this.deviceConfig.serverType === 'camera' &&
      (deviceInfo.cameraIp === undefined || deviceInfo.cameraIp === '' || deviceInfo.cameraIp === null)
    ) {
      throw new RTSPOverWebSocketError({
        errorCode: fromHex('0x0400'),
        place: 'SunapiRestClient.ts:60',
        message: 'cameraIP is empty from input parameter.'
      });
    }

    if (
      this.deviceConfig.serverType === 'nvr' &&
      (deviceInfo.username === undefined || deviceInfo.username === '' || deviceInfo.username === null)
    ) {
      throw new RTSPOverWebSocketError({
        errorCode: fromHex('0x0402'),
        place: 'SunapiRestClient.ts:70',
        message: 'username is empty from input parameter.'
      });
    } else if (
      this.deviceConfig.serverType === 'camera' &&
      (deviceInfo.user === undefined || deviceInfo.user === '' || deviceInfo.user === null)
    ) {
      throw new RTSPOverWebSocketError({
        errorCode: fromHex('0x0402'),
        place: 'SunapiRestClient.ts:78',
        message: 'user id is empty from input parameter.'
      });
    }

    if (deviceInfo.password === undefined || deviceInfo.password === '' || deviceInfo.password === null) {
      throw new RTSPOverWebSocketError({
        errorCode: fromHex('0x0403'),
        place: 'SunapiRestClient.ts:80',
        message: 'password is empty from input parameter.'
      });
    }

    const splitProt = window.location.protocol.split(':');
    // Only trust the page's own protocol when it's actually http(s) — for
    // a non-http(s) host (e.g. a chrome-extension: page) it says nothing
    // about the target device's protocol. Same root cause and fix as
    // SunapiManager.init(); see its comment for the full story.
    // Unlike SunapiManager/SunapiClient's device-info types,
    // SunapiInitDeviceInfo carries no protocol field to fall back to here,
    // so this falls back to this class's own default (see deviceConfig's
    // initializer above) rather than an explicit caller-provided value.
    const pageIsHttp = splitProt[0] === 'http' || splitProt[0] === 'https';

    this.deviceConfig.serverType = deviceInfo.deviceType!;
    this.deviceConfig.hostname = deviceInfo.hostname!;
    this.deviceConfig.port = deviceInfo.port!;
    this.deviceConfig.protocol = pageIsHttp ? splitProt[0] : 'http';
    this.deviceConfig.ClientIPAddress = deviceInfo.ClientIPAddress!;
    this.deviceConfig.username = deviceInfo.username!;
    this.deviceConfig.password = deviceInfo.password;
  }

  get(
    uri: string,
    jsonData: unknown,
    successFn: SunapiSuccessFn,
    failFn: SunapiErrorFn,
    scope: unknown,
    isAsyncCall: boolean,
    isText: boolean
  ): void {
    this.successFn = successFn;
    this.errorFn = failFn;
    this.sendGet(uri, jsonData, scope, isAsyncCall, isText);
  }

  post(
    uri: string,
    jsonData: unknown,
    successFn: SunapiSuccessFn,
    failFn: SunapiErrorFn,
    scope: unknown,
    fileData: unknown,
    specialHeaders: unknown
  ): void {
    this.successFn = successFn;
    this.errorFn = failFn;
    this.sendPost(uri, jsonData, scope, fileData, specialHeaders);
  }

  join(): void {
    if (!this.promiseMode) {
      return;
    }
    if (this.promise) {
      Promise.resolve(this.promise);
    }
  }

  setTimeout(timeout: number): void {
    if ((timeout as unknown) !== 'undefined') {
      this.deviceConfig.timeout = timeout;
    }
  }
}
