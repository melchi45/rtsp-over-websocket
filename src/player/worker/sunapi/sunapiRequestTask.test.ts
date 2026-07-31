import { describe, it, expect, vi } from 'vitest';
import CryptoJS from 'crypto-js';
import { loadLegacyModuleExports, type LegacySandbox } from '../../test-support/loadLegacyModule';
import { SunapiRequestTask, type DigestCache } from './sunapiRequestTask';

interface LegacySunapiRequestTaskExports {
  onmessage: (event: { data: unknown }) => void;
  jsonToText: (json: Record<string, unknown>) => string;
  decimalToHex: (d: number | null, padding?: number) => string;
  isJSON: (str: unknown) => boolean;
  getDotEqualStrLineToObj: (data: string) => Record<string, unknown>;
  getDigestInfoInWwwAuthenticate: (wwwAuthenticate: string | null) => DigestCache | false;
  formulateResponse: (username: string, password: string, uri: string, realm: string | null, method: string, nonce: string | null, nc: number | null, cnonce: string | null, qop: string | null) => string;
  setAuthorizationHeader: (xhr: unknown, method: string, uri: string, digestCache: DigestCache) => void;
}

/**
 * Loads sunapiRequestTask.js's top-level state/functions in an isolated vm
 * sandbox. `importScripts(...)` (its very first statement, loading external
 * crypto/URI libs) is stubbed to a no-op since CryptoJS is supplied directly
 * as a sandbox global instead — the only thing this file actually needs from
 * that import for the functions under test.
 */
function loadLegacy(): LegacySunapiRequestTaskExports {
  const sandbox: LegacySandbox = {
    CryptoJS,
    importScripts: () => {},
    postMessage: () => {},
    // Real Worker global scopes provide btoa/atob (used in the 'basic' auth
    // branch); shared here so that branch's *own* ReferenceError (RESdata)
    // surfaces instead of an environment-artifact ReferenceError on btoa
    // itself.
    btoa: globalThis.btoa
  };
  return loadLegacyModuleExports<LegacySunapiRequestTaskExports>(
    'Worker/sunapi/sunapiRequestTask.js',
    ['onmessage', 'jsonToText', 'decimalToHex', 'isJSON', 'getDotEqualStrLineToObj', 'getDigestInfoInWwwAuthenticate', 'formulateResponse', 'setAuthorizationHeader'],
    sandbox
  );
}

function call<T>(instance: SunapiRequestTask, method: string, ...args: unknown[]): T {
  return (instance as unknown as Record<string, (...a: unknown[]) => T>)[method](...args);
}

