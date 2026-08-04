import { RTSPOverWebSocketBaseError, type RTSPOverWebSocketErrorOptions } from './RTSPOverWebSocketBaseError';

/**
 * Ported from the legacy player’s Exception/RTSPError.
 *
 * NOTE: the legacy file set `error.name` to the same base-class name every
 * error type in the legacy hierarchy used, rather than a name specific to
 * RTSP errors — same copy-paste oversight as RTCPError.ts. Rebranded here
 * rather than kept verbatim (see RTCPError.ts's matching note for the full
 * rationale and trade-off).
 */
export class RTSPError extends RTSPOverWebSocketBaseError {
  constructor(options: RTSPOverWebSocketErrorOptions = {}) {
    super('RTSPOverWebSocket Error', options);
  }
}
