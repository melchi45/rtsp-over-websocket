# Market Requirements Document (MRD)

## 1. Purpose

This document explains *why* this repository exists: the problem it solves, who it's for, and what "success" looks
like. It is intentionally light on implementation — see [PRD.md](PRD.md) for product-level requirements,
[SRS.md](SRS.md) for detailed functional/non-functional requirements, and [ARCHITECTURE.md](ARCHITECTURE.md) /
[DESIGN.md](DESIGN.md) for how the system is actually built.

## 2. Background

The legacy predecessor to `src/player` was a legacy-host-framework-coupled library distributed as a `<script src>` global,
tied to one specific host application's services (`Attributes`, `UniversialManagerService`,
`EventNotificationService`, etc. — see `src/player/legacyHostInterface/types.ts`). Any team wanting browser-native
playback of an RTSP-over-WebSocket camera stream outside that one host app had no supported path: no ESM/TypeScript
build, no framework-neutral API, and no way to exercise the library without a real camera and the full legacy host
stack running.

This project is a from-scratch TypeScript/ESM port of that library's behavior — reproducing it faithfully
(including documented legacy quirks call sites depend on) — packaged as a single, dependency-free
`<rtsp-over-websocket>` custom element, plus a self-contained demo server that makes the element runnable and
testable without any camera hardware.

## 3. Problem statement

- **No framework-neutral player.** Consumers using React, vanilla JS, or any framework other than the legacy host
  app's own stack cannot embed RTSP-over-WebSocket playback today without re-implementing the wire protocol
  themselves.
- **No way to demo or test without hardware.** RTSP-over-WebSocket cameras are physical devices; evaluating,
  demoing, or writing automated tests against the player previously required one on the network.
- **Legacy naming and packaging.** The prior codebase and its identifiers used old-brand naming throughout,
  blocking a clean, rebrandable open/internal release (see `CLAUDE.md`'s "No old-brand naming" convention).
- **Unverifiable legacy behavior.** The legacy source has been in production long enough that some call sites
  depend on undocumented quirks (see `src/player/exceptions/RTSPOverWebSocketBaseError.ts`'s constructor-signature
  note, or the `android` attribute's always-throws bug in `RTSPOverWebSocket.ts`). A rewrite that "fixes" these
  silently risks breaking real consumers.

## 4. Target users / use cases

| User | Use case |
| --- | --- |
| **Frontend engineer embedding live/playback video** | Drops `<rtsp-over-websocket>` into any HTML/JS/framework page, points it at a camera or NVR channel, gets live or recorded playback with zero legacy host-framework dependency. |
| **QA / developer without camera hardware** | Uses `src/server`'s YouTube-transcode pipeline to stand up a live RTSP-over-WebSocket source in minutes, exercising the exact same player code path a real camera would. |
| **Maintainer porting remaining legacy surface area** | Uses the parity test harness (`test-support/loadLegacyModule.ts` + the `legacy-player` submodule) to verify new TypeScript ports are byte-for-byte behaviorally identical to legacy before removing the old code entirely. |
| **Host-app integrator (legacy host-framework consumer)** | Migrates incrementally via `src/player/legacyHostInterface`, which reproduces the old factory/directive wiring on top of the new core, instead of a hard cutover. |

## 5. Goals

- A single, dependency-light, ESM-importable `<rtsp-over-websocket>` custom element usable from any framework or
  no framework at all.
- Full behavioral parity with the legacy player for every ported module, verified by automated tests, not
  spot-checking.
- A demo/dev server that lets anyone — with no camera and no access to this project's original production
  environment — build, run, and see the player working end to end against a real (if synthetic) live RTSP source.
- Complete removal of old-brand naming from the codebase, including test fixtures and comments.

## 6. Non-goals

- **Not a general-purpose video conferencing or WebRTC solution.** The wire protocol is RTSP-over-WebSocket
  specifically (RFC 7826 interleaved framing tunneled through a plain WebSocket) — not SIP, WebRTC, or HLS/DASH.
- **`src/server` is a demo/dev tool, not a production media server.** It has no auth beyond per-session RTSP
  digest credentials, permissive CORS (`Access-Control-Allow-Origin: *`), and in-memory (non-persistent) session
  state — see [PRD.md](PRD.md) §5 and [SRS.md](SRS.md) for the explicit boundaries.
- **Not re-architecting legacy behavior.** Where the legacy library has a confirmed quirk or bug that call sites
  depend on, this project preserves it rather than "fixing" it (see `CLAUDE.md`).

## 7. Success criteria

- A developer with no prior knowledge of this repo can go from `git clone` to a live stream playing in a browser
  using only [README.md](../README.md) and the "External tools" it documents.
- `npm run test:player` passes with the `legacy-player` submodule checked out, covering every ported module with
  parity or contract tests (see [ARCHITECTURE.md](ARCHITECTURE.md)'s "Testing strategy" section).
- No occurrence of old-brand naming remains in identifiers, comments, docs, or test fixtures.
- The demo page's Test tab (37 in-browser contract cases, `src/index.html`) passes independently of Node/vitest,
  confirming the built artifact — not just the source — behaves correctly in a real browser.

## 8. Constraints and assumptions

- `src/server` depends on three external tools it does not install or bundle: `ffmpeg`, `yt-dlp`, and MediaMTX
  (see [README.md](../README.md#external-tools-required-by-srcserver)). Without them the REST API still serves,
  but sessions cannot reach `live`.
- The legacy parity test suite assumes a `legacy-player` git submodule is checked out; it is not always present,
  and tests depending on it fail with `ENOENT` (not a logic failure) when it's absent.
- `three@0.84.0` is pinned deliberately due to a fisheye-dewarp rendering dependency on removed APIs — see
  [README.md](../README.md#milestones) for the tracked upgrade blocker.

## 9. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| YouTube changes break `yt-dlp` extraction | Demo pipeline (not the player itself) stops reaching `live` | Documented in README as an environment gotcha; `yt-dlp` update path (standalone binary over apt package) is called out explicitly |
| `three@0.84.0` DoS advisory | Real security exposure if the fisheye dewarp path is reachable from untrusted input | Tracked as an open milestone in README; requires a rewrite against modern `BufferGeometry` APIs before upgrading |
| Legacy quirk misidentified as a bug and "fixed" | Silent behavioral regression for real consumers relying on the quirk | Parity tests + explicit inline documentation of every preserved quirk (see `CLAUDE.md`) |
