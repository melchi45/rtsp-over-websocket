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
