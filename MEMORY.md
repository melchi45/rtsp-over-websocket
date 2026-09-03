# Project memory

A log of non-obvious decisions and history for this repo — things that aren't visible just from reading the code,
kept here so future contributors (human or AI) don't have to rediscover them.

## Full rebrand from the predecessor codebase

This project started as part of an earlier, differently-named player framework. It has since been rebranded
**completely** — package name, build output filenames, every code identifier (classes, interfaces, methods, local
variables, test fixture strings), all provenance/doc comments, the expected legacy-parity submodule's path and the
file/export names test loaders look up inside it, and every Korean-language comment/doc and demo-page UI string
(all now English). Nothing in `src/`, `README.md`, `CLAUDE.md`, or the `.claude/skills/` files still names the old
project — check `git log`/`git blame` if you need the specific before/after identifier mapping for something.

Also deleted entirely: a legacy vendored player source file and a set of legacy static demo pages, both fully
superseded by the `src/player` TypeScript rewrite.

One consequence worth knowing: the legacy-parity test submodule (see "Testing strategy" in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)) isn't checked out in this environment, so none of those tests
actually run today (`ENOENT`) — the file/export names the test loaders now look for reflect the *new* naming, not
whatever the real historical submodule's files are actually called. If that submodule is ever added, expect to
have to reconcile the loader's expected names against its real contents at that time; that's a deliberate,
accepted trade-off rather than an oversight.

## Server: port architecture

`src/server` originally ran REST + the RTSP-over-WebSocket bridge on one plain HTTP port. It was later split into
four (http/https/ws/wss as separate ports), then **merged back down to two** on request: `HTTP_PORT` (default 4000)
serves both REST and `ws://.../StreamingServer`; `HTTPS_PORT` (default 4001) serves both REST and
`wss://.../StreamingServer`. `npm run start:server` can start either or both — via `--http`/`--https` CLI flags,
`RTSP_WS_PROTOCOL` env var, or (if run attached to a real TTY with neither given) an interactive prompt. When
neither a flag/env var is given AND there's no TTY (e.g. backgrounded), it defaults to starting both, so scripted
runs never block waiting on stdin.

`scripts/serve-dist.js` is a leftover standalone static file server for `dist/` (ports 4010/4011) — no longer
required since `src/server` serves `dist/index.html` directly via `express.static`, but kept as an option.

## Session lifecycle bug (fixed)

Sessions that finished naturally (video ended, ffmpeg crashed) transitioned to `stopped`/`failed` status but were
**never removed** from the in-memory session store — only an explicit `DELETE /api/sessions/:id` removed one. This
meant a finished session's channel stayed permanently reserved, and a later attempt to reuse that channel number
got a `409` even though nothing was actually still running. Fixed in `sessionRoutes.ts`: channel-reuse conflicts are
now only raised against `starting`/`live` (actually active) sessions; a `stopped`/`failed` session occupying the
requested channel is garbage-collected automatically when a new session claims that channel. A related client-side
bug was also fixed: the demo page's session poller stopped polling once a session reached `live`, so the UI (and
its Stop button state) could go stale forever if the session later finished/failed on its own — it now keeps
polling (at a slower interval) through `live` too.

## `src` attribute + interactive-auth redesign (fixed)

`<rtsp-over-websocket>` grew a `src` attribute (`RTSPOverWebSocket.ts`'s `applySrcAttribute()`) that
parses a bundled RTSP URL (`rtsp://user:pass@host:port/{channel}/{profile}/media.smp?device=camera&statistics&controls`)
into the equivalent individual attributes and auto-connects — a demo page can now offer a single
URL field instead of one input per attribute. It's deliberately **not** a parser for
`generateRTSPURL()`'s own output: that format is one-directional/server-bound and, for
nvr/playback/backup, isn't a real URL at all (bare `&key=value` with no leading `?`, plus a lossy
compact-digit timestamp encoding meant to be generated, not read back). `src` defines its own
standard-URL convention instead. See the new "RTSP URL" tab in `src/index.html` for exercising this
end to end, and `docs/SDD.md`'s `RTSPOverWebSocket` entry for the full parsing rules.

Building that surfaced a real bug in the credentials flow: `RTSPOverWebSocket.play()` used to throw
immediately if `username`/`password` were missing, before ever attempting a connection — but the
correct RTSP behavior is to connect first and only ask for credentials if the server actually
challenges with 401 (you can't know a stream needs auth, or what its realm/nonce even is, until
challenged). That precondition was removed, and `RtspClient.ts`'s 401 handling was redesigned to
match an interactive "ask a human for the password" flow: try the current credentials exactly once
automatically (the protocol's own normal round trip), and if still rejected, report an error and
**wait** — no more automatic retries with the same rejected credentials, and no closing/reopening
the connection. A caller with a fresh password calls the new `RTSPOverWebSocket.retryAuthentication()`
(→ `StreamPlayer.retryAuthentication()` → `RtspClient.retryWithCredentials()`), which re-answers the
same cached 401 challenge over the *same* still-open connection.

Getting there took three rounds of live testing against a real camera, each surfacing a distinct bug
in the original "retry up to 3 times automatically, then give up and reconnect" design (documented in
full in `docs/SDD.md`'s `RtspClient` entry): the retry-before-checking-the-strike-count send, the
`'close'` handler's unconditional (autoconnection-blind) `0x0005` retry trigger on the intentional
teardown, and — the one that actually explained the symptom ("keeps failing forever, eventually
account-locks the camera") — `unahtuorizedCount` never resetting on a fresh connection, so *any*
attempt after a single failure (even one with the *correct* password) died on its first,
protocol-mandatory 401 without ever trying it.

## `docs/player/` per-class reference docs, and VP8/VP9/AV1 video sessions

`docs/player/` (8 files + README, ~8K lines) is a from-scratch, per-class reference for
`src/player` — Structure/Method Analysis/Call Stack/RFC references/Relations & Data Flow for every
class, written by agents reading the real source against `src/player/README.md`/
`docs/ARCHITECTURE.md`. It's a separate, deeper document from `src/player/README.md` (which stays
the quick static class-relationship map) — see `docs/player/README.md` for how the two relate.
`CLAUDE.md` now has a standing rule to read the relevant `docs/player/*.md` section before
touching a documented class, and to update it in the same change afterward — do this for any
future `src/player` work, not just the codec addition below.

Added `VP8Session`/`VP9Session`/`AV1Session` (`mediaSession/videoSession/`) following the existing
`H264Session`/`H265Session` pattern (RFC 7741 for VP8, draft-ietf-payload-vp9 for VP9, the AOM AV1
RTP payload spec for AV1), wired through `RtpClient.sendSdpInfo`'s codec switch and
`RtspClient.ts`'s SDP `codecMime` acceptance list (previously just `JPEG`/`H264`/`H265` — this
gated DESCRIBE parsing itself, not only session creation). `docs/SRS.md`/`docs/DESIGN.md` already
anticipated these three as demo-server passthrough codecs (`REQ-SRV-053`) before any player-side
support existed.

**Scope boundary at the time this was written**: only the RTP depacketization layer was
implemented end-to-end; decode/render was unimplemented follow-up work. **That follow-up has since
landed** — see the "VP8/VP9/AV1 decode + render (WebCodecs)" entry below — VP8/VP9 now actually
play, confirmed live in a real browser.

## VP8/VP9/AV1 decode + render (WebCodecs) — VP8/VP9 confirmed live, AV1 unit-tested only

Closed the gap from the entry above: `MediaRouter`/`CanvasRenderer`/a new
`worker/videoDecoder/WebCodecsVideoDecoder.ts` now actually decode and render VP8/VP9/AV1, using
the browser's native WebCodecs `VideoDecoder` (chosen over extending `AssemblyDecoder`'s vendored
ffmpeg.wasm build, whose H264/H265 codec IDs are baked into the compiled WASM blob, not
extensible from TS). Full design/implementation detail lives in
`docs/player/03-mediaSession-core-video.md`'s VP8/VP9/AV1 section and
`docs/player/07-talk-backup-worker.md`'s `WebCodecsVideoDecoder` section — this entry is the
condensed "what happened and why it matters" version.

**New code**: `util/BitReader.ts` (shared MSB-first bit reader) + `util/VP8HeaderParser.ts`/
`VP9HeaderParser.ts`/`AV1HeaderParser.ts` (VP8/VP9/AV1's equivalent of `H264SPSParser`/
`H265SPSParser` — extract width/height/profile from each codec's own self-describing keyframe
header, since none of the three has a separate parameter-set concept) — plumbed into
`MediaRouter.getFrameSizeInfo`'s new `'VP8'|'VP9'|'AV1'` branch. This turned out to be **required**,
not optional: `CanvasRenderer`'s `YUVWebGLCanvas` allocates its GL textures at a fixed size once, at
first `setCanvas()` — a `0`-sized `videoInfo.width`/`height` (true before this fix) produces a
*permanently blank canvas*, not a visible error, so an earlier plan to skip this step (reasoning
that MJPEG-style reactive canvas-resize would cover it) was wrong and caught only by a design-review
pass before any code was written.

**Three real bugs found only by testing against a real live VP9 stream** (synthetic unit tests and
static analysis missed all three) — worth knowing about since each looks like expected/plausible
behavior rather than an obvious bug at first glance:

