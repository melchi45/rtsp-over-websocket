import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { WebCodecsAudioEncoder } from './WebCodecsAudioEncoder';

// Minimal fakes of the real WebCodecs `AudioEncoder`/`AudioData` globals --
// jsdom (this file's test environment) doesn't implement WebCodecs at all,
// same reason OPUSAudioDecoder.ts/WebCodecsVideoEncoder.ts's own
// `typeof ... === 'undefined'` guards exist in the first place.
class FakeAudioData {
  format: string;
  sampleRate: number;
  numberOfFrames: number;
  numberOfChannels: number;
  timestamp: number;
  data: unknown;
  closed = false;

  constructor(init: { format: string; sampleRate: number; numberOfFrames: number; numberOfChannels: number; timestamp: number; data: unknown }) {
    this.format = init.format;
    this.sampleRate = init.sampleRate;
    this.numberOfFrames = init.numberOfFrames;
    this.numberOfChannels = init.numberOfChannels;
    this.timestamp = init.timestamp;
    this.data = init.data;
  }

  close(): void {
    this.closed = true;
  }
}

class FakeEncodedAudioChunk {
  constructor(
    public byteLength: number,
    public timestamp: number
  ) {}

  copyTo(buffer: Uint8Array): void {
    buffer.set(new Uint8Array(this.byteLength).fill(0xaa));
  }
}

function makeFakeAudioEncoderClass(options: { supported: boolean }) {
  return class FakeAudioEncoder {
    static isConfigSupported = vi.fn(async () => ({ supported: options.supported }));

    state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
    encodeCalls: unknown[] = [];

    constructor(private readonly init: { output: (chunk: FakeEncodedAudioChunk, metadata?: unknown) => void; error: (error: unknown) => void }) {}

    configure(): void {
      this.state = 'configured';
    }

    encode(data: FakeAudioData): void {
      this.encodeCalls.push(data);
      // Simulate the real API: output fires asynchronously via the encoder's
      // own output callback, using the AudioData's own byte length as a
      // stand-in "encoded size".
      this.init.output(new FakeEncodedAudioChunk(4, data.timestamp));
    }

    close(): void {
      this.state = 'closed';
    }
  };
}

describe('WebCodecsAudioEncoder', () => {
  afterEach(() => {
    delete (globalThis as { AudioEncoder?: unknown }).AudioEncoder;
    delete (globalThis as { AudioData?: unknown }).AudioData;
    vi.restoreAllMocks();
  });

  it('throws if the WebCodecs AudioEncoder API is not supported', () => {
    delete (globalThis as { AudioEncoder?: unknown }).AudioEncoder;
    expect(() => new WebCodecsAudioEncoder(8000, 1, { onEncodedChunk: () => {} })).toThrow();
  });

  it('calls onUnsupported when isConfigSupported() reports no support', async () => {
    (globalThis as { AudioEncoder?: unknown }).AudioEncoder = makeFakeAudioEncoderClass({ supported: false });
    (globalThis as { AudioData?: unknown }).AudioData = FakeAudioData;

    const onUnsupported = vi.fn();
    const encoder = new WebCodecsAudioEncoder(8000, 1, { onEncodedChunk: () => {}, onUnsupported });

    // configure() is async (awaits isConfigSupported()) -- flush microtasks.
    await Promise.resolve();
    await Promise.resolve();

    expect(onUnsupported).toHaveBeenCalledOnce();
    expect(encoder.isConfigured).toBe(false);
  });

  it('encodes PCM into an AudioData and feeds it to the underlying AudioEncoder once configured', async () => {
    (globalThis as { AudioEncoder?: unknown }).AudioEncoder = makeFakeAudioEncoderClass({ supported: true });
    (globalThis as { AudioData?: unknown }).AudioData = FakeAudioData;

    const onEncodedChunk = vi.fn();
    const encoder = new WebCodecsAudioEncoder(8000, 1, { onEncodedChunk });

    await Promise.resolve();
    await Promise.resolve();
    expect(encoder.isConfigured).toBe(true);

    const pcm = new Float32Array([0.1, 0.2, 0.3]);
    encoder.encode({ pcm, timestampUs: 1234 });

    expect(onEncodedChunk).toHaveBeenCalledOnce();
    const result = onEncodedChunk.mock.calls[0][0];
    expect(result.timestampUs).toBe(1234);
    expect(result.frameData).toBeInstanceOf(Uint8Array);
    expect(result.frameData.length).toBe(4);
  });

  it('close() marks the encoder closed and a later encode() is a no-op', async () => {
    (globalThis as { AudioEncoder?: unknown }).AudioEncoder = makeFakeAudioEncoderClass({ supported: true });
    (globalThis as { AudioData?: unknown }).AudioData = FakeAudioData;

    const onEncodedChunk = vi.fn();
    const encoder = new WebCodecsAudioEncoder(8000, 1, { onEncodedChunk });
    await Promise.resolve();
    await Promise.resolve();

    encoder.close();
    encoder.encode({ pcm: new Float32Array([0.1]), timestampUs: 1 });

    expect(onEncodedChunk).not.toHaveBeenCalled();
  });
});
