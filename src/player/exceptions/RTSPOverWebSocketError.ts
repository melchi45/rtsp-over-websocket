import { RTSPOverWebSocketBaseError, type RTSPOverWebSocketErrorOptions } from './RTSPOverWebSocketBaseError';

/**
 * Ported from the legacy player’s Exception/RTSPOverWebSocketError.js — the
 * base error class of the legacy library. Legacy correctly named it after
 * the library itself (not a bug, unlike RTCPError/RTSPError's copy-paste
 * reuse of that same name) — this port rebrands that name for the same
 * reason as those two; see RTCPError.ts's note for the full rationale.
 */
export class RTSPOverWebSocketError extends RTSPOverWebSocketBaseError {
  constructor(options: RTSPOverWebSocketErrorOptions = {}) {
    super('RTSPOverWebSocket Error', options);
  }
}
