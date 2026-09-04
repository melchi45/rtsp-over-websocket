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

The `yt-dlp` stage isn't a single hop, either — for most modern videos it also needs a `deno` JS runtime (solves
YouTube's signature/"n" challenge) and a reachable PO Token provider (`bgutil-ytdlp-pot-provider`), both external
to this pipeline diagram — see "External tools required by src/server" below for setup, and
[docs/DESIGN.md](docs/DESIGN.md#13-transcode-pipeline-transcodesessionts) for the full pre-flight-check and
PO-Token-request sequence diagram.

## Server ↔ Player: live-session flow

End-to-end walkthrough of what happens between the demo page's Server and Player tabs, in order:

1. **Probe** — `GET /api/youtube/probe?url=...` runs `yt-dlp -j` against the URL and returns title, duration, and
   the resolutions/codecs actually available in the source.
2. **Create session** — `POST /api/sessions` (video/audio codec, resolution, audio bitrate, RTSP-over-WebSocket
   username/password, optional channel) validates the request, assigns a channel if none was given, and returns
   `201` with the new session (`status: "starting"`) immediately — `yt-dlp`/`ffmpeg` are then spawned
   asynchronously in the background. `username`/`password` may both be left as empty strings to start the session
   with **no RTSP Digest auth at all** — the demo page's Server tab exposes this as the "Use" toggle next to
   Session Username (on by default); one empty and the other non-empty is rejected. There is no partial-auth state.
3. **Transcode reaches MediaMTX** — `yt-dlp`'s stdout is piped directly into `ffmpeg`'s stdin; `ffmpeg` encodes to
   the requested codec/resolution and publishes to `rtsp://127.0.0.1:8554/<sessionId>` on MediaMTX. The first
   `frame=` line in `ffmpeg`'s stderr flips the session to `status: "live"`; no output within 20s (or a process
   exit/crash) flips it to `"failed"` instead.
