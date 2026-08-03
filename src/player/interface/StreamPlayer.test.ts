import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamPlayer, type StreamPlayerInfo } from './StreamPlayer';
import type { MediaRouterFactories, VideoPlayerLike, AudioPlayerLike } from '../mediaSession/MediaRouter';
import type { TransportLike, TransportFactory } from '../network/rtspOverWebsocket/RtspClient';

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

function fakeMediaRouterFactories(): { factories: MediaRouterFactories; backupInit: ReturnType<typeof vi.fn> } {
  const backupInit = vi.fn();
  const factories: MediaRouterFactories = {
    createCanvasPlayer: () => new FakeVideoPlayer(),
    createVideoPlayer: () => new FakeVideoPlayer(),
    createAudioPlayer: () => new FakeAudioPlayer(),
    createTalk: () => ({ channelId: 0, init: () => true, setSendAudioTalkBufferCallback: () => {}, initAudioOut: () => Promise.resolve(8000), terminate: () => {} }),
    createMetaDataParser: () => ({ channelId: 0, parse: () => {} }),
    createBackupProvider: () => ({ channelId: 0, init: backupInit, closeStream: () => {}, onVideoData: () => {}, receiveAudioData: () => {} }),
    cloneArray: (arr: Uint8Array) => arr.slice()
  };
  return { factories, backupInit };
}

class FakeTransport implements TransportLike {
  index?: number;
  channelId?: number;
  autoconnection?: boolean;
  readyState?: number;
  SetCallback = vi.fn();
  Connect = vi.fn();
  Disconnect = vi.fn();
  SendRtspCommand = vi.fn();
  SendRtpData = vi.fn();
  init = vi.fn();
}

function fakeTransportFactory(): { transportFactory: TransportFactory; calls: string[]; transport: FakeTransport } {
  const transport = new FakeTransport();
  const calls: string[] = [];
  const transportFactory: TransportFactory = (serverAddr: string) => {
    calls.push(serverAddr);
    return transport;
  };
  return { transportFactory, calls, transport };
}

function baseInfo(overrides: Partial<StreamPlayerInfo> = {}): StreamPlayerInfo {
  return {
    device: {
      channelId: 1,
      protocol: 'http',
      cameraIp: '192.168.0.10',
      port: 80,
      username: 'admin',
      password: 'pw',
      ClientIPAddress: '10.0.0.1',
      ...overrides.device
    },
    media: {
      type: 'live',
      requestInfo: { cmd: 'open', url: 'profile2', scale: 1 },
      ...overrides.media
    },
    callback: { ...overrides.callback }
  };
}

