import { describe, it, expect } from 'vitest';
import { loadLegacyModule } from '../test-support/loadLegacyModule';
import { type LegacyErrorCtor } from '../test-support/errorParity';
import { RTSPOverWebSocketError } from './RTSPOverWebSocketError';

const LegacyError = loadLegacyModule<LegacyErrorCtor>('Exception/RTSPOverWebSocketError.js', 'RTSPOverWebSocketError');

// name is checked separately from the rest of the shape below — this port
// deliberately rebrands the base error's name rather than reproduce the
// legacy value verbatim (see RTSPOverWebSocketError.ts's doc comment for
// the rationale), so `legacy.name` is not asserted against here.
function expectParityExceptName(legacy: InstanceType<LegacyErrorCtor>, ported: RTSPOverWebSocketError): void {
  expect(ported.message).toBe(legacy.message);
  expect(ported.channel).toBe(legacy.channel);
  expect(ported.element).toBe(legacy.element);
  expect(ported.errorCode).toBe(legacy.errorCode);
  expect(ported.place).toBe(legacy.place);
  expect(ported.uri).toBe(legacy.uri);
  expect(ported instanceof Error).toBe(true);
  expect(legacy instanceof Error).toBe(true);
  expect(ported.name).toBe('RTSPOverWebSocket Error');
}

describe('RTSPOverWebSocketError parity with the legacy player’s Exception/RTSPOverWebSocketError.js', () => {
  it('matches for a full options object (the only shape real call sites use)', () => {
    const options = {
      message: 'sunapi client is not init',
      channelId: 3,
      elementId: 'video-1',
      errorCode: 0x0702,
      place: 'sunapiManager.js:init'
    };
    expectParityExceptName(new LegacyError(options), new RTSPOverWebSocketError(options));
  });

  it('matches when optional channelId/elementId are omitted', () => {
    const options = { message: 'boom', errorCode: 1, place: 'x.js:1' };
    expectParityExceptName(new LegacyError(options), new RTSPOverWebSocketError(options));
  });
});
