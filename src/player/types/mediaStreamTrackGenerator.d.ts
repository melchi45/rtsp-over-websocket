/**
 * Minimal ambient declaration for the WebCodecs "Insertable Streams for
 * MediaStreamTrack" `MediaStreamTrackGenerator` — the *produce*-direction
 * counterpart to `MediaStreamTrackProcessor` (which this repo's pinned
 * TypeScript version's bundled `lib.dom.d.ts`/`lib.webworker.d.ts` already
 * type — confirmed by grep). `MediaStreamTrackGenerator` itself has zero
 * ambient coverage in that same TS version, so this repo supplies it —
 * same `declare global` pattern `vendor/EmscriptenModule.d.ts` uses for
 * another browser/build global TypeScript doesn't know about. Lives outside
 * `vendor/` (which `tsconfig.json` excludes from the default `include` glob
 * and therefore needs an explicit `/// <reference path="..." />` at every
 * call site) so this applies automatically wherever it's needed, with no
 * per-file reference directive required.
 *
 * Only the surface this codebase actually uses is declared (video-only
 * `kind`, `.writable`) — see `video/player/video/VideoTagPlayer.ts` (the
 * bridge tier's main-thread `MediaStreamTrackGenerator` construction; note
 * this API is confirmed, live, to NOT exist inside a dedicated Worker in at
 * least one real Chromium build, despite the spec allowing that exposure —
 * that's why the bridge tier runs on the main thread, not a Worker) and
 * `worker/videoDecoder/WebCodecsVideoDecoder.ts`'s bridge output mode
 * (which only needs the `.writable` type, not construction, since the
 * generator itself is always built by `VideoTagPlayer`).
 */
export interface MediaStreamTrackGeneratorInit {
  kind: 'video' | 'audio';
}

export interface MediaStreamVideoTrackGenerator extends MediaStreamTrack {
  readonly writable: WritableStream<VideoFrame>;
}

declare global {
  // eslint-disable-next-line no-var
  var MediaStreamTrackGenerator: {
    prototype: MediaStreamVideoTrackGenerator;
    new (init: MediaStreamTrackGeneratorInit): MediaStreamVideoTrackGenerator;
  };
}
