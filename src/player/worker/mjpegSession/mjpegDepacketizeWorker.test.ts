import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MjpegDepacketizeRequestEntry } from './mjpegDepacketizeWorker';
import type { MjpegFrameData } from './MjpegDepacketizer';

function buildJpegPayload(scan: number[]): Uint8Array {
  // 8-byte RFC 2435 header (fragmentOffset=0, type=1, q=50, 80x80), then scan bytes.
  return new Uint8Array([0, 0, 0, 0, 1, 50, 10, 10, ...scan]);
}

function buildRtpHeader(marker: boolean, timestamp: number): Uint8Array {
  const header = new Uint8Array(12);
  header[0] = 0x80;
  header[1] = (marker ? 0x80 : 0) | 26;
  header[4] = (timestamp >>> 24) & 0xff;
  header[5] = (timestamp >>> 16) & 0xff;
  header[6] = (timestamp >>> 8) & 0xff;
  header[7] = timestamp & 0xff;
  return header;
}

/** Contract-tier test: this file is thin onmessage/postMessage glue around MjpegDepacketizer (parity-tested separately). */
describe('mjpegDepacketizeWorker contract tests (the legacy player’s Worker/MjpegSession/mjpegDepacketizeWorker.js)', () => {
  let onmessage: ((event: { data: { dataArray: MjpegDepacketizeRequestEntry[] } }) => void) | null;
  let postMessage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    onmessage = null;
    postMessage = vi.fn();
    vi.stubGlobal('self', {
      get onmessage() {
        return onmessage;
      },
      set onmessage(handler) {
        onmessage = handler;
      },
      postMessage
    });
    vi.resetModules();
    await import('./mjpegDepacketizeWorker');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('registers an onmessage handler on import', () => {
    expect(typeof onmessage).toBe('function');
  });

  it('depacketizes a single-fragment frame on the next tick and posts a message with the frame buffer transferred', () => {
    const payload = buildJpegPayload([0xaa, 0xbb]);
    const entry: MjpegDepacketizeRequestEntry = {
      deviceType: 'camera',
      rtspInterleave: new Uint8Array([0x24, 0, 0, (12 + payload.length) & 0xff]),
      interleavedId: 0,
      channelId: 1,
      header: buildRtpHeader(true, 900),
      payload
    };

    onmessage!({ data: { dataArray: [entry] } });
    expect(postMessage).not.toHaveBeenCalled();

    vi.runAllTimers();

    expect(postMessage).toHaveBeenCalledTimes(1);
    const [message, transfer] = postMessage.mock.calls[0] as [MjpegFrameData, Transferable[]];
    expect(message.playMode).toBe('Live');
    expect(message.videoInfo).toEqual({ frameType: 'I', width: 80, height: 80, framerate: 0 });
    expect(transfer).toEqual([message.streamData.frameData.buffer]);
  });

  it('batches multiple onmessage calls queued before the depacketize tick runs', () => {
    const payloadA = buildJpegPayload([0x01]);
    const payloadB = buildJpegPayload([0x02]);
    const entryA: MjpegDepacketizeRequestEntry = {
      deviceType: 'camera',
      rtspInterleave: new Uint8Array([0x24, 0, 0, (12 + payloadA.length) & 0xff]),
      interleavedId: 0,
      channelId: 1,
      header: buildRtpHeader(true, 100),
      payload: payloadA
    };
    const entryB: MjpegDepacketizeRequestEntry = {
      deviceType: 'camera',
      rtspInterleave: new Uint8Array([0x24, 0, 0, (12 + payloadB.length) & 0xff]),
      interleavedId: 0,
      channelId: 1,
      header: buildRtpHeader(true, 200),
      payload: payloadB
    };

    onmessage!({ data: { dataArray: [entryA] } });
    onmessage!({ data: { dataArray: [entryB] } });
    vi.runAllTimers();

    expect(postMessage).toHaveBeenCalledTimes(2);
  });
});
