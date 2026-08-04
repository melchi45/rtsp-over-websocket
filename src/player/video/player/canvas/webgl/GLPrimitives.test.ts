import { describe, it, expect, vi, afterEach } from 'vitest';
import { Shader, Program, Texture, createShaderScript } from './GLPrimitives';
import { Size } from '../../../../util/Size';
import { createFakeWebGLContext, createFakeCanvas } from './testSupport/fakeWebGLContext';

describe('GLPrimitives contract tests (the legacy player’s Video/Player/Canvas/webglCanvas — Script/Shader/Program/Texture)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createShaderScript (Script.createFromSource)', () => {
    it('holds the given type and source verbatim', () => {
      const script = createShaderScript('x-shader/x-vertex', 'void main(){}');
      expect(script.type).toBe('x-shader/x-vertex');
      expect(script.source).toBe('void main(){}');
    });
  });

  describe('Shader', () => {
    it('compiles a fragment shader: createShader(FRAGMENT_SHADER) -> shaderSource -> compileShader', () => {
      const gl = createFakeWebGLContext(createFakeCanvas());
      const script = createShaderScript('x-shader/x-fragment', 'precision highp float;');
      const shader = new Shader(gl, script);

      expect(shader.shader).not.toBeNull();
      expect(gl.calls.map((c) => c.name)).toEqual(['createShader', 'shaderSource', 'compileShader', 'getShaderParameter']);
      expect(gl.calls[0].args).toEqual([gl.FRAGMENT_SHADER]);
    });

    it('compiles a vertex shader: createShader(VERTEX_SHADER)', () => {
      const gl = createFakeWebGLContext(createFakeCanvas());
      const shader = new Shader(gl, createShaderScript('x-shader/x-vertex', 'void main(){}'));
      expect(shader.shader).not.toBeNull();
      expect(gl.calls[0].args).toEqual([gl.VERTEX_SHADER]);
    });

    it('logs (via console.error+console.trace) and leaves shader null for an unrecognized script type, without throwing', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const traceSpy = vi.spyOn(console, 'trace').mockImplementation(() => {});
      const gl = createFakeWebGLContext(createFakeCanvas());

      expect(() => new Shader(gl, createShaderScript('bogus-type', 'x'))).not.toThrow();
      const shader = new Shader(gl, createShaderScript('bogus-type', 'x'));
      expect(shader.shader).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith('Unknown shader type: bogus-type');
      expect(traceSpy).toHaveBeenCalled();
      expect(gl.calls).toEqual([]);
    });

    it('logs and continues (compileShader is still called) when the shader fails to compile, without throwing', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const gl = createFakeWebGLContext(createFakeCanvas());
      gl.shaderCompileStatus = false;

      const shader = new Shader(gl, createShaderScript('x-shader/x-vertex', 'broken'));
      expect(shader.shader).not.toBeNull();
      expect(gl.calls.map((c) => c.name)).toEqual(['createShader', 'shaderSource', 'compileShader', 'getShaderParameter']);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('An error occurred compiling the shaders'));
    });

    it('destroy() calls gl.deleteShader with the compiled shader', () => {
      const gl = createFakeWebGLContext(createFakeCanvas());
      const shader = new Shader(gl, createShaderScript('x-shader/x-vertex', 'x'));
      shader.destroy();
      const deleteCall = gl.calls.find((c) => c.name === 'deleteShader');
      expect(deleteCall?.args).toEqual([shader.shader]);
    });
  });

  describe('Program', () => {
    it('attach/link/use/getAttributeLocation/setMatrixUniform/destroy delegate to the expected gl calls', () => {
      const gl = createFakeWebGLContext(createFakeCanvas());
      const program = new Program(gl);
      const vShader = new Shader(gl, createShaderScript('x-shader/x-vertex', 'v'));
      const fShader = new Shader(gl, createShaderScript('x-shader/x-fragment', 'f'));
      gl.calls.length = 0;

      program.attach(vShader);
      program.attach(fShader);
      program.link();
      program.use();
      const loc = program.getAttributeLocation('aVertexPosition');
      program.setMatrixUniform('uMVMatrix', new Float32Array(16));
      program.destroy();

      expect(loc).toBe(0);
      expect(gl.calls.map((c) => c.name)).toEqual([
        'attachShader',
        'attachShader',
        'linkProgram',
        'getProgramParameter',
        'useProgram',
        'getAttribLocation',
        'getUniformLocation',
        'uniformMatrix4fv',
        'deleteProgram'
      ]);
    });

    it('link() logs (does not throw) when LINK_STATUS is false', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const gl = createFakeWebGLContext(createFakeCanvas());
      gl.programLinkStatus = false;
      const program = new Program(gl);

      expect(() => program.link()).not.toThrow();
      expect(errorSpy).toHaveBeenCalledWith('Unable to initialize the shader program.');
    });
  });

  describe('Texture', () => {
    it('constructor creates+binds+configures a texture with the given format (falls back to LUMINANCE)', () => {
      const gl = createFakeWebGLContext(createFakeCanvas());
      const size = new Size(4, 2);
      const texture = new Texture(gl, size);

      expect(texture.format).toBe(gl.LUMINANCE);
      const texImageCall = gl.calls.find((c) => c.name === 'texImage2D');
      expect(texImageCall?.args).toEqual([gl.TEXTURE_2D, 0, gl.LUMINANCE, 4, 2, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, null]);
    });

    it('constructor uses the given format when provided (e.g. RGBA)', () => {
      const gl = createFakeWebGLContext(createFakeCanvas());
      const texture = new Texture(gl, new Size(4, 2), gl.RGBA);
      expect(texture.format).toBe(gl.RGBA);
    });

    it('fill() uses texImage2D by default and texSubImage2D when requested', () => {
      const gl = createFakeWebGLContext(createFakeCanvas());
      const texture = new Texture(gl, new Size(2, 2));
      gl.calls.length = 0;
      const data = new Uint8Array(4);

      texture.fill(data);
      expect(gl.calls.map((c) => c.name)).toEqual(['bindTexture', 'texImage2D']);

      gl.calls.length = 0;
      texture.fill(data, true);
      expect(gl.calls.map((c) => c.name)).toEqual(['bindTexture', 'texSubImage2D']);
    });

    it('fill() logs (does not throw) when textureData is smaller than size.w*size.h', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const gl = createFakeWebGLContext(createFakeCanvas());
      const texture = new Texture(gl, new Size(10, 10));

      expect(() => texture.fill(new Uint8Array(1))).not.toThrow();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Texture size mismatch'));
    });

    it('bind() activates TEXTUREn, binds, and sets the uniform sampler index', () => {
      const gl = createFakeWebGLContext(createFakeCanvas());
      const texture = new Texture(gl, new Size(2, 2));
      const program = new Program(gl);
      gl.calls.length = 0;

      texture.bind(1, program, 'UTexture');
      expect(gl.calls.map((c) => c.name)).toEqual(['activeTexture', 'bindTexture', 'getUniformLocation', 'uniform1i']);
      expect(gl.calls[0].args).toEqual([gl.TEXTURE1]);
      expect(gl.calls[3].args[1]).toBe(1);
    });

    it('destroy() calls gl.deleteTexture', () => {
      const gl = createFakeWebGLContext(createFakeCanvas());
      const texture = new Texture(gl, new Size(2, 2));
      texture.destroy();
      const deleteCall = gl.calls.find((c) => c.name === 'deleteTexture');
      expect(deleteCall?.args).toEqual([texture.texture]);
    });
  });
});
