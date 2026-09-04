# `src/player/network` — RTSP-over-WebSocket signaling, transport, and SUNAPI HTTP

*Per-class reference for `src/player/network`: RTSP-over-WebSocket signaling, transport, and the SUNAPI HTTP
client, with concrete method behavior, wire framing, and RFC citations.*

**Version:** 1.1.0 · **Author:** Youngho Kim

**History**

| Date | Change |
| --- | --- |
| 2026-08-06 | Add per-class reference docs for `src/player` (initial version) |
| 2026-08-11 | Add AV1/VP8/VP9 + WebCodecs decode support, per-class player docs, server lifecycle/config improvements, and fix SUNAPI protocol clobbering on non-http(s) hosts |
| 2026-08-11 | Fix `SunapiManager`'s `joinAfterGet` bug: eight REST methods always rejected regardless of the actual GET result |
| 2026-08-13 | Add `.env` support for the live-device test; fix `describe.skip` collection bug; docs |
| 2026-08-26 | Added Title/Abstract/Version/Author/History metadata header |
| 2026-08-31 | `SunapiManager` now caches digest challenges across `init()` calls (`SunapiClient.seedAuthInfo()`) to cut the redundant OPTIONS-preflight/401-retry round trip most `init()` calls previously paid |
| 2026-09-01 | `parseRtspResponse()` now parses a PLAY/SEEK/RESUME response's `Scale` header into `RtspResponseData.Scale`, threaded through as `RtspClientErrorEvent.scale` so `RTSPOverWebSocket` can self-correct `playSpeed` when a device clamps/rejects the requested value |
| 2026-09-02 | Fix TEARDOWN belt-and-suspenders disconnect trigger racing the real response: it polled every 500ms and force-`clearTransport()`'d as soon as that first tick found `currentState` still `'Playing'`, regardless of whether the actual `200 OK` had arrived yet — on a slower TEARDOWN (observed live on recording/playback sessions) this tore the transport down before the real response could be processed, so no `200 OK` was ever seen for it. Now a single 5s `setTimeout` (`teardownWatchdogHandler`), cancelled from `clearTransport()` itself as soon as the response-driven path (or any other path) completes teardown first, so it never fires once the real response has already been handled |
| 2026-09-04 | `RtspClient`/`Transport`/`AttributeService`/`SunapiClient`/`SunapiManager`/`SunapiRestClient` each gained a `debug`/`set debug()` gate (`util/debugLog.ts`, see `01-elements-interface-exceptions.md`'s new `debug` attribute and `08-util.md`) — `debug["network"]` in the JSON config, `true` for all six or an array of specific class names. `RtspClient`'s existing 11 `console.log('[RtspClient] ...')` calls and `AttributeService`'s 17 `console.log(...)` calls were migrated onto the new gated `this.debugLog(...)` (real `console.error` calls, in both files, are untouched); `Transport` gained new `Connect()`/`Disconnect()` trace points. `RtspClient` forwards the config to the `Transport` it constructs internally (`Connect()`, `transport.debug = this.debugConfig`) — `StreamPlayer`'s constructor is what actually sets `rtspClient.debug` in the first place (see `01`). `XmlParser` was deliberately **not** instrumented — its own doc comment states it's pure, stateless parsing helpers, and adding mutable debug state would work against that. |

---

This document is the per-class reference for `src/player/network` (plus the one `util` class it
leans on hardest, `DigestGenerator`). It goes one level deeper than
[docs/ARCHITECTURE.md](../ARCHITECTURE.md)'s "Playing a stream" sequence diagram and
[src/player/README.md](../../src/player/README.md)'s `network` class diagram: concrete method
behavior, the exact RTSP/HTTP wire framing, and RFC citations verified against the actual code
(not assumed from convention).

Covered here:

- `network/rtspOverWebsocket/RtspClient.ts` — `RtspClient`
- `network/rtspOverWebsocket/RtspClientManager.ts` — `RtspClientManagerImpl` / `RtspClientManager`
- `network/transport/Transport.ts` — `Transport`
- `network/http/SunapiClient.ts` — `SunapiClient`
- `network/http/SunapiManager.ts` — `SunapiManager`
- `network/http/XmlParser.ts` — `XmlParser`
- `network/http/AttributeService.ts` — `AttributeService`
- `network/http/ProfileConfig.ts` — `ProfileConfig`
- `network/http/SunapiRestClient.ts` — `SunapiRestClient`
- `network/http/SunapiException.ts` — `SunapiException`
- `network/http/HttpStatusCode.ts` — `HTTP_STATUS_CODES`
- `network/RtspStatusCode.ts` — `RtspStatusCode`
- `network/WebsocketStatusCode.ts` — `WebsocketStatusCode`
- `util/DigestGenerator.ts` — `DigestGenerator`

Collaborators referenced but documented elsewhere: `StreamPlayer` (interface/), `RtpClient` /
`MediaRouter` (mediaSession/), the `<rtsp-over-websocket>` custom element (elements/), and
`worker/sunapi/sunapiRequestTask.ts` (worker/).

---

## `RtspClient` (`src/player/network/rtspOverWebsocket/RtspClient.ts`)

Ported from the legacy player's `Network/RTSPoverWebsocket/rtspClient`. This is the RTSP
state-machine/signaling layer: it builds RTSP/1.0 request text, tracks the OPTIONS → DESCRIBE →
SETUP → PLAY → Playing → Teardown state progression, parses SDP and RTSP responses, and drives
digest authentication (including the redesigned interactive-retry path added in this repo's
recent history — see `retryWithCredentials()` below).

### Structure

- **Identity/session fields**: `rtspUrl`, `id`/`pw` (username/password), `userAgent`, `wsUrl`,
  `audioOutStatus`, `mode` (`'live'|'playback'|'backup'`), `rangeClock`, `scale`, `deviceType`
  (`'camera'|'nvr'`), `SessionId`, `ContentBase`, `channelId`.
- **Protocol bookkeeping**: `CSeq` (starts at 1, incremented per response), `Authentication`
  (the current `Authorization:` header text, or `''`), `wwwAuthenticate` (raw cached
  `WWW-Authenticate` header text from the last 401), `unahtuorizedCount`, `currentState` /
  `nextState` (string state machine: `'Options'|'Describe'|'Setup'|'Play'|'Playing'|'Pause'|
  'Teardown'`), `setupSDPIndex`, `SDPinfo: SdpInfoEntry[]` (one entry per negotiated media track).
- **Collaborators**: `transport: TransportLike | null` (created via the injectable
  `transportFactory`, default `(serverAddr) => new Transport(serverAddr)`), `readonly
  digestGenerator = new DigestGenerator()`, `sunapiClient: SunapiClientLike | null` (injected via
  `SetSunapiClient()`; camera-mode digest-auth alternative to `id`/`pw`), `rtpClient?:
  RtpClientLike` (set externally by the caller, e.g. `StreamPlayer`, after `Connect()` — `RtspClient`
  only calls methods on it, never constructs it).
- **Queueing**: `rtspQueue` (array of `{method, requestURL, extHeader}`) + `isRequested` — RTSP is
  a strict request/response protocol over one connection, so only one command is in flight at a
  time; see Method Analysis.
- **Timers**: `getParameterIntervalHandler` (keepalive `GET_PARAMETER` every 10s while playing),
  `checkAliveIntervalHandler` (liveness watchdog), both plain `setInterval` handles.
- **Constructor**: `constructor(transportFactory: TransportFactory = (serverAddr) => new
  Transport(serverAddr))` — the only constructor argument, purely for test injection of a fake
  transport.
- Implements no interface/base class; it's a plain class with callback-style events
  (`SetErrorCallback`/`addEventListener('error'|'rtsp'|'status'|'recv', ...)` — `'status'` is
  wired but never invoked, preserved from legacy as write-only state).

### Method Analysis

**Command construction / queueing**

- `CommandConstructor(method, requestURL?, extHeader?)` — builds the raw RTSP/1.0 request text
  for `OPTIONS`/`DESCRIBE`/`SETUP`/`PLAY`/`PAUSE`/`TEARDOWN`/`GET_PARAMETER`/`SET_PARAMETERS`.
  Every branch appends `CSeq:`, and (except `OPTIONS`) `Session:` once a session exists. `DESCRIBE`
  adds `Accept: application/sdp\r\n` and, if `audioOutStatus === 'on'`, an ONVIF backchannel
  `Require:` header. `SETUP` chooses the request-URI from `requestURL` (absolute `rtsp:` URL),
  `ContentBase + requestURL`, or `rtspUrl + '/' + requestURL`, in that priority. `PLAY`/`PAUSE`
  request against `ContentBase` for NVRs, otherwise `rtspUrl`, and `PLAY` in `'playback'`/`'backup'`
  mode adds a `Require: samsung-replay-timezone` (camera) or `Require: onvif-replay` (NVR) header.
  Returns `null` (and reports error `0x0006`) if no transport exists and the method isn't
  `OPTIONS`.
- `_request(method, requestURL?, extHeader?)` — the public-facing enqueue point used throughout
  the class. `TEARDOWN` jumps the queue (position 0, or 1 if a request is already in flight) since
  it must preempt everything else; all other methods append. Only actually sends
  (`_send(...)`) if the queue was empty before this push — i.e., true FIFO, one in-flight command
  at a time.
- `_send(method, requestURL?, extHeader?)` — builds the message via `CommandConstructor`, forwards
  raw text to the `rtsp` event listener, sets `isRequested = true`, and calls
  `transport.SendRtspCommand(message, callback)`. The callback runs `RtspResponseHandler`, then
  shifts the completed item off `rtspQueue` and, if more remain, schedules the next `_send` via
  `setTimeout(...)` (yields a tick rather than recursing synchronously). For `TEARDOWN`, also
  arms a 5s fallback timer (`teardownWatchdogHandler`) that calls `clearTransport()` if
  `currentState === 'Playing' && nextState === 'Teardown'` is *still* true once it fires — this
  exists because the TEARDOWN response itself normally drives that transition via
  `RtspResponseHandler`/`handleResponse200`; the timer is a belt-and-suspenders disconnect trigger
  for a response that never arrives at all (dropped packet, server hang). `clearTransport()`
  itself cancels this timer unconditionally on entry, from whichever path reaches it first (the
  real response, or the fallback), so the two can't race each other into a double teardown or
  (the bug this replaced — found live 2026-09-02: a 500ms *poll interval* fired on its very first
  tick whenever a real `200 OK` simply hadn't arrived yet, tearing the transport down — and with
  it, the in-flight response — before `RtspResponseHandler` ever got to process it) fire before a
  merely-slow real response is processed.

**Response parsing**

- `parseDescribeResponse(response)` — hand-rolled SDP parser (not a general SDP library). Splits
  on `\r\n\r\n` to isolate the body, then on `(?=m=)` to get one chunk per media section. Extracts
  `v=` (SDP version; throws `RTSPOverWebSocketError` `0x0208` if not `0`), `o=` (Origin — six
  space-separated fields), `i=` (session info), `c=` (connection data), `a=control:` (session-level
  `BaseURL`), then per-media-section `m=`, `a=control:`, `a=rtpmap:`, `a=framesize:`,
  `a=framerate:`, `a=fingerprint:`, `b=AS|RS|RR:`, `a=fmtp:` (sub-parsed for `mode`, `config`,
  `profile-level-id`, `streamtype`, `SizeLength`/`IndexLength`/`IndexDeltaLength` — matched
  case-insensitively per RFC 3640, since some encoders like this repo's own ffmpeg-based demo
  server lowercase them — `profile`, `bitrate`, `sprop-vps`/`sprop-sps`/`sprop-pps`, and the
  combined `sprop-parameter-sets=SPS,PPS` form), and `i=` (per-media info). `Origin`/
  `ConnectionData` are built as arrays with extra string properties bolted on (`result.Origin =
  []; result.Origin.UserName = ...`), preserved verbatim from legacy for exact-shape parity tests.
- `parseRtspResponse(message1)` — parses the status line (`RTSP/1.0 <code> <reason>`) and, only for
  `200`, walks header lines for `Public`, `CSeq`, `Content-Type` (dispatching to
  `parseDescribeResponse` if `application/sdp`), `Content-Length`, `Content-Base`, `Session`
  (splitting off a `;timeout=` parameter), `Transport` (extracting the `interleaved=<rtp>-<rtcp>`
  channel IDs), `RTP-Info` (semicolon/comma-delimited `url=`/`seq=` pairs), and — **new (found
  live, 2026-09-01)** — `Scale` (`:820-821`, `RtspResponseData.Scale = parseFloat(LineTokens[1])`):
  a PLAY/SEEK/RESUME response can echo back a *different* Scale than what was requested (a device
  clamping/rejecting an unsupported value, e.g. a camera that only does whole-number playback
  speeds), and this is how that gets surfaced at all. `RtspResponseHandler()`'s PLAY/SEEK/RESUME
  error-dispatch sites thread it through as `RtspClientErrorEvent.scale`; see
  `docs/player/01-elements-interface-exceptions.md`'s `onRTSPOverWebSocketError()` `0x0000` case
  for how `RTSPOverWebSocket` self-corrects `playSpeed` from it. For `401`, instead
  collects every `WWW-Authenticate` header line into `WWWAuthenticate: ParsedWwwAuthenticate[]` via
  `parseWWWAuthenticate`. Other status codes get no field parsing beyond the status line.
- `parseWWWAuthenticate(str)` — regex-extracts `Basic`/`Digest` scheme plus `realm=`, `nonce=`,
  `opaque=`, `algorithm=`, `qop=` from one `WWW-Authenticate` header value.

**Digest authentication and the interactive-retry redesign**

- `formDigestAuthHeader(uri)` — central auth-header builder, called both on the first automatic
  401 response and from `retryWithCredentials()`. Feeds the cached `wwwAuthenticate` text through
  `digestGenerator.getDigestInfoInWwwAuthenticate()`, assembles an `AuthenticateData` (`Method` =
  current state uppercased, `Uri` = URI-encoded `uri`, `username`/`password` = `id`/`pw`,
  `Realm`/`Nonce`/optionally `Qop`/`Algorithm`/`Opaque`). Two paths: (a) if a plain password is set
  and no `sunapiClient` is attached, computes `Authentication` directly via
  `digestGenerator.getAuthenticate(data)` and calls `SendUnauthorizedRtspCmd()`; (b) if a
  `sunapiClient` is attached, it instead round-trips through a SUNAPI digest-auth-info endpoint
  (`/stw-cgi/security.cgi?msubmenu=digestauth&action=view`) to obtain a pre-computed `response`
  value from the device itself, then calls `getAuthenticate(data, responseValue)` (skips local
  hashing) before `SendUnauthorizedRtspCmd()`. If neither a password nor a `sunapiClient` is
  available, reports error `0x0403` through the normal error callback (deliberately not thrown —
  this runs inside the async `SendRtspCommand` response callback, outside any caller's try/catch).
- `retryWithCredentials(username, password)` — **the redesigned no-reconnect 401 retry path.**
  Sets `id`/`pw` to the newly supplied credentials, resets `unahtuorizedCount = 0`, and re-invokes
  `formDigestAuthHeader(this.rtspUrl!)` — reusing the *same* cached `wwwAuthenticate` challenge
  (same realm/nonce) rather than reopening the WebSocket/RTSP session. This is the method that
  `StreamPlayer.retryAuthentication()` / `RTSPOverWebSocket.retryAuthentication()` call once a
  caller has collected a fresh password from the user (see Call Stack below).
- `RtspResponseHandler()`'s `401` branch (see below) increments `unahtuorizedCount` and only
  auto-retries once per connection — the *first* 401 on any connection is protocol-mandated (the
  client cannot know realm/nonce before being challenged), but a *second* 401 for the same
  challenge means the credentials were genuinely wrong. Rather than blindly resubmitting the
  same rejected credentials (each attempt counts toward the camera's own account-lockout
  threshold — the code comment notes this was confirmed to reach a live "490 Account block") or
  tearing the connection down, it reports error `0x0206` and **waits** for
  `retryWithCredentials()`.

**State machine driver**

- `SendUnauthorizedRtspCmd()` — re-issues whatever request corresponds to `currentState`
  (`OPTIONS`/`DESCRIBE`/`SETUP`/`PLAY`/`PAUSE`) with a freshly computed `Authentication` header,
  used after a digest header has just been (re)computed.
- `RtspResponseHandler(stringMessage)` — the single entry point for all RTSP response text
  (called from the `transport.SendRtspCommand` callback). Validates it's a string (else error
  `0x020F`), forwards raw text to the `rtsp` listener, checks the response `CSeq` against the
  client's own counter (mismatch → error `0x020F`, but processing continues) and increments
  `CSeq`. Parses via `parseRtspResponse`, updates `ContentBase` if present, and then branches on
  `ResponseCode`:
  - `401` → increments `unahtuorizedCount`, caches the raw `WWW-Authenticate` text into
    `wwwAuthenticate`; first occurrence auto-calls `formDigestAuthHeader`, second+ reports
    `0x0206` and stops (see above).
  - `200` → delegates to `handleResponse200()`.
  - `503` during `Setup` on a talk/backchannel track (`trackID=t`/`trackID=back`) → delegates to
    `handleResponse503Setup()` (talk-service-unavailable recovery: skip that track, continue
    SETUP or move to PLAY). Any other `503` → error `0x0201`.
  - `560` (max users) → error `0x0204`. `404` → error `0x0205`. `490` (account blocked) → error
    `0x020B`. Any other non-handled code → generic error `0x0203`.
  - Any branch other than a mid-flow `200` ends by calling `clearTransport()` if a transport
    exists — i.e., most non-success responses tear the connection down (the 401 case is the
    deliberate exception, per the redesign above).
  - A `checkRtspAlive`-flagged in-flight `GET_PARAMETER` liveness probe is handled first,
    independent of the normal state machine: `200` restarts both interval timers, anything else
    reports error `0x0209`.
- `handleResponse200(msg)` — the actual `Options → Describe → Setup → Play → Playing` state
  transitions:
  - `Options` → `Describe`: issues `DESCRIBE` with `Accept: application/sdp` (or `Require:
    Bestshot` if `bestshot` is set).
  - `Describe` → `Setup`: requires `SDPData` (else throws `RTSPOverWebSocketError` `0x0210`);
    classifies each SDP media session into a codec bucket (`JPEG`/`H264`/`H265`/`VP8`/`VP9`/`AV1`;
    `PCMU`/`PCMA`/`G726-*` — split further into talk-back tracks by `trackID=t`/`trackID=back` vs.
    normal audio; `MPEG4-GENERIC`; `OPUS`; `vnd.onvif.metadata`) and pushes an `SdpInfoEntry` per
    recognized track into `SDPinfo`; unrecognized codecs report error `0x0300` without adding a
    track. `VP8`/`VP9`/`AV1` are classified here purely so `RtpClient.sendSdpInfo` can build the
    matching depacketizer session (`VP8Session`/`VP9Session`/`AV1Session`, see
    `03-mediaSession-core-video.md`) — see that file's "Known gap" note on those sessions for what
    is (and isn't) wired up beyond depacketization. Issues
    the first `SETUP` with `Transport: RTP/AVP/TCP;unicast;interleaved=<n>-<n+1>` (interleave IDs
    are `2*setupSDPIndex` / `2*setupSDPIndex+1`) — re-authenticates against `ContentBase` first if
    it differs from `rtspUrl` and a challenge is cached.
  - `Setup` (repeated) → next `SETUP` for each remaining track, incrementing the interleave-ID
    pair each time; once all tracks are set up, calls `rtpClient.sendSdpInfo(SDPinfo)`, wires an
    `audioTalk` listener to `SendAudioTalkData` if a talk-back track was found, and issues `PLAY`
    (with mode-specific `Range`/`Scale`/`Rate-Control`/`BackupBandwidth` headers for
    `'playback'`/`'backup'`).
  - `Play` → `Playing`: starts the `GET_PARAMETER` keepalive interval and (mode-dependent) the
    alive-watchdog or playback-availability checker; marks `transport.autoconnection = true`;
    reports a synthetic success event (`errorCode: 0x0000`, `oldErrorCode: '200'`).
  - `Playing` (repeated 200s, e.g. from `PAUSE`/seek/`GET_PARAMETER` responses) → updates pause
    timers or reports seek-completion events depending on `isPausing`/`mode`.
  - `Pause` → `Playing` (resume) or, if a teardown was queued, `clearTransport()`.
  - Anything else (including `Playing` with `nextState === 'Teardown'`) → `clearTransport()`.
- `handleResponse503Setup()` — marks the failed track's interleave IDs as `-1`, advances past it,
  reports error `0x020A` ("Talk Service Unavilable" — string preserved from legacy), and continues
  SETUP for the next track or moves on to PLAY if that was the last one.

**Connection lifecycle**

- `Connect()` — lazily creates the `TransportLike` via `transportFactory(wsUrl)` if none exists,
  wires `channelId`/`autoconnection`, registers callbacks
  (`connectionCbFunc`/`RtpDataHandler`/`errorCallbackFunc`/`receivedBytesCallback`) via
  `transport.SetCallback(...)`, then calls `transport.Connect()`.
- `connectionCbFunc(type, statusObject)` — handles the transport's `'open'|'error'|'close'`
  events. On `'open'`: resets `CSeq = 1`, clears the RTSP queue, sets state back to
  `Options`→`Describe`, **resets `unahtuorizedCount = 0`** (documented as necessary so a stale
  count from a previous failed connection doesn't make the very first, protocol-mandatory 401 on
  the new connection look already-exhausted), and issues `OPTIONS`. On `'error'`/`'close'`:
  large branchy logic mapping websocket/backup states to specific `errorCode`s (`0x0601`/`0x0602`
  for backup end/error, `0x0005`/`0x0008`/`0x0001`/`0x0002` for various reconnect/refuse/normal-
  close cases) — see source for the exact matrix; not repeated here since it's pure error-code
  plumbing, not protocol structure.
- `Disconnect(response?)` — if connected and mid-session (`Playing`/`Pause`/`Setup`), issues
  `TEARDOWN` (server-visible graceful stop); otherwise calls `clearTransport()` directly. Always
  clears both interval timers and resets `unahtuorizedCount`/`SessionId`.
- `clearTransport()` — the actual teardown: issues a last `TEARDOWN` if still `Playing`, disconnects
  the transport (or just `init()`s it if not open), clears the RTSP queue, closes and drops
  `rtpClient`, clears both interval timers, and resets `isConnected`/`SDPinfo`/`Authentication`/
  `transport`/`currentState('Teardown')`/`nextState('Options')`/`CSeq`.
- `ControlStream(controlInfo)` — public API for playback control (`resume`/`seek`/`forward`/
  `backward`/`pause`/`speed`/`backup`), each mapping to a `PLAY` or `PAUSE` request with
  mode-specific `Scale`/`Range`/`Rate-Control`/`Immediate`/`Frames: intra` headers built via the
  `scaleHeaderOrDefault`/`rangeHeaderOrDefault`/`toStringExtensionScale` helpers.
- `RtpDataHandler(interleave, header, payload)` — forwards demuxed RTP bytes (received from
  `Transport` via the `rtpCbFunc` callback wired in `Connect()`) to `rtpClient.sendRtpData(...)`
  and marks the alive-watchdog's `isRTPRunning = true`.
- `getSessionId(interleavedId?)` — looks up an active `RtpSession`'s `sessionId` either by
  interleaved channel ID or by falling back through video → audio → meta session types; returns
  the sentinel `NO_SESSION = -1` if `rtpClient` or the session doesn't exist.

### Call Stack

**WebSocket connect → RTSP OPTIONS**

1. Caller (`StreamPlayer`) calls `rtspClient.Connect()`.
2. `Connect()` creates a `Transport` via `transportFactory`, wires callbacks, calls
   `transport.Connect()` → opens the underlying `WebSocket`.
3. `Transport.OnOpen` fires → invokes the `connectionCbFunc` passed to `SetCallback` →
   `RtspClient.connectionCbFunc('open', ...)`.
4. `connectionCbFunc` resets state/`CSeq`/`unahtuorizedCount`, calls `_request('OPTIONS', null,
   null)` → `_send()` → `CommandConstructor('OPTIONS', ...)` builds `OPTIONS <rtspUrl> RTSP/1.0` →
   `transport.SendRtspCommand(message, callback)`.

**DESCRIBE/SETUP/PLAY with a 401 → digest retry, then interactive retry**

```mermaid
sequenceDiagram
    participant App as Caller (StreamPlayer)
    participant RC as RtspClient
    participant TR as Transport
    participant Srv as RTSP server (over WS)

    App->>RC: Connect()
    RC->>TR: Connect()
    TR-->>RC: connectionCbFunc('open')
    RC->>TR: SendRtspCommand("OPTIONS ...")
    TR->>Srv: interleaved RTSP text
    Srv-->>TR: 200 OK
    TR-->>RC: RtspResponseHandler(200)
    RC->>RC: handleResponse200() -> DESCRIBE
    RC->>TR: SendRtspCommand("DESCRIBE ...")
    TR->>Srv: DESCRIBE
    Srv-->>TR: 401 Unauthorized\nWWW-Authenticate: Digest realm=... nonce=...
    TR-->>RC: RtspResponseHandler(401)
    RC->>RC: unahtuorizedCount++ (=1), cache wwwAuthenticate
    RC->>RC: formDigestAuthHeader(rtspUrl)
    RC->>RC: digestGenerator.getDigestInfoInWwwAuthenticate()
    RC->>RC: digestGenerator.getAuthenticate() -> Authorization header
    RC->>TR: SendRtspCommand("DESCRIBE ... Authorization: Digest ...")
    TR->>Srv: DESCRIBE (authenticated)
    alt wrong credentials
        Srv-->>TR: 401 Unauthorized (same challenge)
        TR-->>RC: RtspResponseHandler(401)
        RC->>RC: unahtuorizedCount++ (=2) -> report error 0x0206, wait
        Note over App,RC: caller prompts user for new credentials
        App->>RC: retryWithCredentials(username, password)
        RC->>RC: unahtuorizedCount = 0; formDigestAuthHeader(rtspUrl) again\n(same cached wwwAuthenticate, no reconnect)
        RC->>TR: SendRtspCommand("DESCRIBE ... Authorization: Digest ...")
        TR->>Srv: DESCRIBE (re-authenticated)
    end
    Srv-->>TR: 200 OK + SDP
    TR-->>RC: RtspResponseHandler(200)
    RC->>RC: handleResponse200() -> parseDescribeResponse, SDPinfo built -> SETUP
    RC->>TR: SendRtspCommand("SETUP <track> ... Transport: RTP/AVP/TCP;unicast;interleaved=0-1")
    Srv-->>TR: 200 OK (Session, Transport interleaved ids)
    TR-->>RC: RtspResponseHandler(200)
    RC->>RC: handleResponse200() -> SessionId set, next track or PLAY
    RC->>TR: SendRtspCommand("PLAY ... Session: <id>")
    Srv-->>TR: 200 OK
    TR-->>RC: RtspResponseHandler(200)
    RC->>RC: handleResponse200() -> currentState='Playing', keepalive timers start
    Srv-->>TR: interleaved RTP/RTCP binary frames
    TR-->>RC: RtpDataHandler(interleave, header, payload)
    RC->>App: rtpClient.sendRtpData(...)
```

**TEARDOWN**

1. Caller calls `rtspClient.Disconnect()`.
2. If mid-session, `_request('TEARDOWN', null, null)` jumps the queue ahead of any pending
   command and is sent immediately if nothing else is in flight.
3. Server responds `200 OK`; `RtspResponseHandler` → `handleResponse200()`'s fallback branch (not
   `Options`/`Describe`/`Setup`/`Play`/`Playing`(non-teardown)/`Pause`) calls `clearTransport()`.
4. `clearTransport()` disconnects the `Transport`, releases `rtpClient`, clears timers/queue, and
   resets state to `'Teardown'`/`'Options'`.

### RFC / Standard References

- **RTSP 1.0, not 2.0** — `CommandConstructor` hard-codes `' RTSP/1.0\r\n'` on every request line
  (`RtspClient.ts:335` etc.), so this implements **RFC 2326** (RTSP 1.0), not RFC 7826 (RTSP 2.0).
  Methods used: `OPTIONS`, `DESCRIBE`, `SETUP`, `PLAY`, `PAUSE`, `TEARDOWN`, `GET_PARAMETER`,
  `SET_PARAMETERS` — all RFC 2326 §10 methods. Headers constructed: `CSeq` (§12.17), `Session`
  (§12.37), `Transport` (§12.39, `RTP/AVP/TCP;unicast;interleaved=<n>-<n+1>` — TCP-interleaved
  transport per §10.12/§C.3), `Range` (§12.29, `npt=` and `clock=` sub-formats), `Scale` (§12.34),
  `RTP-Info` and `Content-Base` (§12.32/§12.15) are read from responses. `Require:
  www.onvif.org/ver20/backchannel` and `Require: onvif-replay`/`samsung-replay-timezone` are
  vendor/ONVIF extension `Require:` (§12.32) tokens, not core RFC 2326.
- **SDP body** parsed by `parseDescribeResponse` follows **RFC 4566** (SDP) field prefixes: `v=`,
  `o=`, `i=`, `c=`, `b=`, `m=`, `a=`. `a=rtpmap`/`a=fmtp`/`a=control` are RTSP/RTP-over-RTSP
  conventions from **RFC 2326 §C** and **RFC 3640** (RFC 3640 §4.1 defines the
  `sizelength`/`indexlength`/`indexdeltalength`/`config`/`mode`/`streamtype` fmtp parameters for
  MPEG-4 generic payloads, matched case-insensitively here since RFC 3640 doesn't mandate a
  specific case). H.264/H.265 SPS/PPS/VPS `fmtp` parameters (`sprop-parameter-sets`,
  `sprop-sps`/`sprop-pps`/`sprop-vps`) come from **RFC 6184** (H.264) and **RFC 7798** (H.265).
- **HTTP Digest authentication** — `formDigestAuthHeader`/`retryWithCredentials` build the
  `Authorization` header via `DigestGenerator` per **RFC 2617** (and, since `DigestGenerator`
  supports a SHA-256 branch, effectively **RFC 7616** — see the `DigestGenerator` section below).
  The challenge is read from the RTSP response's `WWW-Authenticate` header (RFC 2617 §3.2.1,
  reused verbatim by RTSP per RFC 2326 §22).
