import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// A *third* build of react/index.ts, alongside vite.config.ts (base library)
// and vite.react.config.ts (the React/ReactDOM-bundled demo build for
// src/index.html's no-bundler <script type="module">). This one is for a
// real app that already has its own React on the page (react-wisenet-player
// being the reference case react/Player.tsx was adapted from) — react/
// react-dom are external here, not bundled in, so the consumer's own copy is
// used instead of shipping (and initializing) a second one. Exposed via
// package.json's "./react" export subpath; dist/types/react/index.d.ts is
// already produced by the ordinary `tsc -b` pass (src/player/tsconfig.json
// includes react/**/*.tsx), so this config only needs to emit JS.
export default defineConfig({
  base: './',
  build: {
    outDir: resolve(__dirname, '../../dist/react'),
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, 'react/index.ts'),
      formats: ['es'],
      fileName: () => 'index.js'
    },
    rollupOptions: {
      // 'react-dom/client' (not just 'react-dom') because react/index.ts
      // imports createRoot from that subpath — externalizing only 'react-dom'
      // left Rollup inlining a hand-rolled createRoot/hydrateRoot shim
      // (reconstructed from react-dom's __SECRET_INTERNALS_DO_NOT_USE_OR_
      // YOU_WILL_BE_FIRED, mirroring what react-dom/client's real source
      // does) that also carried in a raw, un-replaced `process.env.NODE_ENV`
      // check with no `process` global to read it from — externalizing the
      // subpath directly avoids bundling that shim at all.
      external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime']
    }
  }
});
