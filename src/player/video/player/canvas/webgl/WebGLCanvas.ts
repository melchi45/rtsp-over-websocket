import { Size } from '../../../../util/Size';
import { browserDetect } from '../../../../util/BrowserDetect';
import { Shader, Program, Texture, createShaderScript, glError, type ShaderScript } from './GLPrimitives';

function undefinedGlobalError(name: string): ReferenceError {
  return new ReferenceError(`${name} is not defined`);
}

const VERTEX_SHADER_SCRIPT: ShaderScript = createShaderScript(
  'x-shader/x-vertex',
  [
    'attribute vec3 aVertexPosition;',
    'attribute vec2 aTextureCoord;',
    'uniform mat4 uMVMatrix;',
    'varying highp vec2 vTextureCoord;',
    'void main(void) {',
    '  gl_Position = uMVMatrix * vec4(aVertexPosition, 1.0);',
    '  vTextureCoord = aTextureCoord;',
    '}'
  ].join('\n')
);

const FRAGMENT_SHADER_SCRIPT: ShaderScript = createShaderScript(
  'x-shader/x-fragment',
  [
    'precision highp float;',
    'varying highp vec2 vTextureCoord;',
    'uniform sampler2D texture;',
    'void main(void) {',
    '  gl_FragColor = texture2D(texture, vTextureCoord);',
    '}'
  ].join('\n')
);

// Sylvester's Matrix.I(4).flatten() (via app/external-lib/util/glUtils.js) is
// not wrapped as a dependency here: the only live use is this compile-time-
// constant 4x4 identity matrix — mvMultiply/mvTranslate/zoomScene (the only
// call sites that would need real matrix math) are commented out/dead in the
// legacy source itself, confirmed by reading webglCanvas.js directly.
const IDENTITY_MATRIX_4X4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

const BROWSER_TYPE = browserDetect();

/**
 * Ported from the legacy player’s Video/Player/Canvas/webglCanvas.js (WebGLCanvas).
 * Generic WebGL-backed canvas that sets up a textured quad, vertex/fragment
 * shaders, and scene parameters; YUVWebGLCanvas specializes it for YUV->RGB
 * playback. Overridable hook methods (onInitWebGL/onInitShaders/
 * onInitTextures/onInitSceneTextures) are real class methods (not field
 * arrow functions) so that this base constructor's calls into them dispatch
 * to a subclass's override even during construction — matching legacy's
 * prototype-based `this.onInitShaders()` dispatch.
 */
export class WebGLCanvas {
  canvas: HTMLCanvasElement | null;
  size: Size;
  gl: WebGLRenderingContext | null;

  protected glNames: Record<number, string> | null = null;
  protected vertexShader: Shader | null = null;
  protected fragmentShader: Shader | null = null;
  protected program: Program | null = null;
  protected texture: Texture | null = null;
  protected vertexPositionAttribute = 0;
  protected textureCoordAttribute = 0;
  protected quadVPBuffer: WebGLBuffer | null = null;
  protected quadVTCBuffer: WebGLBuffer | null = null;
  protected framebuffer: WebGLFramebuffer | null = null;
  protected framebufferTexture: Texture | null = null;
  protected renderbuffer: WebGLRenderbuffer | null = null;
  private mvMatrix: Float32Array = IDENTITY_MATRIX_4X4;

  constructor(canvas: HTMLCanvasElement, gl: WebGLRenderingContext, size: Size, useFrameBuffer?: boolean) {
    this.canvas = canvas;
    this.size = size;
    this.gl = gl;

    this.canvas.width = size.viewWidth !== undefined ? size.viewWidth : size.w;
    this.canvas.height = size.viewHeight !== undefined ? size.viewHeight : size.h;
    this.onInitWebGL();
    this.onInitShaders();
    this.initBuffers();
    if (useFrameBuffer) {
      this.initFramebuffer();
    }
    this.onInitTextures();
    this.initScene();
  }

