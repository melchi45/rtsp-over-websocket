import { RTSPOverWebSocketBaseError, type RTSPOverWebSocketErrorOptions } from './RTSPOverWebSocketBaseError';

export interface SunapiErrorOptions extends RTSPOverWebSocketErrorOptions {
  uri?: string;
}

export class SunapiError extends RTSPOverWebSocketBaseError {
  readonly uri?: string;

  constructor(options: SunapiErrorOptions = {}) {
    super('SUNAPI Error', options);
    this.uri = options.uri;
  }
}
