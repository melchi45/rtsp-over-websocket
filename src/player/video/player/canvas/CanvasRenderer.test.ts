import { describe, it, expect, vi } from 'vitest';
import { CanvasRenderer } from './CanvasRenderer';
import { createFakeWebGLContext } from './webgl/testSupport/fakeWebGLContext';

interface FakeCanvasElement {
  width: number;
  height: number;
  updatedCanvas?: boolean;
  attributes: Record<string, string>;
  getAttribute(name: string): string | null;
  getContext(type: string): unknown;
  toBlob(cb: (blob: Blob | null) => void): void;
  addEventListener?: (...args: unknown[]) => void;
}

function createFake2DContext(): { clearRect: ReturnType<typeof vi.fn>; drawImage: ReturnType<typeof vi.fn> } {
  return { clearRect: vi.fn(), drawImage: vi.fn() };
}

function createFakeCanvasElement(attrs: Record<string, string> = {}): FakeCanvasElement {
  const gl = createFakeWebGLContext({ width: 0, height: 0 } as unknown as HTMLCanvasElement);
  const ctx2d = createFake2DContext();
  const canvas: FakeCanvasElement = {
    width: 0,
    height: 0,
    attributes: attrs,
    getAttribute(name: string): string | null {
      return name in attrs ? attrs[name] : null;
    },
    getContext(type: string): unknown {
      if (type === 'webgl') return gl;
      if (type === '2d') return ctx2d;
      return null;
    },
    toBlob(cb: (blob: Blob | null) => void): void {
      cb({} as Blob);
    }
  };
  return canvas;
}