- **WebSocket transport framing** (RFC 6455) itself is `Transport`'s responsibility, not
  `RtspClient`'s — `RtspClient` only ever sees already-demuxed RTSP text or already-demuxed RTP
  bytes; see the `Transport` section.
- **Status codes**: `RtspResponseHandler` interprets `200`/`401`/`404`/`490`/`503`/`560` — `200`/
  `401`/`404` are standard RFC 2326 §11 codes; `490`, `503`, `560` are looked up via
  `RtspStatusCode` for human-readable name/description (see that section — `490`/`560` are
  vendor-defined extensions beyond RFC 2326, `503` is standard).

### Relations & Data Flow

```mermaid
classDiagram
    class StreamPlayer
    class RtspClient
    class Transport
    class DigestGenerator
    class RtpClient
    class SunapiClient

    StreamPlayer --> RtspClient : creates, calls Connect/Disconnect/ControlStream/retryAuthentication
    RtspClient --> Transport : creates via transportFactory
    RtspClient --> DigestGenerator : owns, uses for Authorization header
    RtspClient ..> RtpClient : sendSdpInfo/sendRtpData/getRtpSession* (set externally)
    RtspClient ..> SunapiClient : optional alt. digest-auth source (SetSunapiClient)
    Transport --> RtspClient : RtspResponseHandler(text) / RtpDataHandler(binary)
```

