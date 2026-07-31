import { describe, it, expect, vi } from 'vitest';
import { StreamManager } from './StreamManager';
import type { StreamPlayerInfo } from './StreamPlayer';
import type { MediaRouterFactories, VideoPlayerLike, AudioPlayerLike } from '../mediaSession/MediaRouter';

class FakeVideoPlayer implements VideoPlayerLike {
  type = 'canvas';
  playmode: string | undefined = undefined;
  channelId = 0;
  deviceType?: string;
  boxsize = 4;
  framedrop = false;
  speed = 1;
  rfps?: number;
  audioshift?: number;
  ControlVolume = vi.fn();
  init(): void {}
  close(): void {}
  pause(): void {}
  resume(): void {}
  forward(): boolean {
    return true;
  }
  backward(): boolean {
    return true;
  }
  clearBuffer(): void {}
  capture = vi.fn();
  digitalZoom = vi.fn();
  instantplaybackCmd = vi.fn();
  toggleControls = vi.fn();
  onWaitingPackets(): void {}
  bufferingVideoData(): boolean {
    return true;
  }
  controlStepPlay(): void {}
  sendToBufferManager(): void {}
  addEventListener(): void {}
  updateMiniMapInfo(): void {}
  setTimeStampCallback(): void {}
  setErrorCallback(): void {}
  setResizeCallback(): void {}
  setFrameRate(): void {}
  setDefaultDelay(): void {}
  setMaxInstantPlayback(): void {}
  setBufferClearInterval(): void {}
}

class FakeAudioPlayer implements AudioPlayerLike {
  channelId = 0;
  isInit(): boolean {
    return false;
  }
  setInitVideoTimeStamp(): void {}
  audioInit(): void {}
  Play(): void {}
  Stop(): void {}
  terminate(): void {}
  BufferAudio(): void {}
  setBufferingFlag(): void {}
  ControlVolume(): void {}
}

function fakeMediaRouterFactories(): MediaRouterFactories {
  return {
    createCanvasPlayer: () => new FakeVideoPlayer(),
    createVideoPlayer: () => new FakeVideoPlayer(),
    createAudioPlayer: () => new FakeAudioPlayer(),
    createTalk: () => ({ channelId: 0, init: () => true, setSendAudioTalkBufferCallback: () => {}, initAudioOut: () => Promise.resolve(8000), terminate: () => {} }),
    createMetaDataParser: () => ({ channelId: 0, parse: () => {} }),
    createBackupProvider: () => ({ channelId: 0, init: () => {}, closeStream: () => {}, onVideoData: () => {}, receiveAudioData: () => {} }),
    cloneArray: (arr: Uint8Array) => arr.slice()
  };
}

let nextChannelId = 1000;
/** Fresh channelId per test — playerContainer/currentPlayer are legacy-faithful module-level state shared across every StreamManager instance in this file, so tests must not collide on id. */
function uniqueChannelId(): number {
  nextChannelId += 1;
  return nextChannelId;
}

function infoFor(channelId: number, overrides: Partial<StreamPlayerInfo> = {}): StreamPlayerInfo {
  return {
    device: { channelId, cameraIp: '192.168.0.10', username: 'admin', ...overrides.device },
    media: { type: 'live', requestInfo: { cmd: 'open', url: 'profile2' }, ...overrides.media },
    callback: { ...overrides.callback }
  };
}

