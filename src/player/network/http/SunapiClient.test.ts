import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { loadLegacyModule } from '../../test-support/loadLegacyModule';
import { createBaseLegacySandbox } from '../../test-support/legacyGlobals';
import { SunapiClient, type SunapiClientDeviceInfo, type XhrLike } from './SunapiClient';
import { HTTP_STATUS_CODES } from './HttpStatusCode';

interface LegacySunapiClient {
  get(
    uri: string,
    jsonData: Record<string, unknown> | undefined,
    successFn: (result: { data: unknown }) => void,
    failFn: (error: { Code: number | string; message: unknown }) => void,
    scope: unknown,
    isAsyncCall?: boolean,
    isText?: boolean,
    withoutSeqId?: boolean
  ): void;
  post(
    uri: string,
    jsonData: Record<string, unknown> | undefined,
    successFn: (result: { data: unknown }) => void,
    failFn: (error: { Code: number | string; message: unknown }) => void,
    scope: unknown,
    fileData: unknown,
    specialHeaders: unknown
  ): void;
  setTimeout(timeout: number): void;
  getAuthInfo(): unknown;
}

/** Minimal fake satisfying both the legacy sandbox's `XMLHttpRequest` global and the port's injectable `XhrLike`. */
class FakeXhr implements XhrLike {
  static instances: FakeXhr[] = [];
  static readonly DONE = 4;

  readonly UNSENT = 0;
  readonly OPENED = 1;
  readonly HEADERS_RECEIVED = 2;
  readonly LOADING = 3;
  readonly DONE = 4;

  status = 0;
  readyState = 0;
  response: unknown = '';
  responseType = '';
  responseXML: unknown = null;
  onreadystatechange: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onerror: (() => void) | null = null;
  timeout = 0;
  withCredentials = false;
  upload = { addEventListener: () => {} };

  openCalls: { method: string; url: string; async?: boolean }[] = [];
  headers: Record<string, string> = {};
  private responseHeaders: Record<string, string> = {};
  sendCalls: unknown[] = [];

  constructor() {
    FakeXhr.instances.push(this);
  }

