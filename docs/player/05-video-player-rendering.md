# 05. Video Player Rendering (`src/player/video/player`)

*Per-class reference for the rendering hierarchy that turns a decoded (or, for MJPEG, still-encoded JPEG) video
frame into visible pixels: the canvas/WebGL pipeline and the `<video>`-tag/MSE pipeline.*

**Version:** 1.2.0 · **Author:** Youngho Kim

**History**

| Date | Change |
| --- | --- |
| 2026-08-06 | Add per-class reference docs for `src/player` (initial version) |
| 2026-08-11 | Add AV1/VP8/VP9 + WebCodecs decode support, per-class player docs, server lifecycle/config improvements, and fix SUNAPI protocol clobbering on non-http(s) hosts |
| 2026-08-11 | Add real B-frame support to `VideoTagPlayer` via ISOBMFF composition-time-offsets |
| 2026-08-11 | Guard `VideoTagPlayer.createAudioSample()` against undefined `frameData` |
| 2026-08-26 | Added Title/Abstract/Version/Author/History metadata header |
| 2026-08-26 | Cross-link the new box-level MP4 container generation doc (file 09) |
| 2026-09-02 | Fix `StepBufferList.setBufferingLength()` never guarding against a `NaN` input — reported live as `#forward`/`#backward` staying disabled forever with no crash/error. A stream whose SDP has no optional `a=framerate:` line (`RtspClient.ts`) leaves `videoInfo.framerate` `undefined`, so `push()`'s `videoInfo.framerate * 4` auto-tune passed `NaN` straight through both clamp checks (neither `> MAX` nor `< MIN` ever matches `NaN`), leaving `bufferingLength` permanently `NaN` and `push()` permanently unable to return `false` ("buffer full") — the exact edge case this file's own code comment had already flagged as theoretically possible but never actually guarded. Fixed by falling back to `DEFAULT_BUFFERING_LENGTH` for any non-finite `length` before clamping. See MEMORY.md. |
| 2026-09-03 | Added MJPEG's new real-MSE tier: `WebCodecsVideoEncoder` (`worker/videoEncoder/`, new) re-encodes each JPEG frame to H264, muxed into fMP4 via the same `mp4Generator` path H264/H265/VP9/AV1 already use. Quick-reference table gained an MJPEG column; `VideoTagPlayer`'s Method Analysis gained a new "MJPEG real-MSE tier" section (`decideUseMjpegEncoder`/`setupMjpegEncoder`/`submitMjpegFrame`/`onMjpegEncodedChunk`/`closeMjpegEncoder`, plus the shared `ingestVideoSample()` extracted from `onVideoData()` and `createSampleFrameData()`'s new `isEncoderSourced` parameter). Requested directly by the user, sized and reviewed as an approved plan before implementation. See `03-mediaSession-core-video.md`, `08-util.md`, `09-mp4-container-generation.md`, and this repo's `MEMORY.md` for the full cross-file picture. |
| 2026-09-03 | Fixed a real, previously-undiscovered `setSourceBuffer()`/`ingestVideoSample()` `SourceBuffer`-creation race, found live via a synthetic-JPEG Playwright harness testing the MJPEG tier above (reported by the user as MJPEG not playing via the video tag against a real device — root cause confirmed to explain it exactly). `setSourceBuffer()` no longer calls `addBufferEventListener()` on a `null` `this.sourceBuffer`; `ingestVideoSample()` now retries `setSourceBuffer()` itself once the real codec is known if `'sourceopen'` beat it there first. General fix, not MJPEG-gated — see the new bullet in `VideoTagPlayer`'s Method Analysis and `MEMORY.md`'s full live-debugging narrative. |
| 2026-09-03 | Fixed a second real bug in the same tier, reported immediately after the fix above against the same real camera: `WebCodecsVideoEncoder: no supported VideoEncoder configuration found for 2048x1536`. `codecString.ts`'s `mjpegEncoderCandidateCodecStrings()` used to return one fixed Level 3.1/4.0 candidate pair regardless of actual resolution — MJPEG has no codec-level resolution ceiling, and 2048x1536 (12,288 macroblocks/frame) exceeds Level 4.0's 8,192 MaxFS. Now resolution- and framerate-aware (`H264_LEVEL_LIMITS`, the full H.264 Annex A level table, `selectH264LevelIndexes()`) — both `MediaRouter.ts`'s pre-flight probe and `WebCodecsVideoEncoder.configure()`'s real check now compute the actually-required level instead of guessing. See `08-util.md` and `MEMORY.md`. |
| 2026-09-03 | Fixed a third real bug: Playback mode (recorded MJPEG, not Live) still didn't play even with `tagMode: 'video'` correctly selected. `createSegment()` (the dual-track `moof+mdat` builder Playback mode uses, shared with every real-MSE codec — not MJPEG-specific) requires both video *and* audio samples queued before building anything; the only place dummy audio was seeded only ran from the *second* I-frame boundary onward, so a Playback session with no real audio track and either a short clip or (MJPEG's case) an infrequent keyframe cadence could deadlock forever with zero segments ever appended. `createSegment()` now also seeds dummy audio itself, on any caller, whenever none is queued yet — capped through `makeDummyAudio()`'s safe direct-add input range (its own `>100000` branch silently no-ops for large multi-sample spans, a real trap the first fix attempt hit). See `MEMORY.md` for the full narrative. |
| 2026-09-03 | Fixed a fourth real bug, the most serious in this saga: Playback video now appeared but played back corrupted (OSD oscillating, 20+s latency, wrong apparent frame rate). Two layers: (a) `createSegment()`'s `MAX_PLAYBACK_DIFF` fallback timeout was only ever rescheduled from an I-frame boundary, so periodic flushing silently stopped between whatever keyframe cadence a real `VideoEncoder` happened to choose on its own (observed ignoring this tier's own `forceKeyFrame` request) — now reschedules unconditionally on every `createSegment()` call. (b) `initBaseAudioTime()` (an A/V-drift resync helper, shared by every codec's Playback path) reassigned `this.baseVideoTime` — not `baseAudioTime`, despite the function's name — from an absolute wall-clock formula, corrupting the purely-relative video clock every time a resync fired mid-session in Playback mode specifically (Live mode's own resync never zeroed `baseVideoTime` first, so never hit this). Confirmed live: `baseVideoTime` jumping from ~65,000 to ~75,000,000 mid-session. Fixed by deleting the reassignment. A smaller, not-yet-root-caused oscillation pattern remains — see `MEMORY.md`. |
| 2026-09-03 | Fixed a fifth real bug, continuing the fourth's leftover oscillation: two corrections tuned for H264/H265's larger, sparser Playback segments fired far too often against MJPEG's smaller, real-time-paced ones. `onWaiting()` used to unconditionally truncate `currentTime` to the floor integer second on every ordinary 'waiting' event (not just genuine out-of-range recovery), discarding real playback progress every ~0.5-0.9s cycle — now only truncates when `currentTime` is actually non-finite or at/past the buffered end. `videoPlay()` used to require a full 1s buffer-ahead margin before *every* resume, not just cold start — a permanent deadlock for MJPEG's slow, small-increment trickle — now only cold start (`currentTime === 0`) requires that margin; mid-session resume just requires `latency <= 0`. See `MEMORY.md`. |
| 2026-09-03 | Fixed a sixth real bug, the root cause the fifth bug's fixes didn't reach: `onWaiting()`'s A/V-drift resync compared the real, monotonically-accumulating `baseVideoTime` against `baseAudioTime` even when `dummyAudio` is `true` (MJPEG's re-encoder tier has no real audio at all — `baseAudioTime` only advances via `makeDummyAudio()`'s synthetic seeding, not a real timing signal). Dummy audio routinely drifts past the 2-second threshold with no real desync, triggering `resetBaseDecodingTime()` to zero `baseVideoTime` and discard several already-buffered real seconds — every subsequent muxed segment's PTS then landed back inside the already-covered buffered range instead of extending it, so `SourceBuffer.buffered.end()` froze despite appends continuing to succeed (confirmed via direct instrumentation: `{baseVideoTime: 85000, baseAudioTime: 58880, dummyAudio: true}` logged at the exact moment the freeze began). This is what the user reported as OSD cycling and a 2fps source appearing to output ~7fps. Fixed by skipping this resync check entirely while `dummyAudio` is `true`; a real second audio track's resync behavior is unchanged. See `MEMORY.md` for the full trace narrative. |
| 2026-09-03 | Fixed a seventh real bug, reported live against a real 2048x1536 camera after the sixth fix: a real "Statistics" panel `Latency` value going negative (`currentTime` past the actual buffered end) after playing for a while. Root-caused two contributing issues via direct instrumentation: (a) `WebCodecsVideoEncoder`'s backpressure signal (`encodeQueueSize`) didn't count frames still awaiting its own `createImageBitmap()` decode step, only the underlying `VideoEncoder`'s queue — an invisible backlog that grew from ~1s to ~28s of real lag within one real minute in a synthetic 2048x1536 noise-JPEG trace (see `07-talk-backup-worker.md`). (b) `videoUpdating()`'s Playback branch snapped `currentTime` to the *raw* buffered `endTime` with zero safety margin on a `boxsize` transition, unlike every other currentTime correction in this class (which all back off by `defaultDelay`/`this.delay` first) — risking landing exactly on the edge of what's not yet fully decodable. Fixed (a) in `WebCodecsVideoEncoder` (see that doc) and (b) by backing this snap off by `defaultDelay`, clamped to not go behind `startTime`, matching `onWaiting()`'s own pattern. See `MEMORY.md` for the full narrative, including the caveat that (a)'s measured magnitude may be specific to a software-only (no hardware acceleration) test environment — not yet confirmed as the full explanation for the real device's smaller-magnitude (~6s) negative latency. |
| 2026-09-03 | Fixed an eighth real bug, the actual root cause of the negative-`Latency` stall the seventh bug's fixes didn't resolve: `changeCurrentTime()` (only called from `onVisibilityChange()`, on the page's `visibilitychange` event) jumped `currentTime` to a `boxStartTime`-derived value with no validation against what's actually buffered — safe while the tab stays foregrounded, but not after a real background period, where a browser-throttled `<video>` clock stays frozen while RTP delivery/segment creation keeps running, so the jump target can point past whatever's actually finished appending by the time the tab refocuses. The user's own report of the exact symptom shape (stall is transient, self-recovers once `Latency` turns positive again) is what narrowed it to this jump-then-wait-to-catch-up site specifically, distinct from the seventh bug's chronic-backlog/zero-margin issues. Confirmed via an A/B synthetic harness (freeze `currentTime` via `playbackRate = 0` while feeding continues, then fire a real `visibilitychange`): reverting the fix reproduced a real overshoot in the same harness. Fixed by clamping the jump target to `sourceBuffer.buffered.end() - defaultDelay`, the same margin pattern used everywhere else in this class. See `MEMORY.md` for the full narrative. |
| 2026-09-03 | Fixed Playback timestamp cues (the `VTTCue`/`timeStampCallback` mechanism feeding OSD/UI clock sync) going missing at higher device Scale, reported directly by the user. Not MJPEG-specific — applies to Playback for any codec. A first attempt (pulling `TextTrack.activeCues` from `onTimeUpdate()`) made no measurable difference, confirmed via an A/B test: `activeCues` is recomputed by the same "time marches on" algorithm responsible for `onenter`/`onexit` in the first place, so it shares the identical coarse dispatch cadence — a cue whose entire lifetime falls inside one scheduling gap is invisible to both. Fixed by searching `track.cues` (the static list, unaffected by that batching) directly against the live `videoElement.currentTime`, driven by a new `requestAnimationFrame` poll (`startTimestampCuePolling()`/`stopTimestampCuePolling()`) instead of any TextTrack-native event. A same-scenario A/B test went from 10% to 90% cue-delivery coverage at 8x requested speed under low system load; re-confirming later under heavier concurrent load showed the measured percentage is highly load-sensitive (the bottleneck shifts to encode throughput, the seventh bug's territory, when CPU is scarce) — the fix never measured worse than the pre-fix baseline in any same-load comparison, and some residual loss at extreme speeds/heavy load is an accepted, expected limit of firing cue-shaped events off a `<video>` timeline at all. See `MEMORY.md` for the full narrative, including a corrected initial assumption about Playback's own speed handling and the load-sensitivity caveat. |

---

This document covers the rendering hierarchy that turns a decoded (or, for MJPEG, still-encoded
JPEG) video frame into visible pixels: the `VideoPlayer` abstract base and its two concrete
strategies — the canvas/WebGL pipeline (`CanvasTagPlayer` + `CanvasRenderer` + the `webgl/`
package) and the `<video>`-tag/MSE pipeline (`VideoTagPlayer`). Both are ports of the legacy
player's `Video/Player/*` sources; see [`src/player/README.md`](../../src/player/README.md#5-videoplayer--rendering-hierarchy)
for the one-page class-diagram summary this document expands on.

**Decode-path quick reference** (read this before chasing a decode-performance or
codec-support question into the wrong file — confirmed the hard way once already, see
MEMORY.md's "canvas tag vs video tag decode paths" entry):

| Renderer Type (`tagMode`) | H.264 / H.265                                              | VP8 / VP9 / AV1                                                              | MJPEG |
| -------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------- | ----- |
| `canvas`                   | `decoderWorker` → `AssemblyDecoder` (vendored ffmpeg.wasm, **software** decode) | `decoderWorker` → `WebCodecsVideoDecoder` (browser-native `VideoDecoder`, hardware-capable) | `CanvasRenderer.draw()` — `new Image()` + a Blob URL, i.e. the browser's native (non-WebCodecs) JPEG image decoder; no worker, no JS decode of any kind. |
| `video`                    | **No JS decoder at all.** `VideoTagPlayer` remuxes RTP → fragmented MP4 (`mp4Generator`) and hands it to a real `<video>` element via MSE — the *browser's own* internal decoder does the work, same as playing a local MP4 file. | `MediaSource.isTypeSupported()`-gated: real MSE (same as H264/H265 above) if the browser declares support for that codec's fMP4 box type, else falls back to `WebCodecsVideoDecoder` in **`'bridge'`** output mode (decoded `VideoFrame`s piped into a `MediaStreamTrackGenerator` feeding the `<video>` element) — see `VideoTagPlayer`'s own Method Analysis below for the `realMseSupported` check. | (2026-09-03) **Re-encodes, doesn't decode.** `WebCodecsVideoEncoder` re-compresses each JPEG frame to H264 (`createImageBitmap` → `VideoFrame` → `VideoEncoder`), muxed into fMP4 via the same `mp4Generator` path as native H264 above — `MediaRouter.ts`'s `typeof VideoEncoder !== 'undefined'` + `MediaSource.isTypeSupported()` pre-flight gates this; **no bridge fallback exists** (a decode-direction bridge can't produce an encoded bitstream), so unsupported means `tagMode` stays `'canvas'`, never a broken `'video'`. See the new "MJPEG real-MSE tier" section below. |

The one thing both tag modes share for H.264/H.265: neither one ever runs `WebCodecsVideoDecoder`
for those two codecs specifically — `canvas` always uses the WASM path, `video` always uses real
MSE (browser-native decode, not WebCodecs). A decode-throughput complaint for H.264/H.265 in
`canvas` mode is a `decoderWorker`/`AssemblyDecoder` question; the same complaint in `video` mode
is *not* — there's no vendored decoder involved at all, so look at `VideoTagPlayer`'s fMP4-muxing/
MSE-append pipeline (and the browser's own decode capability for that resolution/profile) instead.

Collaborators documented elsewhere, referenced here by name only:
- **`MediaRouter`** (`mediaSession/MediaRouter.ts`) — the RTP/session-layer class that owns a
  `VideoPlayerLike` instance (`this.player`) and is the sole source of decoded/depacketized frame
  data flowing into this module.
- **`StreamPlayer`** (`interface/StreamPlayer.ts`) — the orchestration-layer class that supplies
  `MediaRouter`'s `createCanvasPlayer`/`createVideoPlayer` factories (`() => new CanvasTagPlayer()`,
  `() => new VideoTagPlayer()`).
- **`PlaybackBufferManager`** (`mediaSession/videoSession/PlaybackBufferManager.ts`) — the
  H.265-playback reordering buffer `CanvasTagPlayer` creates and drives; see §4/§5 relations below.
- **`H264Session`/`H265Session`/`VP8Session`/`VP9Session`/`AV1Session`/`MjpegSession`**
  (`mediaSession/videoSession/`) — upstream RTP depacketizers that produce the
  `VideoStreamData`/`VideoInfo` objects this module consumes. `CanvasRenderer.setCanvas()`
  recognizes all five non-MJPEG `codecType`s identically (`YUVWebGLCanvas`); VP8/VP9 are
  confirmed rendering correctly end-to-end (screenshot-verified via the demo server), AV1 is
  implemented identically but unverified end-to-end (this environment's `ffmpeg` can't produce a
  live AV1 source — see `03-mediaSession-core-video.md`'s VP8/VP9/AV1 section for the full story,
  including two real bugs the live-testing pass found and fixed: a `decoderWorker.ts` readiness
  race, and a missing `UNPACK_ALIGNMENT` WebGL call).
- **`decoderWorker`** (`worker/videoDecoder/decoderWorker.ts`) — the Web Worker `CanvasTagPlayer`
  spawns to decode video off the main thread. Owns either an `AssemblyDecoder` (H264/H265, vendored
  ffmpeg.wasm) or a `WebCodecsVideoDecoder` (VP8/VP9/AV1, browser-native WebCodecs `VideoDecoder`)
  — see `07-talk-backup-worker.md`'s `AssemblyDecoder`/`WebCodecsVideoDecoder` sections.
- **`CircularTypedArrayQueue`, `Median`, `Mean`, `IntervalTimer`, `Size`, `BrowserDetect`** (`util/`)
  — small standalone utilities consumed here; usage is described precisely below but their own
  implementations are documented in the `util/` reference.

## Class hierarchy

```mermaid
classDiagram
    class VideoPlayer {
        <<abstract>>
        +boxsize number
        +frameRate number
        +rfps number
        +audioshift number
        +speed number
        +init(element)
        +onVideoData(playMode, streamData, videoInfo)
        +play() pause() resume() stop() close()
        +onNetworkState(variance, mean)* abstract
        +onChangeAudioShift(v)* abstract
        +onChangeSpeed(v)* abstract
        +capture(fileName)* abstract
        +toggleControls(flags)* abstract
    }
    class CanvasTagPlayer
    class VideoTagPlayer
    class CanvasRenderer
    class Image2DCanvas
    class WebGLCanvas
    class YUVWebGLCanvas
    class Shader
    class Program
    class Texture
    class StepBufferList

    VideoPlayer <|-- CanvasTagPlayer
    VideoPlayer <|-- VideoTagPlayer

    CanvasTagPlayer --> CanvasRenderer : creates (init())
    CanvasTagPlayer --> StepBufferList : creates (init())
    CanvasTagPlayer ..> "decoderWorker (Worker)" : postMessage/onmessage

    CanvasRenderer --> YUVWebGLCanvas : creates (H264/H265)
    CanvasRenderer --> Image2DCanvas : creates (MJPEG)

    WebGLCanvas <|-- YUVWebGLCanvas
    WebGLCanvas --> Shader : creates
    WebGLCanvas --> Program : creates
    WebGLCanvas --> Texture : creates
    YUVWebGLCanvas --> Shader : creates (own scripts)
    YUVWebGLCanvas --> Program : creates (own scripts)
    YUVWebGLCanvas --> Texture : creates (Y/U/V)
```

`VideoTagPlayer` has **no** `CanvasRenderer`/WebGL dependency whatsoever — confirmed by reading the
whole file: its only non-`VideoPlayer` imports are `moment-timezone`, `file-saver`, the vendored
`mp4Generator`, and the small utils listed above (`VideoTagPlayer.ts:1-12`). It builds fragmented
MP4 directly and feeds it to a native `<video>` element via Media Source Extensions.

---

### `VideoPlayer` (`src/player/video/player/VideoPlayer.ts`)

- **Structure.** Abstract base class (`VideoPlayer.ts:46`). Plain fields: `boxsize`, `currentFrameCount`,
  `previousFrameCount`, `framedrop`, `type`, `frameRate`, `minRemainTime`, `minTimerInterval`,
  `maxdelay`, `currentdelay`, `audioCodecHint` (real bug fix: set by `MediaRouter.handleVideoData`
  from SDP — see `MediaRouter`'s `setAudioCodecHint()` in `03-mediaSession-core-video.md` — right
  before `init()`, alongside `codec`, so a subclass can know the audio codec *before* its first
  `onVideoData`/`onAudioData` call rather than only reactively; `VideoTagPlayer` is the only current
  consumer, see its `init()`/`setAudioInfo()` entries below), plus optional callbacks
  `errorCallback`/`eventStatisticsCallback`/`eventCaptureCallback`/`eventInstantPlaybackCallback`
  (`:47-69`). Backing-field-driven getter/setter
  pairs (real TS accessors, not plain fields) for `channelId`, `playmode`, `instantplayback`,
  `deviceType`, `codec`, `rfps`, `audioshift`, `speed` (`:81-175`) — ported from legacy's
  `Object.defineProperty` calls on `VideoPlayer`'s prototype so both subclasses inherit the exact
  same side effects. A private `fpsQueue = new CircularTypedArrayQueue<number>(5, true)` (`:79`)
  backs the `rfps` setter's network-state analysis. No constructor of its own (implicit default);
  never instantiated directly — only `CanvasTagPlayer`/`VideoTagPlayer` extend it.
  Inheritance: `VideoPlayer <<abstract>> <|-- CanvasTagPlayer, VideoTagPlayer`.

- **Method Analysis.**
  - `set rfps(v)` (`:125-157`) — the one method with real logic in this class. Pushes `v` into the
    5-slot `fpsQueue`; once full, computes `Median.variance(samples)` and buckets it into a
    `'poor' | 'fair' | 'good' | 'very_good' | 'excellent'` state string, reports it through
    `errorCallback` with `fromHex('0x1005')`, then calls the abstract `onNetworkState(variance, mean)`
    hook so each subclass can react (`CanvasTagPlayer` ignores it; `VideoTagPlayer` uses it to tune
    `networkWeight`, which feeds its MSE buffering delay).
  - `set audioshift(v)` / `set speed(v)` (`:163-175`) — call the abstract `onChangeAudioShift`/
    `onChangeSpeed` hooks *before* updating the backing field, so subclasses see the *previous*
    value via `this.audioshift`/`this.speed` while handling the change.
  - `init`, `onVideoData`, `onWaitingPackets`, `play`, `pause`, `resume`, `stop`, `close`,
    `clearBuffer`, `updateMiniMapInfo` (`:177-233`) — no-op defaults; every real subclass overrides
    them.
  - `addEventListener(event, callback)` (`:195-207`) — a 3-case switch (`statistics`/`capture`/
    `instantplayback`) storing the callback into the matching `event*Callback` field; not a real
    `EventTarget`, just a legacy-compatible dispatch table.
  - `setFrameRate`/`getFrameRate`, `setMaxInstantPlayback`/`getMaxInstantPlayback`,
    `setBufferClearInterval`/`getBufferClearInterval`, `setDefaultDelay`/`getDefaultDelay`,
    `setCurrentDelay`/`getCurrentDelay` (`:209-253`) — plain accessor pairs over the fields above.
  - `instantplaybackCmd({cmd})` (`:255-261`) — only handles `cmd === 'play'` (calls `this.play()`);
    both subclasses override this with a fuller command set.
  - `onNetworkState`, `onChangeAudioShift`, `onChangeSpeed`, `capture`, `toggleControls` (`:267-271`)
    — declared `abstract`. Legacy never defines a base implementation for these either (not even a
    log-only stub, unlike the no-op methods above); every real instance is one of the two
    subclasses, both of which implement all five, so the `abstract` keyword is a compile-time
    encoding of what was an implicit runtime contract in legacy.
  - Deliberately **not** declared here despite looking universal: `bufferingVideoData`,
    `sendToBufferManager`, `digitalZoom`, `controlStepPlay` — legacy's `videoTagPlayer` never
    defines these on its own prototype, so calling them on a real `VideoTagPlayer` throws
    `TypeError`. See `VideoTagPlayer`'s own section below.

- **Call Stack.** N/A directly — `VideoPlayer` itself never runs a frame through; see the
  `CanvasTagPlayer`/`VideoTagPlayer` sections.

- **RFC / Standard References.** None — pure internal state/lifecycle base class.

- **Relations & Data Flow.** `MediaRouter` talks to instances of this hierarchy only through the
  structural `VideoPlayerLike` interface (`mediaSession/MediaRouter.ts:136-176`), which both
  `CanvasTagPlayer` and `VideoTagPlayer` satisfy without formally implementing it in TypeScript —
  it exists purely for `MediaRouter`'s own typing of `this.player`.

---

### `CanvasTagPlayer` (`src/player/video/player/canvas/CanvasTagPlayer.ts`)

- **Structure.** Extends `VideoPlayer` (`CanvasTagPlayer.ts:60`). Fields: `renderer: CanvasRenderer
  | null`, `canvasElement: HTMLCanvasElement | null`, `rendererCheck` (resize-event dedup flag),
  `videoSizeCallback`/`timeStampCallback`, `decoderWorker: Worker | null`, `frameCount` (MJPEG
  frame-drop counter), `stepVideoList: StepBufferList | null`, `isStepPlaying`,
  `bufferManager: PlaybackBufferManager | null`, `mediaTimer` (1s FPS-stats interval),
  `checkedPlayer` (`:61-77`). Constructor takes an injectable `DecoderWorkerFactory` defaulting to
  `() => new Worker(new URL('.../decoderWorker.ts', import.meta.url))` (`:114-119`) — the same
  injectable-factory pattern used elsewhere in this codebase for browser-dependent APIs. A
  module-level `decoderCount` counter (`:42`) is passed to the worker as `setDecoderIndex` on each
  creation. Inheritance: `VideoPlayer <|-- CanvasTagPlayer`.

- **Method Analysis.**
  - `init(element)` (`:300-321`) — clones the caller's `<canvas>` element and replaces it in the
    DOM (so React/consumer re-renders don't fight with in-place canvas mutation), constructs a
    `CanvasRenderer`, wires its `channelId` and `capture` listener, calls `renderer.init(canvasElement)`,
    creates a fresh `StepBufferList`, registers a `webglcontextlost` handler
    (`onHandleContextLost`, reports error `0x0902`), and starts a 1s `setInterval` driving
    `onMediaTimer` (FPS/bandwidth statistics).
  - `checkPlayer(streamData, videoInfo, playMode)` (`:138-148`, private, idempotent via
    `checkedPlayer`) — for non-MJPEG codecs spawns the decoder worker (`createDecoderWorker`);
    always calls `renderer.setCanvas(codecType, videoInfo)` to lazily construct the right drawer.
  - `createDecoderWorker(codecType, videoInfo, playMode)` (`:121-136`) — creates the `Worker`,
    wires `onmessage → decoderWorkerMessage`, and posts a sequence of setup messages:
    `createDecoder`, `setOutputSize` (`w*h + w*h/4 + w*h/4` — exact YUV420 planar byte count),
    `setFrameRate`, `setDecoderIndex`, `useDropPacket`, `playMode`.
  - `onVideoData(playMode, streamData, videoInfo)` (`:335-390`, overrides `VideoPlayer`) — the
    per-frame entry point from `MediaRouter`/`PlaybackBufferManager`. Calls `checkPlayer`, then
    tags `streamData.timeStamp.mode = this.playmode` (`'live'`/`'playback'`, already lowercased by
    `MediaRouter.selectVideoPlayer()`'s `player.playmode = playMode.toString().toLowerCase()`)
    before anything else — real bug fix, found live: `VideoTagPlayer` has always tagged its own
    per-sample `timeStamp.mode` this way (`updateVideoTimestamp`/`onVideoSourceUpdateEnd`), but
    this class never did, so every consumer that switches on the dispatched `'timestamp'` event's
    `mode` field (e.g. an app's Live-vs-Playback timestamp readout) silently no-opped for every
    canvas-rendered frame. Tagged once on `streamData.timeStamp` here rather than at each of the
    three places that later hand it to `timeStampCallback` (the `checkFrameDrop` early-return right
    below, the MJPEG `mjpegDraw` closure, and the H264/H265 decoder-worker round trip) — the
    decoder-worker path structured-clones this same object into the worker and echoes it straight
    back as the `'decoded'` message's `data.time`, so the one assignment covers all three. Then
    `checkFrameDrop` (MJPEG-only frame-skip logic driven by `videoInfo.dropOut`). For MJPEG:
    schedules `renderer.draw(frameData, videoInfo, callback)` via `setTimeout` with a
    size-tiered delay (`FRAME_SIZE.HD/FHD/UHD` thresholds → 200/160/120/80ms) that throttles
    decode-free JPEG blits to something screen-refresh-reasonable. For H264/H265: posts a
    `decode` message to `decoderWorker` carrying `frameData`, `frameType`, `width`/`height`,
    `cropWidth`/`cropHeight`, and `currentFps` (`this.rfps ?? this.getFrameRate()`).
  - `decoderWorkerMessage(event)` (`:164-256`, private) — the worker's `onmessage` handler; the
    core of the rendering pipeline for the coded path. `'decoded'` case (`:167-218`): increments
    `currentFrameCount`; bails if `renderer.userPaused && !isStepPlaying`; if a
    `PlaybackBufferManager` exists and doesn't need a restart, immediately pops the next buffered
    frame (`popNextFrame(true)`) to keep the pipeline moving; if the canvas element's current
    `width`/`height` matches the decoded frame's, calls `renderer.draw(data.frame, {})` (drawing
    the actual YUV buffer) and `resizeCheck`; otherwise it *resizes the canvas attributes instead
    of drawing* (first-frame / resolution-change bootstrapping). Forwards `data.time` to
    `timeStampCallback` for A/V-sync bookkeeping. `'notReady'` case: asks the buffer manager to
    retry via `front()` + a 500ms `setTimeout(() => popNextFrame(false), 500)`. `'lowPerformance'`
    case: reports error `0x090B` with decoder id/perf info. `'terminated'`: tears down the worker.
  - `bufferingVideoData`/`sendToBufferManager`/`controlStepPlay`/`digitalZoom` (`:394-416, 456-461,
    479-483`) — the four methods `VideoPlayer.ts` deliberately does *not* declare abstract because
    they're canvas-only. `sendToBufferManager` lazily creates the `PlaybackBufferManager` (H.265
    Playback reordering) and pushes into it; `bufferingVideoData` pushes into `StepBufferList`
    instead (frame-stepping mode). `digitalZoom` forwards into `CanvasRenderer.digitalZoom`, which
    (see below) is genuinely broken/dead in both legacy and this port.
  - `stepPlay(cmd)` / `forward()` / `backward()` (`:258-270, 463-471`) — drive `StepBufferList`
    forward/backward and re-invoke `onVideoData` with the retrieved node's data, or (on list
    exhaustion) call `renderer.renewCanvas()` for camera devices.
  - `play`/`pause`/`resume`/`stop` (`:431-454`) — toggle `renderer.userPaused` and, where
    applicable, pause/resume the `PlaybackBufferManager`.
  - `close()` (`:489-512`) — tears down the context-lost listener, the stats timer, the renderer
    (`renewCanvas` + `destroy`), posts `terminate` to the decoder worker, and drops the buffer
    manager reference.

- **Call Stack.** See the combined diagram in the "Relations & Data Flow" section below (H264/H265
  branch) — the decoder-worker round trip is the defining feature of this path versus
  `VideoTagPlayer`'s synchronous, worker-free muxing.

- **RFC / Standard References.** None of its own (orchestration only); the actual pixel-producing
  standard is WebGL, owned by `CanvasRenderer`'s `YUVWebGLCanvas` drawer (see below). MJPEG frames
  are plain JFIF/JPEG blitted via the 2D Canvas API (no external RFC — `Image2DCanvas` just calls
  `ctx.drawImage`).

- **Relations & Data Flow.** Created by `StreamPlayer`'s `createCanvasPlayer` factory
  (`() => new CanvasTagPlayer()`), selected by `MediaRouter.selectVideoPlayer()` when `tagMode ===
  'canvas'` (MJPEG always, small/step-play H264, H265 whenever the browser's `MediaSource` can't
  handle the negotiated codec profile, or NVR/oversized H264 falls to `video` instead — see
  `MediaRouter.ts:1308-1391`). `VP8`/`VP9`/`AV1` aren't a case in that `switch` at all, so they fall
  to `default: break` and land on `'canvas'` too — which is the *correct* outcome for them (not a
  gap): `CanvasRenderer.setCanvas()`'s codec switch (below) and `decoderWorker`/
  `WebCodecsVideoDecoder` do fully decode/render these three now (see
  `03-mediaSession-core-video.md`'s VP8/VP9/AV1 section), and none of them would benefit from the
  H264/H265-only MSE `<video>`-tag path this `switch` also decides between — WebCodecs decoder
  output is raw frames, not encoded data MSE could consume, and `vendor/mp4Generator.js` has no
  `vp08`/`vp09`/`av01` box-type support regardless. `CanvasTagPlayer.init()` creates its own `CanvasRenderer` and
  `StepBufferList`; `sendToBufferManager()` lazily creates its own `PlaybackBufferManager`
  (documented under `mediaSession`) — matching the README's class diagram, which shows
  `CanvasTagPlayer --> PlaybackBufferManager : creates`. **Video only** — this class declares no
  `onAudioData`, so `MediaRouter.handleAudioData` falls back to a standalone `AudioPlayerGxx` for
  audio whenever `CanvasTagPlayer` is active; that decode/playback subsystem is documented
  separately in `06-listen-audio.md` (see its "Where this subsystem fits" section).

```mermaid
flowchart LR
    MR["MediaRouter.onVideoData"] -->|"stepFlag / bufferManager routing"| CTP["CanvasTagPlayer"]
    CTP -->|"H264/H265: postMessage('decode')"| DW["decoderWorker (Worker thread)"]
    DW -->|"postMessage('decoded': YUV420 frame)"| CTP
    CTP -->|"renderer.draw(frame, {})"| CR["CanvasRenderer"]
    CTP -->|"MJPEG: renderer.draw(frameData, videoInfo)"| CR
    CR -->|"H264/H265"| YUV["YUVWebGLCanvas.drawCanvas"]
    CR -->|"MJPEG"| I2D["Image2DCanvas.drawCanvas"]
    CTP -->|"sendToBufferManager / bufferingVideoData"| PBM["PlaybackBufferManager (H.265 reorder)"]
    PBM -->|"pop() -> onVideoData"| CTP
    CTP -->|"push (step mode)"| SBL["StepBufferList"]
```

---

### `CanvasRenderer` (`src/player/video/player/canvas/CanvasRenderer.ts`)

- **Structure.** Two classes in this file: the exported `CanvasRenderer` (`:69-272`) and a private,
  un-exported `Image2DCanvas` (`:24-48`) used only for the MJPEG drawer. `CanvasRenderer` fields:
  `userPaused`, `channelId`, `eventCaptureCallback`, private `canvasElement`, `drawer: Drawer | null`
  (`Drawer = YUVWebGLCanvas | Image2DCanvas`), `mapDrawer` (minimap's own drawer instance),
  `codecType`, `captureFlag`, `captureframeData`, `fileName`, `size: Size | null`, `minimapInfo`.
  Constructor takes an injectable `saveAsFn` defaulting to `file-saver`'s real `saveAs` (`:87`).
  `Image2DCanvas` wraps a `CanvasRenderingContext2D`; `drawCanvas(image)` resizes the canvas to the
  image's dimensions and calls `ctx.drawImage`; `initCanvas()` clears the canvas rect.
  Note (preserved from legacy, documented in the source comment at `:55-67`): `channelId`/
  `userPaused` are plain data properties, not accessors, despite legacy declaring them via
  `Object.defineProperty` — the outer legacy factory function discarded its own `this` by
  `return`-ing a different object, so those accessor definitions never actually attached.

- **Method Analysis.**
  - `setCanvas(codec, videoInfo)` (`:150-174`) — lazily (once; guarded by `drawer === null`)
    constructs `this.size = new Size(videoInfo.width, videoInfo.height)` and, per `codec`,
    instantiates `YUVWebGLCanvas` (via `canvasElement.getContext('webgl')`) for `H264`/`H265`, or
    `Image2DCanvas` (via `getContext('2d')`) for `MJPEG`.
  - `draw(frameData, videoInfo, callback)` (`:185-201`) — the public per-frame entry point. For
    MJPEG: builds an `HTMLImageElement`, sets `image.src` to an object URL over
    `new Blob([frameData.buffer])`, and on `image.onload` calls `drawCanvas(image)`, revokes the
    object URL, and invokes `callback`. For coded video: calls `drawCanvas(frameData)` directly
    (already-decoded YUV buffer, no image decode needed) and stashes `frameData` as
    `captureframeData` for a possible paused-state capture.
  - `drawCanvas(data)` (`:113-135`, private) — duck-types `drawer.drawCanvas(data)` across both
    possible drawer types (a `Uint8Array` for `YUVWebGLCanvas`, an `HTMLImageElement` for
    `Image2DCanvas` — they're unrelated classes, not siblings under a shared interface; the cast
    just gives TypeScript one call signature). Marks `canvasElement.updatedCanvas = true`,
    triggers `download()` if a capture was requested, and mirrors the draw into `mapDrawer` for
    the minimap if one is active and flagged for update.
  - `capture(name)` (`:176-183`) — sets `captureFlag`/`fileName`; if the renderer is currently
    paused and a last frame is cached, draws it immediately (so "capture while paused" doesn't
    need a new frame to arrive).
  - `download()` (`:89-111`, private) — `canvas.toBlob()` then either `saveAsFn(blob, fileName +
    '.png')` (direct file save) or, if no filename was given, invokes `eventCaptureCallback` with
    `{channelId, blob}` (in-memory capture, e.g. for programmatic snapshotting) — throwing
    `RTSPOverWebSocketError(0x0909)` if neither is available.
  - `digitalZoom(bufferData)` (`:214-218`) — calls `drawer.updateVertexArray(bufferData)` via an
    unsafe cast. **Confirmed dead/broken**: `updateVertexArray` is commented out on both
    `WebGLCanvas`'s and `YUVWebGLCanvas`'s prototypes in legacy, and `Image2DCanvas` never defined
    it either — every call throws `TypeError: drawer.updateVertexArray is not a function`. Kept
    as-is per this repo's fidelity-to-legacy convention rather than silently "fixed."
  - `updateMinimapInfo({mode, target})` (`:234-263`) — lazily creates `mapDrawer` (same
    `YUVWebGLCanvas`/`Image2DCanvas` choice as the main drawer) sized off `target`'s `width`/
    `height` attributes on first `'on'`/target-bearing call; `'draw'` flags `minimapInfo.isUpdate`
    for the next `drawCanvas`; `'off'` tears the minimap drawer down.
  - `destroy()` (`:220-232`) — `initCanvas()` + `destroy()` on both `drawer` and `mapDrawer`, then
    nulls everything.

- **Call Stack.** See `CanvasTagPlayer`'s diagram above — `CanvasRenderer.draw`/`drawCanvas` is the
  midpoint between the decoder worker (or the MJPEG `Image` decode) and the WebGL/2D drawer.

- **RFC / Standard References.** No standard of its own; delegates to WebGL (via `YUVWebGLCanvas`)
  or the Canvas 2D API (via `Image2DCanvas`, itself just wrapping browser-native JPEG decoding
  through `<img>`/`Blob` — no explicit JPEG spec handling in this code).

- **Relations & Data Flow.** Created exactly once per `CanvasTagPlayer.init()` call
  (`CanvasTagPlayer.ts:312`); owns the `drawer`/`mapDrawer` `YUVWebGLCanvas`/`Image2DCanvas`
  instances it lazily constructs in `setCanvas`/`updateMinimapInfo`.

---

### `StepBufferList` (`src/player/video/player/canvas/StepBufferList.ts`)

- **Structure.** Standalone class (`:33-132`), **not** a subclass of any `BufferList` type despite
  the legacy source grafting these methods onto one via `inheritObject` — the source comment
  (`:18-32`) explains `push`'s signature and internal array-based storage are incompatible with
  `BufferList`'s linked-list `push(buffer)`, and no `BufferList` method is ever called on a real
  instance, so this port makes it a genuinely standalone class instead of a fake subclass. Fields:
  `bufferingLength` (auto-tuned, default/max `240`, min `6` — `DEFAULT_BUFFERING_LENGTH`/
  `MAX_BUFFERING_LENGTH`/`MIN_BUFFERING_LENGTH`), `listLength`, `curIndex`, and the backing
  `stepList: StepBufferNode[]` array. `StepBufferNode = {playMode, streamData, videoInfo}`.

- **Method Analysis.** Pure internal ring/array buffer — no external standard. `push(playMode,
  streamData, videoInfo)` (`:45-63`) — on the *second* pushed item, auto-tunes
  `bufferingLength = videoInfo.framerate * 4` via `setBufferingLength` (clamped to
  `[MIN_BUFFERING_LENGTH, MAX_BUFFERING_LENGTH]`); appends a node (deep-copying `frameData` into a
  fresh `Uint8Array` so later mutation of the source buffer can't corrupt buffered history) while
  under `bufferingLength`; returns whether the caller may keep pushing (`false` once full) — note
  the code comment at `:57-61` explaining why the return expression is written as
  `length >= bufferingLength ? false : true` rather than the seemingly-equivalent `<` form: they
  diverge under `NaN`, and the `>=`-based form is what legacy actually used. **Real bug fix, found
  live (2026-09-02)**: the `NaN` case this comment already flagged as theoretically possible
  ("a possible `bufferingLength` if `videoInfo.framerate` was missing") turned out to be real —
  `RtspClient.ts`'s SDP parser only sets `session.Framerate` `if` an `a=framerate:` attribute is
  present (`:643-646`, an optional SDP line some cameras simply don't send), leaving
  `videoInfo.framerate` `undefined` for such a stream. `setBufferingLength(undefined * 4)` =
  `setBufferingLength(NaN)`, and neither of its own clamp comparisons (`> MAX`/`< MIN`) ever matches
  `NaN`, so `bufferingLength` stayed `NaN` permanently — meaning `push()`'s own `length >=
  bufferingLength` check could never be `true`, so `push()` could never return `false` ("buffer
  full"), so a `forward()`/`backward()` step could never reach `stepStatus = 'complete'` and
  `#forward`/`#backward` stayed disabled forever, with no crash and no RTSP-level error at all —
  reported live as exactly that ("영원히 활성화 안된다", "never re-enables"). Fixed by validating
  `length` is finite in `setBufferingLength()` before using it, falling back to
  `DEFAULT_BUFFERING_LENGTH` otherwise (which then clamps normally, same as if a "reasonable"
  framerate had been supplied). `forward()`/`backward()` (`:65-85`) — step
  `curIndex` and return the node at the new position; `backward()` additionally *skips* forward
  through non-keyframes, only returning on an I-frame or MJPEG node (frame-accurate step-back needs
  a decodable start point); both call `clear()` (reset to empty) when they run off either end.
  `searchTimestamp(frameTimestamp)` (`:87-101`) — linear scan for an exact
  `timestamp`/`timestamp_usec` match, or the first node whose timestamp exceeds the target,
  positioning `curIndex` there. `findIFrame(cmd)` (`:103-118`) — walks `curIndex` forward/backward
  from its current position until it lands on a `frameType === 'I'` node. `bufferClear()` (`:129-131`)
  — public wrapper over the private `clear()`.

- **Call Stack.** Driven entirely by `CanvasTagPlayer`'s step-play controls: `bufferingVideoData`
  pushes, `controlStepPlay` calls `searchTimestamp` then `findIFrame`, `forward`/`backward` call
  the matching `StepBufferList` method and feed the result back into `onVideoData` (see
  `CanvasTagPlayer.stepPlay`, `:258-270`).

- **RFC / Standard References.** None — pure internal buffering/indexing logic, no external
  standard basis.

- **Relations & Data Flow.** Created once per `CanvasTagPlayer.init()` (`:316`); the only consumer
  anywhere in the codebase is `CanvasTagPlayer` (confirmed via grep). Matches the README's
  `CanvasTagPlayer --> StepBufferList : creates`.

---

## `webgl/` — WebGL rendering primitives

### `Shader` (`src/player/video/player/canvas/webgl/GLPrimitives.ts`)

- **Structure.** `GLPrimitives.ts` also exports the `ShaderScript` interface and two free
  functions used across the WebGL classes: `createShaderScript(type, source): ShaderScript`
  (`:15-17`, a trivial object literal constructor) and `glAssert`/`glError` (`:20-29`, a
  log-only "assert" — never throws, just `console.error` + `console.trace`, matching legacy's
  `window.assert`/`window.error`). `Shader` itself (`:31-57`) holds `gl: WebGLRenderingContext`
  and `shader: WebGLShader | null`.
- **Method Analysis.** Constructor (`:35-52`) — dispatches on `script.type`
  (`'x-shader/x-fragment'` → `gl.createShader(gl.FRAGMENT_SHADER)`, `'x-shader/x-vertex'` →
  `gl.createShader(gl.VERTEX_SHADER)`, anything else → `glError` and early return), then
  `gl.shaderSource` + `gl.compileShader`, checking `gl.COMPILE_STATUS` and routing failures through
  `glError` with `gl.getShaderInfoLog`. `destroy()` (`:54-56`) calls `gl.deleteShader`.
  `Script.createFromElementId` and `ImageTexture` from the legacy source were dropped entirely —
  grep across the legacy tree confirmed neither is ever called (source comment `:3-9`).

### `Program` (`src/player/video/player/canvas/webgl/GLPrimitives.ts`)

- **Structure.** `:59-93`. Holds `gl` and `program: WebGLProgram | null` (created in the
  constructor via `gl.createProgram()`, `:63-66`).
- **Method Analysis.** `attach(shader)` (`:68-70`) — `gl.attachShader`. `link()` (`:72-75`) —
  `gl.linkProgram` then `glAssert(gl.getProgramParameter(..., LINK_STATUS), ...)`. `use()`
  (`:77-79`) — `gl.useProgram`. `getAttributeLocation(name)` (`:81-83`) — thin wrapper over
  `gl.getAttribLocation`, used by both `WebGLCanvas` and `YUVWebGLCanvas` to resolve
  `aVertexPosition`/`aTextureCoord`. `setMatrixUniform(name, array)` (`:85-88`) — resolves the
  uniform location and calls `gl.uniformMatrix4fv`; the only uniform ever set this way is
  `uMVMatrix` (always the identity matrix in practice — see `WebGLCanvas`'s `mvMatrix` note below).
  `destroy()` (`:90-92`) — `gl.deleteProgram`.

### `Texture` (`src/player/video/player/canvas/webgl/GLPrimitives.ts`)

- **Structure.** `:100-147`. Holds `gl`, `size: Size`, `texture: WebGLTexture | null`, `format:
  number` (defaults to `gl.LUMINANCE` — the format `YUVWebGLCanvas` relies on for its 8-bit
  single-channel Y/U/V planes). A module-level `textureIDs` array (`:98`, lazily filled with
  `[TEXTURE0, TEXTURE1, TEXTURE2]`) is shared across every `Texture` instance — harmless since
  those enum values are identical on any `WebGLRenderingContext`.
- **Method Analysis.** Constructor (`:106-117`) — `gl.createTexture()`, binds it, calls
  `gl.texImage2D(..., size.w, size.h, ..., format, UNSIGNED_BYTE, null)` to allocate storage with
  no initial data, and sets `NEAREST` mag/min filtering with `CLAMP_TO_EDGE` wrapping (no mipmaps,
  no filtering artifacts at plane edges — appropriate for exact per-pixel YUV sampling).
  `fill(textureData, useTexSubImage2D?)` (`:119-132`) — the actual per-frame upload: asserts the
  supplied buffer is at least `w*h` bytes, then either `gl.texSubImage2D` (in-place update, used
  when `useTexSubImage2D` is explicitly requested — not the default anywhere in this codebase) or
  `gl.texImage2D` (full re-specification; the code comment notes this benchmarked faster and is
  kept as the default). `bind(n, program, name)` (`:134-142`) — `gl.activeTexture(textureIDs[n])`,
  binds the texture, and sets the named sampler uniform on `program` to unit `n` via
  `gl.uniform1i`. `destroy()` (`:144-146`) — `gl.deleteTexture`.

- **Call Stack (Shader/Program/Texture, combined).** Compiled/linked once at `WebGLCanvas`/
  `YUVWebGLCanvas` construction time (`onInitShaders`/`onInitTextures`); `Texture.fill` +
  `WebGLCanvas.drawScene` run on every decoded frame. See the "Rendering pipeline" call stack under
  `YUVWebGLCanvas` below.

- **RFC / Standard References.** WebGL (Khronos/W3C WebGL 1.0 specification, built on OpenGL ES
  2.0 shader semantics — GLSL ES 1.00 for the shader sources compiled here).

- **Relations & Data Flow.** Both `WebGLCanvas` and `YUVWebGLCanvas` depend directly on all three
  (`WebGLCanvas --> Shader/Program/Texture : creates`); `YUVWebGLCanvas` additionally holds three
  private `Texture` instances (`YTexture`/`UTexture`/`VTexture`) instead of `WebGLCanvas`'s single
  `texture`.

---

### `WebGLCanvas` (`src/player/video/player/canvas/webgl/WebGLCanvas.ts`)

- **Structure.** `:54-267`. Fields: `canvas`, `size: Size`, `gl`, plus protected rendering state:
  `glNames` (reverse-lookup table of every numeric `WebGLRenderingContext` constant, built once for
  error-code-to-name translation), `vertexShader`/`fragmentShader: Shader`, `program: Program`,
  `texture: Texture`, `vertexPositionAttribute`/`textureCoordAttribute` (attribute locations),
  `quadVPBuffer`/`quadVTCBuffer` (vertex-position / texture-coordinate `WebGLBuffer`s for a
  full-viewport quad), optional `framebuffer`/`framebufferTexture`/`renderbuffer` (only allocated
  if `useFrameBuffer` is passed — no call site in this codebase passes `true`), and a private
  `mvMatrix: Float32Array` always set to a compile-time-constant 4×4 identity matrix
  (`IDENTITY_MATRIX_4X4`, `:40`) — the code comment notes legacy's real Sylvester-matrix math
  (`mvMultiply`/`mvTranslate`/`zoomScene`) is dead/commented-out in the source itself, so only the
  identity case is ever reachable. Ships its own generic pass-through vertex/fragment shader pair
  (`VERTEX_SHADER_SCRIPT`/`FRAGMENT_SHADER_SCRIPT`, `:9-33`) that just samples a single `texture`
  uniform unmodified — this is what a *non*-YUV `WebGLCanvas` would render, though in this codebase
  only `YUVWebGLCanvas` (which overrides the shaders entirely) is ever actually constructed
  (`CanvasRenderer.setCanvas` only ever builds `YUVWebGLCanvas`, never a bare `WebGLCanvas`).
  `onInitWebGL`/`onInitShaders`/`onInitTextures`/`onInitSceneTextures` are real (non-arrow) instance
  methods specifically so the constructor's calls into them dispatch to a subclass override even
  mid-construction (`:44-53`) — this is exactly how `YUVWebGLCanvas` replaces the shader/texture
  setup without needing its own constructor logic beyond calling `super()`.
  Inheritance: `WebGLCanvas <|-- YUVWebGLCanvas`.

- **Method Analysis (rendering pipeline).**
  - **Constructor** (`:73-88`) — sets `canvas.width`/`height` from `size.viewWidth`/`viewHeight`
    (falling back to `size.w`/`size.h`), then runs the fixed setup sequence:
    `onInitWebGL()` → `onInitShaders()` → `initBuffers()` → (optionally `initFramebuffer()`) →
    `onInitTextures()` → `initScene()`.
  - `onInitWebGL()` (`:181-195`) — warns via `glError` if `gl` is falsy; builds `glNames` (numeric
    GL constant → name) once, by iterating every enumerable property of `gl` and keeping the
    numeric ones — used later by `checkLastError` to print human-readable WebGL error names.
  - `onInitShaders()` (`:197-210`) — compiles the base pass-through vertex+fragment `Shader`s,
    creates a `Program`, `attach`es both, `link()`s and `use()`s it, then resolves and
    `enableVertexAttribArray`s `aVertexPosition`/`aTextureCoord`. **`YUVWebGLCanvas` fully
    overrides this** with its own three-texture YUV→RGB shader pair (see below).
  - `initBuffers()` (`:107-125`, private) — allocates `quadVPBuffer` with 4 vertex positions
    forming a full-viewport `TRIANGLE_STRIP` quad (`[1,1,0, -1,1,0, 1,-1,0, -1,-1,0]`) and
    `quadVTCBuffer` with matching texture coordinates; includes an Edge-browser-specific
    `scaleX` correction (via `browserDetect()`) to avoid a gray edge line when canvas width isn't
    exactly divisible by the source width.
  - `onInitTextures()` (`:212-216`) — sets the GL viewport to the canvas's actual pixel size and
    allocates a single RGBA `Texture` sized to `this.size`. **Overridden entirely by
    `YUVWebGLCanvas`** (three `LUMINANCE` textures instead — see below).
  - `initScene()` (`:135-148`, private) — binds `quadVPBuffer`/`quadVTCBuffer` to the vertex
    position/texture-coordinate attributes via `gl.vertexAttribPointer`, calls
    `onInitSceneTextures()` (binds the texture(s) to their sampler uniform(s) — subclass-overridable),
    uploads the (always-identity) MV matrix uniform, and binds the optional framebuffer if one was
    requested.
  - `drawScene()` (`:222-224`) — the actual draw call: `gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)`,
    rasterizing the quad with whatever texture(s) are currently bound — this is what actually
    paints the previously-`fill()`ed texture data onto the canvas each frame.
  - `checkLastError(operation?)` (`:154-179`) — polls `gl.getError()`, translates it through
    `glNames`, and logs; throws a `ReferenceError` for genuinely unknown error codes (preserved
    legacy quirk referencing an undeclared global — effectively unreachable with a real
    `WebGLRenderingContext`, kept for fidelity per the source comment `:163-170`).
  - `readPixels(buffer)` (`:226-229`) — `gl.readPixels` into a caller-supplied buffer (RGBA); not
    called anywhere in this module's own code (available for external tooling/testing).
  - `destroy()` (`:231-266`) — deletes the framebuffer/renderbuffer/buffers, destroys both shaders,
    the (optional) framebuffer texture, the texture, and the program; shrinks the underlying
    `gl.canvas` to `1×1` (releases GPU memory eagerly) before nulling every field.

- **Call Stack.** See `YUVWebGLCanvas`'s combined pipeline diagram below — `WebGLCanvas` supplies
  the shared quad/attribute/uniform machinery that every draw call runs through, but `YUVWebGLCanvas`
  is the class actually instantiated for real video and the one whose overrides matter for the
  per-frame path.

- **RFC / Standard References.** WebGL 1.0 (Khronos/W3C specification; GLSL ES 1.00 shading
  language).

- **Relations & Data Flow.** Base class for `YUVWebGLCanvas`; not directly instantiated by
  anything in this codebase (`CanvasRenderer.setCanvas` only ever builds the subclass). Depends on
  `Shader`/`Program`/`Texture` from `GLPrimitives.ts` and `Size`/`browserDetect` from `util/`.

---

### `YUVWebGLCanvas` (`src/player/video/player/canvas/webgl/YUVWebGLCanvas.ts`)

- **Structure.** `:45-132`. Extends `WebGLCanvas`. Adds three protected `Texture` fields —
  `YTexture`, `UTexture`, `VTexture` — deliberately declared **without** a `= null` initializer
  (using the `!` definite-assignment marker) because subclass field initializers run *after*
  `super()` returns, which would otherwise stomp the values `onInitTextures()` (invoked *during*
  `super()`'s constructor execution, dispatching to this class's override) already assigned
  (source comment `:46-50`). Ships its own shader pair (`:5-38`): the vertex shader is identical to
  `WebGLCanvas`'s; the fragment shader is the real YUV→RGB specialization — see below. This is the
  only concrete `WebGLCanvas` subclass, and the only WebGL drawer `CanvasRenderer` ever constructs
  (for `H264`/`H265`). Inheritance: `WebGLCanvas <|-- YUVWebGLCanvas`.

- **Method Analysis — the actual rendering pipeline.**
  - **YUV→RGB conversion approach**: entirely in the fragment shader (`:19-38`), via a hardcoded
    `mat4 YUV2RGB` (BT.601-style coefficients: `1.16438, 0, 1.59603, -.87079` / `1.16438, -.39176,
    -.81297, .52959` / `1.16438, 2.01723, 0, -1.08139` / `0,0,0,1`) multiplying the vector
    `(Y, U, V, 1)` sampled independently from three separate `sampler2D` uniforms (`YTexture`,
    `UTexture`, `VTexture`) — i.e. **no** CPU-side color conversion; every pixel's YUV→RGB math
    runs on the GPU, once per fragment, in parallel.
  - `onInitShaders()` (override, `:59-72`) — same structure as the base class's but compiles
    *this* file's three-texture shader pair instead of the base pass-through one.
  - `onInitTextures()` (override, `:74-85`) — allocates `YTexture` at full `this.size` (luma
    plane, one byte per pixel) and `UTexture`/`VTexture` at `this.size.getHalfSize()` (chroma
    planes at half width and half height each) — the standard **4:2:0 planar** subsampling layout.
    All three default to `Texture`'s `LUMINANCE` format (single 8-bit channel).
  - `onInitSceneTextures()` (override, `:87-91`) — binds `YTexture`/`UTexture`/`VTexture` to
    texture units 0/1/2 under the sampler uniform names `YTexture`/`UTexture`/`VTexture`
    respectively (matching the fragment shader's uniform names).
  - `drawCanvas(bufferData)` (`:99-106`) — **the per-frame entry point**, called by
    `CanvasRenderer.drawCanvas()`. Computes `lumaSize = w*h` and `chromaSize = lumaSize >> 2`
    (quarter size — consistent with 4:2:0's half-width×half-height chroma planes), then slices
    the single incoming `Uint8Array` into three contiguous regions — `[0, lumaSize)` for Y,
    `[lumaSize, lumaSize+chromaSize)` for U, `[lumaSize+chromaSize, lumaSize+2*chromaSize)` for V
    — uploading each via `Texture.fill` (`gl.texImage2D`), then calls `drawScene()` to issue the
    actual `gl.drawArrays` draw call. This confirms the decoder worker hands back one flat planar
    I420/YUV420P buffer (Y plane followed by U then V), not three separate arrays.
  - `fillYUVTextures(y, u, v)` (`:93-97`) — a three-separate-array variant of the same upload.
    **Confirmed dead code** (grep across the whole `src/player` tree finds no call site anywhere)
    — `drawCanvas`'s single-buffer-slicing form is what's actually used; this method is a legacy
    leftover kept for API-surface fidelity.
  - `initCanvas()` (`:112-115`) — `gl.clear(DEPTH_BUFFER_BIT | COLOR_BUFFER_BIT)`, used to blank
    the canvas (e.g. on step-play list exhaustion, or before `destroy()`).
  - `destroy()` (override, `:117-131`) — destroys all three YUV textures before delegating to
    `super.destroy()` for the shared buffer/program/shader teardown.

- **Call Stack.**

```mermaid
sequenceDiagram
    participant DW as decoderWorker
    participant CTP as CanvasTagPlayer
    participant CR as CanvasRenderer
    participant YUV as YUVWebGLCanvas
    participant TEX as Texture (x3)
    participant GL as WebGLRenderingContext

    DW->>CTP: postMessage({type:'decoded', data:{frame: Uint8Array YUV420, width, height}})
    CTP->>CTP: decoderWorkerMessage('decoded')
    CTP->>CR: renderer.draw(frame, {})
    CR->>CR: drawCanvas(frame)
    CR->>YUV: drawer.drawCanvas(frame)
    YUV->>YUV: slice frame into Y/U/V subarrays
    YUV->>TEX: YTexture.fill(Y) / UTexture.fill(U) / VTexture.fill(V)
    TEX->>GL: gl.texImage2D(...) per plane
    YUV->>YUV: drawScene()
    YUV->>GL: gl.drawArrays(TRIANGLE_STRIP, 0, 4)
    GL-->>GL: fragment shader samples Y/U/V, applies YUV2RGB matrix, rasterizes quad
    Note over GL: visible pixels on the &lt;canvas&gt; element
```

- **RFC / Standard References.** WebGL 1.0 / GLSL ES 1.00 (Khronos/W3C). The YUV→RGB matrix
  implements the standard BT.601 (ITU-R BT.601) full-range-ish conversion coefficients commonly
  used for SD/consumer video — no formal citation in-source, but the coefficient pattern matches
  the well-known BT.601 Y'CbCr→RGB conversion.

- **Relations & Data Flow.** Created exclusively by `CanvasRenderer.setCanvas()` for `H264`/`H265`
  codec types (`CanvasRenderer.ts:157-161`), and again for the minimap drawer in
  `updateMinimapInfo` (`CanvasRenderer.ts:249`). Never constructed anywhere else. Matches the
  README's `CanvasRenderer --> YUVWebGLCanvas : creates` and `WebGLCanvas <|-- YUVWebGLCanvas`.

```mermaid
flowchart TD
    StreamPlayer -->|"createCanvasPlayer()"| CanvasTagPlayer
    MediaRouter -->|"VideoPlayerLike.onVideoData / sendToBufferManager"| CanvasTagPlayer
    CanvasTagPlayer -->|"init()"| CanvasRenderer
    CanvasTagPlayer -->|"sendToBufferManager()"| PlaybackBufferManager["PlaybackBufferManager (mediaSession)"]
    CanvasRenderer -->|"setCanvas('H264'/'H265', videoInfo)"| YUVWebGLCanvas
    YUVWebGLCanvas -->|"creates"| GLPrimitives["Shader / Program / Texture"]
```

---

### `VideoTagPlayer` (`src/player/video/player/video/VideoTagPlayer.ts`)

- **Structure.** `:127-2219`. The largest, most stateful class in this subsystem — a `<video>`
  element driven entirely by Media Source Extensions, fed fragmented-MP4 (fMP4) segments built on
  the fly from RTP-depacketized H264/H265 video and AAC/OPUS/G711/G726 audio, with A/V sync driven
  by `VTTCue` text-track entries carrying JSON timestamps. Extends `VideoPlayer`; kept as one
  cohesive class (matching legacy's single closure) rather than split up, since nearly every method
  reads/writes the same ~50 shared fields. Key field groups:
  - **MSE plumbing**: `videoElement`, `mediaSource: MediaSource | null`, `sourceBuffer: SourceBuffer
    | null`, `sourceBufferAudioIsOpus` (tracks what codec string the `SourceBuffer` was actually
    created with, since MSE forbids changing it later).
  - **fMP4 muxing state**: `segmentArray: Uint8Array[]` (pending, not-yet-appended segments),
    `sequenseNum`, `videoSamples`/`audioSamples` (pending per-track sample queues), `baseVideoTime`/
    `baseAudioTime`/`baseNTPTimestamp` (decode-time bases), `boxStartTime`, `lastBoxSize`,
    `audioInfo: Mp4AudioTrackInfo`, `videoInfoBox: Mp4VideoTrackInfo | null`, `dummyAudio`,
    `realAacActive`/`opusActive` (which real audio codec is currently muxed), `opusActiveIsHintOnly`
    (true when `opusActive` was pre-seeded from `audioCodecHint` — inherited from `VideoPlayer`,
    set by `MediaRouter` from SDP — rather than confirmed by a real `onAudioData` call yet; see
    `init()`/`setAudioInfo()` below).
  - **Timing/statistics**: `bufferedFrameCount`, `defaultDelay`/`delay` (browser-tiered — Chrome/
    Windows, Safari/Mac ≥10.13, and a generic-other bucket each get different
    `*_DEFAULT_FRAME_BUFFER_COUNT`/`*_DEFAULT_DELAY_TIME` constants, chosen in the constructor via
    `getBrowserInfo()`), `statisticsTimer: IntervalTimer | null`, `decodedMean`/`videoMean`/
    `dropMean: Mean`, `videoTimestampIntervalQueue: CircularTypedArrayQueue<number>`.
  - **Workers**: `audiotranscoderWorker: Worker | null` — spawned unconditionally in the
    constructor (`:298-299`) via an injectable `AudiotranscoderWorkerFactory`, used to transcode
    G711/G726 audio to AAC in-browser (Opus and real AAC need no transcode).
  - No `CanvasRenderer`/WebGL/GL-primitive fields anywhere — confirmed by reading the whole file;
    its only rendering surface is the native `<video>` element itself.
  Inheritance: `VideoPlayer <|-- VideoTagPlayer`.

- **Method Analysis — fMP4 muxing / MSE pipeline.**
  - **Constructor** (`:266-300`) — calls `super()`, sets `this.rfps = 30`/`this.boxsize = 1`,
    inspects `getBrowserInfo()` to select buffering constants (throwing `RTSPOverWebSocketError
    0x090D` for unsupported old-Safari/OSX-10.7 combinations), and eagerly spawns the audio
    transcoder worker with its `onmessage → audiotranscoderWorkerMessage`.
  - `init(element)` (`:1860-1905`) — registers a `beforeunload` handler that flushes the
    `MediaSource` via `endOfStream()` before calling `close()`; sets `background_img` (loading
    spinner asset, jQuery-detection-adjusted); seeds `opusActive` (and `opusActiveIsHintOnly`) from
    `this.audioCodecHint` — set by `MediaRouter` from SDP, before either the first video I-frame or
    the first audio packet arrives, see `setAudioInfo()`'s doc entry below for why; calls
    `elementSetting()` (wires the full `<video>` event-listener set —
    `playing`/`pause`/`canplay`/`waiting`/`seeking`/`seeked`/`timeupdate`/etc., `:302-311`) and
    `createMediaSource()` (constructs a `new MediaSource()`, assigns it to `videoElement.src` via
    `URL.createObjectURL`, and listens for `sourceopen`).
  - `mediaSourceEventListener('sourceopen')` (`:327-340`) → `setSourceBuffer()` (`:1376-1398`) —
    on first call, builds the MIME/codecs string
    `video/mp4;codecs="${videoCodecInfo}, ${opusActive ? 'opus' : 'mp4a.40.2'}"`, checks
    `MediaSource.isTypeSupported`, and calls `mediaSource.addSourceBuffer(mimeCodec)` — this is
    the point the browser is told exactly which H264/H265 profile+level and which audio codec to
    expect for the entire session (audio codec can only be declared once, see `sourceBufferAudioIsOpus`).
  - `onVideoData(playMode, streamData, videoInfo)` (`:1706-1731`, overrides `VideoPlayer`) — the
    per-video-frame entry point. On the first `I`-frame of a session, captures `videoCodecInfo`,
    calls `setVideoInfo()` (builds the `Mp4VideoTrackInfo` box descriptor — width/height with a
    crop-correction heuristic for non-16-aligned resolutions, `:2132-2175`, plus SPS/PPS or
    VPS/PTL for H264/H265 respectively), `initBaseNTPTimestamp()`, and `createInitSegment()`
    (calls the vendored `initSegment([videoInfoBox, audioInfo])` to build the fMP4 `ftyp+moov`
    initialization segment, then immediately tries to append it). Every call then runs
    `createVideoSample()`.
  - `createVideoSample(streamData, videoInfo)` (`:1083-1120`) — builds a `VideoSample`
    (NAL-length-prefixed via `createSampleFrameData`/`setNalLength`, which rewrites Annex-B
    start-codes into 4-byte big-endian length prefixes — the AVCC/HVCC format fMP4 requires
    instead of raw Annex-B). Live mode: computes `frameDuration` via `getVideoFrameDuration()`
    (RTP-timestamp-delta-based, with `Median`-based jitter smoothing — see below), feeds a
    dummy-audio generator if no real audio track is active yet (`makeDummyAudio` — MSE requires an
    audio track sample cadence even with no real audio, to avoid buffering stalls), and once
    `boxsize` samples have accumulated, calls `createVideoSegment(boxsize)`. Playback mode: pushes
    unconditionally and, on each I-frame boundary once there's more than one buffered sample,
    calls `createSegment()` (a combined video+audio segment).
  - `createVideoSegment`/`createAudioSegment`/`createSegment` (`:1225-1344`) — splice the pending
    sample queue(s), build an `Mp4BoxInfo` (`id`, `samples`, `baseMediaDecodeTime`, `type`), flatten
    the samples' frame data via `createFrameDataBuffer` (single-`memcpy`-equivalent concatenation
    when >1 sample), update the `VTTCue` timestamp text track (`updateVideoTimestamp`/
    `updateAudioTimestamp`) for A/V-sync consumers, then call the vendored `mediaSegment(seqNum,
    [boxInfo], frameDataBuffer)` (single-track) or `dualTrackMediaSegment(seqNum, [videoBoxInfo,
    audioBoxInfo], [videoBuf, audioBuf])` (`createSegment`, both tracks in one `moof+mdat` — used
    in Playback mode to keep video/audio segments atomically paired) to build the actual `moof`+
    `mdat` fragment, pushing the result onto `segmentArray` and calling
    `appendSegmentToSourceBuffer()`.
  - `appendSegmentToSourceBuffer()` (`:1346-1374`) — the MSE append itself: no-ops if the
    `SourceBuffer` doesn't exist or is mid-update (`sourceBuffer.updating`); on empty queue, calls
    `mediaSource.endOfStream()` if the stream is flagged to end; otherwise shifts one segment off
    the queue and calls `sourceBuffer.appendBuffer(segment)`, wrapping append failures into
    `RTSPOverWebSocketError(0x030A)`.
  - `sourceBufferEventListener('updateend')` (`:350-359`) — drains any pending `clearBufferFlag`
    (removes everything from `0` to the buffered end via `sourceBuffer.remove()`) then calls
    `appendSegmentToSourceBuffer()` again — this is what actually keeps the segment queue draining,
    since MSE only allows one `appendBuffer` in flight at a time.
  - `videoUpdating()` (`:1497-1590`, triggered from `onDurationChange`) — the live-edge/latency
    controller: reads `sourceBuffer.buffered`'s start/end, computes `latency = endTime -
    currentTime`, and nudges `videoElement.currentTime` forward (skipping ahead) when latency
    exceeds `this.delay`, or backs off `bufferedFrameCount` when latency is comfortably low —
    effectively an adaptive jitter buffer implemented via `<video>` seeking rather than an actual
    audio/video decoder queue. Also calls `checkBufferSize()` (`:1475-1495`) to `sourceBuffer.remove()`
    old buffered ranges once they exceed `getMaxInstantPlayback()`, capping MSE buffer growth.
  - **Framerate/network estimation utils** — `getVideoFrameDuration()` (`:995-1075`) pushes each
    inter-frame RTP-timestamp delta into `videoTimestampIntervalQueue` (a 10-slot
    `CircularTypedArrayQueue<number>`) and uses `Median.mean`/`Median.median`/`Median.variance`/
    `Median.findRangeAndCoefficient` both for a `'timestamp'` statistics event and to detect+smooth
    jittery timestamps (`VIDEO_MAX_VARIANCE_VALUE` threshold triggers substituting the queue's mean
    delta for a wild single-sample outlier). `onNetworkState(variance, mean)` (`:2031-2045`,
    called from the inherited `rfps` setter's own `Median.variance` computation) tunes
    `networkWeight`, which directly scales `this.delay` in `getVideoFrameDuration`'s final delay
    calculation (`:1072`). `recalcRates()`/`getCurrentVideoFrame()` (`:577-653`) record
    decoded-frames/bytes/dropped-frames-per-second into three separate `Mean` instances
    (`decodedMean`/`videoMean`/`dropMean`) every second, driven by a `statisticsTimer =
    new IntervalTimer(() => this.getCurrentVideoFrame(), 1000)` started in `onPlaying()` and
    paused in `onClose()`/`pause()` — `IntervalTimer` (vs. a raw `setInterval`) is what lets this
    survive/resume correctly around tab backgrounding.
  - `capture(fileName)` / `download(videoElem)` (`:1770-1777, 1624-1655`) — snapshotting: draws
    the current `<video>` frame to an offscreen `<canvas>` via `ctx.drawImage(videoElem, ...)`,
    then `canvas.toBlob()` → `saveAs` or `eventCaptureCallback`, mirroring `CanvasRenderer`'s
    capture flow but sourced from the video element instead of a WebGL/2D canvas.
  - `digitalZoom`/`bufferingVideoData`/`controlStepPlay`/`sendToBufferManager` (`:1949-1963`) —
    all four **unconditionally throw** `TypeError('this.player.<method> is not a function')`.
    These exist only so `VideoTagPlayer` structurally satisfies `VideoPlayerLike` for
    `StreamPlayer`'s factory wiring; legacy's real `videoTagPlayer.js` never defines them either,
    and `MediaRouter`'s own call sites already gate every one of them behind `tagMode ===
    'canvas'`/`stepFlag` checks that are provably always false when a `VideoTagPlayer` is active
    — so in the real wired-up system these are unreachable, but the throw preserves the genuine
    legacy crash if something ever did call them.
  - `setAudioInfo(audioinfo)` (`:2262-2347`) — the audio-codec-switch handler: refuses to switch
    (drops the new codec's audio silently) if the `SourceBuffer` was already created for the other
    Opus-vs-non-Opus family (MSE can't change codecs string post-creation); otherwise flushes
    pending segments, rebuilds `this.audioInfo` (real AAC uses actual `sampleRate`/
    `channelCount`/`samplingFrequencyIndex`; Opus uses a native-mux config with no
    `audioobjecttype`; G711/G726 keeps a fixed 8kHz-mono AAC-transcode target), and calls
    `createInitSegment()` again to re-declare the init segment with the new track config.
    **Real-camera bug, fixed**: the very first `SourceBuffer` is created at the first video
    I-frame (`onVideoData()`, not here), using whatever `opusActive` happens to be *at that
    moment* to pick `'opus'` vs. `'mp4a.40.2'` in the MIME string. On a real camera it's a genuine
    race which arrives first — the first video I-frame or the first audio RTP packet — and
    `opusActive` used to default to `false` until an actual `onAudioData` call ran. If the video
    I-frame won the race (confirmed live: reproduced with a real H.264+Opus camera — 1 frame
    renders, then playback freezes forever while RTP keeps arriving, because the `<video>`
    element's `buffered` range is the *intersection* across tracks and the Opus audio track never
    receives a single sample after this point), the `SourceBuffer` would lock in `'mp4a.40.2'`,
    and the moment the real Opus `onAudioData` call arrived, this method's mismatch guard above
    would silently and permanently drop that stream's audio — with the practical effect of
    stalling video too, not just losing sound. Fixed by having `init()` (see above) pre-seed
    `opusActive` from `audioCodecHint`, which `MediaRouter` learns from SDP (`RtpClient.
    sendSdpInfo()`) well before any RTP data flows either direction — so the first `SourceBuffer`
    is now created with the right codecs string regardless of video/audio arrival order. The new
    `opusActiveIsHintOnly` field (cleared inside this method's `switchingCodec` branch) exists
    only so the *first* real Opus `setAudioInfo()` call still runs its population branch even
    though `opusActive` already matches from the hint — without it, the equality would look like
    "no change" and the real `channelCount`/`sampleRate`-derived fields would never get filled in.
    AAC/G711/G726 are unaffected by this fix or the bug: they all share the same `'mp4a.40.2'`
    MIME string regardless of arrival order, so the mismatch guard never triggers for them (and
    the field's real-camera default of `false` already matches `opusActive`'s default). The mismatch
    guard above is kept as a fallback for a missing/wrong SDP hint.
  - `setVideoInfo(videoinfo, codecType)` (`:2315-`) — **the actual root cause of a VP9/AV1
    `onAudioData ... byteLength` crash**, isolated via a temporary diagnostic
    `console.error(err.stack)` at the `MediaRouter.onAudioData` catch site (the two fixes below
    were both real bugs, both fixed first, and *neither* stopped the crash — a live stack trace
    was what actually found it). `videoInfoBox.sps`/`.pps` used to be set unconditionally to
    `[videoinfo.spsPayload]`/`[videoinfo.ppsPayload]` for every codec, before the per-codec
    `if`/`else if` chain even ran — meaningless for VP9/AV1/VP8/MJPEG (only H264/H265 have an
    SPS/PPS concept), so for those, `spsPayload`/`ppsPayload` are always `undefined`, making
    `videoInfoBox.sps` a *non-empty* array containing one `undefined` element:
    `[undefined]`. `mp4Generator.js`'s `videoSample()` does `var a = track.sps || []` — correct
    when `sps` is absent entirely (`undefined || []` → `[]`, loop body never runs) but `[undefined]`
    is still a truthy, non-empty array, so its NAL-length-prefixing loop runs anyway and crashes on
    `a[0].byteLength` — *before* that function ever reaches its own `codecType === "H264"` check
    that would have ignored `sps`/`pps` for AV1 regardless. Fixed by moving the `sps`/`pps`
    assignment into the `H264`/`H265` branches specifically (mirroring how `vps` was already
    H265-only) instead of the shared base object — `Mp4VideoTrackInfo.sps`/`.pps`
    (`mp4Generator.d.ts`) became optional to match. For any other codec the fields are now
    genuinely absent, not present-with-undefined, so `videoSample()`'s existing `|| []` guard
    handles it correctly with no vendored-file change needed.
  - `createInitSegment()` (`:1349-1367`) — a real, separate bug, fixed first but insufficient on
    its own: returns early (no-op) if `this.videoInfoBox` is still `null`. Both `onVideoData()`'s
    first-I-frame block and `setAudioInfo()`'s codec-switch block call this, but only the former
    ever sets `videoInfoBox` first — if audio RTP reaches the player before the first video
    I-frame does, `setAudioInfo()` used to call `initSegment([null, this.audioInfo])`, hitting the
    same kind of `mp4Generator.js` box-concatenation crash from a `null` track instead of a
    malformed one. Deferring costs nothing: once the first video I-frame does arrive,
    `onVideoData()`'s own `createInitSegment()` call runs with the already-current
    `this.audioInfo` anyway.
  - `createAudioSample(streamData, audioinfo, chunkCodec)` — also bails out defensively if
    `streamData.frameData` is falsy, skipping just that one sample rather than letting a
    `.byteLength` throw take down the session. Kept as defense-in-depth alongside the two fixes
    above — a missing/empty frame from a different upstream cause is still plausible, and a single
    bad audio sample still shouldn't be able to kill video playback too.
  - `setSourceBuffer()` (`:1536-`) — returns early unless `mediaSource.readyState === 'open'`,
    guarding the immediately-following `mediaSource.duration = 0` (which the MSE spec requires
    `readyState === 'open'` for). Only ever called from the `'sourceopen'` listener, which should
    already guarantee that — but a stale/late-firing event during session teardown/reconnect
    churn (observed live as a downstream symptom of the crash above, before it was fixed) can
    still reach here after the `MediaSource` has already moved on to `'closed'`/`'ended'`,
    throwing an uncaught `InvalidStateError`.

- **Call Stack.**

```mermaid
sequenceDiagram
    participant MR as MediaRouter
    participant VTP as VideoTagPlayer
    participant M4 as mp4Generator (vendor)
    participant SB as SourceBuffer (MSE)
    participant VE as &lt;video&gt; element (browser-native decode)

    MR->>VTP: onVideoData(playMode, streamData, videoInfo)
    alt first I-frame of session
        VTP->>VTP: setVideoInfo() / initBaseNTPTimestamp()
        VTP->>M4: initSegment([videoInfoBox, audioInfo])
        M4-->>VTP: ftyp+moov Uint8Array
        VTP->>VTP: segmentArray.unshift(...) 
        VTP->>VTP: appendSegmentToSourceBuffer()
    end
    VTP->>VTP: createVideoSample() (NAL length-prefixing, frameDuration calc)
    VTP->>VTP: createVideoSegment()/createSegment() once boxsize samples queued
    VTP->>M4: mediaSegment(seq, [boxInfo], frameData) / dualTrackMediaSegment(...)
    M4-->>VTP: moof+mdat Uint8Array
    VTP->>VTP: segmentArray.push(...)
    VTP->>VTP: appendSegmentToSourceBuffer()
    VTP->>SB: sourceBuffer.appendBuffer(segment)
    SB-->>VTP: 'updateend' event
    VTP->>VTP: appendSegmentToSourceBuffer() (drain next queued segment)
    Note over VE: browser MSE pipeline demuxes/decodes fMP4 internally
    VE-->>VE: visible pixels rendered to the &lt;video&gt; element
    VTP->>VTP: videoUpdating() (on durationchange) adjusts currentTime for live-edge latency
```

- **RFC / Standard References.**
  - **Media Source Extensions** (W3C MSE specification) — `MediaSource`, `SourceBuffer`,
    `appendBuffer`, `buffered`, `updateend`, `endOfStream`, `isTypeSupported` are all MSE APIs used
    directly (`:406-412, 1346-1433`).
  - **ISO Base Media File Format / fragmented MP4** (ISO/IEC 14496-12, ISOBMFF — not an IETF RFC)
    — the segments this class builds via the vendored `mp4Generator` (`initSegment`/`mediaSegment`/
    `dualTrackMediaSegment`) are `ftyp`/`moov` initialization segments and `moof`/`mdat` media
    segments per the ISOBMFF fragmented-MP4 profile (the same box structure used by MPEG-DASH/HLS
    fMP4 delivery).
  - Text-track A/V sync uses **WebVTT** `VTTCue` objects (`makeOnCueChange`/`makeOnCueEnter`/
    `makeOnCueExit`, `:420-494`) purely as a timestamp-delivery side channel (each cue's `text` is
    JSON, not real subtitle text) — not itself a rendering standard, just repurposing the
    `TextTrack`/`VTTCue` W3C APIs as an event-scheduling mechanism synced to `<video>` playback
    position. **`onenter`/`onexit` alone aren't reliable at higher Playback speed** (found live,
    fixed 2026-09-03) — both those events and `TextTrack.activeCues` are driven by the same
    spec-defined "time marches on" algorithm, whose dispatch cadence isn't fine enough to guarantee
    observing a cue whose entire lifetime falls inside one of its own scheduling gaps (confirmed via
    a live A/B trace: reading `activeCues` from a different event made zero measurable difference).
    `checkTimestampCueAtCurrentTime()` now independently searches `track.cues` (the plain, unbatched
    cue list) against the live `videoElement.currentTime`, driven by its own `requestAnimationFrame`
    loop (`startTimestampCuePolling()`/`stopTimestampCuePolling()`) rather than any TextTrack-native
    event — see `MEMORY.md` for the full narrative and the coverage numbers.

- **RFC-free (internal-only) note.** The NAL Annex-B → length-prefixed (AVCC/HVCC) rewrite
  (`createSampleFrameData`/`setNalLength`, `:931-958`) is a real ITU-T H.264/H.265 Annex B bitstream
  convention (start-code `0x00000001` framing → 4-byte big-endian length prefixing, as ISOBMFF's
  `avcC`/`hvcC` sample format requires) rather than an ad hoc format.

- **Relations & Data Flow.** Created by `StreamPlayer`'s `createVideoPlayer` factory
  (`() => new VideoTagPlayer()`), selected by `MediaRouter.selectVideoPlayer()` when `tagMode ===
  'video'` — H264 above `LIMIT_SIZE[playMode]`, H265 whenever `MediaSource.isTypeSupported` accepts
  the negotiated profile, or NVR devices (`MediaRouter.ts:1324-1364`). Unlike `CanvasTagPlayer`, it
  never touches `PlaybackBufferManager` (its own MSE `SourceBuffer` *is* its buffer) and never
  constructs a `CanvasRenderer`/`WebGLCanvas`/`YUVWebGLCanvas` — its only non-`VideoPlayer`
  collaborators are the vendored `mp4Generator` module and the small `util/` helpers
  (`CircularTypedArrayQueue`, `Median`, `Mean`, `IntervalTimer`). **Video and audio together** —
  its `onAudioData` (`:1915`, above) is what `MediaRouter.handleAudioData` checks for to route
  audio here instead of to the standalone `AudioPlayerGxx` decode/playback subsystem
  (`06-listen-audio.md`); real AAC/Opus/G711/G726 audio gets muxed straight into this class's own
  fMP4 `SourceBuffer` alongside video, so that subsystem is never even constructed for a
  `VideoTagPlayer` session.

- **B-frame reordering: composition-time-offset (CTS).** Unlike `CanvasTagPlayer` (whose WASM
  decoder reorders B-frames internally as ordinary decoder behavior, via `PlaybackBufferManager`'s
  jitter buffer downstream of that), `VideoTagPlayer` hands *encoded* NAL units to the browser via
  MSE — RTP packets for a B-frame source arrive in decode order, and each one's own `rtpTimestamp`
  is still its true presentation time (RFC 3550), so the arrival-order timestamp sequence is
  inherently non-monotonic whenever a B-frame is in flight. Originally undiagnosed as exactly
  that: confirmed live via `chrome://media-internals` against this repo's own YouTube-to-RTSP
  H.265 transcoding demo (x265 uses B-frames by default even at `-preset veryfast`) — every
  session logged `Decoded frame ... is out of order` / `Dropping frame ... which is earlier than
  the last rendered frame` continuously for the whole playback, Chrome's own MSE pipeline silently
  discarding most frames (an apparent ~24fps input throttled to ~7fps displayed, with hardware
  decode confirmed active the whole time — not a decode-throughput problem). Real Hanwha camera
  encoders don't use B-frames for low-latency streaming, so `video`-tag mode against a real camera
  was never affected.

  Fixed with real ISOBMFF composition-time-offsets rather than a source-side workaround:
  `getVideoCompositionTimeOffset(streamData)` (private, live-mode only) computes, per sample,
  `presentationTime - decodeTime` where `presentationTime` is this sample's own `rtpTimestamp`
  relative to the stream's first sample (`presentationBaseRtpTimestamp`, reset in
  `initBaseNTPTimestamp()`) and `decodeTime` is `baseVideoTime` plus the summed `frameDuration` of
  any samples already buffered in `this.videoSamples` but not yet flushed — i.e. this sample's own
  position on the *existing* (unmodified) decode-time clock `getVideoFrameDuration()`/
  `baseVideoTime` already maintain. Both are scaled identically (`* TEN`), so for a non-reordered
  stream the two clocks track each other almost exactly and this evaluates to ~0 — no observable
  behavior change for the camera path this was always correct for. `createVideoSample()` stores the
  result on `VideoSample.compositionTimeOffset`, which `mp4Generator.js`'s `videoTrun()` now
  detects (`samples[0].compositionTimeOffset !== undefined`) and writes as a real, signed
  (trun version 1) `sample_composition_time_offset` per ISO/IEC 14496-12 §8.8.8 — a genuine,
  additive extension to the vendored muxer (see `mp4Generator.test.ts`'s CTS describe block for
  byte-level coverage of both the new path and the unchanged fallback), not a JS-side reordering
  buffer, since B-frame *decode* dependencies mean the samples still have to reach the browser's
  decoder in decode order regardless.

  The demo transcoding server (`src/server/services/transcodeSession.ts`) no longer forces
  `bframes=0` unconditionally — `CreateSessionRequest.bFrames` (default `true`, ffmpeg's own
  default) is now a real user-facing option (the demo's Transcoding Settings panel exposes it as
  a checkbox, enabled only for H264/H265), useful for deliberately comparing against
  `bFrames: false`'s IPPP-only/camera-like behavior rather than as a required workaround.

- **MJPEG real-MSE tier (WebCodecs `VideoEncoder`), added 2026-09-03.** `decideUseMjpegEncoder()`
  (`:550-552`, `useMjpegEncoder` field) mirrors `decideUseBridge()`'s style (re-derives its own
  support check — `typeof VideoEncoder !== 'undefined'` — rather than trusting `MediaRouter.ts`'s
  earlier `tagMode` decision blindly) but is structurally simpler: there is no bridge-style
  fallback tier for an *encode* direction, so this either can run, or `MediaRouter.ts` should never
  have picked `'video'`/this class at all for MJPEG in the first place. `init()` (`:2054`) sets
  `useMjpegEncoder` alongside `useBridge`, but — unlike the bridge tier — still calls
  `createMediaSource()` for it (this tier genuinely needs a real `SourceBuffer`, same as H264/H265/
  VP9/AV1's real-MSE path); the `WebCodecsVideoEncoder` itself is constructed lazily in
  `setupMjpegEncoder()` (`:554-561`), called from the first frame each session actually reaches
  (`VideoEncoder.configure()` needs real width/height, unlike the bridge decoder which only needs a
  codec string).

  The core wrinkle this tier has that every other real-MSE codec doesn't: `VideoEncoder.encode()`
  is fire-and-forget (its `EncodedVideoChunk` output arrives later, async, via
  `mjpegEncoder.onEncodedChunk`), but `onVideoData()`'s normal path assumes `streamData.frameData`
  is the complete bitstream synchronously, right now. `submitMjpegFrame()` (`:1390-1418`, called
  from `onVideoData()` in place of the normal synchronous `ingestVideoSample()` call whenever
  `useMjpegEncoder`) hands the raw JPEG to the encoder and records a `mjpegPendingFrames` entry
  (original RTP-derived `streamData`/`videoInfo`, keyed by a caller-assigned `timestampUs` —
  purely internal `VideoFrame` bookkeeping, unrelated to real presentation timing);
  `onMjpegEncodedChunk()` (`:571-614`) is the async replay half — matches a chunk back to its
  pending entry by that same `timestampUs` (a mismatch, e.g. from a mid-flight encoder `error`
  silently dropping an `encode()` call's output, is detected and the chunk dropped rather than
  risk misattributing it to the wrong frame), parses the chunk's `description` (present on the
  first chunk) via `avcConfigParser.ts`'s `parseAvcConfigurationRecord()`/`buildAvc1CodecString()`
  into `mjpegAvcConfig`, builds a synthesized `streamData`/`videoInfo` pair (`codecType: 'H264'`,
  `frameType` from `chunk.type`, `spsPayload`/`ppsPayload`/`profileIdc`/`levelIdc`/`codecInfo` from
  the parsed avcC), and feeds it through `ingestVideoSample()` (`:1371-1381`) — the SAME
  init-segment-once + `createVideoSample()`-every-time logic every synchronous codec's
  `onVideoData()` branch uses, extracted out specifically so this async path doesn't duplicate it
  (including `videoCodecInfo`'s own population, which `setSourceBuffer()`'s MIME-codecs string
  needs and is otherwise an easy new-call-site omission).

  `createSampleFrameData()` (`:1158`) gained a third `isEncoderSourced` parameter for this tier
  specifically: a `VideoEncoder` configured with `avc: { format: 'avc' }` (the default) already
  emits length-prefixed AVCC bytes, so `isEncoderSourced` frames skip the Annex-B-start-code
  rewrite entirely (same early-return VP8/VP9/AV1 already take, just for a different reason) —
  without it, encoder output tagged `codecType: 'H264'` (needed for `mp4Generator.js`'s box-type
  dispatch) would otherwise hit that rewrite and corrupt already-correct bytes. Backpressure
  (`MJPEG_ENCODER_MAX_QUEUE_SIZE`, checked in `submitMjpegFrame()`) never drops a frame while
  `mjpegAvcConfig === null` (no init segment yet, so playback could never start at all without
  it); keyframe cadence (`MJPEG_ENCODER_KEYFRAME_INTERVAL`, `mjpegFramesSinceKeyFrame`) forces a
  periodic `VideoEncoder` keyframe, since MJPEG's own source frames carry no GOP signal of their
  own to derive one from. `close()` calls the new `closeMjpegEncoder()` alongside the existing
  `closeBridge()`. See `MEMORY.md` for the full narrative and the `mp4Generator.js` dead-MJPEG-
  branch (`mpv4`/`esds` stsd, unrelated to this — nothing reaches it) this tier deliberately avoids.

- **`setSourceBuffer()`/`ingestVideoSample()` `SourceBuffer`-creation race, found live via a
  synthetic-JPEG Playwright harness (not by the demo pipeline above, which turned out to have its
  own separate, pre-existing gap — see `MEMORY.md`).** `setSourceBuffer()`'s only call site is the
  `'sourceopen'` listener, and it needs `this.videoCodecInfo` (only set once a real video frame has
  been ingested) to build its MIME/codecs string — if `'sourceopen'` fires first, `isTypeSupported`
  fails on a `"null"` codec string, `this.sourceBuffer` stays `null`, and `addBufferEventListener()`
  — called unconditionally right after regardless — threw `Cannot read properties of null (reading
  'addEventListener')`, permanently aborting `SourceBuffer` creation for the whole session. Not
  MJPEG-specific (the same race exists for H264/H265/VP9/AV1 too — they'd never before had a real
  async gap before their first sample makes it likely to actually trigger), but this tier's
  unavoidable `createImageBitmap()`/`VideoEncoder.configure()` round trip before the first sample
  can exist makes it the first one to hit it reliably. Fixed with two general (not MJPEG-gated)
  changes: `setSourceBuffer()` only calls `addBufferEventListener()` when `this.sourceBuffer !==
  null`; `ingestVideoSample()` retries `setSourceBuffer()` itself right after `createInitSegment()`
  if `this.sourceBuffer` is still `null` at that point (a safe no-op once one already exists, per
  `setSourceBuffer()`'s own `sourceBuffers.length === 0` guard). See `MEMORY.md` for the full
  live-debugging narrative, including the screenshot that confirmed real decoded pixels post-fix.

- **`mjpegEncoderCandidateCodecStrings()` resolution-awareness, found live against a real camera at
  2048x1536.** The candidate list used to be one fixed Level 3.1/4.0 pair, which
  `VideoEncoder.isConfigSupported()` correctly rejected for any resolution whose macroblock count
  exceeds those levels' `maxFS` (H.264 Annex A Table A-1) — MJPEG has no codec-level resolution
  ceiling the way H264/H265 do, so this silently broke the whole tier for real (non-~720p) camera
  resolutions, with only a `console.error` in `WebCodecsVideoEncoder`'s own `configure()` as any
  visible signal. `util/codecString.ts` now computes the actually-required level from the real
  `pixelCount`/`framerate` (`H264_LEVEL_LIMITS`, `selectH264LevelIndexes()`) instead of guessing one
  — see `08-util.md` and `MEMORY.md`.

- **Playback-mode dual-track segment flush deadlock with no audio track, found live immediately
  after Live mode was confirmed working end to end.** `createSegment()` (Playback's `moof+mdat`
  builder, shared with every real-MSE codec, not MJPEG-specific) requires both video *and* audio
  samples queued before building anything; dummy-audio seeding only ran from the *second* I-frame
  boundary onward, so a session with no real audio and either a short clip or an infrequent keyframe
  cadence (MJPEG's own re-encoded stream keyframes only every 60 frames) could permanently deadlock
  with zero segments ever appended — no crash, no error, just nothing plays. `createSegment()` now
  seeds dummy audio itself whenever none is queued yet, capped to stay on `makeDummyAudio()`'s safe
  direct-add path (its own `>100000` branch silently no-ops for a multi-sample span, a trap the
  first fix attempt hit before landing on the cap). See `MEMORY.md` for the full narrative.

- **`initBaseAudioTime()` corrupting `baseVideoTime` (not `baseAudioTime`) on every Playback
  A/V-drift resync, the most serious bug in this saga.** Playback video now appeared (previous
  bug's fix) but played back corrupted — a burned-in OSD timestamp visibly oscillating, 20+s
  latency, a 2fps source appearing to play at a mismatched frame rate. Two layers, found with a
  synthetic-JPEG Playwright trace reading back a distinct per-frame hue from a sampling canvas at
  realistic 2fps/500ms pacing: (a) `createSegment()`'s `MAX_PLAYBACK_DIFF` fallback timeout was only
  ever *scheduled* from `createVideoSample()`'s I-frame-boundary code, so once consumed, nothing
  rescheduled another until the next real keyframe — a real `VideoEncoder` inserts keyframes on its
  own internal cadence, independent of this tier's `forceKeyFrame` request hint, causing multi-second
  stalls; fixed by rescheduling `createVideoSegmentTimeout` unconditionally at the top of every
  `createSegment()` call. (b) `initBaseAudioTime()` (called whenever `baseAudioTime` is the `-1`
  "needs (re)init" sentinel — at session start, and again every `resetBaseDecodingTime()` resync)
  reassigned `this.baseVideoTime` from an *absolute* wall-clock-anchored formula whenever it was
  falsy — harmless the first time (already 0 by default), but `resetBaseDecodingTime()` also zeroes
  `baseVideoTime` itself, Playback-only, so every mid-session resync re-triggered this falsy check
  and clobbered the purely-relative running clock with an absolute millisecond-scale value (confirmed
  live: `baseVideoTime` jumping from ~65,000 to ~75,000,000 between consecutive calls). Live mode's
  own resync never zeroes `baseVideoTime` first, so never hit this. Fixed by deleting the destructive
  reassignment — nothing needs deriving there at all. See `MEMORY.md` for the full narrative.

- **`onWaiting()`'s per-event `currentTime` truncation and `videoPlay()`'s fixed 1s resume margin,
  both tuned for H264/H265's larger Playback segments.** Continuing the previous bug's leftover
  oscillation (native `<video>` event tracing this time, not just the color-sampling trace):
  `onWaiting()` used to truncate `currentTime` to the floor integer second on *every* 'waiting' event,
  not just genuine out-of-range recovery — MJPEG's small, real-time-paced segments hit ordinary
  'waiting' pauses every ~0.5-0.9s, so real playback progress was discarded on nearly every cycle
  (4.79 -> 4.0 -> ~4.79 -> 4.0 again, repeating), reading live as the reported OSD oscillation. Fixed
  to only truncate when `currentTime` is non-finite or at/past the buffered end. Separately,
  `videoPlay()` required a full `PLAYBACK_BUFFERING_TIME` (1s) buffer-ahead margin before *every*
  resume from pause, not just cold start — a permanent deadlock for MJPEG's slow, small-increment
  trickle, which may never accumulate a full second of margin; fixed so only cold start
  (`currentTime === 0`) requires that margin, and a mid-session resume only requires `latency <= 0`.
  Neither fix alone fully resolved the underlying stall (see the next bug) but both are correct,
  narrowly-scoped fixes kept as-is. See `MEMORY.md`.

- **A/V-drift resync comparing real `baseVideoTime` against *synthetic* dummy-audio `baseAudioTime`,
  the root cause the previous bug's fixes didn't reach.** `onWaiting()`'s drift check
  (`Math.abs(baseVideoTime - baseAudioTime) > 20000`) ran unconditionally, even when `dummyAudio` is
  `true` — MJPEG's re-encoder tier has no real audio at all, so `baseAudioTime` only advances via
  `makeDummyAudio()`'s synthetic seeding, an approximation for MSE's technical audio-track
  requirement, not a real timing signal. Dummy audio routinely drifts past the 2s threshold with no
  actual desync, triggering `resetBaseDecodingTime()` to zero `baseVideoTime` and discard several
  already-buffered real seconds; every subsequently-muxed segment's PTS then landed back inside the
  already-covered buffered range instead of extending it, freezing `SourceBuffer.buffered.end()`
  despite appends continuing to succeed (confirmed via direct instrumentation logging
  `{baseVideoTime, baseAudioTime, dummyAudio}` at the exact freeze moment: `{85000, 58880, true}`) —
  and because this re-triggered on nearly every subsequent 'waiting' event, playback stayed
  permanently pinned just past the first reset, matching the reported OSD cycling and the "2fps in,
  ~7fps out" mismatch. Fixed by skipping the resync check entirely while `dummyAudio` is `true`; a
  real second audio track's resync behavior is unchanged. Verified with the same synthetic-JPEG
  trace: `buffered.end()`/`currentTime` now advance continuously and monotonically for the full fed
  duration. See `MEMORY.md` for the full trace narrative.

- **`videoUpdating()`'s zero-margin `currentTime` snap on a `boxsize` transition, found live against
  a real 2048x1536 camera as a negative "Statistics" `Latency` value (`currentTime` past the actual
  buffered end) after playing for a while.** Playback's `boxsize`-transition branch snapped
  `currentTime` directly to the raw `sourceBuffer.buffered.end()` with no safety margin at all —
  every *other* currentTime correction in this class (this same function's own
  `tempCurrentTime = endTime - this.delay` a few lines below, `onWaiting()`'s catch-up jump) backs
  off by `defaultDelay`/`this.delay` first, precisely because a `SourceBuffer`'s reported
  `buffered.end()` can sit right at the edge of what's not yet fully decodable — a real risk for
  this tier's unusually small, frequent, mostly-single-sample segments. Landing exactly on that edge
  risks the same currentTime-ahead-of-decodable-data stall as an outright overshoot. Fixed by backing
  this snap off by `defaultDelay` too, clamped to not go behind `startTime`. Investigated alongside
  `WebCodecsVideoEncoder`'s decode-stage backpressure blind spot (see `07-talk-backup-worker.md`) as
  two independent contributors to the same reported symptom; neither turned out to be the actual
  root cause of the real device's stall — see the `changeCurrentTime()` bullet below, found next.

- **`changeCurrentTime()`'s tab-visibility catch-up jump overshoots the buffered end after the tab
  was backgrounded — the actual root cause of the negative-`Latency` stall the two fixes above
  didn't resolve.** `onVisibilityChange()` (this method's only caller, wired to the page's
  `visibilitychange` event) calls it on every tab refocus; it jumps `currentTime` to a
  `boxStartTime`-derived value (a few `createSegment()`/`createVideoSegment()` calls back) with *no*
  validation against what's actually buffered right now — fine while the tab stays foregrounded
  (`boxStartTime` always trails close behind `currentTime` then), but not after a real background
  period: browsers commonly throttle a hidden tab's `<video>` element (`currentTime` freezes) while
  RTP delivery and this tier's own segment creation keep running regardless, so `boxStartTime` keeps
  growing the whole time. On refocus, the jump target can point past whatever's actually finished
  appending by then — the least defended of the three currentTime-overshoot sites found in this
  saga, with no margin *and* no buffered-end check at all. The user's own description of the
  symptom's *shape* — stall is transient, self-recovers once `Latency` turns positive again, not
  permanent — is what pointed here specifically, since neither of the two bullets above produces
  that jump-then-wait-to-catch-up pattern. Confirmed via an A/B synthetic harness: freeze
  `currentTime` with `videoElement.playbackRate = 0` for 10s while feeding continues (simulating a
  frozen background-tab clock against still-running delivery), restore `playbackRate = 1`, then fire
  a real `visibilitychange` event — reverting the fix and rebuilding reproduced a real overshoot
  (`10.500` past a buffered end of `10.496`) in the exact same harness. Fixed by clamping the jump
  target to `sourceBuffer.buffered.end() - defaultDelay`, same margin pattern as everywhere else in
  this class. Verified post-fix: the jump lands safely under the buffered end, and playback advances
  continuously afterward with no stall. See `MEMORY.md` for the full narrative.

```mermaid
flowchart LR
    StreamPlayer -->|"createVideoPlayer()"| VideoTagPlayer
    MediaRouter -->|"VideoPlayerLike.onVideoData / onAudioData"| VideoTagPlayer
    VideoTagPlayer -->|"initSegment / mediaSegment / dualTrackMediaSegment"| mp4Generator["vendor/mp4Generator"]
    VideoTagPlayer -->|"appendBuffer"| SourceBuffer["SourceBuffer (MSE, browser-native)"]
    SourceBuffer -->|"decode (browser-internal)"| VideoElement["&lt;video&gt; element"]
    VideoTagPlayer -->|"G711/G726 transcode"| AudiotranscoderWorker["audiotranscoderWorker"]
    VideoTagPlayer -->|"encode() (MJPEG only)"| WebCodecsVideoEncoder["worker/videoEncoder/WebCodecsVideoEncoder"]
    WebCodecsVideoEncoder -->|"onEncodedChunk (async)"| VideoTagPlayer
```

---

### `vendor/mp4Generator.d.ts` (type-only reference)

Not a class — a hand-written `.d.ts` for the vendored, unmodified mux.js-derived fMP4 box builder
(`src/player/vendor/mp4Generator.js`, ported verbatim like `ffmpeg.js`/`ffmpegAAC.js`/
`minizip-asm.js` elsewhere in this codebase). It exposes exactly the surface `VideoTagPlayer`
actually calls:
- `initSegment(tracks: (Mp4VideoTrackInfo | Mp4AudioTrackInfo)[]): Uint8Array` — builds the
  `ftyp`+`moov` initialization segment for one or two tracks.
- `mediaSegment(sequenceNumber, tracks: [Mp4BoxInfo], data: Uint8Array): Uint8Array` — builds a
  single-track `moof`+`mdat` media segment.
- `dualTrackMediaSegment(sequenceNumber, tracks: [Mp4BoxInfo, Mp4BoxInfo], data: [Uint8Array,
  Uint8Array]): Uint8Array` — builds a combined video+audio `moof`+`mdat` segment.

Supporting types (`Mp4TimeStamp`, `Mp4Sample`, `Mp4VideoTrackInfo`, `Mp4AudioTrackInfo`,
`Mp4BoxInfo`) describe exactly the shapes `VideoTagPlayer` constructs and passes in — not the full
internal box-building surface of the underlying JS. See `VideoTagPlayer`'s section above for how
each of these three functions is actually invoked.

For the actual box tree these three functions build inside `mp4Generator.js` — the `ftyp`/`moov`/
`stsd`/`moof`/`traf`/`trun` structure, every codec's sample-entry/config-box byte layout, and known
dead-code quirks — see [09-mp4-container-generation.md](09-mp4-container-generation.md).

---

## Combined relations diagram

```mermaid
flowchart TB
    subgraph Orchestration
        StreamPlayer
        MediaRouter
    end

    StreamPlayer -->|"factories.createCanvasPlayer / createVideoPlayer"| MediaRouter
    MediaRouter -->|"tagMode === 'canvas'"| CanvasTagPlayer
    MediaRouter -->|"tagMode === 'video'"| VideoTagPlayer

    CanvasTagPlayer --> CanvasRenderer
    CanvasTagPlayer --> StepBufferList
    CanvasTagPlayer --> PlaybackBufferManager["PlaybackBufferManager (mediaSession, H.265 Playback reorder)"]
    CanvasTagPlayer -.->|"Worker"| decoderWorker

    CanvasRenderer --> YUVWebGLCanvas
    CanvasRenderer --> Image2DCanvas
    YUVWebGLCanvas --> WebGLCanvas
    YUVWebGLCanvas --> GLPrimitives["Shader / Program / Texture"]

    VideoTagPlayer --> mp4Generator["vendor/mp4Generator"]
    VideoTagPlayer --> SourceBuffer["SourceBuffer (MSE)"]
    VideoTagPlayer -.->|"Worker"| audiotranscoderWorker
```
