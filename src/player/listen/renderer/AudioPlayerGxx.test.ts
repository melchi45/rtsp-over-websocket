import { describe, it, expect } from 'vitest';
import { loadLegacyModule, type LegacySandbox } from '../../test-support/loadLegacyModule';
import { createBaseLegacySandbox, createAudioDecoderLegacySandbox, inheritObject } from '../../test-support/legacyGlobals';
import { AudioPlayerGxx } from './AudioPlayerGxx';

interface LegacyAudioPlayerGxx {
  channelId: number;
  audioInit(codecType: string, codecMime: string | undefined, bitrate: number | undefined, volume: number): boolean;
  isInit(): boolean;
  Stop(): void;
  ControlVolume(vol: number): void;
  GetVolume(): number;
  setBufferingFlag(videoTime: number | string, videoStatus: string): void;
  getBufferingFlag(): boolean;
  setInitVideoTimeStamp(time: number | string): void;
  getInitVideoTimeStamp(): number | string;
}

class FakeGainNode {
  gain = { value: 0 };
  connect(): void {}
}
class FakeBiquadFilterNode {
  type = '';
  frequency = { value: 0 };
  gain = { value: 0 };
  connect(): void {}
}
class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: 'running' | 'closed' | 'suspended' = 'running';
  currentTime = 0;
  destination = {};
  onstatechange: (() => void) | null = null;
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  createGain(): FakeGainNode {
    return new FakeGainNode();
  }
  createBiquadFilter(): FakeBiquadFilterNode {
    return new FakeBiquadFilterNode();
  }
  createBuffer(_ch: number, length: number, _rate: number): { getChannelData: () => Float32Array; duration: number } {
    return { getChannelData: () => new Float32Array(length), duration: length / 8000 };
  }
  createBufferSource(): { buffer: unknown; connect(): void; start(): void; stop(): void } {
    return { buffer: null, connect: () => {}, start: () => {}, stop: () => {} };
  }
  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }
}

const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, trace: () => {}, isDebugEnabled: () => false, isInfoEnabled: () => false };

function buildSandbox(): LegacySandbox {
  const base = createBaseLegacySandbox();
  const sandboxBase: LegacySandbox = {
    ...base,
    log: { getLogger: () => noopLogger, ...noopLogger },
    inheritObject,
    rtspOverWebSocketError: loadLegacyModule('Exception/RTSPOverWebSocketError.js', 'RTSPOverWebSocketError'),
    fromHex: (hex: string) => parseInt(hex, 16),
    navigator: { vendor: 'Google Inc.', userAgent: 'Chrome' }
  };
  const decoderSandbox: LegacySandbox = { ...createAudioDecoderLegacySandbox(), ...sandboxBase };
  return {
    ...sandboxBase,
    AudioPlayer: loadLegacyModule('Listen/Renderer/audioPlayer.js', 'AudioPlayer', sandboxBase),
    AudioContext: FakeAudioContext,
    G711AudioDecoder: loadLegacyModule('Listen/Decoder/audioDecoderG711.js', 'G711AudioDecoder', decoderSandbox),
    G726xAudioDecoder: loadLegacyModule('Listen/Decoder/audioDecoderG726x.js', 'G726xAudioDecoder', decoderSandbox),
    AACAudioDecoder: class {
      channelId = 0;
      decode(): Float32Array {
        return new Float32Array();
      }
      close(): void {}
    }
  };
}

function newLegacy(): LegacyAudioPlayerGxx {
  const Ctor = loadLegacyModule<new () => LegacyAudioPlayerGxx>('Listen/Renderer/audioPlayerGxx.js', 'AudioPlayerGxx', buildSandbox());
  return new Ctor();
}

function newPorted(): AudioPlayerGxx {
  return new AudioPlayerGxx(() => new FakeAudioContext() as unknown as AudioContext, () => ({
    channelId: 0,
    decode: () => new Float32Array(),
    close: () => {}
  }));
}

