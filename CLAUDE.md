# CLAUDE.md

Guidance for Claude Code (or any agent) working in this repository.

## What this is

An RTSP-over-WebSocket player (`<rtsp-over-websocket>` custom element, TypeScript/ESM, built with Vite) plus a demo
server (`src/server`) that transcodes a YouTube video to RTSP and bridges it back out over the same WebSocket
protocol, so the player can be exercised without a real camera. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for
the full structure/data-flow writeup and [README.md](README.md) for build/run instructions.

## Build & run

```
npm run build:player          # tsc + vite build -> dist/player/*.js, copies src/index.html -> dist/index.html
npm run build:server          # tsc -> dist/server/*.js
npm run start:server[:http|:https]
npm run stop
npm run test:player            # vitest run
```

`src/index.html` is the source of the demo page; never edit `dist/index.html` directly — it's overwritten by
`npm run build:demo` (part of `build:player`).

## Environment gotchas (read before debugging a "broken" build)

- **`node_modules/.bin/*` shims in this environment may be plain file copies instead of symlinks**, which breaks
  any tool whose entry script uses a relative `require`/`import` to a sibling file (this has hit `tsc`, `vite`, and
  `vitest` in this repo's history). Symptom: `Cannot find module '.../node_modules/.bin/dist/....js'` or similar
  path-shaped errors pointing *into* `.bin/`. Fix: `ln -sf ../<pkg>/<real-bin-path> node_modules/.bin/<name>` — check
  the package's own `package.json` `"bin"` field for the real relative path.
- **The system default `node` may be too old** (e.g. v12) to run this project's `tsc`/`vite` (which need modern
  syntax like `??`). If `tsc -b` fails with a `SyntaxError` on `??` inside `node_modules`, that's the cause — get a
  current Node (20+) on `PATH` ahead of the system one.
- **`src/server` needs ffmpeg, yt-dlp, and MediaMTX** to actually reach a `live` session — see the README's
  "External tools" section. Without them the server still starts and serves the REST API/demo page fine; only
  session creation fails (with a clear error, not a crash).
- **`src/player`'s parity tests need a `legacy-player` git submodule** (the original legacy source) that isn't
  always checked out. Failures there are `ENOENT`, not a real regression — check the error text before assuming a
  change broke something.

## Conventions

- **No old-brand naming anywhere** — file names, identifiers, comments, docs, and test fixture strings have all
  been fully rebranded to RTSP-over-WebSocket naming, including references into the (currently absent) legacy
  submodule's file/export names. Don't reintroduce the old naming in new code; see `MEMORY.md` if you need the
  history of what changed and why.
- **Comments and docs are English.** Don't add Korean (or other non-English) comments/docs going forward.
- **`dist/` is pure build output** — nothing under it is hand-maintained; don't edit files there directly (see
  `.gitignore`).
- Prefer small, targeted commits/edits — this is a large, long-lived codebase with a lot of intentionally-preserved
  legacy behavior; don't "clean up" quirks documented as deliberate without checking whether a test depends on them.
