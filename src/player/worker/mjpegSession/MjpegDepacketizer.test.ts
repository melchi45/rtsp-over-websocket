import { describe, it, expect, vi } from 'vitest';
import { loadLegacyModule } from '../../test-support/loadLegacyModule';
import { MjpegDepacketizer, type MjpegFrameData } from './MjpegDepacketizer';

interface LegacyMjpegDepacketizer {
  interleavedId: number | undefined;
  deviceType: string;
  init(callback: (data: MjpegFrameData) => void): void;
  setGotFrameCallback(callback: (data: MjpegFrameData) => void): void;
  depacketize(rtspInterleaved: Uint8Array, rtpHeader: Uint8Array, rtpPayload: Uint8Array): void;
}

function loadLegacy(): LegacyMjpegDepacketizer {
  const factory = loadLegacyModule<() => LegacyMjpegDepacketizer>('Worker/MjpegSession/mjpegDepacketizer.js', 'MjpegDepacketizer');
  return factory();
}

/** Builds a minimal RFC 2435 JPEG/RTP payload header + scan bytes, no restart marker, no custom Q table. */
function buildJpegPayload(opts: { fragmentOffset: number; type?: number; q?: number; widthDiv8?: number; heightDiv8?: number; scan: number[] }): Uint8Array {
  const { fragmentOffset, type = 1, q = 50, widthDiv8 = 10, heightDiv8 = 10, scan } = opts;
  const header = new Uint8Array(8);
  header[0] = 0; // type-specific
  header[1] = (fragmentOffset >> 16) & 0xff;
  header[2] = (fragmentOffset >> 8) & 0xff;
  header[3] = fragmentOffset & 0xff;
  header[4] = type;
  header[5] = q;
  header[6] = widthDiv8;
  header[7] = heightDiv8;
  return new Uint8Array([...header, ...scan]);
}

function buildRtspInterleaved(rtpTotalLength: number): Uint8Array {
  return new Uint8Array([0x24, 0, (rtpTotalLength >> 8) & 0xff, rtpTotalLength & 0xff]);
}

function buildRtpHeader(opts: { marker: boolean; extension?: boolean; csrcCount?: number; padding?: boolean; timestamp: number }): Uint8Array {
  const { marker, extension = false, csrcCount = 0, padding = false, timestamp } = opts;
  const header = new Uint8Array(12);
  header[0] = 0x80 | (padding ? 0x20 : 0) | (extension ? 0x10 : 0) | (csrcCount & 0x0f);
  header[1] = (marker ? 0x80 : 0) | 26;
  header[2] = 0;
  header[3] = 1;
  header[4] = (timestamp >>> 24) & 0xff;
  header[5] = (timestamp >>> 16) & 0xff;
  header[6] = (timestamp >>> 8) & 0xff;
  header[7] = timestamp & 0xff;
  header[8] = 0;
  header[9] = 0;
  header[10] = 0;
  header[11] = 1;
  return header;
}

function toComparable(frame: MjpegFrameData): unknown {
  return {
    playMode: frame.playMode,
    streamData: {
      ...frame.streamData,
      frameData: Array.from(frame.streamData.frameData)
    },
    videoInfo: frame.videoInfo
  };
}

function depacketizeOneFrame<T extends { depacketize: LegacyMjpegDepacketizer['depacketize']; init: LegacyMjpegDepacketizer['init'] }>(
  instance: T,
  packets: { rtspInterleaved: Uint8Array; rtpHeader: Uint8Array; rtpPayload: Uint8Array }[]
): MjpegFrameData {
  let captured: MjpegFrameData | undefined;
  instance.init((data) => {
    captured = data;
  });
  for (const packet of packets) {
    instance.depacketize(packet.rtspInterleaved, packet.rtpHeader, packet.rtpPayload);
  }
  if (!captured) {
    throw new Error('depacketizeOneFrame: no frame was emitted');
  }
  return captured;
}

