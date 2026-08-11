# src/player — Class Overview

This document maps the classes defined under `src/player` and how they relate to each other
(inheritance, interface implementation, and the main composition/usage links). It complements
[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md), which covers data flow; this file is about
*static structure* — which class knows about which.

For a deeper, per-class reference — full method-by-method behavior, real call-stack traces, the
RFC/standard each class implements, and detailed cross-component data flow — see
[docs/player/](../../docs/player/README.md), which expands every class summarized below into its
own dedicated section.

Diagrams are grouped by directory/subsystem rather than as one giant graph, since a single
diagram for ~100+ classes would not be readable. Only classes are shown (not every exported
interface/type) unless an interface is central to a pattern (e.g. `BufferState`).

## Module layout

```
elements/            <rtsp-over-websocket> custom element (facade)
interface/           StreamManager / StreamPlayer orchestration layer
network/              RTSP-over-WebSocket + SUNAPI HTTP + transport
mediaSession/        RTP/RTCP session hierarchy + MediaRouter + per-codec sessions
video/player/        <video>/<canvas> rendering (VideoPlayer hierarchy)
listen/              Audio decoding + playback (AudioDecoder / AudioPlayer hierarchies)
talk/                 Two-way audio (talk-back) encoder session
backup/              Client-side backup/export orchestration
worker/              Web Worker–side counterparts (backup muxing, decoding, transcoding, mjpeg)
exceptions/          Error class hierarchy
util/                Stand-alone utility classes (no significant inheritance)
react/               React wrapper around the custom element
legacyHostInterface/ Type-only shims describing the legacy host's API surface
```

## 1. System overview — composition

> Per-class detail: [docs/player/01-elements-interface-exceptions.md](../../docs/player/01-elements-interface-exceptions.md),
> [docs/player/03-mediaSession-core-video.md](../../docs/player/03-mediaSession-core-video.md).

The custom element wraps `StreamPlayer` (directly, not via `StreamManager` — see note below),
which wires together the network, media-routing, rendering, audio, talk-back and backup
subsystems.

```mermaid
classDiagram
    class RTSPOverWebSocket {
        <<HTMLElement>>
    }
    class StreamManager
    class StreamPlayer
    class RtspClient
    class RtpClient
    class MediaRouter
    class MetaDataParser
    class CanvasTagPlayer
    class VideoTagPlayer
    class AudioPlayerGxx
    class Talk
    class BackupProvider
    class SunapiManager

    RTSPOverWebSocket --> StreamPlayer : creates/controls
    RTSPOverWebSocket --> SunapiManager : creates
    StreamManager --> StreamPlayer : creates/looks up (unused by RTSPOverWebSocket today)
    StreamPlayer --> RtspClient : creates
    StreamPlayer --> RtpClient : creates
    StreamPlayer --> MediaRouter : creates
    StreamPlayer --> MetaDataParser : creates
    StreamPlayer --> CanvasTagPlayer : creates (canvas mode)
    StreamPlayer --> VideoTagPlayer : creates (video-tag mode)
    StreamPlayer --> AudioPlayerGxx : creates
    StreamPlayer --> Talk : creates
    StreamPlayer --> BackupProvider : creates
    RtpClient --> MediaRouter : reports frames to (via MediaRouterLike)
    MediaRouter ..> CanvasTagPlayer : drives (via VideoPlayerLike)
    MediaRouter ..> VideoTagPlayer : drives (via VideoPlayerLike)
    MediaRouter ..> AudioPlayerGxx : drives (via AudioPlayerLike)
    MediaRouter ..> Talk : drives (via TalkLike)
    MediaRouter ..> MetaDataParser : drives (via MetaDataParserLike)
    MediaRouter ..> BackupProvider : drives (via BackupProviderLike)
```

> `MediaRouter` never imports the concrete player/talk/backup classes directly — `StreamPlayer`
> injects them through the `MediaRouterFactories`/`*Like` interfaces defined in `MediaRouter.ts`
> (dependency inversion, and the seam the parity tests use to inject fakes).

## 2. Exceptions

> Per-class detail: [docs/player/01-elements-interface-exceptions.md](../../docs/player/01-elements-interface-exceptions.md) (§ "Exceptions hierarchy").

