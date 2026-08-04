# Product Requirements Document (PRD)

Product-level requirements for the two products in this repository: the **Player** (`src/player`, the
`<rtsp-over-websocket>` custom element) and the **Server** (`src/server`, the YouTube-transcode demo/bridge). See
[MRD.md](MRD.md) for the motivating problem and [SRS.md](SRS.md) for detailed, testable requirements.

## 1. Player (`src/player`)

### 1.1 Overview

A single custom element, `<rtsp-over-websocket>`, that connects to an RTSP-over-WebSocket source (a real camera/NVR
or `src/server`'s bridge), and plays live or recorded video/audio in-browser with no plugin and no framework
dependency.

### 1.2 Users

- Frontend engineers embedding the element directly in HTML/JS/any framework.
- The legacy host app, via the `src/player/legacyHostInterface` compatibility layer (not part of the
  neutral ESM API — imported from its own subpath only).

### 1.3 Functional requirements

| # | Requirement |
| --- | --- |
| P-1 | Connect to an RTSP-over-WebSocket endpoint identified by `hostname`, `port`, `channel`, `username`/`password` (or an attached `sunapiClient`), and `device` (`camera` \| `nvr`-style deployments) attributes. |
| P-2 | Support four play types: `live`, `playback`, `backup`, `instantplayback` (`mode` attribute / `playType` property), switchable at runtime. |
| P-3 | Support the core playback command surface: `play()`, `pause()`, `resume()`, `stop()`, `speed()` (variable-rate forward/reverse playback per `RTSPOverWebSocketPlaySpeed`, from 0.125x to 256x and the seek-direction equivalents), `forward()`/`backward()` (playback-mode step navigation), `seeking()`. |
| P-4 | Decode and render H.264, H.265, and MJPEG video, and AAC/G.711/G.726 audio (plus two-way talk audio), matching what a real camera/NVR can produce. |
| P-5 | Support two rendering backends selectable via the `type`/`mode` attribute: `canvas` (WebGL/2D canvas decode+render) and `video` (native `<video>` element), plus `auto`. |
| P-6 | Provide audio controls: `mute()`/`unmute()`/`isMute()`, `getAudioVolume()`/`setAudioVolume()`, two-way `talk()`. |
| P-7 | Provide local recording/backup: `backup()`, `startBackup()`, `endBackup()`, producing AVI/ZIP output client-side (`src/player/backup`). |
| P-8 | Provide a still-capture command, `capture(filename?)`, saving the current frame. |
| P-9 | Emit a documented event surface (`addEventListener`/custom `dispatch`) covering state changes, errors, timestamps, resize, meta/meta-image overlays, statistics, capture, backup, and connection-attribute changes (see [SRS.md](SRS.md) §4.3 for the full list). |
| P-10 | Surface a live statistics overlay (`statistics` attribute) — bitrate, frame rate, drop count, RTP receive counters, latency — when enabled. |
| P-11 | Support optional SUNAPI (device REST API) integration via an attached `sunapiClient`, independent of the RTSP-over-WebSocket stream itself, for device capability/profile queries. |
| P-12 | Preserve every confirmed legacy behavioral quirk that a real call site depends on (documented inline at the point of preservation), rather than silently "fixing" it. |

### 1.4 Non-functional requirements

- **Framework-neutral**: importable as plain ESM (`dist/player/rtsp-over-websocket.esm.js`) or a global script
  (`...global.js`), with zero required host-framework dependency for the core element.
- **Behavioral parity**: every ported module must have automated parity coverage against the legacy source where a
  `legacy-player` submodule comparison is possible, or contract tests where it isn't (see
  [ARCHITECTURE.md](ARCHITECTURE.md)).
- **Build**: TypeScript + Vite (`npm run build:player`); no runtime dependency on Node-only APIs.
- **Testability without hardware**: fully exercisable against `src/server`'s synthetic RTSP source, requiring no
  physical camera.

### 1.5 Out of scope

- WebRTC/SIP/HLS/DASH playback — RTSP-over-WebSocket only.
- Multi-tenant or server-rendered use — this is a client-side, single-connection-per-element component.
- Fixing legacy bugs not explicitly flagged for a rewrite (see [MRD.md](MRD.md) §6).

## 2. Server (`src/server`)

### 2.1 Overview

A small Express-based demo/dev server that (a) transcodes a YouTube video into a live RTSP source via `yt-dlp` +
`ffmpeg`, publishing to a MediaMTX instance, and (b) bridges that RTSP source back out as RTSP-over-WebSocket, so
`src/player` can be exercised end to end without a real camera.

### 2.2 Users

- Developers/QA running the demo page (`src/index.html`, served by this same process) to manually exercise the
  player.
- CI/local automated or manual test flows that need a deterministic, hardware-free RTSP-over-WebSocket source.

