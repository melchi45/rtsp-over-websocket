import { describe, it, expect } from 'vitest';
import { loadLegacyModule } from '../../test-support/loadLegacyModule';
import { AudioDecoder } from './AudioDecoder';

interface LegacyAudioDecoder {
  channelId: number;
  decode(buffer: unknown): unknown;
  close(): void;
}

const LegacyAudioDecoderCtor = loadLegacyModule<new () => LegacyAudioDecoder>('Listen/Decoder/audioDecoder.js', 'AudioDecoder');

describe('AudioDecoder parity with the legacy player’s Listen/Decoder/audioDecoder.js', () => {
  it('channelId getter/setter and no-op decode()/close() match', () => {
    const legacy = new LegacyAudioDecoderCtor();
    const ported = new AudioDecoder();

    expect(ported.channelId).toBe(legacy.channelId);
    legacy.channelId = 7;
    ported.channelId = 7;
    expect(ported.channelId).toBe(legacy.channelId);
    expect(ported.decode('anything')).toBe(legacy.decode('anything'));
    expect(ported.close()).toBe(legacy.close());
  });
});
