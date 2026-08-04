import { MjpegDepacketizer, type MjpegFrameData } from './MjpegDepacketizer';

export interface MjpegDepacketizeRequestEntry {
  deviceType: string;
  rtspInterleave: Uint8Array;
  interleavedId: number;
  channelId: number;
  header: Uint8Array;
  payload: Uint8Array;
}

export interface MjpegDepacketizeRequestMessage {
  dataArray: MjpegDepacketizeRequestEntry[];
}

// Narrow local ambient typing for the DedicatedWorkerGlobalScope surface this
// file actually touches, instead of pulling in the full `webworker` lib —
// which conflicts with this project's shared `dom` lib (both declare `self`/
// `postMessage`/etc. with incompatible signatures) and can't coexist in the
// same tsconfig as the DOM-facing main-thread code ported elsewhere.
declare const self: {
  onmessage: ((event: MessageEvent<MjpegDepacketizeRequestMessage>) => void) | null;
  postMessage(message: MjpegFrameData, transfer?: Transferable[]): void;
};

/**
 * Ported from the legacy player’s Worker/MjpegSession/mjpegDepacketizeWorker —
 * the Worker entry MjpegSession.ts (mediaSession/videoSession) spawns to
 * depacketize MJPEG RTP data off the main thread. `mjpegDepacketizer.js`'s
 * standalone JPEG-header/RTP reassembly logic is ported separately in
 * MjpegDepacketizer.ts (old-vs-new vm parity tested there); this file is the
 * thin onmessage/postMessage glue, faithfully reproduced but not parity-
 * testable itself (it has no logic beyond dispatching to that class).
 */
const mjpegDepacketizer = new MjpegDepacketizer();
const bufferArray: MjpegDepacketizeRequestEntry[][] = [];
let isWorking = false;

function gotFrame(data: MjpegFrameData): void {
  const message: MjpegFrameData = {
    playMode: data.playMode,
    streamData: data.streamData,
    videoInfo: data.videoInfo
  };
  self.postMessage(message, [message.streamData.frameData.buffer]);
}

function depacketize(): void {
  if (bufferArray.length === 0 || isWorking === true) {
    return;
  }

  isWorking = true;

  while (bufferArray.length > 0) {
    const dataArray = bufferArray.shift() as MjpegDepacketizeRequestEntry[];
    for (let i = 0, length = dataArray.length; i < length; i += 1) {
      const data = dataArray[i];
      mjpegDepacketizer.deviceType = data.deviceType;
      mjpegDepacketizer.interleavedId = data.interleavedId;
      mjpegDepacketizer.depacketize(data.rtspInterleave, data.header, data.payload);
    }
  }

  isWorking = false;
}

self.onmessage = (event) => {
  bufferArray.push(event.data.dataArray);
  setTimeout(depacketize, 0);
};

mjpegDepacketizer.init();
mjpegDepacketizer.setGotFrameCallback(gotFrame);
