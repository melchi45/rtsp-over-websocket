# CLAUDE.md

Guidance for Claude Code (or any agent) working in this repository.

## What this is

An RTSP-over-WebSocket player (`<rtsp-over-websocket>` custom element, TypeScript/ESM, built with Vite) plus a demo
server (`src/server`) that transcodes a YouTube video to RTSP and bridges it back out over the same WebSocket
protocol, so the player can be exercised without a real camera. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for
the full structure/data-flow writeup and [README.md](README.md) for build/run instructions.

## Build & run

```
npm run build:player          # tsc + vite build -> dist/player/*.js, copies src/index.html -> dist/index.html
npm run build:server          # tsc -> dist/server/*.js
npm run start:server[:http|:https]
npm run stop:server
npm run test:player            # vitest run
```

`src/index.html` is the source of the demo page; never edit `dist/index.html` directly — it's overwritten by
`npm run build:demo` (part of `build:player`).

## Environment gotchas (read before debugging a "broken" build)

- **`node_modules/.bin/*` shims in this environment may be plain file copies instead of symlinks**, which breaks
  any tool whose entry script uses a relative `require`/`import` to a sibling file (this has hit `tsc`, `vite`, and
  `vitest` in this repo's history). Symptom: `Cannot find module '.../node_modules/.bin/dist/....js'` or similar
  path-shaped errors pointing *into* `.bin/`. Fix: `ln -sf ../<pkg>/<real-bin-path> node_modules/.bin/<name>` — check
  the package's own `package.json` `"bin"` field for the real relative path.
- **The system default `node` may be too old** (e.g. v12) to run this project's `tsc`/`vite` (which need modern
  syntax like `??`). If `tsc -b` fails with a `SyntaxError` on `??` inside `node_modules`, that's the cause — get a
  current Node (20+) on `PATH` ahead of the system one.
- **`src/server` needs ffmpeg, yt-dlp, and MediaMTX** to actually reach a `live` session — see the README's
  "External tools" section. Without them the server still starts and serves the REST API/demo page fine; only
  session creation fails (with a clear error, not a crash).
- **`yt-dlp`'s `Deprecated Feature: Support for Python version 3.10 has been deprecated` warning** is cosmetic
  only — unrelated to the `403`/PO-Token issue above, purely about which Python interpreter runs `yt-dlp` itself.
  Fixed here (2026-08-25) by pointing the standalone `~/.local/bin/yt-dlp` zipapp's shebang at `python3.11`
  (already present on this Ubuntu 22.04 box via apt) instead of the generic `#!/usr/bin/env python3` (→ 3.10) —
  no pip reinstall needed, since the zipapp vendors its own dependencies; verified `yt-dlp -j` still works fully
  under 3.11. **Deliberately did NOT repoint the system-wide `python3` → 3.11** (e.g. via `update-alternatives`):
  confirmed live that `python3.11 -c "import apt_pkg"` fails (`ModuleNotFoundError`) because `python3-apt`'s
  compiled `.so` is built only for `cpython-310` — doing that system-wide would break `add-apt-repository`,
  `unattended-upgrades`, and similar apt-Python tooling. If this warning reappears, it's most likely because
  `yt-dlp -U`/a fresh `curl`-installed binary reset the shebang back to generic `python3` — re-patch just the
  shebang line again, don't touch system `python3`.
- **`src/player`'s parity tests need a `legacy-player` git submodule** (the original legacy source) that isn't
  always checked out. Failures there are `ENOENT`, not a real regression — check the error text before assuming a
  change broke something.
- **`src/player/network/http/SunapiManager.live.test.ts`** is a separate, deliberately-skipped-by-default live test
  against a real camera — unrelated to the `legacy-player` submodule gap above. It only runs (and only fails loudly,
  demanding `RTSP_LIVE_TEST_HOSTNAME`/`_USERNAME`/`_PASSWORD`) when `RUN_LIVE_DEVICE_TEST=1` is explicitly set; leave
  it alone otherwise. See the README's "Live-device smoke test" section.
