# Test Case Catalog (TC)

Test cases for the Player and Server, each mapped to the [SRS.md](SRS.md) requirement(s) it verifies. "Automated"
cases already exist as vitest suites (`npm run test:player`) or the demo page's in-browser Test tab; "Manual" cases
are executed by hand following [test-script.md](test-script.md). Case IDs are referenced from that script.

Legend: **Auto** = covered by an existing automated test · **Manual** = exercised via the demo page/API by hand ·
**Both** = automated coverage exists and a manual smoke case is also defined.

## 1. Player — attribute validation

| ID | Requirement | Preconditions | Steps | Expected result | Coverage |
| --- | --- | --- | --- | --- | --- |
| TC-PLY-001 | REQ-PLY-011 | Element not yet connected | Set `channel="0"` (or negative) | Throws `RTSPOverWebSocketError` with `errorCode` for `0x0413` | Auto — `custom/RTSPOverWebSocket.test.ts` |
| TC-PLY-002 | REQ-PLY-011 | — | Set `channel="1"` | `_channel` internally becomes `0`; `changechannel` event fires with `{channel: 0}` | Auto |
| TC-PLY-003 | REQ-PLY-012 | — | Set `profile_number="abc"` (non-integer) | Throws with `0x0414` code | Auto |
| TC-PLY-004 | REQ-PLY-017 | — | Set `mode="invalid"` on `connectedCallback` | Throws with `0x0412` code | Auto |
| TC-PLY-005 | REQ-PLY-023 | — | Set `type="bogus"` | Throws with `0x0414` code | Auto |
| TC-PLY-006 | REQ-PLY-024 | — | Set `usesubstream="maybe"` | Throws with `0x0414` code | Auto |
| TC-PLY-007 | REQ-PLY-027 | — | Set `codec="MPEG2"` (unsupported) | Throws with `0x0414` code | Auto |
| TC-PLY-008 | REQ-PLY-029 | — | Set an attribute not in `observedAttributes` | `console.warn` logged, no throw | Auto |
| TC-PLY-009 | REQ-PLY-100 | — | Set `android` attribute via markup | Throws (legacy quirk: `newValue` is always a string, never satisfies the legacy `typeof === 'boolean'` check) — MUST reproduce, not fix | Auto |
| TC-PLY-010 | REQ-PLY-047 | — | Set `startTime` to a non-ISO-8601 string | Throws with `0x0414` code | Auto |

## 2. Player — playback control and state

| ID | Requirement | Preconditions | Steps | Expected result | Coverage |
| --- | --- | --- | --- | --- | --- |
| TC-PLY-020 | REQ-PLY-046 | `playType = LIVE`, playing | Set `playType = INSTANTPLAYBACK` | Live playback pauses; `init` control command issued; `info.media.type` becomes `'instantplayback'` | Auto |
| TC-PLY-021 | REQ-PLY-046 | `playType = INSTANTPLAYBACK` | Set `playType = LIVE` | Playback resumes | Auto |
| TC-PLY-022 | REQ-PLY-040..042 | Connected to a live session (see §5) | Call `play()`, then `pause()`, then `resume()`, then `stop()` | State transitions `STOPPED→PLAYING→PAUSED→PLAYING→STOPPED`; video renders while `PLAYING` | Manual (see test-script §3) |
| TC-PLY-023 | REQ-PLY-043 | `playType = PLAYBACK`, playing | Call `speed()` at each `RTSPOverWebSocketPlaySpeed` entry | Playback rate changes accordingly; reverse ("seek_*") entries play backward | Manual |
| TC-PLY-024 | REQ-PLY-050, 051 | Playing with audio | Call `mute()`, verify `isMute() === true`; `unmute()`; `setAudioVolume(50)`, verify `getAudioVolume() === 50` | Audio state matches each call | Manual |
| TC-PLY-025 | REQ-PLY-060 | Playing | Call `capture('frame.jpg')` | An image download is triggered for the current frame | Manual |

## 3. Player — events and errors