  open(method: string, url: string, async?: boolean): void {
    this.openCalls.push({ method, url, async });
    this.readyState = this.OPENED;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  getResponseHeader(name: string): string | null {
    return this.responseHeaders[name] ?? null;
  }

  addEventListener(): void {}

  send(body?: unknown): void {
    this.sendCalls.push(body);
  }

  respond(status: number, response: unknown, responseHeaders: Record<string, string> = {}): void {
    this.status = status;
    this.response = response;
    this.readyState = this.DONE;
    this.responseHeaders = responseHeaders;
    this.onreadystatechange?.();
  }
}

const sandbox = {
  ...createBaseLegacySandbox(),
  location: { hostname: 'test-host', port: '3080', protocol: 'http:' },
  rtspOverWebSocketError: loadLegacyModule('Exception/RTSPOverWebSocketError.js', 'RTSPOverWebSocketError'),
  AuthError: loadLegacyModule('Exception/AuthError.js', 'AuthError'),
  fromHex: (hex: string) => parseInt(hex, 16),
  fastJsonStringfy: (value: unknown) => JSON.stringify(value),
  HTTP_STATUS_CODES,
  btoa: globalThis.btoa,
  XMLHttpRequest: FakeXhr
};

const LegacySunapiClientCtor = loadLegacyModule<new (deviceInfo: SunapiClientDeviceInfo) => LegacySunapiClient>(
  'Network/http/sunapiClient.js',
  'SunapiClient',
  sandbox
);

function newLegacy(deviceInfo: SunapiClientDeviceInfo): LegacySunapiClient {
  return new LegacySunapiClientCtor({ ...deviceInfo });
}

function newPorted(deviceInfo: SunapiClientDeviceInfo): SunapiClient {
  return new SunapiClient({ ...deviceInfo }, () => new FakeXhr());
}

function errorShape(fn: () => void): { errorCode?: number; place?: string; message?: string } {
  try {
    fn();
  } catch (error) {
    const err = error as { errorCode?: number; place?: string; message?: string };
    return { errorCode: err.errorCode, place: err.place, message: err.message };
  }
  return {};
}

const cameraDeviceInfo: SunapiClientDeviceInfo = { cameraIp: '192.168.1.100', user: 'admin', password: 'pw' };

describe('SunapiClient parity with the legacy player’s Network/http/sunapiClient.js', () => {
  beforeAll(() => {
    (globalThis as unknown as { window: { location: { hostname: string; port: string; protocol: string } } }).window = {
      location: { hostname: 'test-host', port: '3080', protocol: 'http:' }
    };
  });

  afterAll(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  beforeEach(() => {
    FakeXhr.instances = [];
  });

  describe('constructor validation', () => {
    it('throws identically when a camera device is missing cameraIp', () => {
      const deviceInfo: SunapiClientDeviceInfo = { user: 'admin', password: 'pw' };
      expect(errorShape(() => newPorted(deviceInfo))).toEqual(errorShape(() => newLegacy(deviceInfo)));
    });

    it('throws identically when a camera device is missing user', () => {
      const deviceInfo: SunapiClientDeviceInfo = { cameraIp: '192.168.1.100', password: 'pw' };
      expect(errorShape(() => newPorted(deviceInfo))).toEqual(errorShape(() => newLegacy(deviceInfo)));
    });

    it('throws identically when password is missing', () => {
      const deviceInfo: SunapiClientDeviceInfo = { cameraIp: '192.168.1.100', user: 'admin' };
      expect(errorShape(() => newPorted(deviceInfo))).toEqual(errorShape(() => newLegacy(deviceInfo)));
    });

    it('does not throw for a well-formed camera device, identically', () => {
      expect(() => newLegacy(cameraDeviceInfo)).not.toThrow();
      expect(() => newPorted(cameraDeviceInfo)).not.toThrow();
    });

    it('derives cameraIp from hostname when cameraIp is absent, identically (mutates the input like legacy)', () => {
      const legacyInfo: SunapiClientDeviceInfo = { hostname: '192.168.1.150', user: 'admin', password: 'pw' };
      const portedInfo: SunapiClientDeviceInfo = { hostname: '192.168.1.150', user: 'admin', password: 'pw' };
      expect(() => new LegacySunapiClientCtor(legacyInfo)).not.toThrow();
      expect(() => new SunapiClient(portedInfo, () => new FakeXhr())).not.toThrow();
      expect(portedInfo.cameraIp).toBe(legacyInfo.cameraIp);
    });
  });

  describe('get() request dispatch', () => {
    it('opens the same sync GET URL (with SunapiSeqId appended for a .cgi endpoint) identically', () => {
      const legacy = newLegacy(cameraDeviceInfo);
      legacy.get('/stw-cgi/system.cgi?msubmenu=deviceinfo&action=view', undefined, () => {}, () => {}, null);
      const legacyUrl = FakeXhr.instances[0].openCalls[0].url;

      FakeXhr.instances = [];
      const ported = newPorted(cameraDeviceInfo);
      ported.get('/stw-cgi/system.cgi?msubmenu=deviceinfo&action=view', undefined, () => {}, () => {}, null);
      const portedUrl = FakeXhr.instances[0].openCalls[0].url;

      // Both embed a millisecond Date.now()-based SunapiSeqId — compare
      // everything except that volatile numeric suffix.
      expect(portedUrl.replace(/SunapiSeqId=\d+/, 'SunapiSeqId=N')).toBe(legacyUrl.replace(/SunapiSeqId=\d+/, 'SunapiSeqId=N'));
    });

    it('does not append SunapiSeqId for an attributes.cgi endpoint, identically', () => {
      const legacy = newLegacy(cameraDeviceInfo);
      legacy.get('/stw-cgi/attributes.cgi', { msubmenu: 'x' }, () => {}, () => {}, null);
      const legacyUrl = FakeXhr.instances[0].openCalls[0].url;

      FakeXhr.instances = [];
      const ported = newPorted(cameraDeviceInfo);
      ported.get('/stw-cgi/attributes.cgi', { msubmenu: 'x' }, () => {}, () => {}, null);
      const portedUrl = FakeXhr.instances[0].openCalls[0].url;

      expect(portedUrl).toBe(legacyUrl);
      expect(portedUrl).not.toContain('SunapiSeqId');
    });

    it('sets the same request headers (XClient + Accept) on open, identically', () => {
      const legacy = newLegacy(cameraDeviceInfo);
      legacy.get('/stw-cgi/attributes.cgi', undefined, () => {}, () => {}, null);
      const legacyHeaders = { ...FakeXhr.instances[0].headers };

      FakeXhr.instances = [];
      const ported = newPorted(cameraDeviceInfo);
      ported.get('/stw-cgi/attributes.cgi', undefined, () => {}, () => {}, null);
      const portedHeaders = { ...FakeXhr.instances[0].headers };

      expect(portedHeaders).toEqual(legacyHeaders);
    });
  });

  describe('send() response handling', () => {
    it('parses a 200 JSON response identically', () => {
      const legacyResults: unknown[] = [];
      const legacy = newLegacy(cameraDeviceInfo);
      legacy.get('/stw-cgi/attributes.cgi', undefined, (r) => legacyResults.push(r), (e) => legacyResults.push(e), null);
      FakeXhr.instances[0].respond(200, JSON.stringify({ Response: 'Success', Value: 1 }));

      FakeXhr.instances = [];
      const portedResults: unknown[] = [];
      const ported = newPorted(cameraDeviceInfo);
      ported.get('/stw-cgi/attributes.cgi', undefined, (r) => portedResults.push(r), (e) => portedResults.push(e), null);
      FakeXhr.instances[0].respond(200, JSON.stringify({ Response: 'Success', Value: 1 }));

      expect(portedResults).toEqual(legacyResults);
    });

    it('reports a Fail-shaped 200 JSON response as an error identically', () => {
      const legacyResults: unknown[] = [];
      const legacy = newLegacy(cameraDeviceInfo);
      legacy.get('/stw-cgi/attributes.cgi', undefined, (r) => legacyResults.push(r), (e) => legacyResults.push(e), null);
      FakeXhr.instances[0].respond(200, JSON.stringify({ Response: 'Fail', Error: { Code: 123, Details: 'bad' } }));

      FakeXhr.instances = [];
      const portedResults: unknown[] = [];
      const ported = newPorted(cameraDeviceInfo);
      ported.get('/stw-cgi/attributes.cgi', undefined, (r) => portedResults.push(r), (e) => portedResults.push(e), null);
      FakeXhr.instances[0].respond(200, JSON.stringify({ Response: 'Fail', Error: { Code: 123, Details: 'bad' } }));

      expect(portedResults).toEqual(legacyResults);
    });

    it('fails with "No response" for an empty 200 response body identically', () => {
      const legacyResults: unknown[] = [];
      const legacy = newLegacy(cameraDeviceInfo);
      legacy.get('/stw-cgi/attributes.cgi', undefined, (r) => legacyResults.push(r), (e) => legacyResults.push(e), null);
      FakeXhr.instances[0].respond(200, '');

      FakeXhr.instances = [];
      const portedResults: unknown[] = [];
      const ported = newPorted(cameraDeviceInfo);
      ported.get('/stw-cgi/attributes.cgi', undefined, (r) => portedResults.push(r), (e) => portedResults.push(e), null);
      FakeXhr.instances[0].respond(200, '');

      expect(portedResults).toEqual(legacyResults);
    });

    it('re-sends with a Digest Authorization header after a 401, then reports the retried 200 result identically', () => {
      // generateCnonce() is Math.random()-driven; Math is shared cross-realm
      // by loadLegacyModule (see createLegacyContext), so pinning it here
      // makes legacy's and the port's cnonce (and therefore the whole computed
      // digest response hash) deterministic and comparable.
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      try {
        const legacyResults: unknown[] = [];
        const legacy = newLegacy(cameraDeviceInfo);
        legacy.get('/stw-cgi/attributes.cgi', undefined, (r) => legacyResults.push(r), (e) => legacyResults.push(e), null);
        FakeXhr.instances[0].respond(401, '', {
          'WWW-Authenticate': 'Digest realm="cam", nonce="abc123", qop="auth"'
        });
        const legacyAuthHeader = FakeXhr.instances[0].headers['Authorization'];
        FakeXhr.instances[0].respond(200, JSON.stringify({ Response: 'Success' }));

        FakeXhr.instances = [];
        const portedResults: unknown[] = [];
        const ported = newPorted(cameraDeviceInfo);
        ported.get('/stw-cgi/attributes.cgi', undefined, (r) => portedResults.push(r), (e) => portedResults.push(e), null);
        FakeXhr.instances[0].respond(401, '', {
          'WWW-Authenticate': 'Digest realm="cam", nonce="abc123", qop="auth"'
        });
        const portedAuthHeader = FakeXhr.instances[0].headers['Authorization'];
        FakeXhr.instances[0].respond(200, JSON.stringify({ Response: 'Success' }));

        // Both reuse the SAME xhr instance across the retry (never creating a
        // second one) — this is itself a parity assertion on legacy's actual
        // (somewhat unusual) request-reuse behavior.
        expect(FakeXhr.instances.length).toBe(1);
        expect(portedAuthHeader).toBe(legacyAuthHeader);
        expect(portedResults).toEqual(legacyResults);
      } finally {
        randomSpy.mockRestore();
      }
    });

    it('fails after a second consecutive 401 identically', () => {
      const legacyResults: unknown[] = [];
      const legacy = newLegacy(cameraDeviceInfo);
      legacy.get('/stw-cgi/attributes.cgi', undefined, (r) => legacyResults.push(r), (e) => legacyResults.push(e), null);
      FakeXhr.instances[0].respond(401, '', { 'WWW-Authenticate': 'Digest realm="cam", nonce="abc123", qop="auth"' });
      FakeXhr.instances[0].respond(401, '', { 'WWW-Authenticate': 'Digest realm="cam", nonce="abc123", qop="auth"' });

      FakeXhr.instances = [];
      const portedResults: unknown[] = [];
      const ported = newPorted(cameraDeviceInfo);
      ported.get('/stw-cgi/attributes.cgi', undefined, (r) => portedResults.push(r), (e) => portedResults.push(e), null);
      FakeXhr.instances[0].respond(401, '', { 'WWW-Authenticate': 'Digest realm="cam", nonce="abc123", qop="auth"' });
      FakeXhr.instances[0].respond(401, '', { 'WWW-Authenticate': 'Digest realm="cam", nonce="abc123", qop="auth"' });

      expect(portedResults).toEqual(legacyResults);
    });

    it('reports a 490 (account block) failure identically', () => {
      const legacyResults: unknown[] = [];
      const legacy = newLegacy(cameraDeviceInfo);
      legacy.get('/stw-cgi/attributes.cgi', undefined, (r) => legacyResults.push(r), (e) => legacyResults.push(e), null);
      FakeXhr.instances[0].respond(490, '');

      FakeXhr.instances = [];
      const portedResults: unknown[] = [];
      const ported = newPorted(cameraDeviceInfo);
      ported.get('/stw-cgi/attributes.cgi', undefined, (r) => portedResults.push(r), (e) => portedResults.push(e), null);
      FakeXhr.instances[0].respond(490, '');

      expect(portedResults).toEqual(legacyResults);
    });

    it('reports a generic error status identically', () => {
      const legacyResults: unknown[] = [];
      const legacy = newLegacy(cameraDeviceInfo);
      legacy.get('/stw-cgi/attributes.cgi', undefined, (r) => legacyResults.push(r), (e) => legacyResults.push(e), null);
      FakeXhr.instances[0].respond(500, '');

      FakeXhr.instances = [];
      const portedResults: unknown[] = [];
      const ported = newPorted(cameraDeviceInfo);
      ported.get('/stw-cgi/attributes.cgi', undefined, (r) => portedResults.push(r), (e) => portedResults.push(e), null);
      FakeXhr.instances[0].respond(500, '');

      expect(portedResults).toEqual(legacyResults);
    });

    it('reports an ontimeout failure identically', () => {
      const legacyResults: unknown[] = [];
      const legacy = newLegacy(cameraDeviceInfo);
      legacy.get('/stw-cgi/attributes.cgi', undefined, (r) => legacyResults.push(r), (e) => legacyResults.push(e), null);
      FakeXhr.instances[0].ontimeout?.();

      FakeXhr.instances = [];
      const portedResults: unknown[] = [];
      const ported = newPorted(cameraDeviceInfo);
      ported.get('/stw-cgi/attributes.cgi', undefined, (r) => portedResults.push(r), (e) => portedResults.push(e), null);
      FakeXhr.instances[0].ontimeout?.();

      expect(portedResults).toEqual(legacyResults);
    });
  });

  describe('getAuthInfo / setTimeout', () => {
    it('starts with null auth info and is unaffected by setTimeout, identically', () => {
      const legacy = newLegacy(cameraDeviceInfo);
      const ported = newPorted(cameraDeviceInfo);
      expect(ported.getAuthInfo()).toBe(legacy.getAuthInfo());
      legacy.setTimeout(5000);
      ported.setTimeout(5000);
      expect(ported.getAuthInfo()).toBe(legacy.getAuthInfo());
    });
  });
});
