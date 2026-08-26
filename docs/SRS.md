# Software Requirements Specification (SRS)

Detailed, testable requirements for the Player and Server. Requirement IDs are referenced from
[TC.md](TC.md)'s test cases. See [PRD.md](PRD.md) for product-level requirements this document elaborates, and
[DESIGN.md](DESIGN.md) for how each requirement is actually implemented.

## 1. Scope

Covers `src/player` (the `<rtsp-over-websocket>` custom element and its supporting modules) and `src/server` (the
REST API + RTSP-over-WebSocket bridge + YouTube transcode pipeline). Excludes `src/player/legacyHostInterface`
(legacy host-app glue), which is contract-tested separately and not part of the neutral API surface these
requirements describe.

## 2. Definitions

| Term | Meaning |
| --- | --- |
| Session | A server-side record (`src/server/types.ts`'s `Session`) tracking one YouTube→RTSP transcode: id, channel, status, request params, MediaMTX publish path |
| Channel | Numeric identifier a Player connects to; 1-based in the `channel` attribute/UI, 0-based on the wire and in `Session.channel` |
| Bridge | `src/server/rtspOverWebSocket/server.ts` — the WebSocket ⇄ RTSP relay |
| IDR / keyframe | A self-contained video frame decodable without prior frames — required before a decoder can start producing output |
| Digest auth | RTSP Digest (MD5, no `qop`) authentication, per RFC 2617 §3.2.2 simple mode |

## 3. System overview

```
Browser: <rtsp-over-websocket> ──ws(s)://…/StreamingServer──▶ src/server bridge ──RTSP/TCP──▶ MediaMTX ◀──RTSP/TCP(publish)── ffmpeg ◀──stdout pipe── yt-dlp ◀── YouTube
```

Full diagrams: [ARCHITECTURE.md](ARCHITECTURE.md), [DESIGN.md](DESIGN.md).

## 4. Player requirements (`src/player`)

### 4.1 Custom element registration

- **REQ-PLY-001**: The library MUST register a custom element `rtsp-over-websocket` backed by class
  `RTSPOverWebSocket extends HTMLElement` (`src/player/elements/RTSPOverWebSocket.ts`).
- **REQ-PLY-002**: `version()` MUST return the library's semantic version string.

### 4.2 Attributes

`static get observedAttributes()` MUST include, and `attributeChangedCallback` MUST handle, at minimum:

| Attribute | Type/values | Requirement |
| --- | --- | --- |
| `hostname` | string | REQ-PLY-010: target host; defaults to `document.location.hostname` if unset at `connectedCallback` |
| `channel` | integer ≥ 1 (string form) | REQ-PLY-011: 1-based in markup; stored internally 0-based (`_channel = value - 1`). Value `< 1` MUST throw `RTSPOverWebSocketError` (code `0x0413`) |
| `profile` / `profile_number` | string / integer | REQ-PLY-012: mutually exclusive — setting one clears the other. Wrong type MUST throw (code `0x0414`) |
| `device` | `camera` \| other | REQ-PLY-013: selects device-type-specific URI building in the RTSP client; defaults to `camera` |
| `username` / `password` | string | REQ-PLY-014: RTSP-over-WebSocket digest credentials |
| `iframe`, `controls`, `multicast` | boolean-presence | REQ-PLY-015: presence-only flags |
| `width` / `height` | number/string | REQ-PLY-016: forwarded to the underlying canvas/video element |
| `mode` | `live` \| `playback` | REQ-PLY-017: sets `playType`; any other value MUST throw (code `0x0412`) |
| `proxy`, `port`, `secure`/`https` | string / boolean-ish | REQ-PLY-018: connection routing; `secure`/`https` both toggle the same internal flag |
| `statistics` | boolean-ish, default true unless `"false"` | REQ-PLY-019: toggles the statistics overlay |
| `network` | boolean-ish | REQ-PLY-020: toggles network-quality indicator |
| `gmt` | number \| `null`/`undefined` string | REQ-PLY-021: timezone offset applied to timestamp calculations |
| `bestshotfilter` | `Person`\|`Face`\|`FaceRecognition`\|`Vehicle`\|`LicensePlate` (case-insensitive) or numeric index | REQ-PLY-022: unrecognized values reset the filter to `null` (no throw) |
| `type` | `video`\|`canvas`\|`auto` | REQ-PLY-023: selects the rendering backend; other values MUST throw (code `0x0414`) |
| `usesubstream` | `"true"`\|`"false"` | REQ-PLY-024: any other value MUST throw (code `0x0414`) |
| `camchannel` | integer string | REQ-PLY-025: non-numeric value MUST throw (code `0x0414`) |
| `profileusage` | `Live`\|`Record`\|`Network` | REQ-PLY-026: other values MUST throw (code `0x0414`) |
| `codec` | `MJPEG`\|`H264`\|`H265`\|`MPEG4` | REQ-PLY-027: other values MUST throw (code `0x0414`) |
| `limitwidth` / `limitheight` | integer string | REQ-PLY-028: non-numeric value MUST throw (code `0x0414`) |

- **REQ-PLY-029**: An unrecognized attribute name reaching `attributeChangedCallback`'s `default` case MUST log a
  `console.warn` and MUST NOT throw.

### 4.3 Playback control

- **REQ-PLY-040**: `play()` MUST initiate playback per the current `playType`/`mode`.
- **REQ-PLY-041**: `pause()` MUST suspend playback without tearing down the connection; `resume()` MUST continue it.
- **REQ-PLY-042**: `stop()` MUST tear down the current stream/connection.
- **REQ-PLY-043**: `speed()` MUST support every rate in `RTSPOverWebSocketPlaySpeed` (0.125x–256x forward, and the
  matching negative "seek" rates for reverse playback) in `playback` mode.
- **REQ-PLY-044**: `forward()` / `backward()` MUST step playback position in `playback` mode.
- **REQ-PLY-045**: `seeking()` MUST jump playback to `seekingTime` (ISO-8601, validated on assignment).
- **REQ-PLY-046**: Setting `playType` to `INSTANTPLAYBACK` MUST pause any active live playback first, then issue an
  `init` control command; setting it back to `LIVE` from `INSTANTPLAYBACK` MUST resume.
- **REQ-PLY-047**: `startTime`/`endTime`/`seekingTime` setters MUST validate ISO-8601 format
  (`YYYY-MM-DDTHH:mm:ss[.SSS]Z`) and MUST throw (code `0x0414`) on an invalid string or wrong type.

### 4.4 Audio

- **REQ-PLY-050**: `mute()`/`unmute()`/`isMute()` MUST control and report the audio-muted state.
- **REQ-PLY-051**: `getAudioVolume()`/`setAudioVolume(volume)` MUST get/set audio output volume.
- **REQ-PLY-052**: `talk(flag)` MUST start/stop two-way talk audio.

### 4.5 Capture and backup

- **REQ-PLY-060**: `capture(filename?)` MUST save the currently rendered frame as an image.
- **REQ-PLY-061**: `backup(flag)` MUST toggle backup mode; `startBackup()`/`endBackup()` MUST bound a local
  recording session producing AVI/ZIP output.

### 4.6 Events

`RTSPOverWebSocket` MUST dispatch (via its own `dispatch`/`dispatchEvent`) at least the following event types,
each carrying a payload relevant to its name: `statechange`, `error`, `timestamp`, `resize`, `meta`, `metaImage`,
`statistics`, `capture`, `instantplayback`, `backupstatechange`, `waiting`, and `change*` attribute-mirroring
events (`changehostname`, `changechannel`, `changeprofile`, `changeprofilenumber`, `changedevicetype`,
`changeusername`, `changepassword`, `changeport`, `changeprotocol`, `changetimezone`, `changebestshotfilter`,
`changeclient`, `changefullscreen`, `changemute`, `changevolume`, `changeplayermode`, `changesunapiclient`).

- **REQ-PLY-070**: `addEventListener(type, listener)` / `removeEventListener(type, listener)` MUST support the
  standard DOM listener contract for all of the above event types.
- **REQ-PLY-071**: An RTSP-over-WebSocket-layer error (auth, RTSP, RTCP, SUNAPI) MUST surface through the `error`
  event with enough context (`errorCode`, `channel`, `place`) to diagnose without a debugger — see §4.8.

### 4.7 Codec / rendering support

- **REQ-PLY-080**: Video decode/render MUST support H.264, H.265, and MJPEG.
- **REQ-PLY-081**: Audio decode/render MUST support AAC, G.711, and G.726 (plus talk-back audio).
- **REQ-PLY-082**: Rendering backend MUST be selectable between `canvas` and `video` (`type` attribute), with
  `auto` deferring to the library's default choice.

### 4.8 Error handling

- **REQ-PLY-090**: All thrown library errors MUST be instances of `RTSPOverWebSocketBaseError` subclasses
  (`RTSPOverWebSocketError`, `AuthError`, `RTCPError`, `RTSPError`, `SunapiError`), each carrying `errorCode`,
  `channel`, `element`, and `place`.
- **REQ-PLY-091**: Error construction MUST use the options-object form (`{ message, channelId, elementId,
  errorCode, place }`) exclusively — the legacy variadic-args form is not part of this port's public contract.

### 4.9 Legacy behavior preservation

- **REQ-PLY-100**: Where a confirmed legacy bug is reachable and call sites may depend on it (e.g. the `android`
  attribute case always throwing when set via markup because `attributeChangedCallback`'s `newValue` is always a
  string, never the real `boolean` the legacy check expects), this port MUST reproduce the bug rather than fix it,
  with the behavior documented inline at its exact location.

## 5. Server requirements (`src/server`)

### 5.1 REST API — `/api/youtube`

- **REQ-SRV-001**: `GET /api/youtube/probe?url=<youtube-url>` MUST return `400` if `url` is missing, `502` if
  `yt-dlp` fails or returns no resolvable video formats, and otherwise `200` with `{ youtubeUrl, videoId, title,
  durationSec, maxHeight, availableResolutions, sourceVideoCodecs, sourceAudioCodecs }`.

### 5.2 REST API — `/api/sessions`

- **REQ-SRV-010**: `POST /api/sessions` MUST validate: `youtubeUrl` (http(s) URL string), `resolutionHeight` (one
  of the fixed resolution ladder), `videoCodec` (one of `MJPEG`/`H264`/`H265`/`AV1`/`VP8`/`VP9`), `audioCodec` (one
  of `OPUS`/`AAC`/`G711`/`G726`), `audioBitrateKbps` (1–512), `username`/`password` (each a string; MUST be either
  both empty — an unauthenticated session, REQ-SRV-043a — or both non-empty, never one empty and the other not),
  and an optional non-negative-integer `channel`. Any violation MUST return `400` with a descriptive `error`.
- **REQ-SRV-011**: If `channel` is given and already occupied by a `starting`/`live` session, the request MUST
  return `409`. If occupied by a `stopped`/`failed` session, that session MUST be deleted and the channel reused.
- **REQ-SRV-012**: If the installed `ffmpeg` build has no encoder for the requested `videoCodec`/`audioCodec`, the
  request MUST return `422` before any transcode process is spawned.
- **REQ-SRV-013**: If `yt-dlp` probing of `youtubeUrl` fails, the request MUST return `502`.
- **REQ-SRV-014**: On success, the request MUST return `201` with the created session (password omitted) at
  `status: "starting"`, and the transcode MUST start asynchronously (the HTTP response MUST NOT block on it).
- **REQ-SRV-015**: `GET /api/sessions` MUST list all sessions (password omitted from each). `GET
  /api/sessions/:id` MUST return `404` for an unknown id, else the session (password omitted).
- **REQ-SRV-016**: `DELETE /api/sessions/:id` MUST return `404` for an unknown id; otherwise it MUST stop the
  session's transcode processes, remove the session, and return `204`.

### 5.3 REST API — `/api/capabilities`

- **REQ-SRV-020**: `GET /api/capabilities` MUST return the fixed resolution ladder plus, for every known video and
  audio codec, whether the installed `ffmpeg` build has a usable encoder (`available`, `ffmpegEncoder`, and a
  `reason` when unavailable). Results MUST be cached after first detection (not re-probed per request).

### 5.4 Transcode session lifecycle

- **REQ-SRV-030**: A session's status MUST transition `starting → live` on the first `frame=` progress line
  observed on `ffmpeg`'s stderr.
- **REQ-SRV-031**: A session MUST transition `starting → failed` if no `frame=` line appears within
  `TRANSCODE_STARTUP_TIMEOUT_MS` (20000ms, `config.ts`), or if `yt-dlp`/`ffmpeg` fails to spawn or exits non-zero
  during startup.
- **REQ-SRV-032**: Once `live`, an `ffmpeg` exit MUST transition the session to `stopped` (exit code 0) or `failed`
  (non-zero/signal) — unless the session was already explicitly `stopped` via `DELETE`, which MUST NOT be
  overwritten.
- **REQ-SRV-033**: `yt-dlp`'s source-format selection MUST prefer an `avc1` (H.264) source at or below the
  requested height, falling back to the best available format at or below that height.
- **REQ-SRV-034**: Video encoder argument construction MUST scale to the requested height and apply
  codec-appropriate low-latency/parameter-repetition flags (e.g. H.264/H.265 `repeat-headers=1`, so SPS/PPS are
  embedded in-band before every keyframe — required for players joining mid-stream).
- **REQ-SRV-035**: G.726 audio encoding MUST round an out-of-range requested bitrate to the nearest value the
  encoder actually supports (16/24/32/40 kbps) rather than failing the session.
- **REQ-SRV-036**: `yt-dlp`'s invocation MUST add `--extractor-args youtube:player_client=mweb` if and only if
  both a JS runtime (`~/.deno/bin/deno`) and a reachable bgutil-ytdlp-pot-provider HTTP server (default
  `127.0.0.1:4416`, `scripts/ensure-bgutil-pot-provider.js`) are available at the start of that session; if either
  is missing, `yt-dlp` MUST be invoked without a `player_client` override. Forcing `mweb` without both available
  MUST NOT be done — confirmed to make sessions fail that the unforced default handles.

### 5.5 RTSP-over-WebSocket bridge (`/StreamingServer`)

- **REQ-SRV-040**: The bridge MUST accept WebSocket upgrades only at path `/StreamingServer`, coexisting with any
  other `upgrade` handling on the same HTTP(S) server.
- **REQ-SRV-041**: On the first message from a new connection, the bridge MUST parse it as an RTSP request line; a
  non-parsing first message MUST close the connection with code `1002`.
- **REQ-SRV-042**: The bridge MUST extract a numeric channel from the request URI and look up the matching
  session; no numeric segment MUST close with code `1008`, and no matching session MUST send a `404` RTSP response
  then close with code `1008`.
- **REQ-SRV-043**: The bridge MUST challenge every unauthenticated/incorrectly-authenticated request with RTSP
  Digest (`401` + a fresh nonce per challenge), verified against **that session's own** `username`/`password`
  (never a shared/global credential) — except as carved out by REQ-SRV-043a.
- **REQ-SRV-043a**: If a session's `username`/`password` are both empty (REQ-SRV-010), the bridge MUST skip the
  Digest challenge entirely for connections on that session's channel and proceed directly to relaying from the
  first request, with no `401` ever sent.
- **REQ-SRV-044**: After `MAX_AUTH_ATTEMPTS` (3) failed challenges, the bridge MUST close the connection with code
  `1008`.
- **REQ-SRV-045**: Once authenticated, the bridge MUST wait (up to `SESSION_LIVE_WAIT_MS` = 15000ms) for the
  session to reach `live` before opening its own RTSP/TCP connection to MediaMTX; if the session fails/stops or
  the wait times out, the bridge MUST close the WebSocket with code `1011`.
- **REQ-SRV-046**: Once connected to MediaMTX, the bridge MUST rewrite outgoing request URIs from the client's base
  URI to the session's MediaMTX path, and relay all subsequent RTSP responses and interleaved RTP/RTCP frames back
  to the WebSocket client unmodified (aside from keyframe gating, §5.6).
  a backend socket error/close MUST close the WebSocket.
- **REQ-SRV-047**: If the backend byte stream does not resolve into a complete RTSP response within
  `MAX_PENDING_RTSP_TEXT_BYTES` (1MB), the bridge MUST disable keyframe gating and relay the raw buffered bytes
  rather than buffering unboundedly.

### 5.6 Keyframe gating

- **REQ-SRV-050**: For H.264/H.265 video tracks only, once a `SETUP` response establishes the video RTP
  interleaved channel, the bridge MUST withhold non-keyframe video RTP packets on that channel from the client
  until the first IDR/IRAP (or an aggregate packet containing one) is observed.
- **REQ-SRV-051**: If no keyframe appears within `KEYFRAME_GATE_TIMEOUT_MS` (4000ms), the gate MUST open anyway
  (fail open) — gating is a latency/noise optimization, never a hard playback requirement.
- **REQ-SRV-052**: Gating logic MUST correctly classify H.264 single-NAL, STAP-A aggregate, and FU-A fragment
  packets (RFC 6184), and H.265 single-NAL, aggregation-packet, and fragmentation-unit packets (RFC 7798).
- **REQ-SRV-053**: Video codecs other than H.264/H.265 (MJPEG, VP8, VP9, AV1) MUST NOT be gated — the SDP parser
  only recognizes H264/H265/HEVC `rtpmap` entries as gate-eligible.

### 5.7 Server startup / transport

- **REQ-SRV-060**: The server MUST support HTTP-only, HTTPS-only, or both, selected via `--http`/`--https`/`--both`
  CLI flags, the `RTSP_WS_PROTOCOL` env var, or (only when a real TTY is attached and neither of the above is
  given) an interactive prompt; a non-interactive run with none of these MUST default to `both`.
- **REQ-SRV-061**: HTTPS mode MUST fail fast (`process.exit(1)`) with a clear message if the configured TLS
  key/cert files do not exist.
- **REQ-SRV-062**: At startup, the server MUST probe MediaMTX reachability (`MEDIAMTX_HOST:MEDIAMTX_RTSP_PORT`) and
  log a warning (not fail) if unreachable — session creation must remain possible, failing later at the
  `ffmpeg`-publish step instead.
- **REQ-SRV-063**: `ws://`/`http://` MUST share `HTTP_PORT`; `wss://`/`https://` MUST share `HTTPS_PORT` — no
  separate port for the WebSocket bridge.

## 6. Data model

`src/server/types.ts`:

```
Session {
  id: string (UUID)
  channel: number            // 0-based wire value
  status: 'starting' | 'live' | 'stopped' | 'failed'
  request: CreateSessionRequest  // includes password (server-internal only)
  probe: { title, durationSec, maxHeight }
  mediaMtxPath: string       // == id
  createdAt: string (ISO-8601)
  error?: string
}
PublicSession = Omit<Session, 'request'> & { request: Omit<CreateSessionRequest, 'password'> }
```

- **REQ-SRV-070**: Any REST response containing session data MUST use `PublicSession` — the `password` field MUST
  NOT be serialized to any client.

## 7. Non-functional requirements

| Category | Requirement |
| --- | --- |
| **Security — auth scope** | REQ-NFR-001: RTSP-over-WebSocket credentials are per-session, set at session creation; they are not real device credentials and MUST NOT be treated as such. |
| **Security — transport** | REQ-NFR-002: HTTPS/WSS MUST be supported via a configurable TLS key/cert pair (dev default: a self-signed cert shared with `scripts/serve-dist.js`). |
| **Security — posture** | REQ-NFR-003: CORS is intentionally permissive (`*`) and the REST API has no authentication — acceptable only because this is a local dev/test tool (see [MRD.md](MRD.md) §6); this MUST NOT be treated as production-hardened. |
| **Reliability** | REQ-NFR-010: A crashing/misbehaving session's `yt-dlp`/`ffmpeg` processes MUST NOT affect any other session's processes. |
| **Reliability** | REQ-NFR-011: Sessions are never garbage-collected automatically; only an explicit `DELETE` removes one — a terminal session persists in the store for status visibility until then. |
| **Performance** | REQ-NFR-020: Keyframe gate and MediaMTX-liveness waits MUST be bounded (4s / 15s respectively) — no unbounded wait on any client-visible path. |
| **Portability — Player** | REQ-NFR-030: The built player bundle MUST run in any modern evergreen browser without a plugin; `custom/RTSPOverWebSocket.test.ts` MUST pass under `jsdom` as a baseline DOM-lifecycle contract check. |
| **Portability — Server** | REQ-NFR-031: The server MUST run on Node 20+ (see `CLAUDE.md`'s Node-version environment gotcha) and MUST start (REST API serving) even when `ffmpeg`/`yt-dlp`/MediaMTX are entirely absent — only session creation/liveness is affected. |
| **Observability** | REQ-NFR-040: Every session's `yt-dlp`/`ffmpeg` stderr output MUST be logged with a session-id tag prefix (`[ffmpeg][<8-char-id>]` / `[yt-dlp][<8-char-id>]`) for diagnosability. |

## 8. Error code reference (Player)

| Code | Meaning | Raised by |
| --- | --- | --- |
| `0x0412` | Required mode/configuration missing | `mode` attribute unset in a context requiring it |
| `0x0413` | Invalid channel number (`< 1`) | `channel` attribute setter |
| `0x0414` | Invalid input parameter type/value | `profile_number`, `type`, `usesubstream`, `camchannel`, `profileusage`, `codec`, `limitwidth`, `limitheight`, `android`, `playType`, `startTime`/`endTime`/`seekingTime` setters |

All error instances additionally carry `channelId`, `elementId`, and `place` (source location string) for
diagnostics — see `src/player/exceptions/`.

## 9. External dependencies

See [PRD.md](PRD.md) §3 and [README.md](../README.md#external-tools-required-by-srcserver) for install
instructions. In requirement terms: **REQ-DEP-001** the server MUST degrade gracefully (REST API still serves)
when `ffmpeg`, `yt-dlp`, or MediaMTX are unavailable — only transcode-session creation/liveness is affected, never
server startup.
