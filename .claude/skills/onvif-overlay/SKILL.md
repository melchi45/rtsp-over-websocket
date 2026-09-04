---
name: onvif-overlay
description: Consult and update docs/player/10-onvif-metadata-overlay.md, docs/SRS.md §4.10, and docs/DESIGN.md §2.7 whenever reading or changing the ONVIF metadata overlay (src/player/util/onvifMetadata.ts, src/player/components/ui/onvifOverlay/, src/player/components/ui/switch/) or its wiring into src/player/elements/RTSPOverWebSocket.ts. Use before modifying any of those files to learn the coordinate-mapping algorithm and requirement IDs, and after any change to keep the docs in sync.
---

# ONVIF metadata overlay — read before, update after

The ONVIF `VideoAnalytics` bounding-box overlay and its toggle switch have their own class
reference at [`docs/player/10-onvif-metadata-overlay.md`](../../../docs/player/10-onvif-metadata-overlay.md),
requirements at [`docs/SRS.md`](../../../docs/SRS.md) §4.10 (REQ-PLY-110 through REQ-PLY-116),
design/algorithm detail at [`docs/DESIGN.md`](../../../docs/DESIGN.md) §2.7, and test cases at
[`docs/TC.md`](../../../docs/TC.md) §13 — this mirrors the
[`player-docs`](../player-docs/SKILL.md) skill's own before/after pattern, scoped to this one
subsystem instead of all of `src/player`.

## Files this covers

- `src/player/util/onvifMetadata.ts` (+ `.test.ts`) — pure ONVIF JSON → typed-model parsing,
  including the Transformation coordinate step.
- `src/player/components/ui/onvifOverlay/OnvifOverlay.ts`, `onvifEventColors.ts` (+ tests) — the
  SVG overlay renderer and its type→color palette.
- `src/player/components/ui/switch/Switch.ts` (+ `.test.ts`) — the reusable toggle-switch
  component (`createSwitch`), styled to match `wisenet-camera-discovery`'s SUNAPI On/Off toggle.
- `src/player/elements/RTSPOverWebSocket.ts` — specifically `onRTSPOverWebSocketMeta()`'s overlay
  side effect, the "ONVIF Event" context-menu row, and the `OnvifOverlay`/`createSwitch`
  construction/teardown alongside this element's other per-instance setup/cleanup.
- `src/player/elements/panelStyles.ts` — the `.ui-switch*` CSS block.

## Before touching any of these

Read `docs/player/10-onvif-metadata-overlay.md` first. In particular:

- The **coordinate-mapping algorithm** (`DESIGN.md` §2.7, mirrored in `onvifMetadata.ts`'s own
  Method Analysis in the class-reference doc): `Transformation` is applied *first* to normalize a
  device's own native `BoundingBox`/`CenterOfGravity` coordinate space into intrinsic pixel space,
  *then* that's mapped onto the video's actual rendered (possibly letterboxed) box. Getting the
  order of these two steps wrong, or skipping the `object-fit: contain` containment math in the
  second step, silently misplaces every box on any stream whose container isn't exactly the
  video's own intrinsic aspect ratio — easy to miss in a quick manual check against a
  same-aspect-ratio test window.
- **Frame lifecycle is deliberately full-refresh, not incremental** — `OnvifOverlay.render()`
  clears and redraws from scratch every call, no cross-frame object tracking/interpolation/
  staleness timeout. Don't add partial-update logic without also updating `docs/ROADMAP.md`'s M-4
  entry (which explicitly calls this out as a known, accepted gap, not an oversight).
- The **toggle's visual style is an intentional external parity target** (`wisenet-camera-discovery`'s
  `mountSwitch({variant: 'slider'})` dark-theme values), not derived from this element's own
  pre-existing Audio mute toggle — don't "fix" `Switch.ts`'s CSS to match the Audio toggle's
  different sizing/thumb-color without checking whether that's actually wanted first.
- Real ONVIF metadata may include a vendor (non-ONVIF-schema) shape — see `MEMORY.md`'s
  `MetaDataParser.parse()` entry for the specific deviation found live (a bare `tt:Type
  Likelihood="...">` under `tt:Class`, alongside the standard `ClassCandidate` list).
  `onvifMetadata.ts` intentionally only reads the standard `ClassCandidate` shape — don't assume a
  camera's raw XML matches strict ONVIF schema when debugging a parsing gap.

## After changing any of these

- Update the matching section of `docs/player/10-onvif-metadata-overlay.md` (Structure/Method
  Analysis/Call Stack/RFC References/Relations & Data Flow) in the same change, including its own
  History table.
- If a requirement changed, update `docs/SRS.md` §4.10 and the corresponding `docs/TC.md` §13 case(s).
- If the coordinate-mapping algorithm or data flow changed, update `docs/DESIGN.md` §2.7.
- If the change is only partially wired up, or a known gap is closed, update `docs/ROADMAP.md`'s
  M-4 entry (status/notes) to match.
- If the change is a non-obvious decision or a real bug with a root cause worth preserving, add an
  entry to this repo's root `MEMORY.md`, matching its existing entries' style.
- Whenever you create or edit any of the docs above, keep their Title/Abstract/Version/Author/
  History/Milestone header current — the full rule is in `CLAUDE.md`'s "Documentation headers"
  section; this skill doesn't restate it.
