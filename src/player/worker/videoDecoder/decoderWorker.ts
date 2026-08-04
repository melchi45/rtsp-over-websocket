/// <reference path="../../vendor/EmscriptenModule.d.ts" />
import { AssemblyDecoder, type AssemblyDecoderFrame } from './AssemblyDecoder';

// Ported from the legacy player’s Worker/VideoDecoder/decoderWorker — legacy
// pre-declares the ambient `Module` global here, before `importScripts`-ing
// the vendored Emscripten glue (see AssemblyDecoder.ts), so `AssemblyDecoder`'s
// constructor can assign `Module.onRuntimeInitialized` without a
// ReferenceError. `EmscriptenModule.d.ts` only supplies the *type* for
// `Module` — this line is what actually gives it a value at runtime.
globalThis.Module = typeof Module !== 'undefined' ? Module : ({} as typeof Module);

export interface DecoderWorkerFrame extends AssemblyDecoderFrame {
  currentFps?: number;
  timeStamp?: unknown;
  width?: number;
  height?: number;
  cropWidth?: number;
  cropHeight?: number;
  receiveClock?: unknown;
  playMode?: string;
}

export type DecoderWorkerMessage =
  | { type: 'createDecoder'; data: string; channelId: number }
  | { type: 'terminate' }
  | { type: 'setOutputSize'; data: number }
  | { type: 'setDecoderIndex'; data: number }
  | { type: 'useDropPacket'; data: boolean }
  | { type: 'setFrameRate'; data: number }
  | { type: 'playMode'; data: string }
  | { type: 'decode'; data: DecoderWorkerFrame };

// Narrow local ambient typing for the classic Worker global scope this file
// touches — see mjpegDepacketizeWorker.ts for why the full `webworker` lib
// isn't used project-wide.
declare function addEventListener(type: 'message', listener: (event: MessageEvent<DecoderWorkerMessage>) => void, useCapture: boolean): void;
declare const self: {
  postMessage(message: unknown): void;
};

const ALLOW_FRAME_COUNT = 2.5;
const DEFAULT_THRESHOLD = 200;
const DEFAULT_THRESHOLD2 = 100;
const DEFAULT_FRAME_RATE = 30;

/**
 * Ported from the legacy player’s Worker/VideoDecoder/decoderWorker — the
 * Worker entry that owns one AssemblyDecoder instance (H.264/H.265 WASM
 * decode) and applies the drop-frame performance heuristics: an I-frame is
 * always decoded and its decode time compared against a per-frame-rate
 * threshold; if a P/B-frame decode would exceed a (looser) secondary
 * threshold — or the *previous* frame already tripped the primary one — it's
 * skipped instead of decoded.
 *
 * `isDecoderReady` is only ever set `true` from inside `onDecoderReady()`'s
 * `if (frameBuffer.length > 0 || playMode === 'Playback')` guard — a real
 * legacy quirk this preserves: if the WASM runtime finishes initializing
 * while `frameBuffer` is still empty and `playMode` isn't `'Playback'` yet,
 * `isDecoderReady` never becomes true (that guard only runs once, since
 * `onDecoderReady` fires exactly once per decoder lifetime), and every
 * subsequent 'decode' message is buffered forever instead of decoded.
 */
let decoder: AssemblyDecoder | null = null;
let frameRate = DEFAULT_FRAME_RATE;
let decodedClock = 0;
let usePacketDrop = true;
let isDecoderReady = false;
let decoderIndex = 0;
let playMode: string | undefined;
let toBeContinueDropFrameFlag = false;
let threshold = DEFAULT_THRESHOLD;
let threshold2 = DEFAULT_THRESHOLD2;
const frameBuffer: DecoderWorkerFrame[] = [];

function sendMessage(type: string, data: unknown): void {
  self.postMessage({ type, data });
}

function effectiveFrameRate(currentFps: number | undefined): number {
  return currentFps !== undefined && currentFps !== 0 ? currentFps : frameRate;
}

