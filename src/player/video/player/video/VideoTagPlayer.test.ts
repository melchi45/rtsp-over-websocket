import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VideoTagPlayer, type BrowserInfo } from './VideoTagPlayer';
import type { VideoStreamData, VideoInfo, AudioStreamData, AudioInfo } from '../../../mediaSession';

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
}

class FakeTextTrack {
  mode = 'disabled';
  name?: string;
  cues: { length: number; [index: number]: unknown } & unknown[] = Object.assign([], { length: 0 });
  oncuechange: (() => void) | null = null;
  addCue = vi.fn((cue: unknown) => {
    (this.cues as unknown[]).push(cue);
    this.cues.length = (this.cues as unknown[]).length;
  });
  removeCue = vi.fn((cue: unknown) => {
    const idx = (this.cues as unknown[]).indexOf(cue);
    if (idx >= 0) (this.cues as unknown[]).splice(idx, 1);
    this.cues.length = (this.cues as unknown[]).length;
  });
}

class FakeTextTrackList {
  tracks: FakeTextTrack[] = [];
  onaddtrack: ((event: unknown) => void) | null = null;
  onremovetrack: ((event: unknown) => void) | null = null;
  get length(): number {
    return this.tracks.length;
  }
  [index: number]: FakeTextTrack;
}

function withIndexAccess(list: FakeTextTrackList): FakeTextTrackList {
  return new Proxy(list, {
    get(target, prop) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) {
        return target.tracks[Number(prop)];
      }
      return (target as unknown as Record<string, unknown>)[prop as string];
    }
  });
}

class FakeSourceBuffer {
  updating = false;
  buffered = { length: 0, start: (_i: number) => 0, end: (_i: number) => 0 };
  listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  appendBuffer = vi.fn();
  remove = vi.fn();
  addEventListener(type: string, cb: (...args: unknown[]) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }
  removeEventListener(type: string, cb: (...args: unknown[]) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((fn) => fn !== cb);
  }
}

class FakeMediaSource {
  static isTypeSupported = vi.fn(() => true);
  sourceBuffers: FakeSourceBuffer[] = [];
  duration = 0;
  readyState: 'open' | 'closed' | 'ended' = 'open';
  listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  addSourceBuffer = vi.fn(() => {
    const sb = new FakeSourceBuffer();
    this.sourceBuffers.push(sb);
    return sb;
  });
  removeSourceBuffer = vi.fn((sb: FakeSourceBuffer) => {
    this.sourceBuffers = this.sourceBuffers.filter((s) => s !== sb);
  });
  endOfStream = vi.fn(() => {
    this.readyState = 'ended';
  });
  addEventListener(type: string, cb: (...args: unknown[]) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }
  removeEventListener(type: string, cb: (...args: unknown[]) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((fn) => fn !== cb);
  }
}

class FakeVideoElement {
  videoWidth = 640;
  videoHeight = 480;
  currentTime = 0;
  duration = 100;
  paused = true;
  ended = false;
  muted = false;
  volume = 1;
  readyState = 4;
  src = '';
  style: { background: string; backgroundSize: string } = { background: '', backgroundSize: '' };
  textTracks = withIndexAccess(new FakeTextTrackList());
  listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  onplaying: (() => void) | null = null;
  onpause: (() => void) | null = null;
  onclose: (() => void) | null = null;
  oncanplay: ((evt: unknown) => void) | null = null;
  onwaiting: (() => void) | null = null;
  ondurationchange: (() => void) | null = null;
  onloadeddata: (() => void) | null = null;
  onprogress: ((evt: unknown) => void) | null = null;
  onseeking: ((evt: unknown) => void) | null = null;
  onseeked: ((evt: unknown) => void) | null = null;
  ontimeupdate: ((evt: unknown) => void) | null = null;
  onstalled: (() => void) | null = null;
  oncanplaythrough: ((evt: unknown) => void) | null = null;
  onemptied: (() => void) | null = null;
  attributes: Record<string, string> = {};

  addTextTrack(_type: string, _label: string, _lang: string): FakeTextTrack {
    const track = new FakeTextTrack();
    this.textTracks.tracks.push(track);
    return track;
  }
  addEventListener(type: string, cb: (...args: unknown[]) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }
  removeEventListener(type: string, cb: (...args: unknown[]) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((fn) => fn !== cb);
  }
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
  removeAttribute(name: string): void {
    delete this.attributes[name];
  }
  hasAttribute(name: string): boolean {
    return name in this.attributes;
  }
  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
  load(): void {}
}

