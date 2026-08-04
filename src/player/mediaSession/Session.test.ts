import { describe, it, expect, vi } from 'vitest';
import { loadLegacyModule } from '../test-support/loadLegacyModule';
import { createNoopLoggerGlobal } from '../test-support/legacyGlobals';
import { Session } from './Session';

interface LegacySession {
  interleavedId: number;
  channelId: number;
  running: boolean;
  clock: number;
  htonl(h: number): number[];
  ntohl(n: ArrayLike<number>): number;
  htons(h: number): number[];
  ntohs(n: ArrayLike<number>): number;
  addEventListener(event: string, cb: (...args: unknown[]) => void): void;
  removeEventListener(event: string): void;
  SetTimeStamp(data: unknown): void;
  GetTimeStamp(): unknown;
  eventVideoCallback?: unknown;
}

const LegacySessionCtor = loadLegacyModule<new () => LegacySession>('MediaSession/session.js', 'Session', {
  log: createNoopLoggerGlobal()
});

describe('Session parity with the legacy player’s MediaSession/session.js', () => {
  it('has the same default field values', () => {
    const legacy = new LegacySessionCtor();
    const ported = new Session();
    expect(ported.interleavedId).toBe(legacy.interleavedId);
    expect(ported.channelId).toBe(legacy.channelId);
    expect(ported.running).toBe(legacy.running);
    expect(ported.clock).toBe(legacy.clock);
  });

  it('htonl/ntohl/htons/ntohs match for representative values', () => {
    const legacy = new LegacySessionCtor();
    const ported = new Session();
    for (const v of [0, 1, 255, 256, 65535, 0x12345678]) {
      expect(ported.htonl(v)).toEqual(legacy.htonl(v));
    }
    for (const v of [0, 1, 255, 256]) {
      expect(ported.htons(v)).toEqual(legacy.htons(v));
    }
    expect(ported.ntohl(Uint8Array.from([0x12, 0x34, 0x56, 0x78]))).toBe(
      legacy.ntohl(Uint8Array.from([0x12, 0x34, 0x56, 0x78]))
    );
    expect(ported.ntohs(Uint8Array.from([0x12, 0x34]))).toBe(legacy.ntohs(Uint8Array.from([0x12, 0x34])));
  });

  it('addEventListener/removeEventListener wire up the same callback slots', () => {
    const legacy = new LegacySessionCtor();
    const ported = new Session();
    const cb = vi.fn();
    legacy.addEventListener('video', cb);
    ported.addEventListener('video', cb);
    expect(typeof ported.eventVideoCallback).toBe(typeof legacy.eventVideoCallback);

    legacy.removeEventListener('video');
    ported.removeEventListener('video');
    expect(ported.eventVideoCallback).toBe(legacy.eventVideoCallback);
  });

  it('SetTimeStamp/GetTimeStamp round-trip identically', () => {
    const legacy = new LegacySessionCtor();
    const ported = new Session();
    const data = { timestamp: 123, timestamp_usec: 456, timezone: 9 };
    legacy.SetTimeStamp(data);
    ported.SetTimeStamp(data);
    expect(ported.GetTimeStamp()).toEqual(legacy.GetTimeStamp());
  });
});