| ID | Requirement | Preconditions | Steps | Expected result | Coverage |
| --- | --- | --- | --- | --- | --- |
| TC-PLY-030 | REQ-PLY-070 | — | `addEventListener('changechannel', cb)`, set `channel` | `cb` invoked with the new channel payload | Auto |
| TC-PLY-031 | REQ-PLY-070 | — | `addEventListener(...)`, then `removeEventListener(...)`, then trigger the event again | `cb` is NOT invoked the second time | Auto |
| TC-PLY-032 | REQ-PLY-071, REQ-PLY-090 | Bad credentials configured (see TC-SRV-041) | Connect | An `error` event fires carrying an `AuthError`-shaped payload (`errorCode`, `channel`, `place`) | Manual |
| TC-PLY-033 | REQ-PLY-091 | — | Construct each of `RTSPOverWebSocketError`/`AuthError`/`RTCPError`/`RTSPError`/`SunapiError` via the options-object form | Instance's `.channel`/`.element`/`.errorCode`/`.place`/`.message`/`.name` are all set as given | Auto — `exceptions/*.test.ts` |

## 4. Player — `StreamManager` / `StreamPlayer` contract

| ID | Requirement | Preconditions | Steps | Expected result | Coverage |
| --- | --- | --- | --- | --- | --- |
| TC-PLY-040 | Design §2.2 | Two elements with distinct `id`s | `initStreamPlayer(info1, ...)`, `initStreamPlayer(info2, ...)` | Two independent `StreamPlayer` instances are registered, looked up correctly by their respective `playerId` | Auto — `interface/StreamManager.test.ts` |
| TC-PLY-041 | Design §2.2 | A player already registered for an id | `initStreamPlayer(sameInfo, ...)` again | No new `StreamPlayer` created; existing one receives a `reassignCanvas` control command | Auto |
| TC-PLY-042 | Design §2.2 | Registered player | `destroyPlayer(channelId, elementId)` | Player is sent `initVideo(false)`/`setLiveMode('canvas')`/audio-volume-0 commands, then removed from the registry | Auto |
| TC-PLY-043 | — | Registered player | `getVideoWidth/Height/CodecType(channelId, elementId)` | Returns the underlying `StreamPlayer`'s reported values | Auto — `interface/StreamPlayer.test.ts` |

## 5. Player — `legacyHostInterface` contract

| ID | Requirement | Preconditions | Steps | Expected result | Coverage |
| --- | --- | --- | --- | --- | --- |
| TC-PLY-050 | Design §2.6 | Mocked `StreamManagerHandle`/legacy host-framework services | `createRTSPOverWebSocketStreamInterface(deps)`, call `init`, `changeStreamInfo`, `controlWorker`, `destroyPlayer` | Each call forwards to the corresponding mocked `StreamManager` method with correctly-shaped arguments | Auto — `legacyHostInterface/streamInterface.test.ts` |
| TC-PLY-051 | Design §2.6 | Mocked `RTSPOverWebSocketStreamInterface`, jQuery stub (`test-support/jqueryStub.ts`) | `createRTSPOverWebSocketStreamDirective(deps)`, exercise `link`/scope wiring | Directive definition object has `restrict: 'E'`, correct `scope` bindings, and wires `$on('$destroy', ...)` to `destroyPlayer` | Auto — `legacyHostInterface/streamCanvas.test.ts` |

## 6. Server — REST API `/api/youtube`

| ID | Requirement | Preconditions | Steps | Expected result | Coverage |
| --- | --- | --- | --- | --- | --- |
| TC-SRV-001 | REQ-SRV-001 | Server running | `GET /api/youtube/probe` (no `url` param) | `400` with an `error` message | Manual |
| TC-SRV-002 | REQ-SRV-001 | Server running, `yt-dlp` installed | `GET /api/youtube/probe?url=<valid YouTube URL>` | `200` with `title`, `durationSec`, `maxHeight`, `availableResolutions`, source codec lists | Manual |
| TC-SRV-003 | REQ-SRV-001 | Server running | `GET /api/youtube/probe?url=<unreachable/invalid URL>` | `502` with an `error` message describing the `yt-dlp` failure | Manual |

## 7. Server — REST API `/api/capabilities`

| ID | Requirement | Preconditions | Steps | Expected result | Coverage |
| --- | --- | --- | --- | --- | --- |
| TC-SRV-010 | REQ-SRV-020 | Server running, `ffmpeg` installed | `GET /api/capabilities` | `200` with the full resolution ladder and, for every codec, `available`/`ffmpegEncoder`/`reason` | Manual |
| TC-SRV-011 | REQ-SRV-020 | `ffmpeg` NOT on `PATH` | `GET /api/capabilities` | `200` with every codec `available: false` (server does not crash) | Manual |

## 8. Server — REST API `/api/sessions`

