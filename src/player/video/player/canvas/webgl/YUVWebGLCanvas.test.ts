import { describe, it, expect } from 'vitest';
import { YUVWebGLCanvas } from './YUVWebGLCanvas';
import { Size } from '../../../../util/Size';
import { createFakeWebGLContext, createFakeCanvas } from './testSupport/fakeWebGLContext';

describe('YUVWebGLCanvas contract tests (the legacy player’s Video/Player/Canvas/webglCanvas — YUVWebGLCanvas)', () => {
  it('constructor creates 3 textures (Y at full size, U/V at half size via getHalfSize())', () => {
    const canvas = createFakeCanvas();
    const gl = createFakeWebGLContext(canvas);
    new YUVWebGLCanvas(canvas, gl, new Size(4, 4));

    const texImageCalls = gl.calls.filter((c) => c.name === 'texImage2D');
    expect(texImageCalls).toHaveLength(3);
    // [target, level, internalformat, width, height, ...]
    expect(texImageCalls[0].args[3]).toBe(4); // Y: full width
    expect(texImageCalls[0].args[4]).toBe(4);
    expect(texImageCalls[1].args[3]).toBe(2); // U: half width
    expect(texImageCalls[1].args[4]).toBe(2);
    expect(texImageCalls[2].args[3]).toBe(2); // V: half width
    expect(texImageCalls[2].args[4]).toBe(2);
  });

  it('constructor binds YTexture/UTexture/VTexture to texture units 0/1/2 under the expected uniform names', () => {
    const canvas = createFakeCanvas();
    const gl = createFakeWebGLContext(canvas);
    new YUVWebGLCanvas(canvas, gl, new Size(4, 4));

    const uniformNames = gl.calls.filter((c) => c.name === 'getUniformLocation').map((c) => c.args[1]);
    expect(uniformNames).toContain('YTexture');
    expect(uniformNames).toContain('UTexture');
    expect(uniformNames).toContain('VTexture');

    const activeTextureUnits = gl.calls.filter((c) => c.name === 'activeTexture').map((c) => c.args[0]);
    expect(activeTextureUnits).toEqual([gl.TEXTURE0, gl.TEXTURE1, gl.TEXTURE2]);
  });

  it('drawCanvas() splits a planar YUV420P buffer into Y/U/V (Y = w*h, U/V = w*h/4 each) and draws', () => {
    const canvas = createFakeCanvas();
    const gl = createFakeWebGLContext(canvas);
    const yuv = new YUVWebGLCanvas(canvas, gl, new Size(4, 2));
    gl.calls.length = 0;

    const lumaSize = 4 * 2; // 8
    const chromaSize = lumaSize >> 2; // 2
    const buffer = new Uint8Array(lumaSize + 2 * chromaSize);
    buffer.set(new Uint8Array(lumaSize).fill(1), 0);
    buffer.set(new Uint8Array(chromaSize).fill(2), lumaSize);
    buffer.set(new Uint8Array(chromaSize).fill(3), lumaSize + chromaSize);

    yuv.drawCanvas(buffer);

    const texImageCalls = gl.calls.filter((c) => c.name === 'texImage2D');
    expect(texImageCalls).toHaveLength(3);
    expect((texImageCalls[0].args[8] as Uint8Array).every((v) => v === 1)).toBe(true);
    expect((texImageCalls[1].args[8] as Uint8Array).every((v) => v === 2)).toBe(true);
    expect((texImageCalls[2].args[8] as Uint8Array).every((v) => v === 3)).toBe(true);

    const drawCall = gl.calls.find((c) => c.name === 'drawArrays');
    expect(drawCall?.args).toEqual([gl.TRIANGLE_STRIP, 0, 4]);
  });

  it('fillYUVTextures() fills Y/U/V without redrawing the scene', () => {
    const canvas = createFakeCanvas();
    const gl = createFakeWebGLContext(canvas);
    const yuv = new YUVWebGLCanvas(canvas, gl, new Size(2, 2));
    gl.calls.length = 0;

    yuv.fillYUVTextures(new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3]));

    expect(gl.calls.filter((c) => c.name === 'texImage2D')).toHaveLength(3);
    expect(gl.calls.some((c) => c.name === 'drawArrays')).toBe(false);
  });

  it('toString() reports "YUVCanvas Size: " + the Size', () => {
    const canvas = createFakeCanvas();
    const gl = createFakeWebGLContext(canvas);
    const yuv = new YUVWebGLCanvas(canvas, gl, new Size(6, 3));
    expect(yuv.toString()).toBe('YUVCanvas Size: (6, 3)');
  });

  it('initCanvas() clears depth+color buffers', () => {
    const canvas = createFakeCanvas();
    const gl = createFakeWebGLContext(canvas);
    const yuv = new YUVWebGLCanvas(canvas, gl, new Size(2, 2));
    gl.calls.length = 0;

    yuv.initCanvas();
    const call = gl.calls.find((c) => c.name === 'clear');
    expect(call?.args).toEqual([gl.DEPTH_BUFFER_BIT | gl.COLOR_BUFFER_BIT]);
  });

  it('destroy() deletes Y/U/V textures in addition to the base WebGLCanvas cleanup', () => {
    const canvas = createFakeCanvas();
    const gl = createFakeWebGLContext(canvas);
    const yuv = new YUVWebGLCanvas(canvas, gl, new Size(2, 2));
    gl.calls.length = 0;

    yuv.destroy();

    // 3 YUV textures + destroy() shouldn't also delete a base `texture`
    // field (onInitTextures is overridden here — texture is never set).
    expect(gl.calls.filter((c) => c.name === 'deleteTexture')).toHaveLength(3);
    expect(gl.calls).toEqual(expect.arrayContaining(['deleteFramebuffer', 'deleteRenderbuffer', 'deleteBuffer'].map((name) => expect.objectContaining({ name }))));
  });
});
