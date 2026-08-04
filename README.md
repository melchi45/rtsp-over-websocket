[![Hanwha Vision License](https://img.shields.io/badge/license-Hanwha%20Vision%20Software%20License%201.0-blue.svg?style=flat)](LICENSE.txt)

# RTSP over WebSocket

A TypeScript/ESM player for the `<rtsp-over-websocket>` custom element, plus a small demo server that transcodes a
YouTube source to RTSP and bridges it over WebSocket so the player can consume it in a browser.

## Repository layout

```
src/player/    Player library (TypeScript, built with Vite) — the <rtsp-over-websocket> custom element
                and its supporting network/media/decoder/worker code.
src/server/    Demo server: REST API + RTSP-over-WebSocket bridge (YouTube -> ffmpeg -> MediaMTX -> RTSP -> WS).
src/index.html Vanilla-JS demo page (Player / Server / Test tabs) — built into dist/index.html.
scripts/       Standalone helper scripts (static file server, stop-server).
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for a deeper look at the structure, data flow, and diagrams.

## Pipeline: YouTube → ffmpeg → MediaMTX → Player

`src/server` exists so the player can be exercised without a real RTSP camera. It turns a YouTube URL into a live
RTSP source and bridges that back out over the same RTSP-over-WebSocket wire protocol a real camera would speak:

```
YouTube URL
   │  yt-dlp (download, stdout pipe: video+audio, DASH-muxed)
   ▼
yt-dlp stdout ──pipe──▶ ffmpeg (transcode to the requested video/audio codec + resolution)
   │  ffmpeg -f rtsp (TCP), rtsp://127.0.0.1:8554/<sessionId>
   ▼
MediaMTX (RTSP server, :8554 publish / :8554 read, :9997 API)
   │  RTSP (TCP), relayed 1:1 by src/server's own bridge
   ▼
src/server/rtspOverWebSocket/server.ts (WS ⇄ RTSP bridge, digest auth, keyframe gating)
   │  RTSP-over-WebSocket (ws:// or wss://, interleaved framing, RFC 7826 §10.12)
   ▼
<rtsp-over-websocket> custom element (src/player) — decode + render in the browser
```

Each stage is a separate OS process/service `src/server` coordinates but does not itself implement: `yt-dlp` and
`ffmpeg` are spawned per session (`services/transcodeSession.ts`), MediaMTX is a standalone binary `src/server`
only connects to (never spawns — see "External tools required by src/server" below), and the bridge is the one
piece of custom RTSP/WebSocket protocol code in this repo (`src/server/rtspOverWebSocket/`). The player at the far
end doesn't know or care that the "camera" it's talking to is actually this pipeline — it speaks the identical
RTSP-over-WebSocket protocol it would use against a real device.

## Server ↔ Player: live-session flow

End-to-end walkthrough of what happens between the demo page's Server and Player tabs, in order:

1. **Probe** — `GET /api/youtube/probe?url=...` runs `yt-dlp -j` against the URL and returns title, duration, and
   the resolutions/codecs actually available in the source.
2. **Create session** — `POST /api/sessions` (video/audio codec, resolution, audio bitrate, RTSP-over-WebSocket
   username/password, optional channel) validates the request, assigns a channel if none was given, and returns
   `201` with the new session (`status: "starting"`) immediately — `yt-dlp`/`ffmpeg` are then spawned
   asynchronously in the background.
3. **Transcode reaches MediaMTX** — `yt-dlp`'s stdout is piped directly into `ffmpeg`'s stdin; `ffmpeg` encodes to
   the requested codec/resolution and publishes to `rtsp://127.0.0.1:8554/<sessionId>` on MediaMTX. The first
   `frame=` line in `ffmpeg`'s stderr flips the session to `status: "live"`; no output within 20s (or a process
   exit/crash) flips it to `"failed"` instead.
4. **Player connects** — the `<rtsp-over-websocket>` element opens `ws(s)://<host>:<port>/StreamingServer` and
   sends an RTSP `DESCRIBE` whose URI embeds the channel number (`channel` attribute, 1-based in markup, 0-based on
   the wire). The bridge reads that channel, looks up the matching session, and challenges with RTSP Digest
   (`401` + nonce) using **that session's own username/password** — not real camera credentials.
5. **Relay + keyframe gate** — once authenticated, the bridge opens its own RTSP/TCP connection to MediaMTX and
   relays `DESCRIBE`/`SETUP`/`PLAY` and the resulting interleaved RTP/RTCP frames 1:1 back over the WebSocket. For
   H.264/H.265 video it also holds back non-keyframe slices until the first IDR (or a 4s timeout) so a viewer
   joining mid-GOP doesn't try to decode without SPS/PPS.
6. **Playback** — the player demuxes interleaved frames by RTP payload type into per-codec sessions, decodes, and
   renders to canvas/video — the same code path as a real camera stream (see
   [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)'s "Playing a stream" sequence diagram).
7. **Teardown** — `DELETE /api/sessions/:id` stops `ffmpeg`/`yt-dlp` and removes the session; an already-
   `stopped`/`failed` session doesn't block its channel from being reused by a later `POST /api/sessions`, but a
   `starting`/`live` one does (`409 Conflict`) until stopped or reused explicitly.

See [docs/DESIGN.md](docs/DESIGN.md) for the underlying state machines (session status, keyframe gate) and full
sequence diagrams.

## Further documentation

| Doc | Covers |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Repository structure, module layering, high-level data-flow diagrams |
| [docs/MRD.md](docs/MRD.md) | Why this project exists — problem statement, target use cases, goals |
| [docs/PRD.md](docs/PRD.md) | Product-level requirements for the Player and the demo Server |
| [docs/SRS.md](docs/SRS.md) | Detailed functional/non-functional requirements, REST + WebSocket protocol contracts |
| [docs/DESIGN.md](docs/DESIGN.md) | Implementation-level design: state machines, sequence diagrams, module responsibilities |
| [docs/TC.md](docs/TC.md) | Test case catalog for the Player and Server, mapped to SRS requirement IDs |
| [docs/test-script.md](docs/test-script.md) | Step-by-step manual/automated procedures for executing the test cases |

## Building

```
npm install
npm run build:player   # tsc + vite build -> dist/player/*.js, and copies src/index.html -> dist/index.html
npm run build:server   # tsc -> dist/server/*.js
```

## Running the demo server

```
npm run start:server         # builds src/server, then starts it (prompts for http/https/both if run in a real terminal)
npm run start:server:http    # http only (REST + ws://.../StreamingServer on port 4000)
npm run start:server:https   # https only (REST + wss://.../StreamingServer on port 4001)
npm run stop:server          # stops whatever is listening on those ports
```

Once running, open `http://localhost:4000/` (or `https://localhost:4001/`) — the server serves the demo page
directly. The Player tab connects to any `<rtsp-over-websocket>`-compatible device; the Server tab drives the
YouTube-transcode demo pipeline end to end.

`npm run start:player` (`scripts/serve-dist.js`) is an optional standalone static file server for `dist/` on its own
ports (4010/4011) — not required now that `src/server` serves the demo page itself.

### External tools required by src/server

The demo server does not install or run ffmpeg/yt-dlp/MediaMTX itself — all three must already be installed and
running for a session to make it all the way to `live`. (Ubuntu/Debian, sudo required.)

**ffmpeg** — used for transcoding.

```
sudo apt update
sudo apt install -y ffmpeg
```

**yt-dlp** — used for probing/downloading the YouTube source.

- Method A — apt (simple): `sudo apt install -y yt-dlp`. Distro packages are often years out of date, and since
  YouTube changes its internal API frequently, an old build can break outright (`Precondition check failed`,
  `Unable to extract uploader id`, etc.). Check the version with `yt-dlp --version` after installing; if it's old,
  use Method B, or update via `sudo apt install -y yt-dlp` again / `pip install -U yt-dlp`.
- Method B — official standalone binary (always current, recommended):
  ```
  sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
  sudo chmod a+rx /usr/local/bin/yt-dlp
  ```
  `/usr/local/bin` takes PATH priority over `/usr/bin`, so this binary is picked up first even if an older apt
  version is also installed. Update later with `sudo yt-dlp -U`.

**MediaMTX** — the RTSP server `src/server` publishes transcoded video to. No apt package exists, so fetch a GitHub
release binary directly (swap in the latest version from the [releases page](https://github.com/bluenviron/mediamtx/releases)):

```
sudo curl -L -o /tmp/mediamtx.tar.gz https://github.com/bluenviron/mediamtx/releases/download/v1.19.3/mediamtx_v1.19.3_linux_amd64.tar.gz
sudo mkdir -p /opt/mediamtx
sudo tar -xzf /tmp/mediamtx.tar.gz -C /opt/mediamtx
sudo ln -sf /opt/mediamtx/mediamtx /usr/local/bin/mediamtx
```

Run it (default RTSP port 8554 / API port 9997 — the bundled `mediamtx.yml`'s `paths: all_others:` catch-all already
satisfies the "allow publishing to any path" condition `src/server` needs):

```
mediamtx /opt/mediamtx/mediamtx.yml
```

(Installing needs sudo; running it doesn't — 8554/9997 are both unprivileged ports.)

`src/server` tries to connect to `127.0.0.1:8554` at startup to check whether MediaMTX is up; if it isn't, it logs a
warning and keeps running anyway — sessions can still be created, but they'll fail at the final publish step
(`ffmpeg` → MediaMTX) with `Connection refused`.

## Testing

```
npm run test:player         # vitest run (src/player)
npm run test:player:watch   # vitest watch mode
```

Most of `src/player`'s test suite consists of parity tests that diff the new TypeScript port against the original
legacy player's source, loaded from a `legacy-player` git submodule at the repo root. That submodule isn't checked
out in every environment — tests that depend on it will fail with `ENOENT` until it's present.

## Milestones

- **Upgrade `three` past `0.84.0` (pending).** `three@0.84.0` has a known high-severity denial-of-service advisory,
  but it's pinned to that exact version deliberately: `src/player/util/FishEye3D.ts` and `FishEye3DMulti.ts` (the
  fisheye camera dewarp rendering) depend on APIs removed from three.js in later releases — `THREE.Geometry`,
  `THREE.Face3`, `THREE.AxisHelper`, `THREE.RGBFormat`, `BufferGeometry.fromGeometry`, `THREE.Math.degToRad`.
  Upgrading requires rewriting that mesh-construction/rendering code against modern `BufferGeometry`-based APIs, and
  there's no visual-regression test for the fisheye dewarp output — only structural/unit tests — so the rendered
  result can't be verified automatically. On hold until that rewrite can be checked against a real fisheye camera
  feed in a browser.

![license-image](https://img.shields.io/badge/license-HanwhaVision%201.0-blue.svg?style=flat) [license-url](LICENSE.txt)
