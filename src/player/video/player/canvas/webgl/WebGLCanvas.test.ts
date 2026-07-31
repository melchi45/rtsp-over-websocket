import { describe, it, expect, vi } from 'vitest';
import { WebGLCanvas } from './WebGLCanvas';
import { Size } from '../../../../util/Size';
import { createFakeWebGLContext, createFakeCanvas } from './testSupport/fakeWebGLContext';

describe('WebGLCanvas contract tests (the legacy player’s Video/Player/Canvas/webglCanvas.js — WebGLCanvas)', () => {
  it('constructor sets canvas.width/height from size.w/h when no viewWidth/viewHeight is given', () => {
    const canvas = createFakeCanvas();
    const gl = createFakeWebGLContext(canvas);
    new WebGLCanvas(canvas, gl, new Size(640, 480));
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(480);
  });

  it('constructor prefers size.viewWidth/viewHeight over w/h when provided', () => {
    const canvas = createFakeCanvas();
    const gl = createFakeWebGLContext(canvas);
    new WebGLCanvas(canvas, gl, new Size(320, 240, 640, 480));
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(480);
  });

  it('constructor runs the init sequence in order: shader compile/link, quad buffers, texture, drawArrays setup (viewport) via onInitTextures', () => {
    const canvas = createFakeCanvas();
    const gl = createFakeWebGLContext(canvas);
    new WebGLCanvas(canvas, gl, new Size(2, 2));

    const names = gl.calls.map((c) => c.name);
    // onInitShaders
    expect(names).toContain('createProgram');
    expect(names).toContain('linkProgram');
    expect(names).toContain('useProgram');
    // initBuffers (quadVPBuffer/quadVTCBuffer)
    expect(names.filter((n) => n === 'createBuffer')).toHaveLength(2);
    expect(names.filter((n) => n === 'bufferData')).toHaveLength(2);
    // onInitTextures (single RGBA texture)
    expect(names).toContain('viewport');
    expect(names.filter((n) => n === 'createTexture')).toHaveLength(1);
    // initScene binds the quad + sets the uMVMatrix uniform
    expect(names).toContain('uniformMatrix4fv');
    // no framebuffer requested by default
    expect(names).not.toContain('createFramebuffer');
  });

  it('constructor sets up a framebuffer + depth renderbuffer when useFrameBuffer is true', () => {
    const canvas = createFakeCanvas();
    const gl = createFakeWebGLContext(canvas);
    new WebGLCanvas(canvas, gl, new Size(2, 2), true);

    const names = gl.calls.map((c) => c.name);
    expect(names).toContain('createFramebuffer');
    expect(names).toContain('createRenderbuffer');
    expect(names).toContain('framebufferTexture2D');
    expect(names).toContain('framebufferRenderbuffer');
    // bindFramebuffer is called both to attach it and again at the end of initScene
    expect(names.filter((n) => n === 'bindFramebuffer').length).toBeGreaterThanOrEqual(1);
  });

  it('toString() reports "WebGLCanvas Size: " + the Size', () => {
    const canvas = createFakeCanvas();
    const gl = createFakeWebGLContext(canvas);
    const wc = new WebGLCanvas(canvas, gl, new Size(8, 4));
    expect(wc.toString()).toBe('WebGLCanvas Size: (8, 4)');
  });

  it('checkLastError() is a no-op when gl.getError() is NO_ERROR', () => {
    const canvas = createFakeCanvas();
    const gl = createFakeWebGLContext(canvas);
    const wc = new WebGLCanvas(canvas, gl, new Size(2, 2));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    wc.checkLastError('someOp');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('checkLastError() logs the resolved enum name (via the glNames reverse map) when a recognized error is pending', () => {
    const canvas = createFakeCanvas();
    const gl = createFakeWebGLContext(canvas);
    const wc = new WebGLCanvas(canvas, gl, new Size(2, 2));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'trace').mockImplementation(() => {});
    // Use a code that IS one of gl's own enumerable numeric constants so glNames resolves it.
    gl.errorQueue = [gl.TEXTURE0];

    wc.checkLastError('draw');
    expect(logSpy).toHaveBeenCalledWith('WebGL Error: %s, %s', 'draw', expect.stringContaining('TEXTURE0'));
  });

  it('checkLastError() throws the preserved "undeclared global `value`" ReferenceError for an unrecognized error code', () => {
    const canvas = createFakeCanvas();
    const gl = createFakeWebGLContext(canvas);
    const wc = new WebGLCanvas(canvas, gl, new Size(2, 2));
    gl.errorQueue = [999999]; // not among gl's own enumerable numeric properties
    expect(() => wc.checkLastError()).toThrow(new ReferenceError('value is not defined'));
  });

  it('destroy() deletes GL resources and resets canvas size to 1x1, and is safe to introspect afterward', () => {
    const canvas = createFakeCanvas();
    const gl = createFakeWebGLContext(canvas);
    const wc = new WebGLCanvas(canvas, gl, new Size(4, 4));
    gl.calls.length = 0;

    wc.destroy();

    const names = gl.calls.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(['deleteFramebuffer', 'deleteRenderbuffer', 'deleteBuffer', 'deleteShader', 'deleteProgram', 'deleteTexture'])
    );
    expect(canvas.width).toBe(1);
    expect(canvas.height).toBe(1);
  });

  it('readPixels() reads a region matching size.w x size.h in RGBA/UNSIGNED_BYTE', () => {
    const canvas = createFakeCanvas();
    const gl = createFakeWebGLContext(canvas);
    const wc = new WebGLCanvas(canvas, gl, new Size(4, 3));
    gl.calls.length = 0;
    const buffer = new Uint8Array(4 * 3 * 4);

    wc.readPixels(buffer);
    const call = gl.calls.find((c) => c.name === 'readPixels');
    expect(call?.args).toEqual([0, 0, 4, 3, gl.RGBA, gl.UNSIGNED_BYTE, buffer]);
  });

  it('drawScene() draws a TRIANGLE_STRIP of 4 vertices', () => {
    const canvas = createFakeCanvas();
    const gl = createFakeWebGLContext(canvas);
    const wc = new WebGLCanvas(canvas, gl, new Size(2, 2));
    gl.calls.length = 0;

    wc.drawScene();
    const call = gl.calls.find((c) => c.name === 'drawArrays');
    expect(call?.args).toEqual([gl.TRIANGLE_STRIP, 0, 4]);
  });
});
