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
    return type === 'MD5' ? CryptoJS.MD5(str).toString() : CryptoJS.SHA256(str).toString();
  }

  generateClientNonce(): void {
    this.cnonce = DigestGenerator.makeCnonce(8);
    this.nc += 1;
  }

  Digest(): string {
    const data = this.authenticateData!;
    const type: HashType =
      data.Algorithm === 'MD5' || typeof data.Algorithm === 'undefined' || data.Algorithm === null ? 'MD5' : 'SHA256';
    const ha1 = this.digestSchema(type, `${data.username}:${data.Realm}:${data.password}`);
    const ha2 = this.digestSchema(type, `${data.Method}:${decodeURIComponent(data.Uri)}`);
    let response: string;
    this.generateClientNonce();

    if (
      typeof data.Qop !== 'undefined' &&
      data.Qop !== null &&
      typeof data.Algorithm !== 'undefined' &&
      data.Algorithm !== null &&
      typeof data.Opaque !== 'undefined' &&
      data.Opaque !== null
    ) {
      const input = `${ha1}:${data.Nonce}:${decimalToHex(this.nc, 8)}:${this.cnonce}:${data.Qop}:${ha2}`;
      response = this.digestSchema(type, input);
      console.log('input string:', input);
    } else {
      response = this.digestSchema(type, `${ha1}:${data.Nonce}:${ha2}`);
    }
    return response;
  }

  getAuthenticate(data?: AuthenticateData | null, response?: string | null): string {
    if (data !== undefined && data !== null) {
      this.authenticateData = data;
    }
    const responseValue = typeof response === 'undefined' || response === null ? this.Digest() : response;

    const auth = this.authenticateData!;
    let authentication = 'Authorization: Digest';
    authentication += ` username="${auth.username}"`;
    authentication += `, realm="${auth.Realm}"`;
    authentication += `, uri="${decodeURIComponent(auth.Uri)}"`;
    authentication += `, nonce="${auth.Nonce}"`;
    if (
      typeof auth.Qop !== 'undefined' &&
      auth.Qop !== null &&
      typeof auth.Algorithm !== 'undefined' &&
      auth.Algorithm !== null &&
      typeof auth.Opaque !== 'undefined' &&
      auth.Opaque !== null
    ) {
      authentication += `, algorithm="${auth.Algorithm}"`;
      authentication += `, opaque="${auth.Opaque}"`;
      authentication += `, nc="${decimalToHex(this.nc, 8)}"`;
      authentication += `, cnonce="${this.cnonce}"`;
      authentication += `, qop="${auth.Qop}"`;
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
    if ((pos = authenticateString.search(/algorithm="/gi)) !== -1) {
      parserData.algorithm = authenticateString.substr(pos + 9).split('"')[1];
    }
    if ((pos = authenticateString.search(/qop="/gi)) !== -1) {
      parserData.qop = authenticateString.substr(pos + 3).split('"')[1];
    }
    return parserData;
  }
}
