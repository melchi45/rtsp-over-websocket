import { describe, it, expect, vi } from 'vitest';
import { loadLegacyModule } from '../../test-support/loadLegacyModule';
import { createMediaSessionLegacySandbox } from '../../test-support/legacyGlobals';
import { MjpegSession, type MjpegWorkerLike, type MjpegWorkerMessage } from './MjpegSession';

interface LegacyMjpegSession {
  init(): void;
  depacketize(rtspInterleaved: Uint8Array, rtpHeader: Uint8Array, rtpPayload: Uint8Array): void;
  close(): void;
  eventVideoCallback?: (...args: unknown[]) => void;
  channelId: number;
  deviceType?: string;
  information?: string;
  clock: number;
  sessionId: string | null;
  rtcpSession?: { interleavedId: number } | null;
}

class FakeWorker implements MjpegWorkerLike {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: MjpegWorkerMessage }) => void) | null = null;
  posted: unknown[] = [];
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }
}

const sandbox = createMediaSessionLegacySandbox();
(sandbox as Record<string, unknown>).Session = loadLegacyModule('MediaSession/session.js', 'Session', sandbox);
(sandbox as Record<string, unknown>).RtpSession = loadLegacyModule('MediaSession/rtpSession.js', 'RtpSession', sandbox);
(sandbox as Record<string, unknown>).Worker = FakeWorker;

const LegacyMjpegSessionCtor = loadLegacyModule<new () => LegacyMjpegSession>(
  'MediaSession/VideoSession/mjpegSession.js',
  'MjpegSession',
  sandbox
);

function rtpHeader(marker: boolean, seq: number, timestamp: number): Uint8Array {
  const header = new Uint8Array(12);
  header[0] = 0x80;
  header[1] = (marker ? 0x80 : 0x00) | 0x1a;
  header[2] = (seq >> 8) & 0xff;
  header[3] = seq & 0xff;
  header[4] = (timestamp >>> 24) & 0xff;
  header[5] = (timestamp >>> 16) & 0xff;
  header[6] = (timestamp >>> 8) & 0xff;
  header[7] = timestamp & 0xff;
  return header;
}

const RTSP_INTERLEAVED = Uint8Array.from([0x24, 0]);

describe('MjpegSession parity with the legacy player’s MediaSession/VideoSession/mjpegSession.js', () => {
  it('init() creates exactly one worker, even if called twice', () => {
    FakeWorker.instances = [];
    const legacy = new LegacyMjpegSessionCtor();
    legacy.init();
    legacy.init();
    expect(FakeWorker.instances.length).toBe(1);

    FakeWorker.instances = [];
    const ported = new MjpegSession(() => new FakeWorker());
    ported.init();
    ported.init();
    expect(FakeWorker.instances.length).toBe(1);
  });

  it('accumulates packets and only posts to the worker on a marker-bit packet, identically', () => {
    FakeWorker.instances = [];
    const legacy = new LegacyMjpegSessionCtor();
    legacy.init();
    legacy.rtcpSession = { interleavedId: 1 };
    const legacyWorker = FakeWorker.instances[0];

    FakeWorker.instances = [];
    const ported = new MjpegSession(() => new FakeWorker());
    ported.init();
    ported.rtcpSession = { interleavedId: 1 };
    const portedWorker = FakeWorker.instances[0];

    legacy.depacketize(RTSP_INTERLEAVED, rtpHeader(false, 1, 3000), Uint8Array.from([0xff, 0xd8]));
    ported.depacketize(RTSP_INTERLEAVED, rtpHeader(false, 1, 3000), Uint8Array.from([0xff, 0xd8]));
    expect(legacyWorker.posted.length).toBe(0);
    expect(portedWorker.posted.length).toBe(0);

    legacy.depacketize(RTSP_INTERLEAVED, rtpHeader(true, 2, 3000), Uint8Array.from([0xff, 0xd9]));
    ported.depacketize(RTSP_INTERLEAVED, rtpHeader(true, 2, 3000), Uint8Array.from([0xff, 0xd9]));

    expect(portedWorker.posted.length).toBe(legacyWorker.posted.length);
    expect(portedWorker.posted.length).toBe(1);

    const legacyMsg = legacyWorker.posted[0] as { dataArray: unknown[] };
    const portedMsg = portedWorker.posted[0] as { dataArray: unknown[] };
    expect(portedMsg.dataArray.length).toBe(legacyMsg.dataArray.length);
    expect(portedMsg.dataArray.length).toBe(2);
  });

  it('flushes at the 50-packet stack threshold even without a marker bit, identically', () => {
    FakeWorker.instances = [];
    const legacy = new LegacyMjpegSessionCtor();
    legacy.init();
    legacy.rtcpSession = { interleavedId: 1 };
    const legacyWorker = FakeWorker.instances[0];

    FakeWorker.instances = [];
    const ported = new MjpegSession(() => new FakeWorker());
    ported.init();
    ported.rtcpSession = { interleavedId: 1 };
    const portedWorker = FakeWorker.instances[0];

    for (let i = 1; i <= 50; i++) {
      legacy.depacketize(RTSP_INTERLEAVED, rtpHeader(false, i, 3000), Uint8Array.from([i & 0xff]));
      ported.depacketize(RTSP_INTERLEAVED, rtpHeader(false, i, 3000), Uint8Array.from([i & 0xff]));
    }

    expect(portedWorker.posted.length).toBe(legacyWorker.posted.length);
    expect(portedWorker.posted.length).toBe(1);
  });

  it('delivers a worker response to eventVideoCallback with the same isMetaImage derivation, identically', () => {
    FakeWorker.instances = [];
    const legacy = new LegacyMjpegSessionCtor();
    legacy.init();
    const legacyCb = vi.fn();
    legacy.eventVideoCallback = legacyCb;
    legacy.information = 'MetaImageSession';
    const legacyWorker = FakeWorker.instances[0];

    FakeWorker.instances = [];
    const ported = new MjpegSession(() => new FakeWorker());
    ported.init();
    const portedCb = vi.fn();
    ported.eventVideoCallback = portedCb;
    ported.information = 'MetaImageSession';
    const portedWorker = FakeWorker.instances[0];

    const message: MjpegWorkerMessage = { playMode: 'live', streamData: new Uint8Array([1, 2, 3]), videoInfo: { width: 10 } };
    legacyWorker.onmessage!({ data: message });
    portedWorker.onmessage!({ data: message });

    expect(portedCb.mock.calls[0]).toEqual(legacyCb.mock.calls[0]);
    expect(portedCb.mock.calls[0][3]).toBe(true);
  });

  it('close() terminates the worker and clears sessionId identically, and is safe to call again', () => {
    const legacy = new LegacyMjpegSessionCtor();
    legacy.init();
    legacy.sessionId = 'abc';
    const legacyWorker = FakeWorker.instances[FakeWorker.instances.length - 1];

    const ported = new MjpegSession(() => new FakeWorker());
    ported.init();
    ported.sessionId = 'abc';
    const portedWorker = FakeWorker.instances[FakeWorker.instances.length - 1];

    legacy.close();
    ported.close();
    expect(portedWorker.terminated).toBe(legacyWorker.terminated);
    expect(portedWorker.terminated).toBe(true);
    expect(ported.sessionId).toBe(legacy.sessionId);
    expect(ported.sessionId).toBeNull();

    expect(() => legacy.close()).not.toThrow();
    expect(() => ported.close()).not.toThrow();
  });
});