describe('AudioPlayerGxx parity with the legacy player’s Listen/Renderer/audioPlayerGxx.js', () => {
  it('isInit()/GetVolume() start out false/0 identically', () => {
    const legacy = newLegacy();
    const ported = newPorted();
    expect(ported.isInit()).toBe(legacy.isInit());
    expect(ported.isInit()).toBe(false);
    expect(ported.GetVolume()).toBe(legacy.GetVolume());
    expect(ported.GetVolume()).toBe(0);
  });

  it('audioInit succeeds for G711 and reports isInit()=true identically', () => {
    FakeAudioContext.instances = [];
    const legacy = newLegacy();
    const legacyResult = legacy.audioInit('G711', 'PCMU', 64, 10);

    FakeAudioContext.instances = [];
    const ported = newPorted();
    const portedResult = ported.audioInit('G711', 'PCMU', 64, 10);

    expect(portedResult).toBe(legacyResult);
    expect(portedResult).toBe(true);
    expect(ported.isInit()).toBe(legacy.isInit());
    expect(ported.isInit()).toBe(true);
  });

  it('audioInit returns false identically when an AudioContext already exists', () => {
    const legacy = newLegacy();
    legacy.audioInit('G711', 'PCMU', 64, 10);
    const legacySecond = legacy.audioInit('G711', 'PCMU', 64, 10);

    const ported = newPorted();
    ported.audioInit('G711', 'PCMU', 64, 10);
    const portedSecond = ported.audioInit('G711', 'PCMU', 64, 10);

    expect(portedSecond).toBe(legacySecond);
    expect(portedSecond).toBe(false);
  });

  it('ControlVolume clamps gain to [0,1] identically once initialized', () => {
    const legacy = newLegacy();
    legacy.audioInit('G711', 'PCMU', 64, 0);
    const ported = newPorted();
    ported.audioInit('G711', 'PCMU', 64, 0);

    for (const vol of [-10, 0, 2.5, 5, 20]) {
      legacy.ControlVolume(vol);
      ported.ControlVolume(vol);
      expect(ported.GetVolume()).toBe(legacy.GetVolume());
    }
  });

  it('Stop() resets volume to 0 identically', () => {
    const legacy = newLegacy();
    legacy.audioInit('G711', 'PCMU', 64, 10);
    legacy.Stop();
    const ported = newPorted();
    ported.audioInit('G711', 'PCMU', 64, 10);
    ported.Stop();
    expect(ported.GetVolume()).toBe(legacy.GetVolume());
    expect(ported.GetVolume()).toBe(0);
  });

  describe('buffering-flag / video-timestamp bookkeeping', () => {
    it('round-trips setBufferingFlag/getBufferingFlag/setInitVideoTimeStamp/getInitVideoTimeStamp identically', () => {
      const legacy = newLegacy();
      const ported = newPorted();

      legacy.setInitVideoTimeStamp(5);
      ported.setInitVideoTimeStamp(5);
      expect(ported.getInitVideoTimeStamp()).toBe(legacy.getInitVideoTimeStamp());

      legacy.setBufferingFlag(5, 'init');
      ported.setBufferingFlag(5, 'init');
      expect(ported.getBufferingFlag()).toBe(legacy.getBufferingFlag());
    });
  });

  it('audioInit throws the same RTSPOverWebSocketError-shaped error identically when the AudioContext factory throws', () => {
    const legacy = new (loadLegacyModule<new () => LegacyAudioPlayerGxx>('Listen/Renderer/audioPlayerGxx.js', 'AudioPlayerGxx', {
      ...buildSandbox(),
      AudioContext: class {
        constructor() {
          throw new Error('no device');
        }
      }
    }))();
    const ported = new AudioPlayerGxx(() => {
      throw new Error('no device');
    });

    let legacyError: { errorCode?: number; place?: string } = {};
    let portedError: { errorCode?: number; place?: string } = {};
    try {
      legacy.audioInit('G711', 'PCMU', 64, 0);
    } catch (e) {
      legacyError = e as typeof legacyError;
    }
    try {
      ported.audioInit('G711', 'PCMU', 64, 0);
    } catch (e) {
      portedError = e as typeof portedError;
    }
    expect(portedError.errorCode).toBe(legacyError.errorCode);
    expect(portedError.place).toBe(legacyError.place);
  });
});
