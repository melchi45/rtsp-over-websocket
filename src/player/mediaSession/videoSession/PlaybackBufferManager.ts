import { InitState, type BufferControlMessage, type BufferState } from './BufferManagerStates';
import { VideoBufferList, type VideoBufferNode, type VideoFrameTimeStamp } from './VideoBufferList';

export interface PushBufferInfo {
  streamData: {
    codecType?: string;
    frameData: ArrayLike<number>;
    timeStamp?: VideoFrameTimeStamp;
  };
  videoInfo: {
    frameType?: string;
    spsPayload?: unknown;
    ppsPayload?: unknown;
    framerate?: number;
    width?: number;
    height?: number;
    cropWidth?: number;
    cropHeight?: number;
  };
}

export interface PopFrameInfo {
  playMode: 'Playback';
  streamData: {
    codecType?: string;
    frameData: Uint8Array | null;
    timeStamp?: VideoFrameTimeStamp;
  };
  videoInfo: {
    frameType?: string;
    width?: number;
    height?: number;
    cropWidth?: number;
    cropHeight?: number;
  };
}

/** Ported from the legacy player’s MediaSession/VideoSession/playbackBufferManager.js. */
export class PlaybackBufferManager {
  channelId = 0;
  private bufferStatus: BufferState = new InitState(this);
  private buffer: VideoBufferList | null = new VideoBufferList();
  private bufferSize = 0;
  private callbackFunc: ((message: BufferControlMessage) => void) | null = null;
  private reserveNode: VideoBufferNode | null = null;

  constructor() {
    this.buffer!.setBufferFullCallback(() => this.fullCallback());
  }

  change(status: BufferState): void {
    this.bufferStatus = status;
  }

  private fullCallback(): void {
    const message = this.bufferStatus.full();
    if (typeof message !== 'undefined') {
      this.callbackFunc?.(message);
    }
  }

  init(callback: (message: BufferControlMessage) => void): void {
    this.bufferStatus = new InitState(this);
    this.callbackFunc = callback;
    this.buffer?.clearBuffer();
  }

  push(bufferInfo: PushBufferInfo): boolean {
    if (this.buffer === null) {
      return false;
    }
    if (typeof bufferInfo.videoInfo.framerate !== 'undefined' && bufferInfo.videoInfo.framerate * 4 !== this.bufferSize) {
      this.bufferSize = bufferInfo.videoInfo.framerate * 4;
      this.buffer.setBUFFERING(this.bufferSize);
      this.buffer.setMaxLength(bufferInfo.videoInfo.framerate * 6);
    }
    const frameData = new Uint8Array(bufferInfo.streamData.frameData as ArrayLike<number>);
    this.buffer.push(
      frameData,
      bufferInfo.videoInfo.width,
      bufferInfo.videoInfo.height,
      bufferInfo.videoInfo.cropWidth,
      bufferInfo.videoInfo.cropHeight,
      bufferInfo.streamData.codecType,
      bufferInfo.videoInfo.frameType,
      bufferInfo.streamData.timeStamp
    );
    return this.bufferStatus.push();
  }

  front(): void {
    this.buffer?.front(this.reserveNode);
    this.reserveNode = null;
  }

  pause(): void {
    const message = this.bufferStatus.pause();
    if (typeof message !== 'undefined') {
      this.callbackFunc?.(message);
    }
  }

  resume(): boolean {
    const message = this.bufferStatus.resume();
    if (typeof message !== 'undefined') {
      this.callbackFunc?.(message);
    }
    return this.bufferStatus.isReadyToPop();
  }

  pop(): PopFrameInfo | false | undefined {
    if (this.buffer === null) {
      return undefined;
    }
    const bufferNode = this.buffer.pop();
    if (bufferNode === null || typeof bufferNode === 'undefined') {
      this.bufferStatus.clear();
      return false;
    }
    this.reserveNode = bufferNode;
    return {
      playMode: 'Playback',
      streamData: {
        codecType: bufferNode.codecType,
        frameData: bufferNode.buffer,
        timeStamp: bufferNode.timeStamp
      },
      videoInfo: {
        frameType: bufferNode.frameType,
        width: bufferNode.width,
        height: bufferNode.height,
        cropWidth: bufferNode.cropWidth,
        cropHeight: bufferNode.cropHeight
      }
    };
  }

  full(): BufferControlMessage | undefined {
    return this.bufferStatus.full();
  }

  checkRestart(): boolean {
    if (this.buffer!.getBufferLength() < 1) {
      const message = this.bufferStatus.restart();
      if (typeof message !== 'undefined') {
        this.callbackFunc?.(message);
        return true;
      }
    }
    return false;
  }

  isReadyToPop(): boolean {
    return this.bufferStatus.isReadyToPop();
  }

  clear(): void {
    this.bufferStatus.clear();
  }
}