describe('MjpegDepacketizer parity with the legacy player’s Worker/MjpegSession/mjpegDepacketizer.js', () => {
  it('reassembles a single-fragment JPEG frame identically (JFIF header + scan bytes, videoInfo, timestamp)', () => {
    const scan = [0xaa, 0xbb, 0xcc, 0xdd];
    const payload = buildJpegPayload({ fragmentOffset: 0, scan });
    const rtpHeader = buildRtpHeader({ marker: true, timestamp: 900 });
    const rtspInterleaved = buildRtspInterleaved(12 + payload.length);

    const legacy = loadLegacy();
    const legacyFrame = depacketizeOneFrame(legacy, [{ rtspInterleaved, rtpHeader, rtpPayload: payload }]);

    const ported = new MjpegDepacketizer();
    const portedFrame = depacketizeOneFrame(ported, [{ rtspInterleaved, rtpHeader, rtpPayload: payload }]);

    expect(toComparable(portedFrame)).toEqual(toComparable(legacyFrame));
    expect(portedFrame.videoInfo).toEqual({ frameType: 'I', width: 80, height: 80, framerate: 0 });
    expect(portedFrame.streamData.timeStamp.rtpTimestamp).toBe((900 / 90).toFixed(0));
  });

  it('reassembles a multi-fragment JPEG frame identically (two RTP packets, second carries the marker bit)', () => {
    const firstScan = [0x01, 0x02, 0x03];
    const secondScan = [0x04, 0x05];
    const firstPayload = buildJpegPayload({ fragmentOffset: 0, scan: firstScan });
    const secondPayload = buildJpegPayload({ fragmentOffset: firstScan.length, scan: secondScan });

    const packets = [
      { rtspInterleaved: buildRtspInterleaved(12 + firstPayload.length), rtpHeader: buildRtpHeader({ marker: false, timestamp: 500 }), rtpPayload: firstPayload },
      { rtspInterleaved: buildRtspInterleaved(12 + secondPayload.length), rtpHeader: buildRtpHeader({ marker: true, timestamp: 500 }), rtpPayload: secondPayload }
    ];

    const legacyFrame = depacketizeOneFrame(loadLegacy(), packets);
    const portedFrame = depacketizeOneFrame(new MjpegDepacketizer(), packets);

    expect(toComparable(portedFrame)).toEqual(toComparable(legacyFrame));
  });

  it('throws identically (ReferenceError: PaddingSize is not defined) when the padding bit is set with no CSRC (legacy: undeclared global assignment under strict mode)', () => {
    const payload = buildJpegPayload({ fragmentOffset: 0, scan: [0x01] });
    const rtpHeader = buildRtpHeader({ marker: true, padding: true, timestamp: 1 });
    const rtspInterleaved = buildRtspInterleaved(12 + payload.length);

    const legacy = loadLegacy();
    let legacyMessage = '';
    try {
      legacy.depacketize(rtspInterleaved, rtpHeader, payload);
    } catch (error) {
      legacyMessage = (error as Error).message;
    }

    const ported = new MjpegDepacketizer();
    expect(() => ported.depacketize(rtspInterleaved, rtpHeader, payload)).toThrow(legacyMessage);
    expect(legacyMessage).toBe('PaddingSize is not defined');
  });

  it('does not throw when CSRC count is nonzero (legacy: console.error only) and still depacketizes normally', () => {
    const scan = [0x11, 0x22];
    const payload = buildJpegPayload({ fragmentOffset: 0, scan });
    const rtpHeader = buildRtpHeader({ marker: true, csrcCount: 2, timestamp: 42 });
    const rtspInterleaved = buildRtspInterleaved(12 + payload.length);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const legacyFrame = depacketizeOneFrame(loadLegacy(), [{ rtspInterleaved, rtpHeader, rtpPayload: payload }]);
    const portedFrame = depacketizeOneFrame(new MjpegDepacketizer(), [{ rtspInterleaved, rtpHeader, rtpPayload: payload }]);

    expect(toComparable(portedFrame)).toEqual(toComparable(legacyFrame));
    errorSpy.mockRestore();
  });

  it('parses the sync-source-only extension header (0xFF 0xDD) identically, including objectId', () => {
    const scan = [0x9a];
    const extHeader = [0xff, 0xdd, 0x00, 0x00, 0, 0, 0, 7]; // objectId = 7
    const jpegHeaderBytes = buildJpegPayload({ fragmentOffset: 0, scan: [] }); // 8-byte JPEG/RTP header at offset extensionHeaderLen
    const payload = new Uint8Array([...extHeader, ...jpegHeaderBytes, ...scan]);
    const rtpHeader = buildRtpHeader({ marker: true, extension: true, timestamp: 10 });
    const rtspInterleaved = buildRtspInterleaved(12 + payload.length);

    const legacyFrame = depacketizeOneFrame(loadLegacy(), [{ rtspInterleaved, rtpHeader, rtpPayload: payload }]);
    const portedFrame = depacketizeOneFrame(new MjpegDepacketizer(), [{ rtspInterleaved, rtpHeader, rtpPayload: payload }]);

    expect(toComparable(portedFrame)).toEqual(toComparable(legacyFrame));
    expect(portedFrame.streamData.objectId).toBe(7);
  });

  it('interleavedId/deviceType are real accessors, identically to legacy', () => {
    const legacy = loadLegacy();
    const ported = new MjpegDepacketizer();

    legacy.interleavedId = 3;
    ported.interleavedId = 3;
    legacy.deviceType = 'nvr';
    ported.deviceType = 'nvr';

    expect(ported.interleavedId).toBe(legacy.interleavedId);
    expect(ported.deviceType).toBe(legacy.deviceType);
  });
});
