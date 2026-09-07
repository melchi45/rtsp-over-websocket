import { createHash } from 'node:crypto';
import { REALM } from '../config';
import type { DigestAuth } from './rtspFraming';

export type DigestAlgorithm = 'MD5' | 'SHA-256';

export function md5(str: string): string {
  return createHash('md5').update(str, 'utf8').digest('hex');
}

function digestHash(algorithm: DigestAlgorithm, str: string): string {
  return algorithm === 'SHA-256' ? createHash('sha256').update(str, 'utf8').digest('hex') : md5(str);
}

/** Simple-mode RTSP Digest (no qop) — RtspClient.ts's DigestGenerator falls
 * back to this exact scheme whenever the server's challenge omits
 * qop/algorithm/opaque (see src/player/util/DigestGenerator.ts), which is
 * deliberate here: it avoids needing server-side nc/cnonce session state for
 * what is, in effect, a loopback-adjacent relay to our own ffmpeg publish.
 *
 * `algorithm` (default 'MD5', matching every real camera exercised so far —
 * see MEMORY.md) selects MD5 vs. SHA-256 per RFC 7616 §3.4.2's A1/A2 shape;
 * both variants still use the qop-less A2/response formula above, since this
 * bridge's challenge (server.ts's `challenge()`) never sends `qop` either
 * way. Caller (server.ts) must pass the same algorithm it challenged with. */
export function verifyDigest(
  auth: DigestAuth | null,
  method: string,
  expectedUsername: string,
  expectedPassword: string,
  nonce: string | null,
  algorithm: DigestAlgorithm = 'MD5'
): boolean {
  if (!auth || !auth.username || !auth.nonce || !auth.uri || !auth.response || !nonce) return false;
  if (auth.nonce !== nonce) return false;
  if (auth.username !== expectedUsername) return false;
  const ha1 = digestHash(algorithm, `${expectedUsername}:${REALM}:${expectedPassword}`);
  const ha2 = digestHash(algorithm, `${method}:${auth.uri}`);
  const expected = digestHash(algorithm, `${ha1}:${auth.nonce}:${ha2}`);
  return expected === auth.response;
}
