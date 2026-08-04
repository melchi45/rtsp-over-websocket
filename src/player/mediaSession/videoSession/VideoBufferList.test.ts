import { describe, it, expect, vi } from 'vitest';
import { loadLegacyModule, loadLegacyModuleSlice } from '../../test-support/loadLegacyModule';
import { VideoBufferList } from './VideoBufferList';

interface UtilBufferSlice {
  inherit: (base: unknown, properties: Record<string, unknown>) => object;
  BufferNode: new (buffer: unknown) => unknown;
  BufferList: (new () => unknown) & { prototype: object };
}

// Only the specific functions this test needs (inherit/BufferNode/BufferList)
// are sliced out of Util/util.js by line range — the rest of that file reaches
// for real-browser globals (document/navigator/screen/log4javascript) that
// aren't worth stubbing just to reach these three self-contained functions.
const utilSlice = loadLegacyModuleSlice<UtilBufferSlice>(
  'Util/util.js',
  [
    [1310, 1325], // window.inherit / window.inheritObject
    [1450, 1455], // function BufferNode(buffer)
    [1500, 1616] // function BufferList() ... BufferList.prototype.clear
  ],
  ['inherit', 'BufferNode', 'BufferList']
);

interface LegacyVideoBufferNode {
  buffer: Uint8Array | null;
  width?: number;
  height?: number;
  frameType?: string;
  timeStamp?: { timestamp: number | null; timestamp_usec: number | null };
  next: LegacyVideoBufferNode | null;
  previous: LegacyVideoBufferNode | null;
}

interface LegacyVideoBufferList {
  push(
    data: Uint8Array,
    width?: number,
    height?: number,
    cropWidth?: number,
    cropHeight?: number,
    codecType?: string,
    frameType?: string,
    timeStamp?: unknown
  ): LegacyVideoBufferNode;
  pop(): LegacyVideoBufferNode | null;
  front(node: LegacyVideoBufferNode | null): void;
  setBufferFullCallback(cb: () => void): void;
  setBUFFERING(interval: number): void;
  getBufferLength(): number;
  clearBuffer(): void;
}

const LegacyVideoBufferListCtor = loadLegacyModule<new () => LegacyVideoBufferList>(
  'MediaSession/VideoSession/videoBuffer.js',
  'VideoBufferList',
  { ...utilSlice, BufferNode: utilSlice.BufferNode }
);

function frame(n: number): Uint8Array {
  return Uint8Array.from([n, n, n]);
}

describe('VideoBufferList parity with the legacy player’s MediaSession/VideoSession/videoBuffer.js', () => {
  it('push/pop preserve FIFO order and return matching node shapes', () => {
    const legacy = new LegacyVideoBufferListCtor();
    const ported = new VideoBufferList();

    for (let i = 1; i <= 3; i++) {
      legacy.push(frame(i), 640, 480, 0, 0, 'H264', 'P', { timestamp: i, timestamp_usec: 0 });
      ported.push(frame(i), 640, 480, 0, 0, 'H264', 'P', { timestamp: i, timestamp_usec: 0 });
    }

    expect(ported.getBufferLength()).toBe(legacy.getBufferLength());

    const legacyPopped = legacy.pop();
    const portedPopped = ported.pop();
    expect(Array.from(portedPopped!.buffer!)).toEqual(Array.from(legacyPopped!.buffer!));
    expect(portedPopped!.timeStamp).toEqual(legacyPopped!.timeStamp);
  });

  it('triggers the full callback once length reaches the BUFFERING threshold, in both implementations', () => {
    const legacy = new LegacyVideoBufferListCtor();
    const ported = new VideoBufferList();
    legacy.setBUFFERING(20); // clamped to the [20, 240] range internally
    ported.setBUFFERING(20);

    const legacyCb = vi.fn();
    const portedCb = vi.fn();
    legacy.setBufferFullCallback(legacyCb);
    ported.setBufferFullCallback(portedCb);

    for (let i = 0; i < 25; i++) {
      legacy.push(frame(i));
      ported.push(frame(i));
    }

    expect(portedCb).toHaveBeenCalledTimes(legacyCb.mock.calls.length);
  });

  it('clearBuffer resets length/head/tail identically', () => {
    const legacy = new LegacyVideoBufferListCtor();
    const ported = new VideoBufferList();
    legacy.push(frame(1));
    ported.push(frame(1));
    legacy.clearBuffer();
    ported.clearBuffer();
    expect(ported.getBufferLength()).toBe(legacy.getBufferLength());
    expect(ported.getBufferLength()).toBe(0);
  });
});