```mermaid
classDiagram
    class RTSPOverWebSocketBaseError {
        <<abstract>>
    }
    Error <|-- RTSPOverWebSocketBaseError
    RTSPOverWebSocketBaseError <|-- AuthError
    RTSPOverWebSocketBaseError <|-- RTCPError
    RTSPOverWebSocketBaseError <|-- RTSPError
    RTSPOverWebSocketBaseError <|-- RTSPOverWebSocketError
    RTSPOverWebSocketBaseError <|-- SunapiError
```

`SunapiException` (`network/http/SunapiException.ts`) is a separate, unrelated standalone class
(legacy SUNAPI HTTP error shape) — it does not extend `RTSPOverWebSocketBaseError`.

## 3. `mediaSession` — RTP/RTCP session hierarchy

> Per-class detail: [docs/player/03-mediaSession-core-video.md](../../docs/player/03-mediaSession-core-video.md)
> (base classes, `RtpClient`, `MediaRouter`, video codec sessions) and
> [docs/player/04-mediaSession-audio-text.md](../../docs/player/04-mediaSession-audio-text.md)
> (audio/text codec sessions).

All per-codec sessions share a `Session` → `RtpSession` base, and `RtpClient` is the factory/
owner that picks which concrete session to instantiate per SDP media line.

```mermaid
classDiagram
    class Session
    class RtpSession
    class RTCPSession
    class RtpClient

    Session <|-- RtpSession
    Session <|-- RTCPSession

    RtpSession <|-- AACSession
    RtpSession <|-- AudioTalkSession
    RtpSession <|-- G711Session
    RtpSession <|-- G726Session
    RtpSession <|-- OPUSSession
    RtpSession <|-- H264Session
    RtpSession <|-- H265Session
    RtpSession <|-- VP8Session
    RtpSession <|-- VP9Session
    RtpSession <|-- AV1Session
    RtpSession <|-- MjpegSession
    RtpSession <|-- MetaSession
    RtpSession <|-- VideoRtcpSession

    RtpClient --> RTCPSession : creates
    RtpClient --> H264Session : creates
    RtpClient --> H265Session : creates
    RtpClient --> VP8Session : creates
    RtpClient --> VP9Session : creates
    RtpClient --> AV1Session : creates
    RtpClient --> MjpegSession : creates
    RtpClient --> AudioTalkSession : creates
    RtpClient --> G711Session : creates
    RtpClient --> G726Session : creates
    RtpClient --> OPUSSession : creates
    RtpClient --> AACSession : creates
    RtpClient --> MetaSession : creates
```

`MediaRouter` sits above `RtpClient`/`RtpSession` and is not part of this hierarchy — it
receives already-depacketized media via the `*Like` interfaces described in §1.

### 3a. `videoSession/BufferManagerStates` — state pattern

```mermaid
classDiagram
    class BufferState {
        <<interface>>
    }
    class PlaybackBufferManager

    BufferState <|.. InitState
    BufferState <|.. PlayState
    BufferState <|.. PauseState
    BufferState <|.. FakePauseState
    BufferState <|.. WaitPauseState
    BufferState <|.. FullState

    PlaybackBufferManager --> InitState : initial state
    PlaybackBufferManager ..> BufferState : delegates to current state
    PlaybackBufferManager --> VideoBufferList : uses
```

## 4. `network` — RTSP-over-WebSocket + SUNAPI HTTP

> Per-class detail: [docs/player/02-network.md](../../docs/player/02-network.md).

```mermaid
classDiagram
    class RtspClient
    class RtspClientManagerImpl
    class Transport
    class DigestGenerator
    class SunapiClient
    class SunapiManager
    class SunapiRestClient
    class SunapiException
    class RtspStatusCode
    class WebsocketStatusCode

    RtspClientManagerImpl --> RtspClient : creates/tracks (per-channel registry)
    RtspClient --> Transport : creates
    RtspClient --> DigestGenerator : uses
    RtspClient ..> RtspStatusCode : uses (status lookup)

    SunapiManager --> SunapiClient : creates
    SunapiManager --> SunapiException : throws
    SunapiClient ..> DigestGenerator : uses (digest auth)

    SunapiRestClient ..> SunapiClient : parallel/worker-side counterpart
```

