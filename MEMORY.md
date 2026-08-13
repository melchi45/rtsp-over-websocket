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
