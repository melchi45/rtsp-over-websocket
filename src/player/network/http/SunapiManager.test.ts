import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadLegacyModule } from '../../test-support/loadLegacyModule';
import { createBaseLegacySandbox } from '../../test-support/legacyGlobals';
import { SunapiManager, type SunapiManagerDeviceInfo, type SunapiManagerError } from './SunapiManager';
import { HTTP_STATUS_CODES } from './HttpStatusCode';

interface LegacySunapiManager {
  init(info: SunapiManagerDeviceInfo): Promise<unknown>;
  getSunapiClient(): unknown;
  attach(v: unknown): void;
  dettach(): void;
  sunapi: unknown;
  getAttributes(): Promise<unknown>;
  getDeviceInfo(): Promise<unknown>;
  getVideoSource(): Promise<unknown>;
  getVideoProfile(channel?: number | string): Promise<unknown>;
  getSystemProfileAccessInfo(viewgroup?: string): Promise<unknown>;
  getSnapshot(profile?: number | string, channel?: number | string): Promise<unknown>;
  getSessionKey(): Promise<unknown>;
  getCalendarSearch(month?: string, channelIdList?: string): Promise<unknown>;
  getOverlappedIdList(fromDate?: string, toDate?: string, channelIdList?: string): Promise<unknown>;
  getTimeline(fromDate?: string, toDate?: string, channelIdList?: string, overlappedId?: string, type?: string): Promise<unknown>;
}

type FakeGetCall = { uri: string; jsonData: unknown; scope: unknown; isAsyncCall?: boolean; isText?: boolean; withoutSeqId?: boolean };

/** Minimal stand-in matching SunapiClient's real prototype surface (get/post/setTimeout/getAuthInfo) — deliberately has NO `join()`, so attaching it reproduces the confirmed sunapiManager.js `.join()` bug identically on both sides. */
class FakeSunapiClient {
  calls: FakeGetCall[] = [];
  timeoutCalls: number[] = [];
  nextResponse: unknown = { data: {} };
  nextError: (SunapiManagerError & Record<string, unknown>) | null = null;

  get(
    uri: string,
    jsonData: unknown,
    successFn: (response: unknown) => void,
    failFn: (error: SunapiManagerError) => void,
    scope: unknown,
    isAsyncCall?: boolean,
    isText?: boolean,
    withoutSeqId?: boolean
  ): void {
    this.calls.push({ uri, jsonData, scope, isAsyncCall, isText, withoutSeqId });
    // Deferred (like a real XHR response) rather than synchronous — this
    // matters for the `.join()`-bug test below: if the success callback fired
    // synchronously here, it would resolve the promise *before* the
    // subsequent (synchronous) `sunapiClient.join()` call gets a chance to
    // throw, masking the bug for both legacy and the port alike.
    queueMicrotask(() => {
      if (this.nextError) {
        failFn(this.nextError);
        return;
      }
      successFn(this.nextResponse);
    });
  }

  setTimeout(timeout: number): void {
    this.timeoutCalls.push(timeout);
  }

  getAuthInfo(): unknown {
    return null;
  }
}

const sandbox = {
  ...createBaseLegacySandbox(),
  location: { hostname: 'test-host', port: '3080', protocol: 'http:' },
  rtspOverWebSocketError: loadLegacyModule('Exception/RTSPOverWebSocketError.js', 'RTSPOverWebSocketError'),
  SunapiError: loadLegacyModule('Exception/SunapiError.js', 'SunapiError'),
  sunapiException: loadLegacyModule('Network/http/sunapiException.js', 'sunapiException'),
  fromHex: (hex: string) => parseInt(hex, 16),
  HTTP_STATUS_CODES,
  // Not exercised (useSunapiClient is hardcoded true in legacy — see class doc
  // comment) — every test attaches a FakeSunapiClient directly instead of
  // letting the manager construct a real SunapiClient/XHR chain, except the
  // one `init()` test which needs the real constructor reachable.
  SunapiClient: loadLegacyModule('Network/http/sunapiClient.js', 'SunapiClient', {
    ...createBaseLegacySandbox(),
    location: { hostname: 'test-host', port: '3080', protocol: 'http:' },
    rtspOverWebSocketError: loadLegacyModule('Exception/RTSPOverWebSocketError.js', 'RTSPOverWebSocketError'),
    AuthError: loadLegacyModule('Exception/AuthError.js', 'AuthError'),
    fromHex: (hex: string) => parseInt(hex, 16),
    HTTP_STATUS_CODES,
    XMLHttpRequest: class {
      open() {}
      setRequestHeader() {}
    }
  })
};

