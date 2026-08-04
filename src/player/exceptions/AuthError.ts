import { RTSPOverWebSocketBaseError, type RTSPOverWebSocketErrorOptions } from './RTSPOverWebSocketBaseError';

export class AuthError extends RTSPOverWebSocketBaseError {
  constructor(options: RTSPOverWebSocketErrorOptions = {}) {
    super('Auth Error', options);
  }
}