`StreamPlayer` (interface/StreamPlayer.ts) constructs `new RtspClient(transportFactory?)`,
immediately calls `SetSunapiClient(...)`, and later sets `rtspClient.rtpClient` once it has
created the corresponding `RtpClient`. `RtspClient` never imports `RtpClient`'s concrete type —
it only depends on the `RtpClientLike` structural interface, so `mediaSession/RtpClient` and
`network/rtspOverWebsocket/RtspClient` have no compile-time circular dependency despite the
tight runtime coupling. `retryAuthentication()` on the custom element and on `StreamPlayer` are
both one-line pass-throughs to `RtspClient.retryWithCredentials()`.

---

## `RtspClientManagerImpl` / `RtspClientManager` (`src/player/network/rtspOverWebsocket/RtspClientManager.ts`)

Ported from the legacy player's `Network/RTSPoverWebsocket/rtspClientManager`.

### Structure

- `RtspClientManagerImpl` (not exported) holds one field: `private readonly rtspClientList:
  RtspClient[] = []` — a flat array, **not** keyed by channel ID or any other identifier. Despite
  `src/player/README.md`'s class diagram annotating the manager's edge to `RtspClient` as "creates/
  tracks (per-channel registry)", the actual implementation has no per-channel indexing at all —
  it is simply a list of every `RtspClient` the manager has created, used only for membership
  removal and counting. That README annotation should be read loosely; this file is the source of
  truth.
