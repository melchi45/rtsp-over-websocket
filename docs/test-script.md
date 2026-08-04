# Test Script

Concrete, runnable procedures for executing the cases in [TC.md](TC.md). Section numbers below correspond to the
"Coverage" column references there (e.g. "see test-script §3").

## 0. Setup

```
npm install
npm run build:player     # tsc + vite build -> dist/player/*.js, dist/index.html
```

For anything beyond §1–§2 you also need the external tools documented in
[README.md](../README.md#external-tools-required-by-srcserver): `ffmpeg`, `yt-dlp`, and a running MediaMTX
instance (`mediamtx /opt/mediamtx/mediamtx.yml`). Confirm MediaMTX is up before starting the server:

```
curl -sS 127.0.0.1:9997/v3/paths/list | head -c 200   # any JSON response (even an empty list) means it's up
```

## 1. Automated test suite

```
npm run test:player        # vitest run — covers TC-PLY-* and the legacyHostInterface contract cases
```

Expected: all suites pass. Two known non-regressions, per `CLAUDE.md`:

- Any suite under a legacy-parity path failing with `ENOENT` means the `legacy-player` git submodule isn't checked
  out (`git submodule update --init` if you have access to it) — not a real regression.
- A `tsc`/`vite`/`vitest` failure whose error path points *into* `node_modules/.bin/` (not a real source file)
  means a `.bin` shim is a plain-copy instead of a symlink in this environment — see `CLAUDE.md`'s "Environment
  gotchas" for the fix.

To watch a single file while iterating: `npm run test:player:watch -- RTSPOverWebSocket`.

## 2. Server build sanity

```
npm run build:server
node dist/server/index.js --http &   # or use npm run start:server:http directly
curl -sS http://127.0.0.1:4000/health
# expect: {"ok":true}
npm run stop:server
```

## 3. End-to-end demo smoke test (TC-E2E-001, TC-PLY-022)

If you're an agent with the `run-demo-server` skill available, that skill automates build/start/verify/stop for
this exact flow — otherwise, or to verify by hand, follow these steps:

1. **Start the server:**
   ```
   npm run start:server:http
   ```
   Confirm the log line `[server] MediaMTX reachable at 127.0.0.1:8554` — if it instead warns "not reachable",
   stop and fix MediaMTX first (TC-SRV-041 will otherwise fire for every session).

2. **Open the demo page:** `http://127.0.0.1:4000/` in a browser. You should land on the **Player** tab with
   **Server** and **Test** tabs alongside it.

3. **Probe a source (TC-SRV-002):** Switch to the **Server** tab, paste a public YouTube URL, click
   **Check max resolution (Probe)**. Expect a title/duration/max-resolution summary to appear within a few
   seconds — if it errors, re-check `yt-dlp --version` (README's yt-dlp staleness gotcha).

4. **Check codec support (TC-SRV-010):** Click **Refresh codec support**. Expect a table of video/audio codecs
   with availability — H264/AAC should be `available: true` on any standard `ffmpeg` build.

5. **Create a session (TC-SRV-025, TC-SRV-040):** Pick a resolution at or below the probed max, `H264` video,
   `AAC` audio, set a username/password, click **Start**. Expect the session row's status to go
   `starting` → `live` within ~20 seconds (matches `TRANSCODE_STARTUP_TIMEOUT_MS`). If it goes to `failed`
   instead, check the server's stdout for the `[ffmpeg][<id>]`/`[yt-dlp][<id>]`-tagged log lines — the failure
   reason is always logged there.

6. **Wire up the Player (TC-E2E-001):** Click **Fill Player tab connection info** (copies host/port/channel/
   credentials into the Player tab), switch to the **Player** tab, click **Connect**, then **Play**. Expect:
   - Video renders within a couple seconds of clicking Play.
   - The statistics overlay (if enabled) shows non-zero frame rate / bitrate / RTP-received counters.
   - Audio is audible unless muted.

7. **Exercise playback controls (TC-PLY-022, TC-PLY-024):** Click **Pause**, confirm the frame freezes; click
   **Play** again, confirm it resumes; toggle mute/volume if exposed in the panel; click **Stop**, confirm
   playback and the statistics overlay stop updating.

8. **Tear down (TC-E2E-002):** Back on the **Server** tab, click **Stop** on the session (or **Restart** to verify
   a fresh transcode comes back up on the same channel). Confirm the Player tab's connection drops (an `error` or
   `close` event/log line, and the video freezing/stopping) within a few seconds.

9. **Stop the server:**
   ```
   npm run stop:server
   ```

## 4. In-browser Test tab (TC-E2E-003)

1. With the server still running from §3 (or restarted via §3 step 1), open the demo page and click the **Test**
   tab.
2. Run the suite (page auto-runs on tab open, or via an on-page "Run" control if present).
3. Expect all 37 contract cases to report pass — this is the same logical suite as
   `custom/RTSPOverWebSocket.test.ts`, run against the real built bundle in a real browser instead of `jsdom`, so a
   pass here that disagrees with a `vitest` failure (or vice versa) usually points at a build-output problem
   (stale `dist/`) rather than a source regression — rerun `npm run build:player` first if you see a mismatch.

## 5. Negative / failure-path scripts

These correspond to the "Manual" server-bridge and lifecycle cases in [TC.md](TC.md) §9–§10 that aren't part of
the golden path above.

**TC-SRV-041 — MediaMTX down:**
```
# with MediaMTX stopped
npm run start:server:http
# create a session via the Server tab or curl (see below) — expect status: "failed" within ~20s
```

**TC-SRV-023 — unsupported codec (422):**
```
curl -sS -X POST http://127.0.0.1:4000/api/sessions \
  -H 'Content-Type: application/json' \
  -d '{"youtubeUrl":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","resolutionHeight":720,
       "videoCodec":"AV1","audioCodec":"AAC","audioBitrateKbps":128,
       "username":"u","password":"p"}'
# expect 422 if this ffmpeg build has no AV1 encoder — cross-check against GET /api/capabilities first
```

**TC-SRV-026 — channel conflict (409):** start one session with an explicit `"channel": 0`, then immediately
`POST` a second with the same `"channel": 0` — expect `409` on the second while the first is still
`starting`/`live`.

**TC-SRV-053/054/055 — bridge auth failures:** using a raw WebSocket client (e.g. `wscat -c
ws://127.0.0.1:4000/StreamingServer`), send a minimal RTSP `DESCRIBE` request line with no `Authorization` header
first (expect `401` + nonce), then with a wrong password (expect a fresh `401`), then repeat the wrong-password
attempt a third time (expect the connection to close with code `1008` after the 3rd failure, per
`MAX_AUTH_ATTEMPTS`).

**TC-SRV-051/052 — malformed/unknown channel:** same client, send a request URI with no numeric segment (expect
close `1002`/`1008` depending on which check fails first — see SRS §5.5), then a well-formed URI for a channel
with no session (expect a `404` RTSP response then close `1008`).

## 6. Regression checklist before merging a change here

1. `npm run test:player` — all green (or only the documented `ENOENT`/`.bin` environment failures).
2. `npm run build:player && npm run build:server` — both succeed with no `tsc` errors.
3. Section 3 (end-to-end smoke) — at least once per change touching `src/server` or the player's network/mediaSession
   layers.
4. Section 4 (Test tab) — at least once per change touching `src/player/custom` or a change to `dist/` build
   config (Vite/tsc settings).
