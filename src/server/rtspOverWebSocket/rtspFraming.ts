import { MAX_PENDING_RTSP_TEXT_BYTES } from '../config';

export interface RtspRequestLine {
  method: string;
  uri: string;
}

export function parseRtspRequestLine(text: string): RtspRequestLine | null {
  const firstLine = (text.split('\r\n')[0] || '').trim();
  const m = firstLine.match(/^([A-Z_]+)\s+(\S+)\s+RTSP\/[\d.]+$/);
  return m ? { method: m[1], uri: m[2] } : null;
}

export function parseHeader(text: string, name: string): string | null {
  const m = text.match(new RegExp(`^${name}:\\s*(.+)$`, 'im'));
  return m ? m[1].trim() : null;
}

/** The channel number is the first numeric path segment of the RTSP URL —
 * RtspClient.ts (device="nvr" mode) builds "LiveChannel/<channel>/media.smp"
 * (or "PlaybackChannel/"/"BackupChannel/" for other modes); a non-numeric
 * prefix precedes the channel number, so this searches for the first
 * numeric segment anywhere in the path rather than anchoring to the start
 * (device="camera" mode, which puts the channel first, still matches). */
export function extractChannel(uri: string): number | null {
  let pathname = uri;
  try {
    pathname = new URL(uri).pathname;
  } catch {
    // not a full URL — use as-is
  }
  const m = pathname.match(/\/(\d+)(?:\/|$)/);
  return m ? parseInt(m[1], 10) : null;
}

export interface DigestAuth {
  username?: string;
  realm?: string;
  nonce?: string;
  uri?: string;
  response?: string;
  [key: string]: string | undefined;
}

export function parseDigestAuthorization(text: string): DigestAuth | null {
  const header = parseHeader(text, 'Authorization');
  if (!header || !/^Digest/i.test(header)) return null;
  const out: DigestAuth = {};
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header))) out[m[1]] = m[2];
  return out;
}

/** Rewrites an outgoing (client -> backend) RTSP request line's URI to
 * target this session's MediaMTX path instead of whatever base URI the
 * client built the request against, leaving every other line untouched.
 * Ported from an equivalent rewriteRequestUri() design in a sibling
 * camera-streaming server this project's RTSP paths share heritage with —
 * same two-branch handling (client-base-prefixed vs. already-correct-because-
 * copied-from-our-own-Content-Base) applies here verbatim, this server just doesn't have the
 * ingest-daemon-fan-out-vs-MediaMTX-direct-path distinction that file has. */
export function rewriteRequestUri(text: string, clientBaseUri: string | null, targetUri: string | null): string {
  const idx = text.indexOf('\r\n');
  const firstLine = idx === -1 ? text : text.slice(0, idx);
  const rest = idx === -1 ? '' : text.slice(idx);
  const m = firstLine.match(/^([A-Z_]+)\s+(\S+)(\s+RTSP\/[\d.]+)\s*$/);
  if (!m) return text; // not a request line — forward unchanged, defensively
  const [, method, uri, suffix] = m;
  let newUri: string;
  if (targetUri && uri.startsWith(targetUri)) {
    newUri = uri; // client already built this from our own DESCRIBE response's Content-Base
  } else if (clientBaseUri && uri.startsWith(clientBaseUri)) {
    newUri = targetUri + uri.slice(clientBaseUri.length);
  } else {
    newUri = targetUri ?? uri;
  }
  return `${method} ${newUri}${suffix}${rest}`;
}

export function buildRtspResponse(statusCode: number, statusText: string, cseq: string, extraHeaders = ''): string {
  return `RTSP/1.0 ${statusCode} ${statusText}\r\nCSeq: ${cseq}\r\n${extraHeaders}\r\n`;
}

export interface ExtractedRtspResponse {
  raw: Buffer;
  headerText: string;
  body: string;
  consumed: number;
}

/** Pulls one complete RTSP response (header block + Content-Length body, if
 * any) off the front of `buf`. Returns null if `buf` doesn't yet hold a
 * full response — the caller should wait for more data and retry. */
export function extractRtspResponseText(buf: Buffer): ExtractedRtspResponse | null {
  const headerEnd = buf.indexOf('\r\n\r\n');
  if (headerEnd === -1) return null;
  const headerText = buf.slice(0, headerEnd).toString('utf8');
  const contentLength = parseInt(parseHeader(headerText, 'Content-Length') || '0', 10) || 0;
  const total = headerEnd + 4 + contentLength;
  if (buf.length < total) return null;
  return {
    raw: buf.slice(0, total),
    headerText,
    body: buf.slice(headerEnd + 4, total).toString('utf8'),
    consumed: total
  };
}

export { MAX_PENDING_RTSP_TEXT_BYTES };
