# Roadmap

*Tracked future milestones for `src/player` and `src/server` — confirmed gaps found by reading the
current code, not aspirational feature ideas. See [PRD.md](PRD.md)'s "Future milestones" section for
the product-level summary and [README.md](../README.md#milestones) for the original `three.js`
entry this document supersedes as the canonical list.*

**Version:** 1.1.0 · **Author:** Youngho Kim · **Milestone:** — (this document is the milestone tracker itself)

**History**

| Date | Change |
| --- | --- |
| 2026-08-26 | Initial version — consolidates the existing README.md milestone plus two newly-confirmed gaps |
| 2026-08-26 | Clarify M-1's Notes (playback itself is confirmed not blocked); add "Documentation conventions" section |
| 2026-09-04 | Add M-4 (ONVIF metadata overlay) |
| 2026-09-04 | Mark M-4 Done — implementation plus a live-reported metadata/resize race-condition fix both verified |
| 2026-09-04 | Add M-5 (per-component `debug` console.log tracing); marked Done, verified end-to-end |

---

## Documentation conventions

Every file under `docs/` (including this one) and `docs/player/` carries a Title (its `#` heading) / Abstract /
Version / Author / History / Milestone header, kept up to date whenever that file is created or edited. The rule
itself lives in [CLAUDE.md](../CLAUDE.md)'s "Documentation headers" section; day-to-day enforcement for
`docs/player/*.md` specifically is in [`.claude/skills/player-docs/SKILL.md`](../.claude/skills/player-docs/SKILL.md).

---

| ID | Area | Milestone | Status | Notes |
| --- | --- | --- | --- | --- |
| M-1 | Player | Allow `AV1`/`VP8`/`VP9` through the `codec` attribute/property validation | Planned | Depacketization (`AV1Session`/`VP8Session`/`VP9Session`, `src/player/mediaSession/videoSession/`), WebCodecs decode (`WebCodecsVideoDecoder`), MSE wiring (`VideoTagPlayer`, incl. `vp09`/`av01` `stsd` entries in `vendor/mp4Generator.js` — see [docs/player/09-mp4-container-generation.md](player/09-mp4-container-generation.md)), and canvas rendering (`CanvasRenderer`, `YUVWebGLCanvas`) are already wired end to end — see [docs/player/03-mediaSession-core-video.md](player/03-mediaSession-core-video.md) and [docs/player/05-video-player-rendering.md](player/05-video-player-rendering.md). **Confirmed live that playback itself is not blocked** — the `codec` attribute isn't actually consumed by SDP negotiation, only echoed into a `codec=` query param (see `docs/player/README.md`'s "Notable discrepancies"), so this is a documentation/API-surface completeness gap, not a functional blocker. The remaining work is `RTSPOverWebSocket.ts`'s `codec` attribute/property setters (`attributeChangedCallback`'s `case 'codec'` and the property setter), which still only accept `'MJPEG'`\|`'H264'`\|`'H265'`\|`'MPEG4'`. The statistics-overlay codec label `switch` (`onRTSPOverWebSocketStatistics`) also has no AV1/VP8/VP9 case, so the overlay would show `undefined` for those codecs once the allow-list is opened up. |
| M-2 | Player | Upgrade `three` past `0.84.0` | Blocked | `src/player/util/FishEye3D.ts` and `FishEye3DMulti.ts` (fisheye camera dewarp rendering) depend on APIs removed from three.js in later releases (`THREE.Geometry`, `THREE.Face3`, `THREE.AxisHelper`, `THREE.RGBFormat`, `BufferGeometry.fromGeometry`, `THREE.Math.degToRad`). Upgrading requires rewriting that mesh-construction/rendering code against modern `BufferGeometry`-based APIs; there's no visual-regression test for the fisheye dewarp output, only structural/unit tests, so on hold until it can be checked against a real fisheye camera feed. Originally tracked in [README.md](../README.md#milestones). |
| M-3 | Player | Port remaining `legacyHostInterface` stand-ins | Not started | `src/player/legacyHostInterface/types.ts`'s `StreamManagerHandle` and `SunapiClientHandle` are currently unimplemented placeholder types ("not yet ported to this repository" per their inline comments), so `legacyHostInterface` consumers must supply their own real implementations rather than getting one from this repo. |
| M-4 | Player | ONVIF metadata overlay (bounding boxes + toggle) | Done | Requested directly by the user. Renders ONVIF `VideoAnalytics` bounding boxes/labels (ObjectId, type, Likelihood, colored by type) over the video, toggleable from the context menu, hidden by default. See [SRS.md](SRS.md) §4.10, [DESIGN.md](DESIGN.md) §2.7, [docs/player/10-onvif-metadata-overlay.md](player/10-onvif-metadata-overlay.md). Not yet implemented: cross-frame object staleness/timeout handling (an object simply disappears the instant a new `Frame` stops including it, or stays until a new `Frame` arrives if the stream pauses — no fade-out or explicit "gone" signal is modeled), and migrating the pre-existing hand-rolled Audio mute toggle onto the new shared `Switch` component. |
| M-5 | Player | Per-component `debug` console.log tracing | Done | Requested directly by the user, prompted by manually-commented-out `VideoTagPlayer.ts` trace logs (too noisy to leave always-on). New `debug` attribute/property on `RTSPOverWebSocket`, JSON-configured per subsystem (`mediaSession`/`network`/`listen`/`video`/`backup`), propagated through `StreamPlayer` into every session/player class via `util/debugLog.ts`. See [docs/player/08-util.md](player/08-util.md)'s `debugLog.ts` entry and `01`/`02`/`03`/`04`/`05`/`06`/`07`'s own History entries. Verified end-to-end against a real (deliberately-unroutable) connect attempt: gated log lines appear only with `debug` set, confirmed absent otherwise. Not in scope: live mid-stream reconfiguration (`debug` is read once at `play()` time) and `vendor/`/`XmlParser.ts`/`AACAudioDecoder.ts`'s pre-existing always-on legacy logs (deliberately excluded, see `MEMORY.md`). |