class FakeVTTCue {
  id = '';
  onenter: (() => void) | null = null;
  onexit: (() => void) | null = null;
  constructor(
    public startTime: number,
    public endTime: number,
    public text: string
  ) {}
}

const fakeBrowserInfo: BrowserInfo = { os: 'Linux', browser: 'Chrome', osVersion: '', browserVersion: '' };

function newPlayer(overrides: Partial<BrowserInfo> = {}): { player: VideoTagPlayer; getWorker: () => FakeWorker } {
  let worker: FakeWorker | undefined;
  const player = new VideoTagPlayer(
    () => {
      worker = new FakeWorker();
      return worker as unknown as Worker;
    },
    () => ({ ...fakeBrowserInfo, ...overrides })
  );
  return { player, getWorker: () => worker as FakeWorker };
}

function videoFrame(overrides: Partial<{ codecType: string; frameType: string; width: number; height: number }> = {}): { streamData: VideoStreamData; videoInfo: VideoInfo } {
  return {
    streamData: {
      codecType: overrides.codecType ?? 'H264',
      frameData: new Uint8Array([0, 0, 0, 1, 0x67, 1, 2, 3, 0, 0, 0, 1, 0x68, 4, 5]),
      timeStamp: { timestamp: 1000, timestamp_usec: 0, timezone: 0, rtpTimestamp: 1000 } as VideoStreamData['timeStamp'] & { rtpTimestamp: number }
    },
    videoInfo: {
      frameType: overrides.frameType ?? 'I',
      framerate: 30,
      width: overrides.width ?? 640,
      height: overrides.height ?? 480,
      codecInfo: 'avc1.64001e',
      spsPayload: new Uint8Array([1, 2, 3]),
      ppsPayload: new Uint8Array([4, 5, 6]),
      profileIdc: 100,
      levelIdc: 30
    }
  };
}

function audioFrame(): { streamData: AudioStreamData; audioInfo: AudioInfo } {
  return {
    streamData: {
      codecType: 'AAC',
      frameData: new Uint8Array([1, 2, 3, 4]),
      timeStamp: { timestamp: 1000, timestamp_usec: 0, timezone: 0, rtpTimestamp: 1000 } as AudioStreamData['timeStamp'] & { rtpTimestamp: number }
    },
    audioInfo: { bitrate: 64000 }
  };
}