- The module exports:
  ```ts
  export const RtspClientManager = {
    getInstance(): RtspClientManagerImpl {
      if (!rtspManagerInstance) {
        rtspManagerInstance = new RtspClientManagerImpl();
      }
      return rtspManagerInstance;
    }
  };
  ```
  i.e. a **lazily-initialized singleton accessed through `getInstance()`**, not a directly
  constructed `export const RtspClientManager = new RtspClientManagerImpl()`. (That direct-
  construction form is what the top-level `src/player/README.md` describes in prose — the code
  as written instead defers construction to first `getInstance()` call via a module-level
  `rtspManagerInstance` variable. Functionally equivalent as a singleton, but the exact shape
  differs from the README's description, so verify against this file if precision matters.)

### Method Analysis

- `createRtspClient(): typeof RtspClient` — constructs `new RtspClient()` (using `RtspClient`'s
  own default `transportFactory`, i.e. real `Transport`/`WebSocket`), pushes it onto
  `rtspClientList`, but **returns the `RtspClient` class/constructor itself, not the created
  instance** — a genuine legacy bug preserved verbatim. Since nothing in this codebase calls
  `RtspClientManager` at all (confirmed: no references to `RtspClientManager`/`RtspClientMgr`
  anywhere else in `src/player`, including in the legacy source this was ported from), the bug
  has never had an observed runtime effect. `StreamPlayer` constructs `RtspClient` instances
  directly instead of going through this manager.
- `deleteRtspClient(rtspClient: RtspClient): void` — removes one specific instance via
  `indexOf`/`splice`; no-op if not found.
- `getRtspClientCount(): number` — returns `rtspClientList.length`.

### Call Stack

Not exercised by any real call path in this codebase — `StreamPlayer` bypasses it entirely (see
`RtspClient`'s Relations & Data Flow above). Ported for completeness/parity with the legacy
source, not because it's load-bearing.

### RFC / Standard References

None — this class contains no protocol logic, only instance bookkeeping.

### Relations & Data Flow

```mermaid
classDiagram
    class RtspClientManagerImpl
    class RtspClient
    RtspClientManagerImpl --> RtspClient : creates (createRtspClient), tracks in a flat list
```

`RtspClientManagerImpl` is a dead-code path in the current architecture: `RtspClient` instances
in this library are always created directly by `StreamPlayer`, one per channel, with no manager
in between.

---

## `Transport` (`src/player/network/transport/Transport.ts`)

Ported from the legacy player's `Network/transport/transport`. This is the WebSocket transport:
it owns the actual `WebSocket`, and demultiplexes the single byte stream it carries into (a)
interleaved RTSP text responses and (b) binary RTP/RTCP frames, per RTSP's `$`-prefixed
interleaved-binary-data framing (RFC 2326 §10.12).

### Structure

- Public/settable fields: `websock: WebSocketLike | null`, `channelId?`, `readyState?`,
  `autoconnection?`, `index?`. A code comment notes these last four are **not** initialized in the
  constructor — they stay `undefined` until either `initializeWebsocket()` runs (only from inside
  `OnClose`) or a caller (`RtspClient.Connect()`) sets them explicitly right after construction;
  preserved as-is since real callers always set `channelId` immediately.
- Private callback slots set via `SetCallback(...)`: `rtspCallback`, `rtpCallback`,
  `connectionCallback`, `errorCallback`, `receivedCallback`; plus an internal one-shot
  `rtspResponseCallback` used per-command by `SendRtspCommand`.
- `fragmentedData: Uint8Array | null` — carries a partial frame across WebSocket message
  boundaries (a single logical RTSP/RTP frame can arrive split across multiple `onmessage` events,
  or multiple frames can arrive coalesced into one).
- `statisticsTimer: IntervalTimer | null` — 1-second bandwidth-reporting tick (`onStatisticsTimer`)
  started on open.
- `listeners: Map<...>` — a small custom `EventTarget`-like registry (`addEventListener`/
  `removeEventListener`/`dispatchEvent`) for `'rtsp'|'rtp'|'connected'|'disconnected'` events,
  dispatched alongside (not instead of) the direct callbacks.
- `constructor(private readonly serverAddr: string)`.
- Static constants: `Transport.OPEN = 1`, `Transport.CLOSED = 3` (mirroring the standard
  `WebSocket.readyState` values from the WHATWG/RFC 6455 API, hard-coded rather than referencing
  the global `WebSocket.OPEN`/`CLOSED` so tests can inject a fake socket without a real
  `WebSocket` constant).
- `createWebSocket(serverAddr)` is `protected` and overridable — the seam tests use to inject a
  fake socket (mirrors `RtspClient`'s `transportFactory` pattern).

### Method Analysis

- `Connect()` — if no socket exists yet, creates one via `createWebSocket(serverAddr)`, sets
  `binaryType = 'arraybuffer'`, and wires `onopen`/`onmessage`/`onclose`. Wraps failures in
  `RTSPOverWebSocketError` (`0x0002`).
- `Disconnect()` — closes the socket if present; wraps failures in `RTSPOverWebSocketError`
  (`0x0003`).
- `SendRtspCommand(sendMessage, response?)` — refuses to send if another command's response
  callback is still pending (returns the error `'Another command is processing'` to the *caller's*
  callback rather than sending) — this is what makes `RtspClient`'s queue-and-wait discipline
  necessary in the first place, since `Transport` itself only supports one in-flight RTSP
  request/response pair at a time. Otherwise, if the socket is `OPEN`, sends the string via
  `stringToUint8Array` and stashes `response` as the pending `rtspResponseCallback` to be resolved
  by the next matching RTSP response text seen in `OnReceive`.
- `SendRtpData(data)` — raw pass-through `websock.send(data)` when open; legacy's corresponding
  error-throw-on-closed branch referenced an undefined variable (a pre-existing `ReferenceError`
  immediately swallowed by an empty catch), so this port reproduces the net effect — silent no-op
  — directly instead of throw-then-swallow.
- `OnReceive(event)` — the demux core. Accumulates `event.data` onto any carried-over
  `fragmentedData`, then:
  1. If the buffer starts with ASCII `RTSP` (an RTSP status-line), locates the header/body
     boundary via `indexOfMulti(byteData, [CR, LF, CR, LF])` (i.e., the blank line terminating
     headers), decodes that header block as text, and if a `Content-Length:` header is present,
     appends exactly that many more bytes as the body. If the declared content isn't fully
     buffered yet, stashes the whole thing as `fragmentedData` and returns (wait for more data).
     Otherwise dispatches the assembled RTSP text to `rtspCallback` and, if a `SendRtspCommand`
     response is pending, resolves it (`rtspResponseCallback(rtspData)`, then clears it) — and
     fires a `'rtsp'` `TransportEvent`. Any remaining bytes after the RTSP message continue to be
     processed as binary RTP/RTCP data in the same pass.
  2. If (what remains of) the buffer starts with `MAGIC_NUMBER = 0x24` (`'$'`), loops extracting
     interleaved binary frames per RFC 2326 §10.12: 4-byte header (`$`, 1-byte channel id, 2-byte
     big-endian length — `RTSP_INTERLEAVE_LENGTH = 4`), then treats the next `RTP_HEADER_LENGTH =
     12` bytes as the RTP fixed header (RFC 3550 §5.1) and the remaining `length - 12` bytes as
     the RTP/RTCP payload, invoking `rtpCallback(interleave, header, payload)` and firing a
     `'rtp'` event for each frame. If a full frame isn't yet buffered, stashes the remainder as
     `fragmentedData` and stops. If an interleaved RTP frame is immediately followed by more RTSP
     text (mid-stream, e.g. a response arriving between RTP packets), that text is parsed the same
     way as step 1, inline, before continuing the interleaved-frame loop.
  3. If the buffer starts with neither `RTSP` nor `$`, reports error `0x0200` ("Invalid RTSP/RTP
     data in the channel") and discards `fragmentedData`.
  4. Catches `RTCPError` silently (a recognized-but-ignorable per-packet parse issue) and reports
     other errors (`RTSPOverWebSocketError`-shaped or not) through `errorCallback`, resolving any
     pending `rtspResponseCallback` with the error if it was an `RTSPError`.
- `OnOpen(message)` — fires the `'open'` connection callback, records `readyState`, wires
  `onclose`/`onerror` (deferred until now — not set in `Connect()` — so they don't fire on a
  socket that's still connecting), starts the statistics timer, and dispatches a `'connected'`
  event.
- `OnClose(event)` / `OnError(event)` — both normalize `event.code` (with a special-cased
  legacy quirk for close code `12592`, see `WebsocketStatusCode` below), wrap it in
  `WebsocketStatusCode`, dispatch a `'disconnected'` event, and (in `OnClose` only) route to the
  `'close'` connection callback for codes `1000`/`1001` (normal/going-away — also clears
  `autoconnection`) or `'error'` for anything else. `OnClose` also stops the statistics timer,
  closes the socket, and — if `autoconnection` is set — schedules a reconnect via `setTimeout(()
  => this.Connect(), 500)`; if not auto-reconnecting, resets all transport state via
  `initializeWebsocket()` in a `finally` block.
- `onStatisticsTimer()` — reports bytes-received-per-second (`current`/`total`, in bits — note
  the `* 8` conversion) through `receivedCallback`, then resets the per-tick counter.
- `init()` — detaches all four socket event handlers without closing the socket (used by
  `initializeWebsocket()` and by `RtspClient.clearTransport()`'s non-open branch).
- `close()` — closes the socket directly if open (distinct from `Disconnect()`, which also wraps
  errors — `close()` is the quieter variant used elsewhere).

### Call Stack

**WebSocket connect**

1. `RtspClient.Connect()` → `transport.Connect()`.
2. `Connect()` → `createWebSocket(serverAddr)` → real `new WebSocket(serverAddr)` (or a test
   fake), `binaryType = 'arraybuffer'`, `onopen = OnOpen`, `onmessage = OnReceive`, `onclose =
   OnClose`.
3. Browser fires the socket's native `open` event → `OnOpen(message)` → `connectionCallback('open',
   message)` → (wired by `RtspClient.Connect()`'s `SetCallback` call) `RtspClient.connectionCbFunc('open', ...)`.

**Interleaved RTSP response demux**

1. Server sends bytes over the WebSocket → browser fires `message` → `OnReceive(event)`.
2. `OnReceive` detects the `RTSP` prefix, isolates the header block via the `\r\n\r\n` marker,
   reads `Content-Length` to know how much body to wait for.
3. Once complete, calls `rtspCallback(rtspData)` (wired to `RtspClient.RtspResponseHandler` is
   *not* how this actually connects — `RtspClient.Connect()` passes `null` as `rtspCbFunc` to
   `SetCallback`; the real per-command response instead flows through the one-shot
   `rtspResponseCallback` set by `SendRtspCommand`, which is exactly the `response` callback
   `RtspClient._send()` passed in). Fires the `'rtsp'` `TransportEvent` for any additional
   listeners.

**Interleaved RTP demux**

1. `OnReceive` detects the `$` (`0x24`) prefix, reads the 2-byte big-endian length, splits off the
   4-byte interleave header / 12-byte RTP header / remaining payload.
2. Calls `rtpCallback(interleave, header, payload)` → (wired by `RtspClient.Connect()`) →
   `RtspClient.RtpDataHandler(interleave, header, payload)` → `rtpClient.sendRtpData(...)`.

### RFC / Standard References

- **RFC 6455 (WebSocket Protocol)** — `Transport` owns the `WebSocket` object itself
  (`binaryType = 'arraybuffer'`, `send()`, `close()`, `readyState`/`onopen`/`onmessage`/`onclose`/
  `onerror`), and `WebsocketStatusCode` (see below) interprets WebSocket close codes per RFC 6455
  §7.4.1.
- **RFC 2326 §10.12 (Embedded (Interleaved) Binary Data)** — the `$` (`0x24`) magic byte, 1-byte
  channel identifier, and 2-byte big-endian length field that `OnReceive` parses out of
  `byteData[index+2]<<8 | byteData[index+3]` is exactly this framing. This is how RTSP multiplexes
  RTP/RTCP packets and RTSP control messages onto the *same* transport connection — here, that
  single transport connection is itself the WebSocket, so the framing is doubly nested: WebSocket
  frames carry raw bytes, which in turn carry RTSP's own interleaved `$`-framing for RTP/RTCP.
  Plain RTSP text responses (the `RTSP/1.0 ...` status-line branch) are not `$`-framed — they are
  the "normal" RTSP-over-the-wire text, just carried inside a WebSocket binary message instead of
  a raw TCP stream.
- **RFC 3550 §5.1 (RTP Fixed Header)** — the `RTP_HEADER_LENGTH = 12` constant splitting `header`
  from `payload` in the interleaved-frame loop corresponds to RTP's fixed 12-byte header (before
  any CSRC list); `Transport` itself does not parse the header fields, it only slices the bytes —
  parsing is left to `mediaSession`'s per-codec `RtpSession` classes.

### Relations & Data Flow

```mermaid
classDiagram
    class RtspClient
    class Transport
    class WebSocket
    RtspClient --> Transport : creates via transportFactory, calls Connect/Disconnect/SendRtspCommand
    Transport --> WebSocket : creates via createWebSocket()
    Transport --> RtspClient : RtpDataHandler(binary) / SendRtspCommand response callback (text)
```

`Transport` is intentionally protocol-agnostic about RTSP *semantics* — it only knows the
interleaved-framing envelope, not what a `DESCRIBE`/`SETUP`/`PLAY` request means. All RTSP
state-machine logic lives one layer up, in `RtspClient`.

---

## `SunapiClient` (`src/player/network/http/SunapiClient.ts`)

Ported from the legacy player's `Network/http/sunapiClient`. A synchronous-or-async digest-auth
`XMLHttpRequest` wrapper for SUNAPI (Wisenet camera/NVR HTTP control-plane) requests — a
completely separate wire path from the RTSP-over-WebSocket stream, used for device metadata
(profiles, snapshots, recording search, etc.) and, per `RtspClient.formDigestAuthHeader`, also as
an alternate source of RTSP digest-auth response values for camera-mode devices.

### Structure

- `restClientConfig: SunapiRestClientConfig` — `clientVersion` (hard-coded `'1.00_20160404'`),
  `serverType` (`'camera'|'grunt'`), `cors`, `proxy`, `basic: {username,password}`, `digest:
  {hostname, port, protocol, rtspPort, ClientIPAddress, username, password, timeout}`, `oauth:
  {username}`.
- `authInfo: DigestCache | null | undefined` and `authCount` — the per-instance cached digest
  challenge (`scheme`/`realm`/`nonce`/`opaque`/`qop`/`nc`/`cnonce`) and 401-retry counter.
- `xhrFactory: XhrFactory` — injectable, defaults to `() => new XMLHttpRequest()`; the test
  seam for this class.
- Constructor validates `deviceInfo` heavily and **throws** (`RTSPOverWebSocketError` or
  `AuthError`) for a `'camera'` `serverType` missing `cameraIp`/`user`/`password`, or any
  `serverType` missing `password`. Resolves the digest config's `hostname`/`port`/`protocol` from
  `window.location` for `'camera'`, or from `deviceInfo`/`window.location` (proxy-dependent) for
  `'grunt'` — but only when `window.location.protocol` is actually `http:`/`https:` (see the
  chrome-extension-host fix below); for any other page scheme it falls back to `deviceInfo`'s own
  `hostname`/`port`/`protocol` instead, since there's no such origin/proxy to borrow from.
- **Chrome-extension-host fix** (deviates from a straight legacy port, unlike this file's other
  documented "preserved as-is" legacy quirks): legacy unconditionally borrowed
  `window.location.hostname`/`port`/`protocol` for the `'camera'` branch, and for `'grunt'` +
  `proxy: true`. That's a reasonable default when the embedding page is itself http(s) — e.g. a
  same-origin reverse proxy in front of the device — but breaks when it isn't, concretely when
  `<rtsp-over-websocket>` is embedded in a Chrome extension page (`window.location.protocol` is
  `"chrome-extension:"`, which is never a valid protocol/host to reach a SUNAPI device on and
  produces a `chrome-extension://invalid/`-style unresolvable request). Both borrowing branches
  are now gated on `window.location.protocol` being `http:`/`https:`; otherwise they use
  `deviceInfo`'s own values (already correctly resolved upstream — see `SunapiManager.init()`'s
  matching fix). Same root cause and fix shape in `SunapiManager.init()` and
  `SunapiRestClient`'s device-config setup below.
- Not exported as extending anything; implements no interface. Confirmed-unreachable legacy
  methods (`mobile(...)`, `clearDigestCache()`, `DetectBrowser()`, `checkStaleResponseIssue()`)
  are dropped — they existed on the legacy object literal but were never attached to its
  prototype, so no caller could reach them.

### Method Analysis

- `get(uri, jsonData?, successFn, failFn, scope?, isAsyncCall?, isText?, withoutSeqId?)` — URI-
  encodes `uri`, appends `jsonData` as a `&key=value` query string via `jsonToText`, and (unless
  `withoutSeqId` or the URI targets `attributes.cgi`) appends a `&SunapiSeqId=<timestamp>` cache-
  buster for any `.cgi` endpoint. Dispatches to `ajaxAsync` (if the URI contains `configbackup` or
  `isAsyncCall`) or `ajaxSync` otherwise.
- `post(uri, jsonData?, successFn, failFn, scope?, fileData, specialHeaders?)` — always async
  (`ajaxAsync`); appends `jsonData` the same way.
- `send(...)` (private, shared by both) — builds the initial `XMLHttpRequest` via
  `makeNewRequest`, wires progress/complete/cancel/error callbacks for async calls, then sets
  `onreadystatechange` to branch on `xhr.status` once `DONE`:
  - `490` → `handleAccountBlock` (fails immediately with the HTTP reason phrase looked up in
    `HTTP_STATUS_CODES`).
  - `401` → increments `authCount`; if `< 2`, re-reads `WWW-Authenticate` from the response,
    rebuilds a request via `makeNewRequest` (now with that challenge, computing a real digest
    `Authorization` header) and re-sends; if `>= 2`, fails with the status's reason phrase and
    resets `authCount`.
  - `200` → `parseResponse` if a non-empty body, else fails with `{Code:-1, message:'No
    response'}`.
  - default → fails with `{Code: xhr.status, message: HTTP_STATUS_CODES[status]}`.
  - `ontimeout` fails with `408`/`'Request Time-out'`.
- `makeNewRequest(method, uri, isAsync, wwwAuthenticate, isText, existingXhr?)` — opens the XHR
  against `protocol://hostname[:port] + uri`, sets `XClient: XMLHttpRequest` (CORS marker) and
  `Accept: application/json` (unless `isText`), refreshes `authInfo` from a passed
  `wwwAuthenticate` string if given, and — if cached `authInfo.scheme === 'Digest'` — delegates to
  `setDigestHeader`.
- `setDigestHeader(xhr, method, uri, digestCache)` — for `digest`/`xdigest` schemes, increments
  `nc`, regenerates `cnonce`, and sets `Authorization: <scheme> username="..." realm="..." nonce="..."
  uri="..." cnonce="..." nc=<8-hex> qop=<qop> response="<hash>"` via `buildDigestAuthHeader`. For
  `basic`, sets `Authorization: Basic <base64(user:pass)>`. With no cache yet (first request, no
  prior challenge), builds a fresh `{scheme:'Digest', qop:'auth', nc:null, cnonce:null, ...}` and
  sends that (its `nc` renders as `00000000` since it's never incremented in this branch — a
  preserved legacy quirk, since this first request is expected to 401 and get properly retried
  anyway).
- `formulateResponse(username, password, uri, realm, method, nonce, nc, cnonce, qop)` — computes
  `HA1 = MD5(username:realm:password)`, `HA2 = MD5(method:uri)`, `response =
  MD5(HA1:nonce:nc(8-hex):cnonce:qop:HA2)`. **Always MD5** — unlike `DigestGenerator` (used by
  `RtspClient`), this SUNAPI-specific implementation has no SHA-256 branch.
- `getAuthInfoInWwwAuthenticate(wwwAuthenticate)` — parses a comma-split `WWW-Authenticate` value
  for `realm`/`nonce`/`opaque`/`qop`, generates a fresh `cnonce`, and **initializes `nc = 0`** (not
  `1`) — the code comment explains this was deliberately changed from a prior version that
  pre-incremented to `1` here (making the first authenticated attempt send `nc=00000002`), because
  at least one real Wisenet camera firmware rejects that as invalid and re-challenges instead of
  authenticating; `setDigestHeader` increments to `1` right before building the first real request,
  so the wire value ends up `nc=00000001` as RFC 2617 expects.
- `parseResponse(xhr, successFn, failFn, isText?)` — for `blob`/`arraybuffer`/XML responses or
  `isText`, resolves with the raw response. Otherwise parses JSON, or (if not valid JSON) falls
  back to `getDotEqualStrLineToObj` (NVR line-based `a.b.c=value` responses, nested by `.`-split
  keys). A parsed `{Response: 'Fail', Error: {Code, Details}}` shape is routed to `failFn` instead
  of `successFn`.
- `setTimeout(timeout)` / `getAuthInfo()` — the only other reachable prototype methods; simple
  accessors.
- `seedAuthInfo(cache)` — **new, not a legacy port**: shallow-copies a `DigestCache` (realm/nonce/
  opaque/qop/nc/cnonce) obtained by a *previous* `SunapiClient` instance into `this.authInfo`
  before the first request goes out. Exists purely so `SunapiManager.init()` (which discards and
  recreates its `SunapiClient` on every call) can seed a fresh instance with the last-known-good
  challenge instead of always starting from `authInfo: null`. With a seeded challenge,
  `makeNewRequest()`'s existing `authInfo.scheme === 'Digest'` check is satisfied on the very
  first attempt, so it sends a real `Authorization` header immediately (via the same
  `setDigestHeader` path a 401 retry would otherwise take) instead of the unauthenticated probe.
  If the seeded nonce is stale/rejected, `send()`'s ordinary `case 401` path fires exactly as it
  would for an unseeded instance — this method changes nothing about failure handling, only which
  attempt (the 1st vs. the usual 2nd) carries valid credentials.

### Call Stack

**SUNAPI GET with digest 401 retry**

```mermaid
sequenceDiagram
    participant App as Caller (SunapiManager / RtspClient.formDigestAuthHeader)
    participant SC as SunapiClient
    participant Dev as Camera/NVR (SUNAPI HTTP)

    App->>SC: get(uri, data, successFn, failFn, ...)
    SC->>SC: makeNewRequest() (no cached authInfo yet)
    SC->>Dev: GET uri (Authorization: Digest ... nc=00000000, fresh/unauthenticated)
    Dev-->>SC: 401 Unauthorized, WWW-Authenticate: Digest realm=... nonce=...
    SC->>SC: authCount++ (=1)
    SC->>SC: makeNewRequest(..., wwwAuthenticate) -> getAuthInfoInWwwAuthenticate() caches nonce/realm, nc=0
    SC->>SC: setDigestHeader() -> nc=1, formulateResponse() (MD5 HA1/HA2/response)
    SC->>Dev: GET uri (Authorization: Digest ... nc=00000001, response=<hash>)
    Dev-->>SC: 200 OK
    SC->>SC: parseResponse()
    SC-->>App: successFn({data})
```

Each of the two real `GET`s above is a distinct cross-origin `XMLHttpRequest.send()` with a
different non-CORS-safelisted header set (`XClient`+`Accept` on the first, plus `Authorization` on
the retry), so a browser sends its own OPTIONS preflight ahead of *each* one — two preflights and
two GETs for what the caller sees as a single logical request. That doubling is unavoidable for a
`SunapiClient` instance with no prior challenge, but `SunapiManager.init()` used to hit it on
*every* call (it always constructs a fresh `SunapiClient`, discarding any nonce the previous call
had already obtained) — see `SunapiManager.init()`'s Method Analysis below for the
`seedAuthInfo()`-based fix, which collapses this to one preflight + one `GET` whenever the seeded
nonce is still accepted.

### RFC / Standard References

- **HTTP/1.1 (RFC 7230-7235)** — this is a standard `XMLHttpRequest`-based REST client;
  `Accept`, `Authorization`, `WWW-Authenticate`, `Content-Type`/response parsing follow HTTP
  semantics (RFC 7231) and authentication framework (RFC 7235).
- **HTTP Digest Authentication (RFC 2617)** — `formulateResponse`/`setDigestHeader` implement the
  `auth` qop response formula (`response = MD5(HA1:nonce:nc:cnonce:qop:HA2)`), always MD5 (no
  SHA-256/RFC 7616 support here, unlike `DigestGenerator`). `nc` is sent as an 8-hex-digit counter
  per RFC 2617 §3.2.2.
- **HTTP status codes**: `401` (RFC 7235 §3.1), `200` (RFC 7231 §6.3.1), `408` (RFC 7231 §6.5.7);
  `490` is a SUNAPI-specific vendor extension code (account-block), looked up via
  `HTTP_STATUS_CODES` (see that section) rather than any IETF-standard code.

### Relations & Data Flow

```mermaid
classDiagram
    class SunapiManager
    class SunapiClient
    class RtspClient
    class XMLHttpRequest

    SunapiManager --> SunapiClient : creates (init())
    RtspClient ..> SunapiClient : optional alt. digest-auth source (SetSunapiClient)
    SunapiClient --> XMLHttpRequest : creates via xhrFactory
```

`SunapiClient` is a parallel path to the RTSP-over-WebSocket stream: it talks directly to the
device's SUNAPI HTTP endpoints (over regular HTTP/HTTPS, via `XMLHttpRequest`, not the WebSocket)
independent of whatever `RtspClient`/`Transport` are doing for the media stream itself. The two
paths intersect only at `RtspClient.formDigestAuthHeader()`'s optional `sunapiClient` branch,
where a `SunapiClient`-like object (or, in the actual app wiring, `SunapiManager`'s underlying
client) can supply a device-computed digest response for the *RTSP* challenge instead of
`RtspClient` computing it itself via `DigestGenerator`.

---

## `SunapiManager` (`src/player/network/http/SunapiManager.ts`)

Ported from the legacy player's `Network/http/sunapiManager` — a thin promise-wrapping facade
over `SunapiClient`, exposing one method per SUNAPI endpoint.

### Structure

- `_sunapiClient: SunapiClientLike | null` — exposed via both a `sunapiClient` getter/setter pair
  and `getSunapiClient()`/`attach()`/`dettach()` (legacy naming, including the misspelling,
  preserved).
- `device: SunapiManagerDeviceInfo` — defaults (`ClientIPAddress: '127.0.0.1'`, `port: 80`,
  `deviceType: 'nvr'`, `timeout: 10`, `debug: true`, `async: false`, protocol derived from
  `window.location.protocol`), overwritten wholesale by `init(info)`.
- URI-building constant tables: `CGI` (endpoint file names), `SUBMENU` (`msubmenu=` values),
  `ACTION` (only `ACTION.VIEW` is actually used — the rest are `void`-referenced to document
  they're intentionally unused rather than dead accidentally), `PARAMS`. A `URI` table exists but
  is confirmed unused within this file (also `void`-referenced) — ported for completeness.
- The legacy `useSunapiClient` flag (always hard-coded `true`, never reassigned) gated a second,
  unreachable `sunapiRestClient`-backed branch — dropped; `init()` always constructs a
  `SunapiClient`.
- `static digestCache: Map<string, DigestCache>` — **new, not a legacy port**: digest challenges
  (realm/nonce/etc., see `SunapiClient`'s `DigestCache`) that survive across `init()` calls,
  keyed by `digestCacheKey(info)` (`protocol://host:port@user`, `host` preferring `hostname` then
  falling back to `cameraIp`). Static rather than per-instance because the cached challenge
  belongs to the device/credential pair, not to whichever `SunapiManager` happened to authenticate
  first. See `init()` below for how it's read/written, and `SunapiClient`'s Call Stack section for
  *why* this exists (the CORS-preflight-doubling consequence of a fresh, unseeded digest
  handshake).

### Method Analysis

- `init(info)` — stores `device`, normalizes `protocol` from `window.location` **only when that
  page protocol is `http:`/`https:`** (chrome-extension-host fix, see below — for any other page
  scheme, `info.device.protocol` is left as whatever the caller already resolved), remaps
  `hostname`/`username` from `cameraIp`/`user` for non-`'nvr'` device types, constructs `new
  SunapiClient(device)`, and calls `sunapiClient.get('/stw-cgi/attributes.cgi', ...)` to fetch
  device capability attributes, wrapping any error as a `SunapiError`. (A legacy quirk that
  unconditionally reset `_sunapiClient` right before an `if (!this._sunapiClient)` "already
  initialized" check is dropped since that branch was permanently unreachable.)
- **Digest-cache seeding (new, not a legacy port)**: right after building `digestCacheKey(device)`
  (post-normalization, so it sees the already-resolved `hostname`), `init()` looks up
  `SunapiManager.digestCache` for that key and, if found, calls the new `SunapiClient` instance's
  `seedAuthInfo()` with it *before* issuing `attributes.cgi`'s GET. On that GET's success, the
  now-current `sunapiClient.getAuthInfo()` (whatever challenge ended up working — the seeded one,
  or a fresh one obtained via a 401 if the seed was stale) is written back to the cache under the
  same key; on failure, the entry is deleted instead, so a bad/expired seed doesn't get retried
  forever. Net effect: only the *first-ever* `init()` for a given device (or the first one after a
  failure) pays the full unauthenticated-probe → 401 → retry round trip (see `SunapiClient`'s Call
  Stack section); every `init()` after a successful one for the same device sends `Authorization`
  preemptively and, if the camera still accepts that nonce, completes in one `GET` behind one
  CORS preflight instead of two of each.
- **Chrome-extension-host fix** (deviates from a straight legacy port, unlike this file's other
  documented "preserved as-is" legacy quirks): legacy always synced `device.protocol` to
  `window.location.protocol` whenever they differed — fine for a normal http(s) tab, but for
  `<rtsp-over-websocket>` embedded in a Chrome extension page, `window.location.protocol` is
  `"chrome-extension:"`, which isn't a valid protocol to reach a SUNAPI device on. Worse, by the
  time `init()` runs, `RTSPOverWebSocket.updateSunapiManager()` has *already* resolved the correct
  `device.protocol` from the element's `secure`/`https` attribute — so the unconditional sync was
  clobbering an already-correct value with the literal string `"chrome-extension"`, producing SUNAPI
  requests against an unresolvable `chrome-extension://<host>/...` URL (Chrome's
  `net::ERR_FAILED`/`chrome-extension://invalid/` fallback). The sync now only fires when
  `window.location.protocol` is `http:`/`https:`; behavior for a normal http(s) host is unchanged.
  Same root cause and fix shape in `SunapiClient`'s constructor and `SunapiRestClient`'s
  device-config setup (see those sections).
- `getAttributes()`, `getDeviceInfo()`, `getClientIp()`, `getTimezoneInfo()`, `getDateInfo()`,
  `getSystemProfileAccessInfo()`, `getVideoSource()`, `getVideoProfileAll()`/`getVideoProfile()`,
  `getVideoProfilePolicyAll()`/`getVideoProfilePolicy()`, `getRtspStreamURL()` — each builds one
  `/stw-cgi/<cgi>?msubmenu=<x>&action=view[...]` URI and delegates to the shared private
  `request()` helper, optionally extracting a sub-field (`data.VideoProfiles`, etc.) from the
  response. **`getAttributes()` specifically** hits `/stw-cgi/attributes.cgi/attributes`, which
  real devices answer with **XML**, not JSON (`SunapiClient.parseResponse()` hands back the raw
  response text unparsed whenever `xhr.responseXML !== null` — see that class's section above) —
  `SunapiManager` itself does nothing further with it. `XmlParser`/`AttributeService` (new sections
  immediately below) exist specifically to parse that XML into structured capability data, ported
  from `react-wisenet-player`'s legacy jQuery-based equivalents, but as of this writing neither is
  wired into `SunapiManager`/`Player.tsx` yet — `getAttributes()`'s return value is still raw XML
  text to any current caller.
- `getSnapshot(profile?, channel?)` — builds `/stw-cgi/video.cgi?msubmenu=snapshot&action=view`
  with validated numeric `Profile`/`Channel` query params (throwing `RTSPOverWebSocketError`
  `0x0409` for non-integer input — note a copy-paste bug preserved from legacy where the
  `channel`-validation branch's error message still says "Invalid profile number"). A preserved
  legacy bug: if the response's `data.size === 0` (or `data` is undefined), the promise is never
  resolved *or* rejected — it hangs unless some other timeout/error path fires.
- `getSessionKey()`, `getStorageInfo()`, `getRecordingSetup()`, `getSearchRecordingPeriod()`,
  `getCalendarSearch()`, `getOverlappedIdList()`, `getTimeline()`, `getAITimeline()` — plain
  `request()` calls, same shape as every other method here. **Fixed** (was a confirmed real bug):
  these eight used to also pass `joinAfterGet: true`, which (see below) made them functionally
  broken — always rejecting regardless of whether the device actually responded successfully.
  Initially ported faithfully (matching a real legacy bug), then actually fixed once a real
  consumer hit it — `getOverlappedIdList` succeeding against a real device (valid
  `OverlappedIDList` JSON back) but still surfacing as a failure — by removing the `join()` call
  and the `joinAfterGet` option entirely; see `SunapiManager`'s class-level doc comment for the
  full story.
- `request<T>(buildUri, place, opts)` (private) — the shared executor: builds the URI *inside* the
  `Promise` executor (matching legacy — so a validation throw inside `buildUri`, e.g.
  `getOverlappedIdList`'s missing-date check, rejects the promise rather than throwing
  synchronously to the caller), then calls `sunapiClient.get(...)`. No longer has a
  `joinAfterGet`-gated `sunapiClient.join()` call after it (see above) — `SunapiClient` never had a
  `join()` method (its only prototype methods are `get`/`post`/`setTimeout`/`getAuthInfo`), so that
  call always threw synchronously and rejected the promise via the surrounding `try/catch`'s
  `RTSPOverWebSocketError` (`0x0700`), independent of whatever the in-flight `get()` call was
  actually doing.
- `buildTimelineUri(...)` (private) — shared URI builder for `getTimeline`/`getAITimeline`,
  including camera-specific date reformatting (`T`/`Z` stripped from ISO timestamps) and
  `Type`/`ClassType` query parameters.

### Call Stack

**SUNAPI REST GET** (every `request()`-backed method, including the previously-broken
`getSessionKey()`/`getStorageInfo()`/`getRecordingSetup()`/`getSearchRecordingPeriod()`/
`getCalendarSearch()`/`getOverlappedIdList()`/`getTimeline()`/`getAITimeline()` — see Method
Analysis above for why those eight used to take a different, always-rejecting path)

1. Caller (e.g. `<rtsp-over-websocket>`'s demo/device-info UI) calls `sunapiManager.getDeviceInfo()`.
2. `getDeviceInfo()` → `request(() => '/stw-cgi/system.cgi?msubmenu=deviceinfo&action=view',
   'getDeviceInfo')`.
3. `request()` builds the URI, calls `this._sunapiClient!.get(uri, {}, resolve-wrapper,
   reject-wrapper, '', async)`.
4. `SunapiClient.get()` → `ajaxSync`/`ajaxAsync` → `send()` → XHR request/response cycle
   (including any digest 401 retry — see `SunapiClient`'s Call Stack above) → `successFn(response)`.
5. `request()`'s success wrapper calls `unwrapResponse(response)` (unwraps a `{data: ...}`
   envelope if present) and resolves the promise (optionally through `opts.extract`).
4. The surrounding `try/catch` in `request()`'s executor catches this and calls `reject(new
   RTSPOverWebSocketError({errorCode: 0x0700, ...}))` — the promise rejects immediately,
   regardless of what the in-flight `get()` call eventually does.

### RFC / Standard References

Same HTTP/1.1 (RFC 7230-7235) and SUNAPI-vendor-extension status codes as `SunapiClient` — this
class adds no protocol logic of its own beyond URI construction; all wire behavior is
`SunapiClient`'s.

### Relations & Data Flow

```mermaid
classDiagram
    class RTSPOverWebSocket
    class SunapiManager
    class SunapiClient
    class SunapiException

    RTSPOverWebSocket --> SunapiManager : creates
    SunapiManager --> SunapiClient : creates (init())
    SunapiManager --> SunapiException : throws (date-param validation)
```

`SunapiManager` is constructed directly by the `<rtsp-over-websocket>` custom element
(`_sunapiMng = new SunapiManager()`) as a sibling facility to the RTSP stream, not something
`StreamPlayer`/`RtspClient` depend on for playback itself.

---

## `XmlParser` (`src/player/network/http/XmlParser.ts`)

Ported from the legacy player's `sunapi/XmlParser` — pure XML-string-in/JS-value-out parsing, no
network calls of its own. Parses two distinct SUNAPI response shapes: the "CGI section"
(`GET /stw-cgi/attributes.cgi/cgis` — a schema describing every CGI/submenu/action/parameter and
its expected data type) and the "attribute section" (`GET /stw-cgi/attributes.cgi/attributes` —
the device's actual capability-flag *values*, optionally split per channel).

### Structure

- No network/DOM-registration side effects — a plain class, one instance per `AttributeService`
  (see below), constructed with no arguments.
- **Cache fields**: `cgiSectionXML`/`parsedCgiSection` and `attributeSectionXML`/
  `parsedAttributeSection` — the last-parsed XML string and its `DOMParser`-parsed `Document`, so a
  repeated call with the same input string skips re-parsing. `parseAttributeSection` and
  `parseAttributeSectionByChannel` intentionally share the same attribute-section cache fields
  (via a shared `getAttributeSectionDoc()` helper), matching legacy's module-level-closure
  behavior where both functions read/wrote the same two variables — a call to either method can
  serve as the other's cache hit.
- Legacy was built on jQuery (`$.parseXML` + `.find()`/`.filter()`/`.attr()`/`.children()`/
  `.each()`/`.not()`). This port drops jQuery entirely for native `DOMParser` +
  `Element.querySelector`/`querySelectorAll` — legacy's attribute-name selectors (e.g.
  `"cgi[name='x']"`) are valid CSS attribute selectors and translate directly, no behavior change.

### Method Analysis

- `parseCgiSection(iXML, inputStr, options?)` — `inputStr` is a `/`-delimited path
  (`cginame/submenu/action/parameter/datatype`, `cginame/submenu/parameter/datatype`,
  `submenu/parameter/datatype`, or `parameter/datatype` — token count selects which), walked
  against the parsed `<cgi>/<submenu>/<action>/<parameter>` tree. Returns a shape depending on the
  parameter's declared `dataType`: `string` → `{minLength?, maxLength?, formatInfo?, format?}`,
  `int`/`float` → `{minValue?, maxValue?}`, `enum`/`csv` → an array of `<entry value="...">` values,
  `bool` → `true`. `options.parseRequest` additionally reads the node's own `request` attribute
  into `.isRequest`.
- `parseAttributeSectionByChannel(iXML, inputStr, maxChannel)` — `inputStr` is
  `groupName/categoryName/.../attrName`; walks to that `<group>/<category>`, then either a single
  `<attribute>` (no `<channel>` children — result is a length-1 array) or one entry per
  `<channel number="N">` (result indexed by channel number).
- `parseAttributeSection(iXML, inputStr)` — same path convention (1-3 tokens:
  `attributeName`, `categoryName/attributeName`, or `groupName/categoryName/attributeName`) for a
  single attribute value, no per-channel split. Value coercion (both methods, shared private
  `stringToJsonAttributes`): `type="bool"` → `value === 'True'`; `type="int"` → `parseInt`;
  `type="enum"`/`"csv"` → `value.split(',')`; anything else → `undefined`.

### RFC / Standard References

None — SUNAPI is a Hanwha-vendor HTTP/XML API, not an IETF/W3C standard. `DOMParser`/
`Element.querySelector` are standard Web APIs, used here in their ordinary documented way.

### Relations & Data Flow

```mermaid
classDiagram
    class XmlParser
    class AttributeService
    AttributeService --> XmlParser : creates, calls per attribute/CGI-parameter lookup
```

Consumed only by `AttributeService` (below) as of this writing — not called directly by
`SunapiManager`/`Player.tsx`/`RTSPOverWebSocket.ts`.

---

## `AttributeService` (`src/player/network/http/AttributeService.ts`)

Ported from the legacy player's `sunapi/AttributeService` — a capability-flags service that
fetches a device's `/stw-cgi/attributes.cgi/attributes` (and `/cgis`) XML once, then derives a
large capability-flag bag (`MaxChannel`, `PTZSupport`, `IRLedSupportByChannel`, ...) from it via
~250 `XmlParser.parseAttributeSection`/`parseAttributeSectionByChannel` calls, plus ~17
`parse*CgiAttributes` methods deriving finer-grained per-CGI option/limit metadata from the
`/cgis` schema. See the class's own top-of-file doc comment for the full, itemized list of what
was preserved vs. fixed vs. deliberately not ported during the port — summarized here rather than
duplicated in full.

### Structure

- Constructed with a `SunapiClientLike` (this repo's real `SunapiClient.get()` signature,
  structurally declared rather than importing the concrete class — matching `SunapiManager.ts`'s
  own pattern) and an `AttributeServiceOptions` (currently just `isAdmin?: () => boolean`, default
  `() => true` — legacy's Angular-`AccountService`-backed admin check, adapted to an injectable
  predicate since this library has no session/account layer of its own).
- `private xmlParser = new XmlParser()` — one instance per service.
- `attributes` getter (and legacy-named `getAttributes()` method) exposes the internal capability
  bag, typed `Record<string, any>` — a deliberate, narrow exception to this codebase's usual
  `unknown`-by-default convention: ~250+ dynamically-shaped flags (bool/number/string[]/nested
  object, chosen per XML path at runtime) have no practical 1:1 TypeScript interface, and every
  legacy consumer read them the same untyped way.

### Method Analysis

- `getDeviceInfo()`/`getWebHiddenInfo()`/`getAiVersionInfo()`/`getEventSourceOptions()` — each one
  REST call (`/stw-cgi/system.cgi`/`eventsources.cgi`), populating a handful of top-level flags
  directly from the JSON response (no XML/`XmlParser` involvement).
- `getAttributeSection()` — the large one: fetches `/stw-cgi/attributes.cgi/attributes` once, then
  runs the ~250 `XmlParser.parseAttributeSection`/`parseAttributeSectionByChannel` calls against
  that single response to populate the capability bag. Ported near-verbatim from legacy path-for-
  path, for confidence that a port this large didn't silently change which flag reads which XML
  path.
- `getCgiSection()` + the 17 `parse*CgiAttributes()` methods (`parseSystemCgiAttributes`,
  `parseMediaCgiAttributes`, `parseSecurityCgiAttributes`, `parseEventSourceCgiAttributes`,
  `parsePTZCgiAttributes`, ... — one per SUNAPI CGI group) — fetch `/stw-cgi/attributes.cgi/cgis`
  and derive parameter-level option/limit metadata via the private `paserXML()` helper.
  **`paserXML()` is a from-scratch fix, not a straight port**: legacy's own `paserXML` was an
  unconditional self-recursive stub (`function paserXML(obj, target) { return paserXML(obj,
  target); }`, reassigned nowhere) that stack-overflows the instant any of these ~2800 lines
  actually runs — confirmed via grep that `xmlParser.parseCgiSection` (the method every call site's
  arguments unambiguously match) was never called anywhere in the legacy source either. This port's
  `private paserXML(...)` delegates to `this.xmlParser.parseCgiSection(...)` instead, the same
  judgment call `SunapiManager.ts` applied to its own confirmed-broken `sunapiClient.join()` chain.
- `initialize()` — `Promise.all(...)` of the fetch methods above, gated on `options.isAdmin()` for
  admin-only ones. Fixed during porting: legacy pushed bare `this.getPTZModeInfo`/
  `this.getCropChannelOptions` function *references* into the list instead of invoking them, so
  those two fetches silently never ran.
- `getAppStatus()` — fixed during porting: legacy's success callback called
  `deferred.resolve(appStatus)` where `deferred` was never declared (a `ReferenceError` at
  runtime there; a compile error here) — corrected to the executor's own `resolve`.
- `login()`/`loginBypass()`/`checkInitPw()` — **not ported**: built entirely on Angular
  app-shell services (`$location`, `$state`, `$q`, session/language/account managers) with no
  reachable equivalent in this pure network/protocol library, which already owns its own
  device-connection entry point via `SunapiManager.init()`.
- Every XHR success callback's `try { ...; resolve(x); } catch { throw new
  RTSPOverWebSocketError(...) }` pattern (~30 call sites) is **preserved, not fixed**: because the
  callback runs asynchronously (invoked later by the XHR handler, not synchronously inside the
  `new Promise(executor)` call), the `throw` doesn't reject the promise — it becomes an uncaught
  exception, and the promise is left permanently pending. Same category of bug `SunapiManager.ts`
  documents preserving in its own `getSnapshot()`; left as-is here rather than guessed at across
  ~30 near-identical sites with no real device available to verify intended behavior against.

### RFC / Standard References

None beyond what `SunapiClient`/`XmlParser` already provide — this class adds no protocol logic
of its own, only capability-flag derivation from their responses.

### Relations & Data Flow

```mermaid
classDiagram
    class AttributeService
    class SunapiClient
    class XmlParser
    class ProfileConfig

    AttributeService --> SunapiClient : uses (constructor-injected)
    AttributeService --> XmlParser : creates, parses attribute/CGI XML
    AttributeService ..> ProfileConfig : (no current reference — see ProfileConfig section)
```

Not yet constructed/called by `SunapiManager`, `Player.tsx`, or `RTSPOverWebSocket.ts` — wiring
this capability layer into the live connection flow is deliberate follow-up work, not part of this
port.

---

## `ProfileConfig` (`src/player/network/http/ProfileConfig.ts`)

Ported from the legacy player's `sunapi/ProfileConfig` — a small, static lookup table (`DIS`/
`DPTZ`/`DEFAULT`/`MULTI`, each `{ index: number }`) mapping named video-profile *kinds* to their
index. Logic unchanged from legacy, only typed (`ProfileConfigEntry`/`ProfileConfigTable`). No
current reference from `AttributeService`/`SunapiManager`/`Player.tsx` — ported for parity/
completeness alongside the other two files, not because something already needs it.

---

## `SunapiRestClient` (`src/player/network/http/SunapiRestClient.ts`)

Ported from the legacy player's `Network/http/sunapiRestClient` — a digest-auth REST client with
the *same* `get`/`post` public surface as `SunapiClient`, but implemented by delegating each
request to a dedicated Web Worker instead of an in-thread `XMLHttpRequest`.

### Structure

- `deviceConfig: SunapiDeviceConfig` — same shape of fields as `SunapiClient`'s digest config
  (`serverType`, `hostname`, `port`, `protocol`, `rtspPort`, `ClientIPAddress`, `username`,
  `password`, `timeout?`).
- `authInfo: Record<string, unknown> | undefined` — populated from `'auth'`-tagged worker
  messages, carried forward into subsequent requests.
- `promiseMode = true` (`readonly`, never toggled — `join()` is effectively always a no-op given
  this).
- `worker?: Worker`, `promise?: Promise<void>` — recreated per request via
  `createSunapiRequestWorker()`, which does `new Worker(new URL('../../worker/sunapi/
  sunapiRequestTask.ts', import.meta.url))`.
- **Confirms the "runs off the main thread" design point**: unlike `SunapiClient` (constructs and
  drives `XMLHttpRequest` directly on the calling thread), every `SunapiRestClient` request spins
  up a fresh dedicated `Worker` running `worker/sunapi/sunapiRequestTask.ts`, posts a message
  describing the request, and waits for that worker to post back a result — the actual HTTP
  request (and any digest-auth XHR retry logic) executes inside that worker, not here. That
  worker module is documented separately (by the `worker/` documentation); this class is only the
  main-thread-side proxy that talks to it.

### Method Analysis

- `init(deviceInfo)` — validates required fields per `serverType` (`hostname` for `'nvr'`,
  `cameraIp` for `'camera'`; `username`/`user` accordingly; `password` always required), throwing
  `RTSPOverWebSocketError` (`0x0400`-`0x0403`) otherwise, then copies validated/normalized values
  into `deviceConfig` (protocol derived from `window.location.protocol` **only when that page
  protocol is `http:`/`https:`** — chrome-extension-host fix, same root cause and shape as
  `SunapiManager.init()`'s and `SunapiClient`'s constructor's, see `SunapiManager`'s section for
  the full story. `SunapiInitDeviceInfo` carries no `protocol` field of its own to fall back to
  here, unlike those two, so the non-http(s) fallback is this class's own `'http'` default rather
  than a caller-supplied value). This class is confirmed unreachable from the live app today (see
  Relations & Data Flow below), so this is a correctness fix for its public-API surface rather than
  something that changes current runtime behavior.
- `get(uri, jsonData, successFn, failFn, scope, isAsyncCall, isText)` /
  `post(uri, jsonData, successFn, failFn, scope, fileData, specialHeaders)` — store
  `successFn`/`failFn` on the instance, then call `sendGet`/`sendPost`.
- `sendGet(...)` / `sendPost(...)` (private) — assemble a plain-data message (`{async, deviceInfo:
  deviceConfig, method:'get'|'post', uri, body, scope, isText/file/header, auth: authInfo,
  promise: promiseMode}`), create a fresh worker via `createSunapiRequestWorker()`, start
  `runWorkerRequest(worker)`, and `postMessage(data)` to it.
- `runWorkerRequest(worker)` (private) — returns a `Promise<void>` that resolves once the worker
  posts back a non-`'auth'` message: `'auth'`-tagged messages update `authInfo` and keep waiting;
  any other message is treated as the final result — `data.success && data.id === 'response'`
  calls `successFn(data.response)`, anything else calls `errorFn(data)` — then resolves and
  terminates the worker. `worker.onerror` is a silent no-op (legacy logged only).
- `join()` — since `promiseMode` is always `true`, this always no-ops (the `if (!this.promiseMode)
  return` short-circuit before it ever matters); `Promise.resolve(this.promise)` is also a no-op
  in effect (its result is discarded). Unlike `SunapiClient` (which has *no* `join()` at all —
  `SunapiManager` used to call it anyway via a since-fixed `joinAfterGet` bug, see that section),
  `SunapiRestClient.join()` exists and is safe to call — but nothing in this class's own callers
  actually depends on it doing anything.
- `toQueryString(json)` — public wrapper around the private `jsonToText` (same `&key=value`
  builder as `SunapiClient`), exposed for parity testing.
- `setTimeout(timeout)` — sets `deviceConfig.timeout`.

### Call Stack

**SUNAPI GET via worker**

1. Caller calls `sunapiRestClient.get(uri, jsonData, successFn, failFn, scope, isAsyncCall,
   isText)`.
2. `get()` stores the callbacks, calls `sendGet(...)`.
3. `sendGet()` builds the message payload, creates a `Worker` for `sunapiRequestTask.ts`, starts
   `runWorkerRequest(worker)` (which installs `worker.onmessage`), and `postMessage`s the request
   data into the worker.
4. Inside the worker (documented separately): it performs the actual digest-auth HTTP request
   against the device, `postMessage`s back an `{id:'auth', auth}` update if it obtains fresh
   digest-challenge info, and finally an `{id:'response', success, response}` (or an error-shaped
   message) once the HTTP request completes.
5. `runWorkerRequest`'s `onmessage` handler on the main thread receives that final message, calls
   `successFn`/`errorFn` accordingly, resolves the internal promise, and terminates the worker.

### RFC / Standard References

Same HTTP/1.1 + digest-auth references as `SunapiClient` apply to the request performed *inside*
the worker (not visible in this file) — this class itself contains no HTTP or digest logic; it is
purely a `postMessage`-based RPC proxy.

### Relations & Data Flow

```mermaid
classDiagram
    class SunapiRestClient
    class Worker
    class SunapiRequestTask

    SunapiRestClient --> Worker : creates per request (sunapi/sunapiRequestTask.ts)
    Worker ..> SunapiRequestTask : owns (documented under worker/)
```

`SunapiRestClient` is not constructed by `SunapiManager` in this codebase (`SunapiManager.init()`
always constructs a `SunapiClient`, per the dropped-dead-`useSunapiClient`-flag note above) — it
exists as a parallel, worker-backed implementation of the same `get`/`post` surface, intended for
callers that want the HTTP request work off the main thread. Its counterpart on the worker side,
`SunapiRequestTask` (constructed inside `worker/sunapi/sunapiRequestTask.ts`'s `onmessage` shim),
is documented in the `worker/` reference doc.

---

## `SunapiException` (`src/player/network/http/SunapiException.ts`)

A minimal, standalone exception shape used by `SunapiManager` for a few parameter-validation
failures (`getOverlappedIdList`/`getTimeline`/`getAITimeline` throw `new SunapiException()` when
required date parameters are missing).

- **Structure**: two optional fields, `name?: string` and `message?: string` (both unset by every
  current throw site — always constructed with no arguments), plus `toString(): string` returning
  `` `[${name || 'unknown'}] ${message || 'no description'}` ``.
- **Not part of the `RTSPOverWebSocketBaseError` hierarchy** — confirmed via
  `src/player/README.md`'s exceptions diagram and by this file's own definition: it does not
  `extends` anything, has no `errorCode`/`place` fields the way `RTSPOverWebSocketError` and
  siblings do. It's a distinct, legacy-shaped error type carried over as-is.
- **RFC references**: none — it's an internal parameter-validation signal, not a protocol error.
- **Relations**: thrown only by `SunapiManager` (see that section); not otherwise referenced by
  any class in this document.

---

## `HTTP_STATUS_CODES` (`src/player/network/http/HttpStatusCode.ts`)

A single exported `Record<string, string>` mapping numeric HTTP status codes (as string keys,
`'100'`–`'607'`) to their reason phrases. Covers the standard IANA-registered HTTP status codes
(RFC 7231/7235/6585/etc. — `100 Continue` through `511 Network Authentication Required`) plus a
number of **non-standard/vendor codes** specific to this device family's SUNAPI protocol:
`218 This is fine`, `420 Method Failure`, `440 Login Time-out`, `449 Retry With`, `450 Blocked by
Windows Parental Controls`, `490 Maximum account rearched` [sic], `498 Invalid Token`, `499 Token
Required`, `509 Bandwidth Limit Exceeded`, `530 Site is frozen`, `598 Network read timeout error`,
and the SUNAPI-specific `600`–`607` range (`600 Submenu Not Found`, `606 Invalid Parameter`, `607
Unknown Error`).

Consulted by: `SunapiClient.handleAccountBlock()` and its `send()`'s default/timeout error
branches (looks up a human-readable message for `xhr.status`), and `SunapiManager.init()`'s
reject-wrapper (same purpose for the `attributes.cgi` bootstrap call). Not consulted by
`RtspClient`/`Transport` — those are RTSP-status-coded, not HTTP-status-coded (see
`RtspStatusCode` below), except insofar as SUNAPI's own HTTP layer reuses HTTP semantics for its
`401`/`490` responses.

---

## `RtspStatusCode` (`src/player/network/RtspStatusCode.ts`)

Ported from the legacy player's `Network/rtspStatusCode`. An immutable lookup class:
`new RtspStatusCode(code)` resolves `code` against a `STATUS_TABLE` (keyed by name, e.g.
`Unauthorized`, `AccountBlocked`) indexed a second time `BY_VALUE` (numeric code → entry),
falling back to `Unknown` (`value: -1`) for unrecognized codes. Exposes `getStatusCode()`,
`getName()`, `getDescription()`, `getObject()`.

Covers standard **RFC 2326 §11** RTSP response codes (`100 Continue`, `200 OK`, `250 Low on
Storage Space`, the `3xx` redirection codes, `4xx` client-error codes through `463 Key management
Failure`, `5xx` server-error codes through `551 Option not supported`), plus vendor extensions
specific to this device family: `490 Account Blocked`, `560 Maximum user Reached for HTW NVR
Device`, and `702 Invalid Request Search Time`.

A doc comment notes a legacy quirk in how the original assigned `Constructor.prototype.status`
inside a per-call factory function rather than `this.status` — verified here to *not* actually be
a cross-instance state-sharing bug (each call creates its own fresh `Constructor`), just an
unusual authoring style; the TypeScript port uses a normal `private readonly status` field
instead, with equivalent behavior.

**Consulted by**: `RtspClient.RtspResponseHandler()` for every non-`200`/non-`401` response code
it reports through the error callback (`503`, `560`, `404`, `490`, and the generic fallback), to
attach a human-readable `rtspCode`/`name`/`description` to the resulting `RtspClientErrorEvent`.

---

## `WebsocketStatusCode` (`src/player/network/WebsocketStatusCode.ts`)

Ported from the legacy player's `Network/websocketStatusCode`. Same shape as `RtspStatusCode`:
`new WebsocketStatusCode(code)` resolves via `resolveStatus()`, which range-checks into
`Reserved_*` buckets (`<=999`, `1016-1999`, `2000-2999`, `3000-3999`, `4000-4999` per the RFC 6455
§7.4.2 reserved-range structure) or exact-matches one of the defined 1000-1015 codes, falling back
to `Unknown` (`-1`).

Covers the full **RFC 6455 §7.4.1** defined close-code set (`1000 Normal Closure` through `1015
TLS Handshake`), the §7.4.2 reserved ranges, and one non-standard entry: `12592 Host was closed
the websocket` — a vendor/legacy-protocol code, paired with `Transport`'s `hex2AsciiForCloseCode`
quirk-handling (`Transport.OnClose`/`OnError` special-case `event.code === 12592` by decoding a
hex-ASCII string out of the close reason to recover the "real" numeric code the device meant).

A doc comment notes a fixed legacy bug: the original's `case 1004:` branch read a misspelled key
(`StatusCode.Reserved1004`, missing underscore) that resolved to `undefined`, crashing on that
code; this port maps `1004` to its intended `Reserved_1004` entry instead of reproducing the
crash — a deliberate correction, not a preserved quirk, on the judgment that this was an
unintentional typo rather than meaningful behavior.

**Consulted by**: `Transport.OnClose()`/`OnError()`, which wrap the raw WebSocket close/error code
in a `WebsocketStatusCode` before dispatching `'disconnected'` events and choosing the `'close'`
vs. `'error'` connection-callback branch (`RtspClient.connectionCbFunc`).

---

## `DigestGenerator` (`src/player/util/DigestGenerator.ts`)

Ported from the legacy player's `Util/digestGenerator`. This is the digest-auth engine
`RtspClient` uses to answer RTSP `401` challenges — a separate implementation from
`SunapiClient`'s own inline digest logic (the two are not shared code, despite computing a
structurally similar hash).

### Structure

- `nc = 0` (nonce-count, incremented by `generateClientNonce()`), `cnonce: string` (client nonce,
  8 random alphanumeric characters, regenerated on construction and every
  `generateClientNonce()` call), `authenticateData: AuthenticateData | null` (the last data set
  via `getAuthenticate()`, reused by `Digest()`).
- `AuthenticateData` shape: `username`, `Realm`, `password`, `Method` (uppercased HTTP/RTSP
  method, e.g. `'DESCRIBE'`), `Uri`, `Nonce`, and optional `Qop`/`Algorithm`/`Opaque`.
- `ParsedWwwAuthenticate` shape: `method`, `realm`, `nonce`, `opaque`, `algorithm`, `qop` (all
  `string | null`).
- No inheritance; standalone utility class, `new`-constructed once per `RtspClient` instance
  (`readonly digestGenerator = new DigestGenerator()`).

### Method Analysis

- `digestSchema(type, str)` — `type === 'MD5' ? CryptoJS.MD5(str) : CryptoJS.SHA256(str)`
  (`.toString()`-hex-encoded). The only two supported hash algorithms.
- `generateClientNonce()` — regenerates `cnonce` (8 random chars from `A-Za-z0-9`) and increments
  `nc`.
- `Digest()` — computes the actual response hash from `this.authenticateData`:
  1. `type = data.Algorithm === 'MD5' || data.Algorithm == null ? 'MD5' : 'SHA256'` — MD5 is the
     default and the explicit-`'MD5'` case; *any other* non-null `Algorithm` value (including,
     notably, `'MD5-sess'`, which RFC 2617 defines as a variant of MD5, not a request for SHA-256)
     is treated as a request for SHA-256. This is a real code behavior worth knowing if a server
     ever sends `algorithm="MD5-sess"` — it would be computed as SHA-256 here, which is not RFC
     2617-conformant for that specific algorithm value, but no server encountered in this
     codebase's usage has been observed to send it.
  2. `HA1 = digestSchema(type, "username:Realm:password")`.
  3. `HA2 = digestSchema(type, "Method:decodeURIComponent(Uri)")`.
  4. `generateClientNonce()` is called (regenerating `cnonce`/incrementing `nc` as a side effect
     of computing the digest, not before it).
  5. If `Qop`, `Algorithm`, *and* `Opaque` are **all** non-null/non-undefined: `response =
     digestSchema(type, "HA1:Nonce:nc(8-hex):cnonce:Qop:HA2")` (the RFC 2617 `qop="auth"` formula)
     — note the three-way `Qop && Algorithm && Opaque` gate means a server offering `qop` without
     also sending `algorithm`/`opaque` falls through to the simpler formula below instead, which
     is stricter than RFC 2617 technically requires (RFC 2617 only requires `qop` presence to pick
     the qop-formula). A `console.log('input string:', input)` debug line is fired unconditionally
     in this branch (not gated behind any debug flag — the one place in this network layer where a
     console call was *not* dropped as pure observability, since it was left un-stripped from the
     legacy source verbatim; note if auditing for stray logging).
  6. Otherwise: `response = digestSchema(type, "HA1:Nonce:HA2")` (the RFC 2069/legacy-compatible
     formula without qop).
- `getAuthenticate(data?, response?)` — sets `authenticateData` if `data` is given, computes
  `responseValue` via `Digest()` unless an explicit `response` was passed (the
  `SunapiClient`-sourced-response path in `RtspClient.formDigestAuthHeader()` uses this to skip
  local hashing entirely). Builds the literal header text: `Authorization: Digest
  username="...", realm="...", uri="...", nonce="..."` and, only if `Qop`/`Algorithm`/`Opaque` are
  all present, appends `algorithm="...", opaque="...", nc="<8-hex>", cnonce="...", qop="..."`,
  always finishing with `, response="<hash>"\r\n`.
- `getDigestInfoInWwwAuthenticate(wwwAuthenticate)` — splits the cached raw header text on line
  breaks and parses each line via `parseWWWAuthenticate` (handles a `WWW-Authenticate` value that
  may span multiple challenge lines, e.g. one `Basic` and one `Digest` offer).
- `parseWWWAuthenticate(str)` — extracts `method` (`Basic`/`Digest`/else `'Unknown'`, checked via
  `.some()` so it stops at the first match) and `realm=`/`nonce=`/`opaque=`/`algorithm=`/`qop=`
  quoted-value fields via regex + `substr`/`split('"')`.

### Call Stack

See `RtspClient`'s Call Stack section above for the full DESCRIBE → 401 → digest-retry sequence.
Narrowly, within that flow:

1. `RtspClient.formDigestAuthHeader(uri)` calls
   `digestGenerator.getDigestInfoInWwwAuthenticate(wwwAuthenticate)` to parse the cached
   `WWW-Authenticate` text into one or more `ParsedWwwAuthenticate` entries, and folds the last
   one with a `qop`+`algorithm`+`opaque` triple into the outgoing `AuthenticateData`.
2. `formDigestAuthHeader` calls `digestGenerator.getAuthenticate(data)` (no explicit `response` —
   local computation path).
3. `getAuthenticate` calls `Digest()`, which computes `HA1`/`HA2`/`response` as above and (as a
   side effect) advances `nc`/`cnonce`.
4. `getAuthenticate` returns the full `Authorization: Digest ...` header text, assigned to
   `RtspClient.Authentication`, which `CommandConstructor` then splices verbatim into the next
   RTSP request's headers.

### RFC / Standard References

- **RFC 2617 (HTTP Digest Access Authentication)** — the core `HA1`/`HA2`/`response` formulas
  implemented in `Digest()` match RFC 2617 §3.2.2.1's MD5 digest computation exactly (`HA1 =
  H(username:realm:password)`, `HA2 = H(method:digest-uri)`, and, with `qop="auth"`, `response =
  H(HA1:nonce:nonceCount:cnonce:qop:HA2)`; without `qop`, the simpler RFC 2069-style `response =
  H(HA1:nonce:HA2)`). The `Authorization` header fields constructed by `getAuthenticate()`
  (`username`, `realm`, `uri`, `nonce`, `algorithm`, `opaque`, `nc`, `cnonce`, `qop`, `response`)
  are exactly RFC 2617 §3.2.2's `Authorization` header field set. `WWW-Authenticate` parsing
  (`parseWWWAuthenticate`) reads RFC 2617 §3.2.1's challenge fields.
- **RFC 7616 (HTTP Digest Access Authentication, obsoletes RFC 2617)** — `digestSchema`'s SHA-256
  branch is this class's one point of divergence from plain RFC 2617 (which only defines MD5):
  RFC 7616 §6.1 formally adds `SHA-256`/`SHA-512-256` as selectable digest algorithms via the
  `algorithm` challenge parameter, which is what `Digest()`'s `type` selection is approximating —
  though, as noted above, its `!== 'MD5'` catch-all is broader than RFC 7616's `algorithm` value
  set (e.g. it would also treat an unrecognized/malformed algorithm string as "use SHA-256").
- **RTSP's reuse of HTTP auth (RFC 2326 §22)** — RTSP explicitly reuses HTTP's `WWW-Authenticate`/
  `Authorization` header mechanics rather than defining its own, which is why an HTTP-auth class
  written against RFC 2617 directly plugs into `RtspClient`'s RTSP request construction with no
  RTSP-specific adaptation needed.

### Relations & Data Flow

```mermaid
classDiagram
    class RtspClient
    class DigestGenerator
    class SunapiClient

    RtspClient --> DigestGenerator : owns, computes Authorization header
    SunapiClient ..> DigestGenerator : no dependency (parallel, separate MD5-only digest logic)
```

`DigestGenerator` is used exclusively by `RtspClient` for the RTSP-over-WebSocket digest-auth
cycle. `SunapiClient` (SUNAPI HTTP) does **not** use this class — it has its own private
`formulateResponse()` implementing the same RFC 2617 formula independently, MD5-only, with no
SHA-256 path. The two are functionally parallel but structurally unrelated code.
