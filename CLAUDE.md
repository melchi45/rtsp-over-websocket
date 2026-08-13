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
npm run stop:server
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
- **`src/player/network/http/SunapiManager.live.test.ts`** is a separate, deliberately-skipped-by-default live test
  against a real camera — unrelated to the `legacy-player` submodule gap above. It only runs (and only fails loudly,
  demanding `RTSP_LIVE_TEST_HOSTNAME`/`_USERNAME`/`_PASSWORD`) when `RUN_LIVE_DEVICE_TEST=1` is explicitly set; leave
  it alone otherwise. See the README's "Live-device smoke test" section.
- **AV1 *output* sessions need ffmpeg 9+ and `-strict experimental` — both are required, neither alone is enough.**
  ffmpeg 4.4.2 (Ubuntu 22.04 apt) and 7.1.1 (`ppa:ubuntuhandbook1/ffmpeg7`) fail identically (`Server returned 400
  Bad Request`; MediaMTX logs `invalid SDP: media 1 is invalid: clock rate not found`) because ffmpeg's RTP muxer
  has no `a=rtpmap` entry for AV1 at all in those versions (confirmed via `strings libavformat.so.* | grep rtpmap`).
  ffmpeg 9.0 (`ppa:ubuntuhandbook1/ffmpeg9`) *does* have the entry (exact version it landed in is unconfirmed —
  ffmpeg 8 untested) but the muxer still marks AV1 payloading experimental, so it also needs `-strict experimental`
  (same as VP9) — without that flag it fails differently (`Packetizing AV1 is experimental ... Could not write
  header ... Experimental feature`). `transcodeSession.ts`'s `videoEncoderArgs` AV1 branch passes this flag; confirm
  it's still there if AV1 sessions start failing again. Confirmed live end-to-end on ffmpeg 9.0: session reaches
  `status: "live"` and publishes real AV1 frames to MediaMTX. See `README.md`'s "External tools" section for the
  full investigation history (including two earlier wrong guesses — that ffmpeg 6.0+ would fix it, then that no
  ffmpeg version could).

## `docs/player/` — per-class reference docs (read before *and* update after touching `src/player`)

`docs/player/` (not `src/player/docs/` — that path doesn't exist) is a deep, per-class reference
for every subsystem under `src/player`: for each class, its Structure, Method Analysis, real
call-stack traces, RFC/standard references, and Relations & Data Flow. Start at
[docs/player/README.md](docs/player/README.md) for the file index and the RFC/standard map.

- **Before changing any `src/player` class**, check whether it's documented in `docs/player/` and
  read that section first — it records intentional legacy quirks (bit-mask differences between
  near-identical classes, dead-looking state that's actually load-bearing, etc.) that look like
  bugs but aren't; see also this file's "Conventions" note below on not "fixing" documented
  quirks.
- **After changing any `src/player` class** (new class, changed method behavior, new
  RFC/standard dependency, new codec, etc.), update the matching `docs/player/*.md` section in the
  same change — keep Structure/Method Analysis/RFC references/diagrams in sync, not just the code.
  Also update `src/player/README.md`'s class-relationship diagrams if inheritance/composition
  changed, and this repo's root `MEMORY.md` if the change is a non-obvious decision worth
  preserving.
- If a new class doesn't fit neatly under an existing `docs/player/*.md` file's subsystem, add a
  new section to the closest-matching file rather than leaving it undocumented.

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
