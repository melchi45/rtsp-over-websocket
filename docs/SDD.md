# Software Design Description — `src/player` Classes

*An IEEE 1016-style Software Design Description (SDD) covering every class defined in `src/player` — structure,
responsibilities, public interface, and design notes, one entry per class.*

**Version:** 1.1.0 · **Author:** Youngho Kim · **Milestone:** —

**History**

| Date | Change |
| --- | --- |
| 2026-08-06 | Document the `src` attribute and 401 retry redesign (initial version) |
| 2026-08-26 | Added Title/Abstract/Version/Author/History metadata header |
| 2026-08-26 | Point `VideoTagPlayer`'s entry at the new box-level MP4 container generation doc |
| 2026-08-26 | Note the PO Token/`deno`/`mweb`-client YouTube fetch changes (`e9a7e70`) as out of this document's scope |

---

An IEEE 1016-style Software Design Description (SDD) covering every class defined in `src/player`
(97 classes across 63 files). This is the class-level companion to
[README.md](../src/player/README.md) (which gives the same inventory as inheritance/composition
diagrams) and [DESIGN.md](DESIGN.md) (which covers state machines, protocols, and algorithms) —
start there for the big picture; use this document to look up one class's contract in detail.

**Out of scope**: this document covers `src/player` classes only. Server-side changes — such as the YouTube
PO Token provider (`bgutil-ytdlp-pot-provider`) and `deno` JS-runtime setup that `src/server/services/
transcodeSession.ts` now depends on to fetch modern YouTube videos without a `403` (commit `e9a7e70`) — touch no
`src/player` class and are intentionally not documented here. See `CLAUDE.md`'s "Environment gotchas" section,
`README.md`'s "External tools" section, and `MEMORY.md`'s `yt-dlp-po-token-provider-final-fix` entry for the
full install/decision history instead.

## How to read an entry

Each class gets a fixed set of fields:

- **File / Type** — where it lives and whether it's a concrete class, abstract class, or a
  same-file helper class that isn't separately exported.
- **Purpose** — why the class exists, in product/design terms.
- **Responsibilities** — what it actually does, grounded in the real implementation (not an
  aspirational description).
- **Structure** — its place in the inheritance graph (`Extends`/`Implements`) and its immediate
  collaborators (`Subordinates`: what it creates/uses; `Used by`: confirmed real callers, found by
  grepping the codebase — not guessed. Where a class turned out to be currently unreferenced or
  dead code, that is stated explicitly rather than omitted).
