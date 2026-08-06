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
  warns (doesn't crash) if it's absent, but ffmpeg publish will fail with `Connection refused` until it's up.
- **The `legacy-player` submodule isn't checked out** in this environment — the large majority of `src/player`'s
  test suite (parity tests) fails with `ENOENT` as a result. This is expected/pre-existing, not a regression from
  any change described above.
