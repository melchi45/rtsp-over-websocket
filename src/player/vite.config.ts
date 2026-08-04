import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Library build for the RTSP-over-WebSocket player.
// Produces two artifacts:
//   - ESM  (dist/player/rtsp-over-websocket.esm.js)    for app-react / modern consumers
//   - IIFE (dist/player/rtsp-over-websocket.global.js) for legacy <script> consumers
// (the IIFE bundle registers the <rtsp-over-websocket> custom element, see elements/RTSPOverWebSocket.ts)
//
// The react/ Player wrapper is a separate build (see vite.react.config.ts,
// run as its own `vite build` step) rather than a second entry here: Vite's
// lib mode rejects multiple entry points as soon as any target format is
// 'iife'/'umd' (single-entry-only formats), and this config's `iife` output
// is load-bearing for the legacy-<script> consumers above.
export default defineConfig({
  // Both rtsp-over-websocket.global.js and every `new Worker(new URL(...))`
  // chunk it spawns (audiotranscoderWorker, decoderWorker, zipWorker, ...)
  // must resolve correctly no matter which subpath the consuming app serves
  // dist/player/ from (site root, /player/, /rtsp-ws/, app-react/dist/, ...).
  // The default `base: '/'` bakes an origin-absolute `/assets/...` path into
  // those `new URL(...)` calls, which only resolves correctly if
  // dist/player/'s contents are deployed at the domain root — breaks under
  // any other subpath. `'./'` makes Vite emit paths relative to the
  // currently-executing script (`document.currentScript.src` in the IIFE
  // build, `import.meta.url` in the ESM build) instead.
  base: './',
  build: {
    outDir: resolve(__dirname, '../../dist/player'),
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, 'index.ts'),
      name: 'RTSPOverWebSocketLib',
      formats: ['es', 'iife'],
      fileName: (format) => (format === 'es' ? 'rtsp-over-websocket.esm.js' : 'rtsp-over-websocket.global.js')
    }
  },
  // The Worker entries (worker/**/*.ts — mjpegDepacketizeWorker, zipWorker,
  // decoderWorker, audiotranscoderWorker, backupWorker, sunapiRequestTask)
  // are not listed as explicit build inputs here: Vite auto-detects and
  // separately bundles any `new Worker(new URL(...))` call site (see
  // VideoTagPlayer.ts, CanvasTagPlayer.ts, FileMaker.ts, BackupProvider.ts,
  // MjpegSession.ts, SunapiRestClient.ts), so no manual entry wiring is
  // needed.
  //
  // `format: 'iife'` is Vite's own default and is pinned explicitly here
  // (rather than left implicit) because several of those worker entries rely
  // on it: they load large vendored Emscripten/UMD bundles (ffmpeg.js,
  // ffmpegAAC.transcoder.js, minizip-asm.js) via classic-script
  // `importScripts()` (see e.g. zipWorker.ts / AssemblyDecoder.ts's doc
  // comments), which only resolves `this`/globals the way those vendor
  // bundles expect under a classic (non-ESM) worker script — an `'es'`-format
  // worker bundle would break that. Those vendor files are referenced via
  // `new URL('../../vendor/xxx', import.meta.url)`, which Vite inlines as
  // base64 `data:` URLs directly in the worker chunk (Vite's default for
  // assets referenced from within a worker), so they need no separate
  // copy/deploy step either.
  worker: {
    format: 'iife'
  }
});