`RtspClientManagerImpl` is the un-exported class behind the singleton exported from
`RtspClientManager.ts` (`export const RtspClientManager = new RtspClientManagerImpl()`).

`SunapiRestClient` runs inside `worker/sunapi/sunapiRequestTask.ts`'s worker rather than being
constructed by `SunapiClient` directly — see §7.

## 5. `video/player` — rendering hierarchy

> Per-class detail: [docs/player/05-video-player-rendering.md](../../docs/player/05-video-player-rendering.md).

```mermaid
classDiagram
    class VideoPlayer {
        <<abstract>>
    }
    class CanvasTagPlayer
    class VideoTagPlayer
    class CanvasRenderer
    class WebGLCanvas
    class YUVWebGLCanvas
    class StepBufferList
    class PlaybackBufferManager

    VideoPlayer <|-- CanvasTagPlayer
    VideoPlayer <|-- VideoTagPlayer

    CanvasTagPlayer --> CanvasRenderer : creates
    CanvasTagPlayer --> StepBufferList : creates
    CanvasTagPlayer --> PlaybackBufferManager : creates

    CanvasRenderer --> YUVWebGLCanvas : creates
    WebGLCanvas <|-- YUVWebGLCanvas
    YUVWebGLCanvas --> Shader : creates
    YUVWebGLCanvas --> Program : creates
    YUVWebGLCanvas --> Texture : creates
    WebGLCanvas --> Shader : creates
    WebGLCanvas --> Program : creates
    WebGLCanvas --> Texture : creates
```

`VideoTagPlayer` (MSE `<video>` tag path) does not use `CanvasRenderer`/WebGL at all — it
demuxes into fragmented MP4 via `vendor/mp4Generator` and feeds a `MediaSource` `SourceBuffer`
directly, so it has no further class dependencies beyond `VideoPlayer` and small utils
(`CircularTypedArrayQueue`, `Median`, `Mean`, `IntervalTimer`).

## 6. `listen` — audio decode + playback

> Per-class detail: [docs/player/06-listen-audio.md](../../docs/player/06-listen-audio.md).

```mermaid
classDiagram
    class AudioDecoder
    class AudioPlayer

    AudioDecoder <|-- AACAudioDecoder
    AudioDecoder <|-- G711AudioDecoder
    AudioDecoder <|-- G726_16_AudioDecoder
    AudioDecoder <|-- G726_24_AudioDecoder
    AudioDecoder <|-- G726_32_AudioDecoder
    AudioDecoder <|-- G726_40_AudioDecoder
    AudioDecoder <|-- OPUSAudioDecoder

    class G726xAudioDecoder
    G726xAudioDecoder --> G726_16_AudioDecoder : creates
    G726xAudioDecoder --> G726_24_AudioDecoder : creates
    G726xAudioDecoder --> G726_32_AudioDecoder : creates
    G726xAudioDecoder --> G726_40_AudioDecoder : creates

    AudioPlayer <|-- AudioPlayerAAC
    AudioPlayer <|-- AudioPlayerGxx

    AudioPlayerGxx --> G711AudioDecoder : creates
    AudioPlayerGxx --> G726xAudioDecoder : creates
    AudioPlayerGxx --> AACAudioDecoder : creates
    AudioPlayerGxx --> OPUSAudioDecoder : creates
```

`G726xAudioDecoder` is a dispatcher/facade over the four bitrate-specific G.726 decoders
(16/24/32/40 kbit/s) — it does **not** itself extend `AudioDecoder`, it composes them and
selects one per stream.

## 7. `worker` — Web Worker–side classes

> Per-class detail: [docs/player/07-talk-backup-worker.md](../../docs/player/07-talk-backup-worker.md).

Each worker entry point (`*Worker.ts`) is a thin `onmessage` shim around one real class; none of
these classes reference the main-thread classes above directly (workers only exchange
plain-data messages with `RtpClient`/`VideoTagPlayer`/etc. across the worker boundary).

