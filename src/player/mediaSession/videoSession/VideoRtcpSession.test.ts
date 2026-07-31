import { describe, it, expect } from 'vitest';
import { loadLegacyModule } from '../../test-support/loadLegacyModule';
import { createMediaSessionLegacySandbox } from '../../test-support/legacyGlobals';
import { VideoRtcpSession } from './VideoRtcpSession';

interface LegacyVideoRtcpSession {
  SendRtpData(rtspInterleaved: unknown, rtpHeader: Uint8Array, rtpPayload: Uint8Array): void;
  calculatePacketTime(rtpTimeStamp: number): { tv_sec: number; tv_usec: number };
}

const sandbox = createMediaSessionLegacySandbox();
(sandbox as Record<string, unknown>).Session = loadLegacyModule('MediaSession/session.js', 'Session', sandbox);
(sandbox as Record<string, unknown>).RtpSession = loadLegacyModule('MediaSession/rtpSession.js', 'RtpSession', sandbox);

const LegacyVideoRtcpSessionCtor = loadLegacyModule<new (clockFreq: number) => LegacyVideoRtcpSession>(
  'MediaSession/VideoSession/videoRtcpSession.js',
  'RtcpSession',
  sandbox
);

describe('VideoRtcpSession parity with the legacy player’s MediaSession/VideoSession/videoRtcpSession.js (legacy class name RtcpSession)', () => {
  it('SendRtpData(SR) followed by calculatePacketTime produces identical presentation times', () => {
    const legacy = new LegacyVideoRtcpSessionCtor(90000);
    const ported = new VideoRtcpSession(90000);

    const rtpHeader = Uint8Array.from([0x80, 200, 0, 6]);
    const rtpPayload = new Uint8Array(20);
    rtpPayload.set([0x01, 0x02, 0x03, 0x04], 0); // SSRC
    rtpPayload.set([0x83, 0xaa, 0x7e, 0x90], 4); // NTP MSW
    rtpPayload.set([0x00, 0x00, 0x00, 0x01], 8); // NTP LSW
    rtpPayload.set([0x00, 0x00, 0x23, 0x28], 12); // RTP timestamp
    rtpPayload.set([0x00, 0x00, 0x00, 0x00], 16);

    legacy.SendRtpData(null, rtpHeader, rtpPayload);
    ported.SendRtpData(null, rtpHeader, rtpPayload);

    const legacyTime = legacy.calculatePacketTime(9500);
    const portedTime = ported.calculatePacketTime(9500);
    expect(portedTime).toEqual(legacyTime);
  });
});
