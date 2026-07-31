import { describe, it } from 'vitest';
import { loadLegacyModule } from '../test-support/loadLegacyModule';
import { expectErrorParity, type LegacyErrorCtor } from '../test-support/errorParity';
import { SunapiError } from './SunapiError';

const LegacySunapiError = loadLegacyModule<LegacyErrorCtor>('Exception/SunapiError.js', 'SunapiError');

describe('SunapiError parity with the legacy player’s Exception/SunapiError.js', () => {
  it('matches for a full options object', () => {
    const options = {
      message: 'sunapi client is not init',
      channelId: 0,
      elementId: 'rtsp-over-websocket-player1',
      errorCode: 0x0702,
      place: 'sunapiManager.js:init',
      uri: '/stw-cgi/attributes.cgi'
    };
    expectErrorParity(new LegacySunapiError(options), new SunapiError(options));
  });

  it('matches the real sunapiManager.js call shape (no channelId/elementId/uri)', () => {
    const options = { errorCode: 404, place: 'sunapiManager.js:init', message: 'Not Found' };
    expectErrorParity(new LegacySunapiError(options), new SunapiError(options));
  });
});
