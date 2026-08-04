import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CanvasTagPlayer } from './CanvasTagPlayer';
import { createFakeWebGLContext } from './webgl/testSupport/fakeWebGLContext';
import type { VideoStreamData, VideoInfo } from '../../../mediaSession';

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
}

// resizeCheck()/draw()'s MJPEG branch touch real browser globals
// (window/document/Image) that don't exist under vitest's Node environment
// (this suite deliberately doesn't use jsdom — see vitest.config.ts) —
// stubbed for the duration of each test, same pattern as
// AudioPlayerAAC.test.ts's beforeAll/afterAll globalThis stubbing.
class FakeDomEvent {
  type = '';
  bubbles = false;
  cancelable = false;
  initEvent(type: string, bubbles: boolean, cancelable: boolean): void {
    this.type = type;
    this.bubbles = bubbles;
    this.cancelable = cancelable;
  }
}

class FakeImage {
  onload: (() => void) | null = null;
  src = '';
  width: number;
  height: number;
  constructor(width?: number, height?: number) {
    this.width = width ?? 0;
    this.height = height ?? 0;
  }
}

const fakeDocument = { createEvent: () => new FakeDomEvent() };
const fakeWindow = {
  jQuery: undefined as unknown,
  parent: {} as { id?: string },
  dispatchEvent: vi.fn(),
  URL: { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} }
};

interface FakeCanvasElement {
  width: number;
  height: number;
  id: string;
  tagName: string;
  listeners: Record<string, ((...args: unknown[]) => void)[]>;
  parentNode: { replaceChild: ReturnType<typeof vi.fn> } | null;
  cloneNode(deep: boolean): FakeCanvasElement;
  addEventListener(type: string, cb: (...args: unknown[]) => void): void;
  removeEventListener(type: string, cb: (...args: unknown[]) => void): void;
  setAttribute(name: string, value: string): void;
  getContext(type: string): unknown;
  getAttribute(name: string): string | null;
  toBlob(cb: (blob: Blob | null) => void): void;
}

function createFakeCanvasElement(): FakeCanvasElement {
  const gl = createFakeWebGLContext({ width: 0, height: 0 } as unknown as HTMLCanvasElement);
  const ctx2d = { clearRect: vi.fn(), drawImage: vi.fn() };
  const el: FakeCanvasElement = {
    width: 640,
    height: 480,
    id: 'canvas-1',
    tagName: 'CANVAS',
    listeners: {},
    parentNode: { replaceChild: vi.fn() },
    cloneNode(): FakeCanvasElement {
      const clone = createFakeCanvasElement();
      clone.width = el.width;
      clone.height = el.height;
      clone.id = el.id;
      clone.parentNode = el.parentNode;
      return clone;
    },
    addEventListener(type, cb): void {
      (el.listeners[type] ??= []).push(cb);
    },
    removeEventListener(type, cb): void {
      el.listeners[type] = (el.listeners[type] ?? []).filter((fn) => fn !== cb);
    },
    setAttribute(name, value): void {
      if (name === 'width') el.width = Number(value);
      if (name === 'height') el.height = Number(value);
    },
    getAttribute(name): string | null {
      if (name === 'width') return String(el.width);
      if (name === 'height') return String(el.height);
      return null;
    },
    getContext(type): unknown {
      if (type === 'webgl') return gl;
      if (type === '2d') return ctx2d;
      return null;
    },
    toBlob(cb): void {
      cb({} as Blob);
    }
  };
  return el;
}

// `worker` is only assigned once the player actually creates a decoder (on
// the first non-MJPEG checkPlayer() call) — a getWorker() accessor is used
// instead of a destructured property so tests can call it *after* triggering
// that, rather than capturing `undefined` at newPlayer() time.
function newPlayer(): { player: CanvasTagPlayer; getWorker: () => FakeWorker } {
  let worker: FakeWorker | undefined;
  const player = new CanvasTagPlayer(() => {
    worker = new FakeWorker();
    return worker as unknown as Worker;
  });
  return { player, getWorker: () => worker as FakeWorker };
}