- **AV1 *output* sessions need ffmpeg 9+ and `-strict experimental` — both are required, neither alone is enough.**
  ffmpeg 4.4.2 (Ubuntu 22.04 apt) and 7.1.1 (`ppa:ubuntuhandbook1/ffmpeg7`) fail identically (`Server returned 400
  Bad Request`; MediaMTX logs `invalid SDP: media 1 is invalid: clock rate not found`) because ffmpeg's RTP muxer
  has no `a=rtpmap` entry for AV1 at all in those versions (confirmed via `strings libavformat.so.* | grep rtpmap`).
  ffmpeg 9.0 (`ppa:ubuntuhandbook1/ffmpeg9`) *does* have the entry (exact version it landed in is unconfirmed —
  ffmpeg 8 untested) but the muxer still marks AV1 payloading experimental, so it also needs `-strict experimental`
  (same as VP9) — without that flag it fails differently (`Packetizing AV1 is experimental ... Could not write
  header ... Experimental feature`). `transcodeSession.ts`'s `videoEncoderArgs` AV1 branch passes this flag; confirm
  it's still there if AV1 sessions start failing again. Confirmed live end-to-end on ffmpeg 9.0: session reaches
  `status: "live"` and publishes real AV1 frames to MediaMTX. See `README.md`'s "External tools" section for the
  full investigation history (including two earlier wrong guesses — that ffmpeg 6.0+ would fix it, then that no
  ffmpeg version could).
- **Most modern YouTube videos need a JS runtime AND a PO Token provider to actually download (not just probe)
  without a `403` — neither alone is enough, and this repo now sets both up automatically.** Symptom when either
  is missing: session reaches `starting` then `failed` with `ffmpeg exited with code 183: ... Invalid data found
  when processing input` (this app's own ffmpeg, fed nothing because `yt-dlp` produced zero bytes), or in
  `yt-dlp`'s own stderr, `ERROR: ffmpeg exited with code 8` wrapping a `Server returned 403 Forbidden` on a
  `googlevideo.com` URL. `GET /api/youtube/probe` (metadata only) succeeding first is not a useful signal — it
  succeeds even for videos whose actual download then 403s.
  - **JS runtime (`deno`)** solves YouTube's signature/"n" challenge — confirmed necessary but **not sufficient
    alone**: the identical `403` reproduced with `deno` present and actively solving the challenge
    (`[jsc:deno] Solving JS challenges using deno` right before the `403` in the log).
  - **PO Token provider** ([bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider),
    see also yt-dlp's [PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)) is the other,
    separately-required piece — without it, essentially every DASH format 403s regardless of the JS runtime.
  - **Both together**: `transcodeSession.ts`'s `startTranscode()` checks `hasDeno()` (looks for
    `~/.deno/bin/deno`) and `potProviderReachable()` (a live server at `127.0.0.1:4416`, or
    `BGUTIL_POT_PROVIDER_PORT`) at the start of every session, and only *then* adds `--extractor-args
    youtube:player_client=mweb` to the `yt-dlp` invocation — confirmed live to reliably expose the full DASH
    resolution ladder and download cleanly, where `yt-dlp`'s own default (unforced) client mix can end up serving
    an `android_vr`-origin URL for a given itag that `403`s regardless of PO Token/JS runtime being available.
    **Forcing `mweb` without both is confirmed *worse*** — it fails outright (`No video formats found!`) even for
    videos the unforced default handles fine — so `startTranscode()` falls back to the plain default whenever
    either check fails (log line: `player_client=default (deno and/or PO Token provider unavailable — forcing
    mweb would be worse)` vs. `player_client=mweb (deno + PO Token provider both available)`).
  - **Setup is automated by `scripts/ensure-bgutil-pot-provider.js`** (wired into `npm run start:server*`, same
    leave-alone-if-reachable / pid-tracked-for-`stop:server` shape as `ensure-mediamtx.js`) — but it only *starts*
    an already-built provider, it doesn't install one. First-time setup (git clone + Node 22 build + yt-dlp
    plugin zip) is manual — see `README.md`'s "External tools" section for the full commands. Two setup gotchas
    hit live on this box, both env-var-overridable (see `.env.example`):
    - The provider requires **Node.js >=22**, a separate requirement from this repo's own pinned Node 20 —
      `ensure-bgutil-pot-provider.js` auto-detects one under `~/.nvm/versions/node/*`.
    - Behind a TLS-intercepting proxy (a corporate root CA folded into `/etc/ssl/certs/ca-certificates.crt` on
      this box), the provider's own outbound HTTPS (BotGuard challenge fetch from `google.com`) fails with
      `self-signed certificate in certificate chain` without `NODE_EXTRA_CA_CERTS` pointed at that bundle —
      auto-detected by `ensure-bgutil-pot-provider.js` if present. The provider's own `npm ci` (its `canvas`
      native dependency specifically) hits the identical error during setup for the same reason.
  - Active YouTube-vs-`yt-dlp` arms race — re-verify against real current behavior (`yt-dlp -v -F <url>` on the
    actual failing URL, and check `PO Token Providers:`/`JS runtimes:` in that output) rather than trusting any
    specific client/format name here to stay accurate forever. See `MEMORY.md` for the full investigation
    (multiple wrong-then-corrected explanations along the way — worth reading before re-deriving this from
    scratch if it breaks again).

