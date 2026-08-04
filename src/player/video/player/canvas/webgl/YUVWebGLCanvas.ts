import { Size } from '../../../../util/Size';
import { Shader, Program, Texture, createShaderScript, type ShaderScript } from './GLPrimitives';
import { WebGLCanvas } from './WebGLCanvas';

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
    'uniform sampler2D YTexture;',
    'uniform sampler2D UTexture;',
    'uniform sampler2D VTexture;',
    'const mat4 YUV2RGB = mat4',
    '(',
    ' 1.16438, 0.00000, 1.59603, -.87079,',
    ' 1.16438, -.39176, -.81297, .52959,',
    ' 1.16438, 2.01723, 0, -1.08139,',
    ' 0, 0, 0, 1',
    ');',
    'void main(void) {',
    ' gl_FragColor = vec4( texture2D(YTexture,  vTextureCoord).x, texture2D(UTexture, vTextureCoord).x, texture2D(VTexture, vTextureCoord).x, 1) * YUV2RGB;',
    '}'
  ].join('\n')
);

/**
 * Ported from the legacy player’s Video/Player/Canvas/webglCanvas (YUVWebGLCanvas).
 * Specializes WebGLCanvas for YUV420P planar frame data (3 planes bound as
 * separate textures, converted to RGB in the fragment shader).
 */
export class YUVWebGLCanvas extends WebGLCanvas {
  // No `= null` initializer: subclass field initializers run *after* super()
  // returns, which would otherwise stomp the values onInitTextures() (called
  // from WebGLCanvas's own constructor, dispatching to this class's override
  // below) already assigned during super()'s execution. `!` tells
  // strictPropertyInitialization these are assigned by the time they're used.
  protected YTexture!: Texture | null;
  protected UTexture!: Texture | null;
  protected VTexture!: Texture | null;

  constructor(canvas: HTMLCanvasElement, gl: WebGLRenderingContext, size: Size) {
    super(canvas, gl, size);
  }

  override onInitShaders(): void {
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

  override onInitTextures(): void {
    const gl = this.gl as WebGLRenderingContext;
    gl.viewport(
      0,
      0,
      this.size.viewWidth !== undefined ? this.size.viewWidth : this.size.w,
      this.size.viewHeight !== undefined ? this.size.viewHeight : this.size.h
    );
    this.YTexture = new Texture(gl, this.size);
    this.UTexture = new Texture(gl, this.size.getHalfSize());
    this.VTexture = new Texture(gl, this.size.getHalfSize());
  }

  override onInitSceneTextures(): void {
    (this.YTexture as Texture).bind(0, this.program as Program, 'YTexture');
    (this.UTexture as Texture).bind(1, this.program as Program, 'UTexture');
    (this.VTexture as Texture).bind(2, this.program as Program, 'VTexture');
  }

  fillYUVTextures(y: Uint8Array, u: Uint8Array, v: Uint8Array): void {
    (this.YTexture as Texture).fill(y);
    (this.UTexture as Texture).fill(u);
    (this.VTexture as Texture).fill(v);
  }

  drawCanvas(bufferData: Uint8Array): void {
    const lumaSize = this.size.w * this.size.h;
    const chromaSize = lumaSize >> 2;
    (this.YTexture as Texture).fill(bufferData.subarray(0, lumaSize));
    (this.UTexture as Texture).fill(bufferData.subarray(lumaSize, lumaSize + chromaSize));
    (this.VTexture as Texture).fill(bufferData.subarray(lumaSize + chromaSize, lumaSize + 2 * chromaSize));
    this.drawScene();
  }

  override toString(): string {
    return 'YUVCanvas Size: ' + this.size;
  }

  initCanvas(): void {
    const gl = this.gl as WebGLRenderingContext;
    gl.clear(gl.DEPTH_BUFFER_BIT | gl.COLOR_BUFFER_BIT);
  }

  override destroy(): void {
    if (this.YTexture !== null) {
      this.YTexture.destroy();
    }
    if (this.UTexture !== null) {
      this.UTexture.destroy();
    }
    if (this.VTexture !== null) {
      this.VTexture.destroy();
    }
    this.YTexture = null;
    this.UTexture = null;
    this.VTexture = null;
    super.destroy();
  }
}
