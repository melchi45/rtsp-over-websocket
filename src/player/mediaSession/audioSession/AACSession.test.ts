import { describe, it, expect, vi } from 'vitest';
import { loadLegacyModule } from '../../test-support/loadLegacyModule';
import { createMediaSessionLegacySandbox } from '../../test-support/legacyGlobals';
import { AACSession } from './AACSession';

interface LegacyAACSession {
  init(info: { config: string; bitrate: number; clockFreq: number }): void;
  depacketize(rtspInterleaved: Uint8Array, rtpHeader: Uint8Array, rtpPayload: Uint8Array): void;
  eventAudioCallback?: (...args: unknown[]) => void;
  rtcpSession?: { interleavedId: number } | null;
}

const sandbox = createMediaSessionLegacySandbox();
(sandbox as Record<string, unknown>).Session = loadLegacyModule('MediaSession/session.js', 'Session', sandbox);
(sandbox as Record<string, unknown>).RtpSession = loadLegacyModule('MediaSession/rtpSession.js', 'RtpSession', sandbox);

const LegacyAACSessionCtor = loadLegacyModule<new () => LegacyAACSession>(
  'MediaSession/AudioSession/aacSession.js',
  'AACSession',
  sandbox
);

function rtpHeader(marker: boolean, timestamp: number): Uint8Array {
  const header = new Uint8Array(12);
  header[0] = 0x80;
  header[1] = (marker ? 0x80 : 0x00) | 0x61;
  header[4] = (timestamp >>> 24) & 0xff;
  header[5] = (timestamp >>> 16) & 0xff;
  header[6] = (timestamp >>> 8) & 0xff;
  header[7] = timestamp & 0xff;
  return header;
}

const RTSP_INTERLEAVED = Uint8Array.from([0x24, 0]);

describe('AACSession parity with the legacy player’s MediaSession/AudioSession/aacSession.js', () => {
  it('a single marker-bit packet produces an identical streamData/audioInfo callback', () => {
    const legacy = new LegacyAACSessionCtor();
    const ported = new AACSession();
    const info = { config: '1210', bitrate: 128000, clockFreq: 44100 };
    legacy.init(info);
    ported.init(info);
    legacy.rtcpSession = { interleavedId: 1 };
    ported.rtcpSession = { interleavedId: 1 };

    const legacyCb = vi.fn();
    const portedCb = vi.fn();
    legacy.eventAudioCallback = legacyCb;
    ported.eventAudioCallback = portedCb;

    // 4-byte AU header + raw AAC payload, ADT header already absent so genADTSAAC() should fire.
    const payload = Uint8Array.from([0x00, 0x10, 0x00, 0x00, 0x21, 0x19, 0x56, 0xe5, 0xa0]);
    legacy.depacketize(RTSP_INTERLEAVED, rtpHeader(true, 5000), payload);
    ported.depacketize(RTSP_INTERLEAVED, rtpHeader(true, 5000), payload);

    expect(legacyCb).toHaveBeenCalledTimes(1);
    const [legacyPlayMode, legacyStreamData] = legacyCb.mock.calls[0];
    const [portedPlayMode, portedStreamData] = portedCb.mock.calls[0];
    expect(portedPlayMode).toBe(legacyPlayMode);
    expect(Array.from(portedStreamData.ADTs)).toEqual(Array.from(legacyStreamData.ADTs));
    expect(Array.from(portedStreamData.frameData)).toEqual(Array.from(legacyStreamData.frameData));
  });
});
