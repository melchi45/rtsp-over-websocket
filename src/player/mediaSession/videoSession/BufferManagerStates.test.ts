import { describe, it, expect } from 'vitest';
import { loadLegacyModuleExports } from '../../test-support/loadLegacyModule';
import { fromHex } from '../../test-support/legacyGlobals';
import { InitState, PlayState, WaitPauseState, FullState, FakePauseState, PauseState, type BufferManagerLike } from './BufferManagerStates';

interface LegacyStateCtors {
  InitState: new (manager: BufferManagerLike) => LegacyState;
  PlayState: new (manager: BufferManagerLike) => LegacyState;
  WaitPauseState: new (manager: BufferManagerLike) => LegacyState;
  FullState: new (manager: BufferManagerLike) => LegacyState;
  FakePauseState: new (manager: BufferManagerLike) => LegacyState;
  PauseState: new (manager: BufferManagerLike) => LegacyState;
}

interface LegacyState {
  isReadyToPop(): boolean;
  push(): boolean;
  pause(buffer?: unknown): unknown;
  full(): unknown;
  restart(): unknown;
  clear(): void;
  resume(): unknown;
}

const legacyStates = loadLegacyModuleExports<LegacyStateCtors>(
  'MediaSession/VideoSession/bufferStatus.js',
  ['InitState', 'PlayState', 'WaitPauseState', 'FullState', 'FakePauseState', 'PauseState'],
  { fromHex }
);

/** Records every `change()` call so a state-transition trace can be diffed old vs new. */
function trackingManager(): { manager: BufferManagerLike; transitions: string[] } {
  const transitions: string[] = [];
  const manager: BufferManagerLike = {
    change(status) {
      transitions.push(status.constructor.name);
    }
  };
  return { manager, transitions };
}

describe('BufferManagerStates parity with the legacy player’s MediaSession/VideoSession/bufferStatus.js', () => {
  it('InitState.push() transitions to PlayState and returns true, in both implementations', () => {
    const legacyTrack = trackingManager();
    const portedTrack = trackingManager();
    const legacy = new legacyStates.InitState(legacyTrack.manager);
    const ported = new InitState(portedTrack.manager);

    expect(ported.push()).toBe(legacy.push());
    expect(portedTrack.transitions).toEqual(['PlayState']);
    expect(legacyTrack.transitions).toEqual(['PlayState']);
    expect(ported.isReadyToPop()).toBe(legacy.isReadyToPop());
  });

  it('PlayState.full() transitions to WaitPauseState and returns the same error message shape', () => {
    const legacyTrack = trackingManager();
    const portedTrack = trackingManager();
    const legacy = new legacyStates.PlayState(legacyTrack.manager);
    const ported = new PlayState(portedTrack.manager);

    expect(ported.full()).toEqual(legacy.full());
    expect(portedTrack.transitions).toEqual(legacyTrack.transitions);
  });

  it('FullState.pause() then FakePauseState.resume() round-trips back to FullState identically', () => {
    const legacyTrack = trackingManager();
    const portedTrack = trackingManager();
    const legacy = new legacyStates.FullState(legacyTrack.manager);
    const ported = new FullState(portedTrack.manager);

    expect(ported.pause()).toEqual(legacy.pause());
    expect(portedTrack.transitions).toEqual(legacyTrack.transitions);
    expect(portedTrack.transitions).toEqual(['FakePauseState']);

    const legacyFake = new legacyStates.FakePauseState(legacyTrack.manager);
    const portedFake = new FakePauseState(portedTrack.manager);
    expect(portedFake.resume()).toEqual(legacyFake.resume());
    expect(portedTrack.transitions).toEqual(legacyTrack.transitions);
  });

  it('WaitPauseState/PauseState isReadyToPop/push/clear match', () => {
    for (const [LegacyCtor, PortedCtor] of [
      [legacyStates.WaitPauseState, WaitPauseState],
      [legacyStates.PauseState, PauseState]
    ] as const) {
      const legacyTrack = trackingManager();
      const portedTrack = trackingManager();
      const legacy = new LegacyCtor(legacyTrack.manager);
      const ported = new PortedCtor(portedTrack.manager);

      expect(ported.isReadyToPop()).toBe(legacy.isReadyToPop());
      expect(ported.push()).toBe(legacy.push());
      ported.clear();
      legacy.clear();
      expect(portedTrack.transitions).toEqual(legacyTrack.transitions);
    }
  });
});