| ID | Requirement | Preconditions | Steps | Expected result | Coverage |
| --- | --- | --- | --- | --- | --- |
| TC-SRV-020 | REQ-SRV-010 | Server running | `POST /api/sessions` with a missing `youtubeUrl` | `400`, descriptive `error` | Manual |
| TC-SRV-021 | REQ-SRV-010 | — | `POST /api/sessions` with `resolutionHeight: 999` (off-ladder) | `400` | Manual |
| TC-SRV-022 | REQ-SRV-010 | — | `POST /api/sessions` with `audioBitrateKbps: 0` | `400` | Manual |
| TC-SRV-022a | REQ-SRV-010 | — | `POST /api/sessions` with `username: "tester", password: ""` (one empty, one not) | `400`, error names both fields | Manual — verified 2026-08-25 |
| TC-SRV-022b | REQ-SRV-010, REQ-SRV-043a | — | `POST /api/sessions` with `username: "", password: ""` | `201`; created session's `request.username` is `""` | Manual — verified 2026-08-25 |
| TC-SRV-023 | REQ-SRV-012 | Requested `videoCodec` unsupported by installed `ffmpeg` | `POST /api/sessions` with that codec | `422`, message references `GET /api/capabilities` | Manual |
| TC-SRV-024 | REQ-SRV-013 | Valid body, unreachable `youtubeUrl` | `POST /api/sessions` | `502` | Manual |
| TC-SRV-025 | REQ-SRV-014 | Fully valid body | `POST /api/sessions` | `201`, body has `status: "starting"`, no `password` field; session later transitions to `live` (poll `GET /api/sessions/:id`) | Manual |
| TC-SRV-026 | REQ-SRV-011 | An active session already on channel `N` | `POST /api/sessions` with `channel: N` | `409 Conflict` | Manual |
| TC-SRV-027 | REQ-SRV-011 | A `stopped`/`failed` session on channel `N` | `POST /api/sessions` with `channel: N` | `201` — old session silently replaced, no conflict | Manual |
| TC-SRV-028 | REQ-SRV-015 | Unknown session id | `GET /api/sessions/does-not-exist` | `404` | Manual |
| TC-SRV-029 | REQ-SRV-016 | Live session exists | `DELETE /api/sessions/:id` | `204`; session no longer in `GET /api/sessions`; its `ffmpeg`/`yt-dlp` processes are terminated (verify via `ps`) | Manual |
| TC-SRV-030 | REQ-SRV-016 | Unknown session id | `DELETE /api/sessions/does-not-exist` | `404` | Manual |

## 9. Server — transcode session lifecycle

| ID | Requirement | Preconditions | Steps | Expected result | Coverage |
| --- | --- | --- | --- | --- | --- |
| TC-SRV-040 | REQ-SRV-030 | Valid session created | Wait, poll `GET /api/sessions/:id` | `status` transitions `starting → live` once `ffmpeg` reports its first `frame=` | Manual |
| TC-SRV-041 | REQ-SRV-031 | MediaMTX NOT running | Create a session | `status` becomes `failed` within ~20s, `error` mentions connection failure/no output | Manual |
| TC-SRV-042 | REQ-SRV-032 | Live session | Kill the session's `ffmpeg` process externally (`kill <pid>`) | `status` becomes `failed` (non-zero/signal exit) | Manual |
| TC-SRV-043 | REQ-SRV-035 | — | Create a G.726 session with `audioBitrateKbps: 100` (unsupported rate) | Session still reaches `live`; encoder actually runs at 40 kbps (nearest supported) | Manual |
| TC-SRV-044 | REQ-SRV-036 | `~/.deno/bin/deno` present, bgutil-ytdlp-pot-provider reachable at `127.0.0.1:4416` | Create a session for a modern YouTube video at 1080p | Server log shows `player_client=mweb (deno + PO Token provider both available)`; session reaches `live` | Manual — verified 2026-08-25 (`dQw4w9WgXcQ`, `9bZkp7q19f0`) |
| TC-SRV-045 | REQ-SRV-036 | PO Token provider stopped (or deno absent) | Create a session | Server log shows `player_client=default (...)`, no `--extractor-args` in the logged `yt-dlp` command — NOT forced to `mweb` | Manual — verified 2026-08-25 |

## 10. Server — RTSP-over-WebSocket bridge

