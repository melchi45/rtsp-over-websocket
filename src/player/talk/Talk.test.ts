import { describe, it, expect, vi } from 'vitest';
import { loadLegacyModule, type LegacySandbox } from '../test-support/loadLegacyModule';
import { Talk } from './Talk';

interface LegacyTalk {
  channelId: number;
  init(): boolean;
  initAudioOut(): Promise<number>;
  controlVolumeOut(volume: number): void;
  stopAudioOut(): void;
  terminate(): void;
  setSendAudioTalkBufferCallback(cb: (data: Float32Array) => void): void;
}

class FakeGainNode {
  gain = { value: 0 };
  connect(): void {}
}

class FakeScriptProcessorNode {
  onaudioprocess: ((e: { inputBuffer: { getChannelData(i: number): Float32Array } }) => void) | null = null;
  connect(): void {}
}

class FakeMediaStreamAudioSourceNode {
  connect(): void {}
}

class FakeAudioTrack {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

class FakeMediaStream {
  tracks = [new FakeAudioTrack()];
  getAudioTracks(): FakeAudioTrack[] {
    return this.tracks;
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  sampleRate = 16000;
  destination = {};
  closed = false;
  onstatechange: (() => void) | null = null;
  lastScriptNode: FakeScriptProcessorNode | null = null;

  constructor() {
    FakeAudioContext.instances.push(this);
  }
  lastGainNode: FakeGainNode | null = null;
  createGain(): FakeGainNode {
    this.lastGainNode = new FakeGainNode();
    return this.lastGainNode;
  }
  createScriptProcessor(): FakeScriptProcessorNode {
    this.lastScriptNode = new FakeScriptProcessorNode();
    return this.lastScriptNode;
  }
  createMediaStreamSource(): FakeMediaStreamAudioSourceNode {
    return new FakeMediaStreamAudioSourceNode();
  }
  close(): void {
    this.closed = true;
  }
}

function buildSandbox(getUserMedia: ((constraints: unknown) => Promise<FakeMediaStream>) | undefined): LegacySandbox {
  return {
    rtspOverWebSocketError: loadLegacyModule('Exception/RTSPOverWebSocketError.js', 'RTSPOverWebSocketError'),
    fromHex: (hex: string) => parseInt(hex, 16),
    AudioContext: FakeAudioContext,
    navigator: getUserMedia ? { mediaDevices: { getUserMedia } } : { mediaDevices: {} }
  };
}

function newLegacy(getUserMedia?: (constraints: unknown) => Promise<FakeMediaStream>): LegacyTalk {
  const Ctor = loadLegacyModule<new () => LegacyTalk>('Talk/Talk.js', 'Talk', buildSandbox(getUserMedia));
  return new Ctor();
}

function newPorted(): Talk {
  return new Talk(() => new FakeAudioContext() as unknown as AudioContext);
}

describe('Talk parity with the legacy player’s Talk/Talk.js', () => {
  it('init() creates the AudioContext once and is idempotent, identically', () => {
    FakeAudioContext.instances = [];
    const legacy = newLegacy();
    expect(legacy.init()).toBe(true);
    expect(legacy.init()).toBe(true);
    expect(FakeAudioContext.instances.length).toBe(1);

    FakeAudioContext.instances = [];
    const ported = newPorted();
    expect(ported.init()).toBe(true);
    expect(ported.init()).toBe(true);
    expect(FakeAudioContext.instances.length).toBe(1);
  });

  it('init() returns false identically when constructing the AudioContext throws', () => {
    const legacy = new (loadLegacyModule<new () => LegacyTalk>(
      'Talk/Talk.js',
      'Talk',
      {
        rtspOverWebSocketError: loadLegacyModule('Exception/RTSPOverWebSocketError.js', 'RTSPOverWebSocketError'),
        fromHex: (hex: string) => parseInt(hex, 16),
        AudioContext: class {
          constructor() {
            throw new Error('no audio device');
          }
        },
        navigator: { mediaDevices: {} }
      }
    ))();
    const ported = new Talk(() => {
      throw new Error('no audio device');
    });

    expect(ported.init()).toBe(legacy.init());
    expect(ported.init()).toBe(false);
  });

  it('initAudioOut() resolves with the sample rate and starts streaming identically', async () => {
    const stream = new FakeMediaStream();
    const legacy = newLegacy(() => Promise.resolve(stream));
    legacy.init();
    const legacyRate = await legacy.initAudioOut();

    const ported = newPorted();
    ported.init();
    // The port always uses the real global `navigator` (not injected) —
    // stub it for this test only.
    const originalGetUserMedia = navigator.mediaDevices?.getUserMedia;
    (navigator as unknown as { mediaDevices: { getUserMedia: unknown } }).mediaDevices = { getUserMedia: () => Promise.resolve(stream as unknown as MediaStream) };
    try {
      const portedRate = await ported.initAudioOut();
      expect(portedRate).toBe(legacyRate);
      expect(portedRate).toBe(16000);
    } finally {
      if (navigator.mediaDevices) {
        (navigator.mediaDevices as unknown as { getUserMedia: unknown }).getUserMedia = originalGetUserMedia;
      }
    }
  });

  it('initAudioOut() rejects with an RTSPOverWebSocketError-shaped error identically when getUserMedia rejects', async () => {
    const legacy = newLegacy(() => Promise.reject(new Error('denied')));
    legacy.init();
    let legacyError: { errorCode?: number; place?: string; message?: string } = {};
    try {
      await legacy.initAudioOut();
    } catch (e) {
      legacyError = e as typeof legacyError;
    }

    const ported = newPorted();
    ported.init();
    const originalGetUserMedia = navigator.mediaDevices?.getUserMedia;
    (navigator as unknown as { mediaDevices: { getUserMedia: unknown } }).mediaDevices = { getUserMedia: () => Promise.reject(new Error('denied')) };
    let portedError: { errorCode?: number; place?: string; message?: string } = {};
    try {
      await ported.initAudioOut();
    } catch (e) {
      portedError = e as typeof portedError;
    } finally {
      if (navigator.mediaDevices) {
        (navigator.mediaDevices as unknown as { getUserMedia: unknown }).getUserMedia = originalGetUserMedia;
      }
    }

    expect(portedError.errorCode).toBe(legacyError.errorCode);
    expect(portedError.place).toBe(legacyError.place);
    expect(portedError.message).toBe(legacyError.message);
  });

  // NOTE: legacy's "getUserMedia is completely absent" scenario is not
  // tested here for true parity — legacy unconditionally installs a
  // vendor-prefix polyfill in that case (which itself always fails, since no
  // currently-supported browser exposes `navigator.webkitGetUserMedia`/
  // `mozGetUserMedia`/`msGetUserMedia`), converging on the same RTSPOverWebSocketError
  // `.catch()` path exercised by the "getUserMedia rejects" test above. This
  // port deliberately drops that dead polyfill (see Talk.ts's class-level
  // doc comment) and calls `navigator.mediaDevices.getUserMedia` directly,
  // per TypeScript's DOM types guaranteeing its presence — a scenario where
  // it's truly absent can't be reproduced without reintroducing the polyfill.

  it('controlVolumeOut clamps to [0, 10] identically across representative volumes', async () => {
    const legacyStream = new FakeMediaStream();
    const legacy = newLegacy(() => Promise.resolve(legacyStream));
    legacy.init();
    await legacy.initAudioOut();
    const legacyGain = FakeAudioContext.instances[FakeAudioContext.instances.length - 1].lastGainNode!;

    const portedStream = new FakeMediaStream();
    const ported = newPorted();
    ported.init();
    const originalGetUserMedia = navigator.mediaDevices?.getUserMedia;
    (navigator as unknown as { mediaDevices: { getUserMedia: unknown } }).mediaDevices = {
      getUserMedia: () => Promise.resolve(portedStream as unknown as MediaStream)
    };
    await ported.initAudioOut();
    if (navigator.mediaDevices) {
      (navigator.mediaDevices as unknown as { getUserMedia: unknown }).getUserMedia = originalGetUserMedia;
    }
    const portedGain = FakeAudioContext.instances[FakeAudioContext.instances.length - 1].lastGainNode!;

    for (const volume of [-5, 0, 20, 100, 200]) {
      legacy.controlVolumeOut(volume);
      ported.controlVolumeOut(volume);
      expect(portedGain.gain.value).toBe(legacyGain.gain.value);
    }
  });

  it('stopAudioOut stops all audio tracks and clears streaming state identically', async () => {
    const legacyStream = new FakeMediaStream();
    const legacy = newLegacy(() => Promise.resolve(legacyStream));
    legacy.init();
    await legacy.initAudioOut();
    legacy.stopAudioOut();
    expect(legacyStream.tracks[0].stopped).toBe(true);
    // calling again after tracks were already stopped/cleared is a safe no-op
    expect(() => legacy.stopAudioOut()).not.toThrow();

    const portedStream = new FakeMediaStream();
    const ported = newPorted();
    ported.init();
    const originalGetUserMedia = navigator.mediaDevices?.getUserMedia;
    (navigator as unknown as { mediaDevices: { getUserMedia: unknown } }).mediaDevices = {
      getUserMedia: () => Promise.resolve(portedStream as unknown as MediaStream)
    };
    await ported.initAudioOut();
    if (navigator.mediaDevices) {
      (navigator.mediaDevices as unknown as { getUserMedia: unknown }).getUserMedia = originalGetUserMedia;
    }
    ported.stopAudioOut();
    expect(portedStream.tracks[0].stopped).toBe(true);
    expect(() => ported.stopAudioOut()).not.toThrow();
  });

  it('setSendAudioTalkBufferCallback wires captured PCM chunks to the callback identically', async () => {
    const legacyStream = new FakeMediaStream();
    const legacy = newLegacy(() => Promise.resolve(legacyStream));
    legacy.init();
    const legacyChunks: Float32Array[] = [];
    legacy.setSendAudioTalkBufferCallback((data) => legacyChunks.push(data));
    await legacy.initAudioOut();
    const legacyNode = FakeAudioContext.instances[FakeAudioContext.instances.length - 1].lastScriptNode!;

    const portedStream = new FakeMediaStream();
    const ported = newPorted();
    ported.init();
    const portedChunks: Float32Array[] = [];
    ported.setSendAudioTalkBufferCallback((data) => portedChunks.push(data));
    const originalGetUserMedia = navigator.mediaDevices?.getUserMedia;
    (navigator as unknown as { mediaDevices: { getUserMedia: unknown } }).mediaDevices = {
      getUserMedia: () => Promise.resolve(portedStream as unknown as MediaStream)
    };
    await ported.initAudioOut();
    if (navigator.mediaDevices) {
      (navigator.mediaDevices as unknown as { getUserMedia: unknown }).getUserMedia = originalGetUserMedia;
    }
    const portedNode = FakeAudioContext.instances[FakeAudioContext.instances.length - 1].lastScriptNode!;

    const chunk = new Float32Array([0.1, 0.2, 0.3]);
    const fakeEvent = { inputBuffer: { getChannelData: () => chunk } };
    legacyNode.onaudioprocess!(fakeEvent);
    portedNode.onaudioprocess!(fakeEvent);

    expect(portedChunks.length).toBe(legacyChunks.length);
    expect(portedChunks.length).toBe(1);
    expect(Array.from(portedChunks[0])).toEqual(Array.from(legacyChunks[0]));
  });
});
