import type { Size } from '../../../../util/Size';

/**
 * Ported from the legacy player’s Video/Player/Canvas/webglCanvas (Script,
 * Shader, Program, Texture). `Script.createFromElementId` and `ImageTexture`
 * are dropped: grep across the whole the legacy player tree confirms neither is
 * ever called/instantiated — only `Script.createFromSource` and `Texture`
 * are actually used by WebGLCanvas/YUVWebGLCanvas.
 */
export interface ShaderScript {
  type: string;
  source: string;
}

export function createShaderScript(type: string, source: string): ShaderScript {
  return { type, source };
}

/** Ported from util.js's window.assert/window.error (log-only, never throws). */
export function glAssert(condition: unknown, message: string): void {
  if (!condition) {
    glError(message);
  }
}

export function glError(message: string): void {
  console.error(message);
  console.trace();
}

export class Shader {
  readonly gl: WebGLRenderingContext;
  shader: WebGLShader | null = null;

  constructor(gl: WebGLRenderingContext, script: ShaderScript) {
    this.gl = gl;
    if (script.type === 'x-shader/x-fragment') {
      this.shader = gl.createShader(gl.FRAGMENT_SHADER);
    } else if (script.type === 'x-shader/x-vertex') {
      this.shader = gl.createShader(gl.VERTEX_SHADER);
    } else {
      glError('Unknown shader type: ' + script.type);
      return;
    }

    gl.shaderSource(this.shader as WebGLShader, script.source);
    gl.compileShader(this.shader as WebGLShader);
    if (!gl.getShaderParameter(this.shader as WebGLShader, gl.COMPILE_STATUS)) {
      glError('An error occurred compiling the shaders: ' + gl.getShaderInfoLog(this.shader as WebGLShader));
      return;
    }
  }

  destroy(): void {
    this.gl.deleteShader(this.shader);
  }
}

export class Program {
  readonly gl: WebGLRenderingContext;
  readonly program: WebGLProgram | null;

  constructor(gl: WebGLRenderingContext) {
    this.gl = gl;
    this.program = gl.createProgram();
  }

  attach(shader: Shader): void {
    this.gl.attachShader(this.program as WebGLProgram, shader.shader as WebGLShader);
  }

  link(): void {
    this.gl.linkProgram(this.program as WebGLProgram);
    glAssert(this.gl.getProgramParameter(this.program as WebGLProgram, this.gl.LINK_STATUS), 'Unable to initialize the shader program.');
  }

  use(): void {
    this.gl.useProgram(this.program);
  }

  getAttributeLocation(name: string): number {
    return this.gl.getAttribLocation(this.program as WebGLProgram, name);
  }

  setMatrixUniform(name: string, array: Float32Array): void {
    const uniform = this.gl.getUniformLocation(this.program as WebGLProgram, name);
    this.gl.uniformMatrix4fv(uniform, false, array);
  }

  destroy(): void {
    this.gl.deleteProgram(this.program);
  }
}

// Shared across all Texture instances (module-level, matching legacy's
// closure-scoped `textureIDs` inside the Texture IIFE) — harmless, since
// TEXTURE0/1/2 are the same enum values on every WebGLRenderingContext.
let textureIDs: number[] | null = null;

export class Texture {
  readonly gl: WebGLRenderingContext;
  readonly size: Size;
  readonly texture: WebGLTexture | null;
  readonly format: number;

  constructor(gl: WebGLRenderingContext, size: Size, format?: number) {
    this.gl = gl;
    this.size = size;
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    this.format = format ? format : gl.LUMINANCE;
    gl.texImage2D(gl.TEXTURE_2D, 0, this.format, size.w, size.h, 0, this.format, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  fill(textureData: Uint8Array, useTexSubImage2D?: boolean): void {
    const gl = this.gl;
    glAssert(
      textureData.length >= this.size.w * this.size.h,
      'Texture size mismatch, data:' + textureData.length + ', texture: ' + this.size.w * this.size.h
    );
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (useTexSubImage2D) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.size.w, this.size.h, this.format, gl.UNSIGNED_BYTE, textureData);
    } else {
      // texImage2D seems to be faster, thus keeping it as the default
      gl.texImage2D(gl.TEXTURE_2D, 0, this.format, this.size.w, this.size.h, 0, this.format, gl.UNSIGNED_BYTE, textureData);
    }
  }

  bind(n: number, program: Program, name: string): void {
    const gl = this.gl;
    if (!textureIDs) {
      textureIDs = [gl.TEXTURE0, gl.TEXTURE1, gl.TEXTURE2];
    }
    gl.activeTexture(textureIDs[n]);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(gl.getUniformLocation(program.program as WebGLProgram, name), n);
  }

  destroy(): void {
    this.gl.deleteTexture(this.texture);
  }
}