function frame(overrides: Partial<{ codecType: string; frameType: string; width: number; height: number; dropOut: number }> = {}): {
  streamData: VideoStreamData;
  videoInfo: VideoInfo;
} {
  return {
    streamData: {
      codecType: overrides.codecType ?? 'H264',
      frameData: new Uint8Array([1, 2, 3]),
      timeStamp: { timestamp: 0, timestamp_usec: 0 }
    },
    videoInfo: {
      frameType: overrides.frameType ?? 'I',
      framerate: 30,
      width: overrides.width ?? 640,
      height: overrides.height ?? 480,
      dropOut: overrides.dropOut
    }
  };
}

describe('CanvasTagPlayer contract tests (the legacy player’s Video/Player/Canvas/canvasTagPlayer.js)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as unknown as { window: unknown }).window = fakeWindow;
    (globalThis as unknown as { document: unknown }).document = fakeDocument;
    (globalThis as unknown as { Image: unknown }).Image = FakeImage;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (globalThis as unknown as { window?: unknown }).window;
    delete (globalThis as unknown as { document?: unknown }).document;
    delete (globalThis as unknown as { Image?: unknown }).Image;
  });

  it('init() throws an RTSPOverWebSocketError for an undefined/non-element argument, and otherwise clones+replaces the element', () => {
    const { player } = newPlayer();
    expect(() => player.init(undefined)).toThrow(/canvas element do not exist/);

    const el = createFakeCanvasElement() as unknown as HTMLCanvasElement;
    expect(() => player.init(el)).not.toThrow();
    expect((el as unknown as FakeCanvasElement).parentNode?.replaceChild).toHaveBeenCalled();
  });

  it('play()/pause()/resume()/stop() toggle renderer.userPaused identically to legacy', () => {
    const { player } = newPlayer();
    player.init(createFakeCanvasElement() as unknown as HTMLCanvasElement);

    player.pause();
    player.stop();
    expect(() => player.play()).not.toThrow();
    expect(() => player.resume()).not.toThrow();
  });

  it('onVideoData() for a non-MJPEG codec creates a decoder worker and posts a "decode" message', () => {
    const { player, getWorker } = newPlayer();
    player.init(createFakeCanvasElement() as unknown as HTMLCanvasElement);

    const { streamData, videoInfo } = frame({ codecType: 'H264' });
    player.onVideoData('Live', streamData, videoInfo);

    expect(getWorker().postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'createDecoder', data: 'H264' }));
    expect(getWorker().postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'decode' }));
  });

  it('onVideoData() for MJPEG schedules a draw via setTimeout with the HD/FHD/UHD-bucketed delay, and does not create a decoder worker', () => {
    const { player } = newPlayer();
    player.init(createFakeCanvasElement() as unknown as HTMLCanvasElement);

    const { streamData, videoInfo } = frame({ codecType: 'MJPEG', width: 640, height: 480 }); // HD-or-under bucket
    player.setTimeStampCallback(() => {});
    player.onVideoData('Live', streamData, videoInfo);

    expect(vi.getTimerCount()).toBeGreaterThan(0);
    vi.advanceTimersByTime(200);
  });

  it('bufferingVideoData() pushes onto stepVideoList and creates a decoder worker for non-MJPEG codecs (checkPlayer)', () => {
    const { player, getWorker } = newPlayer();
    player.init(createFakeCanvasElement() as unknown as HTMLCanvasElement);

    const { streamData, videoInfo } = frame({ codecType: 'H264' });
    const result = player.bufferingVideoData('Live', streamData, videoInfo);

    expect(result).toBe(true);
    expect(getWorker().postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'createDecoder' }));
  });

  it('forward()/backward() return false and renew the canvas when there is nothing buffered yet (deviceType=camera)', () => {
    const { player } = newPlayer();
    player.init(createFakeCanvasElement() as unknown as HTMLCanvasElement);

    expect(player.forward()).toBe(false);
    expect(player.backward()).toBe(false);
  });

  it('clearBuffer() delegates to stepVideoList.bufferClear() without throwing', () => {
    const { player } = newPlayer();
    player.init(createFakeCanvasElement() as unknown as HTMLCanvasElement);
    expect(() => player.clearBuffer()).not.toThrow();
  });

  it('digitalZoom() is a no-op before any frame has triggered a resize (rendererCheck still false)', () => {
    const { player } = newPlayer();
    player.init(createFakeCanvasElement() as unknown as HTMLCanvasElement);
    expect(() => player.digitalZoom({ x: 1, y: 1, z: 1 })).not.toThrow();
  });

  it('capture() forwards to renderer.capture() without throwing when userPaused+a drawn frame exist', () => {
    const { player } = newPlayer();
    player.init(createFakeCanvasElement() as unknown as HTMLCanvasElement);
    const { streamData, videoInfo } = frame({ codecType: 'H264' });
    player.onVideoData('Live', streamData, videoInfo);

    expect(() => player.capture('snapshot')).not.toThrow();
  });

  it('close() removes the webglcontextlost listener, clears the media timer, terminates the decoder worker, and is safe on an already-closed player', () => {
    const { player, getWorker } = newPlayer();
    const el = createFakeCanvasElement();
    player.init(el as unknown as HTMLCanvasElement);
    const { streamData, videoInfo } = frame({ codecType: 'H264' });
    player.onVideoData('Live', streamData, videoInfo);

    expect(() => player.close()).not.toThrow();
    expect(getWorker().postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'terminate' }));
    expect(() => player.close()).not.toThrow();
  });

  describe('decoderWorkerMessage (driven by capturing the fake Worker\'s onmessage handler)', () => {
    function primedPlayer(tsCallback: (timeStamp: unknown) => void = () => {}): { player: CanvasTagPlayer; worker: FakeWorker; canvas: FakeCanvasElement } {
      const { player, getWorker } = newPlayer();
      const original = createFakeCanvasElement();
      player.setTimeStampCallback(tsCallback);
      player.init(original as unknown as HTMLCanvasElement);
      // init() clones the passed element (`element.cloneNode(true)`) and
      // uses the *clone* internally from then on — grab that clone (the
      // first arg replaceChild was called with) rather than asserting
      // against the untouched original.
      const canvas = (original.parentNode!.replaceChild as ReturnType<typeof vi.fn>).mock.calls[0][0] as FakeCanvasElement;
      const { streamData, videoInfo } = frame({ codecType: 'H264', width: 640, height: 480 });
      player.onVideoData('Live', streamData, videoInfo); // triggers createDecoderWorker -> assigns worker.onmessage
      return { player, worker: getWorker(), canvas };
    }

    it('"decoded" with matching canvas size draws the frame and forwards the timestamp callback', () => {
      const tsCallback = vi.fn();
      const { worker, canvas } = primedPlayer(tsCallback);

      expect(worker.onmessage).toBeTypeOf('function');
      const time = { timestamp: 1, timestamp_usec: 2, timezone: 0 };
      expect(() =>
        worker.onmessage!({
          data: {
            type: 'decoded',
            data: { width: canvas.width, height: canvas.height, frame: new Uint8Array(4), receiveClock: null, time }
          }
        } as MessageEvent)
      ).not.toThrow();
      expect(tsCallback).toHaveBeenCalledWith(expect.objectContaining({ type: 'timestamp' }));
    });

    it('"decoded" with a mismatched size updates the canvas width/height attributes instead of drawing', () => {
      const { worker, canvas } = primedPlayer();
      expect(worker.onmessage).toBeTypeOf('function');

      worker.onmessage!({
        data: { type: 'decoded', data: { width: 1280, height: 720, frame: new Uint8Array(4), receiveClock: null, time: null } }
      } as MessageEvent);

      expect(canvas.width).toBe(1280);
      expect(canvas.height).toBe(720);
    });

    it('"lowPerformance" invokes the registered errorCallback with the decoder performance payload', () => {
      const { player, worker } = primedPlayer();
      const errorCb = vi.fn();
      player.setErrorCallback(errorCb);

      worker.onmessage!({ data: { type: 'lowPerformance', data: { decoderId: 7, performance: 0.2 } } } as MessageEvent);

      expect(errorCb).toHaveBeenCalledWith(expect.objectContaining({ decoderId: 7, performance: 0.2 }));
    });

    it('"terminated" terminates and clears the decoder worker reference', () => {
      const { worker } = primedPlayer();
      expect(() => worker.onmessage!({ data: { type: 'terminated' } } as MessageEvent)).not.toThrow();
      expect(worker.terminate).toHaveBeenCalled();
    });

    it('an unrecognized message type throws an RTSPOverWebSocketError, matching legacy\'s default switch branch', () => {
      const { worker } = primedPlayer();
      expect(() => worker.onmessage!({ data: { type: 'bogus' } } as MessageEvent)).toThrow(/unknown data/);
    });
  });
});
