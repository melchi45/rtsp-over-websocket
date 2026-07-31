/**
 * Shared ambient `Module` typing for this project's vendored Emscripten
 * asm.js/WASM builds (ffmpegAAC.decoder.js, ffmpeg.js, ffmpegAAC.js — see
 * each vendor file's own comment). All three attach a single bare global
 * named `Module` when loaded via `importScripts()`/`<script>` (classic
 * top-level script execution, not ESM `import` — see minizip-asm.d.ts for
 * why that matters), so their ambient declarations must share one identical
 * `declare global` site rather than one per vendor file (TypeScript requires
 * every declaration of the same ambient `var` to agree exactly). Fields only
 * one specific build actually provides are optional.
 */
export type EmscriptenCType = 'void' | 'number' | 'string' | 'array';

export interface EmscriptenModule {
  cwrap<F extends (...args: never[]) => unknown>(ident: string, returnType: EmscriptenCType | null, argTypes: EmscriptenCType[]): F;
  _malloc(size: number): number;
  _free?(ptr: number): void;
  readonly HEAPF32?: Float32Array;
  readonly HEAPU8?: Uint8Array;
  readonly HEAP8?: Int8Array;
  wasmBinary?: ArrayBuffer;
  onRuntimeInitialized?: () => void;
}

declare global {
  // eslint-disable-next-line no-var
  var Module: EmscriptenModule;
}
