import { describe, it, expect, vi } from 'vitest';
import { loadLegacyModule, type LegacySandbox } from '../../test-support/loadLegacyModule';
import { createNoopLoggerGlobal, fromHex } from '../../test-support/legacyGlobals';
import { CircularTypedArrayQueue } from '../../util/CircularTypedArrayQueue';
import { Median } from '../../util/Median';
import { VideoPlayer, type VideoPlayerErrorCallback } from './VideoPlayer';
import type { VideoStreamData, VideoInfo } from '../../mediaSession';

interface LegacyVideoPlayer {
  boxsize: number;
  channelId: number;
  currentFrameCount: number;
  previousFrameCount: number;
  framedrop: boolean;
  type: string;
  deviceType: string;
  playmode: string | undefined;
  instantplayback: boolean | undefined;
  codec: string | undefined;
  rfps: number | undefined;
  audioshift: number;
  speed: number;
  eventStatisticsCallback?: unknown;
  eventCaptureCallback?: unknown;
  eventInstantPlaybackCallback?: unknown;
  errorCallback?: (data: unknown) => void;
  onNetworkState: (variance: number, mean: number) => void;
  onChangeAudioShift: (v: number) => void;
  onChangeSpeed: (v: number) => void;
  play(): void;
  addEventListener(event: string, cb: unknown): void;
  setFrameRate(fps: number): void;
  getFrameRate(): number;
  setMaxInstantPlayback(t: number): void;
  getMaxInstantPlayback(): number;
  setBufferClearInterval(i: number): void;
  getBufferClearInterval(): number;
  setDefaultDelay(v: number): void;
  getDefaultDelay(): number;
  setCurrentDelay(v: number): void;
  getCurrentDelay(): number;
  instantplaybackCmd(data: { cmd: string }): void;
  setErrorCallback(func: (data: unknown) => void): void;
}

function buildSandbox(): LegacySandbox {
  return {
    log: createNoopLoggerGlobal(),
    CircularTypedArrayQueue,
    Median,
    fromHex
  };
}

function newLegacy(): LegacyVideoPlayer {
  const Ctor = loadLegacyModule<new () => LegacyVideoPlayer>('Video/Player/videoPlayer.js', 'VideoPlayer', buildSandbox());
  const instance = new Ctor();
  // VideoPlayer.js has *no* base implementation for these (only concrete
  // subclasses like canvasTagPlayer.js provide one) — attach test stand-ins
  // directly on the instance, same as a subclass's inheritObject() would.
  instance.onNetworkState = vi.fn();
  instance.onChangeAudioShift = vi.fn();
  instance.onChangeSpeed = vi.fn();
  return instance;
}

class TestVideoPlayer extends VideoPlayer {
  onNetworkStateCalls: [number, number][] = [];
  onChangeAudioShiftCalls: number[] = [];
  onChangeSpeedCalls: number[] = [];

  override onNetworkState(variance: number, mean: number): void {
    this.onNetworkStateCalls.push([variance, mean]);
  }

  override onChangeAudioShift(v: number): void {
    this.onChangeAudioShiftCalls.push(v);
  }

  override onChangeSpeed(v: number): void {
    this.onChangeSpeedCalls.push(v);
  }

  bufferingVideoData(): boolean {
    return true;
  }

  sendToBufferManager(): void {}

  capture(): void {}

  digitalZoom(): void {}

  controlStepPlay(): void {}

  toggleControls(): void {}
}

function newPorted(): TestVideoPlayer {
  return new TestVideoPlayer();
}

