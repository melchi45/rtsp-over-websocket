import CryptoJS from 'crypto-js';

export type HashType = 'MD5' | 'SHA256';

export interface AuthenticateData {
  username: string;
  Realm: string;
  password: string;
  Method: string;
  Uri: string;
  Nonce: string;
  Qop?: string | null;
  Algorithm?: string | null;
  Opaque?: string | null;
}

export interface ParsedWwwAuthenticate {
  method: string | null;
  realm: string | null;
  nonce: string | null;
  opaque: string | null;
  algorithm: string | null;
  qop: string | null;
}

/** Verbatim port of window.decimalToHex from the legacy player’s Util/util (~line 892). */
function decimalToHex(dec: number, padding = 2): string {
  let hex = Number(dec).toString(16);
  while (hex.length < padding) {
    hex = '0' + hex;
  }
  return hex;
}

function hashWith(type: HashType, str: string): string {
  return type === 'MD5' ? CryptoJS.MD5(str).toString() : CryptoJS.SHA256(str).toString();
}

/**
 * Resolves which hash algorithm a challenge's `algorithm` value selects —
 * MD5 is the default (absent) and case-insensitive-`'MD5'` case, anything
 * else non-empty is treated as SHA-256 (see `Digest()`'s own doc comment on
 * why this is broader than RFC 7616's actual `algorithm` value set).
 * Exported so callers besides `Digest()` (`RtspClient.ts`'s SUNAPI-delegated
 * path) can compute a response candidate without duplicating this rule.
 */
export function resolveDigestHashType(algorithm: string | null | undefined): HashType {
  return typeof algorithm !== 'string' || algorithm.toUpperCase() === 'MD5' ? 'MD5' : 'SHA256';
}

/**
 * Computes both response formulas RFC 7616 §3.4.1 defines (qop-based and
 * plain) for the same `data`/`nc`/`cnonce`, without touching `nc`/`cnonce`
 * state the way `Digest()` does. Used by `RtspClient.ts`'s SUNAPI-delegated
 * digest path to detect *which* formula a device's own digest-computing
 * helper endpoint actually used for an externally-supplied response value —
 * confirmed live against two real devices that this isn't a hypothetical:
 * one's helper endpoint correctly honors the `Qop`/`Nc`/`Cnonce` it's given
 * and returns the qop-based response, the other silently ignores them and
 * always returns the plain one, and neither difference is discoverable
 * except by comparing the returned value against both candidates.
 */
export function computeDigestResponseCandidates(data: AuthenticateData, nc: string, cnonce: string): { qopBased: string; plain: string } {
  const type = resolveDigestHashType(data.Algorithm);
  const ha1 = hashWith(type, `${data.username}:${data.Realm}:${data.password}`);
  const ha2 = hashWith(type, `${data.Method}:${decodeURIComponent(data.Uri)}`);
  const qop = data.Qop ?? '';
  return {
    qopBased: hashWith(type, `${ha1}:${data.Nonce}:${nc}:${cnonce}:${qop}:${ha2}`),
    plain: hashWith(type, `${ha1}:${data.Nonce}:${ha2}`)
  };
}

/**
 * Ported from the legacy player’s Util/digestGenerator (HTTP Digest auth per RFC 2617).
 * `makeNonceCount()` and the unused `infoWWWAuthenticate` parameter of `Digest()`
 * were dead code in the legacy file (defined/declared but never exercised) and
 * are dropped here.
 */
export class DigestGenerator {
  nc = 0;
  cnonce: string;
  authenticateData: AuthenticateData | null = null;

  constructor() {
    this.cnonce = DigestGenerator.makeCnonce(8);
  }

