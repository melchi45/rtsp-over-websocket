/**
 * Type declarations for the vendored minizip-asm.js UMD bundle
 * (the legacy player’s Worker/Backup/minizip-asm.js, copied verbatim — not
 * rewritten, matching this migration's treatment of ffmpeg.js/ffmpegAAC.js/
 * mp4Generator.js). Exposes only the narrow surface zipWorker.ts actually
 * uses; the vendor bundle's own internal Emscripten/webpack API is not
 * declared here.
 *
 * Loaded via `importScripts()` inside the zip Worker (see zipWorker.ts),
 * not via ESM `import` — the bundle's outermost UMD factory relies on
 * classic-script top-level `this` resolving to the Worker global scope,
 * which only holds true when it runs as its own `importScripts`-loaded
 * script, not when bundled into an ES module graph.
 */
export interface MinizipAppendOptions {
  compressLevel?: number;
  password?: string;
}

export interface MinizipInstance {
  append(name: string, data: ArrayBuffer, options?: MinizipAppendOptions): void;
  zip(): Uint8Array;
}

export interface MinizipConstructor {
  new (zipfile?: ArrayBuffer): MinizipInstance;
}

declare global {
  // eslint-disable-next-line no-var
  var Minizip: MinizipConstructor;
}