## `docs/player/` — per-class reference docs (read before *and* update after touching `src/player`)

`docs/player/` (not `src/player/docs/` — that path doesn't exist) is a deep, per-class reference
for every subsystem under `src/player`: for each class, its Structure, Method Analysis, real
call-stack traces, RFC/standard references, and Relations & Data Flow. Start at
[docs/player/README.md](docs/player/README.md) for the file index and the RFC/standard map.

- **Before changing any `src/player` class**, check whether it's documented in `docs/player/` and
  read that section first — it records intentional legacy quirks (bit-mask differences between
  near-identical classes, dead-looking state that's actually load-bearing, etc.) that look like
  bugs but aren't; see also this file's "Conventions" note below on not "fixing" documented
  quirks.
- **After changing any `src/player` class** (new class, changed method behavior, new
  RFC/standard dependency, new codec, etc.), update the matching `docs/player/*.md` section in the
  same change — keep Structure/Method Analysis/RFC references/diagrams in sync, not just the code.
  Also update `src/player/README.md`'s class-relationship diagrams if inheritance/composition
  changed, and this repo's root `MEMORY.md` if the change is a non-obvious decision worth
  preserving.
- If a new class doesn't fit neatly under an existing `docs/player/*.md` file's subsystem, add a
  new section to the closest-matching file rather than leaving it undocumented.

## Documentation headers

Every file under `docs/` (including `docs/player/*.md`) carries a metadata header, directly below its `#`
title, in this exact shape:

```
# <existing title — unchanged>

*<one-to-two sentence abstract, compressed from the doc's own intro>*

**Version:** <current `package.json` version> · **Author:** <current `package.json` author name> ·
**Milestone:** <relevant `docs/ROADMAP.md` ID(s), or "—" if none apply>

**History**

| Date | Change |
| --- | --- |
| <date> | <what changed, oldest first> |
| ... | ... |

---

<existing body, unchanged>
```

- **When creating a new doc**: write the full header, with a one-row History table ("Initial version").
- **When editing an existing doc**: append one new row to its History table (never rewrite prior rows), and
  update the Milestone field if the change relates to a `docs/ROADMAP.md` item. Leave Title/Abstract/Version/
  Author as-is unless the change actually invalidates them.
- Version tracks this repo's overall `package.json` version, not a per-document scheme — all docs share one
  Version value at any given time.
- See any file under `docs/` (e.g. [docs/ROADMAP.md](docs/ROADMAP.md), [docs/SDD.md](docs/SDD.md)) for a real
  example. `docs/player/*.md` specifically also has day-to-day enforcement wired into
  [`.claude/skills/player-docs/SKILL.md`](.claude/skills/player-docs/SKILL.md) — that skill applies this same
  rule, it doesn't restate it.

## Conventions

- **No old-brand naming anywhere** — file names, identifiers, comments, docs, and test fixture strings have all
  been fully rebranded to RTSP-over-WebSocket naming, including references into the (currently absent) legacy
  submodule's file/export names. Don't reintroduce the old naming in new code; see `MEMORY.md` if you need the
  history of what changed and why.
- **Comments and docs are English.** Don't add Korean (or other non-English) comments/docs going forward.
- **`dist/` is pure build output** — nothing under it is hand-maintained; don't edit files there directly (see
  `.gitignore`).
- Prefer small, targeted commits/edits — this is a large, long-lived codebase with a lot of intentionally-preserved
  legacy behavior; don't "clean up" quirks documented as deliberate without checking whether a test depends on them.
