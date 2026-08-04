import { describe, it, expect } from 'vitest';
import { loadLegacyModule, loadLegacyModuleSlice, type LegacySandbox } from '../../../test-support/loadLegacyModule';
import { inheritObject } from '../../../test-support/legacyGlobals';
import { StepBufferList, type StepBufferNode } from './StepBufferList';

interface LegacyStepBufferList {
  push(playMode: string, streamData: unknown, videoInfo: unknown): boolean;
  forward(): StepBufferNode | null;
  backward(): StepBufferNode | null;
  searchTimestamp(frameTimestamp: { timestamp?: number; timestamp_usec?: number }): void;
  findIFrame(cmd: string): StepBufferNode | undefined;
  setBufferingLength(length: number): void;
  bufferClear(): void;
}

// BufferList (the legacy player’s Util/util.js ~line 1450) is loaded as a targeted
// slice for the same reason as other util.js slices elsewhere in this suite —
// the rest of util.js reaches for real-browser globals not worth stubbing
// just to construct the base object stepBufferList.js grafts its own methods
// onto via inheritObject.
function buildSandbox(): LegacySandbox {
  // Lines 1457-1498 (BufferQueue.prototype.*) are skipped: they reference the
  // bare `BufferQueue` identifier, which isn't declared in this slice and
  // isn't needed for BufferNode/BufferList anyway.
  const { BufferList } = loadLegacyModuleSlice<{ BufferList: unknown }>(
    'Util/util.js',
    [
      [1450, 1456],
      [1500, 1692]
    ],
    ['BufferList']
  );
  return { inheritObject, BufferList };
}

function newLegacy(): LegacyStepBufferList {
  const Factory = loadLegacyModule<new () => LegacyStepBufferList>(
    'Video/Player/Canvas/stepBufferList.js',
    'StepBufferList',
    buildSandbox()
  );
  return new Factory();
}

function newPorted(): StepBufferList {
  return new StepBufferList();
}

interface FrameOptions {
  frameType?: string;
  codecType?: string;
  timestamp?: number;
  timestamp_usec?: number;
  framerate?: number;
}

function frame(opts: FrameOptions = {}): { playMode: string; streamData: unknown; videoInfo: unknown } {
  return {
    playMode: 'Live',
    streamData: {
      codecType: opts.codecType ?? 'H264',
      frameData: new Uint8Array([1, 2, 3]),
      timeStamp: { timestamp: opts.timestamp ?? 0, timestamp_usec: opts.timestamp_usec ?? 0 }
    },
    videoInfo: {
      frameType: opts.frameType ?? 'P',
      framerate: opts.framerate
    }
  };
}

function pushFrame(target: { push(playMode: string, streamData: unknown, videoInfo: unknown): boolean }, opts: FrameOptions = {}): boolean {
  const f = frame(opts);
  return target.push(f.playMode, f.streamData, f.videoInfo);
}

