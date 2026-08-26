---
name: run-demo-server
description: Build, start, verify, and stop this repo's RTSP-over-WebSocket demo server (src/server) and player demo page. Use when asked to run, start, test, or screenshot the demo, or to confirm a src/player or src/server change works end to end.
---

# Running the RTSP-over-WebSocket demo

## Prerequisites

- Node.js 20+ on `PATH`. If the system default `node` is older (e.g. v12), `tsc`/`vite` fail with syntax errors on
  modern operators like `??` inside `node_modules` — get a current Node ahead of it on `PATH` rather than debugging
  that as an app bug.
- If any `node_modules/.bin/*` tool fails with `Cannot find module '.../node_modules/.bin/dist/....js'` (a path
  pointing *into* `.bin/`), that tool's shim is a plain file copy instead of a symlink. Fix with:
  ```bash
  ln -sf ../<package>/<real-bin-path-from-package.json's-"bin"-field> node_modules/.bin/<name>
  ```
- For the demo server to actually reach a `live` session (not just start): `ffmpeg`, `yt-dlp`, and `MediaMTX` must
  be installed and MediaMTX running — see the README's "External tools" section for install commands. Without
  them the server still starts and serves the REST API/demo page fine; only session creation fails.
- Most modern YouTube videos additionally need a JS runtime (`deno`) and a reachable PO Token provider
  (`bgutil-ytdlp-pot-provider`) for `yt-dlp` to actually download (not just probe) without a `403` — neither
  alone is enough. `npm run start:server*` already runs `scripts/ensure-bgutil-pot-provider.js` for you (same
  leave-alone-if-reachable shape as `ensure-mediamtx.js`), but that script only *starts* an already-built
  provider — first-time setup (git clone + Node **>=22** build + yt-dlp plugin zip) is manual, see the README's
  "External tools" section. Without it, sessions for videos that need it fail with `ffmpeg exited with code 183`
  even though `GET /api/youtube/probe` succeeded — see `CLAUDE.md`'s "Environment gotchas" for the full symptom
  and root cause before assuming a session failure is an app bug.

## Build

```bash
npm run build:player   # tsc + vite build -> dist/player/*.js, copies src/index.html -> dist/index.html
npm run build:server   # tsc -> dist/server/*.js
```

## Run (background)

```bash
npm run start:server:http &> /tmp/rtsp-ws-server.log &
for i in $(seq 1 20); do curl -sf http://127.0.0.1:4000/health && break; sleep 1; done
```

`start:server` (no suffix) prompts interactively for http/https/both when run in a real terminal; use
`start:server:http` or `start:server:https` (or set `RTSP_WS_PROTOCOL=http|https|both`) for non-interactive/background
runs so it never blocks waiting on stdin.

## Verify

```bash
curl -s http://127.0.0.1:4000/health          # {"ok":true}
curl -s http://127.0.0.1:4000/                 # demo page HTML (dist/index.html)
curl -s http://127.0.0.1:4000/api/capabilities # ffmpeg codec support
```

To exercise a full session (needs ffmpeg/yt-dlp/MediaMTX running):

```bash
curl -s -X POST http://127.0.0.1:4000/api/sessions -H "Content-Type: application/json" -d '{
  "youtubeUrl":"https://www.youtube.com/watch?v=fZa5SwVMnGg",
  "resolutionHeight":480,"videoCodec":"H264","audioCodec":"AAC","audioBitrateKbps":128,
  "username":"tester","password":"testpass123"
}'
# poll GET /api/sessions/<id> until status is "live" (or "failed", with an .error message)
```

## Stop

```bash
npm run stop:server
```

Kills whatever is listening on the configured HTTP/HTTPS ports (respects `RTSP_WS_HTTP_PORT`/`RTSP_WS_HTTPS_PORT`
overrides), and reports clearly whether it stopped something or found nothing running. Also stops a
`bgutil-ytdlp-pot-provider` instance this repo's own `ensure-bgutil-pot-provider.js` started (pid-tracked, same
as MediaMTX) — it leaves alone one that was already running before `start:server*` and not started by this repo.

## Tests

```bash
npm run test:player
```

Most failures in a fresh checkout are `ENOENT` on `legacy-player/...` — that's the legacy-parity test submodule not
being checked out, not a real regression. Only treat a failure as a real problem if its error is something other
than that `ENOENT`.

`SunapiManager.live.test.ts` is unrelated and always skipped in this run — it only activates with
`RUN_LIVE_DEVICE_TEST=1` set (a manual test against a real camera; see the README).
