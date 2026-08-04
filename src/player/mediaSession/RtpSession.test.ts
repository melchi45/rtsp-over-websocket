import { describe, it, expect, vi } from 'vitest';
import { loadLegacyModule } from '../test-support/loadLegacyModule';
import { createMediaSessionLegacySandbox } from '../test-support/legacyGlobals';
import { RtpSession } from './RtpSession';

interface LegacyRtpSession {
  deviceType: string;
  frameRate?: number;
  channelId: number;
  interleavedId: number;
  type?: string;
  codec: string;
  isLost: boolean;
  eventStatisticsCallback?: (data: unknown) => void;
  eventWaitingCallback?: (data: unknown) => void;
  setFramerate(v: number): void;
  getFramerate(): number | undefined;
  appendBuffer(currentBuffer: Uint8Array, newBuffer: Uint8Array, readLength: number): Uint8Array;
  increaseNumberOfReceivedPacketCount(): void;
  getNumberOfReceivedPacketCount(): number;
  isInitializeReceivedPacketCount(): boolean;
  increaseNumberOfDroppedPacket(): void;
  getNumberOfDroppedPacketCount(): number;
  onStatisticsTimer(): void;
  startStatisticsTimer(interval?: number): void;
  stopStatisticsTimer(): void;
  getStatisticsTimer(): unknown;
}

const sandbox = createMediaSessionLegacySandbox();
(sandbox as Record<string, unknown>).Session = loadLegacyModule('MediaSession/session.js', 'Session', sandbox);

const LegacyRtpSessionCtor = loadLegacyModule<new () => LegacyRtpSession>('MediaSession/rtpSession.js', 'RtpSession', sandbox);

describe('RtpSession parity with the legacy player’s MediaSession/rtpSession.js', () => {
  it('has the same default deviceType and packet counters', () => {
    const legacy = new LegacyRtpSessionCtor();
    const ported = new RtpSession();
    expect(ported.deviceType).toBe(legacy.deviceType);
    expect(ported.getNumberOfReceivedPacketCount()).toBe(legacy.getNumberOfReceivedPacketCount());
    expect(ported.isInitializeReceivedPacketCount()).toBe(legacy.isInitializeReceivedPacketCount());
  });

  it('appendBuffer grows the buffer identically when it would overflow', () => {
    const legacy = new LegacyRtpSessionCtor();
    const ported = new RtpSession();
    const current = new Uint8Array(4);
    const incoming = new Uint8Array([9, 9, 9, 9, 9]);
    const legacyResult = legacy.appendBuffer(current, incoming, 2);
    const portedResult = ported.appendBuffer(current, incoming, 2);
    expect(Array.from(portedResult)).toEqual(Array.from(legacyResult));
  });

  it('increaseNumberOfReceivedPacketCount clears isLost and increments the counter identically', () => {
    const legacy = new LegacyRtpSessionCtor();
    const ported = new RtpSession();
    legacy.increaseNumberOfReceivedPacketCount();
    ported.increaseNumberOfReceivedPacketCount();
    expect(ported.getNumberOfReceivedPacketCount()).toBe(legacy.getNumberOfReceivedPacketCount());
    expect(ported.isLost).toBe(legacy.isLost);
  });

  it('onStatisticsTimer fires eventStatisticsCallback with identical fps/interval fields once packets have arrived', () => {
    const legacy = new LegacyRtpSessionCtor();
    const ported = new RtpSession();
    legacy.type = 'video';
    ported.type = 'video';
    legacy.codec = 'H264';
    ported.codec = 'H264';

    for (let i = 0; i < 5; i++) {
      legacy.increaseNumberOfReceivedPacketCount();
      ported.increaseNumberOfReceivedPacketCount();
    }

    const legacyCb = vi.fn();
    const portedCb = vi.fn();
    legacy.eventStatisticsCallback = legacyCb;
    ported.eventStatisticsCallback = portedCb;

    legacy.onStatisticsTimer();
    ported.onStatisticsTimer();

    expect(portedCb.mock.calls[0]?.[0]).toEqual(legacyCb.mock.calls[0]?.[0]);
  });

  it('startStatisticsTimer/stopStatisticsTimer manage a live timer identically (non-null then null)', () => {
    const legacy = new LegacyRtpSessionCtor();
    const ported = new RtpSession();
    legacy.startStatisticsTimer();
    ported.startStatisticsTimer();
    expect(legacy.getStatisticsTimer()).not.toBeNull();
    expect(ported.getStatisticsTimer()).not.toBeNull();
    legacy.stopStatisticsTimer();
    ported.stopStatisticsTimer();
    expect(legacy.getStatisticsTimer()).toBeNull();
    expect(ported.getStatisticsTimer()).toBeNull();
  });
});
