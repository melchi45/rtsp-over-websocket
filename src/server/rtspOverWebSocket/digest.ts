import { createHash } from 'node:crypto';
import { REALM } from '../config';
import type { DigestAuth } from './rtspFraming';

export function md5(str: string): string {
  return createHash('md5').update(str, 'utf8').digest('hex');
}

/** Simple-mode RTSP Digest (no qop) — RtspClient.ts's DigestGenerator falls
 * back to this exact scheme whenever the server's challenge omits
 * qop/algorithm/opaque (see src/player/util/DigestGenerator.ts), which is
 * deliberate here: it avoids needing server-side nc/cnonce session state for
 * what is, in effect, a loopback-adjacent relay to our own ffmpeg publish. */
export function verifyDigest(auth: DigestAuth | null, method: string, expectedUsername: string, expectedPassword: string, nonce: string | null): boolean {
  if (!auth || !auth.username || !auth.nonce || !auth.uri || !auth.response || !nonce) return false;
  if (auth.nonce !== nonce) return false;
  if (auth.username !== expectedUsername) return false;
  const ha1 = md5(`${expectedUsername}:${REALM}:${expectedPassword}`);
  const ha2 = md5(`${method}:${auth.uri}`);
  const expected = md5(`${ha1}:${auth.nonce}:${ha2}`);
  return expected === auth.response;
}