describe('StreamManager contract tests (the legacy player’s Interface/streamManager.js)', () => {
  it('getVideoPlayer() throws when no player has ever been looked up (legacy: currentPlayer.getVideoPlayer() has no null guard)', async () => {
    // Isolated module instance so this doesn't depend on test-execution order
    // relative to the other tests below, which do set currentPlayer.
    vi.resetModules();
    const { StreamManager: FreshStreamManager } = await import('./StreamManager');
    const manager = new FreshStreamManager();
    expect(() => manager.getVideoPlayer()).toThrow();
  });

  it('initStreamPlayer creates a player keyed by channelId and increases getPlayerLength by 1', () => {
    const manager = new StreamManager();
    const channelId = uniqueChannelId();
    const before = manager.getPlayerLength();

    manager.initStreamPlayer(infoFor(channelId), null, fakeMediaRouterFactories());

    expect(manager.getPlayerLength()).toBe(before + 1);
    manager.destroyPlayer(channelId, undefined);
  });

  it('initStreamPlayer keys by media.element in preference to device.channelId when both are given', () => {
    const manager = new StreamManager();
    const channelId = uniqueChannelId();
    const elementId = `elem-${channelId}`;
    manager.initStreamPlayer(infoFor(channelId, { media: { type: 'live', requestInfo: { cmd: 'open' }, element: elementId } }), null, fakeMediaRouterFactories());

    // Lookup must succeed by elementId, not by channelId, since element takes priority.
    expect(manager.getCurrentState(channelId, elementId)).toBe('Options');
    expect(manager.getCurrentState(channelId, undefined)).toBeUndefined();

    manager.destroyPlayer(channelId, elementId);
  });

  it('initStreamPlayer called again for an existing id does not create a second player (dispatches reassignCanvas instead)', () => {
    const manager = new StreamManager();
    const channelId = uniqueChannelId();
    const before = manager.getPlayerLength();

    manager.initStreamPlayer(infoFor(channelId), null, fakeMediaRouterFactories());
    manager.initStreamPlayer(infoFor(channelId), null, fakeMediaRouterFactories());

    expect(manager.getPlayerLength()).toBe(before + 1);
    manager.destroyPlayer(channelId, undefined);
  });

  it('initStreamPlayer with cmd "close" and no existing player is a no-op', () => {
    const manager = new StreamManager();
    const channelId = uniqueChannelId();
    const before = manager.getPlayerLength();

    manager.initStreamPlayer(infoFor(channelId, { media: { type: 'live', requestInfo: { cmd: 'close' } } }), null, fakeMediaRouterFactories());

    expect(manager.getPlayerLength()).toBe(before);
  });

  it('controlPlayer routes to the matching player by channelId', () => {
    const manager = new StreamManager();
    const channelId = uniqueChannelId();
    manager.initStreamPlayer(infoFor(channelId), null, fakeMediaRouterFactories());

    // StreamPlayer.control('terminate') always throws (legacy: deprecated method) —
    // observing the throw proves controlPlayer routed to the right instance.
    expect(() => manager.controlPlayer(infoFor(channelId, { media: { type: 'live', requestInfo: { cmd: 'terminate' } } }))).toThrow('this method was deplicated.');

    manager.destroyPlayer(channelId, undefined);
  });

  it('controlPlayer is a no-op when no player matches', () => {
    const manager = new StreamManager();
    expect(() => manager.controlPlayer(infoFor(uniqueChannelId()))).not.toThrow();
  });

  it('controlWorker routes to the matching player by channelId/elementId and is a no-op otherwise', () => {
    const manager = new StreamManager();
    const channelId = uniqueChannelId();
    manager.initStreamPlayer(infoFor(channelId), null, fakeMediaRouterFactories());

    expect(() => manager.controlWorker({ channelId, elementId: undefined, cmd: 'clearBuffer', data: undefined })).not.toThrow();
    expect(() => manager.controlWorker({ channelId: uniqueChannelId(), elementId: undefined, cmd: 'clearBuffer', data: undefined })).not.toThrow();

    manager.destroyPlayer(channelId, undefined);
  });

  it('destroyPlayer removes the player so subsequent lookups find nothing', () => {
    const manager = new StreamManager();
    const channelId = uniqueChannelId();
    manager.initStreamPlayer(infoFor(channelId), null, fakeMediaRouterFactories());
    const withPlayer = manager.getPlayerLength();

    manager.destroyPlayer(channelId, undefined);

    expect(manager.getPlayerLength()).toBe(withPlayer - 1);
    expect(manager.getCurrentState(channelId, undefined)).toBeUndefined();
  });

  it('destroyPlayer on an unknown id is a safe no-op', () => {
    const manager = new StreamManager();
    expect(() => manager.destroyPlayer(uniqueChannelId(), undefined)).not.toThrow();
  });

  it('getVideoWidth/getVideoHeight/getVideoCodecType/getAudioVolume return undefined for an unknown channel', () => {
    const manager = new StreamManager();
    const channelId = uniqueChannelId();
    expect(manager.getVideoWidth(channelId, undefined)).toBeUndefined();
    expect(manager.getVideoHeight(channelId, undefined)).toBeUndefined();
    expect(manager.getVideoCodecType(channelId, undefined)).toBeUndefined();
    expect(manager.getAudioVolume(channelId, undefined)).toBeUndefined();
  });

  it('setAudioVolume/getAudioVolume round-trip through the matching player', () => {
    const manager = new StreamManager();
    const channelId = uniqueChannelId();
    manager.initStreamPlayer(infoFor(channelId, { media: { type: 'live', requestInfo: { cmd: 'open' }, audioInVolume: 10 } }), null, fakeMediaRouterFactories());

    manager.setAudioVolume(channelId, undefined, 88);

    expect(manager.getAudioVolume(channelId, undefined)).toBe(88);
    manager.destroyPlayer(channelId, undefined);
  });

  it('getVideoWidth/getVideoHeight/getVideoCodecType return null for an initialized-but-not-yet-streaming player', () => {
    const manager = new StreamManager();
    const channelId = uniqueChannelId();
    manager.initStreamPlayer(infoFor(channelId), null, fakeMediaRouterFactories());

    expect(manager.getVideoWidth(channelId, undefined)).toBeNull();
    expect(manager.getVideoHeight(channelId, undefined)).toBeNull();
    expect(manager.getVideoCodecType(channelId, undefined)).toBeNull();

    manager.destroyPlayer(channelId, undefined);
  });
});
