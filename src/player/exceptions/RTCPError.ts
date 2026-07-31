import { RTSPOverWebSocketBaseError, type RTSPOverWebSocketErrorOptions } from './RTSPOverWebSocketBaseError';

/**
 * Ported from the legacy player’s Exception/RTCPError.js.
 *
 * NOTE: the legacy file set `error.name` to the same base-class name used
 * by every error type in the legacy hierarchy, rather than a name specific
 * to RTCP errors — almost certainly a copy-paste oversight. This port
 * rebrands that shared name (see RTSPOverWebSocketError.ts) rather than
 * reproduce the legacy value verbatim, since it's an observable string
 * real consumers of this library can read off a thrown error — but the
 * underlying quirk (RTCPError and RTSPError sharing one name, rather than
 * each having their own) is intentionally still preserved. This means the
 * parity test for this one field would no longer match the actual
 * historical legacy source byte-for-byte if that source is ever available
 * to run against — a deliberate trade-off.
 */
export class RTCPError extends RTSPOverWebSocketBaseError {
  constructor(options: RTSPOverWebSocketErrorOptions = {}) {
    super('RTSPOverWebSocket Error', options);
  }
}
