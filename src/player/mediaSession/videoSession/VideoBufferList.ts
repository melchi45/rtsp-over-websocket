export interface VideoFrameTimeStamp {
  timestamp: number | null;
  timestamp_usec: number | null;
}

export class VideoBufferNode {
  next: VideoBufferNode | null = null;
  previous: VideoBufferNode | null = null;

  constructor(
    public buffer: Uint8Array | null,
    public width?: number,
    public height?: number,
    public cropWidth?: number,
    public cropHeight?: number,
    public codecType?: string,
    public frameType?: string,
    public timeStamp?: VideoFrameTimeStamp
  ) {}
}

const DEFAULT_BUFFERING = 240;

/** Ported from the legacy player’s MediaSession/VideoSession/videoBuffer.js. */
export class VideoBufferList {
  private length = 0;
  private head: VideoBufferNode | null = null;
  private tail: VideoBufferNode | null = null;
  curIdx = 0;

  private buffering = DEFAULT_BUFFERING;
  private bufferFullCallback: (() => void) | null = null;
  private checkFull = false;

  push(
    data: Uint8Array,
    width?: number,
    height?: number,
    cropWidth?: number,
    cropHeight?: number,
    codecType?: string,
    frameType?: string,
    timeStamp?: VideoFrameTimeStamp
  ): VideoBufferNode {
    const node = new VideoBufferNode(data, width, height, cropWidth, cropHeight, codecType, frameType, timeStamp);
    if (this.length > 0) {
      this.tail!.next = node;
      node.previous = this.tail;
      this.tail = node;
    } else {
      this.head = node;
      this.tail = node;
    }
    this.length += 1;

    if (this.bufferFullCallback !== null && this.length >= this.buffering) {
      if (!this.checkFull) {
        this.checkFull = true;
        this.bufferFullCallback();
      }
    } else if (this.checkFull) {
      this.checkFull = false;
    }

    return node;
  }

  front(node: VideoBufferNode | null): void {
    if (node === null) {
      return;
    }
    if (this.length > 0) {
      this.head!.previous = node;
      node.next = this.head;
      this.head = node;
    } else {
      this.head = node;
      this.tail = node;
    }
    this.length += 1;
  }

  pop(): VideoBufferNode | null {
    let node: VideoBufferNode | null = null;
    if (this.length > 0) {
      node = this.head;
      this.head = this.head!.next;
      if (this.head !== null) {
        this.head.previous = null;
      } else {
        this.tail = null;
      }
      this.length -= 1;
    }
    return node;
  }

  // NOTE: write-only in the legacy file too — the clamped MAX_LENGTH value it
  // computed was never read anywhere else. Kept as a no-op for API parity.
  setMaxLength(_length: number): void {}

  setBUFFERING(interval: number): void {
    this.buffering = Math.min(Math.max(interval, 20), 240);
  }

  setBufferFullCallback(callback: () => void): void {
    this.bufferFullCallback = callback;
  }

  searchTimestamp(frameTimestamp: VideoFrameTimeStamp): VideoBufferNode | null {
    let currentNode = this.head;
    const length = this.length;
    let count = 1;

    if (length === 0 || !frameTimestamp || currentNode === null) {
      throw new Error('Failure: non-existent node in this list.');
    }

    while (
      currentNode !== null &&
      (currentNode.timeStamp?.timestamp !== frameTimestamp.timestamp ||
        currentNode.timeStamp?.timestamp_usec !== frameTimestamp.timestamp_usec)
    ) {
      currentNode = currentNode.next;
      count++;
    }

    if (length < count) {
      currentNode = null;
    } else {
      this.curIdx = count;
    }

    return currentNode;
  }

  findIFrame(isForward: boolean): VideoBufferNode | null {
    let currentNode = this.head;
    const length = this.length;
    let count = 1;

    if (length === 0) {
      throw new Error('Failure: non-existent node in this list.');
    }

    while (count < this.curIdx) {
      currentNode = currentNode!.next;
      count++;
    }

    if (isForward === true) {
      while (currentNode!.frameType !== 'I') {
        currentNode = currentNode!.next;
        count++;
      }
    } else {
      while (currentNode!.frameType !== 'I') {
        currentNode = currentNode!.previous;
        count--;
      }
    }

    if (length < count) {
      currentNode = null;
    } else {
      this.curIdx = count;
    }

    return currentNode;
  }

  clearBuffer(): void {
    let node = this.head;
    while (node !== null) {
      const nodeToDelete: VideoBufferNode | null = node;
      node = node.next;
      nodeToDelete.buffer = null;
    }
    this.length = 0;
    this.head = null;
    this.tail = null;
    this.curIdx = 0;
  }

  getBufferLength(): number {
    return this.length;
  }
}
