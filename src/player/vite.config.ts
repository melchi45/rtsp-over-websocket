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
  // vendor/runtime/ (ffmpeg.js/.wasm, ffmpegAAC.transcoder.js/.wasm,
  // minizip-asm.js — the classic-script Emscripten/UMD bundles the worker
  // entries below `importScripts()`/`fetch()` at runtime) is copied
  // *verbatim* into dist/player/ root via publicDir instead of going
  // through Vite's normal asset pipeline — see the `worker:` block below
  // for why that distinction matters. Only the actual runtime-loaded files
  // live under runtime/; vendor/'s .d.ts files and mp4Generator.js (a
  // normally `import`ed, directly-bundled module, not one of these
  // classic-script loads) stay out of it deliberately, so dist/player/
  // doesn't ship type declarations or test files alongside the real build
  // output.
  publicDir: resolve(__dirname, 'vendor/runtime'),
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
  // worker bundle would break that.
  //
  // Those vendor files are referenced via `new URL('../xxx', import.meta.url)`
  // (one level up from the worker chunk's own `dist/player/assets/` — see
  // `publicDir` above for where `../xxx` actually resolves to). This
  // deliberately does NOT match an existing file relative to the *source*
  // worker/**/*.ts location (there is no worker/xxx or worker/videoDecoder/
  // xxx), so Vite's static analysis can't find anything to inline: it
  // leaves the `new URL(...)` call as plain runtime code instead (with a
  // "doesn't exist at build time" build-log note, not an error), and it's
  // resolved for real once the browser actually runs it, against the
  // publicDir copy sitting one directory up from `assets/`.
  //
  // This used to instead read `new URL('../../vendor/xxx', import.meta.url)`
  // — a path Vite's static analysis *could* resolve — which is exactly the
  // problem: Vite's default behavior for an asset reference resolved from
  // inside a worker chunk is to inline it as a base64 `data:` URL directly
  // in that chunk, regardless of `build.assetsInlineLimit` (confirmed
  // empirically against Vite 6.4 — that option has no effect here). That's
  // fine in an unrestricted page, but a real consumer embedding this player
  // in a Chrome extension hit it for real: the extension's
  // `script-src 'self' 'wasm-unsafe-eval'` CSP (MV3's default couldn't be
  // loosened to allow arbitrary `data:` scripts) flatly rejected the H264
  // decoder worker's `importScripts('data:text/javascript;base64,...')`
  // call, breaking canvas-tag playback entirely. A same-origin
  // `chrome-extension://<id>/ffmpeg.js`-style URL (what this now produces)
  // satisfies `'self'` with no CSP changes needed on the consumer's side.
  worker: {
    format: 'iife'
  }
});