describe('SunapiRequestTask parity with the legacy player’s Worker/sunapi/sunapiRequestTask.js', () => {
  it('jsonToText builds an identical query string, including the True/False boolean quirk', () => {
    const legacy = loadLegacy();
    const ported = new SunapiRequestTask();
    const json = { a: 1, b: 'x', c: true, d: false };

    expect(call(ported, 'jsonToText', json)).toBe(legacy.jsonToText(json));
  });

  it('decimalToHex pads identically, including null (coerced to 0) and default padding', () => {
    const legacy = loadLegacy();
    const ported = new SunapiRequestTask();

    expect(call(ported, 'decimalToHex', 255, 4)).toBe(legacy.decimalToHex(255, 4));
    expect(call(ported, 'decimalToHex', null, 8)).toBe(legacy.decimalToHex(null, 8));
    expect(call(ported, 'decimalToHex', 10)).toBe(legacy.decimalToHex(10));
  });

  it('isJSON identifies valid/invalid JSON identically', () => {
    const legacy = loadLegacy();
    const ported = new SunapiRequestTask();

    expect(call(ported, 'isJSON', '{"a":1}')).toBe(legacy.isJSON('{"a":1}'));
    expect(call(ported, 'isJSON', 'not json')).toBe(legacy.isJSON('not json'));
    expect(call(ported, 'isJSON', '')).toBe(legacy.isJSON(''));
  });

  it('getDigestInfoInWwwAuthenticate parses scheme/realm/nonce/opaque/qop identically (cnonce excluded — random)', () => {
    const legacy = loadLegacy();
    const ported = new SunapiRequestTask();
    const header = 'Digest realm="test-realm", nonce="abc123", qop="auth", opaque="xyz"';

    const legacyResult = legacy.getDigestInfoInWwwAuthenticate(header) as DigestCache;
    const portedResult = call<DigestCache | false>(ported, 'getDigestInfoInWwwAuthenticate', header) as DigestCache;

    expect(portedResult.scheme).toBe(legacyResult.scheme);
    expect(portedResult.realm).toBe(legacyResult.realm);
    expect(portedResult.nonce).toBe(legacyResult.nonce);
    expect(portedResult.opaque).toBe(legacyResult.opaque);
    expect(portedResult.qop).toBe(legacyResult.qop);
    expect(portedResult.nc).toBe(legacyResult.nc);
    expect(portedResult.nc).toBe(1);
  });

  it('getDigestInfoInWwwAuthenticate returns false for a null header, identically', () => {
    const legacy = loadLegacy();
    const ported = new SunapiRequestTask();

    expect(call(ported, 'getDigestInfoInWwwAuthenticate', null)).toBe(false);
    expect(legacy.getDigestInfoInWwwAuthenticate(null)).toBe(false);
  });

  it('formulateResponse computes an identical MD5 digest response', () => {
    const legacy = loadLegacy();
    const ported = new SunapiRequestTask();
    const args: [string, string, string, string, string, string, number, string, string] = ['admin', 'pw', '/stw-cgi/system.cgi', 'realm1', 'GET', 'nonce1', 1, 'cnonce1', 'auth'];

    expect(call(ported, 'formulateResponse', ...args)).toBe(legacy.formulateResponse(...args));
  });

  it('getDotEqualStrLineToObj throws identically (fastJsonStringfy is not a Worker global)', () => {
    const legacy = loadLegacy();
    const ported = new SunapiRequestTask();
    const raw = 'aaa.bbb.ccc=value1\r\nddd=value2\r\n';

    let legacyMessage = '';
    try {
      legacy.getDotEqualStrLineToObj(raw);
    } catch (error) {
      legacyMessage = (error as Error).message;
    }

    expect(legacyMessage).toBe('fastJsonStringfy is not defined');
    expect(() => call(ported, 'getDotEqualStrLineToObj', raw)).toThrow(legacyMessage);
  });

  it('onMessage (registered as self.onmessage) throws identically on every call (fastJsonStringfy is not a Worker global)', () => {
    const legacy = loadLegacy();
    const ported = new SunapiRequestTask();
    const event = { data: { method: 'get', uri: '/x', deviceInfo: { protocol: 'http', hostname: 'cam', username: 'a', password: 'b' } } };

    let legacyMessage = '';
    try {
      legacy.onmessage(event);
    } catch (error) {
      legacyMessage = (error as Error).message;
    }

    expect(legacyMessage).toBe('fastJsonStringfy is not defined');
    expect(() => ported.onMessage(event)).toThrow(legacyMessage);
  });

  it('setAuthorizationHeader with a "basic" scheme throws identically (RESdata is never declared — the crash happens before `data` is ever read)', () => {
    const legacy = loadLegacy();
    const ported = new SunapiRequestTask();

    const fakeXhr = { setRequestHeader: vi.fn() };
    const digestCache: DigestCache = { scheme: 'Basic', realm: '', nonce: null, opaque: null, qop: null, nc: null, cnonce: null };

    let legacyMessage = '';
    try {
      legacy.setAuthorizationHeader(fakeXhr, 'GET', '/x', digestCache);
    } catch (error) {
      legacyMessage = (error as Error).message;
    }

    expect(legacyMessage).toBe('RESdata is not defined');
    expect(() => call(ported, 'setAuthorizationHeader', fakeXhr, 'GET', '/x', digestCache)).toThrow(legacyMessage);
  });
});
