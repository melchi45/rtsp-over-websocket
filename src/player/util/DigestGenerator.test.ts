import { describe, expect, it } from 'vitest';
import CryptoJS from 'crypto-js';
import { DigestGenerator, computeDigestResponseCandidates, resolveDigestHashType, type AuthenticateData } from './DigestGenerator';

function baseData(overrides: Partial<AuthenticateData> = {}): AuthenticateData {
  return {
    username: 'Mufasa',
    Realm: 'http-auth@example.org',
    password: 'Circle of Life',
    Method: 'DESCRIBE',
    Uri: 'rtsp://example.org/dir/index.smp',
    Nonce: '7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v',
    ...overrides
  };
}

describe('DigestGenerator', () => {
  describe('Digest() — algorithm selection (RFC 7616 §3.4.2, RFC 7826 §19.1.1)', () => {
    it('hashes with MD5 when Algorithm is absent (RFC 7616 §3.3 default)', () => {
      const generator = new DigestGenerator();
      generator.authenticateData = baseData();
      const expected = CryptoJS.MD5(
        `${CryptoJS.MD5('Mufasa:http-auth@example.org:Circle of Life').toString()}:7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v:${CryptoJS.MD5(`DESCRIBE:rtsp://example.org/dir/index.smp`).toString()}`
      ).toString();
      expect(generator.Digest()).toBe(expected);
    });

    it('hashes with MD5 when Algorithm is exactly "MD5"', () => {
      const generator = new DigestGenerator();
      generator.authenticateData = baseData({ Algorithm: 'MD5' });
      const ha1 = CryptoJS.MD5('Mufasa:http-auth@example.org:Circle of Life').toString();
      const ha2 = CryptoJS.MD5('DESCRIBE:rtsp://example.org/dir/index.smp').toString();
      expect(generator.Digest()).toBe(CryptoJS.MD5(`${ha1}:7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v:${ha2}`).toString());
    });

    it('hashes with MD5 case-insensitively ("md5")', () => {
      const generator = new DigestGenerator();
      generator.authenticateData = baseData({ Algorithm: 'md5' });
      const ha1 = CryptoJS.MD5('Mufasa:http-auth@example.org:Circle of Life').toString();
      const ha2 = CryptoJS.MD5('DESCRIBE:rtsp://example.org/dir/index.smp').toString();
      expect(generator.Digest()).toBe(CryptoJS.MD5(`${ha1}:7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v:${ha2}`).toString());
    });

    it('hashes with SHA-256 when Algorithm is "SHA-256"', () => {
      const generator = new DigestGenerator();
      generator.authenticateData = baseData({ Algorithm: 'SHA-256' });
      const ha1 = CryptoJS.SHA256('Mufasa:http-auth@example.org:Circle of Life').toString();
      const ha2 = CryptoJS.SHA256('DESCRIBE:rtsp://example.org/dir/index.smp').toString();
      expect(generator.Digest()).toBe(CryptoJS.SHA256(`${ha1}:7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v:${ha2}`).toString());
    });

    it('does not confuse an unsupported algorithm token with MD5 (falls to the SHA256 branch)', () => {
      const generator = new DigestGenerator();
      generator.authenticateData = baseData({ Algorithm: 'SHA-512-256' });
      const ha1 = CryptoJS.SHA256('Mufasa:http-auth@example.org:Circle of Life').toString();
      const ha2 = CryptoJS.SHA256('DESCRIBE:rtsp://example.org/dir/index.smp').toString();
      expect(generator.Digest()).toBe(CryptoJS.SHA256(`${ha1}:7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v:${ha2}`).toString());
    });
  });

  describe('Digest() — response formula selection (RFC 7616 §3.4.1/§3.4.3)', () => {
    it('uses the plain ha1:nonce:ha2 formula when Qop is absent, regardless of Algorithm/Opaque', () => {
      const generator = new DigestGenerator();
      generator.authenticateData = baseData({ Algorithm: 'SHA-256', Opaque: null });
      const ha1 = CryptoJS.SHA256('Mufasa:http-auth@example.org:Circle of Life').toString();
      const ha2 = CryptoJS.SHA256('DESCRIBE:rtsp://example.org/dir/index.smp').toString();
      expect(generator.Digest()).toBe(CryptoJS.SHA256(`${ha1}:7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v:${ha2}`).toString());
    });

    it('uses the qop-based formula when Qop is present even without Opaque', () => {
      const generator = new DigestGenerator();
      generator.authenticateData = baseData({ Algorithm: 'SHA-256', Qop: 'auth', Opaque: null });
      // cnonce/nc are regenerated as a side effect inside Digest(), so read them back afterwards.
      const actual = generator.Digest();
      const ha1 = CryptoJS.SHA256('Mufasa:http-auth@example.org:Circle of Life').toString();
      const ha2 = CryptoJS.SHA256('DESCRIBE:rtsp://example.org/dir/index.smp').toString();
      const expected = CryptoJS.SHA256(
        `${ha1}:7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v:00000001:${generator.cnonce}:auth:${ha2}`
      ).toString();
      expect(actual).toBe(expected);
    });
  });

  describe('getAuthenticate() — Authorization header shape (RFC 7616 §3.4/§3.4.5)', () => {
    it('quotes username/realm/uri/nonce/response but leaves algorithm/qop/nc unquoted, and omits nc/cnonce/qop entirely when there is no qop', () => {
      const generator = new DigestGenerator();
      const data = baseData({ Algorithm: 'MD5' });
      const header = generator.getAuthenticate(data, 'deadbeef');

      expect(header).toContain('username="Mufasa"');
      expect(header).toContain('realm="http-auth@example.org"');
      expect(header).toContain('nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v"');
      expect(header).toContain('algorithm=MD5');
      expect(header).not.toContain('algorithm="MD5"');
      expect(header).toContain('response="deadbeef"');
      expect(header).not.toContain('qop=');
      expect(header).not.toContain('nc=');
      expect(header).not.toContain('cnonce=');
    });

    it('includes unquoted nc/qop and quoted cnonce when Qop is present', () => {
      const generator = new DigestGenerator();
      const data = baseData({ Algorithm: 'SHA-256', Qop: 'auth', Opaque: 'FQhe/qaU925' });
      const header = generator.getAuthenticate(data, 'deadbeef');

      expect(header).toContain('algorithm=SHA-256');
      expect(header).toContain('opaque="FQhe/qaU925"');
      expect(header).toMatch(/nc=[0-9a-f]{8}(?!")/);
      expect(header).toContain(`cnonce="${generator.cnonce}"`);
      expect(header).toContain('qop=auth');
      expect(header).not.toContain('qop="auth"');
    });

    it('echoes algorithm/opaque independently — algorithm present without opaque still shows up', () => {
      const generator = new DigestGenerator();
      const data = baseData({ Algorithm: 'SHA-256', Opaque: null });
      const header = generator.getAuthenticate(data, 'deadbeef');

      expect(header).toContain('algorithm=SHA-256');
      expect(header).not.toContain('opaque=');
    });
  });

  describe('parseWWWAuthenticate() — RFC 7616 §3.3 challenge parsing', () => {
    it('parses an unquoted algorithm token (the actual wire format per RFC 7616 §3.9.1)', () => {
      const generator = new DigestGenerator();
      const parsed = generator.parseWWWAuthenticate(
        'Digest realm="http-auth@example.org", qop="auth, auth-int", algorithm=SHA-256, nonce="abc", opaque="xyz"'
      );
      expect(parsed.algorithm).toBe('SHA-256');
      expect(parsed.realm).toBe('http-auth@example.org');
      expect(parsed.nonce).toBe('abc');
      expect(parsed.opaque).toBe('xyz');
      expect(parsed.qop).toBe('auth, auth-int');
    });

    it('parses MD5 as an unquoted token too', () => {
      const generator = new DigestGenerator();
      const parsed = generator.parseWWWAuthenticate('Digest realm="r", qop="auth", algorithm=MD5, nonce="n"');
      expect(parsed.algorithm).toBe('MD5');
    });

    it('tolerates a nonstandard quoted algorithm value', () => {
      const generator = new DigestGenerator();
      const parsed = generator.parseWWWAuthenticate('Digest realm="r", algorithm="SHA-256", nonce="n"');
      expect(parsed.algorithm).toBe('SHA-256');
    });

    it('leaves algorithm null when the challenge omits it (defaults to MD5 elsewhere)', () => {
      const generator = new DigestGenerator();
      const parsed = generator.parseWWWAuthenticate('Digest realm="r", nonce="n", qop="auth"');
      expect(parsed.algorithm).toBeNull();
    });
  });

  describe('resolveDigestHashType()', () => {
    it('defaults to MD5 when algorithm is absent/null/undefined', () => {
      expect(resolveDigestHashType(undefined)).toBe('MD5');
      expect(resolveDigestHashType(null)).toBe('MD5');
    });

    it('resolves MD5 case-insensitively', () => {
      expect(resolveDigestHashType('MD5')).toBe('MD5');
      expect(resolveDigestHashType('md5')).toBe('MD5');
    });

    it('treats any other non-empty value as SHA-256', () => {
      expect(resolveDigestHashType('SHA-256')).toBe('SHA256');
      expect(resolveDigestHashType('SHA-512-256')).toBe('SHA256');
    });
  });

  describe('computeDigestResponseCandidates() — SUNAPI-delegated response-shape detection', () => {
    // Shape (username/realm/method/nonce/qop/nc/cnonce) matches a real
    // exchange captured live against two actual devices whose SUNAPI
    // `security.cgi?msubmenu=digestauth&action=view` helper endpoints
    // disagree on whether they honor the Qop/Nc/Cnonce hints they're given
    // (see RtspClient.ts's formDigestAuthHeader() SUNAPI branch and
    // MEMORY.md) — one computes the qop-based response correctly, the
    // other silently always returns the plain one instead. Host/credentials
    // replaced with placeholders; expected hashes recomputed to match.
    const data: AuthenticateData = {
      username: 'admin',
      Realm: 'TestRealm',
      password: 'hunter2',
      Method: 'OPTIONS',
      Uri: 'rtsp://camera.example.org/0/H.264/media.smp',
      Nonce: '56FCB6476C07FE606E48D0F7F107C2FB',
      Qop: 'auth'
    };
    const nc = '00000001';
    const cnonce = '0rUb8Lj5';

    it('computes the plain formula matching a device that ignores Qop/Nc/Cnonce', () => {
      const candidates = computeDigestResponseCandidates(data, nc, cnonce);
      expect(candidates.plain).toBe('cc901c489b5762ad21143d00d1997a91');
    });

    it('computes the qop-based formula matching a device that honors Qop/Nc/Cnonce', () => {
      const candidates = computeDigestResponseCandidates(data, nc, cnonce);
      expect(candidates.qopBased).toBe('b258b0b458de7893ab1c2b2fd800e391');
    });

    it('the two candidates are never equal for a real qop-bearing challenge', () => {
      const candidates = computeDigestResponseCandidates(data, nc, cnonce);
      expect(candidates.plain).not.toBe(candidates.qopBased);
    });

    it('is pure -- repeated calls with the same inputs return the same result', () => {
      expect(computeDigestResponseCandidates(data, nc, cnonce)).toEqual(computeDigestResponseCandidates(data, nc, cnonce));
    });
  });
});
