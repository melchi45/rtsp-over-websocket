import { describe, it, expect, vi } from 'vitest';
import { loadLegacyModule } from '../test-support/loadLegacyModule';
import { createMediaSessionLegacySandbox } from '../test-support/legacyGlobals';
import { RTCPSession } from './RTCPSession';

interface LegacyRTCPSession {
  interleavedId: number;
  channelId: number;
  type?: string;
  clock: number;
  eventRtcpCallback?: (data: unknown) => void;
  init(): void;
  parse(rtcpData: Uint8Array): void;
  depacketize(rtspInterleaved: unknown, rtcpHeader: Uint8Array, rtpPayload: Uint8Array): void;
}

const sandbox = createMediaSessionLegacySandbox();
(sandbox as Record<string, unknown>).Session = loadLegacyModule('MediaSession/session.js', 'Session', sandbox);

const LegacyRTCPSessionCtor = loadLegacyModule<new () => LegacyRTCPSession>(
  'MediaSession/rtcpSession.js',
  'RTCPSession',
  sandbox
);

function buildSenderReportPacket(): Uint8Array {
  const packet = new Uint8Array(28);
  packet[0] = 0x80;
  packet[1] = 200; // RTCP_SR
  packet[2] = 0;
  packet[3] = 6;
  // SSRC
  packet.set([0x01, 0x02, 0x03, 0x04], 4);
  // NTP MSW
  packet.set([0x83, 0xaa, 0x7e, 0x90], 8);
  // NTP LSW
  packet.set([0x00, 0x00, 0x00, 0x01], 12);
  // RTP timestamp
  packet.set([0x00, 0x00, 0x23, 0x28], 16);
  // sender packet count
  packet.set([0x00, 0x00, 0x00, 0x0a], 20);
  // sender octet count
  packet.set([0x00, 0x00, 0x05, 0x00], 24);
  return packet;
}

describe('RTCPSession parity with the legacy player’s MediaSession/rtcpSession.js', () => {
  it('init() sets the same initial timeData', () => {
    const legacy = new LegacyRTCPSessionCtor();
    const ported = new RTCPSession();
    legacy.init();
    ported.init();
    expect(ported.GetTimeStamp()).toEqual(legacy.GetTimeStamp?.() ?? (legacy as unknown as { timeData: unknown }).timeData);
  });

  it('parse() of a Sender Report invokes eventRtcpCallback with identical data', () => {
    const legacy = new LegacyRTCPSessionCtor();
    const ported = new RTCPSession();
    legacy.init();
    ported.init();

    const legacyCb = vi.fn();
    const portedCb = vi.fn();
    legacy.eventRtcpCallback = legacyCb;
    ported.eventRtcpCallback = portedCb;

    const packet = buildSenderReportPacket();
    legacy.parse(packet);
    ported.parse(packet);

    expect(legacyCb).toHaveBeenCalledTimes(1);
    expect(portedCb).toHaveBeenCalledTimes(1);
    expect(portedCb.mock.calls[0][0]).toEqual(legacyCb.mock.calls[0][0]);
  });

  it('RTCP_BYE on a "video" type session throws RTCPError identically', () => {
    const legacy = new LegacyRTCPSessionCtor();
    const ported = new RTCPSession();
    legacy.type = 'video';
    ported.type = 'video';

    const byePacket = new Uint8Array([0x80, 203, 0, 1]);
    expect(() => legacy.parse(byePacket)).toThrow();
    expect(() => ported.parse(byePacket)).toThrow();
  });
});