```mermaid
classDiagram
    class AviFormatWriter
    class AviFileWriter
    class AudioHeader
    class VideoHeader
    class BackupSession
    class AssemblyDecoder
    class AssemblyTranscoder
    class MjpegDepacketizer
    class SunapiRequestTask

    AviFormatWriter <|-- AudioHeader
    AviFormatWriter <|-- VideoHeader
    BackupSession --> AviFileWriter : creates
    BackupSession ..> AudioHeader : builds frames typed by
    BackupSession ..> VideoHeader : builds frames typed by

    decoderWorker ..> AssemblyDecoder : owns
    audiotranscoderWorker ..> AssemblyTranscoder : owns
    mjpegDepacketizeWorker ..> MjpegDepacketizer : owns
    sunapiRequestTask ..> SunapiRequestTask : owns
```

## 8. `backup` (main-thread) and `talk`

> Per-class detail: [docs/player/07-talk-backup-worker.md](../../docs/player/07-talk-backup-worker.md).

```mermaid
classDiagram
    class BackupProvider
    class FileMaker
    class Talk

    BackupProvider --> FileMaker : creates
```

`Talk` (talk-back / two-way audio) has no class dependencies within `src/player` beyond the
shared `exceptions`/`util` helpers — it drives a G.711 encoder function
(`talk/encoder/G711AudioEncoder.ts`) but that module exports a class (`G711AudioEncoder`) used
purely as a stateless-ish encoder, not subclassed or composed by other classes here.

## 9. `interface` — orchestration layer detail

> Per-class detail: [docs/player/01-elements-interface-exceptions.md](../../docs/player/01-elements-interface-exceptions.md).

```mermaid
classDiagram
    class StreamManager
    class StreamPlayer

    StreamManager --> StreamPlayer : creates, tracks in module-level registry
```

`StreamManager` reproduces a legacy quirk deliberately: `playerContainer`/`currentPlayer` are
module-level (not instance) state, so every `new StreamManager()` shares one player registry
(see the doc comment in [interface/StreamManager.ts](interface/StreamManager.ts)). Don't "fix"
this into instance state without checking `legacyHostInterface` callers that rely on it.

## 10. `util` — notable standalone classes

> Per-class detail: [docs/player/08-util.md](../../docs/player/08-util.md).

Most of `util/` is small, dependency-free helper classes with no inheritance:
`BufferList`/`BufferNode`, `CircularTypedArrayQueue`, `Queue`, `RTSPOverWebSocketMap`, `Size`,
`Mean`, `Median`, `IntervalTimer`, `DigestGenerator`, `H264SPSParser`, `H265SPSParser`,
`CommonAudioUtil`. Two exceptions:

- `Fisheye3D` / `Fisheye3DMulti` — independent (not related by inheritance), both consume
  `fishEyeMesh.ts`'s `GridMesh`/`MeshVertex`/`FisheyeConfig`/`FisheyeMeshGenerator`.
- `fishEyeMesh.ts` — `FisheyeMeshGenerator` creates `GridMesh` (which is built from
  `MeshVertex` instances), configured by `FisheyeConfig`.

```mermaid
classDiagram
    class FisheyeMeshGenerator
    class GridMesh
    class MeshVertex
    class FisheyeConfig
    class Fisheye3D
    class Fisheye3DMulti

    FisheyeMeshGenerator --> GridMesh : creates
    GridMesh --> MeshVertex : creates
    FisheyeMeshGenerator ..> FisheyeConfig : configured by
    Fisheye3D ..> FisheyeMeshGenerator : uses
    Fisheye3DMulti ..> FisheyeMeshGenerator : uses
```

## Notes on scope

- `legacyHostInterface/`, `vendor/*.d.ts`, and `react/Constant.ts` are type-only (interfaces),
  no classes — omitted from the diagrams above.
- `elements/RTSPOverWebSocketTypes.ts` and `elements/panelStyles.ts` are types/constants, not
  classes.
- Interfaces are shown only where they express a real pattern (`BufferState`, the `*Like` DI
  seams in `MediaRouter.ts`); most exported `interface`s here are plain data shapes and were
  left out to keep the diagrams legible.