describe('StepBufferList parity with the legacy player’s Video/Player/Canvas/stepBufferList.js', () => {
  it('push reports not-full while the (auto-tuned) buffering length has room, identically', () => {
    const legacy = newLegacy();
    const ported = newPorted();

    // The 2nd push's framerate (30) re-tunes bufferingLength to 30*4=120,
    // well above the 5 frames pushed here.
    for (let i = 0; i < 5; i++) {
      const legacyResult = pushFrame(legacy, { framerate: 30, timestamp: i });
      const portedResult = pushFrame(ported, { framerate: 30, timestamp: i });
      expect(portedResult).toBe(legacyResult);
      expect(portedResult).toBe(true);
    }
  });

  it("auto-tunes the buffering length from the 2nd push's framerate (framerate*4, clamped to MIN=6) identically", () => {
    const legacy = newLegacy();
    const ported = newPorted();

    // framerate=1 on the 2nd push => 1*4=4, clamped up to MIN(6).
    const results: { legacy: boolean; ported: boolean }[] = [];
    for (let i = 0; i < 8; i++) {
      const framerate = i === 1 ? 1 : 30;
      results.push({
        legacy: pushFrame(legacy, { framerate, timestamp: i }),
        ported: pushFrame(ported, { framerate, timestamp: i })
      });
    }

    results.forEach((r) => expect(r.ported).toBe(r.legacy));
    expect(results.map((r) => r.ported)).toEqual([true, true, true, true, true, false, false, false]);
  });

  it('push stops growing the list once full (bufferingLength clamped to MIN=6), identically', () => {
    const legacy = newLegacy();
    const ported = newPorted();

    for (let i = 0; i < 10; i++) {
      pushFrame(legacy, { framerate: 1, timestamp: i }); // 2nd push's framerate=1 clamps bufferingLength to 6
      pushFrame(ported, { framerate: 1, timestamp: i });
    }

    // The list is capped at 6 nodes; forward() from curIdx=0 visits indices
    // 1..5 (5 real nodes) before overrunning and clearing.
    let legacyCount = 0;
    while (legacy.forward() !== null) legacyCount++;
    let portedCount = 0;
    while (ported.forward() !== null) portedCount++;
    expect(portedCount).toBe(legacyCount);
    expect(portedCount).toBe(5);
  });

  it('a missing framerate on the 2nd/3rd push produces a NaN bufferingLength — frames are silently dropped but push() still reports true (NaN comparisons are always false), and a later valid framerate recovers it', () => {
    const legacy = newLegacy();
    const ported = newPorted();

    const legacyResults: boolean[] = [];
    const portedResults: boolean[] = [];
    const framerates = [30, undefined, undefined, 30, 30];
    framerates.forEach((framerate, i) => {
      legacyResults.push(pushFrame(legacy, { framerate, timestamp: i }));
      portedResults.push(pushFrame(ported, { framerate, timestamp: i }));
    });

    expect(portedResults).toEqual(legacyResults);
    expect(portedResults).toEqual([true, true, true, true, true]);
  });

  it('forward()/backward() traverse identically and return null (after an internal clear) past the ends', () => {
    const legacy = newLegacy();
    const ported = newPorted();

    for (let i = 0; i < 5; i++) {
      pushFrame(legacy, { framerate: 30, timestamp: i, frameType: i % 2 === 0 ? 'I' : 'P' });
      pushFrame(ported, { framerate: 30, timestamp: i, frameType: i % 2 === 0 ? 'I' : 'P' });
    }

    for (let i = 0; i < 6; i++) {
      const legacyNode = legacy.forward();
      const portedNode = ported.forward();
      expect(portedNode === null).toBe(legacyNode === null);
      if (legacyNode !== null && portedNode !== null) {
        expect((portedNode.streamData as { timeStamp: { timestamp: number } }).timeStamp.timestamp).toBe(
          (legacyNode.streamData as { timeStamp: { timestamp: number } }).timeStamp.timestamp
        );
      }
    }

    // forward() ran past the end, which clears the list (a real legacy quirk
    // — forward()/backward() overrunning the list wipes it out). A further
    // forward()/backward() call must return null identically post-clear.
    expect(ported.forward()).toBe(legacy.forward());
    expect(ported.backward()).toBe(legacy.backward());
  });

  it('backward() skips non-I/non-MJPEG frames identically, returning the nearest I-frame or MJPEG frame', () => {
    const legacy = newLegacy();
    const ported = newPorted();

    const frameTypes = ['I', 'P', 'P', 'P', 'I'];
    frameTypes.forEach((frameType, i) => {
      pushFrame(legacy, { framerate: 30, timestamp: i, frameType });
      pushFrame(ported, { framerate: 30, timestamp: i, frameType });
    });

    // Advance to the last node first.
    for (let i = 0; i < 4; i++) {
      legacy.forward();
      ported.forward();
    }

    const legacyNode = legacy.backward();
    const portedNode = ported.backward();
    expect(portedNode === null).toBe(legacyNode === null);
    expect((portedNode as StepBufferNode).videoInfo.frameType).toBe(
      (legacyNode as { videoInfo: { frameType: string } }).videoInfo.frameType
    );
    expect((portedNode as StepBufferNode).videoInfo.frameType).toBe('I');
  });

  it('searchTimestamp + findIFrame locate the same I-frame identically', () => {
    const legacy = newLegacy();
    const ported = newPorted();

    const frameTypes = ['I', 'P', 'P', 'I', 'P', 'P', 'I'];
    frameTypes.forEach((frameType, i) => {
      pushFrame(legacy, { framerate: 30, timestamp: i, frameType });
      pushFrame(ported, { framerate: 30, timestamp: i, frameType });
    });

    legacy.searchTimestamp({ timestamp: 4, timestamp_usec: 0 });
    ported.searchTimestamp({ timestamp: 4, timestamp_usec: 0 });

    const legacyNode = legacy.findIFrame('forward');
    const portedNode = ported.findIFrame('forward');
    expect(portedNode === undefined).toBe(legacyNode === undefined);
    expect((portedNode as StepBufferNode).streamData.timeStamp.timestamp).toBe(
      (legacyNode as { streamData: { timeStamp: { timestamp: number } } }).streamData.timeStamp.timestamp
    );
    expect((portedNode as StepBufferNode).streamData.timeStamp.timestamp).toBe(6);
  });

  it('bufferClear() resets both instances to the same empty state', () => {
    const legacy = newLegacy();
    const ported = newPorted();

    for (let i = 0; i < 5; i++) {
      pushFrame(legacy, { framerate: 30, timestamp: i });
      pushFrame(ported, { framerate: 30, timestamp: i });
    }

    legacy.bufferClear();
    ported.bufferClear();

    expect(ported.forward()).toBe(legacy.forward());
    expect(ported.backward()).toBe(legacy.backward());
  });

  it('setBufferingLength clamps to [6, 240] identically, once past the one-time auto-tune trigger point', () => {
    const legacy = newLegacy();
    const ported = newPorted();

    // 2 pushes to get past the auto-tune trigger (fires only when
    // stepList.length===1, i.e. during the 2nd push).
    pushFrame(legacy, { framerate: 30, timestamp: 0 });
    pushFrame(ported, { framerate: 30, timestamp: 0 });
    pushFrame(legacy, { framerate: 30, timestamp: 1 });
    pushFrame(ported, { framerate: 30, timestamp: 1 });

    // Explicit clamp-from-below: setBufferingLength(1) clamps to MIN(6).
    legacy.setBufferingLength(1);
    ported.setBufferingLength(1);

    const legacyResults: boolean[] = [];
    const portedResults: boolean[] = [];
    for (let i = 2; i < 8; i++) {
      legacyResults.push(pushFrame(legacy, { framerate: 30, timestamp: i }));
      portedResults.push(pushFrame(ported, { framerate: 30, timestamp: i }));
    }
    expect(portedResults).toEqual(legacyResults);
    // List already had 2 nodes; bufferingLength clamped to 6, so 3 more
    // pushes fill it (2->5 nodes, still "true"), the 4th push fills it to 6
    // and reports full, and the rest stay full.
    expect(portedResults).toEqual([true, true, true, false, false, false]);
  });
});
