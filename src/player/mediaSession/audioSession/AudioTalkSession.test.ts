import { describe, it, expect, vi } from 'vitest';
import { loadLegacyModule } from '../../test-support/loadLegacyModule';
import { createMediaSessionLegacySandbox } from '../../test-support/legacyGlobals';
import { AudioTalkSession } from './AudioTalkSession';

interface LegacyAudioTalkSession {
  setSampleRate(rate: number): void;
  getRTPPacket(buffer: Float32Array): Uint8Array;
}

const sandbox = createMediaSessionLegacySandbox();
(sandbox as Record<string, unknown>).Session = loadLegacyModule('MediaSession/session.js', 'Session', sandbox);
(sandbox as Record<string, unknown>).RtpSession = loadLegacyModule('MediaSession/rtpSession.js', 'RtpSession', sandbox);
(sandbox as Record<string, unknown>).G711AudioEncoder = loadLegacyModule('Talk/Encoder/audioEncoderG711.js', 'G711AudioEncoder');

const LegacyAudioTalkSessionCtor = loadLegacyModule<new (channel: number) => LegacyAudioTalkSession>(
  'MediaSession/AudioSession/audioTalkSession.js',
  'AudioTalkSession',
  sandbox
);

describe('AudioTalkSession parity with the legacy player’s MediaSession/AudioSession/audioTalkSession.js', () => {
  it('getRTPPacket() builds an identical packet, excluding the wall-clock RTP timestamp bytes', () => {
    // Math is shared cross-realm by loadLegacyModule, so mocking it here also
    // pins the legacy side's `Math.random()`-derived ssrcId. The RTP timestamp
    // field, by contrast, comes from `new Date()` evaluated independently in
    // each realm (real wall-clock time) and is excluded from the comparison
    // below rather than chasing exact cross-realm Date mocking for one field.
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const legacy = new LegacyAudioTalkSessionCtor(3);
      const ported = new AudioTalkSession(3);
      legacy.setSampleRate(8000);
      ported.setSampleRate(8000);

      const samples = new Float32Array(20).map((_, i) => Math.sin(i / 3) * 0.5);
      const legacyPacket = Array.from(legacy.getRTPPacket(samples));
      const portedPacket = Array.from(ported.getRTPPacket(samples));

      // Packet layout: [0-3] rtspheader, [4-15] rtpheader (timestamp at [8-11]), [16+] payload.
      const stripTimestamp = (packet: number[]) => packet.filter((_, i) => i < 8 || i > 11);
      expect(stripTimestamp(portedPacket)).toEqual(stripTimestamp(legacyPacket));
      expect(portedPacket.length).toBe(legacyPacket.length);
    } finally {
      randomSpy.mockRestore();
    }
  });
});