- **Public interface** — the members an external caller would actually use.
- **Key data** — notable stateful fields (not an exhaustive field dump).
- **Design notes** *(only present when there's something non-obvious)* — preserved legacy quirks,
  confirmed bugs kept intentionally for parity, invariants, or protocol-specific gotchas.

Sections mirror README.md's subsystem grouping so the two documents can be cross-referenced
directly:

1. [elements / interface / exceptions / network](#1-elements--interface--exceptions--network)
2. [mediaSession](#2-mediasession)
3. [video/player & listen](#3-videoplayer--listen)
4. [talk / backup / worker](#4-talk--backup--worker)
5. [util](#5-util)

## 1. elements / interface / exceptions / network

### `RTSPOverWebSocket`

**File:** `src/player/elements/RTSPOverWebSocket.ts`
**Type:** Class (custom element)

**Purpose**
The public, top-level API of the library: a `<rtsp-over-websocket>` custom element (`customElements.define('rtsp-over-websocket', RTSPOverWebSocket)`) that a host page drops into the DOM, configures via HTML attributes/JS properties, and drives with `play()`/`pause()`/`stop()`/etc. It owns the video/canvas surface, the on-screen statistics/network/context-menu overlays, and translates DOM attribute changes and internal player callbacks into `CustomEvent`s the host page can listen for.

**Responsibilities**
- Tracks ~50 attribute-backed properties (`hostname`, `channel`, `profile`, `username`, `password`, `mode`, `width`/`height`, `statistics`, `network`, `bestshotfilter`, `GMT`, `playSpeed`, etc.) via `attributeChangedCallback`/property accessors, keeping an internal `StreamPlayerInfo` (`this.info`) in sync with them.
- On `connectedCallback()`, reads all initial attributes, builds the `info.device`/`info.media` config, and (if an `id` attribute is present) triggers the DOM overlay build (`updateRendering()`).
- Owns playback control: `play()`, `stop()`, `pause()`, `resume()`, `speed()`, `forward()`, `backward()`, `seeking()` compute RTSP `rangeClock`/`scale` parameters (camera vs. NVR, GMT-aware) and forward a `control()` call to a lazily-created `StreamPlayer` (`this.player`); `backup()`/`startBackup()`/`endBackup()` do the same against a second, independent `StreamPlayer` (`this.backupplayer`).
- Owns audio control: `mute()`, `unmute()`, `isMute()`, `getAudioVolume()`, `setAudioVolume()`, `talk()`.
- Receives all `StreamPlayer`/`RtspClient`/`MediaRouter` callbacks (wired up in the constructor's `info.callback` object) through a family of `onRTSPOverWebSocket*` handler methods (error, resize, meta, metaImage, statistics, timestamp, videoMode, step, capture, instantplayback, backup, recv, close, status) and re-dispatches them as bubbling `CustomEvent`s via the private `dispatch()`/`dispatchEvent()` machinery.
- Builds and maintains the statistics panel, network-state indicator, minimap, and right-click context menu as plain DOM (`statisticsDiv()`, `networkstateDiv()`, `updateMinimap()`, `contextmenuDiv()`), plus fullscreen toggling and mouse/wheel/click interaction (zoom, digital-zoom drag).
- Creates and owns a `SunapiManager` (`this._sunapiMng`) for SUNAPI (HTTP) calls alongside the RTSP-over-WebSocket path.

**Structure**
- Extends: `HTMLElement`
- Implements: — (custom element contract: `observedAttributes`, `attributeChangedCallback`, `connectedCallback`)
- Subordinates (creates/uses): `StreamPlayer` (two instances: `player`, `backupplayer`), `SunapiManager`, exceptions (`RTSPOverWebSocketError`, `AuthError`, `SunapiError`)
- Used by: host application code (the demo page, `src/index.html`); not used by any other class in `src/player` — this is the library's outermost facade.

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `version` | `(): string` | Returns a fixed `'1.0.0'` library version string. |
| `play` | `(): void` | Starts live or playback streaming per current attributes; throws `AuthError`/`RTSPOverWebSocketError` on missing username/password/state conflicts. |
| `stop` | `(): void` | Sends a `close` control to the player and resets `readyState` to `STOPPED`. |
| `pause` | `(): void` | Sends a `pause` control (live/playback/instantplayback aware). |
| `resume` | `(): void` | Sends a `resume`/`terminate`(+replay) control depending on play type. |
| `speed` | `(): void` | Playback-only: applies `playSpeed` via a `seek`/`speed` control. |
| `forward` | `(): void` | Playback-only: steps the timestamp forward ~1s and issues a `forward` control. |
| `backward` | `(): void` | Playback-only: steps the timestamp backward ~1s and issues a `backward` control. |
| `seeking` | `(): void` | Playback-only: seeks to `seekingTime` (throws if unset); one-shot (clears `seekingTime` after use). |
| `capture` | `(filename?: string): void` | Requests a single-frame capture, optionally naming the output file. |
| `talk` | `(flag: boolean): void` | Turns two-way audio-out (talk) on/off. |
| `backup` | `(flag: boolean): void` | Starts/stops a recording backup (delegates to `startBackup()`/`endBackup()` when already in backup play type). |
| `startBackup` / `endBackup` | `(): void` | Opens/closes the dedicated `backupplayer` `StreamPlayer` for a backup session. |
| `mute` / `unmute` | `(): boolean` | Toggles audio-in mute via an `audioIn` control; returns new mute state. |
| `isMute` | `(): boolean` | Delegates to `player.isMute()`. |
| `getAudioVolume` / `setAudioVolume` | `(): number` / `(volume: number): void` | Reads/writes audio volume (0–5, validated). |
| `updateSunapiManager` | `(): void` | Establishes a SUNAPI HTTP digest-auth session (`_sunapiMng.init()`) from the current hostname/username/password/deviceType. `connectedCallback` calls this once automatically if all four are already set; not private so a caller that supplies credentials *after* connecting (e.g. in response to a 401) can (re-)run it. |
| `retryAuthentication` | `(username: string, password: string): void` | Sets the `username`/`password` attributes, then — if a `player` exists — re-answers the RTSP client's last-cached 401 challenge with the new credentials over the *same* still-open connection (`StreamPlayer.retryAuthentication()` → `RtspClient.retryWithCredentials()`). No reconnect. The intended response to a `0x0206`/`0x0403` error from a `src`-driven connection attempt that had no (working) credentials. |
| `isPlay` | `(): never` | **Deprecated**, always throws — use the `isplay` property. |
| `setSessionKey` | `(sessionkey: string): void` | **Deprecated** — use `sessionKey` property. |
| `setSunapiClient` | `(client: SunapiClientLike): void` | **Deprecated** — use `sunapiClient` property; also triggers a client-IP lookup. |
| `addEventListener` / `removeEventListener` / `dispatchEvent` | standard DOM-like signatures | Custom listener registry (`Map`-backed) layered over/replacing the native `EventTarget` methods; `dispatchEvent` also invokes an `on<type>` property handler if set. |
| `attributeChangedCallback` | `(name, oldValue, newValue): void` | Custom-element attribute sync hook; validates and mirrors ~25 observed attributes into internal state/`info`. |
| `connectedCallback` | `(): void` | Custom-element mount hook; reads all attributes once, sets up `info`, builds DOM overlays. |
| `scrolled` / `update` | `(event, position?): void` / `(): void` | Digital-zoom pan/redraw entry points (mouse-wheel driven). |
| `onRTSPOverWebSocket*` handlers | various | ~14 methods (`onRTSPOverWebSocketError`, `Resize`, `Meta`, `MetaImage`, `Statistics`, `Timestamp`, `VideoMode`, `Step`, `Capture`, `InstantPlayback`, `Backup`, `Recv`, `Close`, `Status`) — receive `StreamPlayer` callbacks and re-dispatch as `CustomEvent`s; public because they're wired as the actual `info.callback.*` functions but not meant for direct external invocation. |
| ~50 property accessors | `get/set <name>` | Attribute-backed properties: `hostname`, `channel`, `profile`, `profile_number`, `device`, `username`, `password`, `iframe`, `controls`, `multicast`, `width`, `height`, `isplay`, `ismute`, `readyState`, `playSpeed`, `secure`/`https`, `src`, `useIsoTimeFormat`, `statistics`, `filename`, `GMT`, `framedrop`, `volume`, `loading`, `fullscreen`, `grunt`, `bestshot`, `coordinatedUniversalTime`, `background`, `useClockRange`, `bestshotfilter`, `minimap`, `useContextmenu`, `usesubstream`, `type`, `audioshift`, `camchannel`, `profileusage`, `codec`, `limitwidth`, `limitheight`, `android`, `playType`, `mode`, `sessionKey`, `sunapiClient`, `startTime`, `endTime`, `seekingTime`, `overlappedId`, `currentTimestamp`, `client`, `port`. |

**Key data**
- `info: StreamPlayerInfo` — the single config object (`device`/`media`/`callback`) mutated by attribute setters and control methods, then handed to `StreamPlayer.control()`.
- `player: StreamPlayer | null` / `backupplayer: StreamPlayer | null` — the live/playback player and the independent backup-session player.
- `listeners: Map<LegacyListener, {type, listener}>` — custom event-listener registry backing `addEventListener`/`dispatchEvent`.
- `_readyState` — one of `RTSPOverWebSocketPlayState` (`STOPPED`/`PLAYING`/`PAUSED`), read via `readyState`.
- `fpsHistory`/`bufferHistory`/`videoFpsHistory`/`audioFpsHistory`/`rateHistory`/`dropsHistory: number[]` — rolling 30-sample windows feeding the statistics panel's charts.
- `_sunapiMng: SunapiManager` — always-present SUNAPI facade; `sunapiClient` property proxies to it.

**Design notes**
- This is a deliberately preserved, line-for-line port of a ~7300-line legacy class, including confirmed bugs (documented inline at each site): e.g. `_useGrunt`/`grunt` is always `undefined` (never assigned); `speed()` sets a typo'd `.utl` instead of `.url` for camera devices, so the RTSP URL is silently never refreshed there; `connectedCallback`'s tautological `!== null || !== undefined` check on `width`; a duplicate/always-true guard before `updateRendering()` regardless of whether `id` was set (only a `console.warn` fires).
- `isPlay()` is a deprecated method that unconditionally throws — callers must use the `isplay` property instead.
- **`src` attribute**: a convenience attribute (e.g. `rtsp://user:pass@host:port/{channel}/{profile}/media.smp?device=camera&statistics&controls`) parsed by `applySrcAttribute()` into the equivalent set of individual `setAttribute()` calls (reusing every existing `attributeChangedCallback` branch) plus a few direct property assignments (`sessionKey`/`startTime`/`endTime`/`overlappedId`, which were never attributes). Setting it — in markup or dynamically — also connects/reconnects automatically (`_autoplay` + `updateRendering()`'s existing gate if not yet connected to the DOM; an immediate `stop()`+`play()` if already connected). `generateRTSPURL()` reflects the resolved absolute URL back onto `src` on every call (guarded by `_reflectingSrc` against re-parsing itself). This is unrelated to the separate, pre-existing `_source` field (still read by several `if (this._source === null) { ...generateRTSPURL()... }` gates in `play()`/`stop()`/etc.) — nothing has ever written to `_source` outside its own getter/setter pair, so those gates still always evaluate true.
- **`play()` no longer requires `username`/`password` up front.** It used to throw `AuthError` immediately if either was missing; now it always attempts the connection, matching the actual RTSP flow (you can't know whether a stream needs auth — or what its realm/nonce is — until the server challenges with 401). If the server does challenge and there's no password/sunapi client to answer with, `RtspClient.ts` reports it as an `0x0403` error (see `RtspClient`'s design notes) instead, reachable via the normal `error` event.
- Two fully independent `StreamPlayer` instances exist at once when backup is in use (`player` for live/playback, `backupplayer` for the backup session) — they are not coordinated through `StreamManager`.

---

### `StreamManager`

**File:** `src/player/interface/StreamManager.ts`
**Type:** Class

**Purpose**
Legacy-ported per-channel/per-element registry and control dispatcher for `StreamPlayer` instances, sitting between a host integration (e.g. `legacyHostInterface/streamInterface.ts`) and `StreamPlayer`. Not used by `RTSPOverWebSocket` itself (which manages its own `StreamPlayer` directly).

**Responsibilities**
- Looks up an existing `StreamPlayer` by `media.element` id (falling back to `device.channelId`, defaulting to `0`) via `lookup()`.
- Creates a new `StreamPlayer` on `initStreamPlayer()` if none exists for the computed id (unless the request is itself a `close`), or forwards a `reassignCanvas` control to the existing one.
- Routes `control`/`controlWorker` calls to the resolved player, tracking the most-recently-touched player as `currentPlayer`.
- Provides read/write accessors that proxy to the current or looked-up player: state, video dimensions/codec, audio volume.
- `destroyPlayer()` sends a fixed sequence of teardown `controlWorker` commands (`initVideo` off, `setLiveMode` canvas, audio listen/talk volume to 0) then removes the player from the registry.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): `StreamPlayer`
- Used by: `legacyHostInterface/streamInterface.ts` (outside this file group)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `initStreamPlayer` | `(info, sunapiClient, mediaRouterFactories?, transportFactory?): void` | Creates (or reassigns) a `StreamPlayer` for the given config. |
| `lookup` | `(info: StreamLookupInfo): StreamPlayer \| undefined` | Finds a registered player by element id / channel id. |
| `remove` | `(info): void` | Removes all players matching the computed id from the registry. |
| `controlPlayer` | `(info: StreamPlayerInfo): void` | Looks up and calls `player.control(info)`. |
| `controlWorker` | `(controlData: StreamPlayerControlData): void` | Looks up and calls `player.controlWorker(controlData)`. |
| `destroyPlayer` | `(channelId, elementId): void` | Sends teardown commands then unregisters the player. |
| `getCurrentState` | `(channelId, elementId): string \| undefined` | Returns the looked-up player's RTSP state. |
| `getVideoPlayer` | `(): unknown` | Returns `currentPlayer`'s video player (non-null-asserted — throws if no `currentPlayer` yet). |
| `getVideoWidth` / `getVideoHeight` / `getVideoCodecType` | `(channelId, elementId): ...` | Proxy to the looked-up player. |
| `getAudioVolume` / `setAudioVolume` | `(channelId, elementId[, volume]): ...` | Proxy to the looked-up player. |
| `getPlayerLength` | `(): number` | Size of the module-level player registry. |

**Key data**
- Module-level `playerContainer: StreamPlayer[]` and `currentPlayer: StreamPlayer | null` — declared *outside* the class body, in the module's closure.

**Design notes**
- **Deliberate legacy quirk, preserved**: `playerContainer`/`currentPlayer` are module-level, not instance fields, mirroring the legacy IIFE closure (`Constructor.prototype = {...}`) where this state lived outside the constructor. Every `new StreamManager()` therefore shares one global registry — a quasi-singleton via `new`. Any code creating multiple `StreamManager` instances is still operating on the same underlying player list.
- `checkPlayer` (legacy: write-only, set in `initStreamPlayer`, never read) was confirmed dead and dropped from this port.

---

### `StreamPlayer`

**File:** `src/player/interface/StreamPlayer.ts`
**Type:** Class

**Purpose**
The per-channel facade wiring an `RtspClient` (WebSocket RTSP signaling) together with an `RtpClient`/`MediaRouter` (RTP depacketizing, video/audio rendering, backup) behind the single `control()`/`controlWorker()` command surface that both `RTSPOverWebSocket` and `StreamManager` drive.

**Responsibilities**
- Constructs and owns one `MediaRouter` (video/audio/meta rendering + backup) and one `RtspClient` (RTSP-over-WebSocket signaling) per instance, wired together in `startStreaming()` (creates the `RtpClient`, cross-links it into both `mediaRouter` and `rtspClient`).
- `control(info)` is the main command dispatcher: routes `open`/`close`/`resume`/`pause`/`speed`/`seek`/`forward`/`backward`/`step`/`capture`/`dZoom`/`audioIn`/`audioOut`/`backup*`/`minimap`/`changeStackCount` to private per-command handlers that update `profileInfo` and call into `rtspClient.ControlStream()` or `mediaRouter.sendCommandData()`. A separate `instantplayback`-typed branch is handled first for its own small command set (`init`/`open`/`pause`/`seek`/`terminate`).
- `controlWorker(controlData)` is a second, narrower command surface (`setCallback`, `playbackSpeed`, `playbackSeek`, `clearBuffer`, `changeVideoMode`, `audioShift`, plus several confirmed no-op legacy commands like `initVideo`/`setLiveMode`).
- `open()`/`close()` manage the RTSP connect/teardown lifecycle, including validating required device fields (`cameraIp`/`hostname` per device type) and building the `RtspDeviceInfo` handed to `rtspClient.SetDeviceInfo()`.
- Exposes read-only playback/media state (`getCurrentState`, `getVideoWidth/Height/CodecType`, `getAudioVolume`, `isMute`).

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): `MediaRouter`, `RtpClient`, `RtspClient`, `CanvasTagPlayer`/`VideoTagPlayer`, `AudioPlayerGxx`, `Talk`, `BackupProvider`, `MetaDataParser` (all via `MediaRouterFactories`, defaulting to real browser implementations)
- Used by: `RTSPOverWebSocket` (directly, two instances: `player`/`backupplayer`), `StreamManager`

**Public interface**

| Member | Signature | Description |
|---|---|---|
| (constructor) | `(configInfo, sunapiClient, mediaRouterFactories?, transportFactory?)` | Builds `MediaRouter`/`RtspClient`, applies initial media config (volume, instant-playback time, buffer interval, element, framedrop). |
| `control` | `(info: StreamPlayerInfo \| null \| undefined): void` | Main command dispatcher (see Responsibilities). |
| `controlWorker` | `(controlData: StreamPlayerControlData): void` | Secondary, worker-oriented command dispatcher. |
| `getCurrentState` | `(): string` | Delegates to `rtspClient.getCurrentState()`. |
| `getVideoPlayer` | `(): ReturnType<MediaRouter['getVideoPlayer']>` | Delegates to `mediaRouter`. |
| `getVideoWidth` / `getVideoHeight` / `getVideoCodecType` | `(): number \| null` / `string \| null` | Delegate to `mediaRouter`. |
| `isMute` | `(): boolean` | Checks the audio RTP session exists (throws `RTSPOverWebSocketError` if not, while `Playing`), then reads `mediaRouter.mute`. |
| `getAudioVolume` / `setAudioVolume` | `(): number` / `(volume: number): void` | Delegate to `mediaRouter`. |
| `toogleControls` | `(flags: unknown): void` | Delegates to `mediaRouter.toogleControls` (legacy typo preserved). |
| `retryAuthentication` | `(username: string, password: string): void` | Delegates to `rtspClient.retryWithCredentials()` — re-answers the RTSP client's last-cached 401 challenge with new credentials, without reconnecting. |
| `playerId` | `unknown` (public field) | Identity key used by `StreamManager`'s registry lookup. |

**Key data**
- `profileInfo` — mutable snapshot of device/media config (camera IP, credentials, request type/URL/scale, framerate, etc.) rebuilt on every `open()`/command.
- `connectionInfo` — protocol/hostname/port/proxy/ClientIPAddress used to build the WebSocket URL.
- `callbackInfo` — the current set of user callbacks (status/error/recv/time/resize/meta/etc.), reattached to `rtspClient`/`mediaRouter` on each `startStreaming()`.
- `isValidBackupCheck: boolean | null` — tracks whether an active backup session needs a `stop` command sent on `close()`.

**Design notes**
- `terminate()` always throws `RTSPOverWebSocketError` (0x090A, "this method was deplicated") — a legacy dead/deprecated path preserved as-is; `control()`'s `'terminate'` case still routes to it.
- Several `control()`/`controlWorker()` cases are confirmed no-ops ported verbatim because their only legacy effect was a commented-out call into a now-removed `workerManager` subsystem: `changeStackCount`, and `controlWorker`'s `timeStamp`/`initVideo`/`setLiveMode`/`openFPSmeter`/`closeFPSmeter`/`setFpsFrame`/`playToggle`/`setPlaybackservice`/`reassignCanvas`.
- `toogleControls` keeps the real legacy typo (matches `MediaRouter.ts`'s own method name) rather than "correcting" it.

---

### `RTSPOverWebSocketBaseError`

**File:** `src/player/exceptions/RTSPOverWebSocketBaseError.ts`
**Type:** Abstract class

**Purpose**
Shared construction logic for the library's entire error hierarchy, replacing five independently copy-pasted legacy IIFEs (`RTSPOverWebSocketError`, `AuthError`, `RTCPError`, `RTSPError`, `SunapiError`) with one base class.

**Responsibilities**
- Accepts a fixed `errorName` (set by each subclass) plus an options object (`message`, `channelId`, `elementId`, `errorCode`, `place`) and stores them as readonly fields.
- Preserves legacy's exact `message` semantics: an omitted `message` resolves to `''` (via `super(options.message)`), not a "An exception has occurred" fallback (that fallback lived on an unused legacy code path).
- Restores the prototype chain via `Object.setPrototypeOf(this, new.target.prototype)` for correct `instanceof` behavior under downlevel compilation.

**Structure**
- Extends: `Error`
- Implements: —
- Subordinates (creates/uses): —
- Used by: `AuthError`, `RTCPError`, `RTSPError`, `RTSPOverWebSocketError`, `SunapiError`

**Public interface**

| Member | Signature | Description |
|---|---|---|
| (constructor) | `protected (errorName: string, options?: RTSPOverWebSocketErrorOptions)` | Only invocable by subclasses. |
| `channel` | `readonly number \| undefined` | From `options.channelId`. |
| `element` | `readonly string \| undefined` | From `options.elementId`. |
| `errorCode` | `readonly number \| undefined` | Numeric error code (see `fromHex`/`toHex` usage sitewide). |
| `place` | `readonly string \| undefined` | Source-location hint, typically `'File.ts:method'`. |

**Design notes**
- Narrows the legacy constructor to the options-object calling form only — a repo-wide grep confirmed the variadic `(messageTemplate, ...interpolationArgs)` legacy form is never actually used anywhere, so it was dropped rather than ported.

---

### `AuthError`

**File:** `src/player/exceptions/AuthError.ts`
**Type:** Class

**Purpose**
Thrown for authentication-configuration problems (missing username/password) surfaced by `RTSPOverWebSocket.play()`/`startBackup()` and `SunapiClient`'s constructor.

**Responsibilities**
- Sets the error's `name` to `'Auth Error'` and otherwise delegates entirely to `RTSPOverWebSocketBaseError`.

**Structure**
- Extends: `RTSPOverWebSocketBaseError`
- Implements: —
- Subordinates (creates/uses): —
- Used by: `RTSPOverWebSocket.ts` (`play()`), `network/http/SunapiClient.ts` (constructor validation)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| (constructor) | `(options?: RTSPOverWebSocketErrorOptions)` | Standard options-object construction. |

---

### `RTCPError`

**File:** `src/player/exceptions/RTCPError.ts`
**Type:** Class

**Purpose**
Signals an RTCP-layer parsing/processing error; caught specifically by `Transport.OnReceive` to swallow it silently (RTCP errors don't tear down the connection).

**Responsibilities**
- Sets the error's `name` to `'RTSPOverWebSocket Error'` and delegates to the base class.

**Structure**
- Extends: `RTSPOverWebSocketBaseError`
- Implements: —
- Subordinates (creates/uses): —
- Used by: `mediaSession/RTCPSession.ts` (thrown), `network/transport/Transport.ts` (caught via `instanceof RTCPError`)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| (constructor) | `(options?: RTSPOverWebSocketErrorOptions)` | Standard options-object construction. |

**Design notes**
- The `name` value `'RTSPOverWebSocket Error'` is a preserved legacy copy-paste artifact — legacy set the *same* base-class name on every error type in the hierarchy rather than an RTCP-specific one. This port keeps that shared-name quirk (RTCPError and RTSPError both read `'RTSPOverWebSocket Error'`) but rebrands the string itself from the old product name, since it's an observable value real consumers can read off a thrown error.

---

### `RTSPError`

**File:** `src/player/exceptions/RTSPError.ts`
**Type:** Class

**Purpose**
Signals an RTSP protocol/response-handling error; checked via `instanceof` in both `Transport` (to route a failed response to the pending `rtspResponseCallback`) and `RtspClient` (`_send`'s response handler).

**Responsibilities**
- Sets the error's `name` to `'RTSPOverWebSocket Error'` (same shared-name legacy quirk as `RTCPError`) and delegates to the base class.

**Structure**
- Extends: `RTSPOverWebSocketBaseError`
- Implements: —
- Subordinates (creates/uses): —
- Used by: `network/transport/Transport.ts`, `network/rtspOverWebsocket/RtspClient.ts`

**Public interface**

| Member | Signature | Description |
|---|---|---|
| (constructor) | `(options?: RTSPOverWebSocketErrorOptions)` | Standard options-object construction. |

---

### `RTSPOverWebSocketError`

**File:** `src/player/exceptions/RTSPOverWebSocketError.ts`
**Type:** Class

**Purpose**
The library's general-purpose/base error type — thrown throughout the codebase (transport, RTSP client, SUNAPI client/manager, stream player, the custom element) for validation failures, protocol errors, and state-machine violations that don't have a more specific error type.

**Responsibilities**
- Sets the error's `name` to `'RTSPOverWebSocket Error'` (correctly, matching the library's own name — the one case in the hierarchy that isn't a copy-paste artifact) and delegates to the base class.

**Structure**
- Extends: `RTSPOverWebSocketBaseError`
- Implements: —
- Subordinates (creates/uses): —
- Used by: nearly every module in `src/player` (`RTSPOverWebSocket.ts`, `StreamPlayer.ts`, `RtspClient.ts`, `Transport.ts`, `SunapiClient.ts`, `SunapiManager.ts`, `SunapiRestClient.ts`, `MediaRouter.ts`, video/audio session and renderer classes, `Talk.ts`, etc.) — by far the most widely used exception type in the tree.

**Public interface**

| Member | Signature | Description |
|---|---|---|
| (constructor) | `(options?: RTSPOverWebSocketErrorOptions)` | Standard options-object construction. |

---

### `SunapiError`

**File:** `src/player/exceptions/SunapiError.ts`
**Type:** Class

**Purpose**
Signals a failed SUNAPI (HTTP) call, thrown by `SunapiManager` when its underlying `SunapiClient` request rejects.

**Responsibilities**
- Sets the error's `name` to `'SUNAPI Error'` and adds one extra field (`uri`) beyond the shared base options.

**Structure**
- Extends: `RTSPOverWebSocketBaseError`
- Implements: —
- Subordinates (creates/uses): —
- Used by: `network/http/SunapiManager.ts` (`init()`'s rejection path)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| (constructor) | `(options?: SunapiErrorOptions)` | `SunapiErrorOptions` extends the base options with `uri?: string`. |
| `uri` | `readonly string \| undefined` | The SUNAPI request URI that failed, if provided. |

---

### `RtspClient`

**File:** `src/player/network/rtspOverWebsocket/RtspClient.ts`
**Type:** Class

**Purpose**
Implements the RTSP state machine (OPTIONS → DESCRIBE → SETUP → PLAY/PAUSE → TEARDOWN) over a WebSocket `Transport`, including SDP parsing, digest authentication (direct or via a `SunapiClientLike`), and keep-alive/liveness checks. This is the core RTSP-over-WebSocket protocol engine that `StreamPlayer` drives.

**Responsibilities**
- Builds and queues RTSP request text per method (`CommandConstructor`/`_request`/`_send`), maintaining a serialized request queue (`rtspQueue`) since only one RTSP command can be outstanding at a time.
- Parses RTSP responses (`parseRtspResponse`) and embedded SDP bodies (`parseDescribeResponse`), classifying each SDP media session by codec (H264/H265/JPEG, G.711/G.726 variants, MPEG4-generic, OPUS, ONVIF metadata) into `SDPinfo` entries consumed by `RtpClient.sendSdpInfo()`.
- Drives the state machine forward on each `200 OK` (`handleResponse200`) and handles `401` (digest auth retry, either via password locally or via a `SunapiClientLike.get()` round-trip — see Design notes for the exact retry budget), `503` (SETUP-time talk-service-unavailable retry), and other error codes by invoking the registered error callback and tearing down.
- Runs two keep-alive timers: a `GET_PARAMETER` heartbeat every 10s, and an "is RTP still arriving" liveness check every 1s that escalates to an explicit `GET_PARAMETER` probe and eventually an error after ~6–7s of silence.
- Owns the `Transport` lifecycle (`Connect`/`Disconnect`/`clearTransport`) and forwards RTP/RTCP payloads to the attached `RtpClientLike`.
- Exposes `ControlStream()` — the single entry point `StreamPlayer` uses for `resume`/`seek`/`forward`/`backward`/`pause`/`speed`/`backup` control, building the appropriate `Scale`/`Range`/`Immediate`/`Rate-Control` headers per device type and media type.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): `Transport` (via injectable `TransportFactory`), `DigestGenerator`, `RtspStatusCode`
- Used by: `StreamPlayer` (one instance per channel), `RtspClientManagerImpl` (unused path)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| (constructor) | `(transportFactory?: TransportFactory)` | Defaults to real `Transport`-backed factory; overridable for tests. |
| `Connect` | `(): void` | Creates (if needed) and connects the `Transport`. |
| `Disconnect` | `(response?: RtspDisconnectCallback): void` | Sends `TEARDOWN` if streaming, else tears down the transport immediately. |
| `ControlStream` | `(controlInfo: RtspControlInfo): void` | Issues a mid-session RTSP control command (see Responsibilities). |
| `SetDeviceInfo` | `(deviceInfo: RtspDeviceInfo): void` | Sets connection/credential/mode fields before `Connect()`. |
| `SetSunapiClient` | `(client: SunapiClientLike \| null): void` | Enables SUNAPI-mediated digest auth instead of local password auth. |
| `SetErrorCallback` | `(callbackFunc: RtspErrorCallback): void` | Sets the primary error sink. |
| `addEventListener` | `(event: 'error'\|'rtsp'\|'status'\|'recv', callbackFunc?): void` | Registers the four callback slots (`status` is write-only/dead, preserved for parity). |
| `getCurrentState` | `(): string` | Returns the RTSP state machine's current state name. |
| `getSessionId` | `(interleavedId?: number): string \| number` | Resolves an RTP session's SessionID (or `-1` if none). |
| `parseRtspResponse` / `parseDescribeResponse` / `parseWWWAuthenticate` | various | Public parsing utilities, also exercised directly by parity tests. |
| `RtspResponseHandler` | `(stringMessage: string): void` | Main response-driven state transition entry point (invoked by `Transport`'s response callback). |
| `RtpDataHandler` | `(interleave, header, payload): void` | Forwards RTP data to the `RtpClientLike` and marks RTP as alive. |
| `SendAudioTalkData` | `(rtpdata: unknown): void` | Sends talk (audio-out) RTP data if the talk service is active. |
| `retryWithCredentials` | `(username: string, password: string): void` | Updates `id`/`pw`, resets `unahtuorizedCount`, and re-answers the last-cached `wwwAuthenticate` 401 challenge (`formDigestAuthHeader()`) over the *same* still-open connection — no reconnect. Called by `StreamPlayer.retryAuthentication()` in response to a `0x0206`/`0x0403` error once a caller has new credentials. |
| `channelId` / `instantplayback` / `bestshot` / `recvCallback` / `autoconnection` / `rtpClient` | public fields | Cross-wired by `StreamPlayer`. |

**Key data**
- `currentState`/`nextState: string` — the RTSP session state machine (`'Options'`, `'Describe'`, `'Setup'`, `'Play'`, `'Playing'`, `'Pause'`, `'Teardown'`).
- `rtspQueue` / `isRequested` — serializes outbound RTSP commands.
- `SDPinfo: SdpInfoEntry[]` — parsed per-track codec/session info handed to the RTP layer.
- `digestGenerator: DigestGenerator` — builds `Authorization` headers for direct (non-SUNAPI) digest auth.

**Design notes**
- Console/`rtspclient_log` calls and the legacy `window.addEventListener('beforeunload', ...)` TEARDOWN-on-unload side effect were intentionally dropped as observability/page-lifecycle concerns outside this class's contract.
- fmtp parameter parsing (`SizeLength`/`IndexLength`/`IndexDeltaLength`) is deliberately case-insensitive — a fix beyond strict legacy parity, added because this repo's own ffmpeg-based demo server emits lowercase parameter names that the original case-sensitive regex missed, silently breaking AAC framing.
- G.726 codec matching also accepts the AAL2-mode name (`AAL2-G726-32`) in addition to the bare RFC 3551 name, for the same demo-server-compatibility reason.
- **401 handling, redesigned for an interactive "connect first, ask for credentials on demand" flow** (`RTSPOverWebSocket.play()` no longer requires username/password up front — see that class's design notes). `RtspResponseHandler()`'s 401 case now tries whatever credentials are current exactly **once** automatically (`unahtuorizedCount <= 1`) — matching the protocol's own normal "you can't know the realm/nonce until challenged" round trip — and, if still rejected, reports `0x0206` and stops: it does **not** retry the same (now-known-wrong) credentials again, and it does **not** tear the connection down. A caller collecting a new password calls `retryWithCredentials()`, which re-answers the same cached challenge over the still-open connection.
  - This replaced an earlier 3-strikes-then-`clearTransport()` design that had three confirmed bugs, found in sequence while testing the interactive flow live against a real camera: (1) the retry was sent *before* checking the strike count, so even the giving-up attempt sent one more request over the wire; (2) `clearTransport()`'s `Disconnect()` surfaces asynchronously as an abnormal transport close (non-1000 status / `indexOfTransport` mismatch), which `connectionCbFunc()`'s `'close'` handler treated as "worth auto-retrying" (`0x0005`) *unconditionally* — unlike its `'error'` handler, it never checked `transport.autoconnection` — reaching `RTSPOverWebSocket.ts`'s `_retryFlag`-driven auto `stop()`+`play()` and reopening a brand new WebSocket with the same still-wrong password; (3) `unahtuorizedCount` itself was never reset when a *new* connection/transport opened (only on a successful `DESCRIBE` or a full `Disconnect()`, neither of which that give-up path called), so every subsequent connection attempt — even one with the *correct* password — immediately hit the give-up branch on its very first, protocol-mandatory 401, without ever trying it. Together these meant a single wrong password reliably spiraled into unbounded reconnect-with-known-bad-credentials cycles, which is what tripped a real camera's own account-lockout ("490 Account block") during testing. `connectionCbFunc('open', ...)` now resets `unahtuorizedCount` on every fresh connection, and the give-up path no longer touches the transport at all.

---

### `RtspClientManagerImpl`

**File:** `src/player/network/rtspOverWebsocket/RtspClientManager.ts`
**Type:** Class (not exported directly — exposed only via the `RtspClientManager` singleton wrapper's `getInstance()`)

**Purpose**
A per-process registry of `RtspClient` instances, ported from the legacy player for completeness. Confirmed (via repo-wide grep) to be entirely unused in practice — the real code path (`StreamPlayer`) constructs `RtspClient` directly instead.

**Responsibilities**
- Tracks created `RtspClient` instances in an internal list.
- Offers create/delete/count operations against that list.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): `RtspClient`
- Used by: — (confirmed unreferenced anywhere else in `src/player`; only reachable via the exported `RtspClientManager.getInstance()` singleton accessor, itself unused)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `createRtspClient` | `(): typeof RtspClient` | Creates and registers a new `RtspClient` — **but returns the `RtspClient` class/constructor itself, not the created instance** (see Design notes). |
| `deleteRtspClient` | `(rtspClient: RtspClient): void` | Removes an instance from the registry. |
| `getRtspClientCount` | `(): number` | Registry size. |

**Design notes**
- `createRtspClient()`'s return-the-constructor-not-the-instance bug is a genuine legacy defect, preserved verbatim. Since nothing calls this manager, the bug has never had an observable effect in this codebase.
- The exported `RtspClientManager` object (`{ getInstance(): RtspClientManagerImpl }`) lazily constructs a single module-level `RtspClientManagerImpl` on first access — a singleton wrapper around the class documented here.

---

### `Transport`

**File:** `src/player/network/transport/Transport.ts`
**Type:** Class

**Purpose**
The WebSocket transport layer for RTSP-over-WebSocket: demultiplexes interleaved RTSP text responses from binary RTP/RTCP packets arriving on the same socket, and provides the low-level connect/send/disconnect primitives `RtspClient` builds its protocol logic on top of.

**Responsibilities**
- `OnReceive` parses each incoming WebSocket message: detects a leading `'RTSP'` text response (handling `Content-Length`-based fragmentation across multiple WebSocket frames) versus a `0x24`-magic-number-prefixed interleaved RTP/RTCP binary frame, dispatching each to the appropriate callback (`rtspCallback`/`rtpCallback`) and firing matching `TransportEvent`s (`'rtsp'`/`'rtp'`).
- Manages the WebSocket lifecycle (`Connect`, `Disconnect`, `OnOpen`, `OnClose`, `OnError`) including auto-reconnect (`autoconnection`, 500ms retry) and translating WebSocket close/error codes through `WebsocketStatusCode`.
- Tracks per-second received-byte statistics via an `IntervalTimer`, reported through `receivedCallback`.
- Provides a minimal custom pub/sub (`addEventListener`/`removeEventListener`/`dispatchEvent`) independent of the DOM `EventTarget`, plus an `on<type>` handler-property convention.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): `WebSocket` (via overridable `createWebSocket()` factory), `IntervalTimer`, `WebsocketStatusCode`
- Used by: `RtspClient` (one instance per channel, via injectable `TransportFactory`)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| (constructor) | `(serverAddr: string)` | Stores the WebSocket URL; does not connect yet. |
| `Connect` | `(): void` | Opens the WebSocket if not already open. |
| `Disconnect` | `(): void` | Closes the WebSocket. |
| `SendRtspCommand` | `(sendMessage: string \| null, response?: RtspResponseCallback): unknown` | Sends RTSP text, tracking a single pending response callback. |
| `SendRtpData` | `(rtpdata: unknown): void` | Sends binary RTP/RTCP data (talk audio-out). |
| `SetCallback` | `(connectionCbFunc, rtspCbFunc, rtpCbFunc, errorCbFunc, receivedBytesCbFunc?): void` | Registers all callback slots at once. |
| `init` | `(): void` | Clears the socket's own event handlers (pre-teardown cleanup). |
| `close` | `(): void` | Closes the socket if currently open. |
| `addEventListener` / `removeEventListener` / `dispatchEvent` | `(type, listener)` / `(event)` | Transport-local event bus (separate from the callback slots). |
| `websock: WebSocketLike \| null` | public field | The underlying socket (injectable via `createWebSocket()`). |
| `channelId?` / `readyState?` / `autoconnection?` / `index?` | public fields | Set by `RtspClient` right after construction. |

**Key data**
- `fragmentedData: Uint8Array | null` — buffers a partially-received RTSP/RTP frame across multiple `OnReceive` calls.
- `currentReceivedBytes`/`totalReceivedBytes` — feed the 1s statistics timer.

**Design notes**
- Legacy's `SendRtpData` else-branch threw a `RTSPOverWebSocketError` referencing an undefined `error` variable (a pre-existing `ReferenceError`), immediately swallowed by an empty `catch` — net effect was always a silent no-op. This port reproduces that as a direct no-op rather than throw-then-swallow.
- The `OnClose`/`OnError` code-12592 handling parses a made-up decimal string out of a hex/reason concatenation (`hex2AsciiForCloseCode`) — a preserved legacy quirk specific to that one close code.
- Console/logger calls and `typeof window.CustomEvent === 'function'` feature-detection guards from legacy were dropped (observability-only / unconditionally true in this library's target browsers).

---

### `SunapiClient`

**File:** `src/player/network/http/SunapiClient.ts`
**Type:** Class

**Purpose**
Digest-auth REST client for SUNAPI (camera/NVR HTTP control) requests, used both directly by `RtspClient` (for SUNAPI-mediated RTSP digest auth) and as the transport underneath `SunapiManager`.

**Responsibilities**
- Validates device config on construction (camera IP / username / password required, serverType camera-vs-grunt) and derives the digest-auth target host/port/protocol accordingly.
- Issues `GET`/`POST` requests via injectable `XhrFactory`-created XHR objects, handling response parsing for both JSON and the NVR's line-based `a.b.c=value` format (`getDotEqualStrLineToObj`).
- Implements RFC 2617 digest authentication end-to-end: challenge parsing (`getAuthInfoInWwwAuthenticate`), response hashing (`formulateResponse`, MD5 via `crypto-js`), and header construction (`buildDigestAuthHeader`/`setDigestHeader`), including one retry-on-401 with a fresh challenge.
- Special-cases request options by URI shape: `snapshot` → blob response, `configbackup` → arraybuffer response, `opensdk` → `withCredentials`.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): `DigestGenerator`-equivalent logic (self-contained, not `DigestGenerator`), `XMLHttpRequest` (via factory)
- Used by: `SunapiManager` (`init()`), `RtspClient` (`formDigestAuthHeader`'s SUNAPI branch, via `SunapiClientLike`)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| (constructor) | `(deviceInfo: SunapiClientDeviceInfo, xhrFactory?: XhrFactory)` | Validates device info; throws `RTSPOverWebSocketError`/`AuthError` on missing required fields. |
| `get` | `(uri, jsonData, successFn, failFn, scope, isAsyncCall?, isText?, withoutSeqId?): void` | Issues a GET, appending a `SunapiSeqId` cache-buster for `.cgi` endpoints unless suppressed. |
| `post` | `(uri, jsonData, successFn, failFn, scope, fileData, specialHeaders): void` | Issues an async POST. |
| `setTimeout` | `(timeout: number): void` | Sets the configured digest timeout (inert — stored but never read by reachable code, kept for API parity). |
| `getAuthInfo` | `(): DigestCache \| null \| undefined` | Returns the cached digest challenge state. |

**Design notes**
- Several legacy prototype methods (`mobile(...)`, `clearDigestCache()`, `DetectBrowser()`, `checkStaleResponseIssue()`) were confirmed unreachable (never attached to the legacy prototype, or their one call site was commented out) and were not ported.
- Digest `nc` starts at `0` for a freshly-issued nonce (incremented to `1` on first use) rather than legacy's earlier pre-incremented behavior — this port fixes a real interoperability bug confirmed via direct camera testing (at least one Wisenet firmware rejects `nc=00000002` as the first attempt and re-challenges instead of authenticating).
- `Timeout` (Default/Long/Short) and `RESTCLIENT_CONFIG.authType` were confirmed write-only in legacy and dropped, except `setTimeout()` itself (kept inert, for prototype parity).

---

### `SunapiManager`

**File:** `src/player/network/http/SunapiManager.ts`
**Type:** Class

**Purpose**
A thin promise-wrapping facade over `SunapiClient`, exposing one method per SUNAPI endpoint (device info, video profiles/policies, stream URI, recording search/calendar/timeline, snapshot, etc.). This is what `RTSPOverWebSocket._sunapiMng` exposes as the `sunapiClient` property.

**Responsibilities**
- `init(info)` builds and attaches a fresh `SunapiClient` for the given device config, then issues a probing `attributes.cgi` GET, resolving/rejecting the returned promise (rejecting with `SunapiError`).
- Exposes ~15 read methods (`getDeviceInfo`, `getClientIp`, `getVideoProfile(All)`, `getVideoProfilePolicy(All)`, `getRtspStreamURL`, `getSnapshot`, `getSystemProfileAccessInfo`, `getTimezoneInfo`, `getDateInfo`, `getSessionKey`, `getStorageInfo`, `getRecordingSetup`, `getSearchRecordingPeriod`, `getCalendarSearch`, `getOverlappedIdList`, `getTimeline`, `getAITimeline`), each building a SUNAPI query string and wrapping `SunapiClient.get()` in a `Promise`.
- Provides `attach`/`dettach`/`sunapiClient` getter-setter for host code (e.g. `RTSPOverWebSocket.setSunapiClient()`) to inject an externally-managed client instead of one built by `init()`.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): `SunapiClient`, throws `SunapiError` / `RTSPOverWebSocketError` / `SunapiException`
- Used by: `RTSPOverWebSocket` (`_sunapiMng` field, exposed as the `sunapiClient` property)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `init` | `(info: SunapiManagerDeviceInfo): Promise<unknown>` | Constructs a `SunapiClient` and probes connectivity. |
| `sunapiClient` (get/set) / `getSunapiClient` / `attach` / `dettach` | various | Access/inject the underlying `SunapiClient`. |
| `getAttributes`, `getDeviceInfo`, `getClientIp`, `getTimezoneInfo`, `getDateInfo`, `getSnapshot`, `getSystemProfileAccessInfo`, `getVideoSource`, `getVideoProfileAll`, `getVideoProfile`, `getVideoProfilePolicyAll`, `getVideoProfilePolicy`, `getRtspStreamURL`, `getSessionKey`, `getStorageInfo`, `getRecordingSetup`, `getSearchRecordingPeriod`, `getCalendarSearch`, `getOverlappedIdList`, `getTimeline`, `getAITimeline` | `(...): Promise<unknown>` | One promise-returning method per SUNAPI endpoint. |

**Design notes**
- **Confirmed real bug, intentionally preserved**: `getSessionKey`, `getStorageInfo`, `getRecordingSetup`, `getSearchRecordingPeriod`, `getCalendarSearch`, `getOverlappedIdList`, `getTimeline`, and `getAITimeline` all call a non-existent `sunapiClient.join()` method right after `sunapiClient.get(...)` (a leftover from a legacy `useSunapiClient`-flag branch that always resolved `true`, making the intended alternate `sunapiRestClient` path — which does have `join()` — permanently unreachable). Since `SunapiClient` has no `join()`, these eight methods always synchronously throw inside their `Promise` executor and therefore always reject with a `RTSPOverWebSocketError` (0x0700) — a functionally broken legacy behavior, reproduced exactly rather than silently fixed.
- URI construction (and its validation throws, e.g. `SunapiException` in `getOverlappedIdList`/`getTimeline`) deliberately runs *inside* each `Promise` executor, matching legacy — a throw there rejects the promise rather than propagating synchronously to the caller.
- `getSnapshot()` has a legacy bug where, if the response guard (`raw.data !== undefined && raw.data.size !== 0`) is false, the promise is never resolved or rejected — it silently hangs.

---

### `SunapiRestClient`

**File:** `src/player/network/http/SunapiRestClient.ts`
**Type:** Class

**Purpose**
A worker-offloaded counterpart to `SunapiClient`: instead of issuing XHR requests on the main thread, it dispatches each request to a dedicated Web Worker (`worker/sunapi/sunapiRequestTask.ts`) and resolves/rejects based on the worker's response message.

**Responsibilities**
- `init()` validates and stores device connection config (mirrors `SunapiClient`'s validation).
- `get()`/`post()` spawn a fresh `Worker` per request (`createSunapiRequestWorker`), post a structured request message (method/uri/body/auth/scope/etc.), and route the worker's `'auth'`/`'response'` messages back to the caller's success/error callbacks via `runWorkerRequest`.
- `join()` is a promise-parity no-op wrapper around the last request's tracked promise (mirrors `SunapiClient`'s synchronous `join()`-shaped API expectation, though see `SunapiManager`'s notes on that call being generally broken).
- `toQueryString()` exposes the internal `jsonToText` query-string builder for parity testing.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): `Worker` (`sunapiRequestTask.ts`, documented elsewhere)
- Used by: `worker/sunapi/sunapiRequestTask.ts`'s counterpart relationship is the reverse — this class is the main-thread client that spawns that worker script; no other class in this file group references `SunapiRestClient` directly (not currently wired into `SunapiManager`, which always uses `SunapiClient` instead — see `SunapiManager`'s design notes on the `useSunapiClient` flag).

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `init` | `(deviceInfo: SunapiInitDeviceInfo): void` | Validates and sets device config; throws `RTSPOverWebSocketError` on missing required fields. |
| `get` | `(uri, jsonData, successFn, failFn, scope, isAsyncCall, isText): void` | Dispatches a GET to the worker. |
| `post` | `(uri, jsonData, successFn, failFn, scope, fileData, specialHeaders): void` | Dispatches a POST to the worker. |
| `join` | `(): void` | Promise-parity no-op (see Responsibilities). |
| `setTimeout` | `(timeout: number): void` | Sets the configured request timeout. |
| `toQueryString` | `(json: Record<string, unknown>): string` | Exposes the internal query-string builder. |

**Design notes**
- The two near-identical `worker.onmessage` promise executors in legacy's `get`/`post` were merged into one private helper (`runWorkerRequest`) — pure DRY refactor, no behavior change (the two blocks were byte-for-byte identical logic).
- Confirmed currently unreachable from `SunapiManager` — see that class's notes on the `useSunapiClient` flag always selecting `SunapiClient` instead.

---

### `SunapiException`

**File:** `src/player/network/http/SunapiException.ts`
**Type:** Class

**Purpose**
A minimal, non-`Error`-based exception type thrown by `SunapiManager` for a couple of hard-coded parameter-validation failures (missing date range in `getOverlappedIdList`/`getTimeline`/`getAITimeline`'s URI builders).

**Responsibilities**
- Formats itself as `[name] message` via `toString()`, defaulting to `'[unknown] no description'` when unset.

**Structure**
- Extends: — (does not extend `Error` or `RTSPOverWebSocketBaseError` — a standalone class)
- Implements: —
- Subordinates (creates/uses): —
- Used by: `SunapiManager` (`buildTimelineUri`, `getOverlappedIdList`)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `name` | `string \| undefined` | Optional exception name. |
| `message` | `string \| undefined` | Optional exception message. |
| `toString` | `(): string` | Formats as `[name] message`. |

**Design notes**
- Notably not an `Error` subclass, unlike every other exception type in this library — thrown as a plain object via `throw new SunapiException()` with no message/name ever set at its call sites (both current call sites throw it bare), so in practice it always stringifies to `'[unknown] no description'`.

---

### `RtspStatusCode`

**File:** `src/player/network/RtspStatusCode.ts`
**Type:** Class

**Purpose**
A static RTSP status-code lookup table (code → name/description), used by `RtspClient` to attach human-readable status info to error/status callback payloads.

**Responsibilities**
- Maps ~40 RTSP status codes (100–560, 702, plus a synthetic `-1` "Unknown") to `{value, name, description}` via a constructor that resolves the given code (or falls back to `Unknown`).

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): —
- Used by: `RtspClient` (constructed per response to describe status/error events)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| (constructor) | `(statusCode: number \| string \| undefined)` | Resolves to a known entry or `Unknown`. |
| `getDescription` | `(): string` | e.g. `'RTSP 404 Not Found'`. |
| `getStatusCode` | `(): number` | The numeric code (or `-1` for unknown). |
| `getName` | `(): string` | e.g. `'Not Found'`. |
| `getObject` | `(): RtspStatus` | The full `{value, name, description}` record. |

**Design notes**
- Legacy assigned `Constructor.prototype.status = ...` rather than `this.status = ...`, but since legacy's `Constructor` was a fresh function declared inside the outer factory call on every invocation (and instantiated exactly once per call), this was not actually a cross-instance state-sharing bug — just an unusual way to write per-instance state, confirmed safe to port as a normal `private readonly` field.

---

### `WebsocketStatusCode`

**File:** `src/player/network/WebsocketStatusCode.ts`
**Type:** Class

**Purpose**
A static WebSocket close-code lookup table (code → name/description, including standard reserved ranges), used by `Transport` to describe connection close/error events.

**Responsibilities**
- Maps exact standard WebSocket close codes (1000–1015, plus a custom `12592` "Host was closed the websocket") and reserved *ranges* (`0–999`, `1016–1999`, `2000–2999`, `3000–3999`, `4000–4999`) to `{value, name, description}`, falling back to `Unknown` for anything else.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): —
- Used by: `Transport` (`OnClose`/`OnError`, constructed to classify the close/error status)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| (constructor) | `(statusCode: number \| string)` | Resolves via range checks then exact-match table. |
| `getDescription` | `(): string` | Human-readable close reason. |
| `getStatusCode` | `(): number` | The resolved numeric code. |
| `getName` | `(): string` | Short name, e.g. `'Normal Closure'`. |
| `getObject` | `(): WebsocketStatus` | The full `{value, name, description}` record. |

**Design notes**
- Fixes one confirmed legacy typo rather than reproducing it: legacy's `case 1004:` branch read `StatusCode.Reserved1004` (missing underscore), a dead key resolving to `undefined` that would have crashed the legacy code for that one close code. This port maps `1004` to the correctly-named `Reserved_1004` entry instead, since the typo reads as accidental rather than a meaningful contract.

## 2. mediaSession

### 2.1 Session hierarchy

#### `Session`

**File:** `src/player/mediaSession/Session.ts`
**Type:** Class

**Purpose**
Root base class for every RTP/RTCP media session in the player. It defines the common per-track identity fields, the network byte-order helpers RTP/RTCP parsing needs, and a small pub/sub event mechanism used to push decoded frames and status events out of the media-session layer.

**Responsibilities**
- Holds identity/state shared by all sessions: `interleavedId`, `channelId`, `clock`, `running`, `type`, `deviceType`, `timeData`.
- Provides `htonl`/`ntohl`/`htons`/`ntohs` byte-order conversion helpers used throughout RTP/RTCP header parsing.
- Implements a fixed set of named callback slots (`addEventListener`/`removeEventListener`) for `'text' | 'video' | 'metaImage' | 'audio' | 'rtcp' | 'statistics' | 'waiting'` events, each stored as its own `eventXCallback` field rather than a generic listener list.
- Declares the `init()`/`depacketize()` extension points (no-ops here) that every concrete session overrides with codec-specific behavior.
- Tracks the last synced NTP time via `SetTimeStamp`/`GetTimeStamp`.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): —
- Used by: `RtpSession`, `RTCPSession` (direct subclasses); transitively every codec/RTCP session in this group.

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `init` | `(info?: unknown): void` | Extension point for subclass codec setup; no-op here. |
| `depacketize` | `(rtspInterleaved, rtpHeader, rtpPayload: unknown): void` | Extension point for subclass RTP depacketization; no-op here. |
| `htonl`/`ntohl`/`htons`/`ntohs` | `(value): number[] \| number` | 32-/16-bit host↔network byte order conversion. |
| `addEventListener` | `(event: SessionEventName, cb, extraInfo?): void` | Registers the callback for one of the fixed event kinds. |
| `removeEventListener` | `(event: SessionEventName): void` | Clears a previously registered callback. |
| `SetTimeStamp` / `GetTimeStamp` | `(data: TimeData): void` / `(): TimeData \| null` | Stores/reads the last-synced NTP-derived time. |

**Key data**
- `timeData: TimeData | null` — last NTP timestamp/timezone synced onto this session (from RTCP SR or a playback RTP extension).
- `eventXCallback` fields — one slot per event kind; only one subscriber per kind is supported at a time (not a list).

**Design notes**
- The event system is intentionally not generic: each event name maps to its own strongly-named field, matching the legacy JS's ad hoc dispatch rather than a `Map`-based listener registry.
- `init(_info?: unknown)` is deliberately untyped so codec subclasses (e.g. `AACSession`) can narrow the parameter to their own required codec-info shape without a signature clash.

---

#### `RtpSession`

**File:** `src/player/mediaSession/RtpSession.ts`
**Type:** Class

**Purpose**
Base class for every RTP-carrying track (as opposed to RTCP). It adds the packet/statistics bookkeeping, packet-loss detection, and periodic statistics-timer machinery shared by all codec sessions, on top of `Session`'s identity/event plumbing.

**Responsibilities**
- Tracks packet counters (`numberOfReceivedPacket`, `numberOfDroppedPacket`, `rtpLostCount`, etc.) and start-timestamp bookkeeping used to compute per-track timing.
- Runs a periodic statistics timer (`startStatisticsTimer`/`stopStatisticsTimer`) whose tick (`onStatisticsTimer`) detects "no new packets since last tick" and fires the `'waiting'` event (packet-loss/stall signal) or the `'statistics'` event (fps/drop counters) depending on track type and history.
- Owns a growable scratch buffer (`appendBuffer`) used by depacketizers that reassemble fragmented payloads.
- Declares (but leaves as stubs) a wider legacy API surface — `setFrameCallback`, `bufferingRtpData`, `calculatePacketTime`, etc. — preserved for shape-parity with the legacy class even where unused in this port.
- Links to its paired `RTCPSession` via `rtcpSession`, used by codec sessions to read the RTCP-derived interleaved id.

**Structure**
- Extends: `Session`
- Implements: —
- Subordinates (creates/uses): `IntervalTimer` (statistics timer)
- Used by: `RtpClient` (creates/owns instances); subclassed by `AACSession`, `AudioTalkSession`, `G711Session`, `G726Session`, `OPUSSession`, `H264Session`, `H265Session`, `MjpegSession`, `MetaSession`, `VideoRtcpSession`.

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `startStatisticsTimer` | `(interval?: number): void` | Starts the 1s statistics/loss-detection timer. |
| `stopStatisticsTimer` | `(): void` | Stops and clears the timer. |
| `onStatisticsTimer` | `(): void` | Timer tick: fires `'waiting'` on stall, `'statistics'` otherwise. |
| `increaseNumberOfReceivedPacketCount` / `increaseNumberOfDroppedPacket` | `(): void` | Packet counters, also clear/set `isLost`. |
| `isInitializeReceivedPacketCount` | `(): boolean` | True if no packet has been counted yet (used to seed `setStartTimeStamp`). |
| `setStartTimeStamp` / `getTimerStamp` | `(ts): void` / `(): number` | Per-track playback start-time bookkeeping. |
| `setFramerate` / `getFramerate` | `(fr): void` / `(): number \| undefined` | Framerate, fed by RTP-extension NTP sync in codec sessions. |
| `getDropPercent` / `getDropCount` | `(): number` | Drop-rate accessors (values are set only by legacy-parity no-op setters — always 0 in this port). |
| `appendBuffer` | `(current, new, readLength): Uint8Array` | Grow-and-append helper for scratch depacketization buffers. |
| `close` | `(): void` | Clears `sessionId`. |

**Key data**
- `numberOfReceivedPacket` / `numberOfPrevTotalCount` / `rtpLostCount` — drive the stall-detection comparison each timer tick.
- `isLost: boolean` — current stall state; gates duplicate `'waiting'` events.
- `rtcpSession: RTCPSessionLike | null` — paired RTCP session for this track.

**Design notes**
- Several legacy-parity methods (`setDecodingTime`, `initStartTime`, `setCheckDelay`, `VideoBufferList`'s analog `setMaxLength`) are documented no-ops: verified against the legacy source to be write-only (their values are never read anywhere), so they're kept only for API-shape parity rather than as real dead state.
- `startStatisticsTimer`'s `interval` parameter is computed but never actually used to configure the timer — `IntervalTimer` always runs at the fixed `DEFAULT_STATISTICS_INTERVAL` (1000ms); this mirrors an identical no-op computation in the legacy code.
- Loss detection (`onStatisticsTimer`) only ever fires `'waiting'` for `type === 'video'` (with no `information` set) or `type === 'audio'` — metadata tracks never get stall detection.

---

#### `RTCPSession`

**File:** `src/player/mediaSession/RTCPSession.ts`
**Type:** Class

**Purpose**
Parses RTCP control packets (Sender Report, SDES, BYE) received alongside an RTP track and extracts the NTP-to-RTP-timestamp mapping used to synchronize playback across tracks.

**Responsibilities**
- Parses RTCP Sender Reports (`RTCP_SR`, type 200): extracts SSRC, NTP MSW/LSW, RTP timestamp, packet/octet counts; converts NTP time to Unix time via the standard `0x83aa7e80` (1970 epoch) offset and stores it via `SetTimeStamp`.
- Parses SDES packets (`RTCP_SDES`, type 202) via `sdesParse`, walking the list of `{type, length, content}` chunks.
- On RTCP BYE (type 203) for a video track, throws an `RTCPError` (goodbye signals end-of-stream for video only; ignored for other types).
- `depacketize` reassembles one or more compound RTCP packets from the raw interleaved payload (each sub-packet's length is read from its own 2-byte length field) and dispatches each to `parse`.

**Structure**
- Extends: `Session`
- Implements: —
- Subordinates (creates/uses): —
- Used by: `RtpClient` (creates one per SDP media line, paired with the codec session).

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `parse` | `(rtcpData: Uint8Array): void` | Dispatches on RTCP packet type (SR/SDES/BYE). |
| `sdesParse` | `(sdes: Uint8Array): SdesEntry[]` | Parses the chunked SDES item list. |
| `depacketize` | `(rtspInterleaved, rtcpHeader, rtpPayload: Uint8Array): void` | Reassembles and dispatches one or more compound RTCP sub-packets. |
| `close` | `(): void` | Clears `sessionId`. |

**Key data**
- `ssrc`/`ntpMsw`/`ntpLsw`/`rtp`/`spc`/`soc: Uint8Array(4)` — fixed-size scratch buffers reused across SR parses to avoid per-packet allocation.

**Design notes**
- `timezone` is left `undefined` on the SR-derived `TimeData` (unlike the RTP-extension NTP sync path in `rtpDepacketizeUtils.ts`, which does compute a timezone) — verified as matching the legacy behavior exactly, not an omission.
- RTCP BYE only throws for `type === 'video'`; audio/meta BYE is silently ignored, matching the legacy player's asymmetric handling.

---

#### `RtpClient`

**File:** `src/player/mediaSession/RtpClient.ts`
**Type:** Class

**Purpose**
Per-channel factory and router for RTP/RTCP sessions: given the parsed SDP for a channel, it instantiates the right codec session (and a paired `RTCPSession`) for each media line, then routes incoming interleaved RTP/RTCP bytes to the matching session by interleaved channel id.

**Responsibilities**
- `sendSdpInfo` walks the SDP entries and, per `codecName`, constructs the matching codec session (`H264Session`/`H265Session`/`MjpegSession`/`G711Session`/`G726Session`/`OPUSSession`/`AACSession`/`MetaSession`), or — for a G.711 track whose `trackID` marks it as the talk-back track — constructs an `AudioTalkSession` instead and kicks off `mediaRouter.startAudioTalk(...)`.
- For every codec session created, also creates and wires up a paired `RTCPSession` (shared `channelId`/`deviceType`, `rtcpData` listener), and stores both into `sessionArray` indexed by their RTP/RTCP interleaved ids.
- `sendRtpData` looks up the session by `rtspinterleave[1]` (interleaved id byte) and forwards to its `depacketize`.
- Reports frames onward purely through the injected `MediaRouterLike` interface (`onVideoData`/`onAudioData`/`onMetadata`/`onRtcpData`/`onWaiting`/`onStatistics`/`gotAudioSupport`) — never imports `MediaRouter` directly (dependency inversion).
- Bridges outgoing talk audio: `sendAudioTalkData` asks the `AudioTalkSession` to RTP-encode a raw PCM buffer, then forwards the packet via the `'audioTalk'` listener registered through `addListener`.
- Exposes session lookup/query helpers (`getRtpSession`, `getRtpSessionWithType`, `checkRtpSession`) and lifecycle control (`close`, `running` setter that propagates to every owned session).

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): `RTCPSession`, `H264Session`, `H265Session`, `MjpegSession`, `AudioTalkSession`, `G711Session`, `G726Session`, `OPUSSession`, `AACSession`, `MetaSession`.
- Used by: `StreamPlayer` (`interface/StreamPlayer.ts`), constructed with a `MediaRouter` cast to `MediaRouterLike`.

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `sendSdpInfo` | `(sdpInfo: SdpInfoEntry[]): void` | Builds the per-track session set for a channel from parsed SDP. |
| `sendRtpData` | `(rtspinterleave, rtpheader, rtpPacketArray: Uint8Array): void` | Routes one interleaved RTP packet to its session. |
| `addListener` | `(type: 'audioTalk', func: (data: Uint8Array) => void): void` | Registers the outgoing talk-audio packet sink. |
| `checkRtpSession` | `(type: string): boolean` | True if a session of the given media type with an RTCP pairing exists. |
| `getRtpSession` | `(interleavedId: number): RtpSession \| null` | Looks up a session by interleaved id. |
| `getRtpSessionWithType` | `(type: string \| number): RtpSession \| null` | Looks up by media type, codec name, or interleaved id. |
| `close` | `(): void` | Closes and clears all owned sessions. |
| `running` | `get/set boolean` | Propagates run state to every owned session. |

**Key data**
- `sessionArray: AnySession[]` — sparse array indexed by RTP/RTCP interleaved channel id (not a dense list).
- `audioTalkSession: AudioTalkSession | null` — the single talk-back session, if the SDP declared one.

**Design notes**
- `rtcpSession.rtpSession = rtpSession` (a back-reference the legacy code set) is deliberately dropped — confirmed write-only (no read site anywhere), documented in the source comment.
- The commented-out legacy MP4V-ES codec branch was dead code and was dropped rather than ported.
- `rtpWaitingTimeout` is a public field never assigned internally — an intentional escape hatch for an external caller to set directly on the instance, matching legacy.

---

### 2.2 Codec sessions

#### `AACSession`

**File:** `src/player/mediaSession/audioSession/AACSession.ts`
**Type:** Class

**Purpose**
Depacketizes RFC 3640 MPEG4-GENERIC (AAC-hbr) RTP payloads into individual ADTS-framed AAC access units for the audio decoder.

**Responsibilities**
- Parses the AudioSpecificConfig from the SDP `config` fmtp field (audioObjectType, samplingFrequencyIndex, channelConfiguration) in `init()`.
- Parses the RFC 3640 §3.3.6 AU-header-section (`parseAuHeaders`): a 2-byte bit-length field followed by one AU header per aggregated access unit, using the stream's negotiated `sizeLength`/`indexLength`/`indexDeltaLength` (from SDP fmtp, default 13/3/3).
- Splits one RTP packet into potentially *multiple* AAC access units (a single packet from this repo's own demo server commonly aggregates 3–4 AAC frames) — each gets its own generated ADTS header (`genADTSAAC`) if one isn't already present, and its own `eventAudioCallback` dispatch with an incrementing timestamp (`AAC_FRAME_SAMPLES` = 1024 per AU).
- Only processes on `flags.markerBit` (end of an AU-header-section-bearing packet), consistent with AAC's one-marker-per-RTP-packet convention.

**Structure**
- Extends: `RtpSession`
- Implements: —
- Subordinates (creates/uses): `parseRtpHeaderFlags`, `syncPlaybackTimestampFromRtpExtension` (`rtpDepacketizeUtils.ts`)
- Used by: `RtpClient` (created for SDP `codecName === 'mpeg4-generic'`, excluding talk/backup tracks).

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `init` | `(info?: AACCodecInfo): void` | Sets config/bitrate/clock and derives sample rate/channel count from the AudioSpecificConfig. |
| `depacketize` | `(rtspInterleaved, rtpHeader, rtpPayload: Uint8Array): void` | Parses AU headers, emits one `'audio'` event per access unit. |
| `close` | `(): void` | Clears `sessionId`, stops the statistics timer. |

**Key data**
- `samplingFrequencyIndex: number` / `channelCount: number` — decoded from the AudioSpecificConfig; drive both ADTS header generation and the `audioInfo` passed to the decoder.
- `sizeLength`/`indexLength`/`indexDeltaLength` — per-stream AU-header bit widths from SDP fmtp.
- `adts: Uint8Array(7)` — reused ADTS header scratch buffer (`genADTSAAC`'s only output is this side effect).

**Design notes**
- The previous single-AU assumption (hardcoded 4-byte AU-header-section) is explicitly called out in-source as a fixed bug: real aggregated packets desynced partway through decode.
- `samplingFrequencyIndex` defaults to 8 (16kHz, typical for a real camera) but this repo's own demo server encodes 48kHz — declaring the wrong index previously broke MSE decode; the AudioSpecificConfig parse is what corrects it per-stream.

---

#### `AudioTalkSession`

**File:** `src/player/mediaSession/audioSession/AudioTalkSession.ts`
**Type:** Class

**Purpose**
The outgoing (talk-back) counterpart to the receive-only codec sessions: encodes locally captured PCM audio into RTP-over-WebSocket G.711 packets to send back to the camera/server.

**Responsibilities**
- Wraps a `G711AudioEncoder` to convert raw `Float32Array` PCM (from the browser's audio capture pipeline) into G.711-encoded bytes.
- Builds a complete outgoing packet in one call: 4-byte RTSP interleave header (`0x24`, channel id, big-endian payload length) + 12-byte RTP header (fixed version/marker byte `0x80`, payload-type byte `0x80`, incrementing sequence number, `Date.now()` as timestamp, random SSRC) + encoded payload.
- Tracks its own monotonically increasing RTP sequence number (`sequenceNum`, seeded at `0xffde`) and a randomly generated SSRC.

**Structure**
- Extends: `RtpSession`
- Implements: —
- Subordinates (creates/uses): `G711AudioEncoder` (`../../talk/encoder/G711AudioEncoder`)
- Used by: `RtpClient` (created for a G.711 SDP entry whose `trackID` matches the talk/back pattern).

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `setSampleRate` | `(sampleRate: number): void` | Configures the underlying G.711 encoder's sample rate. |
| `getRTPPacket` | `(buffer: Float32Array): Uint8Array` | Encodes one PCM buffer into a full interleaved RTSP+RTP+payload packet. |

**Key data**
- `sequenceNum: number` — per-session outgoing RTP sequence counter.
- `ssrcId: number` — randomly generated once per session, held for the session's lifetime.
- `channelID: number` — the interleaved channel id stamped into the outgoing RTSP header (constructor argument, distinct from `Session.channelId`).

**Design notes**
- This is the only session class in the group that *sends* rather than receives/depacketizes — it overrides `getRTPPacket` (an `RtpSession` stub) instead of `depacketize`.
- `intToByteArrayHtoN` is a local helper (not from `Session`'s `htonl`/`htons`) that writes a big-endian integer of arbitrary byte length backwards from a given end position into a target buffer.

---

#### `G711Session`

**File:** `src/player/mediaSession/audioSession/G711Session.ts`
**Type:** Class

**Purpose**
Depacketizes RFC 3551 G.711 (PCMU/PCMA) RTP audio — a fixed, framing-free codec where each RTP packet is already one complete chunk of continuous companded PCM.

**Responsibilities**
- Validates the RTSP interleave marker and RTP header flags (CSRC count, padding) identically to the other codec sessions via the shared `rtpDepacketizeUtils` helpers.
- Strips any RTP extension header (syncing playback NTP timestamp via `syncPlaybackTimestampFromRtpExtension` when present) and any RTP padding.
- Dispatches the remaining payload as-is (no reassembly) via `eventAudioCallback` on every packet — not gated on the RTP marker bit.

**Structure**
- Extends: `RtpSession`
- Implements: —
- Subordinates (creates/uses): `parseRtpHeaderFlags`, `syncPlaybackTimestampFromRtpExtension`
- Used by: `RtpClient` (created for SDP `codecName === 'G.711'`, excluding talk/backup tracks).

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `init` | `(info?: G711CodecInit): void` | Sets bitrate and clock (`clockFreq * 0.001`). |
| `depacketize` | `(rtspInterleaved, rtpHeader, rtpPayload: Uint8Array): void` | Emits one `'audio'` event per RTP packet (no cross-packet reassembly). |
| `close` | `(): void` | Clears `sessionId`, stops the statistics timer. |

**Key data**
- `bitrate: number` — reported in the `audioInfo` passed to `eventAudioCallback`.

**Design notes**
- Documented fix: previously gated dispatch on `flags.markerBit` (copied from the video-session pattern), which silently dropped every packet against this repo's ffmpeg-based demo server — ffmpeg's G.711 muxer never sets the marker bit (RFC 3551 only defines it for talk-spurt boundaries under silence suppression). G.711/G.726/OPUS all share this same non-marker-gated dispatch for the same reason.

---

#### `G726Session`

**File:** `src/player/mediaSession/audioSession/G726Session.ts`
**Type:** Class

**Purpose**
Depacketizes G.726 ADPCM RTP audio (16/24/32/40 kbit/s variants) — structurally identical to `G711Session` since G.726 is likewise a framing-free, one-packet-one-chunk codec.

**Responsibilities**
- Same header validation, extension/padding stripping, and NTP-extension playback sync as `G711Session`.
- Dispatches the payload unmodified via `eventAudioCallback` on every packet (no marker-bit gate, no reassembly — same rationale as G.711).
- Bitrate is derived either from the SDP `Bitrate` field or, if absent, parsed out of the last two characters of the SDP codec name (`G.726-16`/`-24`/`-32`/`-40`).

**Structure**
- Extends: `RtpSession`
- Implements: —
- Subordinates (creates/uses): `parseRtpHeaderFlags`, `syncPlaybackTimestampFromRtpExtension`
- Used by: `RtpClient` (created for SDP `codecName` in `{G.726-16, G.726-24, G.726-32, G.726-40}`, excluding talk/backup tracks).

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `init` | `(info?: G726CodecInit): void` | Sets bitrate and clock. |
| `depacketize` | `(rtspInterleaved, rtpHeader, rtpPayload: Uint8Array): void` | Emits one `'audio'` event per RTP packet. |
| `close` | `(): void` | Clears `sessionId`, stops the statistics timer. |

**Key data**
- `bitrate: number` — one of the four G.726 rates, reported in `audioInfo`.

**Design notes**
- See `G711Session`'s design note — identical no-marker-bit-gating rationale, referenced directly in this file's source comment rather than re-explained.

---

#### `OPUSSession`

**File:** `src/player/mediaSession/audioSession/OPUSSession.ts`
**Type:** Class

**Purpose**
Depacketizes RFC 7587 Opus RTP audio, another framing-free one-packet-one-Opus-packet codec, fixed at mono/48kHz for this player's decoder.

**Responsibilities**
- Same header validation, extension/padding stripping, and NTP-extension playback sync pattern as `G711Session`/`G726Session`.
- Hardcodes the RTP clock rate to 48000Hz regardless of the SDP's `clockFreq`, per RFC 7587 §4.1 (Opus RTP timestamps always run at a fixed 48kHz clock rate independent of the codec's actual internal sample rate).
- Dispatches the payload unmodified via `eventAudioCallback` on every packet (no marker-bit gate, no reassembly — RFC 7587 §4.2 states no fragmentation/aggregation).
- Reports a fixed `{ channelCount: 1, sampleRate: 48000 }` in `audioInfo` rather than deriving it from the stream.

**Structure**
- Extends: `RtpSession`
- Implements: —
- Subordinates (creates/uses): `parseRtpHeaderFlags`, `syncPlaybackTimestampFromRtpExtension`
- Used by: `RtpClient` (created for SDP `codecName === 'OPUS'`, excluding talk/backup tracks).

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `init` | `(info?: OPUSCodecInit): void` | Sets bitrate; clock is hardcoded to 48000Hz regardless of `info.clockFreq`. |
| `depacketize` | `(rtspInterleaved, rtpHeader, rtpPayload: Uint8Array): void` | Emits one `'audio'` event per RTP packet. |
| `close` | `(): void` | Clears `sessionId`, stops the statistics timer. |

**Key data**
- `bitrate: number` — reported in `audioInfo`.

**Design notes**
- The mono/48kHz hardcoding is deliberate and cross-referenced to the player's `OPUSAudioDecoder.ts` comment on why this player only decodes Opus as mono — not treated as a limitation to fix here.

---

#### `H264Session`

**File:** `src/player/mediaSession/videoSession/H264Session.ts`
**Type:** Class

**Purpose**
Depacketizes RFC 6184 H.264 RTP video into Annex-B byte-stream access units (start-code-prefixed NAL units) ready for the video player/decoder.

**Responsibilities**
- Classifies each RTP payload's leading NAL header byte (`payload[0] & 0x1f`) and handles: single NAL units (default branch), SPS/PPS (captured into `spsSegment`/`ppsSegment` for later SPS parsing by `MediaRouter`), STAP-A aggregation packets (RFC 6184 §5.7.1 — unpacks each `[2-byte size][NAL]` entry, tagging any embedded SPS/PPS), and FU-A fragmentation units (RFC 6184 §5.8 — reassembles a fragmented NAL across packets using the start/end bits).
- Rejects unsupported aggregation types (STAP-B/MTAP16/MTAP24) and SPS extension/subset-SPS NAL types with a typed `RTSPOverWebSocketError`; silently drops Access Unit Delimiter (AUD) NALs.
- Accumulates reassembled NAL units (each prefixed with the `00 00 00 01` Annex-B start code) into a growable `inputBuffer`; on the RTP marker bit, treats the whole accumulated buffer as one complete access unit, classifies it I/P by inspecting the first NAL's type, and dispatches it via `eventVideoCallback`.

**Structure**
- Extends: `RtpSession`
- Implements: —
- Subordinates (creates/uses): `parseRtpHeaderFlags`, `syncPlaybackTimestampFromRtpExtension`
- Used by: `RtpClient` (created for SDP `codecName === 'H264'`); its `spsPayload`/`ppsPayload` output feeds `MediaRouter.spsParse` (`H264SPSParser`).

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `init` | `(): void` | Resets playback flag and `timeData`. |
| `depacketize` | `(rtspInterleaved, rtpHeader, rtpPayload: Uint8Array): void` | Reassembles NAL units; on marker bit, emits one complete access unit via `'video'`. |
| `close` | `(): void` | Clears `sessionId`, stops the statistics timer. |

**Key data**
- `inputBuffer: Uint8Array` (initial ~1.4KB, growable) / `inputLength: number` — the current access unit's accumulated Annex-B bytes.
- `spsSegment`/`ppsSegment: Uint8Array | null` — most recent SPS/PPS NAL payloads, passed through in `videoInfo` for downstream SPS parsing.

**Design notes**
- FU-A reassembly reconstructs the original NAL header byte (`(payload[0] & 0x60) | fuType`) only on the fragment carrying the start bit; middle/end fragments append raw payload bytes.
- A 3-byte start code on the reassembled frame's 4th byte is treated as an unsupported condition and throws — only 4-byte start codes are handled.

---

#### `H265Session`

**File:** `src/player/mediaSession/videoSession/H265Session.ts`
**Type:** Class

**Purpose**
Depacketizes RFC 7798 H.265/HEVC RTP video into Annex-B access units, structurally parallel to `H264Session` but with HEVC's different NAL header layout and VPS/SPS/PPS triad.

**Responsibilities**
- Classifies each payload's HEVC NAL type (`(payload[0] >> 1) & 0x3f`) and handles VPS/SPS/PPS (captured into `vpsPayload`/`spsPayload`/`ppsPayload`), AUD (dropped), and RFC 7798 §4.4.3 fragmentation units (NAL type 49 — reassembles using the FU header's start/end bits, 2-byte HEVC NAL header reconstruction).
- Any other NAL type falls through to the default "single NAL, copy as-is" branch (unlike H264Session, no explicit STAP-A-equivalent aggregation or unsupported-type rejection is implemented here).
- On the RTP marker bit, dispatches the accumulated access unit via `eventVideoCallback`, classifying frame type as `'I'` only when the first NAL byte is exactly `0x40` (VPS-led access unit), else `'P'`.

**Structure**
- Extends: `RtpSession`
- Implements: —
- Subordinates (creates/uses): `parseRtpHeaderFlags`, `syncPlaybackTimestampFromRtpExtension`
- Used by: `RtpClient` (created for SDP `codecName === 'H265'`); its `vpsPayload`/`spsPayload`/`ppsPayload` output feeds `MediaRouter.spsParse` (`H265SPSParser`).

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `init` | `(): void` | Resets playback flag and `timeData`. |
| `depacketize` | `(rtspInterleaved, rtpHeader, rtpPayload: Uint8Array): void` | Reassembles NAL units; on marker bit, emits one complete access unit via `'video'`. |
| `close` | `(): void` | Clears `sessionId`, stops the statistics timer. |

**Key data**
- `inputBuffer`/`inputLength` — accumulated Annex-B bytes for the current access unit (same pattern as `H264Session`).
- `vpsPayload`/`spsPayload`/`ppsPayload: Uint8Array | null` — most recent parameter-set NALs.

**Design notes**
- Deliberately preserves a legacy quirk, called out in-source: CSRC/padding detection here checks raw header bits directly (`(rtpHeader[0] & 0x0f) === 0x0f` for CSRC, i.e. exactly 15, not merely nonzero) rather than using the shared `flags.csrcCount`/`flags.padding` computed values that `H264Session` uses — kept as-is rather than "fixed" to match the legacy behavior exactly.

---

#### `MjpegSession`

**File:** `src/player/mediaSession/videoSession/MjpegSession.ts`
**Type:** Class

**Purpose**
Depacketizes RTP/JPEG (RFC 2435-family) video by offloading the actual reassembly/decode-prep work to a per-instance Web Worker, batching raw RTP packet data across the main-thread/worker boundary.

**Responsibilities**
- Buffers each incoming RTP packet's raw header/payload/interleave bytes into `rtpDataArray` rather than depacketizing inline.
- Flushes a batch of up to `RTP_STACK_CHECK_NUM` (50) buffered packets to its worker whenever the batch is full or the RTP marker bit is seen, via `worker.postMessage`.
- Relays the worker's `onmessage` result back out through `eventVideoCallback`, adding an `isMetaImage` flag derived from `this.information === 'MetaImageSession'` (distinguishes ordinary MJPEG video from an embedded meta-image stream sharing the same codec).
- Owns the worker's lifecycle: lazily created in `init()`, terminated in `close()`.

**Structure**
- Extends: `RtpSession`
- Implements: —
- Subordinates (creates/uses): a `MjpegWorkerLike` Web Worker (default factory instantiates `worker/mjpegSession/mjpegDepacketizeWorker.ts`), injectable via constructor for testing.
- Used by: `RtpClient` (created for SDP `codecName === 'JPEG'`).

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `init` | `(): void` | Lazily creates the worker and wires its `onmessage`. |
| `depacketize` | `(rtspInterleaved, rtpHeader, rtpPayload: Uint8Array): void` | Buffers the raw packet; flushes a batch to the worker on marker bit or batch-size threshold. |
| `close` | `(): void` | Stops the statistics timer, terminates and clears the worker. |

**Key data**
- `rtpDataArray: MjpegRtpDataEntry[]` — buffered raw packets awaiting a worker flush.
- `worker: MjpegWorkerLike | null` — per-instance worker (not shared module state — verified against the legacy factory-function pattern where each `mjpegSession` instance got its own closure-scoped worker).

**Design notes**
- Debug-only RTP header fields the legacy code computed purely for a dropped debug log (version/padding/extension/CSRC count/payload type/sequence number) are not reproduced — only marker bit and timestamp, which drive real control flow, are kept.

---

#### `VideoRtcpSession`

**File:** `src/player/mediaSession/videoSession/VideoRtcpSession.ts`
**Type:** Class

**Purpose**
A second, video-specific RTCP Sender-Report handler distinct from the general-purpose `RTCPSession` — computes wall-clock presentation time for a given RTP timestamp by tracking the most recent SR's NTP↔RTP timestamp mapping.

**Responsibilities**
- `SendRtpData` parses an incoming RTCP Sender Report (`pt === 200`) out of a raw header+payload buffer, extracting NTP MSW/LSW and the RTP timestamp, and records them via `noteIncomingSR`.
- `noteIncomingSR` converts the NTP MSW to Unix seconds (`- 0x83aa7e80`) and NTP LSW to microseconds, storing the resulting `fsyncTime`/`fsyncTimestamp` reference point.
- `calculatePacketTime` (overriding the `RtpSession` stub) converts an arbitrary RTP timestamp to a `{tv_sec, tv_usec}` presentation time, extrapolating from the last-seen SR reference point using the session's `clockFreq`; falls back to the current wall-clock time if no SR has been seen yet.

**Structure**
- Extends: `RtpSession`
- Implements: —
- Subordinates (creates/uses): —
- Used by: exported from `videoSession/index.ts`, but not instantiated anywhere else in the current codebase (no `new VideoRtcpSession(` call found outside its own file) — ported for parity but not currently wired into `RtpClient`'s SDP-driven session creation.

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `SendRtpData` | `(rtspInterleaved, rtpHeader, rtpPayload): void` | Parses an RTCP SR and records its NTP/RTP reference point. |
| `calculatePacketTime` | `(rtpTimeStamp: number): PresentationTime` | Computes `{tv_sec, tv_usec}` for a given RTP timestamp relative to the last SR. |

**Key data**
- `fsyncTime: {seconds, useconds}` / `fsyncTimestamp: number` — the most recent SR's NTP-time/RTP-timestamp reference pair used for extrapolation.

**Design notes**
- Renamed from the legacy `RtcpSession` specifically to avoid a case-only collision with `mediaSession/RTCPSession.ts`, which is a distinct, unrelated class (RTCP handling for the general session hierarchy vs. this video-specific presentation-time calculator) — a discovered pre-existing naming clash in the legacy codebase, resolved by renaming rather than preserved as-is.

---

#### `MetaSession`

**File:** `src/player/mediaSession/textSession/MetaSession.ts`
**Type:** Class

**Purpose**
Depacketizes the RTP "application"/metadata track (XML event/analytics data interleaved alongside video) into complete frame buffers for `MetaDataParser`.

**Responsibilities**
- Same header validation and extension/padding stripping as the other codec sessions, via the shared `rtpDepacketizeUtils` helpers.
- Reassembles fragmented metadata payloads across packets into a growable `inputBuffer` (no NAL-style structure — just raw byte concatenation, since metadata has no codec framing).
- On the RTP marker bit, dispatches the accumulated buffer via `eventMetaCallback` (the `'text'` event) as a `MetadataFrame`-shaped object with timestamp info.

**Structure**
- Extends: `RtpSession`
- Implements: —
- Subordinates (creates/uses): `parseRtpHeaderFlags`, `syncPlaybackTimestampFromRtpExtension`
- Used by: `RtpClient` (created for SDP `codecName === 'MetaData'`); its output (`eventMetaCallback` → `MediaRouter.onMetadata`) feeds `MetaDataParser.parse`.

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `init` | `(): void` | Resets playback flag and `timeData`. |
| `depacketize` | `(rtspInterleaved, rtpHeader, rtpPayload: Uint8Array): void` | Reassembles fragments; on marker bit, emits one complete metadata frame via `'text'`. |
| `close` | `(): void` | Clears `sessionId`, stops the statistics timer. |

**Key data**
- `inputBuffer: Uint8Array` (initial ~1.4KB, growable) / `inputLength: number` — accumulated bytes for the current metadata frame.

**Design notes**
- Unlike the video sessions, there is no NAL/frame-type classification here — metadata is opaque bytes handed straight to `MetaDataParser`, which is responsible for interpreting it as XML.

---

### 2.3 MediaRouter & support

#### `MediaRouter`

**File:** `src/player/mediaSession/MediaRouter.ts`
**Type:** Class

**Purpose**
The per-channel hub that owns the active video/audio player instances, routes depacketized frames from `RtpClient`'s sessions to the right player, and dispatches UI-originated playback commands (speed/pause/resume/step/minimap/backup/digital zoom/...). It is the largest and most stateful class in the media-session layer.

**Responsibilities**
- Implements the four unbound session-callback handlers (`onVideoData`/`onAudioData`/`onMetadata`/`onRtcpData`) that `RtpClient` registers directly onto RTP/RTCP sessions as raw function references — each closes over a captured `self` (router-level state) while also receiving the calling session as `this: SessionContext`, exactly mirroring the legacy `_self` closure pattern.
- On the first I-frame of a new/changed codec or resolution, selects and (re)creates the video player (`selectVideoPlayer`) — deciding canvas-vs-video tag mode based on codec, `MediaSource.isTypeSupported`, resolution limits, device type, and browser quirks — then initializes it against the resolved DOM element (`selectVideoElement`).
- Parses SPS out of H.264/H.265 I-frames (`spsParse`/`getFrameSizeInfo`) to detect resolution/codec changes and to feed `videoInfo.width/height/codecInfo/profileIdc/...` used both for player selection and downstream resize notifications.
- Manages the optional standalone `AudioPlayerLike` for canvas-tag playback (create/init/switch-codec/destroy) and the optional `TalkLike` outgoing-audio session (`startAudioTalk`).
- Implements NTP-based UTC timestamping for Live playback: combines the RTCP-derived NTP↔RTP mapping (`onRtcpData`) with each frame's RTP timestamp to compute `utcTimeStamp`/`utcDatetime` on video/audio frames.
- Dispatches all `MediaRouterCommandType` UI commands (`sendCommandData`) — capture, backup start/stop, step forward/backward, speed, pause/resume, seek, audio control, digital zoom, minimap, instant playback — onto the current player/backup-provider/audio-player.
- Drives the buffer-manager-vs-direct-render decision (`checkBufferManagerAvailable`: true only for H.265 canvas-mode Playback) that determines whether a video frame goes to `player.onVideoData` directly or through `player.sendToBufferManager` (which internally uses `PlaybackBufferManager`).

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses, via `MediaRouterFactories`): `CanvasTagPlayer`/`VideoTagPlayer` (as `VideoPlayerLike`), `AudioPlayerGxx` (as `AudioPlayerLike`), `Talk` (as `TalkLike`), `MetaDataParser` (as `MetaDataParserLike`), `BackupProvider` (as `BackupProviderLike`); also `H264SPSParser`/`H265SPSParser` directly.
- Used by: `StreamPlayer` (constructs it with a `MediaRouterFactories` bundle); driven by `RtpClient` via the `MediaRouterLike` interface.

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `onVideoData`/`onAudioData`/`onMetadata`/`onRtcpData` | unbound session callbacks | Registered directly on RTP/RTCP sessions by `RtpClient`; route frames to the active player/audio-player/meta-parser/NTP-sync state. |
| `onWaiting` | `(waiting: WaitingEvent): void` | Forwards packet-loss/stall notice to the player and error callback; optionally closes the player on a lost video track. |
| `onStatistics` | `(statistics: RtpStatistics): void` | Updates player `rfps` and box size, forwards to the statistics callback. |
| `sendCommandData` | `(type: MediaRouterCommandType, data: unknown): boolean \| void` | Dispatches one UI playback command. |
| `addListener` | `(type: MediaRouterListenerType, func, data?): void` | Registers one of the router's many named callback slots (mirrors `Session`'s per-name pattern at router scope). |
| `selectVideoPlayer` | `(channelid, playMode, codecType, size, framerate): VideoPlayerLike \| null` | Chooses canvas vs. video tag mode and constructs the player. |
| `startAudioTalk` | `(cb: (data: Float32Array) => void): Promise<number>` | Creates and initializes the talk-back session; resolves with negotiated sample rate. |
| `terminate` | `(func?: () => void): void` | Tears down player/audio-player/talk session and resets router state. |
| `gotAudioSupport` | `(supported: boolean): void` | Forwards `RtpClient`'s audio-track-presence detection to the registered listener. |

**Key data**
- `activeSessions: {video, audio, meta}` — tracks which `RtpSession` is currently "active" per media type, used to stop/start statistics timers when the active track changes (e.g. multi-profile switch).
- `currentProfile: CurrentProfile` — last-selected codec/size, used to detect and report speed-limit transitions (`checkValidSpeed`) exactly once per change.
- `videoNTPDateTime`/`rtcpTSvideo`, `audioNTPDateTime`/`rtcpTSaudio` — NTP-time-to-RTP-timestamp anchors, refreshed by `onRtcpData`, consumed by `handleVideoData`/`handleAudioData` to stamp Live-mode UTC time onto frames.
- `stepFlag`/`stepStatus`/`stepCmd` — instant-playback (frame-step) state machine driving `bufferingVideoData`/`controlStepPlay`.

**Design notes**
- The class-level `Constructor.prototype.x = v` idiom from the legacy source (for `audioVolume`/`minRemainTime`/`minTimerInterval`/`profile`/`domElement`) is *not* shared cross-instance state — verified that `MediaRouter` was a plain factory function in legacy (fresh `Constructor`/`.prototype` per call), so it's ported as ordinary private instance fields.
- `metaNTPDateTime`/`rtcpTSmeta` (legacy's meta-track analogs to the video/audio NTP anchors) are confirmed dead (never read) and dropped — meta/text tracks don't get the live NTP-sync treatment video/audio do.
- `onVideoData`/`onAudioData`/`onMetadata`/`onRtcpData` are invoked with `this` bound to the *session*, not the router (they're passed as raw references into `session.addEventListener`) — the `this: SessionContext` parameter annotation documents this statically; `onWaiting`/`onStatistics` by contrast are called as ordinary bound methods from `RtpClient`'s own wrapper functions, so `this` is the router there.

---

#### `MetaDataParser`

**File:** `src/player/mediaSession/MetaDataParser.ts`
**Type:** Class

**Purpose**
Decodes the raw byte buffer assembled by `MetaSession` into a UTF-8 XML string (and, if an optional XML-parser library is present on `window`, also a JSON representation), then hands the result to a caller-supplied callback.

**Responsibilities**
- Decodes bytes to a UTF-8 string via `TextDecoder` when available, falling back to a hand-rolled `utf8ArrayToStr` (multi-byte UTF-8 decode, including a 4-byte-codepoint fallback path) for environments without it.
- Bails out silently (no callback invocation) if the decoded text isn't XML (`indexOf('<?xml') < 0`).
- Optionally enriches the result with a JSON representation via `window.parser` (an externally loaded `fast-xml-parser`-compatible library), treated as fully optional — `.xml` and the callback fire regardless of whether it's present, only `.json` depends on it.
- Wraps any parse failure in a typed `RTSPOverWebSocketError` (error code `0x0907`).

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): `window.parser` (optional, external `FastXmlParserLike`), `fastJsonStringfy` util.
- Used by: `StreamPlayer` (constructs it via `MediaRouterFactories.createMetaDataParser`); driven by `MediaRouter.handleMetadata`, which is itself fed by `MetaSession`'s `'text'` event.

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `parse` | `(byteData: Uint8Array): void` | Decodes bytes to XML (and optionally JSON), then invokes the constructor-supplied callback. |
| `channelId` | `get/set number` | Channel this parser instance is scoped to. |
| `deviceType` | `get/set string \| undefined` | Device type, set by `MediaRouter` at construction. |

**Key data**
- `callback: (metaData: ParsedMetaData) => void` — constructor-injected sink for each successfully parsed metadata frame.

**Design notes**
- The legacy per-codepoint `charCache` memoization in `utf8ArrayToStr` (a pure perf optimization, no output difference) was dropped for simplicity — not a behavior change.
- The 4-byte-codepoint UTF-8 branch is only reachable via a `String.fromCodePoint` feature-detect that's always true in any environment this code actually runs in; kept anyway for fidelity with the legacy fallback structure.

---

### 2.4 Buffer manager state pattern

#### `PlaybackBufferManager`

**File:** `src/player/mediaSession/videoSession/PlaybackBufferManager.ts`
**Type:** Class

**Purpose**
Buffers decoded H.265 Playback-mode video frames ahead of rendering (so canvas-mode H.265 Playback can pop frames at a steady pace independent of network jitter), delegating all state-dependent behavior (when pushes/pops are allowed, when to emit pause/resume/full/restart control messages) to a `BufferState` implementation via the State pattern.

**Responsibilities**
- Owns a `VideoBufferList` and forwards `push`/`pop`/`front`/`clear` frame operations to it, while consulting the current `BufferState` to decide the *meaning* of each operation (e.g., whether the buffer transitions to `PlayState` on first push, or emits a full/restart message).
- Dynamically resizes the underlying list's buffering threshold and max length based on the stream's reported framerate (`buffer.setBUFFERING(framerate * 4)`).
- `fullCallback` (wired into `VideoBufferList.setBufferFullCallback`) asks the current state for a `full()` control message and forwards it through the registered callback if present.
- `checkRestart` detects an empty buffer and asks the current state for a `restart()` message, used to signal the player it needs to request more data.
- Exposes `isReadyToPop`/`push` as boolean returns driven entirely by the current state, letting `CanvasTagPlayer` decide whether to actually pop a frame this tick.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): `VideoBufferList`, `VideoBufferNode` (via the list), `BufferState` implementations (`InitState` initially; transitions through `PlayState`/`PauseState`/`FakePauseState`/`WaitPauseState`/`FullState`).
- Used by: `CanvasTagPlayer` (`video/player/canvas/CanvasTagPlayer.ts`), for H.265 canvas-mode Playback streams specifically (per `MediaRouter.checkBufferManagerAvailable`).

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `change` | `(status: BufferState): void` | Implements `BufferManagerLike`; lets the current state transition the manager to a new state. |
| `init` | `(callback: (message: BufferControlMessage) => void): void` | Resets to `InitState`, registers the control-message sink, clears the buffer. |
| `push` | `(bufferInfo: PushBufferInfo): boolean` | Pushes a decoded frame into the list; return value (from the current state) signals whether playback should (re)start. |
| `pop` | `(): PopFrameInfo \| false \| undefined` | Pops the next buffered frame in `PopFrameInfo` shape, or `false` if empty (also triggers `clear()` on the state). |
| `pause` / `resume` | `(): void` / `(): boolean` | State-dependent pause/resume; `resume` returns whether the manager is now ready to pop. |
| `full` | `(): BufferControlMessage \| undefined` | Asks the current state for a full-buffer control message. |
| `checkRestart` | `(): boolean` | True (and fires the callback) if the buffer emptied and the state signals a restart. |
| `isReadyToPop` | `(): boolean` | Whether the current state allows popping. |
| `clear` | `(): void` | Delegates to the current state's `clear()` (typically returns to `InitState`). |

**Key data**
- `bufferStatus: BufferState` — the current State-pattern state object; all behavior-dependent decisions are delegated here.
- `buffer: VideoBufferList | null` — the actual frame queue.
- `reserveNode: VideoBufferNode | null` — holds the most recently popped node so `front()` can push it back to the head (used for step-back/backup semantics).

**Design notes**
- `push`'s boolean return and `pop`'s implicit `clear()`-on-empty are both state-pattern side effects, not manager-level logic — the manager itself has no conditionals over "am I paused/full/etc.", it purely asks the state object.

---

#### `VideoBufferList`

**File:** `src/player/mediaSession/videoSession/VideoBufferList.ts`
**Type:** Class

**Purpose**
A doubly-linked list of buffered video frames (`VideoBufferNode`) with FIFO push/pop plus the extra seek-support operations (`searchTimestamp`, `findIFrame`) `PlaybackBufferManager` needs for step/backup playback.

**Responsibilities**
- Standard doubly-linked-list FIFO: `push` appends at the tail, `pop` removes from the head, `front` re-inserts a previously popped node back at the head (supports "put this frame back" step-backward semantics).
- Fires a caller-registered `bufferFullCallback` exactly once when the list first reaches its `buffering` threshold (edge-triggered via the `checkFull` latch, reset once length drops back below threshold).
- `searchTimestamp` linearly scans for a node matching an exact `(timestamp, timestamp_usec)` pair, recording its position (`curIdx`) for `findIFrame` to resume from.
- `findIFrame` walks forward or backward from `curIdx` to the nearest I-frame node, used for step play.
- `clearBuffer` walks the whole list nulling out each node's `buffer` (explicit memory release) and resets length/head/tail/`curIdx`.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): `VideoBufferNode`
- Used by: `PlaybackBufferManager` (sole owner).

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `push` | `(data, width?, height?, cropWidth?, cropHeight?, codecType?, frameType?, timeStamp?): VideoBufferNode` | Appends a new frame node at the tail. |
| `pop` | `(): VideoBufferNode \| null` | Removes and returns the head node. |
| `front` | `(node: VideoBufferNode \| null): void` | Re-inserts a node at the head. |
| `setBUFFERING` | `(interval: number): void` | Sets the full-callback threshold, clamped to `[20, 240]`. |
| `setBufferFullCallback` | `(callback: () => void): void` | Registers the edge-triggered full notification. |
| `searchTimestamp` | `(frameTimestamp: VideoFrameTimeStamp): VideoBufferNode \| null` | Linear search by exact timestamp match; throws if the list is empty. |
| `findIFrame` | `(isForward: boolean): VideoBufferNode \| null` | Walks from `curIdx` to the nearest I-frame in the given direction. |
| `clearBuffer` | `(): void` | Empties the list, releasing each node's buffer reference. |
| `getBufferLength` | `(): number` | Current node count. |

**Key data**
- `head`/`tail: VideoBufferNode | null` — list ends.
- `curIdx: number` — last search/I-frame position, consumed by subsequent `findIFrame` calls (stateful across calls, not a pure function of the list).
- `checkFull: boolean` — edge-trigger latch preventing repeated full-callback firing while length stays at/above threshold.

**Design notes**
- `setMaxLength` is a documented no-op — confirmed write-only in the legacy source too (the clamped max-length value it computed was never read anywhere), kept only for API-shape parity.
- `searchTimestamp`/`findIFrame` throw plain `Error`s (not the codebase's typed `RTSPOverWebSocketError`) when the list is empty — matches legacy behavior as-is.

---

#### `VideoBufferNode`

**File:** `src/player/mediaSession/videoSession/VideoBufferList.ts` (same file as `VideoBufferList`)
**Type:** Class

**Purpose**
A single doubly-linked-list node holding one buffered decoded video frame plus the metadata (`PlaybackBufferManager`/`VideoBufferList` need) to render, resize for, and seek to it later.

**Responsibilities**
- Stores the frame's raw buffer plus width/height/crop dimensions, codec type, frame type (`'I'`/`'P'`), and timestamp — everything `PlaybackBufferManager.pop()` needs to reconstruct a `PopFrameInfo`.
- Holds `next`/`previous` links used by `VideoBufferList`'s doubly-linked traversal.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): —
- Used by: `VideoBufferList` (creates/links instances); consumed by `PlaybackBufferManager.pop()`.

**Public interface**

| Member | Signature | Description |
|---|---|---|
| constructor | `(buffer, width?, height?, cropWidth?, cropHeight?, codecType?, frameType?, timeStamp?)` | All fields are public constructor parameters (positional). |
| `next`/`previous` | `VideoBufferNode \| null` | Doubly-linked-list pointers, mutated externally by `VideoBufferList`. |

**Key data**
- `buffer: Uint8Array | null` — the frame's raw bytes; nulled out by `VideoBufferList.clearBuffer()` on release (not by the node itself).

**Design notes**
- A plain data-holder with externally mutated link pointers — all list-manipulation logic lives in `VideoBufferList`, not here, consistent with a lightweight node object rather than a self-managing structure.

---

#### `InitState`

**File:** `src/player/mediaSession/videoSession/BufferManagerStates.ts`
**Type:** Class

**Purpose**
The `PlaybackBufferManager`'s starting state: an empty/not-yet-playing buffer that transitions to `PlayState` on the first successful frame push.

**Responsibilities**
- `push()` transitions the manager to `PlayState` and returns `true` (signals the manager that playback can now begin popping frames).
- Every other `BufferState` method (`pause`, `full`, `restart`, `resume`) is a no-op returning `undefined`; `isReadyToPop()` is `false`.

**Structure**
- Extends: —
- Implements: `BufferState`
- Subordinates (creates/uses): `PlayState` (constructed on `push()`)
- Used by: `PlaybackBufferManager` (initial state, and the state re-entered by every other state's `clear()`/most `restart()`s).

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `push` | `(): boolean` | Transitions to `PlayState`; returns `true`. |
| `isReadyToPop` | `(): boolean` | Always `false`. |
| `pause`/`full`/`restart`/`resume` | `(): undefined` | No-ops. |
| `clear` | `(): void` | No-op (already the "empty" state). |

**Key data**
- `manager: BufferManagerLike` — back-reference used only to call `change()` on transition.

---

#### `PlayState`

**File:** `src/player/mediaSession/videoSession/BufferManagerStates.ts`
**Type:** Class

**Purpose**
The normal steady-state playback state: the buffer is actively feeding frames and is ready to pop.

**Responsibilities**
- `isReadyToPop()` is `true`; `push()` returns `false` (no state transition needed — buffer is already running).
- `pause()` transitions to `PauseState`.
- `full()` transitions to `WaitPauseState` and returns a `BufferControlMessage` (error code `0x0500`) signaling the buffer has hit capacity.
- `clear()`/`restart()` both transition back to `InitState`.

**Structure**
- Extends: —
- Implements: `BufferState`
- Subordinates (creates/uses): `PauseState`, `WaitPauseState`, `InitState`
- Used by: `PlaybackBufferManager` (entered from `InitState.push()`, and from `FullState.restart()`).

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `isReadyToPop` | `(): boolean` | Always `true`. |
| `push` | `(): boolean` | Always `false` (no-op transition). |
| `pause` | `(): undefined` | Transitions to `PauseState`. |
| `full` | `(): BufferControlMessage` | Transitions to `WaitPauseState`; returns the capacity-hit message. |
| `clear`/`restart` | `(): void`/`(): undefined` | Transition to `InitState`. |
| `resume` | `(): undefined` | No-op. |

**Key data**
- `manager: BufferManagerLike` — back-reference for `change()`.

---

#### `WaitPauseState`

**File:** `src/player/mediaSession/videoSession/BufferManagerStates.ts`
**Type:** Class

**Purpose**
An intermediate state entered when the buffer fills up while playing (from `PlayState.full()`) — still ready to pop (draining the existing backlog) but awaiting an explicit pause to fully stop accepting new pushes at capacity.

**Responsibilities**
- `isReadyToPop()` remains `true` (frames keep draining); `push()` returns `false`.
- `pause()` transitions to `FullState` (the actually-paused-at-capacity state) rather than `PauseState` — distinguishing "paused because full" from a user-initiated pause from `PlayState`.
- `clear()` transitions to `InitState`; `full`/`restart`/`resume` are no-ops.

**Structure**
- Extends: —
- Implements: `BufferState`
- Subordinates (creates/uses): `FullState`, `InitState`
- Used by: `PlaybackBufferManager` (entered only from `PlayState.full()`).

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `isReadyToPop` | `(): boolean` | Always `true`. |
| `push` | `(): boolean` | Always `false`. |
| `pause` | `(): undefined` | Transitions to `FullState`. |
| `clear` | `(): void` | Transitions to `InitState`. |
| `full`/`restart`/`resume` | `(): undefined` | No-ops. |

**Key data**
- `manager: BufferManagerLike` — back-reference for `change()`.

---

#### `FullState`

**File:** `src/player/mediaSession/videoSession/BufferManagerStates.ts`
**Type:** Class

**Purpose**
The buffer-at-capacity, fully paused state — playback has stopped accepting pushes and is waiting for either a resume-triggering pause (`FakePauseState`) or a restart signal back into normal play.

**Responsibilities**
- `isReadyToPop()` is `true` (a full buffer still has poppable content) but `push()` returns `false` (no more capacity accepted while full).
- `pause()` — despite the state already being "paused" in effect — transitions to `FakePauseState` and returns a `BufferControlMessage` (`currentState: 'Pause'`) that's forwarded to the UI; the name `FakePauseState` reflects that this is a distinct pause-while-full sub-state rather than the ordinary `PauseState`.
- `restart()` transitions back to `PlayState` and returns a `BufferControlMessage` (error code `0x0501`) signaling playback has resumed from the full-buffer stall.
- `clear()` transitions to `InitState`.

**Structure**
- Extends: —
- Implements: `BufferState`
- Subordinates (creates/uses): `FakePauseState`, `PlayState`, `InitState`
- Used by: `PlaybackBufferManager` (entered from `WaitPauseState.pause()`).

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `isReadyToPop` | `(): boolean` | Always `true`. |
| `push` | `(): boolean` | Always `false`. |
| `pause` | `(): BufferControlMessage` | Transitions to `FakePauseState`; returns a "Pause" control message. |
| `restart` | `(): BufferControlMessage` | Transitions to `PlayState`; returns a "resumed" control message. |
| `clear` | `(): void` | Transitions to `InitState`. |
| `resume`/`full` | `(): undefined` | No-ops. |

**Key data**
- `manager: BufferManagerLike` — back-reference for `change()`.

---

#### `FakePauseState`

**File:** `src/player/mediaSession/videoSession/BufferManagerStates.ts`
**Type:** Class

**Purpose**
The explicitly-paused-while-full state (entered from `FullState.pause()`) — distinct from `PauseState` because the buffer was already saturated when the pause happened, so resuming goes back to `FullState` rather than `InitState`.

**Responsibilities**
- `isReadyToPop()` is `false` (genuinely stopped popping now); `push()` returns `false`.
- `resume()` transitions back to `FullState` and returns a `BufferControlMessage` (`currentState: 'Resume'`) for the UI.
- `clear()` transitions to `InitState`; `full`/`restart`/`pause` are no-ops.

**Structure**
- Extends: —
- Implements: `BufferState`
- Subordinates (creates/uses): `FullState`, `InitState`
- Used by: `PlaybackBufferManager` (entered only from `FullState.pause()`).

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `isReadyToPop` | `(): boolean` | Always `false`. |
| `push` | `(): boolean` | Always `false`. |
| `resume` | `(): BufferControlMessage` | Transitions to `FullState`; returns a "Resume" control message. |
| `clear` | `(): void` | Transitions to `InitState`. |
| `full`/`restart`/`pause` | `(): undefined` | No-ops. |

**Key data**
- `manager: BufferManagerLike` — back-reference for `change()`.

---

#### `PauseState`

**File:** `src/player/mediaSession/videoSession/BufferManagerStates.ts`
**Type:** Class

**Purpose**
The ordinary user-initiated pause state, entered from `PlayState.pause()` (i.e., paused while the buffer was *not* full) — resuming from here goes back to `InitState` rather than to a play state directly, requiring a fresh push to restart playback.

**Responsibilities**
- `isReadyToPop()` is `false`; `push()` returns `false`.
- `resume()` transitions to `InitState` (not directly back to `PlayState` — distinct from `FakePauseState.resume()`'s behavior of returning to `FullState`).
- `clear()` also transitions to `InitState`; `full`/`restart`/`pause` are no-ops.

**Structure**
- Extends: —
- Implements: `BufferState`
- Subordinates (creates/uses): `InitState`
- Used by: `PlaybackBufferManager` (entered only from `PlayState.pause()`).

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `isReadyToPop` | `(): boolean` | Always `false`. |
| `push` | `(): boolean` | Always `false`. |
| `resume` | `(): undefined` | Transitions to `InitState`. |
| `clear` | `(): void` | Transitions to `InitState`. |
| `full`/`restart`/`pause` | `(): undefined` | No-ops. |

**Key data**
- `manager: BufferManagerLike` — back-reference for `change()`.

**Design notes**
- `resume()`'s return type is `undefined` (unlike `FakePauseState.resume()`, which returns a `BufferControlMessage`) — resuming from an ordinary (non-full) pause is a silent transition with no UI message, since the buffer wasn't in an error/capacity condition when paused.

## 3. video/player & listen

### 3.1 video/player

#### `VideoPlayer`

**File:** `src/player/video/player/VideoPlayer.ts`
**Type:** Abstract class

**Purpose**
Common base for the two on-screen video rendering strategies (`<canvas>`-based decode-and-draw vs. `<video>`-tag MSE playback). It centralizes state and side-effecting accessors shared by both, and defines the contract a concrete player must implement.

**Responsibilities**
- Holds shared playback state: `boxsize`, `frameCount`s, `framedrop`, `frameRate`, delay/buffering knobs (`minRemainTime`, `minTimerInterval`, `maxdelay`/`currentdelay`).
- Exposes legacy-parity accessors as real TS getters/setters with side effects: `rfps` (feeds a 5-sample `CircularTypedArrayQueue`, computes variance via `Median`, classifies network state as poor/fair/good/very_good/excellent, and invokes `errorCallback` + `onNetworkState`), `audioshift`/`speed` (call `onChangeAudioShift`/`onChangeSpeed` before storing).
- Provides no-op default lifecycle hooks (`init`, `onVideoData`, `onWaitingPackets`, `play`/`pause`/`resume`/`stop`/`close`/`clearBuffer`) that subclasses override.
- Implements `addEventListener` for `statistics`/`capture`/`instantplayback` callback registration, and getters/setters for frame rate, max instant-playback threshold, buffer-clear interval, and delay.
- Declares `onNetworkState`, `onChangeAudioShift`, `onChangeSpeed`, `capture`, `toggleControls` as `abstract` — legacy has no base implementation for these at all, so both concrete subclasses must supply one.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): `CircularTypedArrayQueue`, `Median` (util/, referenced by name only)
- Used by: `CanvasTagPlayer`, `VideoTagPlayer` (both extend it)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `channelId`/`playmode`/`instantplayback`/`deviceType`/`codec` | accessor properties | plain stored accessors |
| `rfps` | accessor `number \| undefined` | setter drives network-state analysis + `onNetworkState` |
| `audioshift` / `speed` | accessor `number` | setters call `onChangeAudioShift`/`onChangeSpeed` before storing |
| `init` | `(element: unknown): void` | attach to a DOM element (no-op base) |
| `onVideoData` | `(playMode, streamData, videoInfo, codecInfo?): void` | feed a decoded/raw frame (no-op base) |
| `play`/`pause`/`resume`/`stop`/`close`/`clearBuffer` | `(): void` | playback lifecycle (no-op base) |
| `addEventListener` | `(event, callback): void` | registers `statistics`/`capture`/`instantplayback` callbacks |
| `setFrameRate`/`getFrameRate` | `(fps: number): void` / `(): number` | frame-rate accessor pair |
| `setErrorCallback` | `(func: VideoPlayerErrorCallback): void` | registers the error sink used by `rfps` and elsewhere |
| `onNetworkState`, `onChangeAudioShift`, `onChangeSpeed`, `capture`, `toggleControls` | abstract | must-override contract |

**Key data**
- `fpsQueue: CircularTypedArrayQueue<number>` — rolling 5-sample FPS history driving the `rfps` network-state classification.
- `errorCallback: VideoPlayerErrorCallback | undefined` — unset until `setErrorCallback` is called; calling `rfps`'s setter before that throws, preserved intentionally.

**Design notes**
- `VideoPlayer` is never directly instantiated (only `CanvasTagPlayer`/`VideoTagPlayer` do); the `abstract` modifier on the five methods is a compile-time stand-in for legacy's implicit "must override or crash at runtime" contract.
- `bufferingVideoData`/`sendToBufferManager`/`digitalZoom`/`controlStepPlay` are deliberately *not* declared here even though they look universal — they're `CanvasTagPlayer`-only in legacy; declaring them here would have wrongly forced `VideoTagPlayer` to implement something it never did (calling them on a real `VideoTagPlayer` throws `TypeError` by design).

---

#### `CanvasTagPlayer`

**File:** `src/player/video/player/canvas/CanvasTagPlayer.ts`
**Type:** Class

**Purpose**
Drives an off-screen decoder Worker (H264/H265) or an inline `<img>`-based MJPEG path and renders decoded frames onto a `<canvas>` via `CanvasRenderer`, supporting live playback, step-play (frame-by-frame forward/backward), and buffered playback through `PlaybackBufferManager`.

**Responsibilities**
- On `init()`, clones the given canvas element into the DOM, creates a `CanvasRenderer` and `StepBufferList`, wires a `webglcontextlost` listener, and starts a 1s FPS/bitrate statistics timer.
- On `onVideoData()`, lazily creates a codec-specific decoder Worker (`checkPlayer`/`createDecoderWorker`) for H264/H265, or schedules a size-dependent `setTimeout` MJPEG draw directly through `CanvasRenderer`; applies MJPEG frame-drop skipping (`checkFrameDrop`).
- Handles decoder Worker messages (`decoded`, `notReady`, `lowPerformance`, `terminated`) — pops buffered frames via `PlaybackBufferManager`, draws via `CanvasRenderer.draw`, resizes the canvas and fires resize/timestamp callbacks.
- Implements step-play (`forward`/`backward`/`controlStepPlay`) against `StepBufferList`, and buffered ingestion (`bufferingVideoData`, `sendToBufferManager`) that lazily creates a `PlaybackBufferManager`.
- Implements `capture` (delegates to `CanvasRenderer`), `digitalZoom`, `updateMiniMapInfo`, and full teardown in `close()` (removes listeners, terminates the decoder worker, destroys the renderer).

**Structure**
- Extends: `VideoPlayer`
- Implements: —
- Subordinates (creates/uses): `CanvasRenderer`, `StepBufferList`, `PlaybackBufferManager` (mediaSession/videoSession), a `decoderWorker` (Worker, via injectable `DecoderWorkerFactory`)
- Used by: `StreamPlayer` (`interface/StreamPlayer.ts`'s `createCanvasPlayer` factory)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `init` | `(element: HTMLCanvasElement): void` | clone+attach canvas, create renderer/step list, start stats timer |
| `onVideoData` | `(playMode, streamData: VideoStreamData, videoInfo: VideoInfo): void` | route MJPEG vs. H264/H265 frame to renderer/decoder |
| `bufferingVideoData` | `(playMode, streamData, videoInfo): boolean` | push into `StepBufferList` |
| `sendToBufferManager` | `(playMode, streamData, videoInfo, errorCallback): void` | push into (lazily-created) `PlaybackBufferManager` |
| `capture` | `(fileName: string): void` | trigger a PNG capture via `CanvasRenderer` |
| `play`/`pause`/`resume`/`stop` | `(): void` | toggle `renderer.userPaused` and buffer manager pause/resume |
| `forward`/`backward` | `(): boolean` | step-play via `StepBufferList` |
| `controlStepPlay` | `(timestamp, stepCmd): void` | seek `StepBufferList` to a timestamp and render the found I-frame |
| `digitalZoom` | `(bufferData: unknown): void` | delegate to `renderer.digitalZoom` |
| `close` | `(): void` | full teardown |
| `setTimeStampCallback`/`setResizeCallback` | `(func): void` | register callbacks used from decoder/resize paths |

**Key data**
- `renderer: CanvasRenderer | null` — owns the actual draw pipeline.
- `bufferManager: PlaybackBufferManager | null` — lazily created only when `sendToBufferManager` is first called.
- `stepVideoList: StepBufferList | null` — backs forward/backward step-play.
- `decoderWorker: Worker | null` — one per H264/H265 stream; never created for MJPEG.

**Design notes**
- Legacy stored all state in closures over a single `_self`; this port uses ordinary bound instance methods since every original call site read state through `_self`/module closures anyway — no special `this`-preserving trick was needed.
- `decoderCount` is a module-level counter (mirrors legacy's page-global `document.decoderCount`); nothing outside this file reads it.
- The `'decoded'` worker-message handler's `draw(data.frame, {})` intentionally passes an empty `videoInfo` — that parameter is only read on the MJPEG path, and `'decoded'` messages only ever occur for H264/H265.

---

#### `VideoTagPlayer`

**File:** `src/player/video/player/video/VideoTagPlayer.ts`
**Type:** Class

**Purpose**
Drives a `<video>` element via MediaSource Extensions: demuxes RTP-depacketized H264/H265 + AAC/G711/G726/OPUS frames into fragmented MP4 segments (built with the vendored `mp4Generator`) fed into a `SourceBuffer`, with A/V sync carried by VTTCue text tracks holding JSON timestamps.

**Responsibilities**
- `init()` wires up the `<video>` element (autoplay/controls/mute settings, ~20 native event listeners, a hidden "timestamp" text track, `beforeunload` cleanup) and creates a `MediaSource`.
- `onVideoData()`/`onAudioData()` buffer incoming video/audio samples, compute frame/segment durations (network-jitter-aware via a `CircularTypedArrayQueue` of RTP-timestamp deltas feeding `Median.variance`), and periodically flush video-only, audio-only, or dual-track fMP4 segments (`createVideoSegment`/`createAudioSegment`/`createSegment`) into `segmentArray`, appended to the `SourceBuffer` as it drains (`appendSegmentToSourceBuffer`).
- Manages live vs. Playback (DVR) buffering/seek heuristics in `videoUpdating`/`onWaiting`/`checkBufferSize`, browser-specific default delay/buffer-count tuning (Chrome/Safari/other), and instant-playback mode (`instantplaybackCmd`).
- Bridges G711/G726 audio through an `audiotranscoderWorker` (transcodes to AAC before muxing) while real AAC and OPUS are muxed natively; tracks codec-switch bookkeeping (`realAacActive`, `opusActive`, `sourceBufferAudioIsOpus`) since a `SourceBuffer`'s codecs string can't change after creation.
- Synthesizes dummy AAC audio (`makeDummyAudio`) to keep the audio track continuous when no real audio stream is present, and computes/report playback statistics (`getCurrentVideoFrame`, decoded/dropped-frame means).
- Implements `capture` (canvas-based video-frame snapshot + `saveAs`/callback), volume control, minimap updates, and teardown (`close`) that nulls the `SourceBuffer`/`MediaSource` refs to avoid stale-reference errors on reconnect.

**Structure**
- Extends: `VideoPlayer`
- Implements: —
- Subordinates (creates/uses): `vendor/mp4Generator` (`initSegment`/`mediaSegment`/`dualTrackMediaSegment`), `CircularTypedArrayQueue`, `Median`, `Mean`, `IntervalTimer` (util/), an `audiotranscoderWorker` (Worker, via injectable factory)
- Used by: `StreamPlayer` (`interface/StreamPlayer.ts`'s `createVideoPlayer` factory)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `init` | `(element: HTMLVideoElement): void` | attach video element, create MediaSource, wire listeners |
| `onVideoData` | `(playMode, streamData, videoInfo, codecInfo?): void` | ingest a video frame, build/flush fMP4 segments |
| `onAudioData` | `(playMode, streamData: AudioStreamData, audioInfo: AudioInfo): void` | ingest an audio frame (transcodes G711/G726, mux AAC/OPUS natively) |
| `onWaitingPackets` | `(event: WaitingEvent): void` | toggles `dummyAudio` when the audio interleaved stream is lost |
| `capture` | `(fileName: string): void` | snapshot current video frame to PNG |
| `play`/`pause`/`resume`/`close` | `(): void` | playback lifecycle |
| `instantplaybackCmd` | `(data: {cmd; currentTime?}): void` | init/play/pause/seek/terminate instant-playback mode |
| `setAudioInfo` | `(audioinfo): void` | (re)configure the audio track / decide codec switch |
| `setVideoInfo` | `(videoinfo, codecType): void` | build the video track's SPS/PPS/profile info box |
| `ControlVolume` | `(vol): void` | mute/unmute/volume |
| `digitalZoom`/`bufferingVideoData`/`controlStepPlay`/`sendToBufferManager` | — | always throw `TypeError`; stubbed only to satisfy the shared `VideoPlayerLike` structural type |

**Key data**
- `sourceBuffer`/`mediaSource` — the MSE plumbing all segment creation feeds.
- `segmentArray: Uint8Array[]` — queued fMP4 segments awaiting `appendBuffer`.
- `videoSamples`/`audioSamples` — per-track sample accumulators flushed into segments.
- `baseVideoTime`/`baseAudioTime`/`baseNTPTimestamp` — shared decode-time clock used for cue timing and A/V sync.
- `realAacActive`/`opusActive`/`sourceBufferAudioIsOpus` — audio-codec-switch state (see Design notes).

**Design notes**
- Kept as one cohesive class (matching legacy's single factory-function closure) rather than split up: virtually every method reads/mutates the same ~50 shared fields.
- MSE forbids changing a `SourceBuffer`'s codecs string after creation; if the real audio codec (Opus vs. AAC-family) doesn't match what the buffer was created with, `setAudioInfo` silently drops that stream's audio rather than attempting an unsafe remove+recreate (history shows that previously wedged the whole `MediaSource`).
- The first audio sample after (re)init is seeded with a fallback `duration` (`audioInfo.samplingDuration`) rather than left unset — an MP4 sample with duration 0 crashes Chrome's MSE audio decoder and kills playback after the first frame.
- `digitalZoom`/`bufferingVideoData`/`controlStepPlay`/`sendToBufferManager` are provably unreachable in the real wired-up system (MediaRouter always guards these behind `tagMode === 'canvas'`), but are stubbed to throw (matching legacy's real `TypeError` crash) purely so the class structurally satisfies `VideoPlayerLike`.
- Several legacy fields/branches confirmed 100% dead (write-only or unreachable, e.g. `getAudioFrameDuration`, `changeSourceBuffer`, `isCanPlay`, `videoSizeCallback`, `addBuffer`/`buildWaveHeader` WAV recorder) were dropped rather than ported as inert weight — see in-file NOTE comments.
- Box-level detail of the fMP4/ISOBMFF segments this class builds via `vendor/mp4Generator` (not itself a class, so out of this SDD's per-class scope) is documented separately in [docs/player/09-mp4-container-generation.md](player/09-mp4-container-generation.md).

---

#### `CanvasRenderer`

**File:** `src/player/video/player/canvas/CanvasRenderer.ts`
**Type:** Class

**Purpose**
Owns the actual drawing surface for `CanvasTagPlayer`: dispatches each decoded frame to the right low-level drawer (WebGL for H264/H265, plain 2D canvas for MJPEG), and handles capture/minimap/digital-zoom concerns generically over whichever drawer is active.

**Responsibilities**
- `setCanvas(codec, videoInfo)` lazily constructs the correct `Drawer` — a `YUVWebGLCanvas` for `H264`/`H265`, an `Image2DCanvas` for `MJPEG` — sized via `Size`.
- `draw()` routes MJPEG frames through an `Image` element (`Blob`/`ObjectURL` decode, then `drawCanvas`) vs. H264/H265 raw `Uint8Array` frame data straight to `drawCanvas`.
- `capture()`/`download()` implement PNG snapshot: flags the next draw to also call `canvas.toBlob`, then either `saveAs`-downloads it (named capture) or emits it via the registered `capture` event callback.
- `updateMinimapInfo()` lazily creates a second same-codec drawer (`mapDrawer`) targeting a minimap canvas element, and toggles whether it also receives each frame.
- `renewCanvas()`/`destroy()` clear/tear down both the main and minimap drawers.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): `YUVWebGLCanvas`, `Image2DCanvas` (same-file helper), `Size` (util/)
- Used by: `CanvasTagPlayer`

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `init` | `(element?: CanvasWithUpdatedFlag): void` | store the target canvas element |
| `setCanvas` | `(codec: string, videoInfo): void` | lazily create the WebGL or 2D drawer for the given codec |
| `draw` | `(frameData: Uint8Array, videoInfo, callback?): void` | draw a frame (MJPEG via `Image`, else raw buffer) |
| `capture` | `(name: string): void` | arm a PNG capture, drawing immediately if already paused with a cached frame |
| `renewCanvas` | `(): void` | clear the canvas via the active drawer |
| `digitalZoom` | `(bufferData: unknown): void` | calls `drawer.updateVertexArray` — always throws (see Design notes) |
| `updateMinimapInfo` | `(info: {mode, target?}): void` | create/toggle/tear down the minimap drawer |
| `destroy` | `(): void` | tear down main + minimap drawers |
| `addEventListener` | `(event: 'capture', callback): void` | register the capture-blob callback |

**Key data**
- `userPaused: boolean` — plain data property (see Design notes), gates redraw-on-capture behavior.
- `channelId: number \| undefined` — plain data property, settable by callers (e.g. `CanvasTagPlayer.init`).
- `drawer`/`mapDrawer: Drawer | null` — the active `YUVWebGLCanvas`/`Image2DCanvas` instance(s).

**Design notes**
- `channelId`/`userPaused` are plain mutable data fields, not accessors with side effects: legacy defined them via `Object.defineProperty` on the *factory function's own `this`*, but that factory does `return new Constructor()`, which (per JS `new` semantics) discards that `this` entirely — so neither accessor was ever actually installed on the real returned instance in legacy either. Ported faithfully as inert fields.
- `digitalZoom()` always throws `TypeError: drawer.updateVertexArray is not a function` when a drawer exists — `updateVertexArray` is commented out on both `WebGLCanvas`/`YUVWebGLCanvas` prototypes in legacy and `Image2DCanvas` never defined it either. A genuinely broken/dead feature, preserved as-is rather than "fixed."
- `Image2DCanvas` and `YUVWebGLCanvas` are unrelated by inheritance; `drawCanvas()` calls through a cast purely to give TypeScript a shared method signature (duck typing, matching legacy).

---

#### `Image2DCanvas`

**File:** `src/player/video/player/canvas/CanvasRenderer.ts` (un-exported helper class)
**Type:** Class

**Purpose**
Minimal 2D-canvas-context frame drawer used for the MJPEG codec path, where frames arrive as decodable `<img>` elements rather than raw YUV planes.

**Responsibilities**
- Sizes the canvas from an optional `Size` at construction.
- `drawCanvas(image)` resizes the canvas to the image's dimensions and blits it via `ctx.drawImage`.
- `initCanvas()` clears the canvas rect.
- `destroy()` is a no-op (nothing to release for a 2D context).

**Structure**
- Extends: —
- Implements: — (duck-types the same drawer shape as `YUVWebGLCanvas`)
- Subordinates (creates/uses): —
- Used by: `CanvasRenderer` (both `drawer` and `mapDrawer` roles, MJPEG codec only)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `constructor` | `(canvas, ctx: CanvasRenderingContext2D, size?: Size)` | optionally sizes the canvas |
| `drawCanvas` | `(image: HTMLImageElement): void` | resize canvas to image size and draw it |
| `initCanvas` | `(): void` | clear the canvas |
| `destroy` | `(): void` | no-op |

**Key data**
- None beyond the held `canvas`/`ctx` references.

---

#### `WebGLCanvas`

**File:** `src/player/video/player/canvas/webgl/WebGLCanvas.ts`
**Type:** Class

**Purpose**
Generic WebGL-backed canvas base: sets up a textured full-screen quad with vertex/fragment shaders and scene parameters, providing overridable hooks that `YUVWebGLCanvas` specializes for YUV→RGB video playback.

**Responsibilities**
- Constructor drives an ordered init sequence — `onInitWebGL` → `onInitShaders` → `initBuffers` → (optional) `initFramebuffer` → `onInitTextures` → `initScene` — sizing the canvas from `Size` and calling the (possibly subclass-overridden) hook methods.
- `initBuffers()` builds the vertex-position and texture-coordinate quad buffers, with an Edge-browser-specific texture-coordinate scale fix for non-16-divisible widths.
- `onInitShaders()`/`onInitTextures()`/`onInitSceneTextures()` provide the generic (non-YUV) default shader program/single RGBA texture setup.
- `drawScene()` issues the `TRIANGLE_STRIP` draw call; `readPixels()` reads back the framebuffer.
- `checkLastError()` inspects `gl.getError()` against a computed `glNames` lookup table built by enumerating the context's own numeric constants.
- `destroy()` releases all GL resources (framebuffer, renderbuffer, buffers, shaders, textures, program) and collapses the canvas to 1x1.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): `Shader`, `Program`, `Texture` (GLPrimitives.ts), `Size` (util/), `browserDetect` (util/)
- Used by: `YUVWebGLCanvas` (extends it)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `constructor` | `(canvas, gl: WebGLRenderingContext, size: Size, useFrameBuffer?: boolean)` | runs the full init sequence |
| `onInitWebGL`/`onInitShaders`/`onInitTextures`/`onInitSceneTextures` | `(): void` | overridable hooks (real methods, not field arrows — see Design notes) |
| `drawScene` | `(): void` | issue the draw call |
| `readPixels` | `(buffer: ArrayBufferView): void` | read back framebuffer pixels |
| `checkLastError` | `(operation?: string): void` | log the last GL error by name |
| `destroy` | `(): void` | release all GL resources |
| `toString` | `(): string` | debug label |

**Key data**
- `size: Size` — logical frame dimensions driving buffer/texture/viewport setup.
- `glNames: Record<number, string> | null` — reverse lookup of GL enum values to names, built once.
- `mvMatrix: Float32Array` — always the compile-time identity matrix (matrix math is otherwise dead — see Design notes).

**Design notes**
- `onInitWebGL`/`onInitShaders`/`onInitTextures`/`onInitSceneTextures` are real class methods (not field arrow functions) specifically so the base constructor's calls into them dispatch to a subclass override even during construction — matching legacy's prototype-based dispatch.
- `mvMultiply`/`mvTranslate`/`zoomScene` (the only call sites that would need real matrix math) are dead in the legacy source itself, so no matrix library is wired in — `mvMatrix` is always the identity matrix.
- `checkLastError`'s "unknown GL error code" branch throws a `ReferenceError` for an undeclared global (`value`) — a legacy quirk preserved verbatim; effectively unreachable with a real `WebGLRenderingContext`.

---

#### `YUVWebGLCanvas`

**File:** `src/player/video/player/canvas/webgl/YUVWebGLCanvas.ts`
**Type:** Class

**Purpose**
Specializes `WebGLCanvas` for YUV420P planar video frames — binds three separate luma/chroma textures and converts YUV→RGB in the fragment shader, used for the H264/H265 codec path.

**Responsibilities**
- Overrides `onInitShaders()` with a 3-texture fragment shader (`YTexture`/`UTexture`/`VTexture`) applying a hardcoded `YUV2RGB` conversion matrix.
- Overrides `onInitTextures()` to allocate the Y texture at full size and U/V textures at half size (`Size.getHalfSize()`).
- `drawCanvas(bufferData)` slices a single planar `Uint8Array` into Y/U/V subarrays (by luma/chroma size) and fills the three textures before calling `drawScene()`.
- `fillYUVTextures()` offers the same fill operation given three already-separated planes.
- Overrides `destroy()` to release the three textures before delegating to `WebGLCanvas.destroy()`.

**Structure**
- Extends: `WebGLCanvas`
- Implements: —
- Subordinates (creates/uses): `Shader`, `Program`, `Texture` (GLPrimitives.ts)
- Used by: `CanvasRenderer` (`drawer`/`mapDrawer` for H264/H265)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `drawCanvas` | `(bufferData: Uint8Array): void` | split planar buffer into Y/U/V, fill textures, draw |
| `fillYUVTextures` | `(y, u, v: Uint8Array): void` | fill textures from pre-split planes |
| `initCanvas` | `(): void` | clear depth+color buffers |
| `destroy` | `(): void` | release Y/U/V textures then base resources |

**Key data**
- `YTexture`/`UTexture`/`VTexture: Texture | null` — declared with `!` (definite assignment) since they're set inside `onInitTextures()`, called from the base constructor before subclass field initializers would otherwise run.

**Design notes**
- The `!` non-null field declarations (rather than `= null`) are load-bearing: subclass field initializers run *after* `super()` returns, which would otherwise stomp the values `onInitTextures()` already assigned during `super()`'s execution.

---

#### `Shader`

**File:** `src/player/video/player/canvas/webgl/GLPrimitives.ts`
**Type:** Class

**Purpose**
Thin wrapper around a single compiled `WebGLShader` (vertex or fragment), used by `WebGLCanvas`/`YUVWebGLCanvas` to build their shader programs.

**Responsibilities**
- Compiles a `ShaderScript` (`{type, source}`) into a `WebGLShader` of the correct type (`FRAGMENT_SHADER`/`VERTEX_SHADER`), logging (`glError`) on an unknown type or a compile failure.
- `destroy()` releases the shader via `gl.deleteShader`.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): —
- Used by: `WebGLCanvas`, `YUVWebGLCanvas` (both create vertex + fragment `Shader` instances)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `constructor` | `(gl: WebGLRenderingContext, script: ShaderScript)` | compile the shader |
| `destroy` | `(): void` | delete the underlying `WebGLShader` |

**Key data**
- `shader: WebGLShader | null` — the compiled shader handle.

---

#### `Program`

**File:** `src/player/video/player/canvas/webgl/GLPrimitives.ts`
**Type:** Class

**Purpose**
Thin wrapper around a `WebGLProgram`, used to attach/link/use a vertex+fragment `Shader` pair and set uniforms.

**Responsibilities**
- Creates the `WebGLProgram` at construction.
- `attach(shader)` attaches a compiled `Shader`; `link()` links the program (asserting `LINK_STATUS` via `glAssert`); `use()` activates it.
- `getAttributeLocation(name)` looks up a vertex attribute location; `setMatrixUniform(name, array)` uploads a 4x4 matrix uniform.
- `destroy()` releases the program.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): —
- Used by: `WebGLCanvas`, `YUVWebGLCanvas`

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `attach` | `(shader: Shader): void` | attach a shader to the program |
| `link` | `(): void` | link the program |
| `use` | `(): void` | activate the program |
| `getAttributeLocation` | `(name: string): number` | look up a vertex attribute location |
| `setMatrixUniform` | `(name: string, array: Float32Array): void` | upload a 4x4 uniform matrix |
| `destroy` | `(): void` | delete the program |

**Key data**
- `program: WebGLProgram | null`.

---

#### `Texture`

**File:** `src/player/video/player/canvas/webgl/GLPrimitives.ts`
**Type:** Class

**Purpose**
Thin wrapper around a single `WebGLTexture`, used for the generic RGBA texture in `WebGLCanvas` and the three Y/U/V luminance textures in `YUVWebGLCanvas`.

**Responsibilities**
- Allocates and configures a texture at construction (`NEAREST` filtering, `CLAMP_TO_EDGE` wrapping, format defaulting to `LUMINANCE`) sized from a `Size`.
- `fill(textureData, useTexSubImage2D?)` uploads pixel data via `texImage2D` (default, chosen for speed) or `texSubImage2D`, asserting the buffer is large enough.
- `bind(n, program, name)` activates `TEXTURE0`/`1`/`2` (lazily cached in a shared module-level `textureIDs` array) and binds the sampler uniform by name.
- `destroy()` releases the texture.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): —
- Used by: `WebGLCanvas` (one RGBA texture), `YUVWebGLCanvas` (Y/U/V textures)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `constructor` | `(gl, size: Size, format?: number)` | allocate and configure the texture |
| `fill` | `(textureData: Uint8Array, useTexSubImage2D?: boolean): void` | upload pixel data |
| `bind` | `(n: number, program: Program, name: string): void` | activate a texture unit and bind it to a shader sampler |
| `destroy` | `(): void` | delete the texture |

**Key data**
- `format: number` — texture format, defaults to `gl.LUMINANCE` (single-channel, used for Y/U/V planes).

**Design notes**
- `textureIDs` is a module-level (not instance-level) cache — shared across every `Texture` instance, harmless since `TEXTURE0`/`1`/`2` are the same enum values on any `WebGLRenderingContext`.

---

#### `StepBufferList`

**File:** `src/player/video/player/canvas/StepBufferList.ts`
**Type:** Class

**Purpose**
Ring-style buffer of recent video frames backing `CanvasTagPlayer`'s frame-by-frame step-play (forward/backward) feature.

**Responsibilities**
- `push()` appends a `{playMode, streamData, videoInfo}` node once the list is under `bufferingLength` (auto-tuned from stream framerate ×4 on the second push, clamped to [6, 240]), and reports back-pressure via its boolean return.
- `forward()`/`backward()` move `curIndex` and return the node at the new position; `backward()` additionally skips forward to the nearest I-frame/MJPEG frame; both `clear()` the list once the walk runs off either end.
- `searchTimestamp()` linear-scans to position `curIndex` at (or just past) a given RTP timestamp.
- `findIFrame(cmd)` walks from the current position in the given direction until it finds a `frameType === 'I'` node.
- `bufferClear()` resets the list.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): —
- Used by: `CanvasTagPlayer`

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `push` | `(playMode, streamData, videoInfo): boolean` | append a frame node; `false` once buffer is full |
| `forward`/`backward` | `(): StepBufferNode \| null` | step the cursor; `null` at either end (also clears) |
| `searchTimestamp` | `(frameTimestamp): void` | position the cursor at a given RTP timestamp |
| `findIFrame` | `(cmd: string): StepBufferNode \| undefined` | scan for the next I-frame in the given direction |
| `setBufferingLength` | `(length: number): void` | set/clamp the buffer capacity |
| `bufferClear` | `(): void` | reset the list |

**Key data**
- `stepList: StepBufferNode[]` — the buffered frame nodes.
- `bufferingLength: number` — capacity, auto-tuned from stream framerate, clamped to [`MIN_BUFFERING_LENGTH`=6, `MAX_BUFFERING_LENGTH`=240].
- `curIndex`/`listLength` — cursor and count.

**Design notes**
- Standalone (not extending a `BufferList` base) despite legacy grafting these methods onto a `BufferList` instance: `push`'s signature is incompatible with `BufferList.prototype.push`, and `BufferList`'s own `pop`/`getCurIdx`/`clear` are never called on a `StepBufferList` instance anywhere.
- The back-pressure check is written as `length >= bufferingLength ? false : true` (not the seemingly-equivalent `<`) specifically because they diverge when `bufferingLength` is `NaN` (possible via the framerate-based auto-tune) — `NaN` comparisons are always `false`, so the two forms pick different branches in that case.

### 3.2 listen

#### `AudioDecoder`

**File:** `src/player/listen/decoder/AudioDecoder.ts`
**Type:** Class

**Purpose**
Minimal base class establishing the shared shape (`channelId`, `decode`, `close`) that concrete per-codec audio decoders extend or duck-type against.

**Responsibilities**
- Declares `channelId` (used by subclasses for error reporting).
- Provides no-op default `decode()` (returns `undefined`) and `close()`.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): —
- Used by: `AACAudioDecoder`, `G711AudioDecoder`, `G726_16_AudioDecoder`, `G726_24_AudioDecoder`, `G726_32_AudioDecoder`, `G726_40_AudioDecoder`, `OPUSAudioDecoder` (extend it); `AudioPlayerGxx` (consumes instances via the structural `AudioDecoderLike` interface)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `decode` | `(buffer: unknown): unknown` | no-op base, overridden by every subclass |
| `close` | `(): void` | no-op base |

**Key data**
- `channelId: number` — defaults to 0; set externally (e.g. by `AudioPlayerGxx.audioInit`).

**Design notes**
- `G726xAudioDecoder` does **not** extend this class — it's a runtime dispatcher/facade over the four `G726_xx` bitrate decoders, not a decoder itself.

---

#### `AACAudioDecoder`

**File:** `src/player/listen/decoder/AACAudioDecoder.ts`
**Type:** Class

**Purpose**
Decodes AAC RTP payloads to PCM on the main thread by wrapping the vendored `ffmpegAAC.js` asm.js build.

**Responsibilities**
- Constructor binds three `Module.cwrap`-exposed native functions (`init_aac_jsFFmpeg`, `decode_aac_jsFFmpeg`, `close_jsFFmpeg`) and calls `init()`.
- `init()` (re)creates the native decode context and allocates a 4096-float output buffer (`Module._malloc` + a `Float32Array` view over the Emscripten heap).
- `decode(buffer)` calls the native decoder, copies the first 1024 samples of the output buffer into a fresh `Float32Array`, and returns it; returns `null` (cast) once `close()` has been called.
- `close()` releases the native decode context.

**Structure**
- Extends: `AudioDecoder`
- Implements: —
- Subordinates (creates/uses): global `Module` (vendored asm.js build, assumed pre-loaded)
- Used by: `AudioPlayerGxx` (via `aacAudioDecoderFactory`, for `codecType === 'AAC'`)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `init` | `(): void` | (re)create the native decode context and output buffer |
| `decode` | `(buffer: ArrayLike<number>): Float32Array` | decode one AAC frame to 1024 PCM samples |
| `close` | `(): void` | release the native decode context |

**Key data**
- `context: number | null` — native decoder context handle; `null` means closed/uninitialized.
- `outpic: Float32Array` — view over Emscripten heap memory holding raw decoder output.

**Design notes**
- Assumes the vendor build's global `Module` is already loaded via a `<script>` tag before construction — wiring that load step is the concern of `elements/RTSPOverWebSocket.ts`, not this class.
- `decode()` returning `null` after `close()` (via an unsafe cast) preserves a real legacy behavior rather than widening the shared `AudioDecoderLike.decode()` contract to `Float32Array | null`.

---

#### `G711AudioDecoder`

**File:** `src/player/listen/decoder/G711AudioDecoder.ts`
**Type:** Class

**Purpose**
Decodes G.711 μ-law/A-law RTP payloads to normalized PCM.

**Responsibilities**
- `decode(buffer)` runs each input byte through `ulaw2linearPcm` or `alaw2linearPcm` depending on `this.mime`, producing 16-bit PCM, then normalizes to `[-1, 1]` `Float32Array` by dividing by 2^15.
- Throws `RTSPOverWebSocketError` for an unrecognized `mime` value (unreachable in practice — `mime` is only ever set to `PCMU`/`PCMA` by callers).

**Structure**
- Extends: `AudioDecoder`
- Implements: —
- Subordinates (creates/uses): —
- Used by: `AudioPlayerGxx` (for `codecType === 'G711'`)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `mime` | `G711Mime` (`'PCMU'` \| `'PCMA'`) | selects μ-law vs. A-law decode |
| `decode` | `(buffer: ArrayLike<number>): Float32Array` | decode one G.711 packet to normalized PCM |

**Key data**
- `mime: G711Mime` — set by the caller (`AudioPlayerGxx.audioInit`) before decoding, defaults to `'PCMU'`.

---

#### `G726_16_AudioDecoder`

**File:** `src/player/listen/decoder/G726_16_AudioDecoder.ts`
**Type:** Class

**Purpose**
Decodes 16 kbit/s G.726 ADPCM audio (2-bit codewords, 4 samples per input byte) to 16-bit linear PCM.

**Responsibilities**
- Maintains G.726 predictor/quantizer state (`G726State`) via `CommonAudioUtil` (predictor_zero/predictor_pole/step_size/reconstruct/update).
- `decodeSample(i, outCoding)` reconstructs one sample from a 2-bit codeword.
- `decode(buffer)` unpacks each input byte into four 2-bit codewords (bit-shifted `>>6`/`>>4`/`>>2`/`>>0`) and decodes each to a 16-bit sample.

**Structure**
- Extends: `AudioDecoder`
- Implements: —
- Subordinates (creates/uses): `CommonAudioUtil` (util/)
- Used by: `G726xAudioDecoder` (for `bits === 16`)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `decode` | `(buffer: ArrayLike<number>): Int16Array` | decode a 16 kbit/s G.726 packet |

**Key data**
- `state: G726State` — running predictor/quantizer state, mutated per sample.

**Design notes** (applies to all four `G726_xx_AudioDecoder` variants)
- All four decoders share identical structure (`CommonAudioUtil`-backed predictor state machine, a `decodeSample` helper, a `decode` bit-unpacking loop) and differ only in: the codeword bit-width (2/3/4/5 bits, masked via `0x03`/`0x07`/`0x0f`/`0x1f`), the `DQLNTAB`/`WITAB`/`FITAB` quantization tables (sized to match the codeword width), the `update()` call's rate-selector argument (`2`/`3`/`4`/`5`), and the input-byte-to-codeword unpacking arithmetic (bytes-per-codeword-group: 1/3/2/5 for 16/24/32/40 respectively). `G726_32` additionally clamps its output to the `Int16` range (`32767`/`-32768`) before returning, and shifts `WITAB[i]` left by 5 in its `update()` call — a difference from the other three not otherwise explained in-source.

---

#### `G726_24_AudioDecoder`

**File:** `src/player/listen/decoder/G726_24_AudioDecoder.ts`
**Type:** Class

**Purpose**
Decodes 24 kbit/s G.726 ADPCM audio (3-bit codewords, packed 8 samples per 3 input bytes) to 16-bit linear PCM.

**Responsibilities**
- Same predictor-state-machine shape as `G726_16_AudioDecoder`, parameterized for 3-bit codewords (`DQLNTAB`/`WITAB`/`FITAB` sized 8, `update()` rate selector `3`).
- `decode(buffer)` unpacks 8 codewords from each 3-byte group via cross-byte bit shifts.

**Structure**
- Extends: `AudioDecoder`
- Implements: —
- Subordinates (creates/uses): `CommonAudioUtil` (util/)
- Used by: `G726xAudioDecoder` (for `bits === 24`)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `decode` | `(buffer: ArrayLike<number>): Int16Array` | decode a 24 kbit/s G.726 packet |

**Key data**
- `state: G726State`.

(See `G726_16_AudioDecoder`'s Design notes for the cross-variant comparison.)

---

#### `G726_32_AudioDecoder`

**File:** `src/player/listen/decoder/G726_32_AudioDecoder.ts`
**Type:** Class

**Purpose**
Decodes 32 kbit/s G.726 ADPCM audio (4-bit codewords, 2 samples per input byte) to 16-bit linear PCM — the most common G.726 bitrate.

**Responsibilities**
- Same predictor-state-machine shape, parameterized for 4-bit codewords (`DQLNTAB`/`WITAB`/`FITAB` sized 16, `update()` rate selector `4`, `WITAB[i]` additionally left-shifted by 5).
- `decode(buffer)` unpacks 2 codewords per byte (high/low nibble) and clamps each decoded sample to `[-32768, 32767]` before returning (the only variant that does).

**Structure**
- Extends: `AudioDecoder`
- Implements: —
- Subordinates (creates/uses): `CommonAudioUtil` (util/)
- Used by: `G726xAudioDecoder` (for `bits === 32`)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `decode` | `(buffer: ArrayLike<number>): Int16Array` | decode a 32 kbit/s G.726 packet |

**Key data**
- `state: G726State`.

(See `G726_16_AudioDecoder`'s Design notes for the cross-variant comparison.)

---

#### `G726_40_AudioDecoder`

**File:** `src/player/listen/decoder/G726_40_AudioDecoder.ts`
**Type:** Class

**Purpose**
Decodes 40 kbit/s G.726 ADPCM audio (5-bit codewords, packed 8 samples per 5 input bytes) to 16-bit linear PCM.

**Responsibilities**
- Same predictor-state-machine shape, parameterized for 5-bit codewords (`DQLNTAB`/`WITAB`/`FITAB` sized 32, `update()` rate selector `5`; reconstruct/clamp masks widened to `0x7fff`).
- `decode(buffer)` unpacks 8 codewords from each 5-byte group via cross-byte bit shifts.

**Structure**
- Extends: `AudioDecoder`
- Implements: —
- Subordinates (creates/uses): `CommonAudioUtil` (util/)
- Used by: `G726xAudioDecoder` (for `bits === 40`)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `decode` | `(buffer: ArrayLike<number>): Int16Array` | decode a 40 kbit/s G.726 packet |

**Key data**
- `state: G726State`.

(See `G726_16_AudioDecoder`'s Design notes for the cross-variant comparison.)

---

#### `G726xAudioDecoder`

**File:** `src/player/listen/decoder/G726xAudioDecoder.ts`
**Type:** Class

**Purpose**
Runtime dispatcher/facade that selects and owns one of the four `G726_xx_AudioDecoder` bitrate variants based on the stream's declared bitrate, and normalizes its output to `[-1, 1]` PCM.

**Responsibilities**
- Constructor takes a `bits` value (16/24/32/40) and instantiates the matching `G726_xx_AudioDecoder`; logs `'wrong bits'` and leaves `decoder` as `null` for any other value.
- `decode(data)` delegates to the selected decoder's `decode()`, then rescales its `Int16Array` output to a normalized `Float32Array` (divide by 2^15), matching the other decoders' output convention.

**Structure**
- Extends: — (does **not** extend `AudioDecoder`)
- Implements: —
- Subordinates (creates/uses): `G726_16_AudioDecoder`, `G726_24_AudioDecoder`, `G726_32_AudioDecoder`, `G726_40_AudioDecoder` (creates exactly one, chosen by `bits`)
- Used by: `AudioPlayerGxx` (for any `codecType` not `G711`/`AAC`/`OPUS`, i.e. the G.726 family)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `constructor` | `(bits: 16 \| 24 \| 32 \| 40)` | select and construct the matching bitrate decoder |
| `decode` | `(data: ArrayLike<number>): Float32Array` | decode via the selected decoder, normalized to `[-1, 1]` |

**Key data**
- `decoder: G726Decoder | null` — the selected variant; `null` (and `decode()` throws on null-dereference) if `bits` didn't match one of the four known values.

**Design notes**
- Has no `channelId` field, unlike every `AudioDecoder` subclass — `AudioPlayerGxx.audioInit` still unconditionally assigns `.channelId` to it (a write-only assignment on this type), matching a legacy quirk rather than special-casing it away.

---

#### `OPUSAudioDecoder`

**File:** `src/player/listen/decoder/OPUSAudioDecoder.ts`
**Type:** Class

**Purpose**
Decodes Opus RTP payloads to PCM using the browser's native WebCodecs `AudioDecoder` API — unlike the other codecs, there is no vendored WASM/asm.js Opus decoder in this repo.

**Responsibilities**
- Constructor throws `RTSPOverWebSocketError` if `window.AudioDecoder` (WebCodecs) is unavailable; otherwise creates and `configure()`s one for `codec: 'opus'`, fixed `sampleRate: 48000` (per RFC 7587 §4.1), `numberOfChannels: 1` (mono; see Design notes).
- `decode(buffer)` wraps the input in an `EncodedAudioChunk` with a monotonically-increasing synthetic timestamp and feeds it to the WebCodecs decoder; **returns whatever was already decoded and queued from earlier packets**, not this call's own output (see Design notes on the async/sync bridge).
- `onDecodedOutput` (the WebCodecs `output` callback) copies each decoded `AudioData`'s samples into a `Float32Array` and pushes it onto an internal FIFO (`pending`), then closes the `AudioData`.
- `close()` empties the pending queue and closes the WebCodecs decoder if not already closed.

**Structure**
- Extends: `AudioDecoder` (imported aliased as `AudioDecoderBase`)
- Implements: —
- Subordinates (creates/uses): native `window.AudioDecoder`/`window.EncodedAudioChunk` (WebCodecs)
- Used by: `AudioPlayerGxx` (for `codecType === 'OPUS'`)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `decode` | `(buffer: ArrayLike<number>): Float32Array` | feed a packet in, return whatever's already decoded (FIFO, possibly empty) |
| `close` | `(): void` | clear pending queue and close the WebCodecs decoder |

**Key data**
- `pending: Float32Array[]` — FIFO of decoded-but-not-yet-returned PCM chunks, bridging WebCodecs' async `output` callback to this class's synchronous `decode()` contract.
- `nextTimestampUs`/`lastFrameSamples` — synthetic monotonically-increasing chunk timestamp tracking, since Opus RTP packets don't carry their own duration.

**Design notes**
- `decode()`'s return value lags one (or more) calls behind its input by design: WebCodecs decodes asynchronously via the `output` callback, but the shared `AudioDecoderLike.decode()` contract (and `AudioPlayerGxx.BufferAudio`'s call site) expects a synchronous return. Early calls may return an empty `Float32Array(0)`, which `AudioPlayerGxx.playAudioIn` already handles safely as a reset/skip.
- Channel count is hardcoded to mono (`OPUS_CHANNELS = 1`): RFC 7587 mandates the SDP-level channel count always reads 2 regardless of the real channel count, and this player doesn't currently parse the `stereo`/`sprop-stereo` fmtp attributes that would carry the real value — acceptable since camera microphones are overwhelmingly mono in practice.
- Decode errors from the WebCodecs `error` callback are silently swallowed (no failure path exists in `BufferAudio`'s call chain), matching how the other decoders have no error-reporting path either.

---

#### `AudioPlayer`

**File:** `src/player/listen/renderer/AudioPlayer.ts`
**Type:** Class

**Purpose**
Base class defining the common playback-control surface (`AudioPlayerAAC`/`AudioPlayerGxx` extend it) that `MediaRouter`/`StreamPlayer` drive via the shared `AudioPlayerLike` interface.

**Responsibilities**
- Declares `channelId` and an `error` event registration (`addEventListener`).
- Provides no-op default implementations of `audioInit`, `isInit`, `Play`, `Stop`, `BufferAudio`, `ControlVolume` — all overridden by the concrete subclasses.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): —
- Used by: `AudioPlayerAAC`, `AudioPlayerGxx` (both extend it)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `addEventListener` | `(event: 'error', callbackFunc?): void` | register the error callback |
| `audioInit` | `(...args: unknown[]): unknown` | no-op base, overridden per renderer |
| `isInit` | `(): unknown` | no-op base |
| `Play`/`Stop` | `(): void` | no-op base |
| `BufferAudio` | `(...args: unknown[]): void` | no-op base |
| `ControlVolume` | `(...args: unknown[]): void` | no-op base |

**Key data**
- `channelId: number` — defaults to 0.
- `errorCallbackFunc?: AudioPlayerErrorCallback` — set via `addEventListener('error', ...)`.

---

#### `AudioPlayerAAC`

**File:** `src/player/listen/renderer/AudioPlayerAAC.ts`
**Type:** Class

**Purpose**
Plays AAC audio via a hidden `<audio>` element backed by an MSE `SourceBuffer` — an alternative audio rendering path to `AudioPlayerGxx`'s Web Audio API approach, for browsers/streams where native AAC-via-MSE is preferable.

**Responsibilities**
- `audioInit()` creates a detached `<audio>` element, picks `audio/x-aac` (Safari) vs. `audio/aac` MIME, and creates a `MediaSource` if the MIME type is supported, wiring `sourceopen`/`sourceclose`/`sourceended`/`error`/`abort` listeners.
- `BufferAudio(data, rtpTimestamp)` accumulates raw AAC bytes into `segmentBuffer`, detecting a timestamp gap (>200ms or negative) to trigger a re-buffering flag/reset, and appends to the `SourceBuffer` once not `updating`, with buffering-flag-aware start-position trimming (`startPosArray`/`videoDiffTime`) to align audio resumption with video's current position.
- `ControlVolume`/`GetVolume` scale a 0–5 UI volume value to the `<audio>` element's 0–1 volume.
- `setBufferingFlag`/`setInitVideoTimeStamp`/`getInitVideoTimeStamp` coordinate A/V resync bookkeeping with the video player.

**Structure**
- Extends: `AudioPlayer`
- Implements: —
- Subordinates (creates/uses): a detached `<audio>` element, `MediaSource`/`SourceBuffer`
- Used by: — (exported from `listen/renderer/index.ts` but not instantiated anywhere in production code; `StreamPlayer` wires `AudioPlayerGxx` instead — see Design notes)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `audioInit` | `(codecType, codecMime, bitrate, volume): boolean` | create `<audio>` + `MediaSource`, return whether playback is available |
| `isInit` | `(): boolean` | whether the `SourceBuffer` exists |
| `Play`/`Stop` | `(): void` | restore/zero volume |
| `BufferAudio` | `(data: ArrayLike<number>, rtpTimestamp: number): void` | queue+append AAC bytes to the `SourceBuffer` |
| `ControlVolume`/`GetVolume` | `(vol): void` / `(): number` | volume control |
| `setBufferingFlag`/`getBufferingFlag` | — | A/V resync bookkeeping |
| `setInitVideoTimeStamp`/`getInitVideoTimeStamp` | — | A/V resync bookkeeping |

**Key data**
- `mediaSource`/`sourceBuffer`/`audio` — the MSE playback plumbing.
- `segmentBuffer: Uint8Array` — accumulated raw AAC bytes awaiting `appendBuffer`.
- `bufferingFlag`/`startPosArray`/`videoDiffTime` — resync state used to trim stale audio when catching up to video's current position.

**Design notes**
- Not currently wired into the live player: `StreamPlayer.ts`'s `createAudioPlayer` factory constructs `AudioPlayerGxx`, not `AudioPlayerAAC` — this class exists as an alternative/legacy-parity renderer but has no confirmed production call site in this codebase.
- The `WebKitMediaSource` vendor-prefix fallback legacy had is dropped; `window.MediaSource` is referenced directly (no currently-supported browser needs the prefix).

---

#### `AudioPlayerGxx`

**File:** `src/player/listen/renderer/AudioPlayerGxx.ts`
**Type:** Class

**Purpose**
The production audio rendering path: decodes and plays G.711/G.726x/AAC/OPUS audio via the Web Audio API, scheduling decoded PCM through `AudioBufferSourceNode`s rather than MSE.

**Responsibilities**
- `audioInit(codecType, codecMime, bitrate, volume)` selects and constructs the matching decoder — `G711AudioDecoder` (mime set from `codecMime`), `AACAudioDecoder` (via injectable `aacAudioDecoderFactory`), `OPUSAudioDecoder`, or `G726xAudioDecoder` (bitrate-selected) — and lazily builds the `AudioContext`/`GainNode`/`BiquadFilterNode` (lowpass, 1000Hz, gain 25) graph once.
- `BufferAudio(data, rtpTimestamp)` decodes via the selected decoder then calls `playAudioIn` to accumulate/schedule PCM.
- `playAudioIn` detects timestamp gaps (>200ms or negative) to reset/re-buffer, accumulates decoded float samples into a growable `playBuffer`, and schedules an `AudioBufferSourceNode` at `nextStartTime` once enough data has accumulated — with Safari-specific 8kHz→32kHz upsampling (`upsampling8Kto32K`, a Hermite-like interpolation) since Safari's Web Audio doesn't support arbitrary low sample rates well.
- `ControlVolume`/`GetVolume`/`Stop` scale a 0–5 UI volume to the `GainNode`'s gain.
- `terminate()` closes the `AudioContext` and closes the AAC/OPUS decoder (the only two with real resources to release via `close()`).

**Structure**
- Extends: `AudioPlayer`
- Implements: —
- Subordinates (creates/uses): `G711AudioDecoder`, `G726xAudioDecoder`, `AACAudioDecoder`, `OPUSAudioDecoder` (picks one per stream codec), `AudioContext`/`GainNode`/`BiquadFilterNode`/`AudioBufferSourceNode` (Web Audio API)
- Used by: `StreamPlayer` (`interface/StreamPlayer.ts`'s `createAudioPlayer` factory)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `audioInit` | `(codecType, codecMime, bitrate, volume): boolean` | select decoder, build/reuse the Web Audio graph |
| `isInit` | `(): boolean` | whether a decoder is selected |
| `Play`/`Stop` | `(): void` | restore/zero gain |
| `BufferAudio` | `(data: ArrayLike<number>, rtpTimestamp: number): void` | decode + schedule playback (only while `isRunning`) |
| `ControlVolume`/`GetVolume` | `(vol): void` / `(): number` | gain control |
| `terminate` | `(): void` | close `AudioContext` and decoder resources |
| `setBufferingFlag`/`getBufferingFlag` | — | A/V resync bookkeeping |
| `setInitVideoTimeStamp`/`getInitVideoTimeStamp` | — | A/V resync bookkeeping |

**Key data**
- `audioDecoder: AudioDecoderLike | null` — the currently selected codec decoder.
- `audioContext`/`gainInNode`/`biquadFilter` — the Web Audio graph; `isRunning` tracks whether the context is in the `'running'` state (gated `BufferAudio` no-ops otherwise).
- `playBuffer: Float32Array` — growable (in 80000-sample chunks) accumulation buffer for decoded PCM awaiting scheduling.
- `nextStartTime` — Web Audio scheduling clock for gapless `AudioBufferSourceNode` chaining.

**Design notes**
- `aacAudioDecoderFactory` and `audioContextFactory` are constructor-injectable (defaulting to real `AACAudioDecoder`/`AudioContext`) specifically so tests can substitute fakes without needing the vendored asm.js `Module` global loaded or a real audio device.
- The `webkitAudioContext` vendor-prefix polyfill legacy had is dropped — no currently-supported browser needs it.
- This is the renderer actually wired up by `StreamPlayer` for all live audio playback in this codebase; `AudioPlayerAAC` (the MSE-based alternative) is not currently instantiated in production.

## 4. talk / backup / worker

### 4.1 talk

#### `Talk`

**File:** `src/player/talk/Talk.ts`
**Type:** Class

**Purpose**
Captures local microphone audio via the Web Audio API and streams raw PCM chunks to a caller-supplied callback, implementing the outbound ("talk-back") side of two-way audio.

**Responsibilities**
- Lazily creates and owns an `AudioContext` (via an injectable factory, defaulting to `new AudioContext()`).
- Wires a `GainNode` → `ScriptProcessorNode` (4096-sample buffer) chain and, on `onaudioprocess`, forwards the raw `Float32Array` channel-0 samples to a registered callback while streaming.
- Opens the local microphone stream with `navigator.mediaDevices.getUserMedia` under fixed constraints (echo cancellation/noise suppression/AGC disabled), rejecting with an `RTSPOverWebSocketError` (errorCode `0x0211`) if unavailable.
- Provides volume control (`controlVolumeOut`, mapping a 0–20-ish external volume scale to a 0–10 gain range) and stream lifecycle management (`stopAudioOut`, `terminate`).
- Exposes `setSendAudioTalkBufferCallback` so a driver can receive the raw PCM stream for further encoding/packetization.

**Structure**
- Extends: —
- Implements: — (conforms structurally to the `TalkLike` interface consumed by `MediaRouter`, in `mediaSession/MediaRouter.ts`)
- Subordinates (creates/uses): `RTSPOverWebSocketError` (exceptions), `fromHex` (util) — no dependency on `G711AudioEncoder` at the source level (see Design notes)
- Used by: `StreamPlayer` (interface/, different group — constructs it via `createTalk: () => new Talk()`), `MediaRouter` (mediaSession/, different group — drives it through the `TalkLike` interface)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `channelId` | `number` | Public field identifying the talk channel; used in error reporting. |
| `init` | `(): boolean` | Lazily constructs the `AudioContext`; returns `false` if construction throws. |
| `initAudioOut` | `(): Promise<number>` | Builds the gain/script-processor graph, opens the mic via `getUserMedia`, resolves with the local sample rate. |
| `controlVolumeOut` | `(volume: number): void` | Maps an external volume value to gain (clamped 0–10). |
| `stopAudioOut` | `(): void` | Stops all audio tracks of the current local stream; must call `initAudioOut` again to restart. |
| `terminate` | `(): void` | Stops audio out and closes the `AudioContext`; clears graph nodes. |
| `setSendAudioTalkBufferCallback` | `(callbackFn: (data: Float32Array) => void): void` | Registers the callback invoked with each raw PCM chunk while streaming. |

**Key data**
- `sendAudioBufferCallback: ((data: Float32Array) => void) | null` — the registered outbound-audio sink; only invoked while `isStreaming` is true.
- `isStreaming: boolean` / `currentLocalStream: MediaStream | null` — gate whether captured audio is actually forwarded.
- `constraints` — fixed `getUserMedia` constraints, including a legacy Chrome-only `mandatory.googAutoGainControl` key kept for fidelity (harmless if ignored by the browser).

**Design notes**
- Despite the assignment note that "`Talk` drives `G711AudioEncoder`," the source shows no reference from `Talk.ts` to `G711AudioEncoder` at all — `Talk` only produces raw `Float32Array` PCM via its callback. The actual G.711 encoding happens one layer down, in `AudioTalkSession` (`mediaSession/audioSession/AudioTalkSession.ts`, a different group's file), which owns a `G711AudioEncoder` instance and calls `.encode()` inside `getRTPPacket()`. The "drives" relationship is therefore a data-flow relationship through the pipeline (Talk's callback output eventually reaches `AudioTalkSession.getRTPPacket`), not a direct class dependency.
- Several legacy branches are deliberately dropped as confirmed-dead code per the file's own doc comment: `cleanBuffer()` (references undeclared variables, would throw under strict mode, never called), and the vendor-prefixed `getUserMedia` polyfill block (unreachable in evergreen browsers, and TypeScript's DOM types guarantee the unprefixed API exists).

---

#### `G711AudioEncoder`

**File:** `src/player/talk/encoder/G711AudioEncoder.ts`
**Type:** Class

**Purpose**
Encodes 32-bit float PCM audio to 8 kHz G.711 μ-law for outbound talk-back audio, including downsampling from the local hardware sample rate to the fixed 8000 Hz codec rate.

**Responsibilities**
- Tracks the caller's local (hardware) sample rate via `setSampleRate`.
- Downsamples an input `Float32Array` buffer from the local rate to 8000 Hz by block-averaging, carrying over any leftover (non-integral) tail samples into the next `encode()` call via `remainBuffer`.
- Converts float samples to 16-bit PCM, then linear-PCM-to-μ-law (`lin2Mulaw`) per sample.
- Reports its fixed codec info (`{ type: 'G.711', samplingRate: 8000 }`) via `getCodecInfo()`.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): —
- Used by: `AudioTalkSession` (`mediaSession/audioSession/AudioTalkSession.ts`, different group — constructs one instance per session and calls `encode()` from `getRTPPacket()`)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `setSampleRate` | `(sampleRate: number): void` | Sets the source (hardware) sample rate used for downsampling. |
| `encode` | `(buffer: Float32Array): Uint8Array` | Downsamples to 8 kHz and μ-law-encodes; returns one byte per output sample. |
| `getCodecInfo` | `(): G711CodecInfo` | Returns `{ type, samplingRate }` describing the fixed output codec. |

**Key data**
- `remainBuffer: Float32Array | null` — leftover samples from the previous downsample call that didn't cleanly divide into an output sample; prepended to the next `encode()` input.
- `localSampleRate: number` — defaults to 48000 until `setSampleRate` is called.

**Design notes**
- `downsampleBuffer` throws a plain string (`'Downsampling rate show be smaller than original sample rate'`, typo preserved) rather than an `Error`/`RTSPOverWebSocketError`, if asked to "downsample" to a rate higher than the current local rate.
- μ-law encoding (`lin2Mulaw`) follows the standard G.711 bias/segment-table algorithm (`BIAS = 0x84`, 8-segment table `SEG_END`), operating on 16-bit signed PCM.

---

### 4.2 backup (main thread)

#### `BackupProvider`

**File:** `src/player/backup/BackupProvider.ts`
**Type:** Class

**Purpose**
Main-thread façade that owns the backup Worker per channel, forwarding live video/audio frames into it for AVI encoding and relaying the Worker's file-assembly messages to a single shared `FileMaker`.

**Responsibilities**
- Spawns a `backupWorker.ts` Worker (via an injectable factory) on `init()` and posts a `'start'` message describing the backup session (channel, filename, device type, password, split, gmt).
- Lazily creates a single **module-level shared** `FileMaker` (`sharedFileMaker`) the first time any `BackupProvider` starts a backup, and (re)configures its password/compress-callback on every `init()`.
- Translates incoming `VideoStreamData`/`VideoInfo` and `AudioStreamData`/`AudioInfo` (from `mediaSession`) into plain frame-info messages (`sendVideoFrame`/`sendAudioFrame`) posted to the Worker, gated by an internal `WAIT`/`PROCESSING`/`DONE` status machine.
- Dispatches the Worker's `onmessage` events by type: `'backup'` frames are forwarded to `sharedFileMaker.processMessage`, `'backupResult'`/`'timestamp'` are forwarded to caller-supplied callbacks.
- `closeStream()` posts a `'stop'` message to end the session and resets status to `WAIT`.

**Structure**
- Extends: —
- Implements: — (conforms structurally to the `BackupProviderLike` interface consumed by `MediaRouter`, in `mediaSession/MediaRouter.ts`)
- Subordinates (creates/uses): `FileMaker` (module-shared singleton, not per-instance), a `Worker` running `worker/backup/backupWorker.ts` (entry point, not a class)
- Used by: `StreamPlayer` (interface/, different group — via `createBackupProvider: () => new BackupProvider()`), `MediaRouter` (mediaSession/, different group — drives it through the `BackupProviderLike` interface)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `channelId` | `number` | Channel this provider backs up. |
| `deviceType` | `string \| undefined` | Device type forwarded to the Worker's session (affects AVI filename/format decisions). |
| `init` | `(data: BackupInitData): void` | Starts a new backup: spawns the Worker, wires the shared `FileMaker`, posts `'start'`. |
| `onVideoData` | `(streamData: VideoStreamData, videoInfo: VideoInfo): void` | Forwards one video frame to the Worker as `sendVideoFrame`. |
| `receiveAudioData` | `(streamData: AudioStreamData, audioInfo: AudioInfo): void` | Forwards one audio frame to the Worker as `sendAudioFrame`. |
| `closeStream` | `(): void` | Posts `'stop'` to the Worker and resets state. |

**Key data**
- `sharedFileMaker: FileMaker | null` (module-level, not an instance field) — one `FileMaker` shared across every `BackupProvider` instance, matching legacy's module-scoped singleton; constructed on whichever channel starts a backup first.
- `backupStatus` — `WAIT` (0) / `PROCESSING` (1) / `DONE` (2); gates whether incoming frames are actually forwarded to the Worker.

**Design notes**
- The `sharedFileMaker` singleton means all channels' backups funnel through one `FileMaker`, matching a legacy `var fileMaker = null;` declared outside the per-instance factory closure — this is a faithful port of shared (not per-channel) file-assembly state, not a bug.
- `backupWorkerMessage` is bound as an arrow-captured method here (legacy assigned it unbound as `backupWorker.onmessage = this.backupWorkerMessage`), but since its body never reads `this`, the difference has no observable effect.

---

#### `FileMaker`

**File:** `src/player/backup/FileMaker.ts`
**Type:** Class

**Purpose**
Assembles the AVI (or password-protected ZIP-wrapped AVI) backup file from the header/body/tail pieces `BackupProvider` streams in from the backup Worker, then saves it via `file-saver`.

**Responsibilities**
- Accumulates four kinds of incoming pieces — main header, body chunks, tail header, tail (index) chunks — keyed by `processMessage`'s `target` argument (`'mainHeader' | 'body' | 'tailHeader' | 'tailBody' | 'save'`).
- On `'save'`, concatenates header + body parts + tail header + tail parts into one ordered array and either zips it (if a password was set) or saves it directly as a `.avi` `Blob`.
- For ZIP output, spawns a `zipWorker.ts` Worker (via an injectable factory), transfers the buffers to it, and on the Worker's response wraps the compressed result in a `Blob` and saves it as `.zip`; fires `compressCallback` with `COMPRESS_START`/`COMPRESS_STOP` error codes (`0x060C`/`0x060D`) around the operation.
- Clears its accumulated state (`clearMemory`) after each completed save.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): a `Worker` running `worker/backup/zipWorker.ts` (entry point, not a class), `saveAs` (file-saver library)
- Used by: `BackupProvider` (`backup/BackupProvider.ts`, as the module-shared `sharedFileMaker` singleton)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `processMessage` | `(target: string, data: unknown): void` | Routes an incoming piece (`mainHeader`/`body`/`tailHeader`/`tailBody`/`save`) to the right accumulator or triggers file creation. |
| `setPassword` | `(password: string \| null): void` | Sets the ZIP password; a non-null password routes output through `createZipFile` instead of `createAviFile`. |
| `setCompressCallback` | `(callback: (errorCode: number) => void): void` | Registers the callback fired with `COMPRESS_START`/`COMPRESS_STOP` codes during ZIP creation. |

**Key data**
- `header: unknown`, `parts: unknown[]`, `tailHeader: unknown`, `tails: unknown[]` — the accumulated AVI file pieces, in the order they'll be concatenated at save time.
- `zipPassword: string | null` — when set, routes the finished file through the ZIP worker instead of saving a plain `.avi`.
- `blob: Blob | null` — cached finished blob; invalidated (`null`) whenever a new body part arrives.

---

### 4.3 worker/backup

#### `AviFormatWriter`

**File:** `src/player/worker/backup/AviFormatWriter.ts`
**Type:** Class

**Purpose**
Shared low-level binary writer for the AVI/RIFF container format — provides the primitive byte/int/string writers and the structural AVI header/index-entry builders that `VideoHeader`, `AudioHeader`, and `AviFileWriter` all build on.

**Responsibilities**
- Provides raw little-endian binary writers into an internal `Uint8Array` buffer: `writeInt8`/`writeInt16`/`writeInt32`/`writeString`/`writeChunkHeader`/`appendBuffer`.
- Builds and serializes the AVI **main header** (`initMainHeader`/`writeMainHeader`/`writeAviMainHeader`, including the `RIFF`/`AVI `/`LIST hdrl` framing) and per-stream **stream header**/**format** blocks (`writeStreamHeader`, `writeBitmapInfo` for video, `writeWaveFormatEx` for audio).
- Builds AVI index entries (`getIndexBuffer`, supporting "dummy" padding entries for variable-frame-rate video) and the trailing `idx1` tail header (`writeAviTailHeader`).
- Writes the `JUNK` padding chunk (`writeJunk`) used to keep the fixed 2048-byte header region aligned before the `movi` list begins.
- Exposes getters/setters for `mainHeader`/`streamHeader`/`streamFormat`/`aviIndexEntry`/`chunkHeader`/error code, plus derived helpers `getDuration()`, `setResolution()`, `getAviSampleSize()`.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): —
- Used by: `VideoHeader`, `AudioHeader` (both `extends AviFormatWriter`), `AviFileWriter` (composes a private `AviFormatWriter` instance)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `setBuffer` | `(buffer: Uint8Array): void` | Resets the active write buffer and cursor. |
| `writeInt8`/`writeInt16`/`writeInt32` | `(val: number): void` | Little-endian primitive writers, advancing the cursor. |
| `writeString` | `(str: string): void` | Writes ASCII bytes (4-byte-advance no-op for `''`, matching AVI FourCC placeholder slots). |
| `writeChunkHeader` | `(dummyCountInput?: number): void` | Writes an AVI chunk header, optionally preceded by `dummyCount` zero-payload padding chunks. |
| `initMainHeader` | `(frameInfo: {framerate, width, height}): void` | Populates `mainHeader` fields (fourCC `'avih'`, flags, dimensions, etc.). |
| `writeMainHeader`/`writeStreamHeader`/`writeBitmapInfo`/`writeWaveFormatEx` | `(): void` | Serialize the corresponding struct from current state into the buffer. |
| `writeAviMainHeader` | `(fileSize: number): Uint8Array` | Writes the full `RIFF`/`AVI `/`LIST hdrl` + main header block into a fresh 2048-byte buffer. |
| `getVideoHeader`/`getAudioHeader` | `(): Uint8Array` | Serialize a `LIST strl` block (stream header + format) for video/audio respectively. |
| `writeJunk` | `(pos: number): Uint8Array` | Pads out to the fixed header size with a `JUNK` chunk, then opens the `LIST movi` chunk. |
| `writeAviTailHeader` | `(tailSize: number): Uint8Array` | Writes the `idx1` tail chunk header. |
| `getIndexBuffer` | `(): Uint8Array` | Serializes one (or more, with dummy padding) AVI index entries. |
| `getMainHeader`/`setMainHeader`, `getStreamHeader`/`setStreamHeader`, `getStreamFormat`/`setStreamFormat`, `getIndexEntry`/`setIndexEntry`, `setChunkHeader` | accessor pairs | Struct-level get/set used by subclasses. |
| `getChunkPayloadSize`/`setErrorCode`/`getErrorCode`/`getTotalFrames`/`getDuration` | various | Derived read accessors. |
| `setResolution` | `(w: number, h: number, fps: number): void` | Updates stream header/format dimensions and buffer-size estimate together. |
| `getAviSampleSize` | `(): number` | Computes bytes-per-sample from `BitsPerSample`/`Channels` (minimum 1). |

**Key data**
- `buffer: Uint8Array`, `bufferIndex: number` — the active write target and cursor; reset by every `setBuffer` call (each "write a block" method allocates its own buffer).
- `mainHeader`/`streamHeader`/`streamFormat`/`aviIndexEntry`/`chunkHeader` — the AVI struct state being accumulated/serialized.

**Design notes**
- Ported as a real `extends`-able base class from legacy's `inheritObject(new AviFormatWriter(), {...})` composition pattern — legitimate here for `VideoHeader`/`AudioHeader` since their overrides share the base method signatures, unlike `AviFileWriter` (see its own notes).
- Legacy's `aviHeader`/`pos` constructor state is confirmed write-only (no read site anywhere in the AVI-writer family) and is dropped entirely.
- `AviStreamHeader.aviInitialFrames` is set by `VideoHeader`/`AudioHeader` but `writeStreamHeader()` always writes a hardcoded `0` in its place — confirmed write-only, kept only for data fidelity.

---

#### `AviFileWriter`

**File:** `src/player/worker/backup/AviFileWriter.ts`
**Type:** Class

**Purpose**
Top-level per-session AVI writer that `BackupSession` drives directly, delegating stream-type-specific work (video vs. audio) to an owned `VideoHeader`/`AudioHeader` pair while using a private `AviFormatWriter` for the file-level (main header / junk / tail) framing.

**Responsibilities**
- Dispatches `initHeader`/`updateInfo`/`getErrorCode`/`getChunkPayloadSize`/`getIdxBuffer` calls to `createVideoHeader` or `createAudioHeader` based on a `'video' | 'audio'` type tag.
- Assembles the full AVI header block (`makeAviHeader`): pulls `aviTotalFrames` from the video header, writes the main header, appends the serialized video and audio `strl` headers, then writes the `JUNK`/`movi` padding.
- Builds the AVI tail (`makeAviTail`, delegating to the composed `AviFormatWriter`'s `writeAviTailHeader`).
- Forwards resolution updates (`setResolution`) to the video header only.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): `AviFormatWriter` (private composed instance), `VideoHeader`, `AudioHeader` (both owned, one each)
- Used by: `BackupSession` (`worker/backup/BackupSession.ts`, constructs one instance in `init()`)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `initHeader` | `(type: 'video'\|'audio', frameInfo: VideoBackupFrame): void` | Initializes main header (video path only) and the relevant per-type header. |
| `updateInfo` | `(type, frameInfo, fileInfo): Uint8Array \| null` | Delegates to `VideoHeader.updateInfo`/`AudioHeader.updateInfo`; returns the serialized chunk header or `null` on a codec/profile-change error. |
| `getErrorCode` | `(type: 'video'\|'audio'): number` | Reads the last error code from the relevant header. |
| `getChunkPayloadSize` | `(type: 'video'\|'audio'): number \| undefined` | Reads the last chunk's payload size. |
| `getIdxBuffer` | `(type: 'video'\|'audio'): Uint8Array` | Reads the serialized index entry for the last frame. |
| `getDuration` | `(): number` | Video-stream duration in seconds (delegates to `VideoHeader.getDuration`). |
| `makeAviHeader` | `(fileSize: number, filePos: number): Uint8Array` | Builds the complete AVI header block including both stream headers and the `movi` padding. |
| `makeAviTail` | `(tailSize: number): Uint8Array` | Builds the `idx1` tail chunk header. |
| `setResolution` | `(width: number, height: number, fps: number): void` | Forwards to the video header. |

**Design notes**
- Composition, not inheritance: legacy builds this via `inheritObject(new AviFormatWriter(), {...})`, which copies override methods onto a fresh `AviFormatWriter` instance rather than classically subclassing it. Several overrides (`getErrorCode`, `getChunkPayloadSize`) take a `type` parameter the base `AviFormatWriter` method signature doesn't have, which a real `extends` relationship couldn't type-check safely — hence this is ported as a private composed `AviFormatWriter` field with explicit forwarding, matching what `inheritObject` actually does at runtime.

---

#### `AudioHeader`

**File:** `src/player/worker/backup/AudioHeader.ts`
**Type:** Class

**Purpose**
Builds the AVI audio stream header and format block for backup audio, supporting AAC, G.711, and G.726 codecs, and produces the per-frame chunk header/index-entry data as audio frames arrive.

**Responsibilities**
- `initHeader()` resets the stream header/format to codec-agnostic defaults.
- Per-codec setup methods (`settingAAC`, `settingG711`, `settingG726`) populate rate/format/bitrate-specific fields; `makeAudioConfig` encodes AAC-LC `AudioConfig` bits from sample rate + channel count.
- `checkAudioFrameInfo` validates that codec/bitrate/sampling-rate haven't changed mid-session (first frame initializes `fileInfo`; later frames must match or it signals `-1`, i.e. `CODEC_CHANGED`).
- `updateInfo` (override) is the per-frame entry point: re-applies the codec setting, updates the running length/byte totals, computes the AVI index entry (`01wb` chunk id) and chunk header, writes the chunk header into the buffer, and returns it (or `null` on a codec-change error, after calling `setErrorCode(-1)`).

**Structure**
- Extends: `AviFormatWriter`
- Implements: —
- Subordinates (creates/uses): —
- Used by: `AviFileWriter` (`worker/backup/AviFileWriter.ts`, owns one instance as `createAudioHeader`)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `initHeader` | `(): void` | Resets stream header/format to defaults. |
| `settingAAC` | `(audioFrame: AudioBackupFrame): void` | Configures AAC-LC stream header/format fields. |
| `settingG711` | `(): void` | Configures fixed 8 kHz/8-bit μ-law header/format fields. |
| `settingG726` | `(audioFrame: AudioBackupFrame): void` | Configures header/format fields by G.726 bitrate tier (16/24/32/40 kbps). |
| `checkAudioFrameInfo` | `(audioFrame, fileInfo): number` | Initializes or validates per-session codec consistency; `0` ok, `-1` codec/param changed. |
| `updateInfo` | `(audioFrame: AudioBackupFrame, fileInfo: AudioBackupFileInfo): Uint8Array \| null` | Per-frame update: applies codec settings, updates length, builds index entry + chunk header. |

**Key data**
- Inherited `streamHeader`/`streamFormat`/`aviIndexEntry`/`chunkHeader` (from `AviFormatWriter`) hold the current AVI struct state for the audio stream.

**Design notes**
- `settingG726` has a preserved legacy typo: `audioFormat.aviSuggestedBufferSize = audioHeader.aviRate;` assigns into the **format** struct's field of that name rather than the header's — kept faithfully (documented as write-only/never read by any writer) rather than "fixed."
- `aviInitialFrames` is set here but never read by `AviFormatWriter.writeStreamHeader()` (which hardcodes `0`); kept for data fidelity only.

---

#### `VideoHeader`

**File:** `src/player/worker/backup/VideoHeader.ts`
**Type:** Class

**Purpose**
Builds the AVI video stream header and format block, and tracks per-frame index entries including "dummy frame" padding used to keep variable-frame-rate source video in sync with AVI's constant-frame-rate timeline.

**Responsibilities**
- `initHeader(videoFrame)` populates the stream header (fourCC `strh`, type `vids`, handler = codec fourCC, scale/rate derived from framerate) and format block (`strf`, 24-bit RGB placeholder, `SizeImage`).
- `updateInfo` (override) is the per-frame entry point: on the first frame, calls `initHeader` and records width/height/compressor; on later frames, validates the codec and resolution haven't changed (returns `null` + sets error code `-1` "CODEC_CHANGED" or `-2` "PROFILE_CHANGED" otherwise).
- Computes `dummycount` — the number of padding index entries to insert — from the gap between the current frame's `sourceInputMs` and the last frame's timestamp versus the expected per-frame interval (`rate`), resetting to 0 if the gap exceeds `DUMMY_COUNT_RESET_THRESHOLD` (210 frames).
- Builds the `00dc` chunk header/index entry (flag `0x10` for I-frames) and writes the chunk header (with dummy-padding) into the buffer.

**Structure**
- Extends: `AviFormatWriter`
- Implements: —
- Subordinates (creates/uses): —
- Used by: `AviFileWriter` (`worker/backup/AviFileWriter.ts`, owns one instance as `createVideoHeader`)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `initHeader` | `(videoFrame: VideoBackupFrame): void` | Populates stream header/format from the first frame's codec/dimensions/framerate. |
| `updateInfo` | `(videoFrame: VideoBackupFrame, fileInfo: VideoBackupFileInfo): Uint8Array \| null` | Per-frame update: validates codec/resolution consistency, computes dummy-frame padding, builds index entry + chunk header. |

**Key data**
- `fileInfo.last_ms` / stream header's own `last_ms` — track the source timestamp of the last written frame, used to compute inter-frame gaps for dummy-frame insertion.

**Design notes**
- The "dummy frame" mechanism is the key non-obvious behavior: when a source frame arrives later (in source time) than expected for the target constant frame rate, `VideoHeader` inserts `dummycount` zero-payload padding chunks (via `writeChunkHeader(dummycount)`) so the AVI's fixed-rate timeline stays aligned with real elapsed time, rather than simply writing frames back-to-back.

---

#### `BackupSession`

**File:** `src/player/worker/backup/BackupSession.ts`
**Type:** Class

**Purpose**
Runs inside the backup Worker (`backupWorker.ts`) and drives a single backup recording end-to-end: consumes incoming video/audio frames, feeds them to an `AviFileWriter`, streams the resulting AVI body chunks back to the main thread, and handles max-size/max-duration-triggered file splits or session termination.

**Responsibilities**
- `init()`/constructor creates a fresh `AviFileWriter` (`this.createAviFile = new AviFileWriter()`) and resets session state (`isPlayback`, `filename`).
- `onVideoData`/`onAudioData` normalize incoming raw frame-info messages into `VideoBackupFrame`/`AudioBackupFrame` shape (codec-name remapping, e.g. `'MJPEG'` → `'MJPG'`, `'H265'` → `'HEVC'`; fixed sampling-rate/bitrate lookup per audio codec), call `createAviFile.updateInfo`, and stream the resulting header + frame bytes back via `sendMessage('backup', { target: 'body', ... })`.
- Enforces file-size limits (`checkMaxSize`, thresholds vary: 500 MiB plain AVI / 300 MiB when splitting / 250 MiB when ZIP-encrypted) and a max single-file duration (5 minutes, skipped while in `isPlayback` mode), triggering either a `fileSplit()` (starts a fresh file, same session) or `endSession()` (closes the Worker).
- On codec/profile-change errors (from `AviFileWriter.getErrorCode`), either splits the file (if split mode enabled, re-establishing on the next I-frame) or ends the session with an error result.
- Builds the final filename (`makeFileName`, from codec/resolution/audio-codec/timestamp) when none was explicitly set, and formats session start/end times (`toDateFormat`/`formatYYYYMMDDHHMMSS`, deriving UTC offset from the running machine's own timezone string).
- `endSession()` writes the final AVI header/tail, sends a `'backup'` `'save'` message and a `'backupResult'` message, then calls `closeWorker()` (the injected `close()` wrapper) and clears state.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): `AviFileWriter` (creates one via `new AviFileWriter()` in `init()`); imports `VideoBackupFrame`/`AudioBackupFrame` types only from `VideoHeader.ts`/`AudioHeader.ts` — it does **not** construct `VideoHeader`/`AudioHeader` directly (that happens inside `AviFileWriter`, which owns both)
- Used by: `backupWorker.ts` (entry point, not a class — constructs one `BackupSession` per `'start'` message, driving it via `onVideoData`/`onAudioData`/`endSession`)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `channelId`/`deviceType`/`filename`/`gmt` | accessor properties | Session metadata; `filename` falls back to `makeFileName()` when unset. |
| `isPlayback` | `boolean` (public field) | Set from outside (by `backupWorker.ts`) when incoming messages carry `playMode === 'Playback'`; suppresses the max-duration auto-split/end while true. |
| `init` | `(channelId?: number): void` | (Re)initializes session state and creates a fresh `AviFileWriter`. |
| `setZipEncrypt` | `(value: boolean): void` | Selects the ZIP-encrypted file-size threshold. |
| `split` | `(): void` | Enables split-on-max-size/codec-change mode instead of ending the session. |
| `onVideoData` | `(frameInfo: BackupVideoFrameInfo, streamData: Uint8Array): void` | Processes one incoming video frame. |
| `onAudioData` | `(frameInfo: BackupAudioFrameInfo, streamData: Uint8Array): void` | Processes one incoming audio frame. |
| `endSession` | `(): void` | Finalizes the current file (header/tail/save), reports the result, and closes the worker. |

**Key data**
- `fileInfo: BackupFileInfo | null` — `{ pos, tailSize, width?, height?, fileSize? }`, the running write-position/size state for the current file; `null` until the first frame arrives, reset to `null` on split.
- `videoFrame`/`audioFrame` — the most recently normalized per-stream frame descriptors, reused across `updateInfo` calls.
- `startDate`/`endDate: BackupTimeInfo` — first/last frame source timestamps, used for filenames and split-boundary reporting.

**Design notes**
- Confirms the assignment's open question: `BackupSession` does not directly instantiate `AudioHeader`/`VideoHeader` — it only imports their frame-shape types (`VideoBackupFrame`, `AudioBackupFrame`) and delegates all header work through the single `AviFileWriter` it owns.
- `isPlayback` is intentionally a plain public field (not private), mirroring a legacy module-scope variable shared between `backupWorker.ts`'s dispatch function and the session's own methods — `init()` still resets it to `false` on construction, but it's set to `true` from outside by `backupWorker.ts` when a later message signals playback mode.
- Worker message contract (via the injected `sendMessage` callback, matching `backupWorker.ts`'s `postMessage({ type, data })`): `'backupResult'` (status/error/completion), `'timestamp'` (per-frame source timestamp echo), `'backup'` with `target` of `'mainHeader' | 'body' | 'tailHeader' | 'tailBody' | 'save'` (consumed by `BackupProvider`/`FileMaker` on the main thread).

---

### 4.4 other workers

#### `AssemblyDecoder`

**File:** `src/player/worker/videoDecoder/AssemblyDecoder.ts`
**Type:** Class

**Purpose**
Wraps the vendored ffmpeg.js/ffmpeg.wasm build to decode H.264/H.265 video frames inside the video-decoder Worker, bridging the WASM `Module.cwrap`'d C functions to a small TypeScript API.

**Responsibilities**
- Fetches the vendored `ffmpeg.wasm` binary and assigns it to `Module.wasmBinary` *before* `importScripts`-ing the glue script `ffmpeg.js` (the glue's synchronous `createWasm()` reads `Module.wasmBinary` at the top of its own execution).
- On `Module.onRuntimeInitialized`, binds four native functions via `Module.cwrap` (`init_jsFFmpeg`, `context_jsFFmpeg`, `decode_video_jsFFmpeg`, `close_jsFFmpeg`), initializes the decoder, and opens a decode context for the given codec (H264 → ID 264, H265 → ID 265).
- `decode(data)` only proceeds once an I-frame has been seen (gate: `iFrameCheck`); allocates an output buffer in WASM heap memory, calls the native decode function, copies the result out, frees the WASM buffer, and returns the copy (or `null` if no context / not yet ready).
- Fires a caller-registered `onDecoderReady` callback once initialization completes.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): — (no dependency on any other src/player class; interacts only with the global vendored `Module`/WASM runtime)
- Used by: `decoderWorker.ts` (entry point, not a class — owns the single `AssemblyDecoder` instance, applies drop-frame heuristics, and relays decoded frames back via `postMessage`)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `channelId` | `number` | Public field identifying the decode channel, echoed in outgoing messages. |
| `addListener` | `(eventType: 'onDecoderReady', callback: DecoderReadyCallback): void` | Registers the ready callback. |
| `init` | `(): void` | (Re)opens a decode context for this decoder's codec ID; closes any prior context first. |
| `close` | `(): void` | Closes the current decode context. |
| `setOutputSize` | `(size: number): void` | Sets the output buffer size (only applied if `size > 0`). |
| `decode` | `(data: AssemblyDecoderFrame): Uint8Array \| null` | Decodes one frame; `null` if no context or waiting for the first I-frame. |

**Key data**
- `context: number | null` — the native decode context handle from `context_jsFFmpeg`.
- `iFrameCheck: boolean` — latches `true` once the first I-frame is decoded; gates all subsequent P/B-frame decode calls.
- `outpicsize: number` — size of the WASM-heap output buffer allocated per `decode()` call.

**Design notes**
- Worker-boundary message contract (via `decoderWorker.ts`, not this class): inbound `{type: 'createDecoder', data: codecType, channelId}` / `{type: 'decode', data: DecoderWorkerFrame}` / `{type: 'setOutputSize'|'setDecoderIndex'|'useDropPacket'|'setFrameRate'|'playMode', data}` / `{type: 'terminate'}`; outbound `{type: 'decoded', data: {channelId, frame, time, width, height, cropWidth, cropHeight, receiveClock}}` / `{type: 'lowPerformance', data}` / `{type: 'terminated', data}` / `{type: 'notReady'}`. All payloads are plain data — no references to main-thread classes cross the boundary.
- `checkPerformance`-gated legacy branches (an alternate 5-arg `cwrap` signature and extra interval timing) are confirmed dead (`checkPerformance` hardcoded `false`, never reassigned) and dropped.

---

#### `AssemblyTranscoder`

**File:** `src/player/worker/audioTranscoder/AssemblyTranscoder.ts`
**Type:** Class

**Purpose**
Wraps a separate vendored ffmpeg-based WASM build (`ffmpegAAC.transcoder.js`/`.wasm`) to transcode G.711/G.726 backup audio to AAC inside the audio-transcoder Worker, for use when producing AAC-audio backup files from non-AAC source audio.

**Responsibilities**
- Fetches `ffmpegAAC.transcoder.wasm`, assigns it to `Module.wasmBinary`, then `importScripts`-s `ffmpegAAC.transcoder.js` (same wasmBinary-before-glue-script ordering constraint as `AssemblyDecoder`).
- On `Module.onRuntimeInitialized`, binds six native functions (`openAudioDecoder`, `open_AACEncoder`, `trans2AAC_pushAudio`, `trans2AAC_getAAC`, `close_audioDecoder`, `close_aacEncoder`) and calls `init(codecType)`.
- `init` opens an AAC encoder context and a source-codec decoder context (`openDecoder`), and allocates a fixed 4096-byte output buffer in WASM heap memory.
- `openDecoder` maps `'G711'` → native codec id `1`, `'G726'` → id `3`, opening/replacing the decoder context at the given bit rate.
- `transcode(data)` pushes the input frame through the native decode→re-encode pipeline and reads back the AAC bytes; returns `undefined` if the native call reports an error (`ret < 0`).

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): — (no dependency on any other src/player class)
- Used by: `audiotranscoderWorker.ts` (entry point, not a class — owns the single `AssemblyTranscoder` instance and relays transcoded AAC frames via `postMessage`)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `addListener` | `(eventType: 'onTranscoderReady', callback: TranscoderReadyCallback): void` | Registers the ready callback. |
| `init` | `(info: TranscoderCodecInfo): void` | Opens the AAC encoder and source decoder, allocates the output buffer. |
| `openDecoder` | `(info: TranscoderCodecInfo): void` | (Re)opens the source-codec decoder context at the given bit rate. |
| `close` | `(): void` | Closes decoder and encoder contexts, drops the output buffer reference. |
| `transcode` | `(data: Uint8Array): Uint8Array \| undefined` | Transcodes one frame of source audio to AAC; `undefined` on native error. |

**Key data**
- `encoderContext`/`decoderContext: number | null` — native WASM context handles.
- `output: Uint8Array | null` — fixed 4096-byte WASM-heap output buffer reused across `transcode()` calls.

**Design notes**
- A legacy bug is preserved faithfully: `outputSize` (the size limit passed to `trans2AAC_getAAC`) is always `0` — a module-scope variable initialized once and never reassigned in the original — despite `output` itself being a real 4096-byte buffer. Not "fixed" to `4096`.
- Worker-boundary message contract (via `audiotranscoderWorker.ts`): inbound `{type: 'init', data: TranscoderCodecInfo}` / `{type: 'transcode', data: {frameData, timeStamp?, ...}}` / `{type: 'terminate'}`; outbound `{type: 'transcoded', data}` (frame buffer transferred, not copied) / `{type: 'terminated', data: null}`. `audiotranscoderWorker.ts` has a preserved legacy bug of its own: no null-check on `transcode()`'s possible `undefined` return before reading `.length` on it.

---

#### `MjpegDepacketizer`

**File:** `src/player/worker/mjpegSession/MjpegDepacketizer.ts`
**Type:** Class

**Purpose**
Runs inside the MJPEG-depacketize Worker, reassembling fragmented RTP/JPEG payloads (RFC 2435) back into complete JFIF-framed JPEG images for MJPEG video streams, including synthesizing a full JPEG header (quantization/Huffman tables) that RTP/JPEG payloads omit.

**Responsibilities**
- `depacketize(rtspInterleaved, rtpHeader, rtpPayload)` parses the RTP header (padding/extension/CSRC-count/marker bits), reads the RTP/JPEG payload header's fragment offset, and either starts a new frame (offset 0 → synthesizes a JFIF header via `createjpegheader`/`makeJPEGHeader`) or appends payload continuation bytes, skipping the appropriate per-fragment special-header size (`getspecialheadersize`).
- `createjpegheader`/`makeJPEGHeader` build a standards-compliant JPEG bitstream header (SOI, APP0/JFIF, optional DRI, DQT quantization tables — either extracted from the RTP payload or synthesized via `makeDefaultQtables` from the payload's Q factor —, SOF0, Huffman tables via `createHuffmanHeader`, SOS) matching the frame's advertised width/height/type.
- `parseExtensionHeader` decodes an optional RTP header extension carrying NTP-derived timestamp/timezone/object-ID metadata (camera vs. NVR device-type-specific layouts), updating a running framerate estimate from consecutive timestamp deltas.
- On the RTP marker bit (end of frame), `frameDataReturn` concatenates the buffered payload fragments into one JPEG frame buffer and invokes the registered `gotFrameCallback` with the assembled `MjpegFrameData` (stream data + video info).

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): — (no dependency on any other src/player class; pure binary/RTP parsing)
- Used by: `mjpegDepacketizeWorker.ts` (entry point, not a class — owns the single `MjpegDepacketizer` instance, buffers incoming RTP entries, and relays completed frames via `postMessage`)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `interleavedId` | `number \| undefined` (accessor) | RTSP interleaved-channel id, echoed into output stream data. |
| `deviceType` | `'camera' \| 'nvr' \| string` (accessor) | Selects device-specific RTP-extension-header parsing layout. |
| `init` | `(callback?: (data: MjpegFrameData) => void): void` | Resets playback state; optionally sets the frame callback. |
| `setGotFrameCallback` | `(callback: (data: MjpegFrameData) => void): void` | Registers the callback invoked once a full frame is reassembled. |
| `depacketize` | `(rtspInterleaved: Uint8Array, rtpHeader: Uint8Array, rtpPayload: Uint8Array): void` | Processes one RTP/JPEG packet, possibly completing and emitting a frame. |

**Key data**
- `payloadBuffer: Uint8Array[]` — fragments accumulated for the frame currently being assembled; starts fresh (with the synthesized JPEG header as its first element) each time `fragmentOffset === 0`.
- `timeData`/`prevTimeData` — current/previous frame's NTP-derived timestamp; `timeData` can end up **literally aliasing** `prevTimeData` (a whole-reference swap, not a field copy) when a frame's timestamp is falsy — preserved from legacy verbatim.
- `frameRate: number` — running estimate derived from consecutive extension-header timestamp deltas.

**Design notes**
- `depacketize()` preserves a real legacy bug: when the RTP padding bit is set (and CSRC count is 0), it throws `ReferenceError: PaddingSize is not defined` — `PaddingSize` is referenced but never declared anywhere in the class. Faithful port, not fixed.
- JPEG header synthesis follows RFC 2435 §3.1's quantization-table-factor scaling (`makeDefaultQtables`, factor 1–99, matching libjpeg's standard IJG scaling formula) when the RTP payload doesn't carry an explicit quantization table.
- Worker-boundary message contract (via `mjpegDepacketizeWorker.ts`): inbound `{dataArray: MjpegDepacketizeRequestEntry[]}` (batched, queued, drained via `setTimeout`); outbound is the raw `MjpegFrameData` object itself (`{playMode, streamData, videoInfo}`), posted with the frame buffer transferred, not copied.

---

#### `SunapiRequestTask`

**File:** `src/player/worker/sunapi/sunapiRequestTask.ts`
**Type:** Class

**Purpose**
Runs (nominally) inside a dedicated Worker spawned by `SunapiRestClient` (`network/http/SunapiRestClient.ts`) to perform one SUNAPI REST HTTP call off the main thread, including full HTTP Digest-authentication challenge/response handling.

**Responsibilities**
- `onMessage` is meant to be the Worker's message entry point: stores the incoming request (`data`/`digestInfo`), then dispatches a GET or POST `XMLHttpRequest` (async or sync, based on URL/flags) via `ajaxAsync`/`ajaxSync`.
- `onReadyStateChangeEventHandler` handles the XHR lifecycle: on a `401`, extracts the `WWW-Authenticate` header, computes Digest auth via `getDigestInfoInWwwAuthenticate`/`setAuthorizationHeader`, and retries the request with the `Authorization` header attached; otherwise parses the final response (`parseResponse`).
- `setAuthorizationHeader` builds RFC 2617 Digest (and `xdigest`) `Authorization` headers using MD5 (`crypto-js`): `HA1 = MD5(user:realm:pass)`, `HA2 = MD5(method:uri)`, `response = MD5(HA1:nonce:nc:cnonce:qop:HA2)`, including per-request nonce-count increment and a random cnonce.
- `parseResponse` normalizes the XHR result into a `SunapiTaskResult` (`response`/`error`), handling arrayBuffer/XML/text responses and a fallback dot/equals key=value text-line parser (`getDotEqualStrLineToObj`) for camera/NVR responses that aren't valid JSON.
- Posts results back to the main thread via an injectable `postMessageFn` (default: the global `postMessage`).

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): `CryptoJS` (crypto-js library, for MD5) — no dependency on any other src/player class
- Used by: `SunapiRestClient` (`network/http/SunapiRestClient.ts`, different group — spawns a `Worker` whose script is this very file: `new Worker(new URL('../../worker/sunapi/sunapiRequestTask.ts', import.meta.url))`)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `digestInfo` | `DigestCache \| undefined` | Currently cached Digest-auth challenge state. |
| `data` | `SunapiTaskRequestData \| null` | The current in-flight request's parameters. |
| `working` | `boolean` | Guards against starting a second request while one is in flight. |
| `onMessage` | `(event: {data: SunapiTaskRequestData}): void` | Intended Worker message entry point (see Design notes — unconditionally throws). |
| `onError` | `(err: unknown): void` | Debug-logs a Worker-level error. |
| `getDigestInfoInWwwAuthenticate` | `(wwwAuthenticate: string \| null): DigestCache \| false` | Parses a `WWW-Authenticate` header into a `DigestCache`. |
| `getDotEqualStrLineToObj` | `(data: string): Record<string, unknown>` | Parses `key.path=value`-per-line text responses into a nested object (see Design notes — unconditionally throws before returning). |

**Design notes**
- **This class, as currently wired, cannot actually run as a Worker.** Unlike the other three worker-owned classes in this group, `sunapiRequestTask.ts` has no separate thin `*Worker.ts` entry-point shim — `SunapiRestClient.ts` loads this file itself directly as the Worker script (`new Worker(new URL('.../sunapiRequestTask.ts', ...))`). But the file contains only the class definition/export — there is no top-level bootstrap code (no `new SunapiRequestTask()`, no `self.onmessage = ...` wiring) anywhere in it, so a spawned Worker running this script would never actually invoke `onMessage` on any instance in the first place. `worker/sunapi/index.ts` only re-exports the class/types and also performs no bootstrapping.
- Even if that wiring existed, `onMessage`'s very first statement (`fastJsonStringfy(event.data)`, a legacy main-thread-only global never available in a Worker scope) is preserved faithfully and throws a `ReferenceError` unconditionally, making all the dispatch logic below it dead in practice. `getDotEqualStrLineToObj` has the same bug in its own result-logging line. `setAuthorizationHeader`'s `'basic'`-scheme branch also throws (`ReferenceError: RESdata is not defined`, an undeclared legacy identifier) whenever a server challenges with Basic auth instead of Digest.
- Net effect: the SUNAPI-over-Worker REST path is fully wired end-to-end (types, message shapes, `SunapiRestClient`'s `worker.onmessage` handler for `SunapiWorkerMessage`) but is confirmed non-functional in the current codebase, consistent with `SunapiRestClient.ts`'s own doc comment noting this class was "not yet ported" at the time that file was written.
- `clearDigestCache` (legacy) is confirmed to have zero call sites and is dropped.

## 5. util

### `BufferNode`

**File:** `src/player/util/BufferList.ts`
**Type:** Class

**Purpose**
A single node in the doubly-linked list maintained by `BufferList`, holding one buffered payload plus its list links.

**Responsibilities**
- Wraps a payload of type `T` (nullable) as `buffer`.
- Holds `next`/`previous` links so `BufferList` can splice/traverse nodes.
- No behavior of its own beyond construction — it is a plain data holder.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): —
- Used by: `BufferList` (creates and links `BufferNode` instances internally). Not otherwise instantiated anywhere in the ported codebase — see Design notes.

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `constructor` | `(buffer: T \| null)` | stores the initial payload |
| `buffer` | `T \| null` | the payload (nulled out on `BufferList.clear()`) |
| `next` | `BufferNode<T> \| null` | link to the following node |
| `previous` | `BufferNode<T> \| null` | link to the preceding node |

**Design notes**
- Ported verbatim from the legacy player's `Util/util` (`BufferNode`/`BufferList`, ~line 1450). Only the members actually consumed elsewhere in the ported codebase so far (`push`/`pop`/`clear`/`getCurIdx`) were carried over; `pushPop`/`searchNodeAt`/`remove`/`removeTillCurrent` from the legacy class were unused and dropped, per the file's header comment.

---

### `BufferList`

**File:** `src/player/util/BufferList.ts`
**Type:** Class (generic `<T>`)

**Purpose**
A minimal doubly-linked list used as a generic append/pop buffer primitive, ported from the legacy player's shared buffering utility.

**Responsibilities**
- Appends items to the tail (`push`), returning the created `BufferNode`.
- Removes and returns the head node (`pop`), but only once more than one node exists (see Design notes).
- Tracks a `curIdx` cursor field (exposed via `getCurIdx()`) that the class itself never advances.
- Clears all nodes, nulling out each node's `buffer` field and resetting `head`/`tail`/`length`/`curIdx`.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): `BufferNode<T>`
- Used by: — (only re-exported through the `util/index.ts` barrel; no other file in `src/player` currently imports or instantiates `BufferList`/`BufferNode` directly — the similarly-named `VideoBufferList`/`StepBufferList` in `mediaSession/videoSession/` and `video/player/canvas/` are deliberately standalone classes, not subclasses or consumers of this one, per `StepBufferList.ts`'s own header comment)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `getCurIdx` | `(): number` | returns the `curIdx` cursor field |
| `push` | `(buffer: T): BufferNode<T>` | appends a new node at the tail |
| `pop` | `(): BufferNode<T> \| null` | removes and returns the head node |
| `clear` | `(): void` | nulls every node's payload and resets the list |
| `head` | `BufferNode<T> \| null` | first node |
| `tail` | `BufferNode<T> \| null` | last node |
| `curIdx` | `number` | cursor field, read via `getCurIdx()` |

**Key data**
- `length: number` (protected) — node count, incremented on `push`, decremented on a successful `pop`.
- `head`/`tail: BufferNode<T> | null` — list endpoints.

**Design notes**
- `pop()` only removes a node when `length > 1` — popping the sole remaining node is a silent no-op that returns `null`, a legacy quirk preserved as-is (not a bug fix opportunity per the file's own comment).
- `clear()` walks the list nulling each node's `buffer` (aiding GC of large payloads) rather than just dropping the head/tail references.

---

### `CircularTypedArrayQueue`

**File:** `src/player/util/CircularTypedArrayQueue.ts`
**Type:** Class (generic `<T = unknown>`)

**Purpose**
A bounded circular queue used for fixed-size rolling statistics (e.g. recent FPS samples, recent frame-timestamp intervals) in the video player, with optional auto-eviction of the oldest entry when full.

**Responsibilities**
- Tracks `head`/`tail` indices into a backing array, wrapping via modulo `maxSize`.
- `enQueue`/`push`/`insert` add an item; if full, either auto-evicts the oldest item (`autodelete: true`) or throws.
- `deQueue`/`pop` remove and return the oldest item; throws if empty.
- `front`/`peak` inspect the oldest item without removing it.
- `Clear` explicitly nulls every occupied slot then resets to empty.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): —
- Used by: `VideoPlayer` (`fpsQueue`, `video/player/VideoPlayer.ts`), `VideoTagPlayer` (`videoTimestampIntervalQueue`, `video/player/video/VideoTagPlayer.ts`) — both constructed with `autodelete: true` for rolling-window statistics.

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `constructor` | `(maxSize?: number, autodelete?: boolean)` | `maxSize` defaults to `2^53 - 1`; `autodelete` controls full-queue behavior |
| `setMaxSize` | `(maxSize: number): void` | changes capacity |
| `isFull` / `isEmpty` | `(): boolean` | capacity checks |
| `enQueue` / `push` / `insert` | `(record: T): void` | add an item (aliases of the same operation) |
| `deQueue` / `pop` | `(): T \| null` | remove and return oldest item |
| `front` / `peak` | `(): T \| null` | inspect oldest item |
| `getLength` | `(): number` | see Design notes — not a logical count |
| `Clear` | `(): void` | empties the queue (throws if already empty) |
| `toArray` | `(): (T \| null)[]` | returns the raw backing array |
| `print` | `(): void` | logs occupied slots |

**Key data**
- `items: (T | null)[]` (private) — backing array, indices reused circularly.
- `head`/`tail: number` (private) — both `-1` when empty.
- `maxSize: number` — capacity; wraps via `(value + 1) % maxSize`.

**Design notes**
- `getLength()` deliberately returns `this.items.length` (the backing array's raw JS length, which only grows and is never shrunk except by `Clear`), not the logical element count — a naive legacy behavior kept verbatim because callers (`videoPlayer`, `videoTagPlayer`) rely on this exact contract, per the file's header comment.
- Method names (`enQueue`, `deQueue`, `peak` — note the misspelling — and capitalized `Clear`) are preserved from the legacy API rather than normalized, for the same reason.

---

### `CommonAudioUtil`

**File:** `src/player/util/CommonAudioUtil.ts`
**Type:** Class

**Purpose**
Shared G.72x ADPCM bitwise arithmetic routines used by the G.726 audio decoders (16/24/32/40 kbit/s variants) to predict, quantize, and reconstruct audio samples.

**Responsibilities**
- Initializes fresh G.726 codec state (`g726_init_state`).
- Computes zero-predictor and pole-predictor estimates (`predictor_zero`, `predictor_pole`) via an internal floating-point multiply helper (`fmult`).
- Computes the adaptive quantizer step size (`step_size`).
- Quantizes (`quantize`) and reconstructs (`reconstruct`) difference samples.
- Updates all adaptive codec state (predictor coefficients, step-size scale factors, tone/transition flags) after each sample via `update`.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): —
- Used by: `G726_16_AudioDecoder`, `G726_24_AudioDecoder`, `G726_32_AudioDecoder`, `G726_40_AudioDecoder` (all in `src/player/listen/decoder/`)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `g726_init_state` | `(): G726State` | builds a fresh decoder state object |
| `predictor_zero` | `(state: G726State): number` | zero-order predictor estimate |
| `predictor_pole` | `(state: G726State): number` | pole predictor estimate |
| `step_size` | `(state: G726State): number` | adaptive quantizer step size |
| `quantize` | `(d: number, y: number, table: number[], size: number): number` | quantizes a difference sample |
| `reconstruct` | `(sign: number, dqln: number, y: number): number` | reconstructs a sample from quantized log value |
| `update` | `(code_size, y, wi, fi, dq, sr, dqsez, state): G726State` | updates all adaptive state in place (and returns it) |

**Key data**
- `G726State` (exported interface) — full mutable codec state: predictor coefficients `a`/`b`, sign history `pk`, quantized differences `dq`, reconstructed signals `sr`, scale factors `yl`/`yu`, tone-detection accumulators `dms`/`dml`/`ap`/`td`.
- `POWER2` (module-level const) — lookup table used by the internal `quan()` exponent search.

**Design notes**
- Bitwise arithmetic (shifts, masks, sign-magnitude handling) is copied verbatim from the legacy port; this is reference DSP code where exact operations, not just mathematical intent, are the contract (per the file's header comment).

---

### `DigestGenerator`

**File:** `src/player/util/DigestGenerator.ts`
**Type:** Class

**Purpose**
Computes HTTP/RTSP Digest authentication responses (RFC 2617) and formats the resulting `Authorization` header, plus parses `WWW-Authenticate` challenge headers.

**Responsibilities**
- Generates a fresh client nonce (`cnonce`) on construction and on each `Digest()` call, incrementing a nonce-count (`nc`).
- Computes HA1/HA2/response digests using MD5 or SHA-256 (`digestSchema`, via `crypto-js`), selecting the algorithm from `authenticateData.Algorithm`.
- Supports both the simple (`HA1:nonce:HA2`) and qop-aware (`HA1:nonce:nc:cnonce:qop:HA2`) response formats.
- Builds the full `Authorization: Digest ...` header string (`getAuthenticate`).
- Parses one or more `WWW-Authenticate` header lines into structured fields (`getDigestInfoInWwwAuthenticate`, `parseWWWAuthenticate`).

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): `CryptoJS.MD5`/`CryptoJS.SHA256` (external `crypto-js`)
- Used by: `RtspClient` (`src/player/network/rtspOverWebsocket/RtspClient.ts`, holds a `digestGenerator` instance) and `SunapiClient` (`src/player/network/http/`, per task context — not re-verified here since it is outside this group)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `nc` | `number` | nonce-count, incremented each `generateClientNonce()` call |
| `cnonce` | `string` | current client nonce |
| `authenticateData` | `AuthenticateData \| null` | credentials/challenge data set via `getAuthenticate` |
| `digestSchema` | `(type: HashType, str: string): string` | hashes a string with MD5 or SHA-256 |
| `generateClientNonce` | `(): void` | regenerates `cnonce`, increments `nc` |
| `Digest` | `(): string` | computes the digest response value |
| `getAuthenticate` | `(data?, response?): string` | builds the full `Authorization` header line |
| `getDigestInfoInWwwAuthenticate` | `(wwwAuthenticate: string): ParsedWwwAuthenticate[]` | parses all challenge lines |
| `parseWWWAuthenticate` | `(authenticateString: string): ParsedWwwAuthenticate` | parses one challenge line |

**Design notes**
- `makeNonceCount()` and an unused `infoWWWAuthenticate` parameter of `Digest()`, both dead code in the legacy source, were dropped in this port.
- Algorithm selection defaults to MD5 whenever `Algorithm` is `undefined`/`null`/`'MD5'`, and only uses SHA-256 otherwise.
- `Digest()` logs the qop-mode input string via `console.log` (kept from legacy).

---

### `Fisheye3D`

**File:** `src/player/util/FishEye3D.ts`
**Type:** Class

**Purpose**
Drives a THREE.js scene that dewarps a fisheye camera video/canvas feed onto a hemispherical mesh, with mouse/wheel pan-tilt-zoom controls and a render loop, for the single-camera "wall"/"ceiling" mount fisheye view.

**Responsibilities**
- `init()` builds the camera, scene, dewarping mesh geometry (via `FisheyeMeshGenerator`), video/canvas texture, renderer, and registers pointer/wheel/resize listeners.
- Tracks pan (`lon`/`lat`), projection (`phi`/`theta`), zoom (`distance`, `fov`) state driven by mouse/wheel event handlers.
- `animate`/`start`/`stop` manage a `requestAnimationFrame` render loop.
- `update()` recomputes camera position/orientation each frame from the current pan/zoom state and renders the scene.
- Exposes `mesh` (debug wireframe overlay), `mount` (wall/ceiling mode), and `fisheyeview` (toggles fisheye vs. dewarped view, saving/restoring the prior camera pose) as accessor properties.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): `FisheyeMeshGenerator` (from `fishEyeMesh.ts`) to build the dewarping mesh geometry; `THREE.*` (external, pinned to `three@0.84.0`)
- Used by: — (exported via `util/index.ts` barrel only; no other file in `src/player` currently imports/instantiates `Fisheye3D`)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `constructor` | `(rendererFactory?: () => THREE.WebGLRenderer)` | injectable renderer factory (defaults to `new THREE.WebGLRenderer()`) |
| `init` | `(videoElement: FisheyeTextureSource, container: HTMLElement, background?): void` | builds scene/mesh/renderer, attaches listeners |
| `start` / `stop` | `(): void` | begin/end the render loop |
| `update` | `(): void` | per-frame camera update + render |
| `mesh` | getter/setter `unknown` | toggles a debug wireframe overlay of the dewarping mesh |
| `mount` | getter/setter `FisheyeMountMode ('wall' \| 'celling')` | wall vs. ceiling camera orientation mode |
| `fisheyeview` | getter/setter `boolean` | raw fisheye vs. dewarped view toggle |

**Key data**
- `storedValue: FisheyeStoredView | null` — saved lon/lat/phi/theta/distance, restored when leaving fisheye view.
- `distance`/`fov`/`lon`/`lat`/`phi`/`theta` — live camera pan/zoom state driven by pointer events.

**Design notes**
- Two confirmed real legacy bugs are preserved as-is rather than fixed, both reproduced as `ReferenceError`s via a local `undefinedGlobalError()` helper: (1) `update()`'s canvas-texture branch (`this.tex` set) reads an undeclared global `livecanvas`, so it throws on every frame once a canvas (non-video) texture is in use; (2) the `mount` setter's invalid-mode branch throws a `FisheyeError` class that is never defined anywhere in the codebase.
- Pinned to `three@0.84.0` (exact version) because the code targets the pre-`BufferGeometry` THREE API (`THREE.Geometry`, `Face3`, `AxisHelper`, `RGBFormat`, `BufferGeometry.fromGeometry`), all removed in modern three.js.
- `console.*` calls from the legacy source are not reproduced.

---

### `Fisheye3DMulti`

**File:** `src/player/util/FishEye3DMulti.ts`
**Type:** Class

**Purpose**
A cylindrical-panorama variant of `Fisheye3D` for a multi-camera stitched view, rendered into a fixed `#mi-full-camera` DOM element.

**Responsibilities**
- `init()` locates the `#mi-full-camera` container, builds camera/scene, generates a cylindrical mesh via the module-local `buildCylindricalMesh()` (not `fishEyeMesh.ts` — see Design notes), builds the video/canvas texture, and registers document-level pointer/wheel/resize listeners.
- Tracks pan/zoom state (`lon`/`lat`/`phi`/`theta`/`distance`/`fov`) via mouse/wheel handlers, structurally similar to `Fisheye3D` but with different clamping constants.
- `animate` drives a `requestAnimationFrame` render loop (with no stop mechanism — see Design notes).
- `update()` recomputes camera position/orientation and renders each frame.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): module-local `buildCylindricalMesh()` helper (own inline mesh generator); `THREE.*` (external, pinned to `three@0.84.0`)
- Used by: — (exported via `util/index.ts` barrel only; no other file in `src/player` currently imports/instantiates `Fisheye3DMulti`)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `constructor` | `(rendererFactory?: () => THREE.WebGLRenderer)` | injectable renderer factory |
| `init` | `(videoElement: FisheyeMultiTextureSource): void` | builds scene/mesh/renderer against `#mi-full-camera`; no-ops if that element is absent |
| `animate` | `(): void` | starts/continues the render loop (see Design notes — cannot be stopped) |
| `update` | `(): void` | per-frame camera update + render |

**Design notes**
- Unlike `Fisheye3D`, this class does **not** use `fishEyeMesh.ts`'s `FisheyeMeshGenerator`/`GridMesh`/`MeshVertex`/`FisheyeConfig`: the legacy source defines byte-for-byte duplicates of those classes but its `init()` builds the mesh with its own inline cylindrical-panorama generator instead (`var g = new GEN();` is commented out in legacy) — ported here as `buildCylindricalMesh()`.
- Confirmed real bug preserved: `onWindowResize` reads a bare `container` identifier never declared in its own scope or the enclosing class scope (only inside `init()`'s function-local `var container` in legacy) — reproduced as a `ReferenceError` via the same `undefinedGlobalError()` pattern used in `FishEye3D.ts`.
- Legacy never stores the `requestAnimationFrame` handle (no `animateId`, unlike `Fisheye3D`), so once `animate()` starts there is no way to stop the render loop — preserved as-is.
- A `minimapCamera` is constructed and added to the scene but never actually rendered to (the legacy minimap render pass — `cameraHelper`/`renderer.setViewport(...)`/second `render()` call — is dead code); it's kept only as an inert scene member.
- Pinned to `three@0.84.0` for the same pre-`BufferGeometry` API reasons as `Fisheye3D.ts`.

---

### `H264SPSParser`

**File:** `src/player/util/H264SPSParser.ts`
**Type:** Class

**Purpose**
Parses an H.264 Sequence Parameter Set (SPS) NAL unit bitstream to extract frame dimensions, cropping, and codec profile/level information needed by the media pipeline.

**Responsibilities**
- Strips emulation-prevention bytes from the raw NAL payload (`nalUnitExtractRbsp`).
- Implements bitstream primitives: fixed-width `readBits`, Exp-Golomb unsigned (`ue`) and signed (`se`) decoders, operating over a running `bitCount` cursor.
- `parse()` walks the full SPS syntax (profile/level, chroma format, scaling matrices, frame dimensions, cropping, and optional VUI/HRD parameters via `vuiParameters`/`hrdParameters`) into an internal `RTSPOverWebSocketMap`.
- `getSizeInfo()` derives final width/height (post-cropping) and total decode size from the parsed fields.
- `getCodecInfo()` formats the `avc1.PPCCLL` codec string from profile/compatibility/level bytes.
- `getSpsValue()` exposes any individual parsed SPS field by key.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): `RTSPOverWebSocketMap<SpsValue>` (parsed field storage)
- Used by: `MediaRouter` (`src/player/mediaSession/MediaRouter.ts`) — instantiated when `codecType === 'H264'`, used for `profileIdc`/`levelIdc` reporting and resolution/decode-size gating.

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `parse` | `(spsPayload: Uint8Array): boolean` | parses an SPS NAL payload; always returns `true` |
| `getSizeInfo` | `(): SpsSizeInfo` | width/height/decodeSize/cropWidth/cropHeight |
| `getSpsValue` | `(key: string): SpsValue` | raw access to any parsed field |
| `getCodecInfo` | `(): string \| null` | `avc1.PPCCLL` codec string, or `null` if profile fields are missing |

**Key data**
- `spsMap: RTSPOverWebSocketMap<SpsValue>` (private) — all parsed SPS fields keyed by their H.264 spec name (e.g. `profile_idc`, `pic_width_in_mbs_minus1`).
- `bitCount: number` (private) — running bit-cursor across the parse.

**Design notes**
- `SpsSizeInfo`/`SpsValue` types and the `nalUnitExtractRbsp`/`getBit`/`readBits`/`ue` core are structurally near-identical to `H265SPSParser`'s (independent parsers for the two codecs, not a shared base class).

---

### `H265SPSParser`

**File:** `src/player/util/H265SPSParser.ts`
**Type:** Class

**Purpose**
Parses an H.265/HEVC Sequence Parameter Set (SPS) NAL unit bitstream to extract frame dimensions, cropping, and profile/tier/level codec information.

**Responsibilities**
- Strips emulation-prevention bytes (`nalUnitExtractRbsp`) and implements the same bitstream primitives (`readBits`, Exp-Golomb `ue`) as `H264SPSParser`, but without an `se` (signed Exp-Golomb) decoder — HEVC SPS parsing here doesn't need one.
- `parse()` walks the NAL header and general SPS syntax (profile/tier/level fields, chroma format, luma width/height, conformance window cropping) into an internal `RTSPOverWebSocketMap`.
- `getSizeInfo()` derives final width/height/decode size using chroma-subsampling-aware crop math.
- `getProfileName()` maps `general_profile_idc` to a human-readable name (`Main`, `Main 10`, `Main Still Picture`, `Rext`, `Unknown`).
- `getCodecInfo()` formats the `hvc1.*` codec string per the HEVC codec-string convention (profile space/tier/level/constraint flags, with bit-reversed compatibility flags via the module-local `reverseBits`).
- `getProfileTierLevel()` returns the raw profile/tier/level byte sequence as a number array.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): `RTSPOverWebSocketMap<SpsValue>` (parsed field storage); module-local `reverseBits()` helper
- Used by: `MediaRouter` (`src/player/mediaSession/MediaRouter.ts`) — instantiated when `codecType === 'H265'`, used for `profileTierLevel` reporting and a `getProfileName() !== 'Main'` resolution/profile gate.

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `parse` | `(spsPayload: Uint8Array): boolean` | parses an SPS NAL payload; always returns `true` |
| `getSizeInfo` | `(): SpsSizeInfo` | width/height/decodeSize/cropWidth/cropHeight |
| `getSpsValue` | `(key: string): SpsValue` | raw access to any parsed field |
| `getProfileName` | `(): string` | human-readable HEVC profile name |
| `getCodecInfo` | `(): string` | `hvc1.*` codec string |
| `getProfileTierLevel` | `(): number[]` | raw profile/tier/level byte sequence |

**Key data**
- `spsMap: RTSPOverWebSocketMap<SpsValue>` (private) — all parsed SPS fields.
- `bitCount: number` (private) — running bit-cursor.

**Design notes**
- Unlike `H264SPSParser.ue()`, this class's `ue()` does not guard against running off the end of the buffer (no `base.length !== idx` check) — a straightforward do/while Exp-Golomb decode, ported as-is.

---

### `IntervalTimer`

**File:** `src/player/util/IntervalTimer.ts`
**Type:** Class

**Purpose**
A pausable/resumable wrapper around `setInterval`, used for periodic statistics callbacks (RTP session stats, video frame/FPS stats) that need to support pause without losing their phase within the current interval.

**Responsibilities**
- Starts a `setInterval` loop immediately on construction.
- `pause()` computes remaining time in the current interval and clears the timer.
- `resume()` schedules a one-shot `setTimeout` for the remaining time, then resumes normal `setInterval` ticking from that point.
- Tracks internal state (`idle`/`running`/`paused`/`resumed`) to guard against invalid pause/resume calls.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): —
- Used by: `Transport` (`src/player/network/transport/Transport.ts`, `statisticsTimer`), `RtpSession` (`src/player/mediaSession/RtpSession.ts`, `statisticsTimer`, exposed via `getStatisticsTimer()`), `VideoTagPlayer` (`src/player/video/player/video/VideoTagPlayer.ts`, `statisticsTimer`)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `constructor` | `(callback: () => void, interval: number)` | starts ticking immediately |
| `pause` | `(): void` | stops ticking, remembers remaining time; no-op unless currently running |
| `resume` | `(): void` | resumes from the remaining time; no-op unless currently paused |

**Key data**
- `state: 0 \| 1 \| 2 \| 3` (private) — `0` idle, `1` running, `2` paused, `3` resumed (mid-resume, before the deferred `setTimeout` fires).
- `remaining: number` (private) — time left in the interval when paused.

**Design notes**
- `resume()` doesn't restart `setInterval` directly; it first waits out the remaining slice via `setTimeout`, then fires the callback once and restarts a full-period `setInterval` — preserving the original interval phase rather than resetting it.

---

### `Mean`

**File:** `src/player/util/Mean.ts`
**Type:** Class

**Purpose**
A simple running-average (and per-sample variance) tracker used by `VideoTagPlayer`'s decode/render/drop statistics.

**Responsibilities**
- Accumulates a running `count`/`sum` via `record(val)`.
- Returns the mean formatted to 3 decimal places once at least one value has been recorded.
- Computes the squared deviation of a given value from the current mean (`variance`).

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): —
- Used by: `VideoTagPlayer` (`src/player/video/player/video/VideoTagPlayer.ts`) — three instances: `decodedMean`, `videoMean`, `dropMean`.

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `count` | `number` | number of recorded samples |
| `sum` | `number` | running sum |
| `record` | `(val: number): void` | adds a sample |
| `variance` | `(val: number): number` | `(val - mean)^2` |
| `mean` | `(): string \| number` | `.toFixed(3)` string once `count > 0`, else the number `0` |

**Design notes**
- `mean()` has a real mixed-type return (`string` once populated, numeric `0` before any sample) preserved as-is from legacy — callers already do `isNaN(x.mean())`-style checks that work against both.

---

### `Queue`

**File:** `src/player/util/Queue.ts`
**Type:** Class (generic `<T = unknown>`)

**Purpose**
A bounded, array-backed FIFO queue with amortized-O(1) dequeue (via a compacting offset rather than `Array.shift`).

**Responsibilities**
- `enqueue` appends; throws once at capacity (`maxSize`, default `2^53 - 1`).
- `dequeue` returns the oldest item, advancing an internal `offset`; throws when empty.
- Periodically compacts the backing array (slicing off consumed entries) once the consumed `offset` reaches half the array's length, to bound memory growth.
- `peek` inspects the oldest item without removing it; `print` logs current contents.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): —
- Used by: — (exported via `util/index.ts` barrel only; no other file in `src/player` currently imports/instantiates `Queue` — distinct from the unrelated `CircularTypedArrayQueue`, which is what `VideoPlayer`/`VideoTagPlayer` actually use)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `constructor` | `(maxSize?: number)` | defaults to `2^53 - 1` |
| `getLength` | `(): number` | logical element count (`items.length - offset`) |
| `isEmpty` | `(): boolean` | true when backing array is empty |
| `isFull` | `(): boolean` | true when logical count `>= maxSize` |
| `enqueue` | `(item: T): void` | appends; throws if full |
| `dequeue` | `(): T` | removes and returns oldest; throws if empty |
| `peek` | `(): T \| undefined` | inspects oldest without removing |
| `print` | `(): void` | logs length + all logical elements |

**Design notes**
- Unlike `CircularTypedArrayQueue`, `getLength()` here *is* the true logical count (`items.length - offset`), not a raw backing-array length — a genuinely different (and more conventional) implementation despite the similar name/purpose.

---

### `RTSPOverWebSocketMap`

**File:** `src/player/util/RTSPOverWebSocketMap.ts`
**Type:** Class (generic `<V = unknown>`)

**Purpose**
A plain string/number-keyed hash map wrapper (a `Map`-like convenience API over a plain object), used as the parsed-field store for the SPS bitstream parsers.

**Responsibilities**
- `put`/`get`/`remove`/`containsKey` — standard key-value operations over an internal `Record<string, V>`.
- `containsValue` — linear search using loose (`==`) equality.
- `keys`/`values`/`size`/`isEmpty`/`clear` — standard collection introspection/mutation.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): —
- Used by: `H264SPSParser`, `H265SPSParser` (both in `src/player/util/`, each holds a private `spsMap` instance)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `put` | `(key: string \| number, value: V): void` | sets a key |
| `get` | `(key: string \| number): V \| undefined` | reads a key |
| `containsKey` | `(key: string \| number): boolean` | key presence check |
| `containsValue` | `(value: V): boolean` | value presence via loose equality |
| `isEmpty` | `(): boolean` | true if `size() === 0` |
| `clear` | `(): void` | removes all entries |
| `remove` | `(key: string \| number): void` | deletes a key |
| `keys` | `(): string[]` | all keys |
| `values` | `(): V[]` | all values |
| `size` | `(): number` | entry count |

**Design notes**
- `containsValue` intentionally uses `==` rather than `===`, preserved from legacy "hashMap" loose-equality semantics (explicitly flagged with an eslint-disable comment in source).

---

### `Size`

**File:** `src/player/util/Size.ts`
**Type:** Class

**Purpose**
A simple width/height (plus optional view-width/view-height) value object used by the canvas/WebGL rendering pipeline to describe frame and viewport dimensions.

**Responsibilities**
- Stores `w`/`h` and optional `viewWidth`/`viewHeight`.
- `toString()` formats as `(w, h)`.
- `getHalfSize()` returns a new `Size` with unsigned-right-shifted (halved, floored) width/height.
- `length()` returns `w * h` (pixel count).

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): —
- Used by: `YUVWebGLCanvas`, `WebGLCanvas`, `GLPrimitives` (all in `src/player/video/player/canvas/webgl/`), `CanvasRenderer` (`src/player/video/player/canvas/CanvasRenderer.ts`)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `constructor` | `(width: number, height: number, viewWidth?: number, viewHeight?: number)` | `viewWidth`/`viewHeight` only set if provided |
| `w` / `h` | `number` | width/height |
| `viewWidth` / `viewHeight` | `number \| undefined` | optional viewport dimensions |
| `toString` | `(): string` | `"(w, h)"` |
| `getHalfSize` | `(): Size` | new `Size` with `w`/`h` each `>>> 1` |
| `length` | `(): number` | `w * h` |

**Design notes**
- Ported from a legacy factory function that assigned fields onto a freshly-declared per-call `Constructor.prototype` object rather than `this` — an unusual style, but because exactly one instance was ever created per factory call, it was behaviorally equivalent to a plain constructor and is ported as a normal class (see file header comment). `CanvasRenderer.ts` separately notes a legacy quirk where a `new Size(..., mapWidth, mapHeight)` call site can pass `viewWidth`/`viewHeight` as strings rather than numbers (no `Number()` conversion) — that quirk lives in the caller, not in `Size` itself.

---

### 5.1 Fisheye dewarping mesh geometry (fishEyeMesh.ts)

### `MeshVertex`

**File:** `src/player/util/fishEyeMesh.ts`
**Type:** Class

**Purpose**
A single 5-component vertex (2D texture UV plus 3D XYZ position) used throughout the fisheye dewarping mesh-triangulation math.

**Responsibilities**
- Default-constructs a zeroed vertex, or copy-constructs from another `MeshVertex`.
- Acts as a mutable value passed through `GridMesh`'s clipping/normalizing/3D-projection steps.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): —
- Used by: `GridMesh` (creates/mutates `MeshVertex` instances while generating the mesh); consumed transitively by `Fisheye3D` (`FishEye3D.ts`) via `FisheyeMeshGenerator`

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `constructor` | `(vertex?: MeshVertex \| null)` | zero-inits if omitted/`undefined`; copy-constructs if a real `MeshVertex` (or `null`, see Design notes) |
| `u` / `v` | `number` | texture coordinates |
| `x` / `y` / `z` | `number` | 3D position |

**Design notes**
- Confirmed legacy bug preserved: passing `null` explicitly satisfies the copy-construct branch's condition (`... || vertex === null`) and then immediately dereferences `vertex!.x` etc., which would throw a `TypeError` at runtime. This path is never actually exercised by any real call site (`new MeshVertex(someRealVertex)` or `new MeshVertex()` only), so it's inert in practice but kept for fidelity to the ported algorithm.

---

### `FisheyeConfig`

**File:** `src/player/util/fishEyeMesh.ts`
**Type:** Class

**Purpose**
Immutable configuration describing a fisheye lens's optical circle (center, radius, field-of-view) and the linear conversions between radius and FOV needed by the dewarping math.

**Responsibilities**
- Stores center coordinates, circle radius, and both the circle's native max FOV and an externally supplied cap, taking the smaller of the two as the effective `m_MaxFOV`.
- Precomputes linear FOV↔radius conversion factors.
- Exposes `GetFOV(radius)`/`GetRadius(fov)` conversions (returning `-1.0` out of range) and basic accessors for center/radius/width/height.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): —
- Used by: `GridMesh` (holds a `FisheyeConfig` and calls it throughout mesh generation/clipping/3D projection); constructed by `FisheyeMeshGenerator`

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `constructor` | `(centerX, centerY, circleMaxFOV, circleFOV, circleRadius: number)` | derives effective max FOV as `min(circleFOV, circleMaxFOV)` |
| `GetCenterX` / `GetCenterY` | `(): number` | optical center |
| `GetCircleFOV` / `GetCircleRadius` | `(): number` | raw circle FOV/radius as passed in |
| `GetMaxFOV` / `GetMaxRadius` | `(): number` | effective (capped) FOV, and radius |
| `GetFOV` | `(radius: number): number` | radius → FOV, or `-1.0` if `radius > maxRadius` |
| `GetRadius` | `(fov: number): number` | FOV → radius, or `-1.0` if `fov > maxFOV` |
| `GetWidth` / `GetHeight` | `(): number` | `2 * maxRadius` |
| `DEFAULT_MAX_FOV` | `static readonly 170.0` | default FOV cap |
| `DEFAULT_MAX_RADIUS` | `static readonly 823.12506` | default radius |

**Design notes**
- All fields are private/readonly, set once in the constructor — a genuinely immutable value object despite the mutable-style Java-SDK naming.

---

### `GridMesh`

**File:** `src/player/util/fishEyeMesh.ts`
**Type:** Class

**Purpose**
Generates a triangulated hemispherical mesh (positions + texture UVs) that dewarps a fisheye-lens video frame, driven by a `FisheyeConfig`.

**Responsibilities**
- `GenerateMesh()` lays out a grid of quads (each split into two triangles, in an alternating brick-like pattern by row parity) across the fisheye circle, at a given step size, and populates a flat `m_Triangles` number array (5 floats × 3 vertices per triangle: xyz + uv).
- `ClipToCircle()` projects any vertex outside the configured circle radius back onto its edge.
- `Normalize()` maps texture-space UVs into `[0,1]` bounds (clamping and flagging out-of-bounds), scaled by the fisheye/texture size ratio.
- `Find3DPos()` converts a clipped/normalized UV vertex into a 3D position on the hemisphere using the configured FOV-to-radius mapping.
- `CreateTriangle()` orchestrates clip→normalize→3D-project for three vertices and appends the resulting triangle to `m_Triangles` if at least one vertex was within-circle and within-bounds.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): `MeshVertex` (creates/mutates many during generation); uses an injected `FisheyeConfig`
- Used by: `FisheyeMeshGenerator` (creates a `GridMesh`, calls `GenerateMesh`, reads back triangles/count)

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `GenerateMesh` | `(step, fisheyeConfig, fisheyeWidth, fisheyeHeight, textureWidth, textureHeight, invertX, invertY): void` | builds the full triangle mesh |
| `ClipToCircle` | `(vertex: MeshVertex): boolean` | clips a vertex to the configured circle; returns whether it was already inside |
| `CreateTriangle` | `(vertex1, vertex2, vertex3: MeshVertex): void` | clips/normalizes/projects and appends one triangle |
| `Find3DPos` | `(vertex: MeshVertex): void` | projects a UV vertex onto the 3D hemisphere in place |
| `Normalize` | `(vertex: MeshVertex): boolean` | clamps UVs to `[0,1]` and rescales; returns whether it was already in bounds |
| `GetTriangleCount` | `(): number` | number of generated triangles |
| `GetTriangles` | `(): number[]` | flat triangle data array |
| `DEGREETORAD` | `static readonly 0.017453293` | degrees→radians constant |

**Key data**
- `m_Triangles: number[]` — flat output buffer, 15 floats per triangle (5 per vertex × 3 vertices).
- `m_NumTriangles: number` — count of triangles actually written (may be fewer than the grid's quad count, since fully-out-of-bounds/out-of-circle triangles are skipped).
- `m_FisheyeConfig: FisheyeConfig` — injected via `GenerateMesh`.
- `m_InvertX`/`m_InvertY: boolean` — axis inversion flags used by `Find3DPos`.

**Design notes**
- Method names (`GetCenterX`, `ClipToCircle`, `GenerateMesh`, ...) keep their original PascalCase/Java-SDK-style naming rather than being renamed to camelCase — this is a direct port of a specific dewarping algorithm (likely itself ported from a vendor fisheye SDK), and preserving exact names keeps it traceable against that source.
- The alternating triangle-winding pattern by `row % 2` is load-bearing for correct mesh topology, not a stylistic choice — preserved exactly from the source algorithm.

---

### `FisheyeMeshGenerator`

**File:** `src/player/util/fishEyeMesh.ts`
**Type:** Class

**Purpose**
Top-level entry point that builds a ready-to-render fisheye dewarping mesh (as flat `Float32Array` position/UV buffers) for a given texture resolution, used directly by `Fisheye3D` to construct its THREE.js geometry.

**Responsibilities**
- `generateVertices(resol)` builds a `FisheyeConfig` centered on the texture (default 170° FOV, radius = `resol / 2`) and a `GridMesh`, generates the mesh at a fixed step (`124.0`), then repacks the resulting triangle data into `position`/`textureCoords` `Float32Array`s consumed directly by THREE.js buffer geometry construction.

**Structure**
- Extends: —
- Implements: —
- Subordinates (creates/uses): `FisheyeConfig`, `GridMesh`
- Used by: `Fisheye3D` (`src/player/util/FishEye3D.ts`, `init()` calls `generateVertices(RESOL)` and reads back `mNumTriangles`/`position`/`textureCoords` to build its THREE.js geometry). Confirmed **not** used by `Fisheye3DMulti`, which builds its own inline cylindrical mesh instead (see `Fisheye3DMulti`'s Design notes).

**Public interface**

| Member | Signature | Description |
|---|---|---|
| `generateVertices` | `(resol: number): void` | builds the mesh for a `resol × resol` texture |
| `mNumTriangles` | `number` | number of generated triangles |
| `position` | `Float32Array` | flat XYZ positions, 9 floats per triangle (3 per vertex) |
| `textureCoords` | `Float32Array` | flat UV coordinates, 6 floats per triangle (2 per vertex) |

**Design notes**
- The repacking loop deliberately reorders the `GridMesh` triangle layout (which interleaves xyz+uv per vertex) into separate contiguous position/UV arrays, matching what `THREE.Geometry`/`Face3`/`Vector2`/`Vector3` construction expects in `Fisheye3D.init()`.
