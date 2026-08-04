import { describe, it, expect } from 'vitest';
import { loadLegacyModule } from '../test-support/loadLegacyModule';
import { type LegacyErrorCtor } from '../test-support/errorParity';
import { RTCPError } from './RTCPError';

const LegacyRTCPError = loadLegacyModule<LegacyErrorCtor>('Exception/RTCPError.js', 'RTCPError');

describe('RTCPError parity with the legacy player’s Exception/RTCPError.js', () => {
  it('matches on every field except name (deliberately rebranded — see RTCPError.ts)', () => {
    const options = { message: 'RTCP parse failure', channelId: 1, elementId: 'rtsp-over-websocket-player1', errorCode: 5, place: 'rtcpSession.js:156' };
    const legacy = new LegacyRTCPError(options);
    const ported = new RTCPError(options);
    expect(ported.message).toBe(legacy.message);
    expect(ported.channel).toBe(legacy.channel);
    expect(ported.element).toBe(legacy.element);
    expect(ported.errorCode).toBe(legacy.errorCode);
    expect(ported.place).toBe(legacy.place);
    expect(ported.uri).toBe(legacy.uri);
    expect(ported instanceof Error).toBe(true);
    expect(legacy instanceof Error).toBe(true);
    // The legacy copy-paste quirk: the real historical file names this
    // after the base error class rather than 'RTCP Error' specifically —
    // this port intentionally does not reproduce that shared name
    // verbatim (see RTCPError.ts), so `legacy.name` is deliberately not
    // asserted against here.
    expect(ported.name).toBe('RTSPOverWebSocket Error');
  });
});