describe('StreamPlayer contract tests (the legacy player’s Interface/streamPlayer)', () => {
  let navigatorStub: { userAgent: string };
  let windowStub: { location: { pathname: string } };

  beforeEach(() => {
    navigatorStub = { userAgent: 'FakeAgent/1.0' };
    windowStub = { location: { pathname: '/' } };
    vi.stubGlobal('navigator', navigatorStub);
    vi.stubGlobal('window', windowStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('propagates media.audioInVolume from configInfo into the MediaRouter (round-trips through getAudioVolume)', () => {
    const { factories } = fakeMediaRouterFactories();
    const player = new StreamPlayer(baseInfo({ media: { type: 'live', requestInfo: { cmd: 'open' }, audioInVolume: 42 } }), null, factories);
    expect(player.getAudioVolume()).toBe(42);
  });

  it('has no video player, dimensions, or codec before any stream is opened', () => {
    const { factories } = fakeMediaRouterFactories();
    const player = new StreamPlayer(baseInfo(), null, factories);
    expect(player.getVideoPlayer()).toBeNull();
    expect(player.getVideoWidth()).toBeNull();
    expect(player.getVideoHeight()).toBeNull();
    expect(player.getVideoCodecType()).toBeNull();
  });

  it('starts in the RTSP "Options" state', () => {
    const { factories } = fakeMediaRouterFactories();
    const player = new StreamPlayer(baseInfo(), null, factories);
    expect(player.getCurrentState()).toBe('Options');
  });

  it('control(null) / control(undefined) is a no-op and does not throw', () => {
    const { factories } = fakeMediaRouterFactories();
    const player = new StreamPlayer(baseInfo(), null, factories);
    expect(() => player.control(null)).not.toThrow();
    expect(() => player.control(undefined)).not.toThrow();
  });

  it('control() with an unrecognized cmd is a no-op and does not throw', () => {
    const { factories } = fakeMediaRouterFactories();
    const player = new StreamPlayer(baseInfo(), null, factories);
    expect(() => player.control(baseInfo({ media: { type: 'live', requestInfo: { cmd: 'bogus' } } }))).not.toThrow();
  });

  it('control() "terminate" throws RTSPOverWebSocketError (legacy: "this method was deplicated")', () => {
    const { factories } = fakeMediaRouterFactories();
    const player = new StreamPlayer(baseInfo(), null, factories);
    expect(() => player.control(baseInfo({ media: { type: 'live', requestInfo: { cmd: 'terminate' } } }))).toThrow('this method was deplicated.');
  });

  it('control() "open" (camera, http) builds a ws:// StreamingServer URL and connects the injected transport', () => {
    const { factories } = fakeMediaRouterFactories();
    const { transportFactory, calls, transport } = fakeTransportFactory();
    const player = new StreamPlayer(baseInfo(), null, factories, transportFactory);

    player.control(baseInfo());

    expect(calls).toEqual(['ws://192.168.0.10:80/StreamingServer']);
    expect(transport.SetCallback).toHaveBeenCalledTimes(1);
    expect(transport.Connect).toHaveBeenCalledTimes(1);
  });

  it('control() "open" (https protocol) uses wss://', () => {
    const { factories } = fakeMediaRouterFactories();
    const { transportFactory, calls } = fakeTransportFactory();
    const player = new StreamPlayer(baseInfo({ device: { channelId: 1, protocol: 'https', cameraIp: '192.168.0.10', username: 'admin' } }), null, factories, transportFactory);

    player.control(baseInfo({ device: { channelId: 1, protocol: 'https', cameraIp: '192.168.0.10', username: 'admin' } }));

    expect(calls).toEqual(['wss://192.168.0.10:80/StreamingServer']);
  });

  it('control() "open" prefers serverAddress/proxy over the camera IP for the WebSocket host', () => {
    const { factories } = fakeMediaRouterFactories();
    const { transportFactory, calls } = fakeTransportFactory();
    const player = new StreamPlayer(baseInfo({ device: { channelId: 1, protocol: 'http', cameraIp: '192.168.0.10', username: 'admin', proxy: 'gateway.local', port: 8080 } }), null, factories, transportFactory);

    player.control(baseInfo({ device: { channelId: 1, protocol: 'http', cameraIp: '192.168.0.10', username: 'admin', proxy: 'gateway.local', port: 8080 } }));

    expect(calls).toEqual(['ws://gateway.local:8080/StreamingServer']);
  });

  it('control() "open" mangles an IPv6-literal proxy into a *.ipv6-literal.net host under IE/Edge user agents', () => {
    navigatorStub.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Trident/7.0; rv:11.0) like Gecko';
    const { factories } = fakeMediaRouterFactories();
    const { transportFactory, calls } = fakeTransportFactory();
    const info = baseInfo({ device: { channelId: 1, protocol: 'http', cameraIp: '192.168.0.10', username: 'admin', proxy: '::1', port: 8080 } });
    const player = new StreamPlayer(info, null, factories, transportFactory);

    player.control(info);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('.ipv6-literal.net/StreamingServer');
    expect(calls[0]).not.toContain('::');
  });

  it('control() "open" with media.type "backup" starts a backup via the injected BackupProvider factory', () => {
    const { factories, backupInit } = fakeMediaRouterFactories();
    const { transportFactory } = fakeTransportFactory();
    const player = new StreamPlayer(baseInfo(), null, factories, transportFactory);

    player.control(
      baseInfo({
        device: { channelId: 1, protocol: 'http', cameraIp: '192.168.0.10', username: 'admin', captureName: 'clip1' },
        media: { type: 'backup', requestInfo: { cmd: 'open' }, split: 100 }
      })
    );

    expect(backupInit).toHaveBeenCalledTimes(1);
    expect(backupInit.mock.calls[0][0]).toMatchObject({ command: 'start', fileName: 'clip1', split: 100 });
  });

  it('setAudioVolume/getAudioVolume round-trip after construction', () => {
    const { factories } = fakeMediaRouterFactories();
    const player = new StreamPlayer(baseInfo(), null, factories);
    player.setAudioVolume(77);
    expect(player.getAudioVolume()).toBe(77);
  });

  it('toogleControls (legacy typo preserved) does not throw when no player is attached', () => {
    const { factories } = fakeMediaRouterFactories();
    const player = new StreamPlayer(baseInfo(), null, factories);
    expect(() => player.toogleControls(true)).not.toThrow();
  });

  it('isMute() returns the MediaRouter default (muted) before any audio session exists', () => {
    const { factories } = fakeMediaRouterFactories();
    const player = new StreamPlayer(baseInfo(), null, factories);
    expect(player.isMute()).toBe(true);
  });

  it('controlWorker() no-op cmds (timeStamp/initVideo/setLiveMode/...) do not throw', () => {
    const { factories } = fakeMediaRouterFactories();
    const player = new StreamPlayer(baseInfo(), null, factories);
    for (const cmd of ['timeStamp', 'initVideo', 'setLiveMode', 'openFPSmeter', 'closeFPSmeter', 'setFpsFrame', 'playToggle', 'setPlaybackservice', 'reassignCanvas']) {
      expect(() => player.controlWorker({ cmd, data: undefined })).not.toThrow();
    }
  });

  it('controlWorker() playbackSpeed/playbackSeek/clearBuffer/changeVideoMode/audioShift do not throw', () => {
    const { factories } = fakeMediaRouterFactories();
    const player = new StreamPlayer(baseInfo(), null, factories);
    expect(() => player.controlWorker({ cmd: 'playbackSpeed', data: 2 })).not.toThrow();
    expect(() => player.controlWorker({ cmd: 'playbackSeek', data: 5 })).not.toThrow();
    expect(() => player.controlWorker({ cmd: 'clearBuffer', data: undefined })).not.toThrow();
    expect(() => player.controlWorker({ cmd: 'changeVideoMode', data: 'video' })).not.toThrow();
    expect(() => player.controlWorker({ cmd: 'audioShift', data: 10 })).not.toThrow();
  });
});