function onDecoderReady(): void {
  if (!(frameBuffer.length > 0 || playMode === 'Playback')) {
    return;
  }

  while (frameBuffer.length !== 0) {
    const lastFrame = frameBuffer.shift() as DecoderWorkerFrame;
    let decodedFrame: Uint8Array | null;

    if (usePacketDrop) {
      if (lastFrame.frameType === 'I') {
        const prev = performance.now();
        decodedFrame = decoder!.decode(lastFrame);
        decodedClock = performance.now() - prev;
        threshold = (1000 / effectiveFrameRate(lastFrame.currentFps)) * ALLOW_FRAME_COUNT;
        toBeContinueDropFrameFlag = false;
        if (decodedClock > threshold) {
          toBeContinueDropFrameFlag = true;
          sendMessage('lowPerformance', { channelId: decoder!.channelId, decoderId: decoderIndex, performance: decodedClock / ((1000 / lastFrame.currentFps!) * ALLOW_FRAME_COUNT) });
        }
      } else if (!toBeContinueDropFrameFlag && decodedClock < threshold) {
        const prev = performance.now();
        decodedFrame = decoder!.decode(lastFrame);
        decodedClock = performance.now() - prev;
        threshold2 = (1000 / effectiveFrameRate(lastFrame.currentFps)) * 1.5;
        if (decodedClock > threshold2) {
          toBeContinueDropFrameFlag = true;
          sendMessage('lowPerformance', { channelId: decoder!.channelId, decoderId: decoderIndex, performance: decodedClock / ((1000 / lastFrame.currentFps!) * ALLOW_FRAME_COUNT) });
        }
      } else {
        break;
      }
    } else {
      decodedFrame = decoder!.decode(lastFrame);
    }

    lastFrame.frameData = null as unknown as Uint8Array; // legacy: nulls the field to free the buffer reference after decode
    if (decodedFrame! !== null) {
      sendMessage('decoded', {
        channelId: decoder!.channelId,
        frame: decodedFrame,
        time: lastFrame.timeStamp,
        width: lastFrame.width,
        height: lastFrame.height,
        cropWidth: lastFrame.cropWidth,
        cropHeight: lastFrame.cropHeight,
        receiveClock: lastFrame.receiveClock
      });
    }
  }
  isDecoderReady = true;
}

function receiveMessage(event: MessageEvent<DecoderWorkerMessage>): void {
  const message = event.data;
  switch (message.type) {
    case 'createDecoder':
      decoder = new AssemblyDecoder(message.data);
      decoder.channelId = message.channelId;
      decoder.addListener('onDecoderReady', onDecoderReady);
      break;
    case 'terminate':
      if (decoder !== null) {
        decoder.close();
      }
      sendMessage('terminated', { channelId: decoder!.channelId });
      break;
    case 'setOutputSize':
      if (decoder !== null) {
        decoder.setOutputSize(message.data);
      }
      break;
    case 'setDecoderIndex':
      decoderIndex = message.data;
      break;
    case 'useDropPacket':
      usePacketDrop = message.data;
      break;
    case 'setFrameRate':
      if (usePacketDrop) {
        frameRate = message.data === 0 ? DEFAULT_FRAME_RATE : message.data;
        threshold = (1000 / frameRate) * ALLOW_FRAME_COUNT;
      }
      break;
    case 'playMode':
      playMode = message.data;
      break;
    case 'decode':
      if (decoder !== null) {
        if (isDecoderReady) {
          decodeLiveMessage(message.data);
        } else {
          // Frame buffering when decoder is not ready
          frameBuffer.push(message.data);
        }
      }
      break;
    default:
      break;
  }
}

function decodeLiveMessage(data: DecoderWorkerFrame): void {
  let decodedFrame: Uint8Array | null;

  if (usePacketDrop) {
    if (data.frameType === 'I') {
      const prev = performance.now();
      decodedFrame = decoder!.decode(data);
      decodedClock = performance.now() - prev;
      threshold = (1000 / effectiveFrameRate(data.currentFps)) * ALLOW_FRAME_COUNT;
      if (decodedClock > threshold) {
        toBeContinueDropFrameFlag = true;
        sendMessage('lowPerformance', { channelId: decoder!.channelId, decoderId: decoderIndex, performance: decodedClock / ((1000 / data.currentFps!) * ALLOW_FRAME_COUNT) });
      }
    } else if (!toBeContinueDropFrameFlag && decodedClock < threshold) {
      const prev = performance.now();
      decodedFrame = decoder!.decode(data);
      decodedClock = performance.now() - prev;
      threshold2 = (1000 / effectiveFrameRate(data.currentFps)) * 1.5;
      if (decodedClock > threshold2) {
        toBeContinueDropFrameFlag = true;
        sendMessage('lowPerformance', { channelId: decoder!.channelId, decoderId: decoderIndex, performance: decodedClock / ((1000 / data.currentFps!) * ALLOW_FRAME_COUNT) });
      }
    } else {
      // legacy: `break;` out of the switch case here, leaving `data.frameData`
      // un-nulled (unlike every other path through this function).
      return;
    }
  } else {
    decodedFrame = decoder!.decode(data);
  }

  data.frameData = null as unknown as Uint8Array; // legacy: nulls the field to free the buffer reference after decode
  if (decodedFrame! !== null) {
    sendMessage('decoded', {
      channelId: decoder!.channelId,
      frame: decodedFrame,
      time: data.timeStamp,
      width: data.width,
      height: data.height,
      cropWidth: data.cropWidth,
      cropHeight: data.cropHeight,
      receiveClock: data.receiveClock
    });
  } else if (data.playMode === 'Playback') {
    self.postMessage({ type: 'notReady' });
  }
}

addEventListener('message', receiveMessage, false);
