import { RTSPOverWebSocketBaseError, type RTSPOverWebSocketErrorOptions } from './RTSPOverWebSocketBaseError';

export interface SunapiErrorOptions extends RTSPOverWebSocketErrorOptions {
  uri?: string;
}

/** Ported from the legacy player’s Exception/SunapiError.js (adds a `uri` field over the base shape). */
export class SunapiError extends RTSPOverWebSocketBaseError {
  readonly uri?: string;

  constructor(options: SunapiErrorOptions = {}) {
    super('SUNAPI Error', options);
    this.uri = options.uri;
  }
}