describe('CanvasRenderer contract tests (the legacy player’s Video/Player/Canvas/canvasRenderer.js)', () => {
  it('init() throws an RTSPOverWebSocketError when element is undefined, and is otherwise a no-op', () => {
    const renderer = new CanvasRenderer();
    expect(() => renderer.init(undefined)).toThrow(/canvas tag element is undefined/);
    expect(() => renderer.init(createFakeCanvasElement() as unknown as HTMLCanvasElement)).not.toThrow();
  });

  it('channelId defaults to undefined (never assigned internally) but is a plain, externally-settable property (no accessor blocks it, matching canvasTagPlayer.js\'s init() setting it directly)', () => {
    const renderer = new CanvasRenderer();
    expect(renderer.channelId).toBeUndefined();
    renderer.channelId = 3;
    expect(renderer.channelId).toBe(3);
  });

  it('userPaused defaults to false and is a plain, freely reassignable field (no accessor side effects)', () => {
    const renderer = new CanvasRenderer();
    expect(renderer.userPaused).toBe(false);
    renderer.userPaused = true;
    expect(renderer.userPaused).toBe(true);
  });

  it('setCanvas("H264", ...) creates a WebGL drawer via getContext("webgl")', () => {
    const renderer = new CanvasRenderer();
    const canvas = createFakeCanvasElement();
    const getContextSpy = vi.spyOn(canvas, 'getContext');
    renderer.init(canvas as unknown as HTMLCanvasElement);

    expect(() => renderer.setCanvas('H264', { width: 4, height: 4 })).not.toThrow();
    expect(getContextSpy).toHaveBeenCalledWith('webgl');
  });

  it('setCanvas("MJPEG", ...) creates a 2D-context drawer via getContext("2d")', () => {
    const renderer = new CanvasRenderer();
    const canvas = createFakeCanvasElement();
    const getContextSpy = vi.spyOn(canvas, 'getContext');
    renderer.init(canvas as unknown as HTMLCanvasElement);

    renderer.setCanvas('MJPEG', { width: 4, height: 4 });
    expect(getContextSpy).toHaveBeenCalledWith('2d');
  });

  it('setCanvas() only creates the drawer once — a second call with a different codec is ignored', () => {
    const renderer = new CanvasRenderer();
    const canvas = createFakeCanvasElement();
    const getContextSpy = vi.spyOn(canvas, 'getContext');
    renderer.init(canvas as unknown as HTMLCanvasElement);

    renderer.setCanvas('H264', { width: 4, height: 4 });
    getContextSpy.mockClear();
    renderer.setCanvas('MJPEG', { width: 4, height: 4 });
    expect(getContextSpy).not.toHaveBeenCalled();
  });

  it('draw() for a non-MJPEG codec draws immediately and caches the raw frame for capture()', () => {
    const renderer = new CanvasRenderer();
    const canvas = createFakeCanvasElement();
    renderer.init(canvas as unknown as HTMLCanvasElement);
    renderer.setCanvas('H264', { width: 2, height: 2 });

    const frame = new Uint8Array(16); // 2x2 RGBA luma+chroma-ish stand-in
    expect(() => renderer.draw(frame, { width: 2, height: 2 })).not.toThrow();
    expect((canvas as unknown as { updatedCanvas?: boolean }).updatedCanvas).toBe(true);
  });

  it('renewCanvas() is a no-op before setCanvas() and calls drawer.initCanvas() after', () => {
    const renderer = new CanvasRenderer();
    expect(() => renderer.renewCanvas()).not.toThrow();

    const canvas = createFakeCanvasElement();
    renderer.init(canvas as unknown as HTMLCanvasElement);
    renderer.setCanvas('MJPEG', { width: 2, height: 2 });
    expect(() => renderer.renewCanvas()).not.toThrow();
  });

  it('digitalZoom() throws TypeError once a drawer exists — updateVertexArray is dead/commented-out in legacy on every drawer type', () => {
    const renderer = new CanvasRenderer();
    expect(() => renderer.digitalZoom({ x: 1, y: 1, z: 1 })).not.toThrow(); // no drawer yet: no-op

    const canvas = createFakeCanvasElement();
    renderer.init(canvas as unknown as HTMLCanvasElement);
    renderer.setCanvas('MJPEG', { width: 2, height: 2 });
    expect(() => renderer.digitalZoom({ x: 1, y: 1, z: 1 })).toThrow(TypeError);
  });

  it('destroy() clears the drawer and is safe to call again afterward (idempotent no-op)', () => {
    const renderer = new CanvasRenderer();
    const canvas = createFakeCanvasElement();
    renderer.init(canvas as unknown as HTMLCanvasElement);
    renderer.setCanvas('MJPEG', { width: 2, height: 2 });

    expect(() => renderer.destroy()).not.toThrow();
    expect(() => renderer.destroy()).not.toThrow();
  });

  it('addEventListener("capture", cb) registers eventCaptureCallback; other event names are ignored', () => {
    const renderer = new CanvasRenderer();
    const cb = vi.fn();
    renderer.addEventListener('capture', cb);
    expect(renderer.eventCaptureCallback).toBe(cb);

    renderer.addEventListener('bogus', vi.fn());
    expect(renderer.eventCaptureCallback).toBe(cb); // unchanged
  });

  it('capture() + a cached frame + userPaused=true redraws immediately and (via the injected saveAsFn) saves a PNG blob', () => {
    const saveAsFn = vi.fn();
    const renderer = new CanvasRenderer(saveAsFn);
    const canvas = createFakeCanvasElement();
    renderer.init(canvas as unknown as HTMLCanvasElement);
    renderer.setCanvas('H264', { width: 2, height: 2 });
    renderer.draw(new Uint8Array(16), { width: 2, height: 2 });

    renderer.userPaused = true;
    (canvas as unknown as { updatedCanvas?: boolean }).updatedCanvas = true;
    renderer.capture('my-snapshot');

    expect(saveAsFn).toHaveBeenCalledWith(expect.anything(), 'my-snapshot.png');
  });

  // capture(name)'s `name` is typed `string`, but nothing at runtime stops a
  // caller from passing undefined (legacy has no such type enforcement
  // either) — that's the only reachable way for download()'s `fileName`
  // check to fail, since capture() is the sole place fileName gets set.
  it('capture(undefined) + a registered eventCaptureCallback calls it with {channelId, blob} instead of saving', () => {
    const saveAsFn = vi.fn();
    const renderer = new CanvasRenderer(saveAsFn);
    const captureCallback = vi.fn();
    const canvas = createFakeCanvasElement();
    renderer.init(canvas as unknown as HTMLCanvasElement);
    renderer.setCanvas('H264', { width: 2, height: 2 });
    renderer.addEventListener('capture', captureCallback);
    renderer.draw(new Uint8Array(16), { width: 2, height: 2 });

    renderer.userPaused = true;
    (canvas as unknown as { updatedCanvas?: boolean }).updatedCanvas = true;
    renderer.capture(undefined as unknown as string);

    expect(saveAsFn).not.toHaveBeenCalled();
    expect(captureCallback).toHaveBeenCalledWith({ channelId: undefined, blob: expect.anything() });
  });

  it('capture(undefined) with no eventCaptureCallback registered throws an RTSPOverWebSocketError instead of silently dropping the blob', () => {
    const renderer = new CanvasRenderer();
    const canvas = createFakeCanvasElement();
    renderer.init(canvas as unknown as HTMLCanvasElement);
    renderer.setCanvas('H264', { width: 2, height: 2 });
    renderer.draw(new Uint8Array(16), { width: 2, height: 2 });

    renderer.userPaused = true;
    (canvas as unknown as { updatedCanvas?: boolean }).updatedCanvas = true;
    expect(() => renderer.capture(undefined as unknown as string)).toThrow(/can not return capture blob/);
  });
});
