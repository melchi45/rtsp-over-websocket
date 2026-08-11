---
name: player-docs
description: Consult and update docs/player/ (the per-class reference doc set for src/player) whenever reading or changing src/player code. Use before modifying any src/player class to learn its documented behavior/RFC references/intentional quirks, and after any src/player change to keep docs/player/*.md in sync. Note the real path is docs/player/ at the repo root, NOT src/player/docs/ (that path doesn't exist).
---

# `docs/player/` — read before, update after

`src/player` has a deep, per-class reference doc set at **`docs/player/`** (repo root — not
`src/player/docs/`, which does not exist). It complements `src/player/README.md` (the quick
static class-relationship map): for every class it records Structure, Method Analysis, real
call-stack traces, RFC/standard references, and Relations & Data Flow.

Start at [`docs/player/README.md`](../../docs/player/README.md) — it indexes the 8 subsystem
files and has a consolidated RFC/standard map plus a "Notable discrepancies" section for known
gaps between the docs and the code.

## Before touching a `src/player` class

Find its section in the matching `docs/player/*.md` file and read it first. These docs record
intentional legacy quirks — bit-mask differences between near-identical sibling classes, dead-
looking state that's actually load-bearing, deliberately preserved bugs — that read like mistakes
but aren't. `CLAUDE.md`'s Conventions section already warns against "fixing" documented quirks
without checking whether a test depends on them; this doc set is where "documented" means.

## After changing a `src/player` class

Update the matching section in the same change:

- New class → add a new `##`-level section to the closest-matching subsystem file, in the same
  Structure/Method Analysis/Call Stack/RFC References/Relations & Data Flow shape as its
  neighbors, and add it to that file's "Contents" list and any Mermaid diagrams (including the
  file's own "Module-wide data flow" diagram at the bottom, if one exists).
- Changed method behavior → update the relevant "Method Analysis" bullet(s) and, if it changes an
  RFC/standard dependency, the "RFC / Standard References" subsection.
- Changed inheritance/composition → update `src/player/README.md`'s class diagrams too, not just
  `docs/player/`.
- If the change is only partially wired up (e.g. a new codec's depacketizer exists but decode/
  render support doesn't yet), say so explicitly in the doc — see the "Known gap" note under
  `AV1Session` in `docs/player/03-mediaSession-core-video.md` for the expected shape of that kind
  of caveat.
- If the change is a non-obvious decision worth preserving beyond just the class docs (a redesign,
  a bug fix with a real root cause, a naming/architecture call), also add an entry to this repo's
  root `MEMORY.md`, matching its existing entries' style.
