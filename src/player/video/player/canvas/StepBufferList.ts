import type { VideoStreamData, VideoInfo } from '../../../mediaSession';

export interface StepBufferNode {
  playMode: string;
  streamData: VideoStreamData;
  videoInfo: VideoInfo;
}

export interface StepFrameTimestamp {
  timestamp?: number;
  timestamp_usec?: number;
}

const DEFAULT_BUFFERING_LENGTH = 240;
const MAX_BUFFERING_LENGTH = 240;
const MIN_BUFFERING_LENGTH = 6;

/**
 * Ported from the legacy player’s Video/Player/Canvas/stepBufferList.js.
 *
 * Legacy grafts these methods onto a `new BufferList()` instance via
 * `inheritObject`, but `push` here has a completely different signature than
 * `BufferList.prototype.push(buffer)` (playMode/streamData/videoInfo, not a
 * single buffer) and operates on its own private `stepList` array rather
 * than `BufferList`'s head/tail linked list — the inherited `push` is fully
 * shadowed, and `BufferList`'s `pop`/`getCurIdx`/`clear` are never called on
 * a StepBufferList instance anywhere (confirmed via grep — canvasTagPlayer.js
 * is the only consumer, and only calls push/forward/backward/searchTimestamp/
 * findIFrame/bufferClear). Extending `BufferList` here would both violate
 * TypeScript's method-override compatibility rules for `push` and carry
 * dead inherited methods, so this is a standalone class instead.
 */
export class StepBufferList {
  private bufferingLength = DEFAULT_BUFFERING_LENGTH;
  private listLength = 0;
  private curIndex = 0;
  private stepList: StepBufferNode[] = [];

  private clear(): void {
    this.stepList = [];
    this.curIndex = 0;
    this.listLength = 0;
  }

  push(playMode: string, streamData: VideoStreamData, videoInfo: VideoInfo): boolean {
    if (this.stepList.length === 1) {
      this.setBufferingLength((videoInfo.framerate as number) * 4);
    }
    if (this.stepList.length < this.bufferingLength) {
      const node: StepBufferNode = { playMode, streamData, videoInfo };
      node.streamData.frameData = new Uint8Array(streamData.frameData);

      this.stepList.push(node);
      this.listLength = this.stepList.length;
    }

    // NOTE: written as the exact `>= ? false : true` form (not the seemingly
    // equivalent `<`) because they diverge when bufferingLength is NaN (see
    // push()'s framerate*4 auto-tune above with a missing framerate): NaN
    // comparisons are always false, so `x >= NaN` is false (ternary picks
    // `true`) while `x < NaN` is also false — not the same result.
    return this.stepList.length >= this.bufferingLength ? false : true;
  }

  forward(): StepBufferNode | null {
    this.curIndex += 1;
    if (this.curIndex < this.listLength) {
      return this.stepList[this.curIndex];
    }
    this.clear();
    return null;
  }

  backward(): StepBufferNode | null {
    this.curIndex -= 1;
    while (this.curIndex >= 0) {
      const node = this.stepList[this.curIndex];
      if (node.videoInfo.frameType === 'I' || node.streamData.codecType === 'MJPEG') {
        return node;
      }
      this.curIndex -= 1;
    }
    this.clear();
    return null;
  }

  searchTimestamp(frameTimestamp: StepFrameTimestamp): void {
    for (let i = 0; i < this.listLength; i++) {
      const node = this.stepList[i];
      if (
        node.streamData.timeStamp.timestamp === frameTimestamp.timestamp &&
        node.streamData.timeStamp.timestamp_usec === frameTimestamp.timestamp_usec
      ) {
        this.curIndex = i;
        break;
      } else if ((node.streamData.timeStamp.timestamp as number) > (frameTimestamp.timestamp as number)) {
        this.curIndex = i;
        break;
      }
    }
  }

  findIFrame(cmd: string): StepBufferNode | undefined {
    while (this.curIndex < this.stepList.length && this.curIndex >= 0) {
      if (cmd === 'forward') {
        this.curIndex += 1;
      } else {
        this.curIndex -= 1;
      }
      if (this.curIndex < 0) {
        this.curIndex = 0;
      }
      if (this.stepList[this.curIndex].videoInfo.frameType === 'I') {
        return this.stepList[this.curIndex];
      }
    }
    return undefined;
  }

  setBufferingLength(length: number): void {
    this.bufferingLength = length;
    if (this.bufferingLength > MAX_BUFFERING_LENGTH) {
      this.bufferingLength = MAX_BUFFERING_LENGTH;
    } else if (this.bufferingLength < MIN_BUFFERING_LENGTH) {
      this.bufferingLength = MIN_BUFFERING_LENGTH;
    }
  }

  bufferClear(): void {
    this.clear();
  }
}
