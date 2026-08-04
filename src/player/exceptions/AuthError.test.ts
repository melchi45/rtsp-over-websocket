import { describe, it } from 'vitest';
import { loadLegacyModule } from '../test-support/loadLegacyModule';
import { expectErrorParity, type LegacyErrorCtor } from '../test-support/errorParity';
import { AuthError } from './AuthError';

const LegacyAuthError = loadLegacyModule<LegacyErrorCtor>('Exception/AuthError.js', 'AuthError');

describe('AuthError parity with the legacy player’s Exception/AuthError.js', () => {
  it('matches for a full options object', () => {
    const options = {
      message: 'Unauthorized',
      channelId: 0,
      elementId: 'rtsp-over-websocket-player1',
      errorCode: 401,
      place: 'sunapiClient.js:auth'
    };
    expectErrorParity(new LegacyAuthError(options), new AuthError(options));
  });

  it('matches when optional channelId/elementId are omitted', () => {
    const options = { message: 'Unauthorized', errorCode: 401, place: 'sunapiClient.js:auth' };
    expectErrorParity(new LegacyAuthError(options), new AuthError(options));
  });
});
