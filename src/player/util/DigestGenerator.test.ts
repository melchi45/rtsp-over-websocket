import { describe, it, expect, vi } from 'vitest';
import { loadLegacyModule } from '../test-support/loadLegacyModule';
import { createBaseLegacySandbox } from '../test-support/legacyGlobals';
import { DigestGenerator, type AuthenticateData } from './DigestGenerator';

interface LegacyDigestGenerator {
  nc: number;
  cnonce: string;
  authenticateData: AuthenticateData | null;
  digestSchema(type: unknown, str: string): string;
  Digest(): string;
  getAuthenticate(data?: AuthenticateData | null, response?: string | null): string;
  getDigestInfoInWwwAuthenticate(wwwAuthenticate: string): unknown[];
  parseWWWAuthenticate(authenticateString: string): unknown;
}

// digestGenerator.js relies on the Object.prototype.Enum polyfill (hashType.Enum(...))
// and the global CryptoJS/decimalToHex from util.js — supplied here verbatim.
const LegacyDigestGeneratorCtor = loadLegacyModule<new () => LegacyDigestGenerator>(
  'Util/digestGenerator.js',
  'DigestGenerator',
  createBaseLegacySandbox()
);

const baseAuth: AuthenticateData = {
  username: 'admin',
  Realm: 'HanwhaVision',
  password: 'password',
  Method: 'GET',
  Uri: '/stw-cgi/attributes.cgi',
  Nonce: 'abc123nonce'
};

describe('DigestGenerator parity with the legacy player’s Util/digestGenerator.js', () => {
  it('digestSchema produces the same MD5/SHA256 hex for the same input', () => {
    const legacy = new LegacyDigestGeneratorCtor();
    const ported = new DigestGenerator();
    // Legacy digestSchema's `type` param is the numeric hashType.Enum('MD5', 'SHA256')
    // index (MD5=0, SHA256=1), not the string literal the ported version uses.
    expect(ported.digestSchema('MD5', 'hello:world')).toBe(legacy.digestSchema(0 as never, 'hello:world'));
    expect(ported.digestSchema('SHA256', 'hello:world')).toBe(legacy.digestSchema(1 as never, 'hello:world'));
  });

  it('Digest() matches on the non-Qop branch (no cnonce/nc dependency)', () => {
    const legacy = new LegacyDigestGeneratorCtor();
    const ported = new DigestGenerator();
    legacy.authenticateData = { ...baseAuth };
    ported.authenticateData = { ...baseAuth };

    expect(ported.Digest()).toBe(legacy.Digest());
  });

  it('Digest()/getAuthenticate() match on the Qop branch once randomness is pinned', () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.42);
    try {
      const legacy = new LegacyDigestGeneratorCtor();
      const ported = new DigestGenerator();
      const qopAuth: AuthenticateData = { ...baseAuth, Qop: 'auth', Algorithm: 'MD5', Opaque: 'opaque-token' };
      legacy.authenticateData = { ...qopAuth };
      ported.authenticateData = { ...qopAuth };

      expect(ported.Digest()).toBe(legacy.Digest());
      expect(ported.cnonce).toBe(legacy.cnonce);
      expect(ported.nc).toBe(legacy.nc);

      // getAuthenticate() re-derives the header from scratch; pin randomness again for its internal Digest() call.
      randomSpy.mockReturnValue(0.17);
      expect(ported.getAuthenticate(qopAuth)).toBe(legacy.getAuthenticate(qopAuth));
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('getAuthenticate() with an explicit response string skips Digest() entirely', () => {
    const legacy = new LegacyDigestGeneratorCtor();
    const ported = new DigestGenerator();
    expect(ported.getAuthenticate(baseAuth, 'precomputed-response')).toBe(
      legacy.getAuthenticate(baseAuth, 'precomputed-response')
    );
  });

  it('parseWWWAuthenticate extracts the same fields', () => {
    const legacy = new LegacyDigestGeneratorCtor();
    const ported = new DigestGenerator();
    const header = 'Digest realm="HanwhaVision", nonce="abc123", qop="auth", algorithm="MD5", opaque="xyz"';
    expect(ported.parseWWWAuthenticate(header)).toEqual(legacy.parseWWWAuthenticate(header));
  });

  it('getDigestInfoInWwwAuthenticate splits multi-line headers identically', () => {
    const legacy = new LegacyDigestGeneratorCtor();
    const ported = new DigestGenerator();
    const header = 'Basic realm="Foo"\r\nDigest realm="Bar", nonce="n1"';
    expect(ported.getDigestInfoInWwwAuthenticate(header)).toEqual(legacy.getDigestInfoInWwwAuthenticate(header));
  });
});
