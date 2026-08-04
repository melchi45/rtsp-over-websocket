import { describe, it, expect, vi } from 'vitest';
import { loadLegacyModule } from '../../test-support/loadLegacyModule';
import { createMediaSessionLegacySandbox } from '../../test-support/legacyGlobals';
import { H264Session } from './H264Session';

interface LegacyH264Session {
  init(): void;
  depacketize(rtspInterleaved: Uint8Array, rtpHeader: Uint8Array, rtpPayload: Uint8Array): void;
  eventVideoCallback?: (...args: unknown[]) => void;
  channelId: number;
  clock: number;
  rtcpSession?: { interleavedId: number } | null;
}

const sandbox = createMediaSessionLegacySandbox();
(sandbox as Record<string, unknown>).Session = loadLegacyModule('MediaSession/session.js', 'Session', sandbox);
(sandbox as Record<string, unknown>).RtpSession = loadLegacyModule('MediaSession/rtpSession.js', 'RtpSession', sandbox);

const LegacyH264SessionCtor = loadLegacyModule<new () => LegacyH264Session>(
  'MediaSession/VideoSession/h264Session.js',
  'H264Session',
  sandbox
);

function rtpHeader(marker: boolean, seq: number, timestamp: number): Uint8Array {
  const header = new Uint8Array(12);
  header[0] = 0x80;
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

describe('H264Session parity with the legacy player’s MediaSession/VideoSession/h264Session.js', () => {
  it('SPS then PPS then a marker-bit slice produce an identical eventVideoCallback frame', () => {
    const legacy = new LegacyH264SessionCtor();
    const ported = new H264Session();
    legacy.init();
    ported.init();
    legacy.rtcpSession = { interleavedId: 1 };
    ported.rtcpSession = { interleavedId: 1 };

    const legacyCb = vi.fn();
    const portedCb = vi.fn();
    legacy.eventVideoCallback = legacyCb;
    ported.eventVideoCallback = portedCb;

    const sps = Uint8Array.from([0x67, 0x42, 0x00, 0x1e, 0x8c, 0x8d, 0x40]);
    const pps = Uint8Array.from([0x68, 0xce, 0x3c, 0x80]);
    const slice = Uint8Array.from([0x41, 0x9a, 0x24, 0x6c, 0x42, 0x0f]);

    legacy.depacketize(RTSP_INTERLEAVED, rtpHeader(false, 1, 3000), sps);
    ported.depacketize(RTSP_INTERLEAVED, rtpHeader(false, 1, 3000), sps);

    legacy.depacketize(RTSP_INTERLEAVED, rtpHeader(false, 2, 3000), pps);
    ported.depacketize(RTSP_INTERLEAVED, rtpHeader(false, 2, 3000), pps);

    legacy.depacketize(RTSP_INTERLEAVED, rtpHeader(true, 3, 3000), slice);
    ported.depacketize(RTSP_INTERLEAVED, rtpHeader(true, 3, 3000), slice);

    expect(legacyCb).toHaveBeenCalledTimes(1);
    expect(portedCb).toHaveBeenCalledTimes(1);

    const [legacyPlayMode, legacyStreamData, legacyVideoInfo] = legacyCb.mock.calls[0];
    const [portedPlayMode, portedStreamData, portedVideoInfo] = portedCb.mock.calls[0];

    expect(portedPlayMode).toBe(legacyPlayMode);
    expect(Array.from(portedStreamData.frameData)).toEqual(Array.from(legacyStreamData.frameData));
    expect(portedStreamData.timeStamp).toEqual(legacyStreamData.timeStamp);
    expect(Array.from(portedVideoInfo.spsPayload)).toEqual(Array.from(legacyVideoInfo.spsPayload));
    expect(Array.from(portedVideoInfo.ppsPayload)).toEqual(Array.from(legacyVideoInfo.ppsPayload));
    expect(portedVideoInfo.frameType).toBe(legacyVideoInfo.frameType);
  });

  it('a STAP-A aggregation packet splits into the same SPS+PPS segments', () => {
    const legacy = new LegacyH264SessionCtor();
    const ported = new H264Session();
    legacy.init();
    ported.init();
    legacy.rtcpSession = { interleavedId: 1 };
    ported.rtcpSession = { interleavedId: 1 };
    const legacyCb = vi.fn();
    const portedCb = vi.fn();
    legacy.eventVideoCallback = legacyCb;
    ported.eventVideoCallback = portedCb;

    const spsInner = Uint8Array.from([0x67, 0x42, 0x00, 0x1e]);
    const ppsInner = Uint8Array.from([0x68, 0xce, 0x3c, 0x80]);
    const stapA = new Uint8Array(1 + 2 + spsInner.length + 2 + ppsInner.length);
    stapA[0] = 0x18; // STAP-A NAL header (type 24)
    stapA[1] = (spsInner.length >> 8) & 0xff;
    stapA[2] = spsInner.length & 0xff;
    stapA.set(spsInner, 3);
    let offset = 3 + spsInner.length;
    stapA[offset] = (ppsInner.length >> 8) & 0xff;
    stapA[offset + 1] = ppsInner.length & 0xff;
    stapA.set(ppsInner, offset + 2);

    legacy.depacketize(RTSP_INTERLEAVED, rtpHeader(false, 1, 3000), stapA);
    ported.depacketize(RTSP_INTERLEAVED, rtpHeader(false, 1, 3000), stapA);

    const slice = Uint8Array.from([0x41, 0x9a, 0x24]);
    legacy.depacketize(RTSP_INTERLEAVED, rtpHeader(true, 2, 3000), slice);
    ported.depacketize(RTSP_INTERLEAVED, rtpHeader(true, 2, 3000), slice);

    const legacyVideoInfo = legacyCb.mock.calls[0][2];
    const portedVideoInfo = portedCb.mock.calls[0][2];
    expect(Array.from(portedVideoInfo.spsPayload)).toEqual(Array.from(legacyVideoInfo.spsPayload));
    expect(Array.from(portedVideoInfo.ppsPayload)).toEqual(Array.from(legacyVideoInfo.ppsPayload));
  });

  it('rejects a non-RTSP-interleaved header identically', () => {
    const legacy = new LegacyH264SessionCtor();
    const ported = new H264Session();
    legacy.init();
    ported.init();
    legacy.rtcpSession = { interleavedId: 1 };
    ported.rtcpSession = { interleavedId: 1 };
    const badInterleaved = Uint8Array.from([0x00, 0]);
    expect(() => legacy.depacketize(badInterleaved, rtpHeader(false, 1, 0), Uint8Array.from([0x67]))).toThrow();
    expect(() => ported.depacketize(badInterleaved, rtpHeader(false, 1, 0), Uint8Array.from([0x67]))).toThrow();
  });
});