| ID | Requirement | Preconditions | Steps | Expected result | Coverage |
| --- | --- | --- | --- | --- | --- |
| TC-SRV-050 | REQ-SRV-041 | Bridge reachable | Open a WS to `/StreamingServer`, send a non-RTSP first message | Connection closes with code `1002` | Manual |
| TC-SRV-051 | REQ-SRV-042 | — | Send a valid RTSP request whose URI has no numeric channel segment | Connection closes with code `1008` | Manual |
| TC-SRV-052 | REQ-SRV-042 | No session on channel 5 | Send a request URI targeting channel 5 | Server sends `404`, then closes with `1008` | Manual |
| TC-SRV-053 | REQ-SRV-043 | Live session on channel `N` with known credentials | Send a request with no `Authorization` header | `401` + `WWW-Authenticate: Digest` with a nonce | Manual |
| TC-SRV-053a | REQ-SRV-043a | Session on channel `N` created with `username`/`password` both `""` | Send a request with no `Authorization` header | No `401` — bridge proceeds straight to the post-auth flow (`waitForLive`/relay) on the first message | Manual |
| TC-SRV-054 | REQ-SRV-043 | — | Retry with wrong password | `401` again with a **new** nonce | Manual |
| TC-SRV-055 | REQ-SRV-044 | — | Fail auth 4 times in a row | Connection closes with code `1008` after the 3rd failed attempt | Manual |
| TC-SRV-056 | REQ-SRV-045 | Session created but not yet `live` | Connect and authenticate immediately | Bridge waits (does not error immediately); if still not live after 15s, closes with `1011` | Manual |
| TC-SRV-057 | REQ-SRV-045, 046 | Session `live` | Authenticate correctly | Bridge connects to MediaMTX and begins relaying `DESCRIBE`/`SETUP`/`PLAY` responses and RTP frames | Manual — also exercised end-to-end by TC-PLY-022 |
| TC-SRV-058 | REQ-SRV-050..052 | `live` H.264 session, fresh viewer connects mid-GOP | Connect a raw WS client, `SETUP`+`PLAY` the video track, capture the first few interleaved frames on that channel | No frame is delivered until one containing an IDR NAL (verify via NAL type byte); frames are otherwise relayed unmodified | Manual (or `keyframeGate.ts` unit-level assertions if run directly) |
| TC-SRV-059 | REQ-SRV-051 | Contrived: video source that never produces a keyframe in time (or a delayed encoder start) | Connect and `SETUP`+`PLAY` | After ~4s, frames begin flowing even without a confirmed IDR (fail-open) | Manual |
| TC-SRV-060 | REQ-SRV-053 | `live` MJPEG session | Connect and play | All frames relay immediately — no gating delay | Manual |

## 11. Server — startup / transport

| ID | Requirement | Preconditions | Steps | Expected result | Coverage |
| --- | --- | --- | --- | --- | --- |
| TC-SRV-070 | REQ-SRV-060 | — | `npm run start:server:http` | Server starts HTTP-only; `http://127.0.0.1:4000/health` returns `{ok:true}`; no HTTPS listener | Manual |
| TC-SRV-071 | REQ-SRV-060 | — | `npm run start:server:https` | Server starts HTTPS-only on 4001 | Manual |
| TC-SRV-072 | REQ-SRV-061 | TLS cert/key files deleted/missing | `npm run start:server:https` | Process exits with code 1 and a clear error naming the missing paths | Manual |
| TC-SRV-073 | REQ-SRV-062 | MediaMTX not running | Start the server (either mode) | Server still starts and serves `/health`/REST API; logs a MediaMTX-unreachable warning | Manual |
| TC-SRV-074 | REQ-SRV-070 | Session data present | Inspect any `PublicSession` returned by the REST API | No `password` field anywhere in the JSON | Auto-adjacent (grep the response); also implied by TC-SRV-025/028 |

## 12. End-to-end (Player + Server)

| ID | Requirement | Preconditions | Steps | Expected result | Coverage |
| --- | --- | --- | --- | --- | --- |
| TC-E2E-001 | README "Server ↔ Player: live-session flow" | Server running, all external tools installed | Follow the full flow: probe → create session → wait for `live` → open Player tab with matching channel/credentials → connect → play | Video renders in-browser within the bridge's liveness window; audio plays if not muted; statistics overlay updates | Manual — primary demo-page smoke test, see test-script §3 |
| TC-E2E-002 | REQ-SRV-016, REQ-PLY-042 | Playing per TC-E2E-001 | `DELETE` the session while the Player is still connected | Player's WebSocket closes (backend socket closes -> `ws.close()`); Player surfaces a `close`/`error` event | Manual |
| TC-E2E-003 | Demo page Test tab | Built `dist/` | Open the demo page's **Test** tab | All 37 in-browser contract cases (same suite as `custom/RTSPOverWebSocket.test.ts` under `jsdom`) report pass, independent of Node/vitest | Manual — see test-script §4 |
