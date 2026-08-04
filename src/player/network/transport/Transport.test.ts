import { describe, it, expect, vi } from 'vitest';
import { loadLegacyModule } from '../../test-support/loadLegacyModule';
import { createNetworkLegacySandbox } from '../../test-support/legacyGlobals';
import { Transport } from './Transport';

interface LegacyTransport {
  channelId: number;
  index: number;
  autoconnection: boolean;
  websock: { readyState: number; close(): void; send(data: unknown): void } | null;
  OnReceive(event: { data: ArrayBuffer }): void;
  SetCallback(
    connectionCb: (...args: unknown[]) => void,
    rtspCb: (...args: unknown[]) => void,
    rtpCb: (...args: unknown[]) => void,
    errorCb: (...args: unknown[]) => void,
    receivedCb?: (...args: unknown[]) => void
  ): void;
  SendRtspCommand(message: string | null, response?: (...args: unknown[]) => void): unknown;
  onStatisticsTimer(): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  dispatchEvent(event: { type: string; bubbles: boolean; detail: unknown }): void;
}

const sandbox = createNetworkLegacySandbox();
const LegacyTransportCtor = loadLegacyModule<new (serverAddr: string) => LegacyTransport>(
  'Network/transport/transport.js',
  'Transport',
  sandbox
);

function rtspMessageBytes(): Uint8Array {
  const text = 'RTSP/1.0 200 OK\r\nCSeq: 1\r\nContent-Length: 5\r\n\r\nHELLO';
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

function rtpPacketBytes(channel: number, payload: number[]): Uint8Array {
  const totalLen = 12 + payload.length;
  const packet = new Uint8Array(4 + totalLen);
  packet[0] = 0x24;
  packet[1] = channel;
  packet[2] = (totalLen >> 8) & 0xff;
  packet[3] = totalLen & 0xff;
  packet.set([0x80, 0x60, 0, 1, 0, 0, 0, 100, 0, 0, 0, 1], 4);
  packet.set(payload, 4 + 12);
  return packet;
}

describe('Transport parity with the legacy player’s Network/transport/transport.js', () => {
  it('OnReceive parses a plain RTSP response (with Content-Length body) identically', () => {
    const legacy = new LegacyTransportCtor('ws://example.invalid');
    const ported = new Transport('ws://example.invalid');

    const legacyRtsp = vi.fn();
    const portedRtsp = vi.fn();
    legacy.SetCallback(vi.fn(), legacyRtsp, vi.fn(), vi.fn());
    ported.SetCallback(vi.fn(), portedRtsp, vi.fn(), vi.fn());

    const bytes = rtspMessageBytes();
    legacy.OnReceive({ data: bytes.buffer as ArrayBuffer });
    ported.OnReceive({ data: bytes.buffer as ArrayBuffer });

    expect(legacyRtsp).toHaveBeenCalledTimes(1);
    expect(portedRtsp.mock.calls[0][0]).toBe(legacyRtsp.mock.calls[0][0]);
  });

  it('OnReceive demultiplexes an RTP packet (interleave/header/payload) identically', () => {
    const legacy = new LegacyTransportCtor('ws://example.invalid');
    const ported = new Transport('ws://example.invalid');

    const legacyRtp = vi.fn();
    const portedRtp = vi.fn();
    legacy.SetCallback(vi.fn(), vi.fn(), legacyRtp, vi.fn());
    ported.SetCallback(vi.fn(), vi.fn(), portedRtp, vi.fn());

    const bytes = rtpPacketBytes(2, [1, 2, 3, 4]);
    legacy.OnReceive({ data: bytes.buffer as ArrayBuffer });
    ported.OnReceive({ data: bytes.buffer as ArrayBuffer });

    expect(legacyRtp).toHaveBeenCalledTimes(1);
    const [legacyInterleave, legacyHeader, legacyPayload] = legacyRtp.mock.calls[0];
    const [portedInterleave, portedHeader, portedPayload] = portedRtp.mock.calls[0];
    expect(Array.from(portedInterleave)).toEqual(Array.from(legacyInterleave));
    expect(Array.from(portedHeader)).toEqual(Array.from(legacyHeader));
    expect(Array.from(portedPayload)).toEqual(Array.from(legacyPayload));
  });

  it('OnReceive reports an error identically for data that is neither RTSP nor RTP-tagged', () => {
    const legacy = new LegacyTransportCtor('ws://example.invalid');
    const ported = new Transport('ws://example.invalid');
    const legacyErr = vi.fn();
    const portedErr = vi.fn();
    legacy.SetCallback(vi.fn(), vi.fn(), vi.fn(), legacyErr);
    ported.SetCallback(vi.fn(), vi.fn(), vi.fn(), portedErr);

    const junk = Uint8Array.from([0x01, 0x02, 0x03, 0x04]);
    legacy.OnReceive({ data: junk.buffer as ArrayBuffer });
    ported.OnReceive({ data: junk.buffer as ArrayBuffer });

    expect(portedErr.mock.calls[0][0]).toEqual(legacyErr.mock.calls[0][0]);
  });

  it('SendRtspCommand sends the stringified message over an open fake socket identically', () => {
    const legacy = new LegacyTransportCtor('ws://example.invalid');
    const ported = new Transport('ws://example.invalid');
    const legacySend = vi.fn();
    const portedSend = vi.fn();
    legacy.websock = { readyState: 1, close: vi.fn(), send: legacySend };
    ported.websock = { readyState: 1, binaryType: '', onopen: null, onmessage: null, onclose: null, onerror: null, close: vi.fn(), send: portedSend };

    legacy.SendRtspCommand('OPTIONS rtsp://x RTSP/1.0\r\n\r\n');
    ported.SendRtspCommand('OPTIONS rtsp://x RTSP/1.0\r\n\r\n');

    expect(Array.from(portedSend.mock.calls[0][0])).toEqual(Array.from(legacySend.mock.calls[0][0]));
  });

  it('onStatisticsTimer accumulates and reports received-byte totals identically', () => {
    const legacy = new LegacyTransportCtor('ws://example.invalid');
    const ported = new Transport('ws://example.invalid');
    const legacyReceived = vi.fn();
    const portedReceived = vi.fn();
    legacy.SetCallback(vi.fn(), vi.fn(), vi.fn(), vi.fn(), legacyReceived);
    ported.SetCallback(vi.fn(), vi.fn(), vi.fn(), vi.fn(), portedReceived);

    const bytes = rtspMessageBytes();
    legacy.OnReceive({ data: bytes.buffer as ArrayBuffer });
    ported.OnReceive({ data: bytes.buffer as ArrayBuffer });
    legacy.onStatisticsTimer();
    ported.onStatisticsTimer();

    expect(portedReceived.mock.calls[0][0]).toEqual(legacyReceived.mock.calls[0][0]);
  });

  it('addEventListener/dispatchEvent deliver the same event shape to listeners', () => {
    const legacy = new LegacyTransportCtor('ws://example.invalid');
    const ported = new Transport('ws://example.invalid');
    const legacyListener = vi.fn();
    const portedListener = vi.fn();
    legacy.addEventListener('rtsp', legacyListener);
    ported.addEventListener('rtsp', portedListener);

    legacy.dispatchEvent({ type: 'rtsp', bubbles: true, detail: { rtsp: 'hello' } });
    ported.dispatchEvent({ type: 'rtsp', bubbles: true, detail: { rtsp: 'hello' } });

    expect(legacyListener).toHaveBeenCalledTimes(1);
    expect(portedListener.mock.calls[0][0].detail).toEqual(legacyListener.mock.calls[0][0].detail);
  });
});