describe('VideoTagPlayer contract tests (the legacy player’s Video/Player/Video/videoTagPlayer)', () => {
  beforeEach(() => {
    (globalThis as unknown as { MediaSource: unknown }).MediaSource = FakeMediaSource;
    (globalThis as unknown as { VTTCue: unknown }).VTTCue = FakeVTTCue;
    (globalThis as unknown as { window: unknown }).window = {
      URL: { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} },
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      jscd: fakeBrowserInfo
    };
    (globalThis as unknown as { document: unknown }).document = {
      hidden: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      createElement: (tag: string) => {
        if (tag === 'canvas') {
          return { width: 0, height: 0, getContext: () => ({ clearRect: vi.fn(), restore: vi.fn(), save: vi.fn(), drawImage: vi.fn() }), toBlob: (cb: (b: Blob | null) => void) => cb({} as Blob) };
        }
        return {};
      }
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as unknown as { MediaSource?: unknown }).MediaSource;
    delete (globalThis as unknown as { VTTCue?: unknown }).VTTCue;
    delete (globalThis as unknown as { window?: unknown }).window;
    delete (globalThis as unknown as { document?: unknown }).document;
  });

  it('constructor tunes bufferedFrameCount/defaultDelay per browser (Chrome/Windows path) and creates the audiotranscoder worker', () => {
    const { getWorker } = newPlayer({ os: 'Windows 10', browser: 'Chrome', osVersion: '10' });
    expect(getWorker()).toBeInstanceOf(FakeWorker);
    expect(getWorker().onmessage).toBeTypeOf('function');
  });

  it('constructor throws an RTSPOverWebSocketError for unsupported old macOS+Safari versions', () => {
    expect(() => new VideoTagPlayer(undefined, () => ({ os: 'Mac OS X', browser: 'Safari', osVersion: '10.12', browserVersion: '' }))).toThrow(/osx version/);
  });

  it('init() wires the video element, creates a MediaSource, and adds a timestamp text track', () => {
    const { player } = newPlayer();
    const el = new FakeVideoElement();
    expect(() => player.init(el as unknown as HTMLVideoElement)).not.toThrow();
    expect(el.src).toBe('blob:fake');
    expect(el.textTracks.tracks).toHaveLength(1);
    expect(el.textTracks.tracks[0].name).toBe('timestamp');
  });

  it('onVideoData() for the first I-frame creates the init segment and appends it to the source buffer', () => {
    const { player } = newPlayer();
    const el = new FakeVideoElement();
    player.init(el as unknown as HTMLVideoElement);

    // Drive mediaSource sourceopen so a real sourceBuffer gets created.
    const mediaSourceListeners = (el.src, (globalThis as unknown as { window: { URL: unknown } }).window);
    void mediaSourceListeners;

    const { streamData, videoInfo } = videoFrame({ codecType: 'H264', frameType: 'I' });
    expect(() => player.onVideoData('Live', streamData, videoInfo)).not.toThrow();
  });

  it('capture() downloads immediately when paused, and defers via captureFlag otherwise', () => {
    const { player } = newPlayer();
    const el = new FakeVideoElement();
    player.init(el as unknown as HTMLVideoElement);

    el.paused = true;
    expect(() => player.capture('snap1')).not.toThrow();

    el.paused = false;
    expect(() => player.capture('snap2')).not.toThrow();
  });

  it('play()/pause()/resume() toggle userPaused and the underlying video element playback state', () => {
    const { player } = newPlayer();
    const el = new FakeVideoElement();
    player.init(el as unknown as HTMLVideoElement);

    player.play();
    expect(el.paused).toBe(false);

    player.pause();
    expect(el.paused).toBe(true);

    player.resume();
    expect(el.paused).toBe(false);
  });

  it('close() is safe to call and revokes the object URL / clears the src', () => {
    const { player } = newPlayer();
    const el = new FakeVideoElement();
    player.init(el as unknown as HTMLVideoElement);
    el.src = 'blob:fake';

    expect(() => player.close()).not.toThrow();
    expect(el.attributes.src).toBeUndefined();
  });

  it('ControlVolume("mute"/"unmute") toggles muted and dummyAudio; numeric values scale volume by 0.2', () => {
    const { player } = newPlayer();
    const el = new FakeVideoElement();
    player.init(el as unknown as HTMLVideoElement);

    player.ControlVolume('unmute');
    expect(el.muted).toBe(false);

    player.ControlVolume('mute');
    expect(el.muted).toBe(true);

    player.ControlVolume(3);
    expect(el.volume).toBeCloseTo(0.6);
  });

  it('toggleControls(flags) sets/removes the controls attribute per the flag, and toggles when omitted', () => {
    const { player } = newPlayer();
    const el = new FakeVideoElement();
    player.init(el as unknown as HTMLVideoElement);

    player.toggleControls(true);
    expect(el.hasAttribute('controls')).toBe(true);

    player.toggleControls(false);
    expect(el.hasAttribute('controls')).toBe(false);

    player.toggleControls();
    expect(el.hasAttribute('controls')).toBe(true);
    player.toggleControls();
    expect(el.hasAttribute('controls')).toBe(false);
  });

  it('instantplaybackCmd dispatches play/pause/init/terminate correctly', () => {
    const { player } = newPlayer();
    const el = new FakeVideoElement();
    player.init(el as unknown as HTMLVideoElement);

    player.instantplaybackCmd({ cmd: 'play' });
    expect(el.paused).toBe(false);

    player.instantplaybackCmd({ cmd: 'pause' });
    expect(el.paused).toBe(true);

    player.playmode = 'live';
    player.instantplaybackCmd({ cmd: 'init' });
    expect(player.instantplayback).toBe(true);

    expect(() => player.instantplaybackCmd({ cmd: 'terminate' })).not.toThrow();
  });

  it('onChangeSpeed (via the inherited `speed` setter) parses string speeds and marks dummyAudio when != 1', () => {
    const { player } = newPlayer();
    const el = new FakeVideoElement();
    player.init(el as unknown as HTMLVideoElement);

    expect(() => {
      player.speed = 2;
    }).not.toThrow();
    expect(() => {
      player.speed = '1.5' as unknown as number;
    }).not.toThrow();
  });

  it('onChangeAudioShift (via the inherited `audioshift` setter) adjusts baseAudioTime without throwing once baseAudioTime is initialized', () => {
    const { player } = newPlayer();
    const el = new FakeVideoElement();
    player.init(el as unknown as HTMLVideoElement);
    expect(() => {
      player.audioshift = 100;
    }).not.toThrow();
  });

  it('onWaitingPackets sets dummyAudio from a matching-interleavedId audio waiting event', () => {
    const { player } = newPlayer();
    const el = new FakeVideoElement();
    player.init(el as unknown as HTMLVideoElement);

    expect(() =>
      player.onWaitingPackets({
        channelId: 0,
        interleavedId: 0,
        media: 'audio',
        islost: true,
        duration: 0
      })
    ).not.toThrow();
  });

  it('onAudioData() for AAC creates and buffers an audio sample without throwing (baseAudioTime auto-initializes on the first frame)', () => {
    const { player } = newPlayer();
    const el = new FakeVideoElement();
    player.init(el as unknown as HTMLVideoElement);
    // A real video I-frame must arrive first (it's what populates
    // videoInfoBox/createInitSegment) — sending audio before any video
    // frame would crash in legacy too (initSegment([null, audioInfo])).
    const videoI = videoFrame({ codecType: 'H264', frameType: 'I' });
    player.onVideoData('Live', videoI.streamData, videoI.videoInfo);

    const { streamData, audioInfo } = audioFrame();
    expect(() => player.onAudioData('Live', streamData, audioInfo)).not.toThrow();
  });

  it('onAudioData() for G711/G726 posts a transcode request to the audiotranscoder worker instead of buffering directly', () => {
    const { player, getWorker } = newPlayer();
    const el = new FakeVideoElement();
    player.init(el as unknown as HTMLVideoElement);
    getWorker().postMessage.mockClear();

    const { streamData, audioInfo } = audioFrame();
    streamData.codecType = 'G711';
    player.onAudioData('Live', streamData, { ...audioInfo });

    expect(getWorker().postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'transcode' }));
  });

  it('setVideoInfo derives a cropped target width/height for non-16-divisible special widths', () => {
    const { player } = newPlayer();
    const el = new FakeVideoElement();
    player.init(el as unknown as HTMLVideoElement);

    expect(() => player.setVideoInfo({ width: 1952, height: 1088, cropWidth: 32, cropHeight: 8, spsPayload: new Uint8Array(), ppsPayload: new Uint8Array() }, 'H264')).not.toThrow();
  });

  it('setAudioInfo switches sampling parameters between AAC and G711/G726 and re-inits the segment stream', () => {
    const { player, getWorker } = newPlayer();
    const el = new FakeVideoElement();
    player.init(el as unknown as HTMLVideoElement);
    const videoI = videoFrame({ codecType: 'H264', frameType: 'I' });
    player.onVideoData('Live', videoI.streamData, videoI.videoInfo);

    expect(() => player.setAudioInfo({ codecType: 'G711', bitrate: 64000, interleavedId: 1 })).not.toThrow();
    expect(getWorker().postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'init', data: expect.objectContaining({ codecType: 'G711' }) }));
    expect(player.getAudioInfo().samplingfrequencyindex).toBe(11);

    expect(() => player.setAudioInfo({ codecType: 'AAC', bitrate: 64000, interleavedId: 1 })).not.toThrow();
    expect(player.getAudioInfo().samplingfrequencyindex).toBe(8);
  });

  it('digitalZoom/bufferingVideoData/controlStepPlay/sendToBufferManager all throw TypeError — legacy never defines these on videoTagPlayer.js, and MediaRouter.ts only calls them when tagMode==="canvas" (i.e. never on this class)', () => {
    const { player } = newPlayer();
    const el = new FakeVideoElement();
    player.init(el as unknown as HTMLVideoElement);

    expect(() => player.digitalZoom({})).toThrow(TypeError);
    expect(() => player.bufferingVideoData('Live', videoFrame().streamData, videoFrame().videoInfo)).toThrow(TypeError);
    expect(() => player.controlStepPlay(null, 'forward')).toThrow(TypeError);
    expect(() => player.sendToBufferManager('Live', videoFrame().streamData, videoFrame().videoInfo, null)).toThrow(TypeError);
  });
});