### 2.3 Functional requirements

| # | Requirement |
| --- | --- |
| S-1 | `GET /api/youtube/probe?url=` — resolve a YouTube URL's title, duration, max source resolution, and available source video/audio codec families, without starting a transcode. |
| S-2 | `GET /api/capabilities` — report which video/audio codecs the installed `ffmpeg` build can actually encode (probed once and cached), plus the fixed resolution ladder (144p–8K) the server is willing to offer. |
| S-3 | `POST /api/sessions` — validate and create a transcode session (YouTube URL, resolution, video codec, audio codec, audio bitrate, RTSP-over-WebSocket credentials, optional explicit channel), returning `201` immediately with `status: "starting"` while the transcode spins up asynchronously. |
| S-4 | `GET /api/sessions`, `GET /api/sessions/:id` — list/inspect sessions and their current status (`starting`/`live`/`stopped`/`failed`), without ever exposing the session's password. |
| S-5 | `DELETE /api/sessions/:id` — stop the session's transcode processes and remove it from the store. |
| S-6 | Serve the built demo page and player bundle directly (`dist/index.html`, `dist/player/*.js`) from the same HTTP(S) server as the REST API — no separate static server required. |
| S-7 | Bridge RTSP-over-WebSocket connections at `/StreamingServer` to the correct session by reading the channel number out of the client's first RTSP request URI, then perform one RTSP Digest challenge/response against that session's own (session-scoped, not global) credentials. |
| S-8 | Relay RTSP signaling and interleaved RTP/RTCP frames 1:1 between the WebSocket client and the session's MediaMTX publish path once authenticated. |
| S-9 | Gate H.264/H.265 video relay until the first keyframe (or a bounded timeout) so a freshly-connected viewer never receives undecodable non-keyframe slices. |
| S-10 | Support both HTTP/`ws://` and HTTPS/`wss://`, independently selectable at startup (flag, env var, or interactive prompt), sharing one port per scheme with the REST API. |
| S-11 | Reject session creation up front (`422`) when the installed `ffmpeg` build lacks an encoder for the requested codec, rather than failing later mid-transcode. |
| S-12 | Prevent two active (`starting`/`live`) sessions from occupying the same channel (`409`), while allowing a terminal (`stopped`/`failed`) session's channel to be reused. |

### 2.4 Non-functional requirements

- **No hardware/account dependency**: works against any public YouTube URL; no API keys required (`yt-dlp` handles
  extraction).
- **Fails loud, not silent**: every external-dependency failure (MediaMTX unreachable, `ffmpeg`/`yt-dlp` missing or
  erroring, unsupported codec) surfaces as a specific session `error` string or REST error response, not a hang.
- **Local dev/test posture, not production hardening**: permissive CORS (`*`), in-memory session store (lost on
  restart), self-signed dev TLS cert — acceptable because this is a demo/dev tool, not a deployed service (see
  [MRD.md](MRD.md) §6 and [SRS.md](SRS.md) for the explicit security boundary).
- **Process isolation per session**: each session's `yt-dlp`/`ffmpeg` pair runs as independent child processes;
  one session crashing must not affect others.

### 2.5 Out of scope

- Persisting sessions across a server restart.
- Authenticating the REST API itself (only the RTSP-over-WebSocket bridge's per-session digest auth is in scope).
- Spawning or managing the MediaMTX process — it is an external dependency the server only connects to.
- Any codec/resolution the installed `ffmpeg` build cannot encode — `GET /api/capabilities` exists precisely so
  callers can discover this rather than the server silently degrading.

## 3. Dependencies (both products)

| Dependency | Used by | Notes |
| --- | --- | --- |
| `ffmpeg` | Server | Transcoding; must be installed separately, not bundled |
| `yt-dlp` | Server | YouTube probing/downloading; standalone binary recommended over the apt package (staleness) |
| MediaMTX | Server | External RTSP server the transcode publishes to and the bridge relays from; not spawned by this repo |
| `legacy-player` git submodule | Player (tests only) | Source of truth for parity tests; absence causes `ENOENT` test failures, not logic failures |
| `three@0.84.0` | Player (fisheye dewarp) | Pinned below a known-DoS-advisory-free version is not currently possible without a rewrite — tracked in [README.md](../README.md#milestones) |

## 4. Open issues

- `three@0.84.0` upgrade blocked on rewriting `FishEye3D.ts`/`FishEye3DMulti.ts` against modern `BufferGeometry`
  APIs, with no automated visual-regression check for the dewarp output (README "Milestones").
- `legacyHostInterface`'s legacy host-app consumption path is currently unverified against a real host app
  (only contract-tested against inferred service shapes) — see `src/player/legacyHostInterface/types.ts`.
