import { RTSPOverWebSocketBaseError, type RTSPOverWebSocketErrorOptions } from './RTSPOverWebSocketBaseError';

/** Ported from the legacy player’s Exception/AuthError.js. */
export class AuthError extends RTSPOverWebSocketBaseError {
  constructor(options: RTSPOverWebSocketErrorOptions = {}) {
    super('Auth Error', options);
  }
}
