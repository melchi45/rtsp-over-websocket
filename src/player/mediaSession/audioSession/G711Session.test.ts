import { describe, it, expect, vi } from 'vitest';
import { loadLegacyModule } from '../../test-support/loadLegacyModule';
import { createMediaSessionLegacySandbox } from '../../test-support/legacyGlobals';
import { G711Session } from './G711Session';

interface LegacyG711Session {
  init(info: { bitrate: number; clockFreq: number }): void;
  depacketize(rtspInterleaved: Uint8Array, rtpHeader: Uint8Array, rtpPayload: Uint8Array): void;
  eventAudioCallback?: (...args: unknown[]) => void;
  rtcpSession?: { interleavedId: number } | null;
}

const sandbox = createMediaSessionLegacySandbox();
(sandbox as Record<string, unknown>).Session = loadLegacyModule('MediaSession/session.js', 'Session', sandbox);
(sandbox as Record<string, unknown>).RtpSession = loadLegacyModule('MediaSession/rtpSession.js', 'RtpSession', sandbox);

const LegacyG711SessionCtor = loadLegacyModule<new () => LegacyG711Session>(
  'MediaSession/AudioSession/g711Session.js',
  'G711Session',
  sandbox
);

function rtpHeader(marker: boolean, timestamp: number): Uint8Array {
  const header = new Uint8Array(12);
  header[0] = 0x80;
  header[1] = (marker ? 0x80 : 0x00) | 0x00;
  header[4] = (timestamp >>> 24) & 0xff;
  header[5] = (timestamp >>> 16) & 0xff;
  header[6] = (timestamp >>> 8) & 0xff;
  header[7] = timestamp & 0xff;
  return header;
}

const RTSP_INTERLEAVED = Uint8Array.from([0x24, 0]);

describe('G711Session parity with the legacy player’s MediaSession/AudioSession/g711Session.js', () => {
  it('a single marker-bit packet produces an identical streamData/audioInfo callback', () => {
    const legacy = new LegacyG711SessionCtor();
    const ported = new G711Session();
    const info = { bitrate: 64000, clockFreq: 8000 };
    legacy.init(info);
    ported.init(info);
    legacy.rtcpSession = { interleavedId: 1 };
    ported.rtcpSession = { interleavedId: 1 };

    const legacyCb = vi.fn();
    const portedCb = vi.fn();
    legacy.eventAudioCallback = legacyCb;
    ported.eventAudioCallback = portedCb;

    const payload = Uint8Array.from([0x11, 0x22, 0x33, 0x44, 0x55]);
    legacy.depacketize(RTSP_INTERLEAVED, rtpHeader(true, 8000), payload);
    ported.depacketize(RTSP_INTERLEAVED, rtpHeader(true, 8000), payload);

    expect(legacyCb).toHaveBeenCalledTimes(1);
    const legacyArgs = legacyCb.mock.calls[0];
    const portedArgs = portedCb.mock.calls[0];
    expect(portedArgs[0]).toBe(legacyArgs[0]);
    expect(Array.from(portedArgs[1].frameData)).toEqual(Array.from(legacyArgs[1].frameData));
    expect(portedArgs[1].timeStamp).toEqual(legacyArgs[1].timeStamp);
    expect(portedArgs[2]).toEqual(legacyArgs[2]);
  });
});
