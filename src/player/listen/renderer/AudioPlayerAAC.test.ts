import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadLegacyModule, type LegacySandbox } from '../../test-support/loadLegacyModule';
import { createBaseLegacySandbox, inheritObject } from '../../test-support/legacyGlobals';
import { AudioPlayerAAC } from './AudioPlayerAAC';

interface LegacyAudioPlayerAAC {
  channelId: number;
  audioInit(codecType: string, codecMime: string | undefined, bitrate: number | undefined, volume: number): boolean;
  isInit(): boolean;
  ControlVolume(vol: number): void;
  GetVolume(): number;
  setBufferingFlag(videoTime: number | string, videoStatus: string): void;
  getBufferingFlag(): boolean;
  setInitVideoTimeStamp(time: number | string): void;
  getInitVideoTimeStamp(): number | string;
}

class FakeAudioElement {
  volume = 1;
  paused = true;
  src = '';
  listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  addEventListener(type: string, cb: (...args: unknown[]) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }
  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
}

const fakeDocument = {
  createElement: () => new FakeAudioElement(),
  body: { appendChild: () => {} }
};

const fakeWindowUrl = { createObjectURL: () => 'blob:fake' };

function buildSandbox(mediaSourceSupported: boolean): LegacySandbox {
  const base = createBaseLegacySandbox();
  const sandboxBase: LegacySandbox = {
    ...base,
    log: { getLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) },
    inheritObject,
    rtspOverWebSocketError: loadLegacyModule('Exception/RTSPOverWebSocketError.js', 'RTSPOverWebSocketError'),
    fromHex: (hex: string) => parseInt(hex, 16),
    navigator: { vendor: 'Google Inc.', userAgent: 'Chrome' },
    document: fakeDocument,
    window: { URL: fakeWindowUrl, MediaSource: mediaSourceSupported ? class {} : undefined },
    URL: fakeWindowUrl,
    MediaSource: mediaSourceSupported
      ? Object.assign(
          class {
            addEventListener(): void {}
          },
          { isTypeSupported: () => true }
        )
      : undefined
  };
  return { ...sandboxBase, AudioPlayer: loadLegacyModule('Listen/Renderer/audioPlayer.js', 'AudioPlayer', sandboxBase) };
}

function newLegacy(mediaSourceSupported = false): LegacyAudioPlayerAAC {
  const Ctor = loadLegacyModule<new () => LegacyAudioPlayerAAC>('Listen/Renderer/audioPlayerAAC.js', 'AudioPlayerAAC', buildSandbox(mediaSourceSupported));
  return new Ctor();
}

function newPorted(): AudioPlayerAAC {
  return new AudioPlayerAAC();
}

describe('AudioPlayerAAC parity with the legacy player’s Listen/Renderer/audioPlayerAAC.js', () => {
  beforeAll(() => {
    (globalThis as unknown as { document: unknown }).document = fakeDocument;
    (globalThis as unknown as { window: unknown }).window = { URL: fakeWindowUrl, MediaSource: undefined };
  });

  afterAll(() => {
    delete (globalThis as unknown as { document?: unknown }).document;
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it('isInit()/GetVolume() start out false/0 identically', () => {
    const legacy = newLegacy();
    const ported = newPorted();
    expect(ported.isInit()).toBe(legacy.isInit());
    expect(ported.isInit()).toBe(false);
    expect(ported.GetVolume()).toBe(legacy.GetVolume());
    expect(ported.GetVolume()).toBe(0);
  });

  it('audioInit throws the same RTSPOverWebSocketError-shaped error identically when MediaSource is unsupported', () => {
    const legacy = newLegacy(false);
    let legacyError: { errorCode?: number; place?: string; message?: string } = {};
    try {
      legacy.audioInit('AAC', 'audio/aac', undefined, 5);
    } catch (e) {
      legacyError = e as typeof legacyError;
    }

    (globalThis as unknown as { window: unknown }).window = { URL: fakeWindowUrl, MediaSource: undefined };
    const ported = newPorted();
    let portedError: { errorCode?: number; place?: string; message?: string } = {};
    try {
      ported.audioInit('AAC', 'audio/aac', undefined, 5);
    } catch (e) {
      portedError = e as typeof portedError;
    }

    expect(portedError.errorCode).toBe(legacyError.errorCode);
    expect(portedError.place).toBe(legacyError.place);
    expect(portedError.message).toBe(legacyError.message);
  });

  describe('buffering-flag / video-timestamp bookkeeping', () => {
    it('round-trips setBufferingFlag/getBufferingFlag/setInitVideoTimeStamp/getInitVideoTimeStamp identically', () => {
      const legacy = newLegacy();
      const ported = newPorted();

      legacy.setInitVideoTimeStamp(3);
      ported.setInitVideoTimeStamp(3);
      expect(ported.getInitVideoTimeStamp()).toBe(legacy.getInitVideoTimeStamp());

      legacy.setBufferingFlag(3, 'init');
      ported.setBufferingFlag(3, 'init');
      expect(ported.getBufferingFlag()).toBe(legacy.getBufferingFlag());
    });
  });
});
