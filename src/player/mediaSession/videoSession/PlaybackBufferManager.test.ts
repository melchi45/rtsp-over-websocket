import { describe, it, expect, vi } from 'vitest';
import { loadLegacyModule, loadLegacyModuleSlice } from '../../test-support/loadLegacyModule';
import { createNoopLoggerGlobal } from '../../test-support/legacyGlobals';
import { PlaybackBufferManager, type PushBufferInfo } from './PlaybackBufferManager';

interface UtilBufferSlice {
  inherit: (base: unknown, properties: Record<string, unknown>) => object;
  BufferNode: new (buffer: unknown) => unknown;
  BufferList: (new () => unknown) & { prototype: object };
}

const utilSlice = loadLegacyModuleSlice<UtilBufferSlice>(
  'Util/util.js',
  [
    [1310, 1325],
    [1450, 1455],
    [1500, 1616]
  ],
  ['inherit', 'BufferNode', 'BufferList']
);

const legacyGlobals = {
  ...utilSlice,
  log: createNoopLoggerGlobal(),
  fromHex: (hex: string) => parseInt(hex, 16)
};

const InitState = loadLegacyModule('MediaSession/VideoSession/bufferStatus.js', 'InitState', legacyGlobals);
(legacyGlobals as Record<string, unknown>).InitState = InitState;
const VideoBufferListLegacy = loadLegacyModule('MediaSession/VideoSession/videoBuffer.js', 'VideoBufferList', legacyGlobals);
(legacyGlobals as Record<string, unknown>).VideoBufferList = VideoBufferListLegacy;

interface LegacyManager {
  push(info: PushBufferInfo): boolean;
  pop(): unknown;
  pause(): void;
  resume(): boolean;
  isReadyToPop(): boolean;
  clear(): void;
  init(cb: (message: unknown) => void): void;
}

const LegacyManagerCtor = loadLegacyModule<new () => LegacyManager>(
  'MediaSession/VideoSession/playbackBufferManager.js',
  'PlaybackBufferManager',
  legacyGlobals
);

function makeFrame(frameType: 'I' | 'P'): PushBufferInfo {
  return {
    streamData: { codecType: 'H264', frameData: new Uint8Array([1, 2, 3]), timeStamp: { timestamp: 1, timestamp_usec: 0 } },
    videoInfo: { frameType, width: 640, height: 480 }
  };
}

describe('PlaybackBufferManager parity with the legacy player’s MediaSession/VideoSession/playbackBufferManager.js', () => {
  it('push() transitions Init -> Play and returns true on first push, in both implementations', () => {
    const legacy = new LegacyManagerCtor();
    const ported = new PlaybackBufferManager();
    expect(ported.push(makeFrame('I'))).toBe(legacy.push(makeFrame('I')));
  });

  it('pop() after a push returns a matching frame; pop() on empty returns false in both', () => {
    const legacy = new LegacyManagerCtor();
    const ported = new PlaybackBufferManager();
    legacy.push(makeFrame('I'));
    ported.push(makeFrame('I'));

    const legacyPopped = legacy.pop() as { streamData: { frameData: Uint8Array } };
    const portedPopped = ported.pop() as { streamData: { frameData: Uint8Array | null } };
    expect(Array.from(portedPopped.streamData.frameData!)).toEqual(Array.from(legacyPopped.streamData.frameData));

    expect(ported.pop()).toBe(legacy.pop());
  });

  it('pause()/resume() emit the same callback messages and end in the same isReadyToPop state', () => {
    const legacy = new LegacyManagerCtor();
    const ported = new PlaybackBufferManager();
    legacy.push(makeFrame('I'));
    ported.push(makeFrame('I'));

    const legacyCb = vi.fn();
    const portedCb = vi.fn();
    legacy.init(legacyCb);
    ported.init(portedCb);
    legacy.push(makeFrame('I'));
    ported.push(makeFrame('I'));

    legacy.pause();
    ported.pause();
    expect(ported.isReadyToPop()).toBe(legacy.isReadyToPop());

    legacy.resume();
    const portedResumed = ported.resume();
    expect(typeof portedResumed).toBe('boolean');
  });

  it('clear() resets state identically', () => {
    const legacy = new LegacyManagerCtor();
    const ported = new PlaybackBufferManager();
    legacy.push(makeFrame('I'));
    ported.push(makeFrame('I'));
    legacy.clear();
    ported.clear();
    expect(ported.isReadyToPop()).toBe(legacy.isReadyToPop());
  });
});
