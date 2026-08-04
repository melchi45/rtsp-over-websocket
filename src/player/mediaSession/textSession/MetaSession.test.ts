import { describe, it, expect, vi } from 'vitest';
import { loadLegacyModule } from '../../test-support/loadLegacyModule';
import { createMediaSessionLegacySandbox } from '../../test-support/legacyGlobals';
import { MetaSession } from './MetaSession';

interface LegacyMetaSession {
  init(): void;
  depacketize(rtspInterleaved: Uint8Array, rtpHeader: Uint8Array, rtpPayload: Uint8Array): void;
  eventMetaCallback?: (...args: unknown[]) => void;
  rtcpSession?: { interleavedId: number } | null;
}

const sandbox = createMediaSessionLegacySandbox();
(sandbox as Record<string, unknown>).Session = loadLegacyModule('MediaSession/session.js', 'Session', sandbox);
(sandbox as Record<string, unknown>).RtpSession = loadLegacyModule('MediaSession/rtpSession.js', 'RtpSession', sandbox);

const LegacyMetaSessionCtor = loadLegacyModule<new () => LegacyMetaSession>(
  'MediaSession/TextSession/metaSession.js',
  'MetaSession',
  sandbox
);

function rtpHeader(marker: boolean, timestamp: number): Uint8Array {
  const header = new Uint8Array(12);
  header[0] = 0x80;
  header[1] = (marker ? 0x80 : 0x00) | 0x62;
  header[4] = (timestamp >>> 24) & 0xff;
  header[5] = (timestamp >>> 16) & 0xff;
  header[6] = (timestamp >>> 8) & 0xff;
  header[7] = timestamp & 0xff;
  return header;
}

const RTSP_INTERLEAVED = Uint8Array.from([0x24, 0]);

describe('MetaSession parity with the legacy player’s MediaSession/TextSession/metaSession.js', () => {
  it('accumulates payload across packets and emits an identical streamData once the marker bit arrives', () => {
    const legacy = new LegacyMetaSessionCtor();
    const ported = new MetaSession();
    legacy.init();
    ported.init();
    legacy.rtcpSession = { interleavedId: 1 };
    ported.rtcpSession = { interleavedId: 1 };

    const legacyCb = vi.fn();
    const portedCb = vi.fn();
    legacy.eventMetaCallback = legacyCb;
    ported.eventMetaCallback = portedCb;

    const chunk1 = Uint8Array.from([0x3c, 0x3f, 0x78, 0x6d]);
    const chunk2 = Uint8Array.from([0x6c, 0x3e, 0x00]);

    legacy.depacketize(RTSP_INTERLEAVED, rtpHeader(false, 1000), chunk1);
    ported.depacketize(RTSP_INTERLEAVED, rtpHeader(false, 1000), chunk1);
    legacy.depacketize(RTSP_INTERLEAVED, rtpHeader(true, 1000), chunk2);
    ported.depacketize(RTSP_INTERLEAVED, rtpHeader(true, 1000), chunk2);

    expect(legacyCb).toHaveBeenCalledTimes(1);
    const legacyStreamData = legacyCb.mock.calls[0][0];
    const portedStreamData = portedCb.mock.calls[0][0];
    expect(Array.from(portedStreamData.frameData)).toEqual(Array.from(legacyStreamData.frameData));
    expect(portedStreamData.timeStamp).toEqual(legacyStreamData.timeStamp);
  });
});