1. **`VP9Session.ts` threw on the VP9 scalability-structure (SS) descriptor bit** instead of
   parsing/skipping it, treating it as an unsupported feature (mirroring how `H264Session` throws on
   STAP-B/MTAP). Real encoders (confirmed: ffmpeg's `libvpx-vp9` RTP payloader) commonly set this
   bit on every keyframe even for an ordinary single, non-scalable layer, so the throw broke
   completely ordinary VP9 streams, not just genuinely multi-layer ones. Fixed by actually parsing
   `N_S`/`Y`/`G` and skipping the right number of bytes (the values aren't needed downstream, just
   correct skipping).
2. **`decoderWorker.ts`'s `onDecoderReady()` had a legacy guard** —
   `if (!(frameBuffer.length > 0 || playMode === 'Playback')) return;` — that left `isDecoderReady`
   permanently `false` (every frame buffered forever, zero errors) if the decoder became ready before
   any frame had queued. `AssemblyDecoder`'s WASM load (network fetch) is slow enough that this never
   triggered in practice; `WebCodecsVideoDecoder.configure()` resolves near-instantly and hit the
   empty-buffer trap on essentially every Live-mode session. Removed the guard entirely (its own
   asymmetry — Playback mode already bypassed it unconditionally — was the tell this was a latent bug
   the WASM path's timing happened to never trigger, not a deliberate invariant).
3. **`YUVWebGLCanvas.ts` never set WebGL's `UNPACK_ALIGNMENT`** (default: 4), silently assuming every
   pixel-data row is padded to a 4-byte boundary — true for H264/H265's macroblock-aligned widths,
   never violated before; false for a real 854px-wide VP9 stream (`854 % 4 == 2`). Every
   `texImage2D` call failed ("ArrayBufferView not big enough for request"), leaving the texture at
   its uninitialized state — visually a solid flat color (confirmed live: solid green), not the
   actual decoded frame, easy to mistake for a color-plane-alignment bug rather than a padding one.
   Fixed with one `gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)` call.

Also found and fixed, separately: `WebCodecsVideoDecoder`'s `VideoFrame.copyTo()` must be called
**without** an explicit `format` option — Chrome rejects any explicit non-RGB format outright
("copyTo() doesn't support explicit copy to non-RGB formats"), even when the frame is already in
that exact format (I420, confirmed the common case for 8-bit VP8/VP9-profile-0/AV1-profile-0). And
the destination buffer must be sized from `frame.displayWidth`/`displayHeight`, not
`frame.codedWidth`/`codedHeight` — the latter can be padded to the decoder's internal alignment
(confirmed live: 928×480 coded vs. 854×480 actually-encoded for the same real stream).

**Also fixed server-side** (`src/server/services/transcodeSession.ts`): added
`-force_key_frames expr:gte(t,n_forced*2)` to VP8/VP9/AV1's ffmpeg args, matching what H264/H265
already had. Without it, `libvpx`/`libaom`'s default GOP sizing produced *zero* keyframes in 15-20s
of test playback — found while debugging why the header parsers above never returned a non-null
result; a viewer connecting mid-stream could otherwise go a long time without a keyframe to size the
canvas from or a `VideoDecoder` could establish state from at all (stricter requirement here than
for H264/H265, which at least have out-of-band SDP parameter sets as a fallback).

**Verification**: VP8/VP9 confirmed end-to-end via Playwright + a real headless Chromium against
this repo's own demo server — actual decoded video frames (not a placeholder/solid color),
screenshot-verified. AV1 could not be tested the same way: this environment's `ffmpeg` cannot
publish AV1 over RTSP at all (separate, unrelated bug — see the entry below and `README.md`), so
`AV1HeaderParser.ts` is covered by hand-written unit tests against synthetic OBU fixtures
(`util/AV1HeaderParser.test.ts`) but the decode/render path itself is unverified against a real
encoder or in a real browser.

**How to apply**: if AV1 output ever becomes testable (ffmpeg gets AV1 RTP support, or a real AV1
RTSP source becomes available), re-verify `AV1HeaderParser`/`WebCodecsVideoDecoder` end-to-end the
same way VP8/VP9 were and update the "AV1 unverified" caveats in `docs/player/03-mediaSession-
core-video.md` and `docs/player/README.md` accordingly — don't just assume it works because VP8/VP9
did; AV1's OBU-walking parser is meaningfully more complex than VP8/VP9's and hasn't seen a real
bitstream yet.

## VP9/AV1 output transcoding (both now fixed — AV1 needed a real ffmpeg upgrade, not just a flag)

Live sessions with `videoCodec: 'VP9'` or `'AV1'` both failed with `ffmpeg` errors visible only in
the server console, not in the session's `error` field (it just said "ffmpeg exited with code 1").
Root-caused both, live, against this environment's ffmpeg and MediaMTX (1.19.3):

- **VP9 — fixed.** ffmpeg's RTP muxer marks its VP9 payloader experimental and refuses to write
  the output header without `-strict experimental` (`Packetizing VP9 is experimental ... Please
  set -strict experimental`). Added that flag to VP9's case in `transcodeSession.ts`'s
  `videoEncoderArgs`; confirmed live end-to-end through the real REST API (session reaches
  `status: "live"`).
- **AV1 — fixed as of ffmpeg 9.0** (`ppa:ubuntuhandbook1/ffmpeg9`); **not fixable on 4.4.2/7.1.1,
  no flag works around that.** First pass root-caused this on ffmpeg 4.4.2 (Ubuntu 22.04 apt) and
  *guessed* the cause was a missing `rtpenc_av1` payloader supposedly added in ffmpeg 6.0 — wrong,
  never actually verified at the time. Installing `ppa:ubuntuhandbook1/ffmpeg7` (7.1.1) to test that
  guess **failed identically** — same `Server returned 400 Bad Request` / MediaMTX `invalid SDP:
  media 1 is invalid: clock rate not found`. Re-investigated: dumped ffmpeg's actual SDP via
  `-loglevel debug` (bare `m=video 0 RTP/AVP 96`, **no `a=rtpmap` line**), confirmed via
  `strings libavformat.so.* | grep rtpmap` that 4.4.2/7.1.1 had rtpmap entries for H264, H265, VP8,
  VP9, JPEG, opus, etc. but **none for AV1** — concluded (at the time) this was unimplemented in
  ffmpeg entirely, version-independent.
  **That conclusion was itself wrong, corrected after the user upgraded to ffmpeg 9.0**: re-running
  the same `strings ... | grep rtpmap` check on 9.0 shows `a=rtpmap:%d AV1/90000` now present —
  ffmpeg added AV1 RTP-muxer support somewhere between 7.1.1 and 9.0 (ffmpeg 8 untested, exact
  version unconfirmed). With the rtpmap entry present, the *same* `-strict experimental` fix VP9
  already needed applies to AV1 too (it hadn't been tried on a version that *had* the entry — the
  4.4.2/7.1.1 "tried, doesn't help" note above was testing it against ffmpeg builds where the whole
  feature was simply absent, not against a build where only the experimental flag was missing).
  Added `-strict experimental` to AV1's case in `transcodeSession.ts`'s `videoEncoderArgs` (it
  already had `-force_key_frames` but not this); confirmed live end-to-end through the real REST
  API on ffmpeg 9.0 — session reaches `status: "live"`, publishes real AV1 frames to MediaMTX.
  Updated `README.md`'s "External tools" section and `CLAUDE.md`'s environment gotchas accordingly.
  **Lesson for next time (reaffirmed, now in both directions)**: verify a "needs version N+" *or* "no
  version will ever fix this" claim about a third-party tool by actually testing against that
  version before writing it into docs as settled fact — this is the second correction to the same
  AV1 claim (6.0-would-fix-it → nothing-will-fix-it → 9.0-actually-does), each time only caught by
  re-testing after a real upgrade rather than trusting the previous investigation's conclusion.
  **Open follow-up**: this unblocks the player-side "AV1 unverified" caveat in the entry below (AV1
  output can now actually reach a browser to test decode/render against) — that re-verification
  hasn't been done yet, don't assume it passes just because VP8/VP9 did.

Also improved failure diagnostics generally while investigating this: `transcodeSession.ts` now
captures the *first* ffmpeg stderr line that looks like a real error (not the *last* non-empty
line — a real failure's actual cause is followed by unrelated per-stream shutdown noise like
`[aac ...] N frames left in the queue on closing`, and capturing "last line" was surfacing that
noise instead of the cause) and folds it into the session's `error` message on a non-zero exit, so
future failures (of any codec) are diagnosable from the API/UI without grepping server logs.

## Canvas overflowed the `<rtsp-over-websocket>` box at the stream's native resolution (fixed)

Reported symptom: a host page sets `width="800" height="480"` on `<rtsp-over-websocket>`, but once
a 1920x1080 stream starts playing, the visible canvas renders far larger than its box (confirmed
live via a real DOM dump from the demo page — the canvas ended up showing only the top-left corner
of the frame, cropped by the browser viewport). Root cause, in two parts:

1. The canvas's `width`/`height` **attributes** are its intrinsic pixel-buffer size
   (`CanvasRenderer`/`WebGLCanvas` overwrite them to the real decoded resolution once frames
   arrive) — unrelated to on-screen display size, which needs a CSS size instead.
   `updateRendering()` (`RTSPOverWebSocket.ts`) didn't apply any such CSS when it first appends
   `this.video`; fixed by setting `width/height: 100%; display: block; margin-left/right: auto`
   there, matching what `onRTSPOverWebSocketVideoMode()` already did on a later tag swap.
2. **This alone wasn't enough — confirmed by testing against a real live stream**:
   `onRTSPOverWebSocketResize()` (`:3646-3663`) re-applies its own style on every real resolution
   change reported by `MediaRouter`, which fires on the stream's very first keyframe — i.e. it runs
   *after*, and overwrites, whatever `updateRendering()` set. Its styleText used to omit
   `width: 100%` specifically for canvas tagmode. With only `height: 100%` set, a replaced element
   like `<canvas>` auto-computes its displayed width from its *intrinsic* aspect ratio (from the
   width/height attributes in point 1) — for a 16:9 stream inside a 5:3 (800x480) host, that
   auto-computed width is wider than the host box, so the canvas overflows horizontally even with
   `updateRendering()`'s fix in place. This was the actual reason the first fix alone didn't resolve
   the user's report. Fixed by applying `width: 100%` unconditionally here too.

See `docs/player/01-elements-interface-exceptions.md`'s `updateRendering()`/
`onRTSPOverWebSocketVideoMode`/`onRTSPOverWebSocketResize` notes for full detail. **Lesson**: three
different call sites in this file independently build the same "fit canvas/video to parent"
styleText (`updateRendering()`, `onRTSPOverWebSocketVideoMode()`, `onRTSPOverWebSocketResize()`) —
if this needs changing again, check all three, not just whichever one looks like the entry point.

## MediaMTX lifecycle: auto-start/stop (added)

`src/server/index.ts` originally had a header comment claiming it deliberately never spawns MediaMTX because a
shared instance was "owned by the parent LTS server process" of an unrelated ("loitering_tracking") project — a
pre-rebrand leftover from the predecessor codebase (see "Full rebrand" above) that both violated the no-old-brand
rule and didn't match this repo's actual, standalone MediaMTX setup (a manually-installed `/opt/mediamtx` binary
per `README.md`'s "External tools" section — no parent project involved). Root-caused after a report that
Transcoding Settings failed with `ffmpeg exited with code 145 ... Connection refused` on `127.0.0.1:8554`: MediaMTX
simply wasn't running, and nothing started it automatically.

Fixed by adding `scripts/ensure-mediamtx.js` (same pattern as the existing `ensure-yt-dlp.js`), wired into every
`start:server*` npm script ahead of `ensure-yt-dlp.js`: if nothing already answers on
`MEDIAMTX_HOST:MEDIAMTX_RTSP_PORT` (127.0.0.1:8554), it starts `mediamtx` (binary from `MEDIAMTX_BIN` env, PATH, or
`/opt/mediamtx/mediamtx`; config from `MEDIAMTX_CONFIG` env or `/opt/mediamtx/mediamtx.yml`) and records its pid in
`$TMPDIR/rtsp-over-websocket-mediamtx.pid`. `scripts/stop-server.js` reads that same pid file and stops *only* that
process (after confirming via `ps -p <pid> -o comm=` that the pid is still actually `mediamtx`, guarding against a
stale/reused pid) — an instance that was already reachable before `ensure-mediamtx.js` ran (started manually, or
genuinely shared with something else) is never started or stopped by these scripts; it's left alone entirely, no
pid file is written for it. `src/server/index.ts`'s own `checkMediaMtxReachable()` startup check is unrelated and
unchanged — it only logs whether MediaMTX is up, it never spawned or managed it, in either the old or new behavior.

## `.env` support for `start:server*`/`stop:server` (added)

Added after a report that `npm run start:server` always prompts `Select which protocol(s) to start...` even
though `RTSP_WS_PROTOCOL` was already a supported way to skip it (`index.ts`'s `modeFromFlagsOrEnv()`) — the env
var just had no way to be set persistently without exporting it in every shell. Fixed with a minimal,
dependency-free `.env` loader (`.env.example` at repo root documents the keys; `.env` itself is gitignored,
machine-specific).

Non-obvious part: there are **two separate copies** of the loader, not one shared module —
`scripts/loadEnv.js` (plain CJS) and `src/server/loadEnv.ts` (compiled into `dist/server`) — because
`start:server*`'s `&&`-chained npm-script steps (`stop-server.js && ensure-mediamtx.js && ensure-yt-dlp.js &&
build:server && index.js`) each run as their **own OS process**; a `process.env` mutation made by one step is
invisible to the next, only real exported env vars survive across `&&`. Every step that reads a configurable env
var (`stop-server.js`, `ensure-mediamtx.js`, and `index.ts` via its `loadEnv` import, which must run before
`./config` since `config.ts` reads `process.env` at module-load time) therefore loads `.env` for itself.
`ensure-yt-dlp.js` was left alone — it has no configurable env vars to read.

## Environment gotchas hit during development

- **Broken `node_modules/.bin/*` shims**: in this environment, several bin shims (`tsc`, `vite`, `vitest` all hit
  this) were plain file copies instead of symlinks, which breaks their relative `require`/`import` of sibling files.
  Fixed by recreating them as real symlinks per the package's own `"bin"` field. If a fresh `npm install` ever
  regenerates proper symlinks, this class of error won't recur.
- **System default `node` is too old** (v12 in this environment) for this project's `tsc`(5.7)/`vite`(6) — they use
  syntax (`??`) that v12 can't parse. A modern Node (20+) needs to be ahead of it on `PATH`.
- **`yt-dlp` from `apt` goes stale fast** — YouTube changes its internal API often enough that a build more than a
  few months old can fail outright (`Precondition check failed`, `Unable to extract uploader id`). The official
  standalone binary (updated via `yt-dlp -U`) is more reliable long-term than relying on the distro package.
- **MediaMTX must be running** for sessions to ever reach `live` — `src/server` checks reachability at startup and
  warns (doesn't crash) if it's absent, but ffmpeg publish will fail with `Connection refused` until it's up. As of
  the "MediaMTX lifecycle" change above, `npm run start:server*` now starts one automatically if needed, so this
  should only bite when running `node dist/server/index.js` directly, bypassing the npm script.
- **The `legacy-player` submodule isn't checked out** in this environment — the large majority of `src/player`'s
  test suite (parity tests) fails with `ENOENT` as a result. This is expected/pre-existing, not a regression from
  any change described above.

## SUNAPI protocol clobbered by non-http(s) host page (fixed)

`SunapiManager.init()`, `SunapiClient`'s constructor, and `SunapiRestClient.init()` all unconditionally borrowed
`window.location.protocol` (and, for the latter two, `hostname`/`port` too) to resolve the device's SUNAPI
protocol whenever it differed from the page's own. That's a reasonable default for a normal http(s) tab, but none
of the three considered what happens when the *hosting page itself* isn't http(s) — concretely, a consumer using
this package's `dist/player/rtsp-over-websocket.esm.js` build embedded in a **Chrome extension page**
(`window.location.protocol` is `"chrome-extension:"` there, not `"http:"`/`"https:"`). `SunapiManager.init()` was
the one actually hit in practice: `RTSPOverWebSocket.updateSunapiManager()` had *already* resolved the correct
`device.protocol` from the element's `secure`/`https` attribute before calling `init()`, and `init()`'s
unconditional sync clobbered that correct value with the literal string `"chrome-extension"` — producing SUNAPI
`XMLHttpRequest`s against an unresolvable `chrome-extension://<host>/...` URL (Chrome's `net::ERR_FAILED` /
`chrome-extension://invalid/` fallback), reported as an opaque `SUNAPI Error` with no indication of the real cause.

Found by tracing a real consumer's bug report back through the published npm bundle's error `place:` string
(`"SunapiManager.ts:init"`) to this exact line. Fixed by gating all three borrowing sites on
`window.location.protocol` actually being `http:`/`https:`; behavior for a normal http(s) host is unchanged, and
non-http(s) hosts now fall back to the caller-provided device info (or, for `SunapiRestClient` specifically, whose
device-info type carries no `protocol` field to fall back to, that class's own `'http'` default) instead of the
page's own location. `SunapiRestClient` is confirmed unreachable from the live app today (see
`docs/player/02-network.md`'s `SunapiManager`/`SunapiRestClient` sections), so its fix is a public-API-surface
correctness fix rather than something that changes current runtime behavior. See those same doc sections for the
full per-class writeup.

## `SunapiManager`'s `joinAfterGet` bug (fixed — was intentionally-preserved, now a real problem)

`getSessionKey()`/`getStorageInfo()`/`getRecordingSetup()`/`getSearchRecordingPeriod()`/`getCalendarSearch()`/
`getOverlappedIdList()`/`getTimeline()`/`getAITimeline()` all called `sunapiClient.join()` right after
`sunapiClient.get(...)` — but `SunapiClient` never had a `join()` method (only `get`/`post`/`setTimeout`/
`getAuthInfo`), so that call always threw synchronously and rejected the promise via `request()`'s `try/catch`,
**regardless of whether the underlying GET actually succeeded**. This was a real bug in the legacy library too,
and was initially ported faithfully rather than silently fixed (per this codebase's general policy of preserving
legacy quirks/bugs that might be load-bearing for parity tests) — see the git history of `SunapiManager.ts`'s
class-level doc comment for how it used to read.

Actually fixed once a real consumer hit it against a real device: `getOverlappedIdList()` sent a well-formed
request, the camera responded with valid `OverlappedIDList`/`ChannelBasedOverlappedIDList` JSON, and the caller
still saw a hard failure (`0x0700`, "o.join is not a function") — because the promise had already rejected via the
`join()` throw before the GET's own `resolve`/`reject` callbacks ever got a chance to fire. Unlike the
`getAudioVolume()` investigation above (where the "bug" turned out to be correct, load-bearing behavior and the
real fix belonged in the *caller*), this one really was a bug in this library with no legitimate purpose — `join()`
was presumably meant to work against whichever backing client was in use (`SunapiRestClient` has a real, safe-to-
call `join()` — see its section in `docs/player/02-network.md`), but `SunapiManager` only ever constructs a
`SunapiClient`, which never had one. Fixed by removing the `join()` call and the `joinAfterGet` option entirely
from `SunapiManager.ts`; see `docs/player/02-network.md`'s `SunapiManager` section for the full per-method writeup.

## Vendor Emscripten/UMD bundles (ffmpeg.js, ffmpegAAC.transcoder.js, minizip-asm.js) base64-inlined into Worker chunks — broke under a real consumer's CSP (fixed)

`AssemblyDecoder.ts`/`AssemblyTranscoder.ts`/`zipWorker.ts` load their vendored Emscripten/UMD bundles via
`importScripts(new URL('../../vendor/xxx', import.meta.url).href)` inside their respective Worker chunks. Vite's
default behavior for an asset reference it can statically resolve *from inside a worker chunk* is to inline it as
a base64 `data:` URL directly in that chunk — confirmed empirically (Vite 6.4) that `build.assetsInlineLimit`
(even set to `0`) has **no effect** on this; it's a worker-specific code path, not the general asset pipeline.
Harmless in an unrestricted page, but a real consumer embedding `<rtsp-over-websocket>` in a Chrome extension hit
it for real: the extension's `script-src 'self' 'wasm-unsafe-eval'` CSP (MV3 extension_pages CSP can't be loosened
to allow arbitrary `data:` scripts) rejected the H264 decoder worker's
`importScripts('data:text/javascript;base64,...')` call outright — canvas-tag playback broke completely, reported
as a CSP violation console error, not an obviously-vendor-related one.

Fixed by moving the actual runtime-loaded vendor files (ffmpeg.js/.wasm, ffmpegAAC.transcoder.js/.wasm,
minizip-asm.js) into `vendor/runtime/` and pointing `vite.config.ts`'s `publicDir` at that folder, so they're
copied *verbatim* to `dist/player/` root instead of going through Vite's asset pipeline at all — then changing
each `new URL(...)` call from `'../../vendor/xxx'` (a path Vite's static analysis *could* resolve, which is
exactly the problem) to `'../xxx'` (deliberately unresolvable at build time — there's no `worker/xxx` or
`worker/videoDecoder/xxx` — so Vite logs a "doesn't exist at build time, remains unchanged" note and leaves the
call as plain runtime code, correctly resolving once actually deployed against the `publicDir` copy one directory
up from the worker chunk's own `assets/`). A same-origin `chrome-extension://<id>/ffmpeg.js`-style URL satisfies
`'self'` with zero CSP changes needed on the consumer's side. `vendor/`'s `.d.ts` files and `mp4Generator.js`
(normally `import`ed and directly bundled, not one of these classic-script loads) deliberately stay out of
`vendor/runtime/`, so `dist/player/` doesn't ship type declarations or test files alongside the real build output
either. See `vite.config.ts`'s `publicDir`/`worker` comments for the full mechanism writeup.

Two other approaches were tried and empirically failed before this one: `build.assetsInlineLimit: 0` (no effect,
confirmed above) and switching the imports to explicit `?url` suffixes (`import x from '../../vendor/xxx?url'`)
instead of `new URL(...)` — also still inlined (and doubled the chunk size, since it inlined *both* the `?url`
import's copy and the original `new URL(...)` call's copy). Worth knowing if this class of Vite worker-asset
behavior needs revisiting again in a future Vite version.

## `<canvas>`/`<video>` stretched instead of keeping aspect ratio (fixed)

`this.video`'s fit-to-host inline style (`width: 100%; height: 100%; display: block; margin: auto`) is written at
three independent points — `updateRendering()` (initial attach), `onRTSPOverWebSocketVideoMode()` (live
canvas↔video Renderer Type switch), `onRTSPOverWebSocketResize()` (every real resolution change from
`MediaRouter`, first firing on the stream's very first keyframe — in practice the *last* writer before real
playback, overwriting whatever the other two set) — and none of them included `object-fit`. `width/height: 100%`
alone *stretches* the element to exactly fill the host's box, distorting the picture whenever the host box's own
aspect ratio (from its CSS/attributes) doesn't match the decoded video's — reported by a real consumer using a
640x320 host showing a 640x480 stream, confirmed in both tag modes (screenshots showed the picture stretched
top-heavy in canvas mode, and — even after removing the consumer's own CSS class and clearing the element's
inline style entirely to rule those out — still not vertically centered in either mode, since without an explicit
CSS size at all a replaced element just renders at its intrinsic buffer size, top-left in its container, with no
scaling or centering of its own).

Fixed by adding `object-fit: contain` to all three style-writing points, unconditionally for both tag modes.
`object-fit` is supported on `<canvas>` the same as `<video>` in every Chromium/Firefox/Safari version this
player otherwise targets (both are CSS "replaced elements") — the element's own box still fills 100% of the
wrapper (so it doesn't overflow the host), but the actual picture inside that box now scales down to the largest
size that fits while preserving its real aspect ratio, and centers itself there by default (`object-position`'s
default is `50% 50%`) — letterboxing/pillarboxing as needed instead of stretching, regardless of tag mode or host
aspect ratio, and regardless of which of the three call sites last touched the style.

While fixing `onRTSPOverWebSocketVideoMode()` also cleaned up an adjacent, previously-preserved legacy bug (it
used to conditionally omit `width: 100%` via a comparison that actually compared a *function reference* to a
string and was therefore always `true` — i.e. always applied `width: 100%` regardless of the condition's real
intent — replaced with the unconditional style that bug always produced anyway, no behavior change beyond adding
`object-fit`). See `docs/player/01-elements-interface-exceptions.md`'s `updateRendering()`/
`onRTSPOverWebSocketVideoMode()`/`onRTSPOverWebSocketResize()` bullets for the full per-method writeup.

## H265Session missing Aggregation Packet (AP) support — "SPS payload is not available" (fixed)

`H265Session.ts` handled VPS(32)/SPS(33)/PPS(34)/AUD(35)/FU(49, Fragmentation Unit)/default, but not
RFC 7798 §4.4.2's Aggregation Packet type (48) — a real, previously-*documented* gap (this doc set's
own `03-mediaSession-core-video.md` already noted "unlike `H264Session`, there is no STAP-A-equivalent
aggregation handling in this class"). An AP bundles multiple NAL units (typically VPS+SPS+PPS+IDR
slice) into one RTP payload; falling into the `default` case buffered the whole thing as one opaque
blob without ever extracting the individual VPS/SPS/PPS NAL units bundled inside it — so
`vpsPayload`/`spsPayload`/`ppsPayload` were never populated, surfacing downstream as
`MediaRouter.spsParse()`'s "SPS payload is not available for channel … The encoder may be sending
SPS/PPS through an aggregation packet type that is not supported" — the exact failure mode that error
message already anticipated by name.

A real consumer hit this using this repo's own YouTube-to-RTSP transcoding demo server
(`src/server`) with the codec set to H.265: playback reached `State: PLAYING` and then immediately
threw that error. Real Hanwha devices apparently send VPS/SPS/PPS as separate single-NAL-unit
packets (confirmed working, unaffected) — at least ffmpeg's HEVC RTP payloader uses APs instead, so
this was purely a gap in the port for a *reachable* code path, not a camera-specific issue.

Fixed by porting `H264Session`'s already-working STAP-A handling (RFC 6184 §5.7.1) to HEVC's AP
format: after the AP's own 2-byte PayloadHdr, unpack a sequence of `{2-byte big-endian NALU size,
that many bytes of NALU data}` (no DONL field — this player never negotiates
`sprop-max-don-diff`), reading each individual NAL unit's own type from its own first two bytes.
Factored the "buffer this NAL, and for VPS/SPS/PPS also stash its payload" dispatch into a new
private `handleSingleNalUnit()`, shared between a standalone single-NAL-unit packet and each unit
an AP unpacks into, rather than duplicating it. Verified the byte-offset math against a synthetic
AP (VPS+SPS+PPS) in a throwaway script before considering it done, since no test harness exists for
this class in this environment (see "Environment gotchas" above re: the missing `legacy-player`
submodule). See `docs/player/03-mediaSession-core-video.md`'s `H265Session` section for the full
per-method writeup.

## H265Session rejected NAL type 0 (TRAIL_N) — a valid H.264-guard copy-pasted without adjusting for H.265 (fixed)

Immediately after fixing the AP gap above, the same consumer hit a second, distinct `H265Session`
bug on the very next thing the fixed AP-carried stream sent: `depacketize()` unconditionally threw
`0x0101` ("This NAL type does not support on this application. nal_type = 0") whenever
`nalType === 0`. `H264Session` has the identical-looking guard, and there it's correct — H.264 NAL
type 0 really is unused/reserved (RFC 6184 Table 7-1). But H.265 has an entirely different, wider
NAL type space (6 bits vs. H.264's 5), and type 0 there is `TRAIL_N` (RFC 7798 Table 1 / H.265
Table 7-1): an ordinary, common non-reference trailing-picture slice — not reserved, not invalid.
The guard was evidently copied from `H264Session` when `H265Session` was ported without adjusting
for that difference, silently rejecting every non-reference slice an H.265 encoder happened to mark
as `TRAIL_N`.

Fixed by removing the guard entirely — type-0 slices now fall through to the `default` case like
every other slice type already does (`TRAIL_R`=1, `IDR_W_RADL`=19, `CRA_NUT`=21, etc. never had
their own `switch` case either, so `default` is already the correct, exercised path for them).
Confirmed via the same YouTube-to-RTSP transcoding demo server as the AP fix (ffmpeg's H.265 output
uses `TRAIL_N`); real Hanwha devices apparently don't hit this either way — both H265Session bugs
were latent for real camera streams and only surfaced once ffmpeg-transcoded H.265 was actually
exercised.

## Canvas tag vs video tag decode paths — easy to chase into the wrong file (documented, not a bug)

Not a bug — a real wrong-turn taken while investigating one, worth recording so it doesn't happen
again. A report of low H.265 decode FPS (RTP arriving at the full 24fps, only ~7fps actually
decoded/displayed, confirmed via the demo page's statistics panel) was first investigated in
`decoderWorker.ts`/`AssemblyDecoder` (the WASM H.264/H.265 software decoder) — the wrong file: the
consumer was using Renderer Type `video`, not `canvas`, and `VideoTagPlayer` (the `video`-tag path)
**never touches `decoderWorker` or any vendored/WebCodecs decoder for H.264/H.265 at all** — it
remuxes RTP into fragmented MP4 and hands it to a real `<video>` element via MSE, so decode happens
entirely inside the browser's own internal pipeline, same as playing a local MP4 file.

The full split (now documented as a table at the top of `docs/player/05-video-player-rendering.md`,
read that first for anything decode-performance-or-codec-support related):
- `canvas` + H264/H265 → `decoderWorker` → `AssemblyDecoder` (vendored ffmpeg.wasm, **software**).
- `canvas` + VP8/VP9/AV1 → `decoderWorker` → `WebCodecsVideoDecoder` (browser-native, hardware-capable).
- `video` + H264/H265 → **no JS decoder** — real MSE, browser-native decode.
- `video` + VP8/VP9/AV1 → real MSE if `MediaSource.isTypeSupported()` accepts that codec's fMP4 box
  type, else `WebCodecsVideoDecoder` in `'bridge'` mode (decoded `VideoFrame`s piped into a
  `MediaStreamTrackGenerator` feeding the `<video>` element).

**The original FPS report is still open** — not root-caused or fixed yet. Since `video`-tag mode
for H.264/H.265 has no vendored decoder to blame, the next places to actually look are (a)
`VideoTagPlayer`'s fMP4-muxing/`SourceBuffer.appendBuffer()` cadence for an unrelated inefficiency,
or (b) the browser/hardware's own real decode ceiling for 1080p H.265 on whatever machine was
tested (`videoElement.webkitDroppedFrameCount`, which the reported "Drops" statistic is sourced
from, is a genuine browser-reported counter, not something this codebase computes/throttles
itself for the `video`-tag path the way `decoderWorker.ts`'s drop-frame heuristic does for
`canvas`) — not yet distinguished between the two.

## H.265 `video`-tag FPS drop root-caused: not decode throughput, but missing B-frame reordering (fixed at the source)

Follow-up to the entry above, which left the FPS report open. Root cause found via
`chrome://media-internals` (the user attached its live JSON dump): the H.265 YouTube-transcoding
demo session was using a **hardware** decoder (`VDAVideoDecoder`, `kIsPlatformVideoDecoder: true`)
the entire time — ruling out a decode-throughput ceiling — but logged, continuously for the whole
session, `Decoded frame with timestamp X s is out of order` immediately followed by
`Dropping frame with timestamp Y s, which is earlier than the last rendered frame`. The same
demo's H.264 session and the real camera's H.264 sessions in the same dump show neither message.

Real cause: `mp4Generator.d.ts`'s `Mp4Sample` has no composition-time-offset/PTS-vs-DTS field —
only a plain `duration` — so the fMP4 `VideoTagPlayer` builds can only represent decode order ===
display order for one linear sequence. `PlaybackBufferManager` (the H.265 reordering buffer
documented under `CanvasTagPlayer`) exists *only* for the `canvas`-tag path — `video`-tag mode has
no reordering of any kind. x265 (this repo's own transcoding demo server) uses B-frames by default
even at `-preset veryfast`; RTP packets for a B-frame stream arrive in decode order, each correctly
timestamped with its true presentation time, so the arrival-order timestamp sequence is inherently
non-monotonic — exactly what the muxer can't represent and what the browser's own frame-ordering
logic was rejecting almost every frame for. Real Hanwha camera encoders don't use B-frames for
low-latency streaming, which is why `video`-tag playback against a real camera was never affected
— matching this file's "Canvas tag vs video tag decode paths" entry's note that this was
demo/ffmpeg-specific.

**Superseded** — initially worked around at the source (`transcodeSession.ts` forcing
`bframes=0`), then fixed properly per explicit request: real B-frame content should just work in
`video`-tag mode, not only be avoidable. See this file's "VideoTagPlayer composition-time-offset
(CTS) support" entry below for the actual fix (real ISOBMFF composition-time-offsets) and the
source-side option this left behind.

## VideoTagPlayer composition-time-offset (CTS) support — real B-frame reordering, not just a workaround

Follow-up/supersedes the entry above. Once the `bframes=0` server-side workaround fixed the
reported symptom, the natural follow-up question was asked directly: shouldn't the *player* handle
B-frames too, not just avoid them for the one encoder this repo controls? Answered by tracing what
actually reorders B-frames for the `canvas`-tag path first: **not** `PlaybackBufferManager`/
`VideoBufferList` (read in full — it's a plain FIFO doubly-linked list, no timestamp sort, no
B-frame-specific logic anywhere) but the WASM decoder itself (`AssemblyDecoder`/ffmpeg.wasm),
which — like any standards-compliant H.264/H.265 decoder — reorders B-frames into display order
internally as ordinary decode semantics, for free, before any frame reaches this repo's own code.
`VideoTagPlayer` never decodes anything (it hands *encoded* NAL units to the browser via MSE), so
it never got that benefit — the reordering problem was entirely unaddressed there, and the
`bframes=0` fix just avoided ever needing to address it, rather than solving it.

Real fix requires ISOBMFF's actual mechanism for this: a per-sample **composition-time-offset**
(CTS) in the `trun` box (ISO/IEC 14496-12 §8.8.8), letting samples be written in *decode* order
(required — B-frame decode dependencies are baked into the encoded bitstream, you cannot just
reorder raw NAL units and expect them to decode) while each one separately declares its true
*display* time. `mp4Generator.d.ts`'s `Mp4Sample` had no such field, and `mp4Generator.js`'s
`videoTrun()` had only a vestigial, non-functional trace of CTS support (a `trunHeader`/`
compositionTimeOffset` flag-detection branch whose sample-writing loop never actually emitted CTS
bytes — dead code, not a working feature). This is genuinely additive to a vendored file this
project otherwise treats as copied-verbatim (per `mp4Generator.d.ts`'s own top comment) — justified
here since it's filling in real spec support the file gestured at but never finished, not a
rewrite.

Implementation, split across three files:
- `mp4Generator.js`: `videoTrun()` gained a third branch (alongside the existing
  no-`frameDuration`/has-`frameDuration` ones), selected when `samples[0].compositionTimeOffset !==
  undefined` — writes a version-1 (signed) `trun` with flags `0x000B05` (adds the
  composition-time-offset bit to the existing duration/size/first-sample-flags/data-offset set) and
  a `[duration, size, cts]` triple per sample, correctly extending the `data_offset` computation by
  the extra 4 bytes/sample this adds. When no sample carries a CTS (every existing/camera stream),
  output is byte-for-byte identical to before — confirmed via a dedicated regression test.
- `VideoTagPlayer.ts`: new `getVideoCompositionTimeOffset(streamData)` (live-mode only) computes
  `presentationTime - decodeTime` per sample without touching `getVideoFrameDuration()`'s existing
  (deliberately untouched — it also drives the live-edge jitter buffer) duration/delay logic at
  all: `presentationTime` = this sample's own `rtpTimestamp` relative to the stream's first sample
  (new field `presentationBaseRtpTimestamp`, reset in `initBaseNTPTimestamp()`); `decodeTime` =
  `baseVideoTime` plus the summed `frameDuration` of any not-yet-flushed buffered samples — i.e.
  this sample's own position on the decode-time clock that already exists. Both scaled identically
  (`* TEN`), so a non-reordered stream's two clocks track each other almost exactly and CTS
  evaluates to ~0 — no behavior change for camera streams, which this was always correct for.
- `src/server/services/transcodeSession.ts` / `types.ts` / `sessionRoutes.ts`: the earlier
  `bframes=0` hardcode became `CreateSessionRequest.bFrames` (default `true`, matching ffmpeg's own
  default) — a real opt-out for comparison/testing now that B-frames work, applied to both H264 and
  H265 (`bFramesArg` appended to `-x264-params`/`-x265-params` only when `bFrames === false`).
  `src/index.html`'s Transcoding Settings panel exposes it as a checkbox (`#yt-bframes`), enabled
  only for H264/H265, restored on session reflect, and shown in the session-status line.

Verified via `mp4Generator.test.ts`'s new CTS describe block (byte-level: version/flags, per-sample
duration/size/signed-CTS values including a negative one, and that `data_offset` still points
exactly at the unmodified mdat payload — the real regression risk was the offset arithmetic missing
the extra 4 bytes/sample) plus the existing regression test confirming the no-CTS path is
byte-for-byte unchanged. Not yet re-verified against a live browser session (no interactive browser
in this environment) — the original bug's diagnosis came from a `chrome://media-internals` dump the
user attached, and the actual "does Chrome now display B-frame H.265 smoothly" confirmation is
still pending a live test on their end. See `docs/player/05-video-player-rendering.md`'s
`VideoTagPlayer` section (replacing its former "Known gap: no B-frame reordering support" note)
for the full per-method writeup.

## VideoTagPlayer init-segment race: audio arriving before the first video I-frame — root-caused and fixed

Reported live: `video`-tag playback with VP9 (then also AV1) video + AAC audio (this repo's own
YouTube transcoding demo) reached `State: PLAYING`, then died with `onAudioData from mediaRouter:
errorcode [undefined], message [Cannot read properties of undefined (reading 'byteLength')]`,
alongside a `RtspClient.ts` "device refuse the connection ... 50x/40x" message and, after the
first fix attempt below, a further `Uncaught InvalidStateError: Failed to set the 'duration'
property on 'MediaSource'` — all part of one cascade, not independent bugs.

**First fix attempt was incomplete**: initially traced the `.byteLength` crash to
`VideoTagPlayer.createAudioSample()`'s `size: streamData.frameData.byteLength` and guarded it —
this didn't actually stop the crash (same VP9 repro, then confirmed AV1 too), because it wasn't
the real trigger. The real one is earlier in the same call chain: `onAudioData()` calls
`setAudioInfo()` *before* `createAudioSample()` whenever the audio codec is first learned or
changes, and `setAudioInfo()`'s codec-switch branch calls `createInitSegment()` — which
unconditionally did `initSegment([this.videoInfoBox as Mp4VideoTrackInfo, this.audioInfo])`.
`videoInfoBox` only gets set once, from `onVideoData()`'s first-I-frame block. If the first audio
RTP packet reaches the player *before* the first video I-frame does, `setAudioInfo()`'s
`createInitSegment()` call runs with `videoInfoBox` still `null`, force-cast past the type system
— `mp4Generator.js`'s box-concatenation code then hits an `undefined` child box (from the video
track's own never-actually-built config box) and throws exactly the reported `.byteLength` error,
which `MediaRouter.onAudioData`'s try/catch wraps as `RTSPOverWebSocketError 0x030B` and — per the
live report — cascades into tearing down the RTSP/WebSocket connection itself (the "device refuse
the connection" message) and, during that teardown/reconnect churn, a stale/late-firing
`'sourceopen'` event reaching `setSourceBuffer()` after the `MediaSource` had already moved on to
`'closed'`/`'ended'` (the `InvalidStateError` on `.duration`).

Not confirmed why audio-before-video-keyframe happens more readily for VP9/AV1 than H264/H265 in
this demo specifically (plausibly GOP/keyframe-interval or muxer-negotiation timing differences —
not chased further, since the fix doesn't depend on knowing why the race window opens, only that
it can).

Fixed with three changes, in order of how directly each addresses the cascade:
- `createInitSegment()` now returns early (no-op) if `this.videoInfoBox === null` — the actual
  fix. Free to defer: `onVideoData()`'s own `createInitSegment()` call, once the first I-frame
  does arrive, runs with whatever `this.audioInfo` is current by then anyway.
- `createAudioSample()`'s `streamData.frameData` falsy-guard (the first, incomplete attempt) was
  kept as defense-in-depth — a single bad/empty audio sample still shouldn't be able to kill video
  playback, regardless of cause.
- `setSourceBuffer()` now returns early unless `mediaSource.readyState === 'open'`, matching what
  the MSE spec actually requires before setting `.duration` — guards the stale-event tail of the
  cascade even if something else triggers session churn in the future.

See `docs/player/05-video-player-rendering.md`'s `VideoTagPlayer` Method Analysis
(`createInitSegment`/`createAudioSample`/`setSourceBuffer` bullets) for the full per-method
writeup.

**Update — this was not actually the (full) root cause.** The exact same crash persisted after
this fix shipped (1.0.10), reproduced with both VP9 and AV1. Confirmed the fix's build output was
correctly published/installed (grepped the compiled bundle for the guard) before looking further,
ruling out a stale-build red herring.

## VideoTagPlayer.setVideoInfo() — the real root cause: sps/pps set unconditionally for every codec

Static reading of `mp4Generator.js` didn't find this one — a live stack trace did. Since the user
couldn't get DevTools' console UI to reveal/expand the stack trace (tried several ways), added a
one-line temporary `console.error(err.stack)` at `MediaRouter.onAudioData`'s catch site, rebuilt,
had them reproduce, and read the plain-text stack trace it printed. That immediately pinpointed a
completely different function than either previous fix touched:

```
at t (mp4Generator's videoSample(), reading a[b].byteLength)
at Rz (stsd-adjacent box builder)
... (initSegment's box-tree call chain)
at rv.createInitSegment
at rv.setAudioInfo
```

`mp4Generator.js`'s `videoSample()` unconditionally NAL-length-prefixes `track.vps`/`.sps`/`.pps`
*before* its own `codecType === "H264"` branch check — `var a = track.sps || []` correctly no-ops
when `sps` is genuinely absent, but `VideoTagPlayer.setVideoInfo()` was setting
`videoInfoBox.sps = [videoinfo.spsPayload]` / `.pps = [videoinfo.ppsPayload]` **unconditionally for
every codec**, before the per-codec `if`/`else if` chain. For VP9/AV1/VP8/MJPEG (no SPS/PPS
concept at all), `spsPayload`/`ppsPayload` are always `undefined` — so `sps` ends up as `[undefined]`,
a *non-empty, truthy* array (the `|| []` fallback only ever triggers on a genuinely-absent
property, not a present array with an undefined element), and `videoSample()`'s loop crashes on
`a[0].byteLength` — well before ever reaching the `codecType` check that would have ignored it.
This is exactly why the previous entry's `createInitSegment()` null-guard fix (a real bug, kept)
didn't stop the crash: `videoInfoBox` was non-null and otherwise fine by the time this ran — its
`sps`/`.pps` fields were the malformed part, not its existence.

Fixed by moving the `sps`/`.pps` assignment into the `H264` and `H265` branches specifically
(mirroring how `vps` was already H265-only, correctly, in the same function) instead of the shared
base object literal — `Mp4VideoTrackInfo.sps`/`.pps` (`mp4Generator.d.ts`) became optional to
match, so for every other codec the fields are now genuinely absent rather than
present-with-undefined, and `videoSample()`'s existing `|| []` guard handles that correctly with
no change to the vendored file needed this time.

**Takeaway for next time a wrapped/generic error message (like `MediaRouter`'s "onAudioData from
mediaRouter: errorcode […], message […]") doesn't have an obvious cause from static reading of the
call chain**: a temporary `console.error(originalError.stack)` at the catch site, rebuilt and
reproduced once, is far faster and more reliable than guessing from symptom text alone — especially
when the user's browser DevTools UI resists giving up the stack trace through normal interaction
(tried: expanding the collapsed error group, clicking the message text, right-click copy — none
worked in this session's Edge browser). Remove the diagnostic once the real throw site is found;
don't ship it.

## AV1 av1C configObu boundary bug — real AV1 test material found a genuine gap in unverified code

Once VP9 started working (the `setVideoInfo()` sps/pps fix above), a live retest across VP8/VP9/
AV1/a real camera surfaced three more distinct findings in one report. This entry covers AV1
(still black screen, `TEARDOWN` + reconnect loop, `errorcode [778]` — `appendBuffer` failing
because `HTMLMediaElement.error` was already non-null from an earlier rejected segment). VP8
(video plays, no audio — a known, separate limitation, `setupBridge()`'s `MediaStream` has no
audio track since WebCodecs-bridge mode was only ever wired up for video) and the real camera's
H.264/OPUS stream freezing after a while (RTP still arriving, FPS drops to 0) are still open —
no diagnosis yet, need more information for both.

`docs/player/03-mediaSession-core-video.md` had explicitly flagged this exact risk beforehand:
"[AV1] could only be verified via unit tests... against the AV1 spec, not against a real encoder or
in a real browser. Treat it as implemented-and-spec-checked, not end-to-end-confirmed." That note
turned out to be exactly right — live AV1 material via this repo's own transcoding demo found a
real bug the synthetic-fixture-only test suite couldn't have caught.

Root cause: `parseAV1SequenceHeader` (`util/AV1HeaderParser.ts`) sets `obuEnd = frameData.length`
whenever the Sequence Header OBU it finds has no explicit `obu_size` field — spec-correct in
isolation ("runs to the end of the containing temporal unit"), but `AV1Session.ts`'s RTP
depacketizer routinely reconstructs exactly a Sequence-Header-then-Frame-OBU access unit where the
Sequence Header element itself has no size field (RTP framing delimited it instead) — so "end of
temporal unit" got treated as "end of `frameData`," wrongly folding the *following* Frame/Tile OBU
bytes into `videoInfo.configObu`. That oversized, invalid `configOBUs` value reaches
`mp4Generator.js`'s `av1C()` verbatim, and Chrome's AV1 decoder rejects the resulting init/config
segment — which is what actually threw the reported `errorcode [778]` on a *later* `appendBuffer`
call (the element's `error` was already set by then; that specific append wasn't the real failure,
just the next thing to trip over it).

Fixed by making `BitReader` expose `bytePosition()` (current cursor rounded up to the next byte —
what a `trailing_bits()` pad would leave it at) and, in the no-size-field case, recomputing
`obuEnd` from how many bytes `parseSequenceHeaderObu` actually consumed rather than trusting
`frameData.length`. Extended `parseSequenceHeaderObu` to read one more field
(`film_grain_params_present`, value unused) purely so the cursor lands at the OBU's true end
instead of stopping short after `color_config()`. Verified with a new test constructing exactly
this shape (size-less Sequence Header OBU + 4 bytes of stand-in trailing OBU data) — `obuEnd` now
correctly stops at the sequence header's own boundary instead of swallowing the trailing bytes; all
existing tests (which only use explicit-size-field fixtures, unaffected by this branch) still pass.
See `docs/player/03-mediaSession-core-video.md`'s `AV1HeaderParser` section for the full writeup,
including a correction to that section's own stale claim that the parser "doesn't parse
`color_config()`" (it does, and has for a while — the doc just hadn't been updated to match).

**Follow-up — the configObu fix alone wasn't enough.** After 1.0.12 shipped it, the exact same
symptom persisted on AV1 retest (black screen, `TEARDOWN`/reconnect loop). A temporary
`console.error` on `VideoTagPlayer`'s video-element `'error'` event (same diagnostic-injection
technique as the earlier `onAudioData` investigation — again faster than fighting the user's Edge
DevTools console UI) surfaced the real `MediaError`: `code=3 PIPELINE_ERROR_DECODE:
dav1d_send_data() failed with error -22` (EINVAL), on **inter frames**
(`is_key_frame=0`) specifically — a different bug from the configObu one (which only affects the
init segment's config record, built once from the first keyframe).

## AV1Session OBU normalization — RTP-framed OBUs lack the in-stream size field ISOBMFF requires

Root cause: `AV1Session.ts`'s depacketizer concatenated each RTP-level OBU element's raw bytes
into the access-unit buffer *exactly as the sender framed them* — preserving whatever
`obu_has_size_field` bit the original `obu_header` happened to have. RTP AV1 senders commonly
leave it `0`, since RTP-level length-prefixing/packet-boundary framing already delimits elements at
that layer — framing information that's lost the moment elements get concatenated into one flat
buffer. The AV1-ISOBMFF binding's "low overhead bitstream format" mandates
`obu_has_size_field == 1` on every contained OBU as a bitstream-conformance rule; without it, a
spec-conformant consumer (Chrome's dav1d-backed MSE decode path, which is what `VideoTagPlayer`'s
`av1C`/ISOBMFF route feeds) can't correctly delimit multiple OBUs (Frame header + Tile group, etc.)
within one access unit and rejects the sample outright. `WebCodecsVideoDecoder`'s canvas/bridge
tier never surfaced this — it tolerates missing per-OBU size fields, unlike ISOBMFF, which is
presumably why this went unnoticed until `VideoTagPlayer` (added later than the canvas/WebCodecs
paths) was live-tested against real AV1 material for the first time.

The obvious first fix attempt (rewrite each element to force `obu_has_size_field = 1` with a size
computed from `element.length`, as they arrive) turned out to be insufficient too: the observed
access units run 30-70KB, routinely exceeding one RTP packet's MTU, so a single OBU commonly
fragments across *several* packets (the RTP AV1 payload format's `Z`/continuation-fragment bit).
The true `obu_size` can only be known once an OBU is **fully** reassembled — computing it per
arriving fragment would just re-introduce a different wrong-size bug.

Fixed properly with a pending-OBU accumulator: `beginPendingObu`/`appendPendingObuPayload`/
`flushPendingObu` buffer one in-progress OBU's payload separately from `inputBuffer` (a
`setBuffer`-style grow-on-demand `Uint8Array`, not the shared access-unit buffer) until it's known
complete — the next non-continuation element starts, or the access unit ends (marker bit) — only
then writing `[header|leb128(realSize)|payload]` into `inputBuffer` in one shot. Verified with a
standalone reimplementation of the algorithm in a throwaway script (no test harness exists for
`*Session.ts` classes in this environment — same limitation noted elsewhere in this file):
a synthetic 3-packet-fragmented OBU followed by a fresh OBU reassembles with the correct leb128
size (confirmed by round-tripping the output through a generic OBU walker) and correct
`obu_has_size_field` on both. See `docs/player/03-mediaSession-core-video.md`'s `AV1Session`
section (the "OBU normalization" note) for the full writeup, including a correction to that
section's own now-stale claim that fragment reassembly "needs no special logic beyond correct
per-packet element splitting" — true for the raw bytes, not for their `obu_has_size_field` meaning.

## RTSPOverWebSocket had no `disconnectedCallback` — reconnecting without Stop left the old session running

Reported as what looked like three unrelated symptoms across this whole debugging arc: AV1→camera
switching producing `dav1d_send_data` errors on H.264 data (nonsensical — dav1d is AV1-only), and
a real camera's H.264/OPUS stream "freezing" (RTP still arriving, FPS dropping to 0). Both traced
to the same cause once asked directly: none of it happened when the user pressed Stop before
reconnecting with different settings; it only happened switching straight from one connection to
another.

Root cause: `RTSPOverWebSocket.ts` (the custom element) never implemented `disconnectedCallback` —
already flagged as a real gap in `docs/player/01-elements-interface-exceptions.md` before this
session touched it ("a consumer must call `stop()` itself before discarding the element"). This
repo's own demo's Connect button doesn't: its `disconnect()` helper does
`playerHost.removeChild(playerEl)` with no `stop()`/`close()` call of its own, then immediately
creates and mounts a *brand new* element for the new session. Removing the old element from the DOM
is a complete no-op as far as its internals are concerned with no `disconnectedCallback` to react
to it — the old instance's WebSocket connection, `MediaSource`/`SourceBuffer`, and RTP processing
all kept running in the background, now contending with the brand-new instance for the same tab's
resources. That explains both symptoms: a still-live old AV1 SourceBuffer's decoder context
receiving interleaved garbage explains a *nonsensical* codec-mismatched decode error more plausibly
than any single-codec bug could, and generic resource contention between two live sessions explains
an otherwise-inexplicable "RTP arrives, nothing renders" freeze on an otherwise-normal H.264 stream.

Fixed by finally implementing `disconnectedCallback()`: calls `stop()` if `this.player` exists,
using the exact same "only when there's actually a player to stop, catch since `stop()` throws
when there isn't" guard already used for the analogous case in the `src`-attribute reconnect path
(`applySrcAttribute`-adjacent code, `:4296-4322`). See
`docs/player/01-elements-interface-exceptions.md`'s updated class-level lifecycle-callback bullet
and new `disconnectedCallback()` Method Analysis bullet for the full writeup — that doc's own prior
note about the missing callback is what pointed straight at the fix once the root cause was known.

## Ported `XmlParser`/`AttributeService`/`ProfileConfig` from `react-wisenet-player`'s legacy jQuery services

`react-wisenet-player` (the Chrome-extension consumer this library's `react/Player.tsx` was
originally adapted from) still had a legacy, jQuery-dependent SUNAPI capability-flags layer
(`sunapi/XmlParser.jsx`/`AttributeService.jsx`/`ProfileConfig.jsx`) that had never been ported to
this repo's TypeScript rewrite. Ported all three into `src/player/network/http/` — `XmlParser.ts`
(native `DOMParser`/`querySelector` instead of jQuery's `$.parseXML`/`.find()`/`.attr()`, verified
the attribute-name CSS selectors translate directly with no behavior change), `AttributeService.ts`
(5,516 lines — the ~250-call capability-flag derivation service, plus ~17 `parse*CgiAttributes`
methods), and `ProfileConfig.ts` (a small static lookup table, unchanged). See
`docs/player/02-network.md`'s new `XmlParser`/`AttributeService`/`ProfileConfig` sections for the
full per-class writeup, including every preserve-vs-fix judgment call made during the port.

**One fix found and applied during porting, not just preserved**: legacy's local `paserXML` helper
(used by all 17 `parse*CgiAttributes` methods, ~2800 lines) was `function paserXML(obj, target) {
return paserXML(obj, target); }` — an unconditional self-recursive stub, reassigned nowhere
(confirmed via grep), that stack-overflows the instant any of those methods actually runs. Every
call site's arguments matched `XmlParser.parseCgiSection`'s signature exactly, so this port's
`private paserXML(...)` delegates there instead — the same judgment `SunapiManager.ts` already
applied to its own confirmed-dead `sunapiClient.join()` chain (see that entry above): faithfully
porting guaranteed-crash dead code would make 17 methods permanently unusable, not "a complete,
usable port." A few small, unambiguous bugs (two `initialize()` fetches silently skipped because
their callbacks were pushed as bare function references instead of being invoked; an
undeclared-`deferred`-variable reference in `getAppStatus` that wouldn't even compile in TS) were
fixed the same way. Angular-app-shell-dependent `login()`/`loginBypass()`/`checkInitPw()` were not
ported — no reachable equivalent exists in this pure network/protocol library.

**Not yet wired into anything live**: `AttributeService`/`XmlParser` exist as standalone,
constructible classes but aren't called from `SunapiManager`, `Player.tsx`, or
`RTSPOverWebSocket.ts` — `SunapiManager.getAttributes()` still returns raw, unparsed XML text to
any current caller (confirmed: real devices answer `/stw-cgi/attributes.cgi/attributes` with XML,
not JSON — `SunapiClient.parseResponse()` hands back the response text as-is whenever
`xhr.responseXML !== null`). Wiring this capability layer into the live connection flow is
deliberate follow-up work.

Alongside the port, added a manual/local-only live-device smoke test
(`network/http/SunapiManager.live.test.ts`, `@vitest-environment jsdom` override since
`SunapiClient` needs a real `XMLHttpRequest` global) covering `SunapiManager.init()` +
`getAttributes()` against a real camera — gated behind `RUN_LIVE_DEVICE_TEST=1` so it's skipped
(not failed) in every other environment, including CI. Credentials are never hardcoded in the
test file itself (it's committed to source control) — read from `RTSP_LIVE_TEST_HOSTNAME`/
`_USERNAME`/`_PASSWORD` env vars, loadable via a new `network/http/loadEnv.ts` (a copy of
`scripts/loadEnv.js`/`src/server/loadEnv.ts`'s minimal dependency-free `.env` parser, kept separate
because `src/player` compiles to ESM with no native `__dirname` — uses `import.meta.url` +
`fileURLToPath` instead). `.env.example` documents the new keys.

## `react/Player.tsx`'s raw-attribute SUNAPI path had a real login/`play()` race — fixed with an opt-in `useSunapi` flag

Live-tested against a real camera through `react-wisenet-player` (the Chrome-extension consumer):
the raw-attribute approach (`<rtsp-over-websocket password=... autoplay />`, relying entirely on
the element's own `connectedCallback()`) connected *intermittently* — sometimes fine, sometimes
"device refuse the connection" or corrupted RTSP/RTP data. Root cause: `connectedCallback()` calls
`updateSunapiManager()` (asynchronous — a real HTTP round trip) and, separately, `play()`
(synchronous, if the `autoplay` attribute is present) in the same pass — nothing sequences one
after the other, so `play()` routinely fires before the SUNAPI login it needs has actually
finished, racing an authenticated stream open against a login that's still in flight.

Fixed at the call site, not by changing `connectedCallback()`'s own timing (a broader, riskier
change): `react/Player.tsx` now does the SUNAPI login itself first (`SunapiManager.init()`),
assigns the result to `sunapiClient` only on success, and calls `play()` explicitly only after
that — removing the race by construction, matching how `react-wisenet-player`'s own `Player.tsx`
was subsequently fixed to match (that fix flowed the other direction: this library's already-
working `react/Player.tsx` was the reference implementation `react-wisenet-player`'s broken one was
brought in line with). Added `useSunapi?: boolean` (`IDevice`, default `true`) so a consumer can
still opt into the raw-attribute path deliberately (for comparison/testing — see `src/index.html`'s
React panel's "Connect via SUNAPI Manager" checkbox) without it being the default, race-prone
behavior. See `docs/player/01-elements-interface-exceptions.md`'s `Player` Method Analysis for the
full per-mode writeup.

Separately found in the same investigation: `statistics`/`https` were passed as the empty-string/
`undefined` "boolean HTML attribute" idiom (matching how `autoplay` is correctly handled), but
`RTSPOverWebSocket.ts` has *real* property setters for both (`set statistics(v: boolean)`/
`set https(v: boolean)`) that React assigns to directly rather than via `setAttribute` for a
custom element — and both throw `RTSPOverWebSocketError` ("this value need to a boolean type") on
anything that isn't strictly `typeof v === 'boolean'`. An empty string satisfied neither. Fixed by
passing real `!!`-coerced booleans for just those two props; `autoplay` correctly keeps the
bare-flag idiom, since it has no matching property setter and *is* read via `getAttribute`.

## Stale `StreamPlayer` never rebuilt after a late SUNAPI login — a second, independent bug behind "SUNAPI login succeeds, RTSP still 401s"

Follow-up to the entry above, found while porting the same SUNAPI-login-then-play pattern into
`src/index.html`'s demo panels (which — unlike `react/Player.tsx` — can legitimately call `play()`
more than once on the same element: an initial raw/unauthenticated attempt that gets challenged,
then a SUNAPI login supplied afterward in response). After that login succeeded and
`sunapiClient` was attached, the *next* `play()` still produced the exact same RTSP-level 401.

Root cause: `play()` only ever constructs `this.player` (`new StreamPlayer(info, sunapiClient)`)
once per element lifetime — `if (this.player === undefined || this.player === null)` — and
**nothing in `RTSPOverWebSocket.ts` ever resets it back to `null`**, not even `stop()` (which only
sends a close command through the existing player, keeping the reference). So the *first* `play()`
call permanently bakes in whatever `sunapiClient` was attached at that exact moment — if that was
before a SUNAPI login supplied credentials, every subsequent `play()` keeps reusing that same
no-sunapiClient `StreamPlayer`/`RtspClient`, answering the digest challenge without one regardless
of anything attached afterward. `react/Player.tsx` never hits this (it only ever calls `play()`
once, after login) — which is exactly why this second bug went unnoticed until the demo panels'
two-attempt flow exercised it.

Fixed at the `sunapiClient` setter: if `this.player` already exists when a client is attached,
stop it and discard the reference (`this.player = null`) so the next `play()` rebuilds one with
the client that was just attached. A no-op for the common (`react/Player.tsx`) case where
`this.player` is still null at that point. See
`docs/player/01-elements-interface-exceptions.md`'s `sunapiClient`-setter Method Analysis bullet
for the full writeup.

Same investigation also found `buildAbsoluteRTSPURL()` (the purely-for-display URL reflected onto
`src` and dispatched via `'generatertspurl'`) unconditionally included `username`/`password` in
the shown URL whenever they happened to be set on the element — misleading and an unnecessary
credential leak once a `sunapiClient` is attached, since SUNAPI-authenticated sessions answer the
RTSP challenge out of band and don't need (or want) plaintext credentials in a URL used only for
observation. Fixed by skipping that whole authority segment whenever `this.sunapiClient !== null`.

## `src/index.html` demo panels redesigned around a "SUNAPI-first" connect flow

Both the React and RTSP URL demo panels gained a "Connect via SUNAPI Manager" checkbox — in the
RTSP URL panel specifically, moved into the main connect form (decided *before* the first connect
attempt) rather than only appearing inside the post-401 "Credentials required" step, since the
whole point is to attempt the SUNAPI login *first*, not only as a fallback once plain RTSP auth
fails.

When checked, the RTSP URL panel no longer assigns `.src` directly (which unconditionally calls
`play()` immediately for an already-connected element — `applySrcAttribute()`'s
`if (this.isConnected) { ...; this.play(); }`, exactly the ordering this flow needs to avoid).
Instead it parses the pasted URL itself (`parseSrcUrl()`, a trimmed standalone reimplementation of
`applySrcAttribute()`'s path/query parsing — necessary since that method can't be invoked directly
and reflects `.src` as a side effect that would trigger the very `play()` call being avoided),
sets the non-credential attributes, and attempts a standalone `SunapiManager` login
(`attemptSunapiConnect()`) before ever calling `play()`. A URL with no (or wrong) credentials 401s
immediately — same "Credentials required" UI either way, whether reached via a SUNAPI REST 401 or
(SUNAPI unchecked) a real RTSP-level challenge; retrying re-runs the same `attemptSunapiConnect()`
with the entered username/password, using a `pendingSrcInfo` var to carry hostname/port/device
across from the initial parse (falling back to the element's own current attributes if the retry
is reached without that initial SUNAPI-first attempt having run — e.g. SUNAPI was only checked
after already hitting the default RTSP-level 401 path).

**A related, non-obvious JS gotcha found while wiring this up**: `SunapiManager.init()` isn't
declared `async`, so when it constructs its internal `SunapiClient` synchronously — which
validates username/password up front and throws `RTSPOverWebSocketError`/`AuthError` right there
for an empty one — that throw happens *before* there's a `Promise` to attach `.catch()` to at all.
It escaped as a plain uncaught synchronous exception (visible for the very first connect attempt,
most of the time, since the URL usually has no password yet) instead of being caught by the
`.catch()` chained onto `sunapiManager.init(...)`'s return value. Fixed by wrapping the `init(...)`
call itself in `try`/`catch` and funneling both the synchronous throw and the normal async
rejection into the same `Promise.reject(...)`-then-`.catch()` path, so "empty credentials" is
handled identically to a real 401 from the device.

## `.env` support extended to `src/player`'s live-device test

`network/http/SunapiManager.live.test.ts` (added alongside the port above) now loads
`RTSP_LIVE_TEST_HOSTNAME`/`_USERNAME`/`_PASSWORD`/`_PORT`/`_PROTOCOL` from the repo-root `.env` via
the new `network/http/loadEnv.ts`, matching the existing `.env` convention `src/server`/
`scripts/` already use (real env vars still win over `.env`, same as everywhere else). Kept as a
*third* copy of the minimal dependency-free loader (alongside `scripts/loadEnv.js`/
`src/server/loadEnv.ts`) rather than a shared module, for the same reason those two are already
separate: `src/player` is yet another distinct build target (ESM output, no native `__dirname` —
uses `import.meta.url`/`fileURLToPath` instead) that a CJS-assuming shared implementation
wouldn't work under.

**Follow-up bug, found immediately after wiring `.env` support up and confirmed live**: the
credentials guard (`if (!hostname || !username || !password) throw new Error(...)`) was written
assuming it only ran when actually opted in, guarded by sitting inside
`describeLive(...)`/`describe.skip(...)`'s callback — but Vitest (like Jest) still **calls that
callback synchronously during test collection even for `describe.skip`**, specifically so it can
discover the `it()`s inside to report them as skipped; only the `it()` *bodies* are actually
skipped. That means the guard threw unconditionally on every single `npm run test:player` run
anywhere `RTSP_LIVE_TEST_*` wasn't set — i.e. everywhere except a machine with real credentials
already configured — the exact opposite of "skipped by default," and silently contradicted this
file's own top comment plus the README/CLAUDE.md text describing it. Not caught immediately
because the failure *looked* identical to the intended "you opted in but forgot credentials"
error, just always active. Found via a real live-testing round-trip: the user filled in their own
`.env` for real (device `192.168.214.40`), which is what actually exposed the *next* bug this
guard had been masking (`runLive`-gated network attempt itself hanging against a device
unreachable from an agent sandbox, expected) — going back to verify the plain "skip, no `.env`"
path still worked (it didn't) is what surfaced this one. Fixed by gating the throw itself on
`runLive` (the same flag that picks `describe`/`describe.skip`), not just on being inside the
`describeLive(...)` call — confirmed via a temporary `.env` move-aside-and-restore round trip: 2
tests correctly skip (not fail) with no `.env` present, and correctly attempt a real connection
once it's back.

## Added a real `./react` export — the package had no import path for a consumer with its own React

Prompted by a plan to replace `react-wisenet-player`'s entire local, increasingly-redundant
`src/components/rtsp-over-websocket/` copy (Player.tsx, SunapiManager/SunapiClient/XmlParser/
AttributeService/ProfileConfig — all already superseded by ported equivalents in this repo) with
this package directly. Surfaced a real gap while planning that: **there was no way for an app with
its own React to actually import `react/Player.tsx`.** `main` (`dist/player/
rtsp-over-websocket.esm.js`) is the base library — `player/index.ts` never re-exports `react/` at
all. The *only* existing build of `react/index.ts` was `vite.react.config.ts`'s
`rtsp-over-websocket-react.esm.js`, deliberately built with React/ReactDOM bundled in (its own doc
comment: for `src/index.html`'s no-bundler `<script type="module">` demo). That bundle is exactly
wrong for a real app — it would load a second, independent copy of React alongside the app's own.

Added a *third* build of the same `react/index.ts` entry: `vite.react-lib.config.ts` →
`dist/react/index.js`, with `react`/`react-dom`/`react-dom/client`/`react/jsx-runtime` all
external rather than bundled. Exposed via a new `package.json` `"exports"` field (previously
absent — only bare `main`/`types`) as the `"./react"` subpath, alongside the existing default
export; `dist/types/react/index.d.ts` needed no new work, since `src/player/tsconfig.json`
already emits declarations for everything under `react/` as part of its ordinary `emitDeclarationOnly`
pass. Also widened `peerDependencies`/`peerDependenciesMeta` (already present, already optional)
from `"^18.2.0"` to `"^18.2.0 || ^19.0.0"` — `react-wisenet-player` is on React 19.

**One non-obvious build detail**: externalizing `'react-dom'` alone wasn't enough.
`react/index.ts` imports `createRoot` from the **subpath** `'react-dom/client'`, which Rollup
doesn't automatically treat as covered by an `external: ['react-dom']` entry — instead it inlined
a hand-reconstructed `createRoot`/`hydrateRoot` shim (built from `react-dom`'s own
`__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED`, mirroring what `react-dom/client`'s real
source does) that also carried in a raw, never-replaced `process.env.NODE_ENV` check — no
`process` global to read it from in a real browser bundle. Fixed by externalizing
`'react-dom/client'` explicitly too; confirmed by grepping the built output for
`process.env.NODE_ENV`/`__SECRET_INTERNALS` (zero matches after the fix, vs. present before it)
and checking the file's actual `import` lines resolve cleanly to `react`/`react-dom/client`/
`react/jsx-runtime` with no inlined interop glue.

Wired into `build:player` (existing `tsc -b && vite build && vite build --config
vite.react.config.ts` gained a fourth step); the two builds don't collide since
`vite.react.config.ts` still writes into `dist/player/` (`emptyOutDir: false`) while this one owns
its own `dist/react/` directory (`emptyOutDir: true`). Verified via `npm pack --dry-run` that the
new `dist/react/index.js` and `dist/types/react/*.d.ts` files are actually included in what gets
published (`files: ["dist"]` already covers them, no change needed there).

Publishing itself goes through the existing `.github/workflows/publish-player.yml` (triggered by
a GitHub Release or manual `workflow_dispatch`, using the workflow's own `GITHUB_TOKEN` against
GitHub Packages) rather than a local `npm publish` — it already runs this repo's own
`build:player` script, so it picks up the new build step automatically with no workflow changes
needed.

## `AACAudioDecoder`'s vendor script was never actually loaded — `Module` undefined on every real AAC-audio canvas-tag playback

Found while live-debugging `react-wisenet-player` (post-migration to this package's `react/`
export) reporting a black canvas with H264 video + AAC audio (`mpeg4-generic` RTP payload) RTP
packets flowing continuously but no visible frames. `AACAudioDecoder.ts`'s own doc comment already
flagged the gap: it "assumes `Module` is already loaded" and says wiring that load step into
`elements/RTSPOverWebSocket.ts` is that file's job, "not something this class does itself" — but
grepping the actual `RTSPOverWebSocket.ts` source turned up **no script-tag injection, no
`globalThis.Module` assignment, nothing** — the wiring was never actually written. `AudioPlayerGxx.
audioInit()`'s `'AAC'` branch (`src/player/listen/renderer/AudioPlayerGxx.ts:166-168`) constructs
`new AACAudioDecoder()` unconditionally for AAC audio, whose constructor calls `Module.cwrap(...)`
synchronously in the first line of its body — with `Module` never set, this throws immediately,
every single time, for every consumer, whenever the audio codec is AAC and the canvas tag (not
video-tag/MSE) path is active. `ffmpegAAC.decoder.js` (the vendor asm.js build this decoder wraps,
872KB, confirmed via `AACAudioDecoder.ts`'s own comment: "wraps the vendored ffmpegAAC.js asm.js
build") sat in `vendor/` as a plain file, outside `vendor/runtime/` (the directory `vite.config.ts`
copies verbatim into `dist/player/` via `publicDir`) — so even a correctly-written loader would
have had nothing to load.

Two-part fix: (1) moved `vendor/ffmpegAAC.decoder.js` → `vendor/runtime/ffmpegAAC.decoder.js` so
it's copied to `dist/player/ffmpegAAC.decoder.js`, same as `ffmpeg.js`/`ffmpegAAC.transcoder.js`;
(2) added `loadFfmpegAACDecoder()` to `elements/RTSPOverWebSocket.ts` — a page-wide-cached
(module-level `Promise`, not per-instance) loader that injects a real `<script src="...">` tag,
since unlike `ffmpeg.js`/`ffmpegAAC.transcoder.js` (each loaded inside their own **worker** thread
via `importScripts`, with an isolated `Module` global per worker) this decoder runs synchronously
on the **main thread** alongside `AudioPlayerGxx`, and needs a real document-level script element,
not `importScripts`. Called as the very first statement in `connectedCallback()` (fire-and-forget,
`.catch(console.error)`) — must start well before the RTSP session negotiates codecs and any AAC
frame could arrive, since `AACAudioDecoder`'s constructor has no async-ready gate the way the
WASM-based decoders do (`Module.onRuntimeInitialized`): asm.js has no separate WASM-compile step,
so `Module.cwrap` is expected to already be callable the instant the class is constructed.

Confirmed via rebuild: `new URL("./ffmpegAAC.decoder.js", import.meta.url)` gets the same "doesn't
exist at build time, remains unchanged to be resolved at runtime" Vite warning as the other three
vendor files (expected — same unresolvable-at-build-time pattern, satisfied by the `publicDir`
copy), and `dist/player/ffmpegAAC.decoder.js` exists post-build and is included in `npm pack
--dry-run`'s file list. **Not yet confirmed against the real camera** — this was found while
chasing a *different*, still-unexplained symptom (a recurring `onStateChanged` "Cannot find module
'chrome-extension://.../<hash>.js'" message tracing to the audio**transcoder** worker chunk, which
per source should only ever be constructed by `VideoTagPlayer`, yet the user confirmed only
`<canvas>` — not `<video>` — exists in the DOM, i.e. `CanvasTagPlayer` should be the active
renderer). That contradiction is still open; this AAC-decoder gap is a separate, independently-real
bug found along the way, not a confirmed fix for the black-canvas report itself.

## Unauthenticated sessions (added) — `src/player` needed zero changes, only `src/server` + the demo page did

Added support for creating/consuming an RTSP-over-WebSocket session with no username/password at all, requested
as: let `src/server` run sessions without credentials, add a Session Username "Use" toggle (default on) to the
demo page's Server panel that starts the session with no auth when switched off, and check whether `src/player`
can already connect without credentials.

The player answer turned out to be **yes, already, with no code change required** — tracing the actual connect
path (not just the one throw site that looks like a blocker) showed the whole chain was already credential-
optional:

- `elements/RTSPOverWebSocket.ts`'s `info.device` default is `username: '', password: ''` (never `undefined`)
  unless the `username`/`password` attributes are left unset, in which case they simply stay at that default.
- `StreamPlayer.ts`'s `open()` only throws its `0x0402` "username is empty" error when `info.device.username` is
  `undefined` — `typeof '' !== 'undefined'` is `true`, so an empty string sails through as a normal (if
  credential-less) username, never hitting that branch. The `0x0402` throw at `RTSPOverWebSocket.ts:5555` (inside
  `backup()`) is a *different*, stricter check (`_username === null`) — it's specific to the backup feature and
  irrelevant to ordinary live playback.
- `RtspClient.ts`'s `Authentication` header field starts `''` and is populated only reactively, inside the `401`
  response handler — never pre-emptively. `DigestGenerator` is likewise only ever invoked in response to a parsed
  `WWW-Authenticate` challenge. So the very first RTSP request a client sends never carries an `Authorization`
  header regardless of whether `username`/`password` are set — a server that never challenges is functionally
  indistinguishable, from the player's perspective, from one that challenged and got answered correctly.
- Confirmed via `docs/player/01-elements-interface-exceptions.md`'s existing note that `play()` "no longer
  validates username/password up front" (a prior redesign, unrelated to this change) — the `0x0403`/`0x0206`
  credential-related errors already only ever originate from an actual failed/missing challenge-response deeper in
  `RtspClient`, never from a synchronous precondition check in `play()` itself.

So the actual changes were entirely server + demo-page side:

- `src/server/api/sessionRoutes.ts`: `username`/`password` may now each be an empty string, but validated as an
  explicit **both-empty-or-both-set** pair — one empty and the other not is rejected with a `400` naming both
  fields. There's no partial-auth state.
- `src/server/rtspOverWebSocket/server.ts`: `handleConnection`'s per-connection state machine now branches on
  `session.request.username` truthiness before ever calling `parseDigestAuthorization`/`verifyDigest`/`challenge` —
  an empty-credentials session skips straight to `state = 'relaying'` on the first message, no `401` ever sent.
  Verified live (not just read) by opening a raw `ws` connection to `/StreamingServer` with no `Authorization`
  header against both an empty-credentials session (proceeded straight past auth to the live-wait/relay stage) and
  a normal-credentials session on the same running server (got the expected `401` + nonce) — see server log lines
  `session has no credentials — skipping digest auth, switching to relay` vs. the normal `digest auth OK` line.
- `src/index.html`: added a "Use" checkbox (`#yt-auth-toggle`, default checked) next to the Session Username field
  in the Server panel. Off sends empty `username`/`password` in `POST /api/sessions` regardless of what's still
  typed into the (now-disabled) Session Username/Password inputs, and disables those inputs plus the password
  show/hide button so a stale-but-ignored value can't confuse anyone reading the form. `reflectRunningSessionSettings()`
  and the "Fill Player tab connection info" button both mirror an already-running session's actual auth state back
  into the toggle/Player-tab fields (an empty `request.username` on a fetched session means it was started with
  the toggle off) rather than assuming the toggle's current UI state matches whatever session is actually live.
- Requirements/test-case docs updated to match: `docs/SRS.md` REQ-SRV-010 (validation rule) and new REQ-SRV-043a
  (challenge-skip carve-out on REQ-SRV-043), `docs/TC.md` TC-SRV-022a/022b/053a, `docs/DESIGN.md` §1.4's sequence
  diagram and §1.6, `docs/ARCHITECTURE.md`'s sequence diagram and key points, `README.md`'s live-session-flow
  steps 2 and 4.
- **Follow-up (2026-08-26): Player-tab "Connect" left a stray `username="" password=""` in the rendered DOM** for
  a no-auth session — reported by the user pasting the actual rendered `<rtsp-over-websocket>` markup. Cause:
  `src/index.html`'s `btnConnect` handler always did `playerEl.username = form.username.value` (and same for
  `password`) unconditionally; `RTSPOverWebSocket.ts`'s `set username(v)`/`set password(v)` are plain
  attribute-reflecting setters (`this.setAttribute('username', v)`, no empty-string guard — same pattern as every
  other attribute setter on the class, e.g. `device`), so assigning `''` still creates the attribute with an
  empty value rather than leaving it absent. Fixed at the demo-page call site only (`if (form.username.value)
  playerEl.username = ...`, same for `password`) — **not** in the element's setter itself, since that's a
  standard, consistently-applied attribute-reflection contract shared by every property on the class and changing
  it would be a much bigger, riskier surface than this one demo-page call site needed. Purely cosmetic/DOM-hygiene
  fix: leaving the attribute unset is functionally identical to setting it to `''` (`info.device.username`/
  `password` already default to `''`, and an unauthenticated session is never challenged either way — see the
  main entry above), confirmed by the investigation that led to the toggle feature in the first place.

## `yt-dlp` YouTube fetch failing in this dev environment — `deno` tried, ruled out, reverted; real cause is per-video server-side gating

While manually verifying the unauthenticated-session change above (creating a real session end-to-end), every
session on this box failed with `ffmpeg exited with code 183: ... Invalid data found when processing input` —
initially assumed related to the auth change, but reproduced identically with normal-auth sessions too, so
unrelated and pre-existing. This took **three** wrong-then-corrected explanations before landing on one backed by
real evidence; recording the full path (not just the ending) because each wrong step looked individually
plausible and was only caught by the user pushing back and asking to re-verify, twice.

1. First hypothesis: blanket YouTube CDN block. Wrong — `GET /api/youtube/probe` (`yt-dlp -j`, metadata-only)
   always succeeded and even listed the requested resolution correctly, which made "it's just blocked" look
   plausible at a glance but was actually just extraction working while the *download* step (a different, later
   `yt-dlp` operation) failed.
2. Second hypothesis: "no JS runtime → `403`, install `deno`". `deno` was installed user-locally (official
   installer → `~/.deno/bin`, added to `~/.bashrc`'s `PATH`) and genuinely does fix the `No supported JavaScript
   runtime could be found` warning and gets real JS-challenge (signature cipher) solving working — confirmed via
   `[youtube] [jsc:deno] Solving JS challenges using deno` in the log. **But re-testing the exact failing session
   after installing `deno` still 403'd.** Investigated further and found the fix hadn't even reached the running
   server process (its `/proc/<pid>/environ` showed no `~/.deno/bin` in `PATH` — a stale process from before the
   `.bashrc` edit) — fixed that too (verified via `/proc/<pid>/environ` this time, not just assumption) and
   re-tested with `deno` *confirmed* reachable by the actual failing process. **Still 403'd, identically**, with
   `[jsc:deno] Solving JS challenges using deno` right before the `403` in the same log — proof `deno` was never
   the fix for this specific symptom, only for the separate (real, but irrelevant here) "no JS runtime" warning.
   Per the user's explicit request, `deno` was fully reverted at this point: `rm -rf ~/.deno`, the `~/.bashrc`
   `PATH` addition removed, and the "install deno" instructions pulled from `README.md`/`CLAUDE.md`.
3. Real cause, found only after ruling out `deno`: tested three different video IDs directly with `yt-dlp`
   (`deno` absent this time, ruling it out as a factor). One older, long-popular video (`jNQXAC9IVRw`, "Me at the
   zoo") downloaded cleanly at every format tier including full DASH merge. Two different modern videos
   (`fZa5SwVMnGg`, `aqz-KE-bpKQ`) both `403`'d at **every** resolution tier tried, down to the lowest (`144p`
   DASH and even the legacy progressive `18`) — so it isn't a resolution/bitrate cutoff, and it isn't specific to
   the one video used throughout earlier testing (`fZa5SwVMnGg`) either. This points at YouTube-side, per-video
   gating (consistent with `yt-dlp`'s own PO-Token-required warnings on non-`android_vr` clients — `yt-dlp -v`
   shows `PO Token Providers: none`), not a local environment defect and not something a JS runtime fixes.

Practical upshot for next time this symptom shows up: **try a different `youtubeUrl` before assuming the
environment is broken** — some videos work, some don't, seemingly independent of resolution. If it turns out to
be consistently every video, that's the PO Token gate.

**Superseded by [[yt-dlp-po-token-provider-final-fix]] below**: the line that used to be here ("`deno` is *not*
part of the fix... don't reinstall it on this same assumption") was itself wrong, in the same way steps 1-2 above
were — it was true only in isolation (deno alone, without a PO Token provider, really doesn't fix this), but the
user pushed back a second time ("정말요? 확인해보세요") and asked for the PO Token provider to actually be set up,
which revealed deno **was** a necessary (if not sufficient) piece all along. Worth noting as its own lesson: a
correction that's true *in the specific context it was tested* can still mislead if that context (here: "without
a PO Token provider") isn't carried forward with it.

## yt-dlp-po-token-provider-final-fix — the actual working fix, both deno and a PO Token provider, plus a third necessary piece (forcing the right YouTube client)

Following directly from the section above: the user asked to set up a real PO Token provider rather than accept
the "not fixable from this repo" conclusion. This turned out to be the right call — it fully fixed real sessions
(confirmed live at 1080p, both `dQw4w9WgXcQ` and `9bZkp7q19f0`, through the actual REST API end-to-end,
`status: "live"` with continuous `frame=` progress) — but getting there needed a third piece beyond the two
already known, discovered only by actually testing rather than stopping once the PO Token layer worked:

1. **Installed [bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider) 1.3.2** — git
   cloned to `~/bgutil-ytdlp-pot-provider`, built the `server/` subdir with Node.js (requires **Node >=22**, a
   separate requirement from this repo's own pinned Node 20 — installed via `nvm install 22`, invoked by absolute
   path rather than changing this repo's own default Node), and installed the yt-dlp plugin via the "Manual" zip
   method (`~/.config/yt-dlp/plugins/bgutil-ytdlp-pot-provider.zip` — this repo's `yt-dlp` is the standalone
   binary, not `pip`/`pipx`, so the PyPI install method doesn't apply).
2. **Hit the same TLS-interception issue as before, twice more** — `npm ci`'s `canvas` native build failed
   (`SELF_SIGNED_CERT_IN_CHAIN` fetching Node headers from nodejs.org) until `NODE_EXTRA_CA_CERTS` pointed at
   `/etc/ssl/certs/ca-certificates.crt`; then the running provider's *own* outbound HTTPS (BotGuard challenge
   fetch from `google.com`) failed identically (`self-signed certificate in certificate chain`) until the same
   env var was set for the server process itself — a corporate root CA (`Somansa_Root_CA.crt`, a Korean DLP/
   security vendor — matches the Windows security-software paths visible in this WSL box's inherited `PATH`)
   trusted by the OS/curl but not by Node's own bundled CA store by default.
3. **First end-to-end retest still 403'd** — even with a real PO Token successfully generated (confirmed via a
   direct `POST /get_pot` call returning a token) and `deno` solving the JS challenge, `yt-dlp`'s *default*
   (unforced) client selection still ended up 403ing at every resolution. Root cause: `yt-dlp` merges formats
   from multiple YouTube "clients" by itag number, and for the app's `bestvideo[...][vcodec^=avc1]` selector it
   kept picking the `android_vr`-origin URL for a given itag over an equally-available `mweb`/`web`-origin one —
   and `android_vr`'s URLs 403 regardless of PO Token/JS runtime (`yt-dlp` doesn't even request it a token, per
   its own client-capability table). Explicitly forcing `--extractor-args youtube:player_client=mweb` fixed it:
   `mweb` (unlike the plain `web` client, which degrades to a 360p progressive-only fallback) exposes the full
   DASH ladder and, with PO Token + JS runtime both available, downloads cleanly at every resolution tested.
4. **Forcing `mweb` unconditionally would have been a regression**, caught by testing the *other* direction
   before shipping: with `deno`/the PO Token provider deliberately turned off, forcing `mweb` failed outright
   (`No video formats found!`) even for the one old video (`jNQXAC9IVRw`) that the *unforced* default had always
   handled fine throughout this whole investigation. So `transcodeSession.ts`'s `startTranscode()` checks
   `hasDeno()` + `potProviderReachable()` (a live HTTP check against `127.0.0.1:4416`) at the start of every
   session and only adds the `mweb` override when *both* are true — otherwise it falls back to the exact
   pre-existing unforced behavior, verified by killing the PO Token provider mid-session-testing and confirming
   the log correctly logged `player_client=default (...)` and did not add `--extractor-args`.

Final architecture, mirroring the existing `ensure-mediamtx.js`/`stop-server.js` pattern exactly: new
`scripts/ensure-bgutil-pot-provider.js` (leaves an already-reachable instance alone; otherwise auto-detects a
Node >=22 under `~/.nvm/versions/node/*` and the provider's build dir, starts it, pid-tracks it) wired into
`npm run start:server*`; `scripts/stop-server.js` extended to stop only the instance it started; new
`BGUTIL_POT_PROVIDER_PORT` config constant and `.env.example` entries for every override
(`BGUTIL_POT_PROVIDER_DIR`/`_NODE_BIN`/`_CA_CERTS`). Deliberately **not** part of this repo's own npm
scripts/install (unlike `yt-dlp` itself, which `ensure-yt-dlp.js` *does* auto-install) — the provider is a
real, separate long-running service with its own build step and Node version requirement, closer in shape to
MediaMTX (external, must already be running) than to `yt-dlp` (a single binary this repo happily fetches for
you). See `README.md`'s "External tools" section for the full manual setup steps, `CLAUDE.md`'s "Environment
gotchas" for the condensed troubleshooting version, and `docs/SRS.md`'s REQ-SRV-036 / `docs/TC.md`'s
TC-SRV-044/045 for the formal requirement and both directions (mweb forced when available; NOT forced when not)
tested.

## `applySrcAttribute()` never wrote the resolved `device` back to the actual attribute — real bug, unrelated to auth (fixed)

Reported as a follow-up to the unauthenticated-sessions work above: the user pasted a real
`RTSPOverWebSocketError` stack (`generateRTSPURL` -> `play` -> `applySrcAttribute` -> `attributeChangedCallback`
-> `set src`) with message `device attribute is not define.`, hit from the demo page's "RTSP URL" tab by typing a
plain nvr-shaped URL with no query string at all (`rtsp://localhost:4000/LiveChannel/0/media.smp` — no
`?device=nvr`) and clicking Connect. Asked to confirm whether this was actually a username/password issue — it
wasn't; a real, separate bug in `src/player/elements/RTSPOverWebSocket.ts`'s `applySrcAttribute()`.

Root cause: the method computes a local `deviceType` const with a sensible fallback chain
(`url.searchParams.get('device') ?? this.getAttribute('device') ?? 'camera'`), but the *only* place that gets
written back to the real `device` attribute is a generic `?query=value` passthrough loop earlier in the same
method — which only fires for params the `src` URL's query string actually contains. A `src` with no query
string, on a fresh element that never had `device` set any other way, left the real attribute (and
`_deviceType`, its backing field, default `null`) unset forever. `generateRTSPURL()` branches
`if (this._deviceType === 'camera') {...} else if (this._deviceType === 'nvr') {...} else { throw 0x0404 }` — a
`null` `_deviceType` hits that final `else` unconditionally, so `play()` always threw for exactly this URL
shape, regardless of credentials.

Fix: added `this.setAttribute('device', deviceType);` immediately after computing `deviceType`, so the resolved
value (URL param, or existing attribute, or the `'camera'` default) is always persisted to the real attribute —
not just used locally to decide how to parse the path segments below it. One-line fix, but the class of bug is
worth remembering: a value computed with a correct fallback chain isn't the same as that value actually being
reflected onto the attribute other code paths (`generateRTSPURL()`, `attributeChangedCallback`) read from — don't
assume a local variable and the backing attribute stay in sync just because they're derived from the same
inputs.

**Second, more consequential bug found while verifying the first fix actually made the user's exact URL work**
(traced the logic by hand with plain Node's `URL`, not just reasoning about it): even with the crash gone, a
`src` with no `?device=` query param still resolves to `'camera'` by default (the URL genuinely doesn't say
which device type it is — `?device=nvr` has to be explicit; added an nvr-shaped example to the demo page's RTSP
URL tab field-note/placeholder, which previously only showed a camera-shaped one, so this isn't confusing again).
But even *with* `?device=nvr` added, the channel never got parsed: `generateRTSPURL()`'s own nvr branch produces
`LiveChannel/<channel>/media.smp` (or `PlaybackChannel`/`BackupChannel`), but `applySrcAttribute()`'s channel-
segment parsing unconditionally read `segments[0]` — correct for camera mode (`{channel}/{profile}/media.smp`,
no prefix) but wrong for nvr mode, where `segments[0]` is the literal `LiveChannel` string and the channel is
`segments[1]`. `Number('LiveChannel')` is `NaN`, so the `channel` attribute silently never got set for *any*
nvr-shaped `src` — not a crash, just a silently-wrong connection (would attempt channel 0/whatever was already
set, not what the URL asked for). This is exactly the shape of URL this repo's own `src/server` sessions
produce and reflect back onto `src` (`docs/DESIGN.md`'s "channel is 0-based on the wire" convention), so it's a
real, live gap, not a hypothetical one. Fixed by stripping a leading `LiveChannel`/`PlaybackChannel`/
`BackupChannel` segment (case-insensitive) before reading the channel segment, but only when
`deviceType === 'nvr'` — camera-mode parsing is unaffected. Verified both fixes together end-to-end (outside a
browser, via plain Node `URL` + the exact parsing logic) for `rtsp://localhost:4000/LiveChannel/0/media.smp`:
no `?device=` → `{device: 'camera', channel: null}` (no crash, but wrong device — expected, URL is genuinely
ambiguous); `?device=nvr` appended → `{device: 'nvr', channel: 1}` (correct — wire value `0` converts to the
1-based `channel` attribute `1`); a camera-mode URL with an existing channel segment was re-verified unaffected.

Doc updated in place (not just appended to) at `docs/player/01-elements-interface-exceptions.md`'s
`applySrcAttribute()`/`generateRTSPURL()`/`buildAbsoluteRTSPURL()` entries for both fixes, since the old
description ("device ... already applied above via the generic passthrough if `src` included it") was actively
wrong about this gap, not just incomplete.

**Third bug, same method, found immediately after** (user tested the round-tripped Player-tab URL against the
RTSP URL tab, worked through the `?device=nvr` fix above, then separately reported a real device connect
attempt — `rtsp://192.168.x.x/0/H.264/media.smp`, no port — failing with a WebSocket connection to `:4000`, the
port from an *earlier, unrelated* connection on the same reused element): `applySrcAttribute()`'s port handling
was `if (url.port !== '') this.setAttribute('port', url.port);` — when the URL had no port at all, this did
*nothing*, leaving `port` at whatever a previous `src` on that same element had set it to (the demo page's RTSP
URL tab element is created once and reused across every "Set"/"Connect" click, not recreated per attempt). Fixed
by resolving a default (`'443'` if `this._secure`, else `'80'`) whenever `url.port === ''`, applied in a
*separate* step positioned deliberately *after* the generic `?query` passthrough loop — not merged into the
single line the explicit-port case still uses before that loop — specifically so an explicit `?secure`/`?https`
in the same URL is already applied by the time the default is computed, rather than being clobbered by the
`'port'` `attributeChangedCallback` case's own `_secure = (port === 443)` side effect (documented at that case
already: setting `port` force-resets `_secure` based on the port number alone). Confirmed `play()` already had
an equivalent `_port === null` → 443/80 fallback elsewhere in the class — validating `443`/`80` as this
codebase's existing canonical defaults, not new numbers invented for this fix — but that guard only covers a
*never-set* `_port`, not a *stale* one, so it didn't help this case. Separately confirmed (direct question from
the user) that ws:// vs wss:// selection is already correctly driven by `secure`/`https` →
`info.device.protocol` → `StreamPlayer.ts`'s `startStreaming()` — not a bug, no change needed there.

**Fourth bug, same method, same "stale state from a reused element" family**: right after the port fix above, the
user tested switching the RTSP URL tab's target IP between two real devices (`.32` then `.40`, both `?device=camera`,
neither URL carrying its own credentials). The first IP correctly triggered the "Credentials required" prompt and
the user typed a username/password; changing only the IP and reconnecting on the same (reused) element then
silently answered `.40` with `.32`'s credentials instead of prompting again — `applySrcAttribute()` never had any
logic to clear `username`/`password` for a `src` that simply omits its own, exactly the same shape of bug as the
`port` one (a value with no explicit override in the new URL just keeps whatever a previous connection left
behind). Fixed by comparing the new `url.hostname` against the element's *current* `hostname` attribute before
overwriting it: if they differ and there *was* a previous hostname (not this element's very first `src`), clear
`username`/`password` first unless the new `src` supplies its own. The `previousHostname === null` guard matters:
without it, a `src` set *after* `username`/`password` had already arrived some other way (the demo page's Player
tab, for instance, assigns them as plain properties before ever touching `src`) would wipe them out on the very
first connect, which would have been a regression in the opposite direction. Verified the logic directly (three
scenarios: fresh element, IP change, same-IP reconnect) via the same plain-Node dry-run technique used for the
device/channel fixes above, rather than fighting jsdom+ESM integration again — much faster and just as conclusive
for pure attribute-derivation logic with no real DOM/network dependency. Doc updated in place again at
`docs/player/01-elements-interface-exceptions.md`'s `applySrcAttribute()` entry (now covers four fixes from one
investigation thread — device, channel, port, credentials — all in the same "resolve explicitly instead of
silently keeping stale state from a reused element" family; worth checking this method for the same pattern again
if another "works once, breaks on the second try" report comes in for the RTSP URL tab).

## nvr-mode `generateRTSPURL()` rewritten to emit real `?query` syntax — a deliberate wire-protocol-format change, not a bug fix, done at the user's explicit request after being warned of the real-device risk

Direct follow-on from the device/channel/port/credentials investigation above: the user asked *why* a
Player-tab-generated `src` like `rtsp://host:4000/LiveChannel/2/media.smp/profile=H264` couldn't just be pasted
into the RTSP URL tab and work — the underlying problem was that `generateRTSPURL()`'s nvr branch never produced
real `?query=value` syntax in the first place, it glued `profile=`/`session=`/`start=`/etc. directly onto the
path string with `/` or `&` chosen ad hoc per field (bare trailing `/` if no session key, otherwise `/session=X`
then `&`-prefixed extras) — not `URLSearchParams`-parseable at all, which is *why* `applySrcAttribute()` could
never read `device`/`profile` back out of its own sibling method's output.

**Before changing it, flagged a real risk the user needed to actually decide on, not one I should default past**:
`generateRTSPURL()`'s return value is not a display string — `play()` assigns it to
`info.media.requestInfo.url`, which `RtspClient.ts` sends verbatim as the literal outgoing RTSP request URI
(`this._request(cmd, requestInfo.url, ...)`). So this wasn't a client-side-only convenience fix like the four
before it — it changes what this player actually sends to **real Hanwha NVR/camera hardware**, which this class
serves in addition to this repo's own demo `src/server` (which only cares about the numeric channel segment and
ignores everything else in the path — confirmed via `rtspFraming.ts`'s `extractChannel()`). No confirmation
either way was found in `docs/player/` that real NVR firmware requires the legacy path-embedded format
specifically, nor that it's safe to change — genuine unknown, not something to guess past. Presented the
tradeoff explicitly (fix `applySrcAttribute()` only — zero wire-risk, vs. also rewrite `generateRTSPURL()` — full
symmetry but real-device risk) via `AskUserQuestion` rather than picking one myself; the user chose the riskier,
fuller fix having been told the risk plainly.

**Implementation**: nvr branch now builds a `queryParams: string[]`, starting with `'device=' + this._deviceType`
(so a self-generated nvr `src` is always unambiguous when re-parsed — no longer relies on
`applySrcAttribute()`'s 'camera' default guessing right), pushes every other piece
(`session`/`start`/`end`/`overlap`/`BestshotFilter`/`substream`/`profile`/`profile_number`/`ProfileUsage`/
`camchannel`/`codec`/`limitWidth`/`limitHeight`/`iframe`) the same way, then joins with exactly one `?` +
`&`-separators at the very end. This incidentally also deletes the whole class of "was this the first param, do
I need a leading `&` or not" bookkeeping the old code had scattered per-field — which was itself part of the
original bug (the no-session-key path left a bare `/` with nothing after it, so the *next* thing appended landed
glued on with no separator at all). Camera mode untouched — its `profile` was already a real path segment,
correctly round-tripped, with none of the nvr branch's `&`-glued extras.

**Verified twice, at two different levels, before calling it done**:
1. Pure logic: simulated `generateRTSPURL()`'s new nvr output for a real channel+profile combination, then fed
   that exact string back through `applySrcAttribute()`'s simulated logic — got back identical
   `device`/`channel`/`profile` state. Full round-trip, no browser/DOM needed for this kind of pure
   string-derivation check.
2. Live, against the real bridge: created a real session on this repo's own `src/server`, then sent a raw
   `DESCRIBE` over a raw WebSocket using the new URI shape (`.../media.smp?device=nvr&profile=H264`) — got a real
   `200 OK` with a full SDP body back from `rtspOverWebSocket/server.ts`/MediaMTX. Confirms the format change
   doesn't break this repo's own bridge (`extractChannel()`/`rewriteRequestUri()` both still resolve the channel
   correctly with a real query string present) — real Hanwha hardware compatibility remains genuinely unverified,
   as disclosed to the user up front.

**Immediately followed by a user request to also keep the *old* format working**: `applySrcAttribute()`'s nvr
branch gained a legacy-fallback pass — every path segment after the channel (skipping `media.smp`/`play.smp`/
`backup.smp`) is split on `&` and each `key=value` pair routed through the exact same
`session`/`start`/`end`/`overlap`/`knownAttributes` handling the real `?query` loop uses, but only for a key the
real query string *didn't* already supply this parse (tracked via a `queryProvidedKeys` set populated while
processing `url.searchParams`) — a legacy path fragment is a best-effort guess, never authoritative over an
explicit `?query` value. This means both `.../media.smp?device=nvr&profile=H264` (new) and
`.../media.smp/profile=H264?device=nvr` (old) now work identically — verified both directly against the same
live session, both `200 OK`. `queryParams` line, `applySrcAttribute()`'s legacy fallback, and both live tests are
documented together in `docs/player/01-elements-interface-exceptions.md`'s `applySrcAttribute()`/`generateRTSPURL()`
entries.

## Fifth bug in `applySrcAttribute()` — same-day regression in the fourth fix itself (`removeAttribute()` vs `setAttribute('', '')` are NOT interchangeable here)

The credentials-clear-on-hostname-change fix (fourth fix, above) used `this.removeAttribute('username')` /
`removeAttribute('password')` to clear stale credentials. This shipped a real regression, caught by the user
testing the exact same two-real-camera-IPs scenario the fix itself was written for
(`rtsp://192.168.x.32/.../media.smp?device=camera` → `rtsp://192.168.x.40/.../media.smp?device=camera`, both
with no credentials in the URL): the *second* connect now threw `RTSPOverWebSocketError` ("username is empty
from input parameter.") from `StreamPlayer.ts`'s `open()`, immediately on `play()`.

Root cause, traced precisely (not just plausible reasoning — simulated the exact conditional both ways before
committing to the fix): `removeAttribute('username')` fires the `'username'` `attributeChangedCallback` case
with `newValue = null`. That case computes `this.info.device.username = this._username ?? undefined` — with
`_username = null`, the `??` operator substitutes `undefined` (it triggers on both `null` and `undefined`, not
just falsy values generally). This produces a state (`info.device.username === undefined`) that is *not* the
same as this element's actual default "no credentials" state, which is `info.device.username: ''` (empty
string) baked into the `info` object literal at construction and never touched if the `username` attribute is
simply never set. `StreamPlayer.ts`'s `open()` checks `typeof info.device.username !== 'undefined'` — `true`
(no throw) for `''`, `false` (throws) for `undefined`. So a *fresh* element with no `username` attribute ever
set connects fine (confirmed throughout this whole investigation), but an element whose `username` attribute
was explicitly *removed* after having been set does not — even though both states read as "no username" at a
glance, only one of them is the specific empty-string representation this class's own precondition check
actually accepts.

Fix: `setAttribute('username', '')` / `setAttribute('password', '')` instead of `removeAttribute()` — produces
`newValue = ''`, so `_username = ''`, so `info.device.username = '' ?? undefined` = `''` (the `??` does *not*
substitute for a non-nullish empty string), matching the safe default exactly. Verified the fix directly by
simulating both code paths (`removeAttribute()`'s `null` vs `setAttribute('', '')`'s `''`) through the identical
`?? undefined` + `typeof !== 'undefined'` logic `StreamPlayer.open()` actually runs — confirmed `null` throws,
`''` doesn't, before touching the real file again.

Lesson worth keeping for next time a "clear this attribute" fix gets written in this class: **`removeAttribute()`
and `setAttribute(name, '')` are not interchangeable whenever the attribute's `attributeChangedCallback` case
uses `?? undefined`/`?? someDefault` on `newValue`** — `removeAttribute()`'s `null` and a real "unset" `undefined`
collapse to the same coalesced value, which may not match whatever this class's *other* code (constructors,
other methods) actually treats as the neutral/default state for that field. Check what the field's own
object-literal default is before picking one over the other; don't assume "clearing" a value always means
`removeAttribute()`.

**Same request also asked for defense-in-depth beyond that one call site**: "username이 비어 있어도 일단 websocket에
접속하고 RTSP의 401 에러를 수신받아 처리하도록 수정이 필요합니다" — even with the `applySrcAttribute()` regression fixed,
the user wanted `StreamPlayer.ts`'s own `open()` precondition relaxed too, not just the one caller that happened
to trip it. `open()` had its own separate `throw ... 0x0402 ('username is empty from input parameter.')` for
`info.device.username === undefined` — a synchronous, hard-fail precondition that's *exactly* the kind of check
`RTSPOverWebSocket.ts`'s own `play()` was already redesigned away from (see this same file's earlier "401 /
credential-retry (recent redesign)" section — `play()` "no longer throws up front for missing username/password
... the actual 0x0403 error now originates deeper, in RtspClient's digest-auth header builder"). `StreamPlayer.open()`
had never gotten the same treatment. Changed it to default `profileInfo.device.username = ''` instead of
throwing — `hostname`/`cameraIp` stay hard requirements (genuinely can't connect without a target host; only
`username` was ever the mismatched-with-the-rest-of-the-codebase check). This is squarely in-line with an
already-established, already-documented architectural direction in this exact codebase, not a novel design
decision — low risk to apply by extension.

## React wrapper (`src/player/react/Player.tsx`) couldn't connect without credentials either — a third code path with the same underlying gap, found by following the same "trace, don't guess" method

After `RTSPOverWebSocket.ts`/`StreamPlayer.ts` were both fixed to accept empty credentials, the user asked to
check `src/player/react` too — a third consumer of the same element, and worth checking precisely *because* it's
a separate code path that could plausibly have its own gap, not because there was any specific symptom reported
yet.

Root cause, different in kind from every fix so far in this thread (not a "stale state" bug — a design default
that stopped fitting once no-auth became a supported case): `Player.tsx`'s `useEffect` branches on `useSunapi =
props.device.useSunapi !== false` — SUNAPI REST login by default unless explicitly opted out. A SUNAPI login
fundamentally needs *something* to authenticate with; with no `username`/`password` at all, `SunapiManager.init()`
can only ever fail, and this component never falls through to the raw-attribute path (`useSunapi: false`'s
branch, which sets real `password`/`autoplay` attributes and lets the element's own
`connectedCallback()`/`updateSunapiManager()` drive things) that would otherwise work fine given the two fixes
above.

**First attempt at the fix was too narrow, and testing against the actual demo page caught it before shipping**:
tried `useSunapi = props.device.useSunapi === true ? true : props.device.useSunapi === false ? false :
hasCredentials` — only override the *default* (unset) case, leaving an *explicit* `useSunapi: true` alone on the
theory that an explicit caller choice should be respected. But re-reading `src/index.html`'s own React panel
connect handler showed `useSunapi: form.useSunapi.checked` — a real boolean from the checkbox's `.checked`
property, **always** explicit, **never** `undefined` (the checkbox defaults to checked, i.e. `true`). So the
"only downgrade the default" version would never actually fire on this repo's own demo page — the exact
UI a report about this would come through. Caught by continuing to trace the *actual call site*, not stopping at
"the component-level fix looks reasonable in isolation." Corrected to `useSunapi = hasCredentials &&
props.device.useSunapi !== false` — no-credentials always wins, full stop, regardless of what the flag says,
since a SUNAPI attempt with zero credentials can never meaningfully succeed no matter how it's requested; an
explicit `useSunapi: true` **with** credentials present is completely unaffected.

Also worth noting since it wasn't obvious going in: `IDevice.username`/`password` (`Constant.ts`) are typed as
required `string`, not `string | undefined` — so this component was never at risk of the `null`-vs-`''`
`removeAttribute()` mixup from the fifth `applySrcAttribute()` bug above; an empty string was already the only
way to express "no credentials" through this component's own prop types, which is exactly the representation
`StreamPlayer.open()`'s fix (fourth entry up) made safe. Doc updated at `docs/player/01-elements-interface-exceptions.md`'s
`Player` (React wrapper) section — both the `useSunapi` derivation and the `useSunapi: false` bullet's
description, since that mode is no longer just a comparison/test path but the one an intentional no-auth
connection now actually goes through.

## Real-camera "1 frame then freeze" bug: Opus audio racing the first video I-frame for `VideoTagPlayer`'s `SourceBuffer` codecs string

Reported live against real Hanwha camera hardware (two cameras, same client code, same profile shape — one
worked fine, one played exactly one video frame then froze forever). The single differentiating fact, given by
the user only after some back-and-forth diagnostic questions: the frozen camera's audio codec was Opus; the
working one's wasn't. Confirmed experimentally (not just by code reading) by having the user reconfigure the
frozen camera's audio to G.711 — the freeze stopped. That confirmation is what turned a plausible-but-unproven
code-reading hypothesis into a confirmed root cause before any fix was written.

**Root cause**: `VideoTagPlayer.ts`'s very first `MediaSource.addSourceBuffer(mimeCodec)` call happens at the
first video I-frame (`onVideoData()`'s `createInitSegment()`), and the `mimeCodec` string's audio half is
`this.opusActive ? 'opus' : 'mp4a.40.2'` — `opusActive` used to default to `false` and only ever get set by a
*real* `onAudioData` → `setAudioInfo()` call. On real hardware, which arrives first — the first video I-frame or
the first audio RTP packet — is a genuine race with no ordering guarantee (this repo's own demo server, by
contrast, apparently tends to deliver video first reliably enough that this race was never seen against it).
When video won the race, the `SourceBuffer` got permanently locked into `'mp4a.40.2'` (MSE forbids changing a
`SourceBuffer`'s codecs string after creation), and the moment the real Opus `onAudioData` call then arrived,
`setAudioInfo()`'s pre-existing (correct, intentional) mismatch guard — added specifically because a prior
remove-and-recreate attempt had wedged the whole `MediaSource`, see that method's comment — silently and
permanently dropped that connection's audio for the rest of the session. The part that wasn't obvious from
reading `setAudioInfo()` alone: this doesn't just mean "no sound." `<video>`'s playable range (`buffered`) for a
multi-track `SourceBuffer` is the *intersection* across all declared tracks — once the audio track stops
receiving samples entirely, the intersection stops advancing even while video segments keep appending
successfully underneath it, which is exactly "renders once, then freezes forever, while RTP keeps arriving"
(confirmed separately via the Statistics panel: the video RTP packet counter kept climbing throughout the
freeze). AAC/G711/G726 were never at risk from this specific bug: all three share the identical `'mp4a.40.2'`
MIME string regardless of arrival order, so `opusActive`'s `false` default already matches them — the race only
exists for the one codec whose correct MIME string differs from the default.

**Fix**: thread the audio codec type down from SDP (`RtpClient.sendSdpInfo()`, which runs once at RTSP `SETUP`
time — well before either the first video or first audio RTP packet, so there's no race at that layer) through a
new `MediaRouter.setAudioCodecHint(codecType)` / `audioCodecHint` field, mirroring the *existing* pattern
already used for the video codec (`MediaRouter.handleVideoData` already sets `player.codec` before calling
`player.init()`, specifically so a player can know its codec before its first data callback — same idea,
applied to audio for the first time). `VideoPlayer.ts` (the shared base class) gained a plain `audioCodecHint`
field; `VideoTagPlayer.init()` now seeds `this.opusActive = this.audioCodecHint === 'OPUS'` before either
`onVideoData`/`onAudioData` can run, so the first `SourceBuffer` is correctly declared regardless of which
media type's RTP happens to arrive first. A second, smaller wrinkle this surfaced: naively pre-seeding
`opusActive` would make the *first real* Opus `setAudioInfo()` call see "no change" (it already matches the
hint) and skip the branch that actually populates `this.audioInfo`'s real `channelCount`/`sampleRate`-derived
fields — fixed with a companion `opusActiveIsHintOnly` flag (true until a real Opus `setAudioInfo()` call
confirms it), added as an extra `switchingCodec` condition scoped to the Opus case only, so AAC/G711/G726's
existing `switchingCodec` behavior is completely unchanged. The original mismatch guard in `setAudioInfo()` is
kept as-is, now only a fallback for a missing/wrong SDP hint rather than the primary defense.

Real camera IPs/credentials from the live report are deliberately not recorded here or anywhere else in this
repo's docs — only the codec/behavior facts, which is all a future fix or regression check would need. Docs
updated: `docs/player/05-video-player-rendering.md` (`VideoPlayer`'s `audioCodecHint` field, `VideoTagPlayer`'s
Structure field list, `init()`, and `setAudioInfo()` entries) and `docs/player/03-mediaSession-core-video.md`
(`RtpClient.sendSdpInfo()`'s per-codec bullets and `MediaRouter.handleVideoData`'s entry).

## Known bug (not yet fixed): `SunapiClient`'s digest-auth retry counter is shared instance state, not per-request

Found while investigating a downstream consumer's (`wisenet-camera-discovery`) real-device bug report: two
concurrent `SunapiManager` calls on the same client instance that both need a *fresh* HTTP Digest challenge (no
cached `authInfo` yet) can race and spuriously fail one of them with `401`.

`src/player/network/http/SunapiClient.ts`: `authInfo` (cached digest challenge: realm/nonce/nc/cnonce) and
`authCount` (line ~147, meant to cap retries to one *per logical request*) are both plain instance fields, shared
across every `.get()`/`.post()` call made through that client — there is no per-request scoping, request queue, or
lock anywhere in `SunapiClient` or `SunapiManager`. The retry flow lives in `send()`'s `case 401` handler
(lines ~592-610): on `401`, `this.authCount += 1`; if now `< 2`, retry the *same logical request* with credentials
built from the challenge; otherwise fail and reset `authCount = 0`. A successful `200` also resets it to `0`
(line ~615).

If two calls (e.g. `getDeviceInfo()` and `getCalendarSearch()`) are fired back-to-back, both without a cached
challenge, both send unauthenticated probes and both get `401` back. Whichever `401` is processed *first*
increments the shared counter to 1, sees `< 2`, and correctly retries with credentials. Whichever is processed
*second* increments it to 2, sees `< 2` is now false, and fails outright — its authenticated retry is never sent.
Which call loses is timing-dependent (an interleaving of two independent request lifecycles), not tied to a
specific endpoint. Once a challenge is cached, later concurrent calls are safe (they attach credentials on the
first attempt; the mutations to `authInfo`'s `nc`/`cnonce` are synchronous/single-threaded, not actually racy) —
so the race window is specifically "two calls both cold at once," not "any two concurrent calls."

**Not fixed here.** The downstream consumer worked around it at their call site (serializing their two
first-request calls so one warms the cache before the other fires) rather than waiting on a fix + republish of
this package. The real fix belongs here: either scope `authCount`/the retry decision per logical request (e.g. a
local variable captured in each `send()` call's own closure instead of `this.authCount`) or serialize/queue
concurrent requests through one `SunapiClient` instance. Worth doing before another consumer hits the same
intermittent failure.

## `SunapiManager` now caches digest challenges across `init()` calls (fixed: redundant OPTIONS/GET pair)

Found while investigating another downstream consumer (`wisenet-camera-discovery`) report: their SUNAPI
requests showed an `OPTIONS` preflight firing twice for what should be one logical `GET`.

Root cause: `SunapiManager.init()` always builds a brand-new `SunapiClient` (see its own doc comment on why —
a legacy quirk that made the "already initialized" branch permanently unreachable, kept as the always-taken
path), which starts with `authInfo: null`. A cold `SunapiClient` needs two real `XMLHttpRequest.send()` calls to
authenticate (unauthenticated probe → `401` → authenticated retry — see `SunapiClient`'s Call Stack in
`docs/player/02-network.md`), and each of those two sends a different non-CORS-safelisted header set
(`XClient`+`Accept` vs. `XClient`+`Accept`+`Authorization`), so the browser preflights each one separately: two
`OPTIONS` + two `GET`s for one logical call. Since `init()` is typically called repeatedly across a UI session
(every reconnect/mode-toggle in `wisenet-camera-discovery`'s case) and discarded the previous instance's
still-valid nonce every time, *every* `init()` paid this cost, not just the first ever one.

Fixed by adding a `SunapiManager.digestCache: Map<string, DigestCache>` keyed by device+user (see
`digestCacheKey()`), plus a new `SunapiClient.seedAuthInfo()`. `init()` seeds the fresh client from the cache
before its `attributes.cgi` GET, and writes back whatever challenge ends up working after success (deletes the
entry on failure). When the camera still accepts the cached nonce, this collapses the exchange to one `OPTIONS`
+ one `GET`; when it doesn't, `SunapiClient`'s ordinary `401` retry recovers exactly as it would for an unseeded
instance — no new failure mode, same worst case as before.

**Known interaction, not addressed here**: this cache is shared/global (static), and `seedAuthInfo()`'s clone
means two concurrent `init()` calls for the *same* device (e.g. two overlapping caller-side init chains, see
`wisenet-camera-discovery`'s own `sunapiInitInFlight` guard for why that can happen) would each seed from the
same cached `nc` and independently increment it, potentially sending the same `nc` value to the device twice —
a narrower variant of the concurrent-`401`-race bug documented just above. Not fixed here since it requires the
*caller* not to fire overlapping `init()`s in the first place (which `wisenet-camera-discovery` already has a
documented, not-yet-ported-here guard for); worth revisiting if a consumer without that guard hits it.

## Mouse-wheel zoom anchored on the wrong point — missing `transform-origin: 0 0` (fixed)

Reported symptom: scrolling over the video anchors zoom near the video's center instead of the mouse cursor,
even though `RTSPOverWebSocket.scrolled()` (`src/player/elements/RTSPOverWebSocket.ts:1071-1106`) explicitly
computes `zoom_target`/`pos` to keep the content point under the cursor fixed across a zoom step.

Root cause: that math is only correct if the CSS `transform: translate(...) scale(...)` applied in `update()`
(`:1108-1112`) scales the wrapper element from its top-left corner. `ensureRTSPOverWebSocketWrapper()`
(`:2337-2345`) creates that wrapper `<div>` without ever setting `transform-origin`, so it kept CSS's default
`50% 50%` (center) origin. With a center origin, the actual rendered transform is
`pos + scale*point + (1-scale)*center` — an extra `(1-scale)*center` offset `scrolled()` never accounted for —
so the zoom visibly pivots toward/away from the element's center rather than the cursor, worse the further the
cursor is from center.

Fixed by adding `transform-origin: 0 0;` to the wrapper's `cssText` in `ensureRTSPOverWebSocketWrapper()`, which
makes the DOM match the assumption `scrolled()`'s math already made. See
`docs/player/01-elements-interface-exceptions.md`'s "Geometry / interaction helpers" section for the full
derivation.

## `statistics` toggle-off required two calls to actually hide the panel — inverted boolean logic in `attributeChangedCallback` (fixed)

Reported symptom: turning `statistics` off (via the `statistics` property setter, or by removing/setting the
attribute) didn't hide the panel on the first try — it took toggling off twice before it actually disappeared.

Root cause: `attributeChangedCallback`'s `'statistics'` case (`src/player/elements/RTSPOverWebSocket.ts:542-552`)
computed `this._statistics = newValue !== 'false'` — every sibling boolean attribute (`controls`, `secure`/
`https`, `network`, `usesubstream`) instead uses `newValue === 'true' || newValue === ''`, which correctly treats
a *removed* attribute (`newValue === null`) as off. `statistics`'s inverted check treated attribute-absent as
*on*. `statisticsDiv()`'s off-path (`:2865-2877`) tears down the built DOM and then calls
`this.removeAttribute('statistics')` — which synchronously re-fires `attributeChangedCallback` with
`newValue = null`. With the old logic that flipped `_statistics` back to `true` and called `statisticsDiv()`
again, which rebuilt the very panel it had just removed (since `statisticsElement` was already null by that
point, the "already built" early-return didn't apply). So a single toggle-off left the panel rebuilt and visible;
only a second call actually hid it, because by then the attribute was already absent, so `removeAttribute()` was
a no-op and didn't re-fire the callback a second time.

Fixed by changing the case to `newValue === 'true' || newValue === ''`, matching the sibling convention. See
`docs/player/01-elements-interface-exceptions.md`'s `attributeChangedCallback` bullet for the full trace.

## Player build shipped with no sourcemaps — browser debugger only showed bundled/minified JS (fixed)

Reported symptom: after the TypeScript → JS build, the browser's DevTools debugger could only step through the
bundled (and, for `build:player`, minified) `.js` output — no way to set breakpoints in or inspect the original
`.ts` sources for `src/player`.

Root cause: none of the three Vite lib configs (`src/player/vite.config.ts`, `vite.react.config.ts`,
`vite.react-lib.config.ts`) set `build.sourcemap`, so Vite/Rollup never emitted `.js.map` files — even though
`scripts/serve-dist.js` already had `.map` registered in its `MIME_TYPES` table, ready to serve them.

Fixed by adding `sourcemap: true` to all three configs' `build` blocks — `npm run build:player` (the normal,
minified production build) now also emits `.js.map` next to every chunk, including the auto-detected Worker
chunks (`zipWorker`, `decoderWorker`, etc.). A minified bundle with a sourcemap is enough for DevTools to display
and step through the original `.ts` — no need to disable minification for that alone.

Also added `npm run build:player:dev`, which runs the same three `vite build` invocations with `--mode
development`. All three configs were converted from `defineConfig({...})` to the functional form
`defineConfig(({ mode }) => ({...}))` so they can read `mode` and set `minify: mode !== 'development'` — the only
difference between the two build scripts is minification; sourcemaps are unconditional in both. Use
`build:player:dev` when unminified, fully readable output is preferable (e.g. inspecting a Worker chunk's
generated code directly) rather than relying on sourcemap-mapped minified output.

Deliberately did **not** make `vite.react.config.ts`'s `process.env.NODE_ENV` define mode-dependent (it stays
hardcoded to `'production'` in both build scripts) — that also gates React's own internal dev-only warning code
paths, which is a separate concern from TS/JS debuggability and would change React's runtime behavior between the
two build scripts, not just its readability.

## Camera-device drag-seek landed on the wrong time — double GMT application plus a stale/wrong-format `rangeClock` (three related fixes, found live)

Reported symptom: dragging the playback timeline on a **camera** device seeked to the wrong time (hours off,
sometimes the wrong calendar day) or didn't move at all/reverted to the current position.

Three real bugs, all in the camera-only code paths (nvr's own GMT handling was never touched and is confirmed
correct/unchanged throughout):

1. **`generateRTSPURL()`'s camera/`playback` sub-case** (`src/player/elements/RTSPOverWebSocket.ts:4658-4674`) —
   `strStart` used to add `this.GMT * 3600 * 1000` on top of `this.seekingTime` whenever `this.GMT` was set (true
   for essentially every camera device — `device.ts` parses the camera's own `TimeZoneIndex` into `player.GMT`
   right after connecting). But `seekingTime` is already the target wall-clock instant, the same convention this
   exact block's neighboring `endTime`/`_currentTimestamp` handling already uses with no GMT adjustment of its
   own — adding GMT again double-counted the offset. Confirmed live: dragging to `16:31:28` under KST (+9)
   produced a URL start of `20260902013312` (next calendar day) instead of `20260901163128`.
2. **`seeking()`'s camera branch** (`:5564-5596`) used to only recompute `rangeClock` when `_useIso` was truthy
   (never set by this app's caller) — so `rangeClock` silently kept whatever stale value `speed()`'s camera
   branch had just written from the *old* `currentTimestamp`, and every drag-seek sent `Range: clock=<current
   position>-`, i.e. "resume where you already are," regardless of where the marker was dropped.
3. **Immediate follow-up to fixing (2)**: the naive fix kept `seekingTime`'s trailing `Z` (RFC 2326 `utc-time`
   grammar, matching the nvr branch right below it), but real cameras stopped playback outright on every seek
   once that shipped. Every other camera-bound clock value in this class (`generateRTSPURL()`'s own
   `strStart`/`strEnd`, `speed()`'s camera branch) strips `Z` — cameras use it for their proprietary
   `samsung-replay-timezone` RTSP extension, and only nvr's `onvif-replay` extension expects a kept `Z`. Cameras
   apparently reject/ignore a Range header in a format their own extension doesn't expect rather than degrading
   gracefully. Fixed by stripping `Z` in `seeking()`'s camera branch too, matching the rest of the camera paths.

Device-type branching for all three was **already structurally in place** before this fix (both
`generateRTSPURL()` and `seeking()` have always had separate top-level `camera` vs `nvr` branches) — no new
branching was needed, only correcting what the existing camera branches computed. See
`docs/player/01-elements-interface-exceptions.md`'s `generateRTSPURL()`/`seeking()` bullets for the full
line-referenced trace.

## Stop button didn't actually stop `<video>` playback — `startTime` setter rejected `null`, silently aborting the disconnect callback chain (fixed, plus temporary debug instrumentation)

Reported symptom (live-device investigation, 2026-09-01): clicking Stop during playback sent a real TEARDOWN
and got a real RTSP response, but the local `<video>` element kept looping whatever was already buffered —
`VideoTagPlayer.close()` never actually ran.

Root cause chain, traced with `console.log`s added across the whole teardown path:
1. The demo page's `videoControl.ts` `onstatechange()` `STOPPED` branch calls `player.startTime = null` to
   reset a finished playback's stale range.
2. `RTSPOverWebSocket`'s `startTime` setter (`src/player/elements/RTSPOverWebSocket.ts:1428-1470`) used to
   reject `null` unconditionally (`typeof v !== 'string'` throws for `null`) — unlike `endTime`'s setter right
   below it, which has always accepted `null` for exactly this reset case.
3. That setter call happens synchronously inside a `dispatchEvent` chain invoked from
   `RtspClient.connectionCbFunc()`. The thrown `RTSPOverWebSocketError` unwound back up through
   `connectionCbFunc()`, previously caught by a silent `catch { }` (legacy: swallowed after a
   `console.error`-only log) — so it aborted the rest of `connectionCbFunc()` with no visible trace, including
   the part that fires `responseDisconnectCallback`.
4. `StreamPlayer.close()`'s `Disconnect()` callback depends on `responseDisconnectCallback` firing to call
   `mediaRouter.terminate()` — which is what actually calls `VideoTagPlayer.close()` (pauses the `<video>` tag,
   tears down MSE). Since that never fired, the `<video>` element was never told to stop.

Fixed by widening `startTime`'s type to `string | null | undefined` and allowing `null` through both the type
check and the ISO-format regex check, matching `endTime`'s existing behavior.

**Temporary diagnostic `console.log`s were added and left in place** (not yet stripped, as of this writing) at:
`StreamPlayer.close()`, `RtspClient.ts`'s `RtspResponseHandler`/`connectionCbFunc()`/`Disconnect()`/
`clearTransport()`, `VideoTagPlayer.close()`, and `generateRTSPURL()`'s camera/nvr `playback` branches (the
latter logging `startTime`/`endTime`/`seekingTime` for a related, separate ongoing playback-seek investigation).
`connectionCbFunc()`'s catch block also now logs the caught error via `console.error` instead of silently
swallowing it (same swallow-and-continue behavior otherwise — this is what surfaced the `startTime` bug above).
**These are intentionally left in for an active live-device debugging session** — don't assume they're
permanent/intentional production logging if found later; strip them once the investigation concludes.

## `#speed` never reflected a device-corrected RTSP `Scale` (new feature, planned via EnterPlanMode)

Reported directly by the user with a real RTSP transcript, 2026-09-01: requesting `0.75x` playback
speed sent `Scale: 0.75` in the `PLAY` request, but the device's `200 OK` response echoed back
`Scale: 1` — it had clamped/rejected the requested speed and applied a different one instead. Nothing
in this codebase parsed a `Scale` header off an incoming RTSP response at all (grep-confirmed: `Scale`
only ever appeared in *outgoing* request-building code across `RtspClient.ts`) — the app's `#speed`
dropdown and this element's own `playSpeed` getter both kept reporting the requested value forever,
a real, silent desync from what the device was actually doing.

Fix, spanning both the RTSP response layer and the element's own speed state:
- `RtspClient.ts`'s `parseRtspResponse()` gained `Scale` parsing (`RtspResponseData.Scale`), same
  pattern as the neighboring `Session`/`Transport`/`RTP-Info` branches. Threaded through
  `RtspClientErrorEvent.scale` into the three `RtspResponseHandler()` branches that represent a
  genuine `PLAY`-method response ("RTSP Play Streaming" / "RTSP Seek Streaming", which already
  covered seek/speed/forward/backward uniformly / "RTSP Resume Streaming") — deliberately NOT the
  `PAUSE`-method branch.
- `RTSPOverWebSocket.ts`: the numeric-value -> named-speed-entry `switch` previously inline in
  `set playSpeed(v)` was extracted into `private resolvePlaySpeedEntry(v)` (both documented legacy
  truncation quirks — the `-0.125x`/`0.125x` -> `0.12` typo — preserved verbatim, not "fixed" while
  touching this code). `onRTSPOverWebSocketError()`'s `'0x0000'` case now calls it directly to
  self-correct `_playSpeed` whenever `error.scale` is present and differs from the current value —
  deliberately bypassing the public `playSpeed` setter, which calls `speed()` and would re-send a
  request for every device response, looping forever. Dispatches a new `changespeed` custom element
  event (`{ speed: this._playSpeed.value }`), matching the existing `change<Property>` pattern this
  class already uses for `changetimezone`/`changeport`/etc.
- `wisenet-camera-discovery` (the consumer, not this repo) adds the listener side —
  `onchangespeed()` in its `playback.ts`, syncing `#speed`'s displayed value.

Planned via `EnterPlanMode` before implementation (the user explicitly asked for a plan first) —
research covered the full response-parsing/self-correction/event-dispatch chain across both repos
before any code was written; see `wisenet-camera-discovery`'s own `MEMORY.md` for the consumer side
and `docs/window-ui/SRS.md` FR-7.5 v2.23 there.

## Device-clamped playback speed now self-corrects `playSpeed` instead of drifting silently (real feature/bug fix, found live)

Reported live via a real RTSP transcript: requesting an unsupported `Scale` (e.g. `0.75x` on a camera that only
supports whole-number playback speeds) got a response where the device silently applied a different Scale than
requested, but `RTSPOverWebSocket.playSpeed` kept reporting the originally-requested value — the element's own
state drifted out of sync with what the device was actually doing.

Fix, split across two files:
- `RtspClient.ts`'s `parseRtspResponse()` now parses a PLAY/SEEK/RESUME response's `Scale:` header into
  `RtspResponseData.Scale` (`:820-821`), threaded through as `RtspClientErrorEvent.scale` on the PLAY/SEEK/RESUME
  error-dispatch sites in `RtspResponseHandler()`.
- `RTSPOverWebSocket.onRTSPOverWebSocketError()`'s `0x0000` case self-corrects `_playSpeed` from `error.scale`
  when present and different from the current value — via a new private `resolvePlaySpeedEntry(v)` (the
  numeric-value → named-speed-entry lookup extracted verbatim from the `playSpeed` setter's old inline `switch`,
  legacy truncation quirks unchanged), assigned **directly to `_playSpeed`**, not through the public `playSpeed`
  setter. This distinction is load-bearing: the public setter also calls `speed()` to send a new request when
  playing, which here would just re-request the same already-rejected `Scale` the device just corrected away
  from, looping forever. Dispatches a `'changespeed'` event after the direct correction so callers still observe
  it.

See `docs/player/01-elements-interface-exceptions.md`'s `onRTSPOverWebSocketError()` bullet and
`docs/player/02-network.md`'s `parseRtspResponse()` bullet for the full line-referenced trace.

## First `forward()`/`backward()` click on a camera got RTSP `457 Invalid Range` and killed the connection — stale `scale = 0.0` bled into `seeking()` (fixed, found live via a raw RTSP trace)

Reported symptom (from `wisenet-camera-discovery`, whose window UI had just wired its `#forward`/`#backward`
buttons to this element's `forward()`/`backward()` for the first time — no caller had ever exercised these
methods against real hardware before): clicking Forward/Backward during camera playback produced no video at
all. The browser console showed a `close()` → `Disconnect()` → full reconnect (fresh `OPTIONS`/`DESCRIBE`/
`SETUP`) loop, retrying identically and never succeeding.

Root cause, found by asking the reporter to open the UI's own RTSP-traffic panel and capture the raw request/
response text (not by guessing from the console trace alone): the first `forward()`/`backward()` click on a
camera doesn't send `forward()`'s/`backward()`'s own PLAY at all. `MediaSession/MediaRouter.ts`'s
`sendCommandData('forward'/'backward', ...)` only calls `player.forward()`/`.backward()` (the canvas renderer's
real per-frame step) once its local frame buffer is primed (`stepFlag === true`); on the very first call
(`stepFlag === false`) it instead calls `stepRequest()`, whose `'request'` callback
(`onRTSPOverWebSocketStep()` in this file) calls `seeking()` to prime that buffer via a small backward re-seek.

`forward()`/`backward()` each set `this.info.media.requestInfo.scale = 0.0` for their **own** eventual PLAY —
tagged with a `'forward'`/`'backward'` direction hint so `RtspClient.ts`'s `toStringExtensionScale()` serializes
it as the camera-recognized `Scale: +0.00`/`Scale: -0.00` (`:729-736`). But `seeking()` never touched
`requestInfo.scale` at all, so that `0.0` was still sitting there when `stepRequest()`'s fallback called
`seeking()` instead — and `seeking()`'s own `scaleHeaderOrDefault()` call passes no direction hint, so the same
`0.0` serialized as a bare, unsigned `Scale: 0.00`. Confirmed directly in the captured trace: the failing PLAY
had `Rate-Control: yes` / `Scale: 0.00` / `Range: clock=...` and, tellingly, **no** `Immediate: yes` — proof it
was `seeking()`'s request (`needToImmediate = false`), not `forward()`'s own (`needToImmediate = true`). Real
hardware rejected the unsigned `Scale: 0.00` + clock Range combination with `457 Invalid Range`, and the client
tore the connection down and retried the identical broken sequence every time.

Fix: `seeking()` now unconditionally resets `requestInfo.scale = 1` up front, before either its `INSTANTPLAYBACK`
or camera/nvr branch — it's always a plain "jump to this time, keep playing at normal speed" operation and must
never depend on whatever `scale` some earlier, unrelated request (`forward()`/`backward()`/`speed()`) left
behind on the shared `requestInfo` object. This is the same class of bug as the two `seeking()` fixes documented
above (a stale field on the shared `info.media.requestInfo` object read by a caller that assumed it owned that
field) — `scale` simply hadn't been hit by it yet because nothing had ever called `forward()`/`backward()` for
real before.

See `docs/player/01-elements-interface-exceptions.md`'s `seeking()` bullet for the full line-referenced trace.

## TEARDOWN's belt-and-suspenders disconnect trigger raced the real response (fixed)

Found live (2026-09-02, wisenet-camera-discovery playback Stop button): the RTSP wire log sometimes showed a
`TEARDOWN` request with no `200 OK` ever logged for it before the connection dropped — intermittent, not every
time. Root cause in `RtspClient.ts`'s `_send()`: right after sending TEARDOWN, it armed a `setInterval` polling
every **500ms** that force-called `clearTransport()` (which synchronously disconnects the transport) as soon as
`currentState === 'Playing' && nextState === 'Teardown'` was true — with no check for whether the real response
had actually arrived yet. Normally the response arrives well inside 500ms and `RtspResponseHandler`'s own
Playing+Teardown branch (`handleResponse200`) wins the race, calling `clearTransport()` first. But when the
camera's TEARDOWN response is merely slow (observed on recording/playback sessions specifically, not live) rather
than absent, the poll's first tick fires anyway and tears the transport down before the in-flight `200 OK` can be
processed — a real reply from the camera, silently discarded by the client's own timing.

Fix: replaced the repeating 500ms poll with a single 5s `setTimeout` (`teardownWatchdogHandler`), and
`clearTransport()` now unconditionally cancels it on entry — from whichever path reaches `clearTransport()` first
(the response-driven path, or the fallback timer itself), so the loser of the race never fires. 5s was picked to
comfortably clear a slow-but-real response while still being a meaningfully bounded fallback for a response that
truly never arrives (dropped packet, server hang) — the original intent of the timer, preserved, just no longer
trigger-happy. See `docs/player/02-network.md`'s `_send()`/`clearTransport()` bullets and History table for the
line-referenced detail.

## `#renderer_type` "canvas" silently ignored for H265 cameras — `defaultVideoTagMode` only checked on the H264 side of `selectVideoPlayer`'s MSE-supported branch (fixed)

Reported symptom: selecting `#renderer_type` "canvas" (the caller-facing `wisenet-camera-discovery` control that sets
`RTSPOverWebSocket.type` → `MediaRouter.defaultVideoTagMode` via a `'changeVideoMode'` worker command) had no effect
— the player kept rendering through a `<video>` tag regardless.

Root cause: `MediaRouter.ts`'s `selectVideoPlayer()` (`:1420-1526`) picks `tagMode` per codec. Its
`case 'H264': case 'H265':` block branches on whether the browser's `MediaSource.isTypeSupported()` accepts the
negotiated codec's mime type (true on essentially any modern Chrome/Edge with hardware HEVC decode). Inside that
`if (mediaSourceIsTypeSupported)` branch, `defaultVideoTagMode` used to only be read `if (codecType === 'H264')`
— H265 fell straight to an unconditional `else { this.tagMode = 'video'; }`, never even looking at
`defaultVideoTagMode`. `docs/player/03-mediaSession-core-video.md`'s `selectVideoPlayer` entry already *documented*
`defaultVideoTagMode` as taking priority "on both sides of the MSE-support check" (written when the no-MSE-support
branch was fixed to honor it for both codecs, 2026-08-26) — that claim was simply never true for this specific
combination (MSE-supported + H265), a doc/code mismatch that went unnoticed until a real camera (which negotiates
H265 as its primary track) hit it.

Fix, two parts (the second found immediately after the first, via the same user's own read of the diff):
1. Moved the `defaultVideoTagMode !== null` check to wrap both codec cases (matching the no-MSE-support branch's
   existing shape just below it), so an explicit override is honored for H265 too.
2. With no override, H265 still unconditionally got `'video'` — no principled reason for that asymmetry (the
   no-MSE-support branch already lets H265 reach `'canvas'`, gated only by SPS profile being `'Main'`, a
   decode-capability check that doesn't apply to this branch's own MSE-native decode path). Folded H265 into
   H264's existing `deviceType === 'nvr'`/size (`LIMIT_SIZE[playMode]`) auto-detect heuristic instead of keeping a
   separate `codecType === 'H264'` guard — inside this `case 'H264': case 'H265':` block, that guard's `else`
   could only ever mean "codecType is H265" anyway, a tautological condition that was hiding what was actually an
   unprincipled codec-specific carve-out.

See `docs/player/03-mediaSession-core-video.md`'s `selectVideoPlayer` bullet and History table for the
line-referenced detail.

## `forward()` computed a *camera* device's current time from GMT-adjusted `_localTimestamp` instead of `currentTimestamp` (fixed, found live)

Found by the user while reading `forward()`'s source (not a reported runtime symptom): its non-seeking-time
`currentDateTime` computation (`:5403-5411`) checked `this.GMT` before even knowing `_deviceType` —

```ts
if (typeof this.GMT !== 'undefined' && this.GMT !== null) {
  currentDateTime = new Date(this._localTimestamp as string);
} else {
  currentDateTime = new Date(this.currentTimestamp as string);
}
```

GMT/`_localTimestamp` substitution is an **nvr-only** concept everywhere else in this class — `seeking()`'s own
camera branch (see the fix above) never touches `GMT` at all, always using `currentTimestamp` (or `seekingTime`)
directly, precisely because `device.ts` parses a *camera's* own `TimeZoneIndex` into `player.GMT` too, not just
nvr's, so a plain `typeof this.GMT !== 'undefined'` check can't distinguish "this is an nvr, adjust for its GMT"
from "this happens to be a camera that also reports a GMT." Fixed by gating on `this._deviceType === 'nvr'`
first, matching `seeking()`'s existing split. Note this only affects the *computed* `isoTimeString`/
`currentDateTime`, which (like the rest of `forward()`'s non-nvr branch) camera devices never actually send in
their outgoing request (`rangeClock` stays untouched, "legacy: no-op", for camera) — so this bug was invisible
in real RTSP traffic and only surfaced by inspecting the source directly (and, incidentally, in this session's
newly-added `console.log` tracing of `isoTimeString`, added in the same change below). `backward()`'s equivalent
block never had this GMT check to begin with, so needed no corresponding fix.

Also added (at the user's own request, to keep verifying future fixes in this area against real hardware): a
`console.log` in both `forward()` and `backward()`, right before `player.control(info)`, dumping
`deviceType`/`currentTimestamp`/`localTimestamp`/`isoTimeString`/`rangeClock`/`scale`/the final `url`.

See `docs/player/01-elements-interface-exceptions.md`'s `forward()`/`backward()`/`seeking()` bullet and History
table for the line-referenced detail.

## `forward()`/`backward()`'s first-click buffer-priming re-seek landed ~9 hours off under KST — local-timezone formatting fed into a UTC-labeled camera clock string (fixed, found live via a raw RTSP trace)

Reported symptom, with a full raw RTSP capture: after the `seeking()`-`scale`-reset fix above landed, the very
next real-camera test of `forward()`/`backward()` still failed with `457 Invalid Range` on the *reconnect's*
initial `PLAY` (not the seek itself) — `Range: clock=20260902043459-` against a `currentTimestamp` around
`19:35:...`, an almost-exactly-9-hour gap (this machine's own KST, UTC+9, offset).

Root cause: `onRTSPOverWebSocketStep('request')` (the `stepRequest()` fallback `forward()`/`backward()` route
through on their first click per device, before a local frame buffer is primed — see the entry above) computes
its `-2000ms` re-seek target and formats it with `util/dateFormat.ts`'s `toYYYYMMDDHHMMSS()`:

```ts
export function toYYYYMMDDHHMMSS(date: Date): string {
  return String(date.getFullYear()) + pad2(date.getMonth() + 1) + pad2(date.getDate()) + pad2(date.getHours()) + pad2(date.getMinutes()) + pad2(date.getSeconds());
}
```

That function's own doc comment is explicit: it formats in the **local** timezone, ported deliberately from the
legacy player's `Date.prototype` patch, with no GMT/offset correction — a genuinely intentional, documented
behavior for whatever it was originally built for, not a bug in the shared utility itself. But every
camera-bound clock string this class builds *elsewhere* represents a UTC-labeled instant as UTC-labeled digits
(stripped from a `.toISOString()` call, e.g. `seeking()`'s own camera branch just above, `generateRTSPURL()`'s
`strStart`/`strEnd`). Feeding a UTC-internal `Date` through `toYYYYMMDDHHMMSS()`'s local getters produced digits
shifted by this machine's own UTC offset before the string ever reached `seeking()`'s already-correct stripping
logic — under KST that's +9 hours, exactly matching the captured trace. The camera rejected the resulting
clearly-implausible Range as invalid, tearing the connection down with no video ever playing. Compounding it:
`play()`'s own camera branch never sets `requestInfo.rangeClock` at all ("legacy: no-op" — untouched, correctly,
by this fix), so the same wrong value could persist and resurface on a subsequent reconnect's fresh `PLAY` too,
which is the specific request the captured trace showed failing.

Fixed at the call site, not in `toYYYYMMDDHHMMSS()` itself (its local-timezone contract stays intentional for any
other caller): `onRTSPOverWebSocketStep('request')` now builds `_seekingTime` as
`targetDateTime.toISOString().split('.')[0] + 'Z'` — the same shape (`'...T...Z'`, no milliseconds) the
already-working `onCustomTimeSeek()` (this repo's own caller in `wisenet-camera-discovery`) uses for its
`seekingTime` assignments, so it lands in `seeking()`'s existing camera-branch stripping logic in the exact form
that logic already handles correctly, rather than introducing yet another ad hoc format. Removed the now-unused
`toYYYYMMDDHHMMSS` import from `RTSPOverWebSocket.ts`.

See `docs/player/01-elements-interface-exceptions.md`'s `onRTSPOverWebSocketStep` bullet and History table for
the line-referenced detail.

## A stuck `_seekingTime` from one interrupted `seeking()` call silently corrupted the start time of every *later, unrelated* camera playback search (fixed)

Reported symptom: after the UTC fix above landed, the very next real-camera test (a fresh Selected Time search,
`06:07:31`–`06:11:32`, nothing to do with `forward()`/`backward()`) produced a playback URL starting at
`2026-09-01T21:07:31` instead — the previous evening, ~9 hours before the requested start, with the *end* time
(`06:11:32`) correct. Requested by the user: audit every time-handling path in `play()`/`seeking()`/
`forward()`/`backward()`/`pause()`/`resume()`/`speed()`, not just the one function just touched.

Root cause, unrelated to the UTC-vs-local fix above (this bug predates it — the same failure mode could already
happen from *any* exception mid-`seeking()`, on any earlier call): `seeking()` used to clear `_seekingTime` only
at the very end of the method, *after* `generateRTSPURL()`/`player.control()` had already run. Any exception
thrown in between left it stuck at whatever value it held. `generateRTSPURL()`'s camera-playback branch always
prioritizes `this.seekingTime` over `_currentTimestamp`/`startTime` when it's non-null — so a value stuck from
one earlier, interrupted seek (most likely the evening-before `forward()`/`backward()` test session, itself
prone to interruption via the connection-teardown/reconnect cycles documented in the entries above) kept
silently overriding the start time of every *subsequent, otherwise-correctly-configured* `play()`/`resume()`/
`seeking()` call — including completely unrelated future searches — until the app happened to be reloaded or
some other path incidentally cleared it.

Fixed by wrapping `seeking()`'s entire body (after the two precondition checks) in `try { ... } finally {
this._seekingTime = null; }`, guaranteeing the reset on every path out of the method, success or failure — not
just the success path that happened to reach the old clear site.

See `docs/player/01-elements-interface-exceptions.md`'s `seeking()` bullet and History table for the
line-referenced detail.

## `_localTimestamp` was never actually GMT-shifted — silently identical to `_currentTimestamp`, breaking every nvr branch that subtracts GMT back off it (fixed)

Found by the user, who stated this class's own contract precisely and asked whether `generateRTSPURL()`'s
camera/nvr handling was correct against it: `currentTimestamp` represents GMT-0/UTC; `_localTimestamp`
represents that *same instant, shifted to the device's own local wall clock*. Checking `onRTSPOverWebSocketTimestamp()`
against that contract turned up a real, previously-undiscovered bug with wide blast radius:

```ts
const curDate = new Date(timestamp.timestamp * 1000 + timestamp.timestamp_usec);
this._currentTimestamp = curDate.toISOString();          // correct: GMT-0/UTC

let localTimestamp: Date | undefined;
if (typeof this.GMT !== 'undefined' && this.GMT !== null) {
  timestamp.timezone = this.GMT * 60;
  this._localTimestamp = curDate.toISOString();           // BUG: no offset applied at all
}

if (timestamp.timezone !== null && timestamp.timezone !== undefined) {
  this.timezone_offset = timestamp.timezone / 60;
  localTimestamp = new Date(curDate.valueOf() + this.timezone_offset * 3600 * 1000);  // correct value, but a DIFFERENT (local, lowercase) variable
}
```

`this._localTimestamp` was assigned the exact same unshifted `curDate.toISOString()` as `_currentTimestamp` —
always byte-identical to it, regardless of `GMT`. A few lines below, the *correctly* GMT-shifted value was
computed as `localTimestamp` (a local variable, easy to conflate with the instance field at a glance since only
an underscore and a `this.` distinguish them), but that was only ever consumed by the dispatched `timestamp`
event's `local` field and a debug `timestampElement` display — nothing wrote it back to `this._localTimestamp`.

Every nvr branch across this class that reads `this._localTimestamp` — `pause()`, `resume()`, `speed()`,
`forward()`, `backward()`, all documented in the entries above — does `new Date(this._localTimestamp).getTime()
- timezone` (where `timezone = this.GMT * 3600 * 1000`), i.e. "this is already shifted forward by GMT, subtract
it back off to recover true UTC for the outgoing `rangeClock`." With `_localTimestamp` never actually shifted
forward in the first place, that subtraction didn't recover true UTC — it moved the value an *additional* GMT
offset away from correct, in the opposite direction from what every one of those call sites intended. This bug
predates every fix in this file's history above; those all happened to land on camera-only code paths (where
`_localTimestamp` is barely used) or on `forward()`'s specific camera-vs-nvr gating bug, so this deeper,
nvr-wide issue went unnoticed until the user asked the precise question that exposed it.

Fixed by writing the already-computed, correctly-shifted `localTimestamp` back to `this._localTimestamp`
(instead of the unshifted `curDate` copy), still gated on `GMT` being explicitly set to match the original
guard's intent. The dispatched event and debug display are unaffected — they already used the correct local
variable.

See `docs/player/01-elements-interface-exceptions.md`'s `onRTSPOverWebSocketTimestamp` bullet and History table
for the line-referenced detail.

## `generateRTSPURL()`'s nvr URL-path `timezone` variable was dead code, not a bug — confirmed correct, then cleaned up

The user asked whether `generateRTSPURL()`'s nvr `playback`/`backup` `strStart`/`strEnd` construction (the two
branches gated on `typeof this.GMT !== 'undefined'`) was correct. It computed `const timezone = this.GMT * 3600 *
1000` and then explicitly discarded it (`void timezone;`) without ever applying it to `strStart`/`strEnd` — both
branches (GMT set or not) end up producing an unshifted value from `this.startTime`/`this.endTime`. Confirmed
this is actually correct, not a bug: `startTime`/`endTime` digits already represent the intended wall-clock
instant (the same "digits ARE the local time, `Z` is just a label" convention `seekingTime` uses throughout this
class, e.g. the camera drag-seek fixes above) — applying `timezone` here would reintroduce the exact
double-GMT-application bug already fixed elsewhere in this file (see "Camera-device drag-seek landed on the
wrong time" above), just on the nvr URL-path side instead of the camera `rangeClock` side. The `T`/trailing `Z`
staying in the output (unlike camera's own `strStart`/`strEnd`, which strip both) is also correct as-is — nvr's
`onvif-replay` RTSP extension expects that literal format, unlike camera's proprietary
`samsung-replay-timezone` one.

The dead `timezone` computation was very likely left over from whatever earlier fix removed its application —
same shape as this file's other "compute, then apply, found live to double-shift, remove the apply" fixes, just
missing its own final cleanup step. Removed at the user's request once confirmed harmless; no behavior change.

See `docs/player/01-elements-interface-exceptions.md`'s `generateRTSPURL()`-related History entries for the
line-referenced detail.

## `_useIso`/`useIsoTimeFormat` removed entirely — its `true` state was a dead camera TODO stub, and its only real nvr effect had no reason to be configurable

The user asked, while reviewing every `rangeClock`/`generateRTSPURL()` site across `play()`/`pause()`/
`resume()`/`speed()`/`forward()`/`backward()`/`seeking()`/`startBackup()` for possible consolidation,
whether `_useIso` was actually necessary. Re-reading all nine sites that branched on it (`generateRTSPURL()`'s
camera `playback`/`backup` branches, its nvr no-GMT `strStart`/`strEnd`, and the no-GMT branch of every
trick-play method above) found:

- **Camera**: `_useIso === true` was a literal `// TODO: camera iso time style generate (legacy:
  unimplemented)` no-op in both of `generateRTSPURL()`'s camera branches — checking it produced a URL
  with **no start/end embedded in the path at all**. `seeking()`'s own camera branch had already been
  fixed earlier this session to ignore `_useIso` entirely (always recomputes from `seekingTime`), so by
  this point the flag was actively harmful in the one place a caller could still reach it, and simply
  inert everywhere else for camera.
- **nvr**: contrary to an initial (incorrect) assumption made partway through this same review, `Z` is
  present in the output regardless of `_useIso` — neither the `true` nor `false` shape strips it, since
  the source value already ends in `Z` and neither regex chain touches that character. The *only* real
  difference was whether the milliseconds fraction survived (`true` dropped it via `.split('.')[0]`,
  `false` kept it) — a distinction with no known real-device rationale; the RFC 2326 `utc-time` grammar's
  fraction is optional, and no RTSP trace captured this session (from either camera or nvr) ever showed
  or needed one.

Decision, made with the user: delete `_useIso` and its public `useIsoTimeFormat` accessor entirely, and
make every one of its nine branch sites unconditionally behave the way `true` already did — the real
`generateRTSPURL()` camera implementation (not the TODO stub) and the fraction-dropping nvr shape,
everywhere. `GMT`-present branches (a completely separate axis — `GMT` performs a real timezone
subtraction and always adds `Z`; `_useIso` never did any numeric conversion, only ever affected fraction
presence) are untouched.

`pause()`'s `.slice(0, 16)` (vs `20` everywhere else) and `startBackup()`'s already-byte-identical
`true`/`false` branches (a pre-existing dead-branch duplication, found the same session) were left as
found — real, separate inconsistencies, not part of this specific change's scope.

The consuming app's `#iso_date_time_checkbox` (`wisenet-camera-discovery`, added for FR-7.7.1 to work
around what turned out to be a *different*, already-fixed bug in this same file) is removed in the same
change — see that repo's own `MEMORY.md`.

See `docs/player/01-elements-interface-exceptions.md`'s Method Analysis bullets and History table for
the line-referenced detail.

## `GMT` now unconditionally defaults to `0` — every "GMT unset" fallback became a throw instead of silently different math

Following on directly from removing `_useIso` above, the user asked for `GMT` itself to stop being able to
represent "unknown" (`null`) at all: it should unconditionally default to `0` (UTC) instead, and every
`typeof this.GMT !== 'undefined' && this.GMT !== null` check's `else` branch — previously a second,
separately-computed code path for "GMT unknown" — should stop existing as a silent fallback. Asked to
clarify what "stop existing" meant (delete outright vs. something else), the user's answer was explicit:
**turn each `else` into a `throw`**.

Rationale (confirmed with the user): historically `_gmt` genuinely started as `null` because it was
unknown until a device's `TimeZoneIndex` populated it after connecting, and every one of these `else`
branches was a real, load-bearing "GMT not known yet" fallback computing `rangeClock`/timestamps a
different way (e.g. from `currentTimestamp` instead of `_localTimestamp`, with no timezone subtraction).
Once `GMT` always has a real default, reaching one of these `else`s during normal operation no longer
means "legitimately unknown" — it means something upstream already broke (the setter's `v === null` path,
or the `'gmt'` attribute being cleared, both of which used to reset `_gmt` back to `null` and are now
normalized to `0` instead, closing off the only two reachable ways back to a falsy `GMT` through the public
API). Silently computing different, unaudited math for a state that should no longer occur risks masking a
real bug behind output that merely looks plausible; throwing (`errorCode: 0x0414`, the same code the `GMT`
setter itself already used for invalid input) surfaces it the same way this class already does for its
other precondition failures (e.g. `play()`'s `startTime === null` → `0x0411`).

Two sites needed individual judgment instead of the mechanical `else → throw` swap:

- **`onRTSPOverWebSocketTimestamp()`** (the `'time'` player callback) fires on essentially every rendered
  frame — a hot path, not a caller-triggered precondition check. Throwing there on every frame the moment
  `GMT` was ever transiently unset would be far more disruptive than failing one `play()`/`seeking()`/etc.
  call. Simplified instead: the `hasExplicitGMT` guard that used to gate whether `_localTimestamp` got
  written was removed entirely (now unconditional, matching `GMT` always being defined), and the debug
  `timestampElement` display's parallel GMT-unset fallback branch (a third, mostly-redundant timezone
  computation) was deleted the same way, since it was equally unreachable once `GMT` can't go missing.
- **`update()`'s mouse-wheel/click-to-seek handler** *was* converted to the same `else → throw` pattern as
  every other site, for consistency — but it's flagged separately because it's the one throw-converted site
  reachable directly from a live end-user gesture (drag/click-to-seek) rather than purely internal
  request-building (every other site only runs inside `play()`/`seeking()`/`forward()`/etc., triggered by
  this app's own call sites, never raw user input). If this specific throw is ever observed firing against
  real hardware, that's worth a closer look before assuming the fix is simply "working as intended" the way
  the other 10 sites are.

`backup()`'s `info.device.gmt = this.GMT` assignment had no prior `else` at all (it just skipped setting the
field) — simplified to unconditional, no throw needed since there was never a fallback behavior to replace.

Deferred, not part of this change (raised by the user as a related idea, judged separately in scope):
normalizing `startTime`/`endTime`/`seekingTime` through a GMT-conversion function at the setter level, so
every read site could stop doing its own `.getTime() - timezone` math. This would be a substantially larger
change — it changes what those setters *store*, not just what they *validate* — better landed as its own
follow-up once this change has had a chance to prove out.

See `docs/player/01-elements-interface-exceptions.md`'s Method Analysis bullets and History table for the
line-referenced detail.

## Camera pause/resume playing `GMT` hours in the past — `generateRTSPURL()`'s `strStart` fallback used the one value in its branch that wasn't already local-shifted

Reported live: on a GMT+9 camera, pause then resume (no drag-seek in between) played back exactly 9
hours earlier than the actual pause point.

`generateRTSPURL()`'s camera `playback` branch builds `strStart` from up to two sources: `seekingTime`
(if set, takes priority) and a fallback used otherwise. Both `seekingTime` and `endTime` in this branch
are deliberately embedded **with no GMT shift applied here** — a real bug fixed earlier the same day
established that they arrive from the caller (`wisenet-camera-discovery`'s `playback.ts`) already
converted to local-wall-clock digits (`moment(...).utcOffset(state.localGmtOffset).format(...) + 'Z'`
for camera devices) — adding GMT again there double-shifted them into the future. See "Camera-device
drag-seek landed on the wrong time" above.

The fallback (used whenever `seekingTime` is unset — i.e. a plain pause→resume with no seek) read
`this._currentTimestamp` instead. Unlike `seekingTime`/`endTime`, `_currentTimestamp` is **not**
caller-supplied — it's set internally by `onRTSPOverWebSocketTimestamp()` directly from the device's own
raw timestamp, and per this class's own confirmed contract (`currentTimestamp` is GMT-0/UTC,
`_localTimestamp` is that instant shifted to local wall clock — see the `_localTimestamp` fix entry
above) it holds true UTC digits, not local ones. Embedding it with the same "no shift, digits are
already local" treatment as `seekingTime`/`endTime` was therefore wrong specifically for this one value:
a KST (+9) pause point of local 14:00 (UTC 05:00) got embedded literally as `...T050000` (UTC's own
digits), which the camera's `samsung-replay-timezone` extension reads as **local** 05:00 — exactly 9
hours before the real local pause point of 14:00.

Fixed by reading `this._localTimestamp` instead of `this._currentTimestamp` — the same instant, already
GMT-shifted to local wall clock by `onRTSPOverWebSocketTimestamp()` (see the `_localTimestamp` fix entry
above; that fix is what made `_localTimestamp` actually reliable here) — matching the convention every
other value in this branch already follows. Camera `pause()`/`resume()` do no GMT math of their own at
all ("legacy: no-op" for camera devices — see their own Method Analysis entries), so this single line in
`generateRTSPURL()` was the entire source of truth for where a camera resumes playback.

Also added temporary `console.log('[pause]/[resume] request:', ...)` diagnostic tracing to both methods
(device type, `GMT`, `currentTimestamp`, `localTimestamp`, computed `rangeClock`/`url`) while
investigating this — same pattern as `forward()`/`backward()`'s existing debug logs, kept for future
GMT-related reports in this area.

See `docs/player/01-elements-interface-exceptions.md`'s Method Analysis bullets and History table for the
line-referenced detail.

## `startTime`/`endTime`/`seekingTime` normalize to canonical UTC at the setter — `coordinatedUniversalTime` removed

Directly requested by the user, following on from the two camera-vs-nvr GMT-direction bugs fixed
earlier the same day (`seekingTime` double-shifted +9h into the future on camera drag-seek;
`generateRTSPURL()`'s `_currentTimestamp` fallback landing camera pause/resume 9h in the past). Both
bugs traced back to the same root cause: `startTime`/`endTime`/`seekingTime`'s setters stored
whatever string a caller passed *verbatim*, with no interpretation at all — so every *consumption*
site elsewhere in the class had to separately know, per device type, whether the stored digits were
already true UTC (nvr's caller convention) or pre-shifted to local wall clock (camera's caller
convention), and apply the opposite conversion to recover the other. Any site that guessed wrong
shifted an instant by a full `GMT` in the wrong direction.

The fix moves that interpretation to exactly one place: the setter itself. A new private
`normalizeTimeInputToUtcIso()` decides, per input string, which of two shapes it's in — an explicit
timezone designator (`Z` or `±HH:MM`/`±HHMM`) is trusted as-is via standard ISO parsing (the string
already unambiguously names an instant); a **naive** string (no designator at all) is treated as
local wall-clock digits in the `GMT` zone and converted to true UTC by subtracting `GMT` hours. This
decision (trust an explicit offset vs. always convert via `GMT` regardless) was made with the user
via `AskUserQuestion` — the alternative (ignore any embedded offset, always use `GMT`) was
considered but rejected in favor of standard ISO semantics whenever a string is self-describing.

All three properties are therefore unconditionally true UTC internally from this point on, no
matter what shape a caller supplied or what device type is in play. This does **not** eliminate the
camera/nvr distinction everywhere in the class — the wire protocols genuinely differ (camera's
`samsung-replay-timezone` extension wants local-wall-clock digits with `T`/`Z` stripped; nvr's
`onvif-replay` extension wants true-UTC digits with `Z` kept, RFC 2326 `utc-time` grammar) — but it
confines that distinction to exactly one place per method, the final wire-serialization step, not
the interpretation of what was stored:

- Every nvr site that used to subtract `GMT` from a stored value to "recover" true UTC
  (`play()`/`resume()`/`speed()`/`forward()`/`backward()`/`startBackup()`) now simply uses it
  directly — the subtraction was undoing a pre-shift that no longer happens.
- Every camera site — confined entirely to `generateRTSPURL()`'s `playback`/`backup` branches and
  `seeking()`'s camera branch, since camera `pause()`/`resume()`/`speed()`/`forward()`/`backward()`/
  `startBackup()` are documented no-ops that rely on `generateRTSPURL()` being re-called for their
  actual wire value — now explicitly shifts the stored true-UTC value forward by `GMT` before
  stripping punctuation, since storage is no longer pre-shifted to local wall clock for it.

`coordinatedUniversalTime` (a public getter/setter + `_coordinatedUniversalTime` field, backing a
manual toggle that already partially anticipated this: `true` meant "treat `startTime`/`endTime` as
already UTC, skip the subtraction," `false` — the default — meant "subtract `GMT`") is removed
entirely, in the exact same shape as this session's earlier `_useIso` removal: once storage is
unconditionally true UTC, `true`'s behavior is the only correct one everywhere the flag was checked,
so every gated branch collapses to that shape unconditionally. Its UI counterpart in
`wisenet-camera-discovery`, the `#universaltime_checkbox` ("Coordinate UTC Time") and
`device.ts`'s `set_use_universal_time()`, are removed in the same change — see that repo's own
`MEMORY.md`.

`handleDoubleClick()`'s click-to-seek handler (the class's actual mouse-wheel/double-click seek
gesture — an earlier History entry mislabeled it "`update()`'s mouse-wheel handler"; the real
mouse-wheel handler, `scrolled()`, is an unrelated pan/zoom feature) needed its own fix as a direct
consequence: its formula used to shift `_localTimestamp` (already local wall clock) forward by `GMT`
*again* on top of the click delta, producing a `Z`-suffixed string — under the old "store verbatim"
setter contract this ambiguity was silently absorbed by whichever consumption site read it back, but
under the new "trust an explicit `Z` as literal true UTC" contract it would have been a genuine
double-shift. Fixed to compute from `_currentTimestamp` (already true UTC) plus only the click delta
— `GMT` no longer has any part in this specific computation, so the GMT-unset throw added at this
site earlier the same day (see the `GMT` default-and-throw entry above) was removed too, since
there's nothing left to guard.

Two pre-existing test gaps in `src/index.html`'s own suite were found and fixed while touching this
area (both dated from the earlier `GMT` default-to-`0` change, missed at the time): `el.GMT = null`
was still asserted to produce `null` (now `0`), and `attributeChangedCallback`'s `'gmt'` "null"
string case was still asserted to produce `null` too (now `0`). The `seekingTime` operator-precedence
bug (preserved — the format-validation regex still never actually runs) meant a non-ISO string used
to echo back verbatim; it now throws instead, since `normalizeTimeInputToUtcIso()` runs regardless of
that dead validation branch and rejects an unparseable string on its own.

Not verified against real hardware — WSL2 can't reach real devices (see `CLAUDE.md`). This is a
foundational, wide-blast-radius change touching nearly every playback-control method; flagged to the
user that real-device testing (both a camera and an nvr, `GMT ≠ 0`) is needed before considering this
done.

See `docs/player/01-elements-interface-exceptions.md`'s new "Time normalization" Method Analysis
section and History table for the line-referenced detail.

## Camera fresh-Play sending a URL with no start time at all — a same-day regression from the `_currentTimestamp` → `_localTimestamp` fix

Reported live, immediately after the `startTime`/`endTime`/`seekingTime` normalization above shipped:
a real device's RTSP `OPTIONS` request showed `.../recording/-20260902090643/OverlappedID=0/play.smp`
— no digits before the `-`, meaning `strStart` was `undefined` — despite `startTime`/`endTime` both
being set correctly (confirmed via the existing `console.log('[generateRTSPURL] camera playback
times:', ...)` diagnostic).

Root cause: `generateRTSPURL()`'s camera `playback` branch only ever computed `strStart` from two
sources — `_localTimestamp` (an already-flowing stream's live position) or `seekingTime` (an
explicit seek target) — with no fallback to `startTime` at all. This was fine under the *original*
code, which read `_currentTimestamp` instead of `_localTimestamp` here: `_currentTimestamp` is
always mirrored from `_startTime` the instant `startTime`'s own setter runs
(`this._currentTimestamp = this._startTime;`), so it was reliably populated even before any playback
had started. `_localTimestamp`, by contrast, is *only* ever written by a live `'timestamp'` player
event (`onRTSPOverWebSocketTimestamp()`) — on a fresh Play, before the very first frame has arrived,
it's still `null`. Swapping `_currentTimestamp` for `_localTimestamp` earlier the same day (to fix
the camera pause/resume "9 hours in the past" bug — `_currentTimestamp` is true UTC and was being
read as if pre-shifted to local, `_localTimestamp` actually is) fixed that bug correctly but silently
removed the only reliable `strStart` source for the fresh-Play case, since nothing else in that
branch ever read `startTime` at all.

Fixed by adding `startTime` (now unconditionally true UTC per the setter-normalization change above,
so it needs the same `+GMT` reshift as the other camera-branch values) as a fallback, checked *after*
`_localTimestamp` — priority order is now `seekingTime` (highest, explicit intent) >
`_localTimestamp` (live position, once a stream exists — needed so pause/resume/speed changes resume
from *where playback currently is*, not the original search start) > `startTime` (fresh-Play
fallback, lowest priority, only reachable before `_localTimestamp` has ever been populated).

Caught quickly because the diagnostic `console.log` added earlier this session for exactly this
branch was still in place — worth remembering as a pattern: this file's GMT/timing logic has enough
subtle cross-dependencies (a fix for one call path silently removing the only working fallback for
another) that keeping temporary diagnostic logging in place through a cluster of related fixes, not
just the first one, keeps paying off.

See `docs/player/01-elements-interface-exceptions.md`'s "Time normalization" Method Analysis section
and History table for the line-referenced detail.

## Step-forward/backward crashing on `null` player — a covert-mode teardown independent of `stepFlag`/readyState (fixed)

Reported by a consumer app (`wisenet-camera-discovery`) from a live console trace: clicking
frame-forward repeatedly during camera playback eventually threw
`TypeError: Cannot read properties of null (reading 'forward')`, stack rooted at
`MediaRouter.ts`'s `sendCommandData()` `'forward'` case, immediately after an `H265 Decoder close`
log line.

Root cause: `sendCommandData()`'s `forward`/`backward` cases were the only two cases in that
`switch` written as `this.player!.forward()`/`.backward()` — a non-null *assertion*, not a guard —
while every sibling case (`capture`, `pause`, `resume`, `digitalZoom`, …) checks
`this.player !== null` first. `MediaRouter.onWaiting()` (the RTP-packet-loss handler) can `close()`
and null `this.player` at any time a video packet is reported lost, gated only on
`supportCovertAndOff` — entirely independent of `stepFlag`/the step-request state machine that
`forward`/`backward` otherwise reason about. A step click landing in that window hit the null
assertion instead of a guard.

The consumer's own trace also explained a secondary symptom they'd noticed: Pause/Resume buttons
flipping to "playing" mid-crash-cluster. That's unrelated to `MediaRouter.player` — it's
`RTSPOverWebSocket._readyState` reacting to the camera's own Play/Pause ACKs for the
forward-then-auto-pause step request pair (`forward()`'s brief PLAY, immediately followed by a
`pause()` to land on exactly one frame) — a completely separate state machine from
`MediaRouter.player`'s liveness, which is exactly why the button state gave no warning that a step
click was about to hit a null player.

Fixed two ways together, not just the null crash:
- `sendCommandData()`'s `forward`/`backward` now guard on `this.player !== null`, matching every
  other case — a step click during the teardown window silently no-ops (same externally-visible
  effect as a `stepRequest()` retry) instead of throwing.
- `onWaiting()`'s `0x0107` error event now carries a `playerClosed: boolean` field (`MediaRouterErrorEvent`),
  computed *before* the close so the one `errorCallback` call is accurate, and
  `RTSPOverWebSocket.ts`'s `0x0107` case forwards it onto the public `'waiting'` DOM event. This is
  the actual fix for the UX gap: a host page can now tell, from the `'waiting'` event alone,
  whether *this* packet-loss notice is also tearing down the player, and disable its own
  forward/backward buttons for that window instead of relying on the null-guard's silent no-op.
  No corresponding "re-enable" event was added — the next `'statechange'` `PLAYING` event (fired
  once a new frame recreates the decoder) already re-enables step controls for `PLAYBACK`, so nothing
  else needed to change.

See `docs/player/03-mediaSession-core-video.md`'s `sendCommandData`/`onWaiting` Method Analysis
entries and `01-elements-interface-exceptions.md`'s `onRTSPOverWebSocketError`/`0x0107` entry.

## `'waiting'`'s `playerClosed` flag above only covered *one* of the two ways `MediaRouter.player` goes null — added a dedicated `'playerstatechange'` event sourced from the setter itself (fixed)

Direct same-day follow-up, from a fresh live console trace the consumer (`wisenet-camera-discovery`)
took right after the fix above shipped: the null-player crash was gone, but a `backward()` call still
hit `TypeError: Cannot read properties of null (reading 'backward')` — this time on a five-repeat
`backward` sequence, right after a `'Pause'` RTSP ack came back.

Root cause: `player` (`MediaRouter.ts`) goes `null` from **two independent code paths**, and the
previous fix's signal (`playerClosed` on the `0x0107`/`'waiting'` event) only covers one of them:

1. `onWaiting()`'s covert-mode teardown (the path the previous fix targeted).
2. `initVideoPlayer()`, called from `stepRequest()` (the very first `forward()`/`backward()` click)
   **and from `sendCommandData`'s `resume`/`seek` command cases** — none of which fire a `'waiting'`
   event at all, so `playerClosed` never reflects this path.

The consumer's own `videoControl.ts` had closed the *click-time* race (debouncing `#forward`/
`#backward` on click, re-enabling on the next `'statechange'` STEP/PLAYING event), but that's not
enough on its own: a step's own auto-`pause()` ack (`onRTSPOverWebSocketStep('complete')`) triggers
a PAUSED `'statechange'`, and the consumer's PAUSED handler *legitimately* re-enables step buttons
on PAUSED (needed so a user who manually pauses, not mid-step, can still start stepping) — but
PAUSED can also arrive while a *separate*, still-in-flight buffer-refill re-seek (triggered by an
*earlier* step exhausting its local frame buffer, via the same `stepRequestCallback('request', ...)`
mechanism `stepRequest()` uses — see `docs/player/01-elements-interface-exceptions.md`'s corrected
`onRTSPOverWebSocketStep` entry, which previously undersold this to "first click only") has `player`
still `null`. Racing `'statechange'` readyState transitions against `player`'s actual nullness from
the *consumer* side is inherently unreliable — there is no ordering guarantee between an unrelated
pause ack and a buffer-refill's own completion.

Fixed by making `player`'s existing getter/setter (`MediaRouter.ts`) the single source of truth:
it now fires a new `playerAvailabilityCallback` on every null <-> non-null transition, regardless of
which of the two paths above caused it (confirmed via grep — no code in the class writes the
backing `_videoPlayer` field directly, every assignment already went through this setter). Forwarded
as a new public `onRTSPOverWebSocketPlayerAvailability(available)` callback /
`'playerstatechange'` DOM event on `RTSPOverWebSocket.ts`. This is intentionally *not* folded into
the existing `'waiting'` event or `RTSPOverWebSocketPlayState` enum (a legacy-ported, exact-value
enum — see this file's earlier rebrand entry for why those values aren't touched lightly) — it's an
orthogonal signal ("does a live decoder exist") from readyState ("what is the RTSP session doing"),
and conflating them is exactly the bug this fix removes.

See `docs/player/01-elements-interface-exceptions.md`'s `onRTSPOverWebSocketPlayerAvailability`
entry and `03-mediaSession-core-video.md`'s `player` getter/setter entry. The consumer-side fix
(routing every step-button enable through this new signal) is in `wisenet-camera-discovery`'s own
`MEMORY.md`.

## `forward()`/`backward()` stuck forever on a camera with no SDP `a=framerate:` line — `StepBufferList` never guarded against a `NaN` buffering length

Reported live: `#forward`/`#backward` never re-enabled after a step, with no crash and no RTSP-level
error at all (`457`/`0x...`) — just silence, forever. Unlike every other GMT/timing bug found this
session, static analysis alone wasn't enough to pin down the cause with confidence, so temporary
`console.log` diagnostics were added first at every stage of the step lifecycle
(`MediaRouter.ts`'s buffering block, `StepBufferList.push()`, `onRTSPOverWebSocketStep()`, and
`wisenet-camera-discovery`'s `onPlayerStateChange()`/`onPlayerFrameRendered()`/STEP statechange) —
but before the user came back with a fresh trace, re-reading `StepBufferList.ts`'s own existing code
comment surfaced the answer directly: `push()`'s comment at `:57-61` already named the exact failure
mode as a known *theoretical* risk ("they diverge under `NaN`, a possible `bufferingLength` if
`videoInfo.framerate` was missing") — but nothing in the class ever actually guarded against it.

The chain: `RtspClient.ts`'s SDP parser only sets `session.Framerate` `if` an `a=framerate:` SDP
attribute line is present (`:643-646`) — a genuinely optional attribute some cameras simply don't
send. That leaves `videoInfo.framerate` `undefined` for such a stream (already an anticipated case
elsewhere in this codebase — `MediaRouter.ts`'s `setFrameRate(typeof videoInfo.framerate ===
'undefined' ? 0 : videoInfo.framerate)` explicitly guards it). `StepBufferList.push()`, on its
*second* call, auto-tunes `bufferingLength = videoInfo.framerate * 4` — `undefined * 4` is `NaN`.
`setBufferingLength()`'s own clamp logic (`length > MAX_BUFFERING_LENGTH` / `length <
MIN_BUFFERING_LENGTH`) never applies, since *every* comparison against `NaN` is `false` — so
`bufferingLength` stays `NaN` permanently. `push()`'s own completion check
(`stepList.length >= bufferingLength`) is therefore *also* always `false` (comparing anything
against `NaN` is `false`), so `push()` can never return `false` ("buffer full") — the step can never
reach `stepStatus = 'complete'`, `onRTSPOverWebSocketStep('complete')` never fires, `pause()`/the
`STEP` statechange dispatch never happen, and `#forward`/`#backward` (only re-enabled by a `STEP`
event, per `wisenet-camera-discovery`'s `updateStepButtonsEnabled()`) stay disabled forever. No
crash anywhere in this chain, and no RTSP-level error either — the underlying stream just keeps
flowing normally, endlessly "buffering" toward a target that mathematically can never be reached.

Fixed by validating `length` is finite in `setBufferingLength()` before using it
(`Number.isFinite(length) ? length : DEFAULT_BUFFERING_LENGTH`), falling back to the same default
the class already uses elsewhere, then clamping normally as before. A camera with no `a=framerate:`
SDP line now buffers a fixed 240 frames before stepping (matching `DEFAULT_BUFFERING_LENGTH` /
`MAX_BUFFERING_LENGTH`, since `240` is already inside its own clamp range) instead of buffering
forever.

The temporary diagnostic `console.log`s added while investigating (see the individual files) were
left in place rather than removed immediately — this class of bug (a numeric edge case with no
error signal at all) is exactly the kind that's cheap to keep instrumented and expensive to silently
reintroduce; strip them in a follow-up once the fix is confirmed against the real device that
reported this.

See `docs/player/05-video-player-rendering.md`'s `StepBufferList` Method Analysis and History table
for the line-referenced detail.

## CanvasTagPlayer never tagged its timestamps' `mode` (fixed)

Reported by the user via `wisenet-camera-discovery`: with `#renderer_type` set to "canvas", its
Playback UI's `#timestamp_date`/`#timestamp_time` readout never appeared, even though
`onRTSPOverWebSocketTimestamp` was confirmed (by breakpoint) to keep receiving fresh
`timestamp`/`timestamp_usec`/`rtpTimestamp` data — the event was firing, the consuming app just
never acted on it. Switching to "video tag" for the exact same stream showed the readout fine.

Root cause: `wisenet-camera-discovery`'s handler for the player's dispatched `'timestamp'` event
`switch`es on `event.detail.mode` (`'live'` / `'playback'`) to decide whether to render anything at
all — a pattern that only works if whichever class produced the frame actually stamped that field.
`VideoTagPlayer` always has (`sample.timeStamp.mode = 'live'|'playback'` in
`updateVideoTimestamp()`/`onVideoSourceUpdateEnd()`, since legacy), but `CanvasTagPlayer` never did,
anywhere in its `onVideoData()`/`decoderWorkerMessage()` pipeline — not for Live, not for Playback.
`TimeStampInfo` (`MediaSession/MediaRouter.ts`) didn't even declare the field. The reason Live
*looked* unaffected during the user's own testing session wasn't that Live's canvas path was
somehow exempt — `MediaRouter.selectVideoPlayer()`'s codec/size/`defaultVideoTagMode` heuristics
mean an explicit `#renderer_type` "canvas" choice only actually takes effect the next time a player
is (re)selected, i.e. the next fresh session; an already-running Live view kept using the
`VideoTagPlayer` instance it had already picked before the dropdown was changed, while starting
Playback fresh genuinely constructed a new `CanvasTagPlayer` and hit the gap.

Fixed by tagging `streamData.timeStamp.mode = this.playmode` once, at the very top of
`CanvasTagPlayer.onVideoData()` — `this.playmode` is `VideoPlayer`'s own property, already set to
the lowercased `'live'`/`'playback'` by `MediaRouter.selectVideoPlayer()` before any frame reaches
the player. One assignment on that shared `streamData.timeStamp` object instance covers all three
downstream paths that eventually hand it to `timeStampCallback`: the `checkFrameDrop` early-return,
the MJPEG `mjpegDraw` closure, and the H264/H265 decoder-worker round trip (which structured-clones
the object into the worker and echoes it straight back as the `'decoded'` message's `data.time`).
`TimeStampInfo` gained the `mode?: string` field to match. See
`docs/player/05-video-player-rendering.md`'s `CanvasTagPlayer` Method Analysis for the
line-referenced detail.

Also removed while fixing this: `CanvasTagPlayer.decoderWorkerMessage()`'s temporary
`console.log('[CanvasTagPlayer] decoded frame', ...)` diagnostic instrumentation from an earlier
session investigating this exact symptom (its own comment named it: "canvas-mode playback reported
live: timestamp events never arrive") — no longer needed now the underlying cause is confirmed and
fixed.

## Selecting a new timeline event mid-playback silently kept playing from the old position — `startTime` never cleared the stale `_localTimestamp` it's outranked by

Reported directly by the user (Korean): selecting an event on `wisenet-camera-discovery`'s timeline
sets `player.startTime = ...`, but while a camera stream was already playing, the next `play()` kept
resuming from wherever the *previous* stream had gotten to, ignoring the new `startTime` entirely.
The user's own diagnosis was exactly right: `seekingTime` moved playback correctly when set instead,
so the difference had to be that setting `startTime` left some other state untouched that `seekingTime`
didn't.

Root cause: `generateRTSPURL()`'s camera `playback` branch (see "`startTime`/`endTime`/`seekingTime`
normalize to canonical UTC at the setter" above, and "Camera fresh-Play sending a URL with no start
time at all" for how this priority order came to exist) computes `strStart` with priority
`seekingTime` (always wins, checked *after* and unconditionally overwrites) > `_localTimestamp` (an
already-flowing stream's live position, intentionally so pause/resume/speed changes resume from
*where playback currently is*) > `startTime` (fresh-Play fallback, lowest). That priority order is
correct for pause/resume/speed changes on the *same* stream. But `_localTimestamp` used to only ever
get cleared by `stop()` or the `GMT` setter — never by `startTime` itself — so selecting a new
timeline event while already playing left the *old* stream's `_localTimestamp` sitting there,
non-null, and it silently outranked the freshly-assigned `startTime` on the very next `play()`.
`seekingTime` never had this problem because it isn't part of that priority chain at all — it's
checked separately, right after, and unconditionally overwrites `strStart` regardless of what the
`_localTimestamp`/`startTime` branch produced.

Fixed by having the `startTime` setter also clear `_localTimestamp` (`RTSPOverWebSocket.ts:~1505`,
right next to its existing `_currentTimestamp` mirror). Confirmed safe for the pause/resume/speed
path: none of `pause()`/`resume()`/`speed()`/`forward()`/`backward()` ever assign `startTime`
themselves — they read `_localTimestamp`/`_currentTimestamp` directly — so clearing it in the setter
only ever fires on an *explicit*, external `startTime` assignment (the two `attributeChangedCallback`
`src`-parsing call sites, or app code like `wisenet-camera-discovery`'s timeline-event handler),
exactly the case that should start fresh rather than reuse a previous stream's position.

See `docs/player/01-elements-interface-exceptions.md`'s "Time normalization" Method Analysis section
and History table for the line-referenced detail.

## `GMT` setter's loose validation for non-number input was intentionally preserved, then deliberately removed

`RTSPOverWebSocket.ts`'s `GMT` setter used to have a documented, intentionally-preserved legacy quirk:
a non-number value (e.g. a string) wasn't rejected — it silently fell through the `< -12`/`> 13` range
check (both comparisons evaluate `false` against a non-numeric operand) and got written straight to
the `gmt` attribute via `setAttribute('gmt', String(v))`. Only `undefined` threw, and only `null` reset
to the default `0`.

Two direct, separate requests from the user changed this in the same session, in this order:

1. Fold `undefined` into the `null` branch (both now reset `GMT` to `0`) instead of throwing on
   `undefined` — the old `if (typeof v !== 'number' && v === undefined)` throw-guard was redundant
   anyway, since `v === undefined` already implies `typeof v !== 'number'`.
2. Once that first change had already narrowed what needed separate handling, remove the loose
   validation itself: any non-number that isn't `null`/`undefined` is now rejected up front with the
   same `RTSPOverWebSocketError` (0x0414) an out-of-range number gets — `if (typeof v !== 'number' ||
   v < -12 || v > 13) throw ...`.

Worth remembering: this is a case where a documented "preserved legacy bug" was later deliberately
reversed on direct user instruction, not rediscovered and "fixed" by accident. If another loose-
validation quirk elsewhere in this class is ever found and preserved the same way, don't assume it's
permanent — it may just not have come up for a decision yet.

See `docs/player/01-elements-interface-exceptions.md`'s History table (two 2026-09-03 entries) for the
line-referenced before/after.

## MJPEG real-MSE tier via H264 re-encoding (WebCodecs `VideoEncoder`) — not yet verified live

MJPEG video used to always render via `<canvas>` (`CanvasRenderer.draw()`'s `new Image()` + Blob
URL, native browser JPEG decode — `MediaRouter.ts`'s `selectVideoPlayer()` hardcoded
`tagMode = 'canvas'` for it unconditionally). Added an alternative real-MSE `<video>`-tag path,
requested directly by the user across several review turns: they first asked how to feed MJPEG
into an MSE `SourceBuffer` at all; confirmed live via `MediaSource.isTypeSupported()` in a headless
Chromium that **no browser recognizes any MJPEG-flavored codec string in any container** (`video/
mp4;codecs="mjpg"|"jpeg"|"mjpa"|"mjpb"`, `video/webm;codecs="mjpeg"`, `video/mjpeg` — all `false`,
vs. `avc1.64001f`/`vp09.00.10.08` both `true`) — MSE's decoder pipeline and the browser's image
(JPEG) decoder are genuinely separate subsystems, so the only way into MSE at all is re-encoding to
a codec MSE actually knows. The user then asked specifically about re-encoding to H264 via
WebCodecs `VideoEncoder`, and — after a sized implementation plan (`ExitPlanMode`-approved) — this
is that path.

**Why not the simpler "bridge" tier instead** (the `MediaStreamTrackGenerator` pattern VP8/VP9/AV1
already use, decoded `VideoFrame`s piped straight into a `<video>`'s `srcObject`, no MSE/muxing/
re-encoding at all — see the entry above): that path is real, cheaper (no re-encode CPU cost, no
quality loss from double lossy compression), and would've needed far less new code (just a decode-
direction wrapper matching `WebCodecsVideoDecoder`'s existing shape). It was recommended first. The
re-encode path was chosen anyway because `MediaStreamTrackGenerator` is Chromium-only —
Safari/Firefox support MSE+H264 but not that API — and browser reach beyond Chromium was the
deciding factor once raised explicitly.

**New code**: `worker/videoEncoder/WebCodecsVideoEncoder.ts` (mirrors `WebCodecsVideoDecoder.ts`'s
shape — constructor throws if unsupported, `isConfigSupported()`-verified candidate-string loop,
`close()` — but owns encode instead of decode, and has no synchronous-pull queue at all: `encode()`
is genuinely fire-and-forget). `util/avcConfigParser.ts` (`parseAvcConfigurationRecord`/
`buildAvc1CodecString`) parses the WebCodecs-surfaced avcC configuration record into the same
`sps`/`pps`/`profileIdc`/`profileCompatibility`/`levelIdc` shape `H264SPSParser` extracts from a
real network SPS — needed because MJPEG has no SPS/PPS of its own. `util/codecString.ts` gained
`mjpegEncoderCandidateCodecStrings()` (`['avc1.42001f', 'avc1.640028']` — Baseline/Level 3.1 first;
Level 3.0's 40,500 MaxMBPS cap doesn't actually cover a common 1280×720@30fps stream, 3,600
macroblocks/frame × 30fps = 108,000, which needs Level 3.1's 108,000 cap exactly).

**The core structural problem**: `MediaRouter.handleVideoData()` → `VideoTagPlayer.onVideoData()`
→ `createVideoSample()` is fully synchronous end-to-end for every other codec, assuming
`streamData.frameData` is the complete bitstream *right now*. `VideoEncoder.encode()` is
fire-and-forget — the real `EncodedVideoChunk` only arrives later, async, via the encoder's own
`output` callback. Bridged with a `mjpegPendingFrames` FIFO queue: `submitMjpegFrame()` (replacing
the normal synchronous ingestion for MJPEG) records the *original* RTP-derived `streamData`/
`videoInfo` keyed by a caller-assigned `timestampUs`, and `onMjpegEncodedChunk()` (the encoder's
async callback) matches a chunk back to its entry by that same value, then feeds the result through
`ingestVideoSample()` — a new shared helper extracted out of `onVideoData()`'s previously-inline
init-segment-once + `createVideoSample()`-every-time logic, so this async path reuses the exact
same `setVideoInfo()`/`initBaseNTPTimestamp()`/`createInitSegment()` sequence every synchronous
codec already uses, rather than duplicating it (including `this.videoCodecInfo`'s own population,
which `setSourceBuffer()`'s MIME-codecs string requires and would otherwise be an easy new-call-
site omission — this was the single easiest thing to silently get wrong, per the approved plan's
own risk list, and reusing the existing gate instead of writing a parallel one is what closes it
structurally rather than by remembering to do it right).

**FIFO safety**: matching is done by `chunk.timestamp === pendingEntry.timestampUs` equality (not
blind `shift()`), specifically so a desync — e.g. a mid-flight `VideoEncoder` `error` callback
silently dropping one `encode()` call's output entirely, which nothing else here would otherwise
detect — surfaces as a loud dropped-chunk log instead of silently misattributing every subsequent
frame's real timing/videoInfo to the wrong pending entry. WebCodecs guarantees a single encoder
instance's output order matches its `encode()` call order as long as no B-frames are requested
(never true here), so plain FIFO is spec-safe in the non-error case; this check only matters once
something has already gone wrong.

**AVCC vs. Annex-B landmine**: `createSampleFrameData()` rewrites H264/H265's Annex-B start-code
NALs into length-prefixed AVCC for muxing — necessary for real network H264, but a `VideoEncoder`
configured `avc: { format: 'avc' }` (the default) already emits AVCC directly. Encoder-sourced
samples are tagged `codecType: 'H264'` (needed so `mp4Generator.js`'s box-type dispatch treats them
as real H264 — this deliberately does **not** exercise the vendored muxer's separate, already-
broken `codecType === "MJPEG"` branch, `mp4Generator.js:881-910`, which calls `box(types.mpv4,
...)` against a `types` table that only defines `mp4v` — see `docs/player/09-mp4-container-
generation.md`'s "Known issues" section, now updated to explain this branch is *still* unreachable,
just for a different reason than before). Since `codecType` alone can't distinguish "real H264,
needs the Annex-B rewrite" from "encoder-sourced H264, already AVCC," `createSampleFrameData()`
gained a third `isEncoderSourced` boolean parameter threaded through from `createVideoSample()` —
without it, encoder output would hit the rewrite and get corrupted, not merely left unoptimized.

**Backpressure and keyframe cadence**: `submitMjpegFrame()` never drops a frame while
`mjpegAvcConfig === null` (no init segment built yet — that's the one frame that can ever start
playback; dropping it would stall the session forever, not just skip a frame), and otherwise drops
new frames once `mjpegEncoder.encodeQueueSize` exceeds a small fixed threshold rather than letting
the encoder's internal queue grow unbounded if it falls behind. A `MJPEG_ENCODER_KEYFRAME_INTERVAL`
counter forces a periodic `VideoEncoder` keyframe, since MJPEG's own source frames (each already a
complete, independent JPEG) carry no GOP signal of their own for the *encoded H264* stream to
inherit.

**Resolution changes need no special handling**: confirmed (before writing any code) that
`MediaRouter.selectVideoPlayer()` already tears down and rebuilds the *entire* `VideoTagPlayer`
instance whenever a frame's decodeSize/width/height differs from the currently active player's, for
every codec including MJPEG, today — so a fresh `WebCodecsVideoEncoder` (with the new resolution)
naturally gets constructed from scratch by `submitMjpegFrame()`'s existing lazy-init-on-first-frame
logic, on the new `VideoTagPlayer` instance. No `VideoEncoder.configure()`-mid-stream code exists or
is needed.

**Live verification, and a real bug found only by it** — exactly this file's own recurring lesson
(see the VP8/VP9/AV1 entry above: three real bugs there were found *only* by live testing, none by
static analysis or synthetic unit tests). This feature's own first end-to-end attempt reproduced
that pattern immediately:

The `run-demo-server` (YouTube → ffmpeg `mjpeg` encoder → MediaMTX → RTSP-over-WebSocket) pipeline
turned out to be its own dead end for verifying this specific feature: `ffmpeg`/MediaMTX published
the MJPEG stream correctly (confirmed via MediaMTX's own logs, and 140+ WebSocket frames/~164KB did
reach the browser), but zero video-data ever reached `MediaRouter.handleVideoData()` client-side —
confirmed via `git stash` that this exact demo pipeline already fails identically with the
completely original, pre-this-feature code, i.e. a pre-existing, unrelated gap in this demo's own
MJPEG relay (not investigated further — out of scope for this feature, and the same kind of
never-actually-exercised gap `MEMORY.md`'s VP8/VP9/AV1 entry already documents for AV1 output).

Verified instead with a **direct synthetic harness**: a Playwright script that loads the built
`dist/player/rtsp-over-websocket.esm.js` in a real headless Chromium, constructs a bare
`VideoTagPlayer` directly (bypassing `MediaRouter`/RTSP entirely), sets `codec = 'MJPEG'`, and feeds
it 40 real JPEG frames (rendered via `<canvas>.toBlob('image/jpeg')`, genuinely different pixel
content per frame) through `onVideoData()` at ~60ms intervals. This isolates exactly the code this
feature actually changed, independent of the demo pipeline's unrelated gap.

**First run crashed — a real, previously-undiscovered pre-existing bug**, not something new this
feature added, but one this feature made far more likely to actually manifest:
`Cannot read properties of null (reading 'addEventListener')` at `VideoTagPlayer.ts`'s
`addBufferEventListener()`, called from `setSourceBuffer()`. Root cause: `setSourceBuffer()`'s only
call site is the `'sourceopen'` `MediaSource` event listener, and it builds its MIME/codecs string
from `this.videoCodecInfo` — which is `null` until a *real video frame* has been ingested at least
once. If `'sourceopen'` fires before that (a real, always-possible race — this class has always
assumed frame data reliably beat the browser's own `sourceopen` timing, apparently true often
enough for H264/H265/VP9/AV1's fully-synchronous ingestion that it was never caught before), the
`isTypeSupported('video/mp4;codecs="null, ...')` check fails, `this.sourceBuffer` is never
assigned, and `addBufferEventListener()` — called *unconditionally* right after regardless of that
outcome — threw trying to attach listeners to `null`, aborting `sourceopen`'s handler entirely and
leaving the session permanently stuck (no `SourceBuffer` ever created, nothing to append to, no
further retry anywhere in the class). This is almost certainly the exact bug the user hit reporting
"MJPEG video tag로 재생이 안됩니다" (MJPEG doesn't play via the video tag) against a real device,
where canvas mode (their working baseline) never touches `MediaSource`/`SourceBuffer` at all. The
MJPEG-encoder tier makes the race far likelier than it was for any prior codec: its first sample
now depends on an async `createImageBitmap()` + `VideoEncoder.configure()` round trip before
`ingestVideoSample()` can run even once — a real, unavoidable delay no synchronous codec ever had —
giving the browser's own `sourceopen` event a realistic window to fire first essentially every time,
not just occasionally.

**Fixed with two changes to `VideoTagPlayer.ts`, both general (not MJPEG-specific), since the
underlying assumption was never actually codec-specific**:
1. `setSourceBuffer()` now only calls `addBufferEventListener()` when `this.sourceBuffer !== null`
   — closes the crash outright, for every codec.
2. `ingestVideoSample()` (the shared init-segment-building helper this feature already extracted —
   see above) now also calls `this.setSourceBuffer()` itself, right after `createInitSegment()`,
   whenever `this.sourceBuffer` is still `null` at that point — `setSourceBuffer()`'s own
   `mediaSource.sourceBuffers.length === 0` guard makes this a safe no-op if a `SourceBuffer`
   already exists, so this is a pure retry: once the real codec is finally known (guaranteed to
   happen here, since this runs right after `videoCodecInfo` is set), the `SourceBuffer` that
   `'sourceopen'` couldn't create in time gets created now instead of never.

**Re-verified after the fix, same synthetic harness, both the unminified and the production
(minified) `npm run build:player` output**: the real `<video>` element reached `readyState: 4`
(`HAVE_ENOUGH_DATA`), `videoWidth`/`videoHeight` `320`/`240` (matching the fed synthetic frames
exactly), and a real advancing `currentTime` — confirmed genuinely decoding, not just not-crashing,
via a full-page screenshot showing the actual synthetic frame content ("frame 4" on its own
distinct background color) rendered inside the `<video>` element. Also directly confirmed the
user's explicit fallback requirement: with `window.VideoEncoder` deleted before construction,
`decideUseMjpegEncoder()` returns `false` (and, per the already-live-verified `MediaRouter.ts`
`case 'MJPEG'` logic, `tagMode` stays `'canvas'`).

**Still not verified**: real camera MJPEG (only synthetic canvas-JPEG frames were exercised — real
RTP/RTSP MJPEG framing, resolution changes mid-stream, and the FIFO-desync/AVCC-passthrough edge
cases noted above remain unverified against an actual device or the still-broken demo pipeline)
and the `docs/player/09-mp4-container-generation.md`-documented dead `mpv4`/`esds` mp4Generator
branch staying unreached (not directly observed, only inferred from the encoder-sourced samples
correctly decoding as H264 — if that branch *had* fired, decode would have failed outright, so this
is reasonably strong indirect evidence, not a gap worth chasing further).

**How to apply**: this is the second time in this file a `VideoTagPlayer.ts` real-MSE bug was found
only by feeding it realistic *timing*, not just realistic data — synthetic unit tests of the pure
avcC-parsing pieces passed the whole time and would never have caught this, since the bug lives in
event-ordering between two independently-scheduled subsystems (the browser's own `MediaSource`
lifecycle vs. this class's own async encode pipeline). Any future change that makes a real-MSE
codec's *first sample* take meaningfully longer to produce (a new async step before
`ingestVideoSample()`'s first call, same as this feature added) should be suspected of the same
class of race until proven otherwise, even though the two general fixes above should already cover
it structurally for codecs that don't exist yet either.

## MJPEG-encoder tier, second real bug: fixed candidate codec list rejected any real camera resolution

Direct follow-up to the entry above, found the same way: the user rebuilt and retested against a
real Hanwha camera (after re-running `wisenet-camera-discovery`'s own `npm run build`, which copies
this package's `dist/player/*` into its `external-lib/` — the first thing to check whenever "still
behaving like the old code" is reported after a fix that only touched *this* repo, since a consuming
app's own copy doesn't refresh itself). Console trace: `WebCodecsVideoEncoder: no supported
VideoEncoder configuration found for 2048x1536`.

Root cause: `mjpegEncoderCandidateCodecStrings()` (`util/codecString.ts`) returned a single fixed
pair (`avc1.42001f`/`avc1.640028` — Baseline/High, Level 3.1/4.0) regardless of the actual stream
resolution — reasonable for the ~1280x720 case it was written against, but MJPEG cameras have no
codec-level resolution ceiling the way H264/H265 do, and a real 2048x1536 (3.1MP) stream needs
128x96 = 12,288 macroblocks/frame, which exceeds even Level 4.0's 8,192 MaxFS cap (H.264 Annex A
Table A-1) — `VideoEncoder.isConfigSupported()` correctly rejected every candidate, `configure()`
never got a working encoder, and `submitMjpegFrame()`'s `!this.mjpegEncoder.isConfigured` guard
silently dropped every frame forever (no crash, no `tagMode` fallback — `MediaRouter.ts`'s own
`isTypeSupported` pre-flight check made the *same* fixed-candidate mistake, so it had already
committed to `tagMode: 'video'` before discovering, too late, that the real resolution couldn't
actually be encoded).

Fixed by making the candidate list resolution- (and framerate-) aware instead of guessing a single
"common" one: `codecString.ts` now has the full H.264 level table (`H264_LEVEL_LIMITS`, Level
3.0-6.2's `maxFS`/`maxMBPS`) and `selectH264LevelIndexes()` picks the lowest level whose `maxFS`/
`maxMBPS` actually cover the requested `pixelCount`/`framerate`, plus the next level up as a second
candidate tier (some real encoders have level-support gaps even when the resolution itself would
fit the computed minimum) — falling back to the table's own highest level if even that isn't
enough, letting `isConfigSupported()` reject it for real rather than this function silently
under-shooting forever. `mjpegEncoderCandidateCodecStrings(pixelCount, framerate)` now takes both
as parameters: `MediaRouter.ts`'s pre-flight check passes `size`/`framerate` (already available at
that call site) and iterates every candidate with `.some(...)` instead of checking only the first;
`WebCodecsVideoEncoder.configure()` passes its own real `width * height` (its constructor already
receives real dimensions, unlike `MediaRouter`'s pre-flight probe). Both call sites necessarily stay
in sync on the *same* function rather than duplicating level math, same reasoning as the original
shared-candidate-list design.

**Verified**: unit tests for 1280x720 (Level 3.1+3.2), 1920x1080 (Level 4.0+4.1), and the exact
2048x1536 failure case (now correctly Level 5.0+5.1, not 3.1/4.0) in `codecString.test.ts`. Also
re-ran the synthetic-JPEG Playwright harness from the entry above at 2048x1536 specifically (not
just the original 320x240) — confirmed `readyState: 4`, `videoWidth`/`videoHeight` `2048`/`1536`,
no `isConfigSupported` rejection, both before and after a full production (`npm run build:player`,
minified) rebuild.

**How to apply**: any future "silently stuck in canvas / encoder never configures" report for this
tier should check the actual resolution against `H264_LEVEL_LIMITS` first — this class of failure
produces no error visible to `MediaRouter`/`VideoTagPlayer` callers (the encoder's own `console.error`
is the only signal), so it looks identical to "browser doesn't support this at all" from the
outside unless that specific log line is checked. Also: when a fix lives only in this package and
the reporter tests through a consuming app (`wisenet-camera-discovery` here, via its `file:` npm
dependency), always ask "did you rebuild the consuming app too" before re-diagnosing from scratch —
the first "still doing the old thing" report in this saga was exactly that, not a second bug.

## MJPEG-encoder tier, third real bug: Playback mode's dual-track segment flush deadlocks with no audio

Third bug in this same saga, found the same way as the first two: the user confirmed Live playback
now genuinely worked end-to-end, then reported Playback mode (a recorded/stored MJPEG clip) still
didn't play, even though `tagMode` correctly resolved to `'video'`. Reproduced with a
`playMode: 'Playback'` variant of the same synthetic-JPEG Playwright harness — `readyState` stayed
`0` (`HAVE_NOTHING`) no matter how many frames were fed.

Root cause lives in `createVideoSample()`'s `playbackFlag` branch and `createSegment()` (the
dual-track `moof+mdat` builder Playback mode uses instead of Live's video-only
`createVideoSegment()`) — both pre-existing, shared with every real-MSE codec's Playback path, not
MJPEG-specific:

- `createSegment()` has always required *both* `this.videoSamples.length > 0` *and*
  `this.audioSamples.length > 0` before building anything (`if (... || this.audioSamples.length ===
  0) return;`) — silently, no error, no log.
- The *only* place dummy audio got seeded (`makeDummyAudio()`, when no real audio track exists) was
  inside `createVideoSample()`'s own I-frame handling, and only once
  `this.videoSamples.length > 1` — i.e. from the *second* I-frame boundary onward. The first flush
  attempt for a session — whether triggered by an I-frame arriving before a second one ever does,
  or by `createSegment()`'s own `MAX_PLAYBACK_DIFF` (1500ms) timeout fallback, which calls
  `createSegment()` directly with no dummy-audio seeding step at all — could hit the guard above
  with `audioSamples` still empty, and then never recover: nothing reschedules another attempt
  except a future I-frame, and `createVideoSegmentTimeout` is a one-shot timer cleared unconditionally
  at the top of `createSegment()` every time it runs, seeded or not.

This is a real gap for *any* real-MSE Playback codec with no audio track and either (a) a short
clip that never reaches a second I-frame, or (b) an infrequent keyframe cadence — but MJPEG's new
tier makes it far more likely to actually manifest: its own re-encoded H264 stream only forces a
keyframe every `MJPEG_ENCODER_KEYFRAME_INTERVAL` (60) frames, easily longer than a whole short
Playback clip, where H264/H265 cameras' native 1-2s GOPs rarely go that long without a second
keyframe arriving.

**First fix attempt was itself incomplete** — worth recording since it's a real trap in
`makeDummyAudio()` itself: seeding inside `createSegment()` too (gated on `dummyAudio &&
audioSamples.length === 0`, using the same `(lastSample.rtpTimestamp - firstSample.rtpTimestamp) *
10` formula the original call site already used) looked right but still produced zero audio
samples in the synthetic harness. Root cause: `makeDummyAudio(updateDuration)` has an `updateDuration
> 100000` branch that *discards* the passed-in value and instead re-derives a duration from
consecutive video-sample `rtpTimestamp` deltas, requiring the recomputed total to land in
`(0, 10000]` or it returns without creating anything — fine for its original target (bridging one
dropped-frame gap) but not for the potentially large multi-sample span buffered here (a real
RTP-timestamp delta across 17-36 buffered samples in the harness, `153000`-`342000` after ×10,
both well past 100000). **Fixed by capping the seed value at exactly 100000** (`Math.min(Math.max(
rawDelta, samplingDuration), 100_000)`), keeping the call on `makeDummyAudio`'s direct-add path
(no recompute, no silent no-op) — trading exact placeholder-audio duration fidelity for a
guaranteed non-empty `audioSamples`, which is a fine trade since this is silent/dummy audio, not
real content whose timing matters.

**Verified**: same synthetic harness, `playMode: 'Playback'`, with temporary diagnostic logging at
`createVideoSample()`'s playback branch and `createSegment()`'s entry/guard first (to see exactly
where the flow stalled, confirming `createSegment()` *was* being called with `audioSamplesLen: 0`
both before and immediately after the first (broken) seed attempt) before landing on the real fix —
`readyState` reached `4` (`HAVE_ENOUGH_DATA`) with real `videoWidth`/`videoHeight` after the fix,
confirmed against both the unminified and production `npm run build:player` output. Diagnostic
`console.log` calls removed once root-caused; not left in place (unlike some of this file's other
entries) since this one didn't need a standing trace to interpret correctly once understood.

**How to apply**: `makeDummyAudio()`'s `updateDuration` parameter is not a free-form "however long
the real gap was" value despite what its call sites' own formulas suggest — anything past 100000
silently routes through a much stricter, easy-to-violate recompute path. Any future caller passing
a value derived from summing multiple samples' timestamps (not just one frame's duration) should
cap it the same way, or confirm live that the recompute path's `(0, 10000]` range actually holds
for the real data in play.

## MJPEG-encoder tier, fourth real bug: `initBaseAudioTime()` corrupts `baseVideoTime`, not `baseAudioTime`, on every Playback A/V-drift resync

Fourth bug in this saga, and the most serious one: the user confirmed the third fix (dual-track
segment flush) made Playback video actually appear, but reported new symptoms — a burned-in OSD
timestamp on the recorded footage visibly oscillating ("27 -> 28 -> 27 -> 28"), 20+ second latency,
and a 2fps source appearing to play back at a visibly higher, mismatched frame rate. Root-caused
with a purpose-built synthetic-JPEG Playwright trace (`readDisplayedFrameIndex()`: each fed frame
gets a distinct HSL hue, read back from a sampling `<canvas>` drawing the live `<video>` frame, the
same idea as reading a real camera's OSD) at a realistic 2fps/500ms pacing, logging
`(elapsedRealSec, currentTime, displayedFrame)` every 500ms for 30 real seconds.

**What the trace found, in two layers**:

1. **A pre-existing periodic-flush gap, general to Playback mode (not MJPEG-specific), that this
   tier's own encoder behavior exposed for the first time.** `createSegment()`'s `MAX_PLAYBACK_DIFF`
   (1500ms) fallback timeout was previously only ever *scheduled* from `createVideoSample()`'s own
   I-frame-boundary code — so once a timeout-triggered flush consumed the pending one,
   *nothing rescheduled another* until the next real keyframe arrived. Confirmed live: a real
   WebCodecs `VideoEncoder` inserts keyframes on its own internal cadence, independent of this
   tier's own `forceKeyFrame` request hint (observed producing a real keyframe every ~17 frames in
   one browser, ignoring the 60-frame request `submitMjpegFrame()` was actually asking for) —
   meaning multi-second stalls between whatever cadence the encoder itself happened to choose, not
   the requested one. Fixed generally: `createSegment()` now reschedules its own
   `createVideoSegmentTimeout` unconditionally at the top of every call (guarded only on
   `mediaSource` still being open), regardless of what triggered that particular call — a safe
   no-op flush attempt when there's nothing new to send yet, but guarantees periodic ~1.5s checks
   continue for the life of the session.

2. **The actually catastrophic bug, found only after fixing (1) let playback run long enough to hit
   it**: `initBaseAudioTime()` (called from `checkAudioTimestamp()` whenever `baseAudioTime` is
   still the `-1` "needs (re)init" sentinel — which happens once at session start, and again every
   time `resetBaseDecodingTime()` fires an A/V-drift resync) used to reassign **`this.baseVideoTime`**
   (not `this.baseAudioTime`, despite the function's name) from an *absolute* wall-clock-anchored
   formula (`receiveTimeStamp.utcTimeStamp` scaled against `baseNTPTimestamp`) whenever
   `baseVideoTime` was falsy. `baseVideoTime` is a purely *relative*, monotonically
   self-accumulating clock everywhere else in this class (`updateVideoTimestamp()`'s own
   `baseVideoTime += frameDuration`, starting from 0) — harmless the very first time this function
   ever runs, since `baseVideoTime` is 0 by its field default either way, regardless of which
   formula "sets" it. But `resetBaseDecodingTime()` (the very thing that put `baseAudioTime` back
   into its `-1` sentinel state) *also* zeroes `baseVideoTime` itself, specifically **only for
   Playback mode** (`if (this.playbackFlag) { this.baseVideoTime = 0; }`) — so every drift-triggered
   resync *mid-session*, in Playback mode specifically, re-triggered this same falsy-check and
   clobbered the relative clock with an absolute millisecond-scale value instead. Confirmed live via
   direct instrumentation: `baseVideoTime` jumped from a normal ~65,000 (TIME_SCALE units, i.e.
   ~6.5s) to ~75,000,000 (~7,500s) between two consecutive `updateVideoTimestamp()` calls, with
   every later call continuing to accumulate on top of that corrupted base — `currentTime` jumping
   to a nonsensical multi-thousand-second value, and the buffered edge/live playback position
   effectively never converging again (matching the reported 20+ second "latency": the video
   element's `currentTime` was chasing a timeline that had been yanked thousands of seconds into
   the future relative to what was actually buffered around it).

   Live mode's own equivalent resync path never zeroes `baseVideoTime` first (see
   `resetBaseDecodingTime()`'s own `if (this.playbackFlag)` guard) — so a real H264/H265 Live
   session hitting this same drift-resync code never had a *freshly-zeroed-but-still-meaningfully-
   relative* value there to corrupt, which is almost certainly why this specific bug went unnoticed
   until MJPEG's Playback tier (with its dummy-audio-heavy timing, more prone to triggering A/V
   drift than a real synced audio track) exercised it.

   **Fixed by deleting the destructive reassignment entirely** — `baseVideoTime` is always already
   valid by the time `initBaseAudioTime()` runs (either its 0 default, or whatever
   `resetBaseDecodingTime()`/prior `updateVideoTimestamp()` accumulation already set), so nothing
   needs deriving there at all; the function's own existing fallback a few lines below (using
   `this.baseVideoTime` as `baseAudioTime`'s value for a dummy/zero-timestamp audio sample) already
   reads the un-corrupted value correctly once the reassignment is gone.

**Verified**: same synthetic-JPEG trace harness, 2fps/500ms pacing, 30 real seconds — the
multi-thousand-second `currentTime` jump is gone entirely (stays in the low single digits/tens
throughout), confirmed against both the unminified and production `npm run build:player` output,
and against the existing Live-mode (320x240 and 2048x1536) scenarios to confirm no regression there.

**Still open, found by the same trace, not yet root-caused**: even after both fixes, the trace shows
`currentTime` occasionally oscillating within a narrow (~0.5-0.7s) range for several real seconds at
a time (e.g. bouncing between displaying frame 23 and frame 24 repeatedly, `currentTime` cycling
~4.0-4.7, rather than monotonically advancing) before eventually jumping forward to later buffered
content. This is a real, reproducible pattern in the synthetic harness — smaller in magnitude than
the two bugs above (no data corruption, no crash, playback does eventually progress), but still
worth root-causing; not yet done, given the scope already covered in this session. Candidate
starting points for a future pass: `videoUpdating()`'s Playback branch (`boxsize`-transition
`currentTime` jump-to-end, the Safari-specific `currentTime < startTime` correction) and whether the
`<video>` element is being told to stay in `play()` state continuously enough across the more
frequent `createSegment()` calls fix (1) introduced.

**How to apply**: don't treat "the OSD stopped showing a wildly wrong number" as proof playback
timing is now fully correct — this session found two independent bugs in the same code path in
sequence (fix (1) was necessary to even reach and reproduce bug (2) reliably), and the trace
technique used here (color-keyed synthetic frames + a sampling canvas, logged against real elapsed
wall-clock time) is worth reusing directly for the next investigation rather than reasoning about
`baseVideoTime`/`baseAudioTime` arithmetic from source reading alone — that approach missed both of
these bugs on the first pass and only found them once a live trace was actually run.

## MJPEG-encoder tier, fifth real bug: `onWaiting()`'s per-event truncation and `videoPlay()`'s fixed 1s resume margin, both tuned for H264/H265's larger segments

Fifth bug in this saga, found continuing the same synthetic-JPEG trace from the fourth bug's "still
open" oscillation note (`currentTime` bouncing in a narrow ~0.5-0.7s range for several seconds before
eventually progressing) — root-caused via native `<video>` element event tracing
(`seeking`/`seeked`/`waiting`/`stalled`/`pause`/`play`/`playing`/`ratechange` listeners logged against
real elapsed time), not just the color-sampling trace, since the oscillation itself needed to be
correlated with the browser's own buffering state transitions to explain.

Two independent over-aggressive corrections, both pre-existing and both written with H264/H265's
typically-larger, multi-second-per-append Playback segments in mind — MJPEG's re-encoded tier appends
much smaller, more frequent segments (real-time-paced, ~0.5-1.5s of new content per append), which
hits both far more often than any prior codec did:

1. **`onWaiting()` used to unconditionally truncate `currentTime` to the floor integer second**
   (`videoElement.currentTime = parseInt(String(videoElement.currentTime), 10)`) on *every* 'waiting'
   event that didn't hit the large-backlog branch above it — not just the rare recovery case that
   truncation is actually meant for. Confirmed live: a real MJPEG Playback session hits ordinary
   'waiting' pauses every ~0.5-0.9s (matching its own small/frequent segment cadence), and got
   `currentTime` rewound by up to a full second on *every one* of them (e.g. 4.79 -> 4.0 -> plays
   forward to ~4.79 -> 'waiting' -> rewound to 4.0 again, repeating indefinitely) — exactly what read
   live as a burned-in OSD timestamp oscillating instead of advancing, and as "latency" building up
   (real playback progress was being discarded every cycle, not actually stalled). Fixed: only
   truncate when `currentTime` is genuinely out of the valid buffered range (non-finite, or at/past
   `endTime`) — an ordinary wait for a few more frames at the buffered edge is now left alone
   entirely, letting the browser's own buffered-position recovery resume it naturally.

2. **`videoPlay()` used to require a full `PLAYBACK_BUFFERING_TIME` (1s) buffer-ahead margin before
   *every* resume from pause**, not just the initial cold start — reasonable for H264/H265 cameras,
   whose Playback segments typically carry several seconds of margin per append, but a permanent
   deadlock for MJPEG's small real-time-paced increments: once mid-playback, `currentTime` naturally
   catches up close to the buffered edge between appends, and if the browser paused for a normal
   buffering wait right as the margin dipped under 1s, every subsequent `videoPlay()` attempt kept
   refusing to resume until a full second of buffer-ahead accumulated — which a slow, real-time-
   matched trickle of small segments may never do, stalling the session forever even though new data
   kept arriving and appending successfully throughout. Fixed: the 1s margin still applies to the
   genuine cold-start case (`currentTime === 0`), but a mid-session resume now only requires
   `latency <= 0` (i.e. don't resume only when there's *literally* nothing new buffered yet).

**Verified**: same synthetic-JPEG trace plus native `<video>` event listeners, 2fps/500ms pacing —
neither fix alone nor together fully resolved the underlying stall (see the sixth bug below, found
immediately after), but both are correct, narrowly-scoped fixes in their own right (confirmed via the
native event trace that 'waiting' cadence and resume attempts behave as intended afterward) and were
kept.

**How to apply**: a correction tuned against one codec's typical timing (H264/H265's larger, sparser
Playback segments) can be silently wrong for another's (MJPEG's smaller, real-time-paced ones) without
ever being codec-specific in its own logic — the bug is in the *assumption* about append size/cadence,
not the codec check. When a `<video>`-tag correction path fires "too often" for a new codec tier,
suspect the threshold/margin's original tuning before suspecting the new tier's data itself.

## MJPEG-encoder tier, sixth real bug: A/V-drift resync compares real `baseVideoTime` against *synthetic* dummy-audio `baseAudioTime`, repeatedly discarding real buffered progress

Sixth bug, found immediately after the fifth — neither of the fifth bug's fixes actually resolved the
underlying stall reported live (user: OSD cycling "27 -> 28 -> 27 -> 28"; separately, "the input is
2fps, so first check why the output comes out at 7fps"). Root-caused by adding direct instrumentation
(temporary logging in `sourceBufferEventListener`'s `'updateend'` case, printing the SourceBuffer's own
`buffered.end()` after every append) to the same synthetic-JPEG trace harness, run at a realistic
2fps/500ms pacing for 30+ real seconds — chosen after tracing `appendBuffer()`/`VideoEncoder` output
counts first confirmed the encoder pipeline itself was healthy (chunks encoding and appending
successfully and continuously, no backpressure drops) so the freeze had to be in the muxed timestamps,
not the data flow.

**What the trace found**: `sourceBuffer.buffered`'s end value grows steadily (0 -> 0.9 -> 2.4 -> ... ->
5.9s) for the first ~10 real seconds, then **freezes** — dozens more chunks encode and append
successfully afterward (confirmed: `appendBuffer()` calls keep succeeding, byte lengths keep growing),
but `buffered.end()` never advances past that point again, and native `<video>` `currentTime` gets
stuck oscillating within the already-buffered range. Adding one more log — at `onWaiting()`'s A/V-drift
resync check (`Math.abs(this.baseVideoTime - this.baseAudioTime) > 20000`) — caught it firing at
exactly the moment the freeze began: `{baseVideoTime: 85000, baseAudioTime: 58880, dummyAudio: true}`.

**Root cause**: this drift check exists to catch a real audio track actually desyncing from video — but
it runs unconditionally, even when `dummyAudio` is `true` (MJPEG's re-encoder tier has no real audio at
all; `baseAudioTime` only advances via `makeDummyAudio()`'s synthetic seeding, an approximation to
satisfy MSE's technical requirement for *an* audio track, not a real timing signal). Dummy audio's
duration accounting routinely drifts several seconds from real video progress with no actual desync
having occurred — in the trace above, a ~2.6s gap that's just normal dummy-audio slop, not a bug on its
own. But once the >20000 (2s) threshold trips, `resetBaseDecodingTime()` zeroes `this.baseVideoTime`
back to `0` (Playback-only, see the fourth bug's entry above for why) — discarding several real seconds
of already-accumulated progress. Every subsequently-muxed segment then gets a PTS computed from that
zeroed base, landing back *inside* the range already covered by the buffer instead of extending past
it — MSE just merges the overlap in place, so `buffered.end()` stops advancing even though appends keep
succeeding. And because MJPEG's small, frequent segments hit `onWaiting()` roughly every 0.5-0.9s (see
the fifth bug above), this reset re-triggers on nearly every subsequent wait, permanently pinning
playback just past where the first reset happened — which also explains the reported OSD
cycling/apparent-fps-mismatch: the video element keeps re-rendering whatever narrow already-buffered
range it can reach, never actually receiving new reachable content again.

**Fixed**: skip this resync check entirely while `dummyAudio` is `true` —
```ts
if (this.localSpeedValue === 1 && !this.dummyAudio && Math.abs(this.baseVideoTime - this.baseAudioTime) > 20000) {
  this.resetBaseDecodingTime();
}
```
A real second audio track (`dummyAudio === false`) still gets exactly the same resync behavior as
before; only the synthetic-audio case (currently only MJPEG's re-encoder tier) is exempted, since
there's no genuine A/V relationship there to protect.

**Verified**: same synthetic-JPEG trace, 2fps/500ms pacing, direct `[DEBUG-RESET]` instrumentation
confirmed this was the only remaining reset trigger firing during the stall window; after the fix,
`buffered.end()`/`displayedFrame`/`currentTime` all advance continuously and monotonically for the
full ~20 real seconds of fed input (displayedFrame reaching 28/40 by the time input stopped, matching
the async encode pipeline's expected catch-up lag — not a stall), with the harness's tail-end stall
after input stops being the expected "no more data" `waiting`/`pause` behavior, not a repeat of this
bug. All temporary `[DEBUG-*]` logging (`DEBUG-VU`/`DEBUG-BP`/`DEBUG-CHUNK`/`DEBUG-APPEND`/
`DEBUG-UE2`/`DEBUG-RESET`) added across this and the two prior bugs' investigations was removed once
this fix was confirmed. Re-ran the full `npx tsc -b` + `npx vitest run` (63 tests) suite clean.

**How to apply**: any code that compares two independently-accumulated "clocks" to detect drift needs
to ask whether *both* sides are real signals before treating a gap as evidence of desync — a synthetic/
placeholder clock (dummy audio, a stub timestamp, a default value standing in for "no real data yet")
will drift from a real one by construction, not because anything is actually wrong. This is the second
bug in this saga traced to `resetBaseDecodingTime()`'s Playback-specific `baseVideoTime = 0` (see the
fourth bug above for the first) — worth being suspicious of *any* remaining trigger for it if MJPEG
Playback shows another stall-shaped symptom in the future, rather than assuming this was the last one.

## `applySrcAttribute()` silently discarded a camera recording `src`'s mode/start/end/OverlappedID (fixed)

Reported symptom: pasting `rtsp://<camera>/0/recording/20260903140724-20260903150724/OverlappedID=0/play.smp`
as `src` — exactly the shape `generateRTSPURL()`'s own camera `playback` branch produces — resolved,
per the RTSP URL demo page's "Resolved connection URL" field, to `rtsp://<camera>/0/recording/media.smp`
instead: the entire start/end/`OverlappedID` range vanished and the URL took the *live* shape
(`{channel}/{profile}/media.smp`) rather than the playback one. The resulting RTSP `OPTIONS` 404'd
against that nonexistent resource. User's own read of the symptom (before the root cause was found):
"recording이 보이면 rtsp-over-websocket이 playback 모드로 동작해야 하는것으로 보입니다" ("if 'recording'
appears [in the path], this should switch to playback mode") — which turned out to be exactly right.

Root cause: `applySrcAttribute()`'s camera-mode path parsing (`RTSPOverWebSocket.ts`, `deviceType ===
'camera'` branch) only ever understood the *live* path shape — it read `segments[1]` unconditionally as
a profile name (`profile1`, or a literal profile string), with no awareness that camera playback/backup
URLs use a structurally different shape: `{channel}/recording/{start}[-{end}]/OverlappedID={id}/
play.smp`. So `segments[1] === 'recording'` fell straight into the plain-profile case and got written
out as `setAttribute('profile', 'recording')` — nonsense, and worse, silently absorbed what should have
been parsed as the playback marker. `mode` was never inferred from the path at all for camera devices
(only nvr mode had a path-embedded legacy-fallback parser, for its own different `key=value` shape), so
it stayed at its `'live'` default, and the start/end/`OverlappedID` segments were simply never looked at
— dropped on the floor. `generateRTSPURL()` then ran its `live` branch with the bogus `profile =
'recording'`, producing exactly the broken URL reported.

Fixed in `applySrcAttribute()`: when the trailing filename (now captured into `smpFilename` before
being popped off `segments`, instead of just discarded) is `play.smp`, treat the rest of the path as
the playback shape instead of a profile — set `mode = 'playback'` (unless an explicit `?mode=` query
param already provided one), parse `segments[2]` as `{start}[-{end}]`
(`/^(\d{14})(?:-(\d{14}))?$/`) and `segments[3]` as `OverlappedID={id}`, deferring to any real `?query`
value the same way the existing nvr-mode path fallback already does (`queryProvidedKeys`).

**Correction made same-day, before this shipped**: the first version of this fix keyed the branch off
`segments[1] === 'recording'` instead of the trailing filename — the user caught this: `'recording'` is
the literal `generateRTSPURL()` writes for *both* the `playback` and `backup` `info.media.type`
branches (its `playType` variable is computed once, from `type !== 'live'`, before either branch runs),
so it can't actually distinguish a playback URL from a backup one. `play.smp` vs `backup.smp` is what
does. Re-keyed off `smpFilename === 'play.smp'` instead; `backup.smp` still falls through to the
plain-profile case unchanged, since `play()` — the method `applySrcAttribute()` calls to reconnect —
has no `'backup'` `info.media.type` path of its own (only the separate `backup()` method does, a
different call shape entirely from "reconnect this `src`"), so there was nothing correct to wire a
`backup.smp` branch up to yet.

The tricky part was the start/end conversion: `generateRTSPURL()` builds those compact `YYYYMMDDHHMMSS`
digit pairs by taking the true-UTC `startTime`/`endTime`, shifting forward by `GMT` hours, then
stripping punctuation (`GMT`-zone local wall clock, not UTC, encoded with no timezone marker at all).
Reconstructing the original true-UTC value therefore needs the *device's* `GMT` at parse time, not `0`
— confirmed by the user testing against a real camera at `GMT = +09:00`. Rather than duplicating that
GMT-subtraction math in the parser, the fix re-punctuates the digits into a naive ISO string
(`YYYY-MM-DDTHH:mm:ss`, no `Z`/offset — via a new small module-level `formatCompactTimestampAsNaiveIso()`
helper) and assigns it through the existing `startTime`/`endTime` setters, which already convert exactly
that naive-ISO-from-`GMT`-zone shape to true UTC via `normalizeTimeInputToUtcIso()` — reusing tested
logic instead of re-deriving it. Hand-verified the full round trip at `GMT = 9`:
`20260903140724-20260903150724` → true-UTC `2026-09-03T05:07:24.000Z`/`06:07:24.000Z` → back through
`generateRTSPURL()` to the byte-identical `20260903140724-20260903150724` path segment.

See `docs/player/01-elements-interface-exceptions.md`'s `applySrcAttribute()` bullet and History table
for the line-referenced detail.

### Follow-up, same day: `play.smp` isn't guaranteed to be the *last* path segment

The user pointed out a further real input shape: a camera recording `src` can carry trailing legacy
`key=value` pseudo-params *after* `play.smp`, not just before it — e.g.
`rtsp://<camera>/0/recording/{start}-{end}/OverlappedID=0/play.smp/device=camera/gmt=9/mode=playback`
— or the same thing via a real `?query` string instead:
`.../play.smp?device=camera&gmt=9&mode=playback`. Two gaps this exposed in the fix above:

1. The `.smp` search only checked `segments[segments.length - 1]` — with trailing pseudo-param
   segments after it, `play.smp` is no longer last, so `smpFilename` never got set at all and the
   whole recording-shape branch silently didn't run (regressing back to the original bug for this
   input shape specifically).
2. Camera mode had no equivalent of nvr's own legacy path-embedded `key=value` fallback (see the
   original 2026-08-26 nvr-mode entry, and `docs/player/01-elements-interface-exceptions.md`), so
   even once `play.smp` was found, a trailing `gmt=9`/`mode=playback` pseudo-param had nowhere to go
   — `gmt` in particular needed to be applied *before* the start/end conversion runs (that
   conversion reads `this.GMT` synchronously), so simply detecting the pair wasn't enough; ordering
   mattered too.

The user also clarified the intended `mode` precedence directly: *"mode가 없으면 그냥 live이고, mode가
존재하면 mode 값을 적용하도록 하는 것입니다"* ("if there's no mode, it's just live; if mode exists,
apply that value") — i.e. an explicit `mode=` (from either a real `?query` or a legacy path pair)
should always win over the `play.smp`-shape inference this fix added, not be redundantly
overwritten by it.

Fixed with three changes in `applySrcAttribute()`:
- The `.smp` search now uses `segments.findIndex()` + `splice()` to find and remove it from anywhere
  in the path, not just check-and-pop the last element.
- The legacy `key=value` pseudo-param scan (previously nested inside the nvr-only `else if` branch)
  was hoisted out to run unconditionally for both device types, positioned right after channel
  resolution and *before* the camera recording-shape block — so a path-embedded `gmt=9` is already
  applied to `this.GMT` by the time that block converts the compact start/end digits, and a
  path-embedded `mode=playback` is already applied before that block's own inference would run.
- The scan now also adds each key it applies to the same `queryProvidedKeys` set the real `?query`
  loop populates (previously only read from it) — so the recording-shape block's existing
  `!queryProvidedKeys.has('mode')` check (unchanged) already gives the right precedence once fed
  from this wider set: no explicit `mode=` anywhere → the `play.smp`-shape inference applies (this
  fix's whole point); an explicit `mode=`, from either source → that value wins, unchanged by the
  inference.

Verified by hand-tracing both new URL shapes end-to-end: both resolve to the identical
`{GMT: 9, mode: 'playback', startTime: '2026-09-03T05:07:24.000Z', endTime:
'2026-09-03T06:07:24.000Z', overlappedId: '0'}` state, and the original no-pseudo-params URL from
the fix above still resolves the same way it did before (mode inferred as `'playback'` from the
`play.smp` shape alone, `GMT` unaffected since nothing sets it).

### Second follow-up, same day: gate on `mode`, and accept a bare compact digit `start=`/`end=` value

Two more requests from the user, testing further real-world `src` shapes:

1. *"smpFilename이 아니라 mode로 처리하도록 수정해줘"* ("make it process via `mode`, not
   `smpFilename`") — the recording-shape block (start/end/`OverlappedID` parsing) was gated on
   `smpFilename === 'play.smp'` directly. Re-gated on `this.mode === 'playback'` instead: the
   `play.smp`-shape inference (`smpFilename === 'play.smp' && !queryProvidedKeys.has('mode')` →
   `setAttribute('mode', 'playback')`) now runs *before* the gate check and feeds into it, rather
   than being the gate itself. This makes the parser symmetric with `generateRTSPURL()`'s own camera
   branch, which dispatches on `info.media.type` (`mode`'s underlying source) to decide what to
   *write*, never on which filename it happens to produce.
2. A further real shape: `rtsp://<camera>/0/recording/play.smp/device=camera/gmt=9/
   start=20260903140724/end=20260903150724/overlappedid=0` (or the same as a real `?query` string)
   — `start`/`end` given as *separate* `key=value` pairs, each holding the bare compact
   `YYYYMMDDHHMMSS` digit string (not the combined `{start}-{end}` range segment this fix originally
   handled, and not a full ISO string either). Both the real `?query` loop's and the legacy path
   scan's `start`/`end` cases previously assigned the raw value straight to `startTime`/`endTime`
   — those setters only accept a full ISO string, so a bare compact value there threw
   `RTSPOverWebSocketError` 0x0414 ("Invalid input parameter type... ISO time format"). Fixed with a
   new small module-level `normalizeStartEndInput()` helper (regex-detects a bare 14-digit string
   and re-punctuates it via the existing `formatCompactTimestampAsNaiveIso()`; anything else passes
   through unchanged for the setters' own validation to accept or reject as before), wired into both
   call sites.

Verified end-to-end (including a regression check against every URL shape traced so far, plus a
plain live `.../profile1/media.smp` to confirm `profile` parsing is unaffected by the `mode`-gating
change) — all resolve to the expected `{GMT, mode, startTime, endTime, overlappedId}`/`profile`
state, with no change in outcome for any shape this fix already handled correctly.

### Third follow-up, same day: `start_time`/`end_time` as alternate key names

One more real shape the user tested: `start`/`end` given under the longer key names `start_time`/
`end_time`, with a full naive-ISO value instead of the compact digit string —
`rtsp://<camera>/0/recording/play.smp/device=camera/gmt=9/start_time=2026-09-03T14:07:24/
end_time=2026-09-03T15:07:24/overlappedid=0` (and the same as a real `?query` string). Since
`normalizeStartEndInput()` (added in the second follow-up) already passes any value through
unchanged unless it's a bare 14-digit compact string, a full naive-ISO value like
`2026-09-03T14:07:24` needed no new conversion logic — just recognizing the alternate key name.
Added `case 'start_time':` falling through to the existing `case 'start':` (and `'end_time'` to
`'end'`) in both the real `?query` loop's switch and the legacy path-scan's switch. Also widened
the recording-shape block's own `!queryProvidedKeys.has('start')`/`'end'` deferral checks to also
check `'start_time'`/`'end_time'` — otherwise a `start_time=`-only `src` (no plain `start=`) would
have left that check blind to it, letting the block's own `segments[2]` positional range parsing
run on top regardless (harmless for the user's actual URLs, since `segments[2]` isn't a real range
there, but a real correctness gap in principle).

Verified all four `start=`/`start_time=` × path-embedded/`?query` combinations resolve to the
identical `{GMT: 9, mode: 'playback', startTime: '2026-09-03T05:07:24.000Z', endTime:
'2026-09-03T06:07:24.000Z', overlappedId: '0'}` state.

### Fourth follow-up, same day: removed the `play.smp`-filename `mode` inference entirely

The user's final instruction on this thread: *"smpFilename 의 구분은 삭제해줘"* ("delete the
`smpFilename` distinction"). Up to this point, `mode` had a filename-based fallback: if no explicit
`mode=` was given anywhere, `smpFilename === 'play.smp'` inferred `mode = 'playback'` (this is what
made the *original* reported URL — `.../recording/{start}-{end}/OverlappedID=0/play.smp`, no
`mode=` at all — resolve correctly in the first place). The user asked to remove that inference
outright, leaving `mode` resolved *purely* from an explicit source (real `?query` or legacy
path-embedded `mode=`), defaulting to `live` with no filename fallback at all.

Removed: the `if (smpFilename === 'play.smp' && !queryProvidedKeys.has('mode')) { this.setAttribute
('mode', 'playback'); }` inference block, and the now-fully-unused `smpFilename` variable itself
(the `.smp`-segment search/removal from `segments` is still needed and stays — a trailing
`play.smp`/`media.smp`/`backup.smp` segment would otherwise still get misread as a profile or a
legacy `key=value` pair — it's just no longer captured into a named variable, since nothing reads
its value anymore). The recording-shape block's gate is now simply `if (this.mode === 'playback')`
with nothing feeding it but explicit sources.

**Real, deliberate consequence**: the *original* reported bug URL, with no `mode=` anywhere, no
longer auto-resolves to `playback` — it now needs an explicit `mode=playback` (path-embedded or
`?query`) to hit the recording-shape branch at all; without one, `segments[1]` (`'recording'`) is
read as a literal profile name via the plain-profile case, exactly like before this whole fix
existed. Confirmed via the same hand-trace harness used throughout this thread: that exact URL now
resolves `{mode: 'live', profile: 'recording', overlappedId: '0', startTime/endTime: undefined}`
(the shared legacy-`key=value` scan still finds `OverlappedID=0` regardless of the `mode` gate,
since that scan doesn't consult `mode`) instead of the `playback` state it resolved to under the
prior (filename-inferring) version of this fix. This is intentional, not a regression — flagged
explicitly to the user as a real behavior change at the time it shipped, since it means any real
caller relying on the old "`play.smp` alone implies playback" auto-detection needs to start
supplying an explicit `mode=playback` instead.

### Fifth follow-up, same day: the fourth follow-up's removal was a real regression, not just a
tradeoff — restored, keyed on the `recording` segment instead of the filename

The fourth follow-up above removed the `play.smp`-filename `mode` inference entirely, expecting the
"original URL now needs an explicit `mode=`" outcome to be an accepted, deliberate simplification.
It wasn't — the user came back and reported, using two further URL shapes (`start_time=`/`end_time=`
variants, both path-embedded and `?query`), that the "RTSP URL" demo page's *Resolved connection
URL* field showed `rtsp://192.168.214.40/0/recording/media.smp` instead of the expected
`rtsp://192.168.214.40/0/recording/<start>-<end>/OverlappedID=<id>/play.smp`. This is exactly the
consequence flagged in the fourth follow-up's own writeup — neither of the user's two new URLs
carries an explicit `mode=` either, so with the filename-based inference gone entirely, `mode` fell
back to `live`, `profileSegment` (`'recording'`) got written out as a literal `profile` value, and
`generateRTSPURL()`'s `live` branch produced `{channel}/{profile}/media.smp` = `.../recording/
media.smp` — the exact symptom this whole investigation started from, resurrected.

Fixed by restoring a fallback inference for `mode`, but this time keyed on the literal `recording`
**path segment** (`profileSegment === 'recording'`, `segments[1]`) instead of the trailing filename
— satisfying the fourth follow-up's actual request ("delete the *filename* distinction") while still
covering the case an explicit `mode=` doesn't. Step 2's original objection to using the `recording`
segment — that it's shared by both the `playback` and `backup` shapes and so can't distinguish them
— turns out not to matter for *this* particular inference: `play()` (the method
`applySrcAttribute()` calls to reconnect a `src`) has no `'backup'` `info.media.type` path of its
own at all, only the unrelated `backup()` method does, so inferring `'playback'` is the only
sensible outcome here regardless of which the original `src` was conceptually "for". The gate stays
exactly as the third follow-up left it — `if (this.mode === 'playback')`, fed in priority order by:
an explicit `?query`/legacy-path `mode=` value, then this `recording`-segment inference, then this
element's `'live'` baseline.

Verified the full round trip is restored: `20260903140724-20260903150724` (no `mode=` anywhere) →
inferred `mode: 'playback'` → true-UTC `startTime`/`endTime` → back through `generateRTSPURL()` to
the exact expected `rtsp://192.168.214.40/0/recording/20260903140724-20260903150724/
OverlappedID=0/play.smp` — plus re-verified every other URL shape traced across all five iterations
of this fix still resolves correctly, with no regressions.

**How to apply**: when a user says "remove X" in response to a design concern, confirm what specific
mechanism they mean before assuming the *behavior* X enabled should also disappear — here "delete
the `smpFilename` distinction" meant "stop checking the filename specifically", not "stop inferring
`mode` at all when it's not given explicitly". Flagging the consequence up front (as the fourth
follow-up did) is good practice, but isn't a substitute for confirming intent before shipping a
behavior-changing removal, especially in a thread where the user has been iterating on real-world
URL shapes one at a time rather than stating a complete spec up front.

### Sixth follow-up, same day: mirror `mode` onto `info.media.type` immediately

Requested directly: whenever the recording-shape block resolves `mode === 'playback'`, it should
also set `this.info.media.type = 'playback'` right there, not leave it to `play()`'s own assignment
(in its `playType !== LIVE/INSTANTPLAYBACK` branch) to catch up moments later at the very end of
`applySrcAttribute()`. `generateRTSPURL()`'s camera branch reads `info.media.type` directly, not
`mode`/`playType` — added `this.info.media.type = 'playback';` as the first statement inside the
`if (this.mode === 'playback')` block, so anything that calls `generateRTSPURL()` or otherwise
inspects `info.media.type` between this parse finishing and `play()` actually running no longer sees
a stale value left over from this element's previous connection.

### Seventh follow-up, same day: reset every session-identifying field on every `applySrcAttribute()` call

The user's next request, stepping back from the `mode`/`start`/`end` specifics to the whole method:
*"applySrcAttribute이 호출될때마다 this._username, this._password, this._hostname, this.port,
this._sessionKey, this.startTime, this.endTime, this.overlappedId, this._device, this._multicast,
this.mode, this.profile, this.profile_number 등의 값이 초기화 되어야 합니다"* — every one of these
should reset to its default at the top of every call, not just conditionally (the existing logic
only cleared `username`/`password`, and only when `hostname` changed).

Implemented as a single block at the very top of `applySrcAttribute()`, before any parsing of the
new `src` begins:
- `username`/`password` → `setAttribute(..., '')` (not `removeAttribute()` — same reasoning as the
  original 2026-08-26 hostname-change fix this supersedes: `removeAttribute()` would set
  `info.device.username`/`password` to `undefined`, which `StreamPlayer.ts`'s `open()` throws on,
  unlike `''`, this class's actual "no credentials" state).
- `hostname`/`port`/`device` → `removeAttribute()` (safe — none of their `attributeChangedCallback`
  cases validate/throw on a `null` `newValue`; this also keeps their `info.device.*` mirrors in
  sync, which poking the private field directly would have missed).
- `sessionKey`/`startTime`/`endTime`/`overlappedId` → their own property setters, `= null` (these
  were never real attributes, just plain properties; `null` is the same reset value `stop()`
  already uses for `startTime` elsewhere, for the same "clear a stale range" reason).
- `multicast`/`mode`/`profile`/`profile_number` → assigned **directly** to the private field
  (`_multicast`/`_playType`/`_profile`/`_profile_number`), bypassing `setAttribute`/
  `removeAttribute`/the property setters entirely. Three different reasons this was necessary,
  found while implementing:
  - `mode`'s setter throws `RTSPOverWebSocketError` for anything that isn't a `string`
    (`typeof v !== 'string'`) — and a `removeAttribute()`-triggered case fire passes `null`.
  - `profile`/`profile_number`'s own `attributeChangedCallback` cases both throw for a
    non-string/non-integer `newValue` — `null` again always qualifies.
  - `multicast`'s case (`case 'multicast': { this._multicast = true; break; }`) has a pre-existing
    quirk: it sets `true` **unconditionally** whenever the case fires at all, never actually
    checking `newValue` — so `removeAttribute('multicast')` wouldn't reset it to `false`, it would
    (per this quirk) set it to `true`, the exact opposite of a reset.

Since the reset now unconditionally clears `hostname` (via `removeAttribute()`) *before* the old
`previousHostname`/`hostnameChanged` comparison logic would have run, that comparison always reads
`previousHostname === null` now — making the entire hostname-change-conditional credential-clearing
block from 2026-08-26 permanently dead code (it can never fire; `hostnameChanged` is always
`false`). Removed that block outright rather than leaving unreachable code with an elaborate
comment describing behavior that no longer applies — the new unconditional reset already produces
the same net effect (and more: it also handles the "first `src`" case identically to every other
case, rather than special-casing it).

**Real, deliberate consequence, checked but not fully resolved**: the old hostname-change fix's own
comment explicitly protected a "set `username`/`password` as properties, then `src` separately"
flow (attributed to "this page's Player tab"). Checked this repo's own `src/index.html` and
`react/Player.tsx` for that exact pattern (property assignment followed by a *separate* `src`
assignment on the *same* element) and found none currently — the "RTSP URL" tab's SUNAPI-checked
flow sets `username`/`sunapiClient` then calls `.play()` directly, never also touching `.src`; the
"Player" tab sets `username`/`password` as properties but never assigns `.src` at all, using
individual `hostname`/`port`/etc. properties plus a separate `.play()` call instead. So nothing in
this repo's own code broke. But an *external* consumer of this element following the pattern the
old comment described (set credentials as properties, then assign `src` to connect) would now find
those credentials wiped the moment `src` is assigned, unless the `src` URL's own authority component
supplies them. Flagged explicitly to the user rather than silently shipped.

## MJPEG-encoder tier, seventh real bug: `WebCodecsVideoEncoder`'s invisible decode-stage backpressure gap, plus a zero-margin `currentTime` snap — both found live against a real 2048x1536 camera as a negative "Statistics" `Latency`

Seventh bug in this saga, reported after the sixth fix held up: the user's real device console
showed a "Statistics" panel `Latency` value of **-6.4240 secs** after playing a real 2048x1536 MJPEG
Playback session for a few minutes, with the `<video>` element visibly stuck (`2:55 / 4:02`,
paused-looking). `Latency` is computed in `getCurrentVideoFrame()` as
`sourceBuffer.buffered.end(...) - videoElement.currentTime` — negative means **`currentTime` is
already past the actual buffered end**, which can only happen from an explicit `currentTime =`
assignment (normal monotonic playback can never outrun what's buffered on its own), refreshed live
every second by the class's own `statisticsTimer`, so this wasn't a stale reading.

Root-caused two independent contributing issues, using a new synthetic Playwright trace built
specifically to stress-test at the real camera's own resolution and content entropy (2048x1536,
per-pixel random noise JPEGs — a flat/solid-color synthetic frame, used by every earlier trace in
this saga, decodes/encodes almost for free and never exposed either of these):

1. **`WebCodecsVideoEncoder.encode()`'s `createImageBitmap()` decode step was invisible to the
   caller's backpressure check.** `encode()` is `async` and `await`s `createImageBitmap()` (real,
   resolution-scaled CPU cost) *before* ever calling `this.encoder.encode()`; `VideoTagPlayer.ts`'s
   `submitMjpegFrame()` calls it fire-and-forget (never awaited) and throttles new frames purely on
   `encodeQueueSize`, which used to return only `encoder.encodeQueueSize` — the underlying
   `VideoEncoder`'s own queue, a count that stays 0 for every frame still stuck mid-decode. A new
   frame arriving every ~500ms while the previous one's `createImageBitmap()` hadn't resolved yet
   just launched another concurrent decode on top of it, with the backpressure check never seeing
   any of it. Confirmed live: in the 2048x1536 noise-JPEG trace, the gap between real received
   content (frames fed × 0.5s) and actually-muxed/buffered content grew from ~1s to ~28s within the
   first real minute, while `encodeQueueSize` read 0 the entire time. Fixed by adding a
   `pendingDecodeCount` field to `WebCodecsVideoEncoder`, incremented at the very start of `encode()`
   and decremented in a `finally` wrapping the *whole* method (every exit path — closed/unconfigured
   guards, a JPEG decode failure, the success path — not just one branch), and folding it into the
   `encodeQueueSize` getter (`encoder.encodeQueueSize + pendingDecodeCount`). The caller's existing
   `MJPEG_ENCODER_MAX_QUEUE_SIZE` check now actually throttles once enough frames are mid-decode, not
   just once enough are mid-encode — no change needed in `VideoTagPlayer.ts` itself.

   **Caveat, not yet resolved**: re-running the same trace after this fix still showed the gap
   growing at roughly the same rate (though `encodeQueueSize`/`pendingDecodeCount` correctly started
   reading 1 partway through, confirming the fix's visibility is now working). This means the
   dominant cost here isn't unbounded *concurrent* decode/encode fan-out (which the fix above
   directly addresses) so much as each individual decode+encode cycle simply taking longer than the
   500ms/frame budget on this test machine — a genuine software-encoding throughput ceiling at full
   2048x1536 resolution, not a pure logic bug. This trace ran in headless Playwright/Chromium, which
   may lack the hardware-accelerated encode path a real desktop browser gets — so this specific
   magnitude (~28s of accumulating lag per real minute) is **not confirmed to reproduce on the user's
   actual hardware**, and the real device's own reported gap (~6s, not tens of seconds and not
   visibly still growing) is smaller and different in character. Left as-is rather than redesigning
   the drop policy (e.g. dropping more aggressively than `MJPEG_ENCODER_MAX_QUEUE_SIZE = 2`) without
   better evidence of what the user's real hardware actually needs — if CPU usage during MJPEG
   Playback turns out to be very high on their machine, that would confirm a genuine throughput
   ceiling and point at lowering `WebCodecsVideoEncoder.ts`'s `BITRATE_BITS_PER_PIXEL`/target quality
   as the next real lever, not a logic fix.

2. **`videoUpdating()`'s Playback `boxsize`-transition branch snapped `currentTime` to the raw
   `buffered.end()` with zero safety margin.** Every *other* currentTime correction in this class
   backs off by `defaultDelay`/`this.delay` first before landing near the buffered edge (this same
   function's own `tempCurrentTime = endTime - this.delay` a few lines below it, and `onWaiting()`'s
   own catch-up jump) — this one alone didn't, landing exactly on `buffered.end()`'s raw value. A
   `SourceBuffer`'s reported `buffered.end()` can sit right at the edge of what's not yet fully
   decodable, especially for this tier's unusually small, frequent, mostly-single-sample segments —
   landing exactly there risks the same currentTime-ahead-of-decodable-data stall as an outright
   overshoot, just a smaller one. Fixed by backing this snap off by `defaultDelay` too (clamped to
   not go behind `startTime`), matching the pattern already used everywhere else in this class.

**Verified**: full `npx tsc -b` + `npx vitest run` (63 tests) clean; re-ran all four established
synthetic scenarios (Live 320x240, Live 2048x1536, Playback 40-frame/20s, Playback 120s continuous)
with no regression from either fix. The specific real-device negative-latency reproduction itself
was **not** independently re-verified live by the user as of this writing (ffprobe against the real
camera's own RTSP URL confirmed reachability and the real SDP — MJPEG 2fps/H264/HEVC alternates,
multiple audio codec choices — but this session's own demo server only relays YouTube sources, so the
real device's exact session couldn't be replayed end-to-end here).

**How to apply**: a synthetic test frame that's cheap to decode/encode (flat color, small resolution)
can hide a genuine CPU-cost-driven backlog bug entirely — six prior bugs in this same saga were all
found and verified with such frames, but this one needed matching the real camera's actual
resolution *and* content entropy (dense noise, not a solid fill) before it reproduced at all. When a
real-device report doesn't reproduce in a lightweight synthetic trace, suspect the trace's own
fidelity to real content cost before ruling the report out. Also: `resolution × entropy`-scaled CPU
cost is a fundamentally different category of bug from every other one in this saga (a genuine
timing/arithmetic mistake, always reproducible identically once found) — it can be hardware-
dependent, and a sandboxed/headless test environment's absolute numbers should not be assumed to
transfer 1:1 to a user's real browser without independent confirmation.

## MJPEG-encoder tier, eighth real bug: `changeCurrentTime()`'s tab-visibility catch-up jump overshoots the buffered end after the tab was backgrounded

Eighth bug in this saga: the seventh bug's two fixes (encoder decode-stage backpressure visibility,
`videoUpdating()`'s boxsize-snap margin) didn't resolve the real device's negative-"Latency" stall —
the user reported it persisted, then added the key clarifying detail: playback stays stopped for as
long as `Latency` reads negative, and *resumes on its own once it turns positive again* (not a
permanent stall). That specific "transient, self-recovering" shape ruled out both prior fixes (they
address the *size* of a margin/backlog, not a jump-then-wait-to-catch-up pattern) and pointed at a
third, still-unexamined `currentTime =` assignment site.

**Root cause**: `changeCurrentTime()` (only caller: `onVisibilityChange()`, wired to the page's
`visibilitychange` event) jumps `currentTime` forward to `lastBoxTime` — an entry a few
`createSegment()`/`createVideoSegment()` calls back in the `boxStartTime` array (which records each
muxed segment's own start time, one push per call) — whenever `currentTime < lastBoxTime`, with
**no validation that `lastBoxTime` is still within what's actually buffered right now**. This is
fine as long as `boxStartTime` always trails close behind `currentTime`, which holds during normal
foreground playback. It breaks the moment a real browser tab is backgrounded for a while: browsers
commonly throttle a hidden tab's `<video>` element (its `currentTime` effectively freezes), but
RTP/WebSocket delivery and this tier's own segment creation aren't necessarily throttled the same
way and can keep running the whole time — so `boxStartTime` keeps growing while `currentTime` stays
put. On refocus, `onVisibilityChange()` fires and `lastBoxTime` now points at a segment appended
*during* the background period, potentially well past what's actually finished
decoding/appending by the time this runs — jumping `currentTime` there can overshoot past the real
buffered frontier, exactly like `onWaiting()`'s catch-up jump or `videoUpdating()`'s boxsize-snap
could (the sixth and seventh bugs' fix sites) — except this jump had no safety margin *and* no
buffered-end validation at all, the most exposed of the three.

Confirmed live with a new synthetic harness: feed frames normally for 6s, freeze `currentTime` via
`videoElement.playbackRate = 0` for 10 more real seconds while feeding (and thus segment creation)
continues uninterrupted — simulating a backgrounded tab's frozen playback clock against still-running
delivery — then restore `playbackRate = 1` and dispatch a real `visibilitychange` event
(`document.visibilityState` stubbed to `'visible'`) matching what a real tab-refocus fires. Without a
fix, the jump landed *past* `sourceBuffer.buffered.end()` (confirmed via an A/B test: reverting the
fix and rebuilding reproduced the overshoot in the exact same harness, `10.500` vs a buffered end of
`10.496`) — a small overshoot in this specific timing, but the mechanism scales with how long the tab
was actually backgrounded, matching a real multi-minute session's much larger reported gap far better
than either of the seventh bug's fixes did.

**Fixed**: clamp `lastBoxTime` to never exceed `sourceBuffer.buffered.end() - this.defaultDelay`
(the same margin-back-off pattern every other currentTime correction in this class already uses)
before comparing/assigning:
```ts
if (this.sourceBuffer !== null && this.sourceBuffer.buffered.length > 0) {
  const bufferedEnd = this.sourceBuffer.buffered.end(this.sourceBuffer.buffered.length - 1) * 1;
  lastBoxTime = Math.min(lastBoxTime, bufferedEnd - this.defaultDelay);
}
```

**Verified**: same harness post-fix — the jump landed at `9.796` (safely under the `10.496` buffered
end at that moment), and playback advanced continuously and smoothly for the full 15s watch window
afterward, no stall. Full `npx tsc -b` + `npx vitest run` (63 tests) clean; re-ran Live 320x240,
Live 2048x1536, and the 120s continuous Playback trace with no regression.

**How to apply**: this is the *third* independent `currentTime =` assignment in this class found
overshooting the buffered frontier in this saga (`onWaiting()`'s catch-up jump already had a margin;
`videoUpdating()`'s boxsize-snap and this one didn't) — before trusting any remaining direct
`videoElement.currentTime = X` assignment in this file, check whether `X` is validated against
`sourceBuffer.buffered.end()` with a safety margin, not just derived from some other internal
bookkeeping value (`boxStartTime`, `endTime` read at a single point in time) that can silently drift
out of sync with what's *actually* still buffered. A symptom's *shape* matters for narrowing which
assignment site is responsible: a permanent stall pointed at a chronic backlog (bug seven); a stall
that's transient and self-recovers once `Latency` crosses back to positive pointed specifically at a
one-shot jump-then-wait pattern (this bug) — the user's own description of the *recovery* behavior,
not just the negative value itself, was the detail that actually narrowed it down.

## `#renderer_type` "canvas" silently ignored for MJPEG cameras — the new real-MSE tier never checked `defaultVideoTagMode` (fixed)

Same class of bug as the H265 case above, hit again the same day for a different codec. When the MJPEG
real-MSE tier (WebCodecs `VideoEncoder` re-encode to H264, see this file's own entry on that feature) was
added to `MediaRouter.ts`'s `selectVideoPlayer()`, its `case 'MJPEG'` block computed `tagMode` purely from
feature detection (`typeof VideoEncoder !== 'undefined'` + `MediaSource.isTypeSupported()`) and never once
read `defaultVideoTagMode` — unlike the `case 'H264': case 'H265':` block immediately below it, which
short-circuits to `defaultVideoTagMode` first on both sides of its own MSE-support check (exactly the
property the H265 fix above spent an entire incident establishing). Net effect: a host forcing
`#renderer_type` "canvas" against an MJPEG stream still got `tagMode = 'video'` whenever the browser
happened to support the real-MSE tier — the override was accepted and stored, just never consulted for
this one codec.

Caught by the user reading the new `case 'MJPEG'` block directly (`MediaRouter.ts:1488`), not a reported
runtime symptom — the same read-the-diff instinct that caught the H265 case's second bug.

Fix: added the identical `if (this.defaultVideoTagMode !== null) { this.tagMode = ...; break; }`
short-circuit ahead of the feature-detection heuristic, mirroring H264/H265's pattern exactly. No change to
the no-override path (feature-detected `'video'`/`'canvas'` choice, still no bridge fallback for this
codec — see that feature's own entry for why).

**How to apply**: any future codec branch added to `selectVideoPlayer`'s `switch` needs its own
`defaultVideoTagMode` short-circuit *from the start* — it's easy to wire up a codec's own
support-detection heuristic and forget this cross-cutting override entirely, since nothing type-checks or
tests would catch its absence (the override is a silent no-op, not an error). Check any new case against
`docs/player/03-mediaSession-core-video.md`'s `selectVideoPlayer` bullet, which now describes this as a
required pattern, not just an H264/H265 particular.

## Playback timestamp cues silently going missing at higher device Scale — `onCueEnter()`/`TextTrack.activeCues` share the same coarse dispatch cadence, fixed with an independent `requestAnimationFrame` poll of the raw cue list

Reported directly by the user: `VideoTagPlayer.ts` delivers each Playback frame's own timestamp to
callers (`timeStampCallback`, used throughout the consuming apps for OSD/UI clock sync) by adding a
`VTTCue` per sample to a hidden `TextTrack` and firing on `cue.onenter` — and this "종종 누락되는"
(occasionally goes missing) at higher requested playback speed.

**First, a wrong assumption corrected along the way**: initially assumed Playback samples' own
`frameDuration` (and thus each cue's video-timeline span) compresses by `1/localSpeedValue`, the same
way `getVideoFrameDuration()` does for *Live* mode. Checked directly: `createVideoSample()`'s Playback
branch never calls `getVideoFrameDuration()` at all — Playback's own segment builder
(`createSegment()`) derives `frameDuration` purely from consecutive `videoSamples[].rtpTimestamp`
deltas, with zero `localSpeedValue` involvement. So a real high-Scale Playback session only actually
plays back faster if the *device* itself reports compressed rtpTimestamp deltas (which this class then
faithfully mirrors into an equally compressed muxed PTS) — there is no player-side speed-compression
mechanism for Playback at all, unlike Live.

**Root cause, confirmed via direct instrumentation (temporary `[DEBUG-CUE]` logging) against a
synthetic harness feeding both compressed rtpTimestamp deltas *and* a proportionally faster real
delivery cadence** (simulating what a real device sending at a high requested Scale would produce):
a first fix attempt — reading `TextTrack.activeCues` from a new `onTimeUpdate()`-driven pull check,
reasoning that `activeCues` is "freshly recomputed from the current position" — made **no measurable
difference at all** (identical results with and without it, confirmed via an A/B test). The trace
explained why: `activeCues` logged `totalCues: 27` at one instant and `totalCues: 0` at the very next
sampled instant — not a narrow miss, but *every* cue in the list being entered and exited within a
single gap between two "time marches on" runs. `TextTrack.activeCues` is itself only recomputed by
that same algorithm, on the same coarse cadence as `onenter`/`onexit` — so polling it, even from a
different event, inherits the identical blind spot. Neither a push (`onenter`) nor a pull
(`activeCues`) approach tied to that algorithm can ever observe a cue whose entire lifetime falls
inside one of its own scheduling gaps.

**Fix**: stopped relying on `TextTrack.activeCues` (or `onenter`/`onexit`) as the *only* signal
entirely. `checkTimestampCueAtCurrentTime()` now searches `track.cues` (the full, static cue list,
unaffected by the "time marches on" algorithm's own batching) directly against the live, always-current
`videoElement.currentTime`, and is driven by a new `requestAnimationFrame` loop
(`startTimestampCuePolling()`/`stopTimestampCuePolling()`, started from `init()`, stopped from
`close()`, only doing work while `playbackFlag` is set) — rAF runs at ~60Hz, far finer than "time
marches on"'s historical ~250ms cadence, so a cue has many more chances to be observed before its
window closes. `onCueEnter()` (the normal, still-useful common case) and this new poll both funnel
through a shared `reportCueTimestamp()`, deduped via a new `lastReportedCue` field so a normally-fired
cue doesn't get double-reported by the poll picking it up too.

**Verified, with an important caveat found while re-confirming it**: a same-speed A/B test (matching
the failed `activeCues` attempt's exact scenario, 8x requested Scale) initially went from 3/30 distinct
timestamps reported (10% coverage) to 27/30 (90%) with this fix. Re-running the identical A/B later the
same session (same machine, now under heavier concurrent load from unrelated processes) showed *no*
difference at all between with/without the fix at that same 8x speed (both ~10%), and at a more modest
2x speed showed both configurations landing at the same ~67% independently of run order — i.e. the
measured percentage is **highly sensitive to how much real CPU is available for the encode/mux pipeline
at the moment of the test**, not a stable property of the fix alone. Under heavy contention, the
dominant bottleneck shifts to encode throughput itself (the seventh bug's territory — see that entry)
rather than cue-scheduling granularity, and no amount of polling can report a timestamp for a frame that
was never muxed into a cue in the first place. The one *reliably reproducible* signal across every
repeat, regardless of load, is directional: this fix never measured worse than the pre-fix baseline in
back-to-back same-load comparisons, and the original clean run demonstrates the mechanism genuinely
closes the scheduling-granularity gap when the encode pipeline itself isn't the bottleneck. Full
`npx tsc -b` + `npx vitest run` (63 tests) clean either way; Live 320x240 unaffected (the poll loop is a
no-op outside `playbackFlag`).

**Residual gap, expected and not fully fixable from here**: even under favorable (low-contention)
conditions, coverage is substantially better but not literally 100% at extreme requested speeds —
firing any cue-shaped event off a `<video>` element's own timeline is fundamentally bounded by how
often *something* samples `currentTime` against the cue list, and rAF (~60Hz) is fast but not infinite;
a real device compressing enough content into a narrow enough window can still produce a cue no poll
ever catches. Under heavy CPU contention (see the caveat above) the gap can be much larger still, for
an entirely different (throughput, not scheduling) reason. This is treated as a hard limit of the
underlying approach (worth flagging to the user, not silently declaring "fixed"), not a bug still left
to chase.

**How to apply**: "poll a value more often" only helps if the value itself isn't *already* rate-limited
by the same underlying mechanism you're trying to route around — `TextTrack.activeCues` looked like an
obvious, spec-blessed escape hatch from `onenter`/`onexit`'s reliability problem, but it's computed by
the exact same algorithm, so it inherited the exact same gap. Confirmed via a live A/B test rather than
assumed from the spec text alone — worth remembering as a second, cheaper instance of this session's
running theme (verify empirically, don't reason from source/spec alone) before trusting the "obvious"
fix for a scheduling-cadence problem.
