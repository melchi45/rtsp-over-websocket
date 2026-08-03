/**
 * A minimal fake WebGLRenderingContext for contract-tier tests: real GPU
 * rendering can't run under Node/Vitest, so this records every call made by
 * GLPrimitives/WebGLCanvas/YUVWebGLCanvas and returns simple stand-in
 * objects, letting tests assert on *what the port asked the GL context to
 * do* rather than on actual pixel output. Only the entry points this port's
 * code actually calls are implemented.
 */
export interface FakeGLCall {
  name: string;
  args: unknown[];
}

export interface FakeWebGLRenderingContext extends WebGLRenderingContext {
  calls: FakeGLCall[];
  shaderCompileStatus: boolean;
  programLinkStatus: boolean;
  errorQueue: number[];
}

let idCounter = 0;

export function createFakeGLObject(type: string): Record<string, unknown> {
  idCounter += 1;
  return { __type: type, __id: idCounter };
}

export function createFakeWebGLContext(canvas: HTMLCanvasElement): FakeWebGLRenderingContext {
  const calls: FakeGLCall[] = [];
  const record = (name: string, args: unknown[]): void => {
    calls.push({ name, args });
  };

  const gl = {
    canvas,
    calls,
    shaderCompileStatus: true,
    programLinkStatus: true,
    errorQueue: [] as number[],

    // Enums (real WebGL1 numeric values, order doesn't matter for a fake context).
    FRAGMENT_SHADER: 35632,
    VERTEX_SHADER: 35633,
    COMPILE_STATUS: 35713,
    LINK_STATUS: 35714,
    TEXTURE_2D: 3553,
    LUMINANCE: 6409,
    RGBA: 6408,
    UNSIGNED_BYTE: 5121,
    TEXTURE_MAG_FILTER: 10240,
    TEXTURE_MIN_FILTER: 10241,
    NEAREST: 9728,
    TEXTURE_WRAP_S: 10242,
    TEXTURE_WRAP_T: 10243,
    CLAMP_TO_EDGE: 33071,
    TEXTURE0: 33984,
    TEXTURE1: 33985,
    TEXTURE2: 33986,
    ARRAY_BUFFER: 34962,
    STATIC_DRAW: 35044,
    FLOAT: 5126,
    TRIANGLE_STRIP: 5,
    NO_ERROR: 0,
    DEPTH_BUFFER_BIT: 256,
    COLOR_BUFFER_BIT: 16384,
    FRAMEBUFFER: 36160,
    COLOR_ATTACHMENT0: 36064,
    DEPTH_ATTACHMENT: 36096,
    RENDERBUFFER: 36161,
    DEPTH_COMPONENT16: 33189,

    createShader(type: number): Record<string, unknown> {
      record('createShader', [type]);
      return createFakeGLObject('shader');
    },
    shaderSource(shader: unknown, source: string): void {
      record('shaderSource', [shader, source]);
    },
    compileShader(shader: unknown): void {
      record('compileShader', [shader]);
    },
    getShaderParameter(this: FakeWebGLRenderingContext, shader: unknown, pname: number): boolean {
      record('getShaderParameter', [shader, pname]);
      return this.shaderCompileStatus;
    },
    getShaderInfoLog(): string {
      return 'fake shader info log';
    },
    deleteShader(shader: unknown): void {
      record('deleteShader', [shader]);
    },
    createProgram(): Record<string, unknown> {
      record('createProgram', []);
      return createFakeGLObject('program');
    },
    attachShader(program: unknown, shader: unknown): void {
      record('attachShader', [program, shader]);
    },
    linkProgram(program: unknown): void {
      record('linkProgram', [program]);
    },
    getProgramParameter(this: FakeWebGLRenderingContext, program: unknown, pname: number): boolean {
      record('getProgramParameter', [program, pname]);
      return this.programLinkStatus;
    },
    useProgram(program: unknown): void {
      record('useProgram', [program]);
    },
    deleteProgram(program: unknown): void {
      record('deleteProgram', [program]);
    },
    getAttribLocation(program: unknown, name: string): number {
      record('getAttribLocation', [program, name]);
      return name === 'aVertexPosition' ? 0 : 1;
    },
    enableVertexAttribArray(index: number): void {
      record('enableVertexAttribArray', [index]);
    },
    getUniformLocation(program: unknown, name: string): Record<string, unknown> {
      record('getUniformLocation', [program, name]);
      return createFakeGLObject('uniformLocation:' + name);
    },
    uniformMatrix4fv(location: unknown, transpose: boolean, value: Float32Array): void {
      record('uniformMatrix4fv', [location, transpose, value]);
    },
    uniform1i(location: unknown, value: number): void {
      record('uniform1i', [location, value]);
    },
    createTexture(): Record<string, unknown> {
      record('createTexture', []);
      return createFakeGLObject('texture');
    },
    bindTexture(target: number, texture: unknown): void {
      record('bindTexture', [target, texture]);
    },
    texImage2D(...args: unknown[]): void {
      record('texImage2D', args);
    },
    texSubImage2D(...args: unknown[]): void {
      record('texSubImage2D', args);
    },
    texParameteri(target: number, pname: number, param: number): void {
      record('texParameteri', [target, pname, param]);
    },
    activeTexture(texture: number): void {
      record('activeTexture', [texture]);
    },
    deleteTexture(texture: unknown): void {
      record('deleteTexture', [texture]);
    },
    createBuffer(): Record<string, unknown> {
      record('createBuffer', []);
      return createFakeGLObject('buffer');
    },
    bindBuffer(target: number, buffer: unknown): void {
      record('bindBuffer', [target, buffer]);
    },
    bufferData(...args: unknown[]): void {
      record('bufferData', args);
    },
    deleteBuffer(buffer: unknown): void {
      record('deleteBuffer', [buffer]);
    },
    vertexAttribPointer(...args: unknown[]): void {
      record('vertexAttribPointer', args);
    },
    viewport(...args: unknown[]): void {
      record('viewport', args);
    },
    drawArrays(...args: unknown[]): void {
      record('drawArrays', args);
    },
    readPixels(...args: unknown[]): void {
      record('readPixels', args);
    },
    clear(mask: number): void {
      record('clear', [mask]);
    },
    getError(this: FakeWebGLRenderingContext): number {
      record('getError', []);
      return this.errorQueue.shift() ?? this.NO_ERROR;
    },
    createFramebuffer(): Record<string, unknown> {
      record('createFramebuffer', []);
      return createFakeGLObject('framebuffer');
    },
    bindFramebuffer(target: number, fb: unknown): void {
      record('bindFramebuffer', [target, fb]);
    },
    deleteFramebuffer(fb: unknown): void {
      record('deleteFramebuffer', [fb]);
    },
    createRenderbuffer(): Record<string, unknown> {
      record('createRenderbuffer', []);
      return createFakeGLObject('renderbuffer');
    },
    bindRenderbuffer(target: number, rb: unknown): void {
      record('bindRenderbuffer', [target, rb]);
    },
    deleteRenderbuffer(rb: unknown): void {
      record('deleteRenderbuffer', [rb]);
    },
    renderbufferStorage(...args: unknown[]): void {
      record('renderbufferStorage', args);
    },
    framebufferTexture2D(...args: unknown[]): void {
      record('framebufferTexture2D', args);
    },
    framebufferRenderbuffer(...args: unknown[]): void {
      record('framebufferRenderbuffer', args);
    }
  };

  return gl as unknown as FakeWebGLRenderingContext;
}

export function createFakeCanvas(): HTMLCanvasElement {
  return {
    width: 0,
    height: 0
  } as unknown as HTMLCanvasElement;
}
