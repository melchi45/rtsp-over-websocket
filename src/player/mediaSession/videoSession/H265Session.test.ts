import { describe, it, expect, vi } from 'vitest';
import { loadLegacyModule } from '../../test-support/loadLegacyModule';
import { createMediaSessionLegacySandbox } from '../../test-support/legacyGlobals';
import { H265Session } from './H265Session';

interface LegacyH265Session {
  init(): void;
  depacketize(rtspInterleaved: Uint8Array, rtpHeader: Uint8Array, rtpPayload: Uint8Array): void;
  eventVideoCallback?: (...args: unknown[]) => void;
  rtcpSession?: { interleavedId: number } | null;
}

const sandbox = createMediaSessionLegacySandbox();
(sandbox as Record<string, unknown>).Session = loadLegacyModule('MediaSession/session.js', 'Session', sandbox);
(sandbox as Record<string, unknown>).RtpSession = loadLegacyModule('MediaSession/rtpSession.js', 'RtpSession', sandbox);

const LegacyH265SessionCtor = loadLegacyModule<new () => LegacyH265Session>(
  'MediaSession/VideoSession/h265Session.js',
  'H265Session',
  sandbox
);

function rtpHeader(marker: boolean, seq: number, timestamp: number, csrcNibble = 0x0): Uint8Array {
  const header = new Uint8Array(12);
  header[0] = 0x80 | csrcNibble;
  header[1] = (marker ? 0x80 : 0x00) | 0x60;
  header[2] = (seq >> 8) & 0xff;
  header[3] = seq & 0xff;
  header[4] = (timestamp >>> 24) & 0xff;
  header[5] = (timestamp >>> 16) & 0xff;
  header[6] = (timestamp >>> 8) & 0xff;
  header[7] = timestamp & 0xff;
  return header;
}

const RTSP_INTERLEAVED = Uint8Array.from([0x24, 0]);

describe('H265Session parity with the legacy player’s MediaSession/VideoSession/h265Session.js', () => {
  it('VPS/SPS/PPS then a marker-bit slice produce an identical eventVideoCallback frame', () => {
    const legacy = new LegacyH265SessionCtor();
    const ported = new H265Session();
    legacy.init();
    ported.init();
    legacy.rtcpSession = { interleavedId: 1 };
    ported.rtcpSession = { interleavedId: 1 };
    const legacyCb = vi.fn();
    const portedCb = vi.fn();
    legacy.eventVideoCallback = legacyCb;
    ported.eventVideoCallback = portedCb;

    const vps = Uint8Array.from([0x40, 0x01]);
    const sps = Uint8Array.from([0x42, 0x01, 0x0c]);
    const pps = Uint8Array.from([0x44, 0x01]);
    const slice = Uint8Array.from([0x02, 0x01, 0x40, 0xab, 0xcd]); // NAL type 1 -> not IDR

    legacy.depacketize(RTSP_INTERLEAVED, rtpHeader(false, 1, 100), vps);
    ported.depacketize(RTSP_INTERLEAVED, rtpHeader(false, 1, 100), vps);
    legacy.depacketize(RTSP_INTERLEAVED, rtpHeader(false, 2, 100), sps);
    ported.depacketize(RTSP_INTERLEAVED, rtpHeader(false, 2, 100), sps);
    legacy.depacketize(RTSP_INTERLEAVED, rtpHeader(false, 3, 100), pps);
    ported.depacketize(RTSP_INTERLEAVED, rtpHeader(false, 3, 100), pps);
    legacy.depacketize(RTSP_INTERLEAVED, rtpHeader(true, 4, 100), slice);
    ported.depacketize(RTSP_INTERLEAVED, rtpHeader(true, 4, 100), slice);

    expect(legacyCb).toHaveBeenCalledTimes(1);
    const [, legacyStreamData, legacyVideoInfo] = legacyCb.mock.calls[0];
    const [, portedStreamData, portedVideoInfo] = portedCb.mock.calls[0];
    expect(Array.from(portedStreamData.frameData)).toEqual(Array.from(legacyStreamData.frameData));
    expect(Array.from(portedVideoInfo.vpsPayload)).toEqual(Array.from(legacyVideoInfo.vpsPayload));
    expect(Array.from(portedVideoInfo.spsPayload)).toEqual(Array.from(legacyVideoInfo.spsPayload));
    expect(Array.from(portedVideoInfo.ppsPayload)).toEqual(Array.from(legacyVideoInfo.ppsPayload));
  });

  it('CSRC nibble === 0x0F throws (the h265-specific check), while a merely-nonzero nibble does not', () => {
    const legacy = new LegacyH265SessionCtor();
    const ported = new H265Session();
    legacy.init();
    ported.init();

    const payload = Uint8Array.from([0x02, 0x01]);
    expect(() => legacy.depacketize(RTSP_INTERLEAVED, rtpHeader(false, 1, 0, 0x0f), payload)).toThrow();
    expect(() => ported.depacketize(RTSP_INTERLEAVED, rtpHeader(false, 1, 0, 0x0f), payload)).toThrow();

    // csrc nibble = 0x05 (nonzero but not 0x0F) should NOT throw in either implementation.
    expect(() => legacy.depacketize(RTSP_INTERLEAVED, rtpHeader(false, 2, 0, 0x05), payload)).not.toThrow();
    expect(() => ported.depacketize(RTSP_INTERLEAVED, rtpHeader(false, 2, 0, 0x05), payload)).not.toThrow();
  });
});