  private static makeCnonce(length: number): string {
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let i = 0; i < length; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  digestSchema(type: HashType, str: string): string {
    return hashWith(type, str);
  }

  generateClientNonce(): void {
    this.cnonce = DigestGenerator.makeCnonce(8);
    this.nc += 1;
  }

  /**
   * Per RFC 7616 §3.4.1/§3.4.3 (which RFC 7826 §19.1.1 mandates RTSP Digest
   * auth follow instead of RFC 2617): whether the qop-based response formula
   * applies depends on `qop` alone — `algorithm`/`opaque` presence is
   * unrelated to which formula to use, they're independent challenge fields.
   */
  Digest(): string {
    const data = this.authenticateData!;
    const type: HashType = resolveDigestHashType(data.Algorithm);
    const ha1 = this.digestSchema(type, `${data.username}:${data.Realm}:${data.password}`);
    const ha2 = this.digestSchema(type, `${data.Method}:${decodeURIComponent(data.Uri)}`);
    let response: string;
    this.generateClientNonce();

    if (typeof data.Qop !== 'undefined' && data.Qop !== null && data.Qop !== '') {
      const input = `${ha1}:${data.Nonce}:${decimalToHex(this.nc, 8)}:${this.cnonce}:${data.Qop}:${ha2}`;
      response = this.digestSchema(type, input);
    } else {
      response = this.digestSchema(type, `${ha1}:${data.Nonce}:${ha2}`);
    }
    return response;
  }

  /**
   * Field emission per RFC 7616 §3.4 (RFC 7826 §19.1.1 defers RTSP Digest to
   * this, not RFC 2617): `algorithm`/`opaque` are echoed back independently,
   * whenever the server's challenge supplied them — neither depends on the
   * other or on `qop` being present. `nc`/`cnonce`/`qop` are emitted
   * together, gated on `qop` alone, since they only exist to support the
   * qop-based response formula (see `Digest()`). Per §3.4.5, `algorithm`,
   * `qop`, and `nc` are unquoted tokens — unlike every other field here,
   * which use quoted-string syntax.
   */
  getAuthenticate(data?: AuthenticateData | null, response?: string | null): string {
    if (data !== undefined && data !== null) {
      this.authenticateData = data;
    }
    const responseValue = typeof response === 'undefined' || response === null ? this.Digest() : response;

    const auth = this.authenticateData!;
    const hasQop = typeof auth.Qop !== 'undefined' && auth.Qop !== null && auth.Qop !== '';

    let authentication = 'Authorization: Digest';
    authentication += ` username="${auth.username}"`;
    authentication += `, realm="${auth.Realm}"`;
    authentication += `, uri="${decodeURIComponent(auth.Uri)}"`;
    authentication += `, nonce="${auth.Nonce}"`;
    if (typeof auth.Algorithm === 'string' && auth.Algorithm !== '') {
      authentication += `, algorithm=${auth.Algorithm}`;
    }
    if (typeof auth.Opaque === 'string' && auth.Opaque !== '') {
      authentication += `, opaque="${auth.Opaque}"`;
    }
    if (hasQop) {
      authentication += `, nc=${decimalToHex(this.nc, 8)}`;
      authentication += `, cnonce="${this.cnonce}"`;
      authentication += `, qop=${auth.Qop}`;
    }
    authentication += `, response="${responseValue}"\r\n`;
    return authentication;
  }

  getDigestInfoInWwwAuthenticate(wwwAuthenticate: string): ParsedWwwAuthenticate[] {
    const lines = wwwAuthenticate.match(/[^\r\n]+/g) ?? [];
    return lines.map((line) => this.parseWWWAuthenticate(line));
  }

  parseWWWAuthenticate(authenticateString: string): ParsedWwwAuthenticate {
    const parserData: ParsedWwwAuthenticate = {
      method: null,
      realm: null,
      nonce: null,
      opaque: null,
      algorithm: null,
      qop: null
    };

    authenticateString.split(' ').some((element) => {
      if (element.search(/Basic/gi) !== -1) {
        parserData.method = element;
        return true;
      } else if (element.search(/Digest/gi) !== -1) {
        parserData.method = element;
        return true;
      } else {
        parserData.method = 'Unknown';
        return false;
      }
    });

    let pos: number;
    if ((pos = authenticateString.search(/realm="/gi)) !== -1) {
      parserData.realm = authenticateString.substr(pos + 5).split('"')[1];
    }
    if ((pos = authenticateString.search(/nonce="/gi)) !== -1) {
      parserData.nonce = authenticateString.substr(pos + 5).split('"')[1];
    }
    if ((pos = authenticateString.search(/opaque="/gi)) !== -1) {
      parserData.opaque = authenticateString.substr(pos + 6).split('"')[1];
    }
    // Per RFC 7616 §3.3 (which RFC 7826 §19.1.1 has RTSP Digest follow), the
    // challenge's `algorithm` value is an UNQUOTED token (e.g.
    // `algorithm=SHA-256`) — unlike realm/nonce/opaque/qop, which are all
    // quoted. `"?...?"` tolerates a quoted form too, defensively, in case a
    // server gets this wrong.
    const algorithmMatch = authenticateString.match(/algorithm\s*=\s*"?([^",\s]+)"?/i);
    if (algorithmMatch !== null) {
      parserData.algorithm = algorithmMatch[1];
    }
    if ((pos = authenticateString.search(/qop="/gi)) !== -1) {
      parserData.qop = authenticateString.substr(pos + 3).split('"')[1];
    }
    return parserData;
  }
}