describe('VideoPlayer parity with the legacy player’s Video/Player/videoPlayer.js', () => {
  it('constructor defaults match legacy identically', () => {
    const legacy = newLegacy();
    const ported = newPorted();

    expect(ported.boxsize).toBe(legacy.boxsize);
    expect(ported.channelId).toBe(legacy.channelId);
    expect(ported.currentFrameCount).toBe(legacy.currentFrameCount);
    expect(ported.previousFrameCount).toBe(legacy.previousFrameCount);
    expect(ported.framedrop).toBe(legacy.framedrop);
    expect(ported.type).toBe(legacy.type);
    expect(ported.deviceType).toBe(legacy.deviceType);
    expect(ported.getFrameRate()).toBe(legacy.getFrameRate());
    expect(ported.getMaxInstantPlayback()).toBe(legacy.getMaxInstantPlayback());
    expect(ported.getBufferClearInterval()).toBe(legacy.getBufferClearInterval());
    expect(ported.getDefaultDelay()).toBe(legacy.getDefaultDelay());
    expect(ported.getCurrentDelay()).toBe(legacy.getCurrentDelay());
  });

  it('channelId/playmode/instantplayback/boxsize/deviceType/currentFrameCount/previousFrameCount/codec round-trip identically', () => {
    const legacy = newLegacy();
    const ported = newPorted();

    legacy.channelId = 3;
    ported.channelId = 3;
    expect(ported.channelId).toBe(legacy.channelId);

    legacy.playmode = 'Live';
    ported.playmode = 'Live';
    expect(ported.playmode).toBe(legacy.playmode);

    legacy.instantplayback = true;
    ported.instantplayback = true;
    expect(ported.instantplayback).toBe(legacy.instantplayback);

    legacy.boxsize = 8;
    ported.boxsize = 8;
    expect(ported.boxsize).toBe(legacy.boxsize);

    legacy.deviceType = 'nvr';
    ported.deviceType = 'nvr';
    expect(ported.deviceType).toBe(legacy.deviceType);

    legacy.currentFrameCount = 10;
    ported.currentFrameCount = 10;
    expect(ported.currentFrameCount).toBe(legacy.currentFrameCount);

    legacy.previousFrameCount = 5;
    ported.previousFrameCount = 5;
    expect(ported.previousFrameCount).toBe(legacy.previousFrameCount);

    legacy.codec = 'H264';
    ported.codec = 'H264';
    expect(ported.codec).toBe(legacy.codec);

    legacy.framedrop = true;
    ported.framedrop = true;
    expect(ported.framedrop).toBe(legacy.framedrop);
  });

  it('setFrameRate/setMaxInstantPlayback/setBufferClearInterval/setDefaultDelay/setCurrentDelay round-trip identically', () => {
    const legacy = newLegacy();
    const ported = newPorted();

    legacy.setFrameRate(60);
    ported.setFrameRate(60);
    expect(ported.getFrameRate()).toBe(legacy.getFrameRate());

    legacy.setMaxInstantPlayback(15);
    ported.setMaxInstantPlayback(15);
    expect(ported.getMaxInstantPlayback()).toBe(legacy.getMaxInstantPlayback());

    legacy.setBufferClearInterval(3);
    ported.setBufferClearInterval(3);
    expect(ported.getBufferClearInterval()).toBe(legacy.getBufferClearInterval());

    legacy.setDefaultDelay(0.5);
    ported.setDefaultDelay(0.5);
    expect(ported.getDefaultDelay()).toBe(legacy.getDefaultDelay());

    legacy.setCurrentDelay(0.7);
    ported.setCurrentDelay(0.7);
    expect(ported.getCurrentDelay()).toBe(legacy.getCurrentDelay());
  });

  it('addEventListener registers statistics/capture/instantplayback callbacks identically, ignoring unknown event names', () => {
    const legacy = newLegacy();
    const ported = newPorted();
    const cb = () => {};

    legacy.addEventListener('statistics', cb);
    ported.addEventListener('statistics', cb);
    expect(ported.eventStatisticsCallback).toBe(cb);
    expect(legacy.eventStatisticsCallback).toBe(cb);

    legacy.addEventListener('bogus', cb);
    ported.addEventListener('bogus', cb);
    expect(ported.eventCaptureCallback).toBeUndefined();
    expect(legacy.eventCaptureCallback).toBeUndefined();
  });

  it('instantplaybackCmd({cmd:"play"}) calls play() identically; other cmds are no-ops', () => {
    const legacy = newLegacy();
    const ported = newPorted();
    const legacyPlay = vi.spyOn(legacy, 'play');
    const portedPlay = vi.spyOn(ported, 'play');

    legacy.instantplaybackCmd({ cmd: 'play' });
    ported.instantplaybackCmd({ cmd: 'play' });
    expect(portedPlay).toHaveBeenCalledTimes(1);
    expect(legacyPlay).toHaveBeenCalledTimes(1);

    legacy.instantplaybackCmd({ cmd: 'pause' });
    ported.instantplaybackCmd({ cmd: 'pause' });
    expect(portedPlay).toHaveBeenCalledTimes(1);
  });

  it('audioshift/speed setters call onChangeAudioShift/onChangeSpeed before storing the value, identically', () => {
    const legacy = newLegacy();
    const ported = newPorted();

    legacy.audioshift = 250;
    ported.audioshift = 250;
    expect(ported.audioshift).toBe(legacy.audioshift);
    expect(ported.onChangeAudioShiftCalls).toEqual([250]);
    expect(legacy.onChangeAudioShift).toHaveBeenCalledWith(250);

    legacy.speed = 2;
    ported.speed = 2;
    expect(ported.speed).toBe(legacy.speed);
    expect(ported.onChangeSpeedCalls).toEqual([2]);
    expect(legacy.onChangeSpeed).toHaveBeenCalledWith(2);
  });

  describe('rfps setter (network-state variance analysis on a full 5-sample queue)', () => {
    it('does nothing observable until the 5-sample queue fills, identically', () => {
      const legacy = newLegacy();
      const ported = newPorted();

      for (let i = 0; i < 4; i++) {
        legacy.rfps = 30;
        ported.rfps = 30;
      }
      expect(ported.onNetworkStateCalls).toEqual([]);
      expect(legacy.onNetworkState).not.toHaveBeenCalled();
    });

    it('once full, calls errorCallback with the computed variance/state and onNetworkState(variance, mean), identically', () => {
      const legacy = newLegacy();
      const ported = newPorted();
      const legacyErrorCallback = vi.fn();
      legacy.setErrorCallback(legacyErrorCallback);
      const portedErrorCallback = vi.fn();
      ported.setErrorCallback(portedErrorCallback as VideoPlayerErrorCallback);

      const samples = [30, 30, 30, 30, 30]; // identical => variance 0 => "excellent"
      samples.forEach((fps) => {
        legacy.rfps = fps;
        ported.rfps = fps;
      });

      expect(portedErrorCallback).toHaveBeenCalledTimes(1);
      expect(legacyErrorCallback).toHaveBeenCalledTimes(1);
      const portedArg = portedErrorCallback.mock.calls[0][0];
      const legacyArg = legacyErrorCallback.mock.calls[0][0];
      expect(portedArg).toEqual(legacyArg);
      expect((portedArg as { state: string }).state).toBe('excellent');

      expect(ported.onNetworkStateCalls).toHaveLength(1);
      expect(legacy.onNetworkState).toHaveBeenCalledTimes(1);
      expect(ported.onNetworkStateCalls[0]).toEqual((legacy.onNetworkState as ReturnType<typeof vi.fn>).mock.calls[0]);
    });

    it('reports "poor" for high-variance samples, identically', () => {
      const legacy = newLegacy();
      const ported = newPorted();
      legacy.setErrorCallback(vi.fn());
      const portedErrorCallback = vi.fn();
      ported.setErrorCallback(portedErrorCallback as VideoPlayerErrorCallback);
      const legacyErrorCallback = legacy.errorCallback as ReturnType<typeof vi.fn>;

      const samples = [5, 30, 5, 30, 5];
      samples.forEach((fps) => {
        legacy.rfps = fps;
        ported.rfps = fps;
      });

      const portedState = (portedErrorCallback.mock.calls[0][0] as { state: string }).state;
      const legacyState = (legacyErrorCallback.mock.calls[0][0] as { state: string }).state;
      expect(portedState).toBe(legacyState);
      expect(portedState).toBe('poor');
    });

    it('throws when the queue fills and no errorCallback was ever registered (legacy: this.errorCallback is not a function)', () => {
      const legacy = newLegacy();
      const ported = newPorted();

      // legacy's TypeError is thrown inside the vm sandbox's own realm, so
      // `instanceof TypeError` (host realm) can't be asserted across that
      // boundary — only Error/Math/Date are explicitly realm-shared by this
      // harness (see loadLegacyModule.ts). Message text is a fine substitute.
      expect(() => {
        for (let i = 0; i < 5; i++) legacy.rfps = 30;
      }).toThrow('errorCallback is not a function');
      expect(() => {
        for (let i = 0; i < 5; i++) ported.rfps = 30;
      }).toThrow(new TypeError('this.errorCallback is not a function'));
    });
  });

  it('onVideoData/onWaitingPackets/play/pause/resume/stop/close/clearBuffer/updateMiniMapInfo/forward/backward default to no-ops (log-only in legacy) without throwing', () => {
    const ported = newPorted();
    const streamData = {} as VideoStreamData;
    const videoInfo = {} as VideoInfo;
    expect(() => ported.onVideoData('Live', streamData, videoInfo)).not.toThrow();
    expect(() => ported.onWaitingPackets({} as never)).not.toThrow();
    expect(() => ported.play()).not.toThrow();
    expect(() => ported.pause()).not.toThrow();
    expect(() => ported.resume()).not.toThrow();
    expect(() => ported.stop()).not.toThrow();
    expect(() => ported.close()).not.toThrow();
    expect(() => ported.clearBuffer()).not.toThrow();
    expect(() => ported.updateMiniMapInfo({})).not.toThrow();
    expect(() => ported.forward()).not.toThrow();
    expect(() => ported.backward()).not.toThrow();
  });
});