  private initFramebuffer(): void {
    const gl = this.gl as WebGLRenderingContext;
    this.framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    this.framebufferTexture = new Texture(gl, this.size, gl.RGBA);
    this.renderbuffer = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.renderbuffer);
    gl.renderbufferStorage(
      gl.RENDERBUFFER,
      gl.DEPTH_COMPONENT16,
      this.size.viewWidth !== undefined ? this.size.viewWidth : this.size.w,
      this.size.viewHeight !== undefined ? this.size.viewHeight : this.size.h
    );
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.framebufferTexture.texture, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.renderbuffer);
  }

  private initBuffers(): void {
    const gl = this.gl as WebGLRenderingContext;
    this.quadVPBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVPBuffer);
    let tmp = [1.0, 1.0, 0.0, -1.0, 1.0, 0.0, 1.0, -1.0, 0.0, -1.0, -1.0, 0.0];
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(tmp), gl.STATIC_DRAW);

    let scaleX = 1.0;
    // To avoid gray line of image when width is not divisible by 16 for Edge browser
    if (BROWSER_TYPE === 'edge' && (this.canvas as HTMLCanvasElement).width !== this.size.w) {
      scaleX = (this.canvas as HTMLCanvasElement).width / this.size.w;
    }

    const scaleY = 1.0;
    this.quadVTCBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVTCBuffer);
    tmp = [scaleX, 0.0, 0.0, 0.0, scaleX, scaleY, 0.0, scaleY];
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(tmp), gl.STATIC_DRAW);
  }

  private mvIdentity(): void {
    this.mvMatrix = IDENTITY_MATRIX_4X4;
  }

  private setMatrixUniforms(): void {
    (this.program as Program).setMatrixUniform('uMVMatrix', this.mvMatrix);
  }

  private initScene(): void {
    const gl = this.gl as WebGLRenderingContext;
    this.mvIdentity();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVPBuffer);
    gl.vertexAttribPointer(this.vertexPositionAttribute, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVTCBuffer);
    gl.vertexAttribPointer(this.textureCoordAttribute, 2, gl.FLOAT, false, 0, 0);
    this.onInitSceneTextures();
    this.setMatrixUniforms();

    if (this.framebuffer) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    }
  }

  toString(): string {
    return 'WebGLCanvas Size: ' + this.size;
  }

  checkLastError(operation?: string): void {
    const gl = this.gl as WebGLRenderingContext;
    const err = gl.getError();
    if (err !== gl.NO_ERROR) {
      const known = (this.glNames as Record<number, string>)[err];
      let name: string;
      if (known !== undefined) {
        name = `${known}(${err})`;
      } else {
        // legacy references the undeclared global `value` here (see the
        // `/* global ... value ... */` comment atop webglCanvas.js — never
        // actually defined anywhere), so it throws a ReferenceError for any
        // WebGL error code not already present in glNames. Only reachable if
        // gl.getError() returns something outside `gl`'s own enumerable
        // numeric constants — effectively unreachable with a real
        // WebGLRenderingContext, but preserved for fidelity.
        throw undefinedGlobalError('value');
      }
      if (operation) {
        console.log('WebGL Error: %s, %s', operation, name);
      } else {
        console.log('WebGL Error: %s', name);
      }
      console.trace();
    }
  }

  onInitWebGL(): void {
    if (!this.gl) {
      glError('Unable to initialize WebGL. Your browser may not support it.');
    }
    if (this.glNames) {
      return;
    }
    this.glNames = {};
    const gl = this.gl as unknown as Record<string, unknown>;
    for (const propertyName in gl) {
      if (typeof gl[propertyName] === 'number') {
        this.glNames[gl[propertyName] as number] = propertyName;
      }
    }
  }

  onInitShaders(): void {
    const gl = this.gl as WebGLRenderingContext;
    this.program = new Program(gl);
    this.vertexShader = new Shader(gl, VERTEX_SHADER_SCRIPT);
    this.fragmentShader = new Shader(gl, FRAGMENT_SHADER_SCRIPT);
    this.program.attach(this.vertexShader);
    this.program.attach(this.fragmentShader);
    this.program.link();
    this.program.use();
    this.vertexPositionAttribute = this.program.getAttributeLocation('aVertexPosition');
    gl.enableVertexAttribArray(this.vertexPositionAttribute);
    this.textureCoordAttribute = this.program.getAttributeLocation('aTextureCoord');
    gl.enableVertexAttribArray(this.textureCoordAttribute);
  }

  onInitTextures(): void {
    const gl = this.gl as WebGLRenderingContext;
    gl.viewport(0, 0, (this.canvas as HTMLCanvasElement).width, (this.canvas as HTMLCanvasElement).height);
    this.texture = new Texture(gl, this.size, gl.RGBA);
  }

  onInitSceneTextures(): void {
    (this.texture as Texture).bind(0, this.program as Program, 'texture');
  }

  drawScene(): void {
    (this.gl as WebGLRenderingContext).drawArrays((this.gl as WebGLRenderingContext).TRIANGLE_STRIP, 0, 4);
  }

  readPixels(buffer: ArrayBufferView): void {
    const gl = this.gl as WebGLRenderingContext;
    gl.readPixels(0, 0, this.size.w, this.size.h, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
  }

  destroy(): void {
    const gl = this.gl as WebGLRenderingContext;

    gl.deleteFramebuffer(this.framebuffer);
    this.framebuffer = null;
    gl.deleteRenderbuffer(this.renderbuffer);
    gl.deleteBuffer(this.quadVPBuffer);
    gl.deleteBuffer(this.quadVTCBuffer);
    if (this.vertexShader !== null) {
      this.vertexShader.destroy();
    }
    if (this.fragmentShader !== null) {
      this.fragmentShader.destroy();
    }
    if (this.framebufferTexture !== null) {
      this.framebufferTexture.destroy();
    }
    if (this.texture !== null) {
      this.texture.destroy();
    }
    if (this.program !== null) {
      this.program.destroy();
    }
    gl.canvas.width = 1;
    gl.canvas.height = 1;

    this.renderbuffer = null;
    this.quadVPBuffer = null;
    this.quadVTCBuffer = null;
    this.vertexShader = null;
    this.fragmentShader = null;
    this.texture = null;
    this.program = null;
    this.gl = null;
    this.canvas = null;
  }
}
