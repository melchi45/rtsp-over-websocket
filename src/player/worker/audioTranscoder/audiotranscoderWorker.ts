/// <reference path="../../vendor/EmscriptenModule.d.ts" />
import { AssemblyTranscoder, type TranscoderCodecInfo } from './AssemblyTranscoder';

// Ported from the legacy player’s Worker/AudioTranscoder/audiotranscoderWorker —
// legacy pre-declares the ambient `Module` global here, before
// `importScripts`-ing the vendored Emscripten glue (see AssemblyTranscoder.ts),
// so `AssemblyTranscoder`'s constructor can assign `Module.onRuntimeInitialized`
// without a ReferenceError. `EmscriptenModule.d.ts` only supplies the *type*
// for `Module` — this line is what actually gives it a value at runtime.
globalThis.Module = typeof Module !== 'undefined' ? Module : ({} as typeof Module);

export interface TranscodeStreamData {
  frameData: Uint8Array;
  timeStamp?: unknown;
  [key: string]: unknown;
}

export type AudiotranscoderWorkerMessage = { type: 'init'; data: TranscoderCodecInfo } | { type: 'terminate' } | { type: 'transcode'; data: TranscodeStreamData };

// Narrow local ambient typing for the classic Worker global scope this file
// touches — see mjpegDepacketizeWorker.ts for why the full `webworker` lib
// isn't used project-wide.
declare function addEventListener(type: 'message', listener: (event: MessageEvent<AudiotranscoderWorkerMessage>) => void, useCapture: boolean): void;
declare function postMessage(message: unknown, transfer?: Transferable[]): void;

/**
 * Ported from the legacy player’s Worker/AudioTranscoder/audiotranscoderWorker —
 * the Worker entry that owns one AssemblyTranscoder instance, transcoding
 * backup-recording G.711/G.726 audio to AAC.
 *
 * `transcode()` can return `undefined` (see AssemblyTranscoder.ts's own doc
 * comment on its `ret < 0` error path); legacy's `'transcode'` case then does
 * `streamData.frameData = transcoder.transcode(...); if
 * (streamData.frameData.length) {...}` with no null check, so it throws a
 * real `TypeError` reading `.length` off `undefined` whenever a transcode
 * call fails. Preserved faithfully rather than guarded.
 */
let transcoder: AssemblyTranscoder | null = null;
let isDecoderReady = false;

function onTranscoderReady(): void {
  // eslint-disable-next-line no-console
  console.log('onTranscoderReady !');
  isDecoderReady = true;
}

function sendMessage(type: string, data: TranscodeStreamData): void {
  const event = { type, data };
  postMessage(event, [event.data.frameData.buffer]);
}

function receiveMessage(event: MessageEvent<AudiotranscoderWorkerMessage>): void {
  const message = event.data;
  switch (message.type) {
    case 'init':
      if (transcoder === null) {
        transcoder = new AssemblyTranscoder(message.data);
        transcoder.addListener('onTranscoderReady', onTranscoderReady);
      } else {
        transcoder.openDecoder(message.data);
      }
      break;
    case 'terminate':
      if (transcoder !== null) {
        transcoder.close();
      }
      transcoder = null;
      postMessage({ type: 'terminated', data: null });
      break;
    case 'transcode':
      if (transcoder !== null && isDecoderReady) {
        const streamData = message.data;
        // legacy: no null-check on the transcode() result — see class doc comment.
        streamData.frameData = transcoder.transcode(streamData.frameData) as Uint8Array;
        if (streamData.frameData.length) {
          sendMessage('transcoded', streamData);
        }
      }
      break;
    default:
      break;
  }
}

addEventListener('message', receiveMessage, false);
