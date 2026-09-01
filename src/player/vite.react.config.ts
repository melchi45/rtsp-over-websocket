import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Separate build for react/index.ts's `Player`/`mountReactPlayer`, run as its
// own `vite build --config vite.react.config.ts` step (see package.json's
// build:player script) rather than folded into vite.config.ts's entry: Vite's
// lib mode rejects multiple entry points once any target format is
// 'iife'/'umd', and that config's iife output is load-bearing for its own
// legacy-<script> consumers.
//
// ESM-only, and React/ReactDOM are bundled in rather than externalized: this
// is meant to be usable from a single <script type="module"> with no import
// map or bundler — this repo's own src/index.html demo page is exactly that
// kind of consumer. A real app that already has React on the page (like
// react-wisenet-player, which react/Player.tsx was adapted from) should
// import react/index.ts's `Player` directly from source instead, so it
// shares that app's own React instance rather than bundling a second one.
// See vite.config.ts's comment on `npm run build:player:dev` / `mode`.
export default defineConfig(({ mode }) => ({
  base: './',
  // React/ReactDOM's own source checks `process.env.NODE_ENV` (e.g. to pick
  // their dev-vs-production internal build, and to gate dev-only warnings)
  // expecting a bundler to statically replace it — Vite does this
  // automatically for its normal app builds, but not for `build.lib`, so
  // without this the raw `process.env.NODE_ENV` reference survives into the
  // output and throws `ReferenceError: process is not defined` at runtime
  // (there's no Node `process` global in a browser). Also strips React's
  // dev-only warning/checking code paths as dead code, shrinking the bundle.
  define: {
    'process.env.NODE_ENV': JSON.stringify('production')
  },
  build: {
    outDir: resolve(__dirname, '../../dist/player'),
    // The main vite.config.ts build (run first in build:player) already
    // wrote rtsp-over-websocket.{esm,global}.js and the worker chunks into
    // this same outDir — clearing it here would erase them.
    emptyOutDir: false,
    // See vite.config.ts's sourcemap comment.
    sourcemap: true,
    minify: mode !== 'development',
    lib: {
      entry: resolve(__dirname, 'react/index.ts'),
      name: 'RTSPOverWebSocketReact',
      formats: ['es'],
      fileName: () => 'rtsp-over-websocket-react.esm.js'
    }
  }
}));