4. **Player connects** — the `<rtsp-over-websocket>` element opens `ws(s)://<host>:<port>/StreamingServer` and
   sends an RTSP `DESCRIBE` whose URI embeds the channel number (`channel` attribute, 1-based in markup, 0-based on
   the wire). The bridge reads that channel, looks up the matching session, and challenges with RTSP Digest
   (`401` + nonce) using **that session's own username/password** — not real camera credentials — unless the
   session was created with empty username/password, in which case the bridge skips the challenge entirely and
   relays from the first request. The player itself never needs `username`/`password` attributes set for this: it
   only ever answers a challenge reactively (RtspClient's digest header stays empty until a `401` asks for one), so
   a session with no auth "just connects" with those attributes left unset.
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

## ONVIF metadata overlay

When a camera sends ONVIF `VideoAnalytics` metadata (motion/object-detection events) over its RTP `application`
media line, the player can optionally draw it on top of the video: a bounding box per detected object, colored by
event type, labeled with its ObjectId/type/Likelihood at the box's top edge. It's off by default and only appears
in the right-click context menu once the stream has actually sent at least one such frame — an "ONVIF Event"
toggle switch (styled to match `wisenet-camera-discovery`'s SUNAPI On/Off toggle) shows/hides it. See
[docs/player/10-onvif-metadata-overlay.md](docs/player/10-onvif-metadata-overlay.md) for the full design (including
the coordinate-mapping math) and [docs/SRS.md](docs/SRS.md) §4.10 for the requirements.

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

## Installing this package in another project

This package is published as **`@melchi45/rtsp-over-websocket`** to **GitHub
Packages** (`.github/workflows/publish-player.yml`), not the public npm
registry — GitHub Packages requires an authenticated token for `npm
install` regardless of whether the package/repo is public or private, so
every consumer needs a token even just to install:

1. Create a [personal access token](https://github.com/settings/tokens) with
   `read:packages` scope.
2. In the consuming project, add a `.npmrc` (don't commit the token itself —
   use an env var):
   ```
   @melchi45:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${GH_PACKAGES_TOKEN}
   ```
3. `npm install @melchi45/rtsp-over-websocket`

If `npm install` fails with `EALLOWREMOTE`, the `.npmrc` above is either
missing or wasn't in place before you ran `npm install` — npm 11+'s
`allow-remote: none` default blocks the dependency's tarball fetch unless
the `@melchi45:registry` line is configured first, since without it npm
compares the tarball's host (`npm.pkg.github.com`) against the default
registry (`registry.npmjs.org`) instead.

## Building

```
npm install
npm run build:player       # tsc + vite build -> dist/player/*.js, and copies src/index.html -> dist/index.html
npm run build:player:dev   # same, but unminified (--mode development) — for readable browser debugging
npm run build:server       # tsc -> dist/server/*.js
```

Both `build:player` and `build:player:dev` emit `.js.map` sourcemaps next to every chunk (including the
auto-detected Worker chunks), so the browser DevTools Sources panel shows the original `.ts` files instead of the
bundled `.js` — set breakpoints and step through TypeScript directly. `build:player`'s output is still minified
(a sourcemap is enough for DevTools to map it back); `build:player:dev` additionally skips minification, for
cases where inspecting the generated JS itself (not just the mapped-back `.ts`) needs to be readable.

## Running the demo server

```
npm run start:server         # builds src/server, then starts it (prompts for http/https/both if run in a real terminal)
npm run start:server:http    # http only (REST + ws://.../StreamingServer on port 4000)
npm run start:server:https   # https only (REST + wss://.../StreamingServer on port 4001)
npm run stop:server          # stops whatever is listening on those ports
```

Each `start:server*` script runs `scripts/ensure-mediamtx.js` first: if nothing is already reachable on
`127.0.0.1:8554`, it starts `mediamtx` (binary resolved from `MEDIAMTX_BIN`, PATH, or `/opt/mediamtx/mediamtx`;
config from `MEDIAMTX_CONFIG` or `/opt/mediamtx/mediamtx.yml` if present) and records its pid, so `npm run
stop:server` can later stop that same instance. If MediaMTX is *already* reachable — started manually, or an
instance shared with something else — neither script touches its lifecycle; it's left running as-is.

`npm run start:server` (bare, no `:http`/`:https` suffix) prompts interactively — `Select which protocol(s) to
start...` — whenever it's run attached to a real terminal with no protocol specified another way. To skip that
prompt permanently: copy [.env.example](.env.example) to `.env` and set `RTSP_WS_PROTOCOL=http` (or `https`/`both`).
`.env` is loaded automatically by every `start:server*`/`stop:server` script (`scripts/loadEnv.js` for the plain
scripts, `src/server/loadEnv.ts` for the compiled server itself) — no need to `export` anything in your shell. It
also doubles as the place to override any other `src/server`/`scripts/ensure-mediamtx.js` env var (ports, TLS
paths, `MEDIAMTX_BIN`/`MEDIAMTX_CONFIG`, ...) — see `.env.example` for the full list. `.env` itself is
machine-specific and gitignored; `.env.example` stays tracked as the template.

Once running, open `http://localhost:4000/` (or `https://localhost:4001/`) — the server serves the demo page
directly. The Player tab connects to any `<rtsp-over-websocket>`-compatible device; the Server tab drives the
YouTube-transcode demo pipeline end to end.

`npm run start:player` (`scripts/serve-dist.js`) is an optional standalone static file server for `dist/` on its own
ports (4010/4011) — not required now that `src/server` serves the demo page itself.

### External tools required by src/server

The demo server does not install or run ffmpeg/yt-dlp/MediaMTX itself — all three must already be installed and
running for a session to make it all the way to `live`. (Ubuntu/Debian, sudo required.)

**ffmpeg** — used for transcoding.

- Method A — apt (simple, may be an older distro-packaged version):
  ```
  sudo apt update
  sudo apt install -y ffmpeg
  ```
- Method B — PPA (newer version, e.g. ffmpeg 9):
  ```
  sudo add-apt-repository ppa:ubuntuhandbook1/ffmpeg9
  sudo apt update
  sudo apt install -y ffmpeg
  ```
  Confirm the installed version with `ffmpeg --version` — the first line should report `ffmpeg version 9...`.

**AV1 output requires ffmpeg 9+ — earlier versions cannot do it at all, no flag works around it.**
This has flipped twice as ffmpeg's own AV1 RTP support evolved; here's the full, verified history:

1. On the Ubuntu 22.04 apt package (ffmpeg 4.4.2, 2021), an `AV1` session fails with `Could not
   write header for output file #0 ... Server returned 400 Bad Request`; MediaMTX logs `invalid
   SDP: media 1 is invalid: clock rate not found`.
2. After installing `ppa:ubuntuhandbook1/ffmpeg7` (ffmpeg **7.1.1**, 2025) — the same failure,
   verbatim, with the same MediaMTX log line.
3. Root cause at the time, found by dumping the actual SDP ffmpeg sends (`-loglevel debug`) and by
   inspecting `libavformat.so`'s own compiled `a=rtpmap:%d <CODEC>/<rate>` format-string table
   directly (`strings libavformat.so.* | grep rtpmap`): ffmpeg's RTP/RTSP muxer had entries for
   `H264`, `H265`, `VP8`, `VP9`, `JPEG`, `opus`, and a dozen others — **but none for AV1, in either
   version**. For an AV1 stream it emitted a bare `m=video 0 RTP/AVP 96` with no `a=rtpmap` line at
   all, which is invalid SDP (RFC 4566 requires a dynamic payload type to have one) and MediaMTX
   correctly rejected it.
4. After installing `ppa:ubuntuhandbook1/ffmpeg9` (ffmpeg **9.0**, 2026) and re-running the same
   `strings ... | grep rtpmap` check — `a=rtpmap:%d AV1/90000` is now present. ffmpeg implemented
   the AV1 RTP payloader somewhere between 7.1.1 and 9.0 (exact version unconfirmed — not tested
   against ffmpeg 8). Re-running an `AV1` session against 9.0 still failed at first, but with a
   *different* error: `Packetizing AV1 is experimental ... Could not write header ... Experimental
   feature` — the same "muxer marks it experimental" behavior VP9 already had (see point 5). Adding
   `-strict experimental` to the AV1 branch of `services/transcodeSession.ts`'s `videoEncoderArgs`
   (previously only the VP9 branch had it) fixed it: confirmed live via the server's own REST API,
   session reached `status: "live"` and published real AV1 frames to MediaMTX.

The session correctly ends up `status: "failed"` with the underlying ffmpeg error attached when it
can't work (confirmed live on 4.4.2/7.1.1), not silently broken. **VP9 and AV1 output both work on
ffmpeg 9.0** — both need `-strict experimental` because ffmpeg's RTP muxer marks both payloaders
experimental (RFC-draft, never finalized as RFCs) but does have real rtpmap entries for them.

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

**Most modern YouTube videos need two more pieces beyond `yt-dlp` itself to actually download (not just probe)
without a `403` — a JS runtime, and a PO Token provider. Both are required; neither alone is enough.** `GET
/api/youtube/probe` (`yt-dlp -j`, metadata only) can succeed and list correct resolutions while the real download
still fails, so a successful probe does **not** mean a session will reach `live`. Symptom: session fails with
`ffmpeg exited with code 183: ... Invalid data found when processing input`, or (in the server's own log lines,
`[yt-dlp][<sessionId>] ...`) `ERROR: ffmpeg exited with code 8` wrapping a `Server returned 403 Forbidden` on a
`googlevideo.com` URL.

1. **A JS runtime (`deno`)** — solves YouTube's signature/"n" challenge. Install user-locally, no sudo needed:
   ```
   curl -fsSL https://deno.land/install.sh | sh   # installs to ~/.deno/bin
   ```
   `transcodeSession.ts` finds it at that exact path automatically (prepended to the `yt-dlp` child process's own
   `PATH`, independent of whatever shell started `src/server` — no need to add it to your own `~/.bashrc`).

2. **A PO Token provider** — [bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)
   (see also yt-dlp's own [PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)). Without one,
   YouTube 403s essentially every DASH format for a typical video regardless of JS runtime — confirmed live
   (2026-08-25): the identical `403` reproduced with `deno` present and actively solving the challenge
   (`[jsc:deno] Solving JS challenges using deno` in the log right before the `403`). Requires Node.js **>=22**
   (a separate requirement from this repo's own pinned Node 20 — install via `nvm install 22` if you don't
   already have one) and `git`:
   ```
   git clone --single-branch --branch 1.3.2 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git ~/bgutil-ytdlp-pot-provider
   cd ~/bgutil-ytdlp-pot-provider/server
   ~/.nvm/versions/node/v22.*/bin/npm ci    # or: npm ci, if node --version is already >=22
   ~/.nvm/versions/node/v22.*/bin/npx tsc
   ```
   Then install the yt-dlp plugin (the "Manual" method — this repo's `yt-dlp` is the standalone binary, not a
   `pip`/`pipx` install):
   ```
   mkdir -p ~/.config/yt-dlp/plugins
   curl -sL "https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/1.3.2/bgutil-ytdlp-pot-provider.zip" \
     -o ~/.config/yt-dlp/plugins/bgutil-ytdlp-pot-provider.zip
   ```
   `scripts/ensure-bgutil-pot-provider.js` (wired into `npm run start:server*`) starts the built server
   automatically if nothing is already reachable on its port (default `127.0.0.1:4416`) — same
   leave-it-alone-if-already-running / pid-tracked-so-`stop:server`-can-clean-up-after-itself shape as
   `ensure-mediamtx.js`. It auto-detects a Node >=22 under `~/.nvm/versions/node/*` (or set
   `BGUTIL_POT_PROVIDER_NODE_BIN` explicitly) and the provider's build dir at `~/bgutil-ytdlp-pot-provider` (or
   set `BGUTIL_POT_PROVIDER_DIR`) — see `.env.example` for all the override vars, including
   `BGUTIL_POT_PROVIDER_CA_CERTS` for the next point.

   **Behind a TLS-intercepting proxy** (confirmed on this dev box — a corporate root CA in
   `/etc/ssl/certs/ca-certificates.crt`), the provider's own outbound HTTPS (BotGuard challenge fetch from
   `google.com`) fails with `self-signed certificate in certificate chain` unless it's told to trust that CA —
   `ensure-bgutil-pot-provider.js` auto-detects `/etc/ssl/certs/ca-certificates.crt` and sets
   `NODE_EXTRA_CA_CERTS` for it if present; override via `BGUTIL_POT_PROVIDER_CA_CERTS` if your CA bundle lives
   elsewhere. `npm ci`'s own `canvas` native build (a real dependency, not optional) hits the identical error for
   the same reason during setup — export `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt` before running
   `npm ci` above if you hit `SELF_SIGNED_CERT_IN_CHAIN` there too.

**With both set up**, `transcodeSession.ts` forces `--extractor-args youtube:player_client=mweb` (confirmed live
to reliably expose the full DASH resolution ladder and actually download, unlike `yt-dlp`'s own default client
mix, which can end up serving an `android_vr`-origin URL that `403`s regardless of PO Token/JS runtime) — **but
only when both a JS runtime and a reachable PO Token provider are detected at session-start time**; forcing
`mweb` without both is confirmed *worse* than not forcing anything (see `CLAUDE.md`'s "Environment gotchas" and
`MEMORY.md` for the full investigation, including two earlier explanations — no JS runtime, then no PO Token —
that were each necessary but not sufficient alone). Missing either piece just means sessions fall back to
`yt-dlp`'s unforced default, exactly the pre-existing behavior — nothing breaks, some videos just won't reach
`live`. This is an active YouTube-vs-`yt-dlp` arms race; treat any specific client/format name here as a
point-in-time snapshot, not a permanent fact — re-verify with `yt-dlp -v -F <url>` if sessions start failing
again.

**MediaMTX** — the RTSP server `src/server` publishes transcoded video to. No apt package exists, so fetch a GitHub
release binary directly (swap in the latest version from the [releases page](https://github.com/bluenviron/mediamtx/releases)):

```
sudo curl -L -o /tmp/mediamtx.tar.gz https://github.com/bluenviron/mediamtx/releases/download/v1.19.3/mediamtx_v1.19.3_linux_amd64.tar.gz
sudo mkdir -p /opt/mediamtx
sudo tar -xzf /tmp/mediamtx.tar.gz -C /opt/mediamtx
sudo ln -sf /opt/mediamtx/mediamtx /usr/local/bin/mediamtx
```

Run it manually if you want (default RTSP port 8554 / API port 9997 — the bundled `mediamtx.yml`'s `paths:
all_others:` catch-all already satisfies the "allow publishing to any path" condition `src/server` needs):

```
mediamtx /opt/mediamtx/mediamtx.yml
```

(Installing needs sudo; running it doesn't — 8554/9997 are both unprivileged ports.) In practice you don't normally
need to run this yourself — `npm run start:server` (see above) starts one automatically via
`scripts/ensure-mediamtx.js` if nothing is already listening on 8554. `src/server` itself only *checks*
`127.0.0.1:8554` at its own startup (separately from `ensure-mediamtx.js`, which runs earlier as part of the npm
script) to log whether MediaMTX is reachable; it never spawns MediaMTX itself. If it's still not reachable at that
point — `mediamtx` missing from PATH and `/opt/mediamtx`, or it failed to start — sessions can still be created but
will fail at the final publish step (`ffmpeg` → MediaMTX) with `Connection refused`.

## Testing

```
npm run test:player         # vitest run (src/player)
npm run test:player:watch   # vitest watch mode
```

Most of `src/player`'s test suite consists of parity tests that diff the new TypeScript port against the original
legacy player's source, loaded from a `legacy-player` git submodule at the repo root. That submodule isn't checked
out in every environment — tests that depend on it will fail with `ENOENT` until it's present.

### Live-device smoke test (manual/local only)

`src/player/network/http/SunapiManager.live.test.ts` exercises `SunapiManager.init()` +
`getAttributes()` against a **real** camera/NVR on your LAN — skipped by default (not part of the
regular `npm run test:player` run) since it needs network access to a specific device and would
just fail everywhere else (CI, other machines). Opt in by copying [.env.example](.env.example) to
`.env` and filling in the `RTSP_LIVE_TEST_*` keys (`HOSTNAME`/`USERNAME`/`PASSWORD` required,
`PORT`/`PROTOCOL` optional — default `443`/`https`), or pass them as real env vars instead:

```
RUN_LIVE_DEVICE_TEST=1 RTSP_LIVE_TEST_HOSTNAME=192.168.x.x RTSP_LIVE_TEST_USERNAME=admin \
RTSP_LIVE_TEST_PASSWORD=... npx vitest run SunapiManager.live.test.ts   # from src/player
```

Never hardcode real device credentials directly in that test file — it's committed to source
control; `.env` itself is gitignored.

## Milestones

- **Upgrade `three` past `0.84.0` (pending).** `three@0.84.0` has a known high-severity denial-of-service advisory,
  but it's pinned to that exact version deliberately: `src/player/util/FishEye3D.ts` and `FishEye3DMulti.ts` (the
  fisheye camera dewarp rendering) depend on APIs removed from three.js in later releases — `THREE.Geometry`,
  `THREE.Face3`, `THREE.AxisHelper`, `THREE.RGBFormat`, `BufferGeometry.fromGeometry`, `THREE.Math.degToRad`.
  Upgrading requires rewriting that mesh-construction/rendering code against modern `BufferGeometry`-based APIs, and
  there's no visual-regression test for the fisheye dewarp output — only structural/unit tests — so the rendered
  result can't be verified automatically. On hold until that rewrite can be checked against a real fisheye camera
  feed in a browser.

See [docs/ROADMAP.md](docs/ROADMAP.md) for the full, currently-tracked milestone list (this entry plus others).

![license-image](https://img.shields.io/badge/license-HanwhaVision%201.0-blue.svg?style=flat) [license-url](LICENSE.txt)