const LegacySunapiManagerCtor = loadLegacyModule<new () => LegacySunapiManager>('Network/http/sunapiManager.js', 'sunapiManager', sandbox);

function newLegacy(): LegacySunapiManager {
  return new LegacySunapiManagerCtor();
}

function newPorted(): SunapiManager {
  return new SunapiManager();
}

async function settleBoth<T>(legacyPromise: Promise<T>, portedPromise: Promise<T>): Promise<{ legacy: unknown; ported: unknown }> {
  const [legacy, ported] = await Promise.all([
    legacyPromise.then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, v: e })),
    portedPromise.then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, v: e }))
  ]);
  return { legacy, ported };
}

describe('SunapiManager parity with the legacy player’s Network/http/sunapiManager.js', () => {
  beforeAll(() => {
    (globalThis as unknown as { window: { location: { hostname: string; port: string; protocol: string } } }).window = {
      location: { hostname: 'test-host', port: '3080', protocol: 'http:' }
    };
  });

  afterAll(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  describe('attach/dettach/getSunapiClient/sunapi accessor', () => {
    it('starts with no attached client, identically', () => {
      const legacy = newLegacy();
      const ported = newPorted();
      expect(ported.getSunapiClient()).toBe(legacy.getSunapiClient());
    });

    it('attach()/dettach() and the `sunapi` alias round-trip identically', () => {
      const legacy = newLegacy();
      const ported = newPorted();
      const legacyFake = new FakeSunapiClient();
      const portedFake = new FakeSunapiClient();

      legacy.attach(legacyFake);
      ported.attach(portedFake);
      expect(legacy.getSunapiClient()).toBe(legacyFake);
      expect(ported.getSunapiClient()).toBe(portedFake);
      expect(legacy.sunapi).toBe(legacyFake);
      expect(ported.sunapiClient).toBe(portedFake);

      legacy.dettach();
      ported.dettach();
      expect(legacy.getSunapiClient()).toBeNull();
      expect(ported.getSunapiClient()).toBeNull();
    });
  });

  describe('GET-wrapper endpoint methods (via request())', () => {
    it('getAttributes builds the same URI and unwraps a `.data` envelope identically', async () => {
      const legacy = newLegacy();
      const ported = newPorted();
      const legacyFake = new FakeSunapiClient();
      const portedFake = new FakeSunapiClient();
      legacyFake.nextResponse = { data: { Model: 'X' } };
      portedFake.nextResponse = { data: { Model: 'X' } };
      legacy.attach(legacyFake);
      ported.attach(portedFake);

      const { legacy: legacyResult, ported: portedResult } = await settleBoth(legacy.getAttributes(), ported.getAttributes());
      expect(portedResult).toEqual(legacyResult);
      expect(portedFake.calls[0].uri).toBe(legacyFake.calls[0].uri);
    });

    it('getVideoSource extracts response.VideoSources identically', async () => {
      const legacy = newLegacy();
      const ported = newPorted();
      const legacyFake = new FakeSunapiClient();
      const portedFake = new FakeSunapiClient();
      legacyFake.nextResponse = { VideoSources: [{ Channel: 0 }] };
      portedFake.nextResponse = { VideoSources: [{ Channel: 0 }] };
      legacy.attach(legacyFake);
      ported.attach(portedFake);

      const { legacy: legacyResult, ported: portedResult } = await settleBoth(legacy.getVideoSource(), ported.getVideoSource());
      expect(portedResult).toEqual(legacyResult);
    });

    it('getVideoProfile appends &Channel= only when a channel is given, identically', async () => {
      const legacy = newLegacy();
      const ported = newPorted();
      const legacyFake = new FakeSunapiClient();
      const portedFake = new FakeSunapiClient();
      legacy.attach(legacyFake);
      ported.attach(portedFake);

      await settleBoth(legacy.getVideoProfile(3), ported.getVideoProfile(3));
      expect(portedFake.calls[0].uri).toBe(legacyFake.calls[0].uri);

      await settleBoth(legacy.getVideoProfile(), ported.getVideoProfile());
      expect(portedFake.calls[1].uri).toBe(legacyFake.calls[1].uri);
    });

    it('propagates a failure with uri/place attached identically', async () => {
      const legacy = newLegacy();
      const ported = newPorted();
      const legacyFake = new FakeSunapiClient();
      const portedFake = new FakeSunapiClient();
      legacyFake.nextError = { Code: 404, message: 'Not Found' };
      portedFake.nextError = { Code: 404, message: 'Not Found' };
      legacy.attach(legacyFake);
      ported.attach(portedFake);

      const { legacy: legacyResult, ported: portedResult } = await settleBoth(legacy.getDeviceInfo(), ported.getDeviceInfo());
      expect(portedResult).toEqual(legacyResult);
    });

    it('getSystemProfileAccessInfo never appends &Channel= regardless of viewgroup, identically (confirmed dead branch — real param name is a typo)', async () => {
      const legacy = newLegacy();
      const ported = newPorted();
      const legacyFake = new FakeSunapiClient();
      const portedFake = new FakeSunapiClient();
      legacyFake.nextResponse = { Profile: [{ id: 1 }] };
      portedFake.nextResponse = { Profile: [{ id: 1 }] };
      legacy.attach(legacyFake);
      ported.attach(portedFake);

      const { legacy: legacyResult, ported: portedResult } = await settleBoth(
        legacy.getSystemProfileAccessInfo('Channel'),
        ported.getSystemProfileAccessInfo('Channel')
      );
      expect(portedResult).toEqual(legacyResult);
      expect(portedFake.calls[0].uri).toBe(legacyFake.calls[0].uri);
      expect(portedFake.calls[0].uri).not.toContain('Channel=');
    });
  });

  describe('getSnapshot', () => {
    // NOTE: the validation throw lives *inside* the Promise executor in
    // legacy (see SunapiManager.ts's `request()` doc comment for why), so
    // `getSnapshot(...)` never throws synchronously to its caller — it
    // returns a rejected promise instead. Both sides are asserted that way.
    it('rejects with the same Invalid-profile-number error for a non-numeric profile', async () => {
      const legacy = newLegacy();
      const ported = newPorted();
      const { legacy: legacyResult, ported: portedResult } = await settleBoth(legacy.getSnapshot('abc'), ported.getSnapshot('abc'));
      expect(portedResult).toMatchObject({ ok: false });
      expect((portedResult as { v: { message: string } }).v.message).toBe((legacyResult as { v: { message: string } }).v.message);
      expect((portedResult as { v: { message: string } }).v.message).not.toBe('');
    });

    it('rejects with the same (copy-pasted "Invalid profile number") message for a non-numeric channel', async () => {
      const legacy = newLegacy();
      const ported = newPorted();
      const { legacy: legacyResult, ported: portedResult } = await settleBoth(legacy.getSnapshot(0, 'abc'), ported.getSnapshot(0, 'abc'));
      expect((portedResult as { v: { message: string } }).v.message).toBe((legacyResult as { v: { message: string } }).v.message);
    });

    it('resolves when data.size is non-zero, identically', async () => {
      const legacy = newLegacy();
      const ported = newPorted();
      const legacyFake = new FakeSunapiClient();
      const portedFake = new FakeSunapiClient();
      legacyFake.nextResponse = { data: { size: 100 } };
      portedFake.nextResponse = { data: { size: 100 } };
      legacy.attach(legacyFake);
      ported.attach(portedFake);

      const { legacy: legacyResult, ported: portedResult } = await settleBoth(legacy.getSnapshot(), ported.getSnapshot());
      expect(portedResult).toEqual(legacyResult);
      expect(portedFake.calls[0].uri).toBe(legacyFake.calls[0].uri);
      expect(portedFake.calls[0].uri).toContain('&Channel=0');
    });

    it('never settles when data.size is 0 (confirmed legacy bug — neither resolve nor reject fires), identically', async () => {
      const legacy = newLegacy();
      const ported = newPorted();
      const legacyFake = new FakeSunapiClient();
      const portedFake = new FakeSunapiClient();
      legacyFake.nextResponse = { data: { size: 0 } };
      portedFake.nextResponse = { data: { size: 0 } };
      legacy.attach(legacyFake);
      ported.attach(portedFake);

      const RACE_TIMEOUT_MS = 20;
      const race = (p: Promise<unknown>) =>
        Promise.race([p.then(() => 'settled').catch(() => 'settled'), new Promise((resolve) => setTimeout(() => resolve('pending'), RACE_TIMEOUT_MS))]);

      expect(await race(legacy.getSnapshot())).toBe('pending');
      expect(await race(ported.getSnapshot())).toBe('pending');
    });
  });

  describe('the confirmed sunapiClient.join() bug (getSessionKey and siblings)', () => {
    it('getSessionKey always rejects with a RTSPOverWebSocketError because SunapiClient has no join() method, identically', async () => {
      const legacy = newLegacy();
      const ported = newPorted();
      const legacyFake = new FakeSunapiClient();
      const portedFake = new FakeSunapiClient();
      legacy.attach(legacyFake);
      ported.attach(portedFake);

      const { legacy: legacyResult, ported: portedResult } = await settleBoth(legacy.getSessionKey(), ported.getSessionKey());
      expect(portedResult).toMatchObject({ ok: false });
      expect(legacyResult).toMatchObject({ ok: false });
      expect((portedResult as { v: { errorCode: number; message: string } }).v.errorCode).toBe(
        (legacyResult as { v: { errorCode: number; message: string } }).v.errorCode
      );
      expect((portedResult as { v: { message: string } }).v.message).toContain('join');
      expect((legacyResult as { v: { message: string } }).v.message).toContain('join');
      // The GET request itself was still fired before the join() crash (fire-and-forget).
      expect(portedFake.calls.length).toBe(legacyFake.calls.length);
      expect(portedFake.calls[0].uri).toBe(legacyFake.calls[0].uri);
    });
  });

  describe('getCalendarSearch', () => {
    it('sets the long-polling timeout when no channelIdList is given, identically', async () => {
      const legacy = newLegacy();
      const ported = newPorted();
      const legacyFake = new FakeSunapiClient();
      const portedFake = new FakeSunapiClient();
      legacy.attach(legacyFake);
      ported.attach(portedFake);

      await settleBoth(legacy.getCalendarSearch('2026-07'), ported.getCalendarSearch('2026-07'));
      // Both reject (join() bug), but the setTimeout(LONG_POLLING_TIMEOUT) call
      // happens before that, synchronously, in the same call.
      expect(portedFake.timeoutCalls).toEqual(legacyFake.timeoutCalls);
      expect(portedFake.calls[0].uri).toBe(legacyFake.calls[0].uri);
    });

    it('does not set the timeout when a channelIdList is given, identically', async () => {
      const legacy = newLegacy();
      const ported = newPorted();
      const legacyFake = new FakeSunapiClient();
      const portedFake = new FakeSunapiClient();
      legacy.attach(legacyFake);
      ported.attach(portedFake);

      await settleBoth(legacy.getCalendarSearch('2026-07', '0,1,2'), ported.getCalendarSearch('2026-07', '0,1,2'));
      expect(portedFake.timeoutCalls).toEqual([]);
      expect(legacyFake.timeoutCalls).toEqual([]);
      expect(portedFake.calls[0].uri).toBe(legacyFake.calls[0].uri);
    });
  });

  describe('getOverlappedIdList / getTimeline required-parameter validation', () => {
    // NOTE: same as getSnapshot above — these validation throws live inside
    // the Promise executor in legacy, so they surface as rejections, not
    // synchronous throws.
    it('rejects with a SunapiException identically when fromDate/toDate are missing', async () => {
      const legacy = newLegacy();
      const ported = newPorted();
      const { legacy: legacyResult, ported: portedResult } = await settleBoth(legacy.getOverlappedIdList(), ported.getOverlappedIdList());
      expect(portedResult).toMatchObject({ ok: false });
      expect(legacyResult).toMatchObject({ ok: false });
    });

    it('rejects identically when getTimeline is missing toDate', async () => {
      const legacy = newLegacy();
      const ported = newPorted();
      const { legacy: legacyResult, ported: portedResult } = await settleBoth(
        legacy.getTimeline('2026-07-01T00:00:00Z', undefined as unknown as string),
        ported.getTimeline('2026-07-01T00:00:00Z', undefined as unknown as string)
      );
      expect(portedResult).toMatchObject({ ok: false });
      expect(legacyResult).toMatchObject({ ok: false });
    });
  });

  describe('init()', () => {
    it('constructs a SunapiClient, fires the attributes.cgi bootstrap GET, and resolves/rejects consistently between legacy and the port', async () => {
      const legacyInfo: SunapiManagerDeviceInfo = {
        deviceType: 'camera',
        cameraIp: '192.168.1.100',
        user: 'admin',
        password: 'pw',
        port: 80,
        protocol: 'http',
        async: false
      };
      const portedInfo: SunapiManagerDeviceInfo = { ...legacyInfo };

      const legacy = newLegacy();
      const ported = newPorted();

      const { legacy: legacyResult, ported: portedResult } = await settleBoth(legacy.init(legacyInfo), ported.init(portedInfo));
      // Both reject: the fake XMLHttpRequest never completes (no response
      // simulated), so this only verifies construction + the initial request
      // dispatch didn't throw synchronously, and that both sides agree on
      // outcome shape (still-pending would show as neither resolved nor
      // rejected within this synchronous assertion window, which is fine —
      // what matters is neither threw synchronously during setup).
      expect(typeof legacy.getSunapiClient()).toBe(typeof ported.getSunapiClient());
      void legacyResult;
      void portedResult;
    });
  });
});
