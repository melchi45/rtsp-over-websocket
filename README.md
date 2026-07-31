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
npm run stop                 # stops whatever is listening on those ports
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

![license-image](https://img.shields.io/badge/license-HanwhaVision%201.0-blue.svg?style=flat) [license-url](LICENSE.txt)
