import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { loadLegacyModule } from '../test-support/loadLegacyModule';
import { Fisheye3D } from './FishEye3D';

interface LegacyFisheye3D {
  fisheyeview: boolean;
  mesh: unknown;
  mount: unknown;
  onDocumentMouseDown(event: { preventDefault(): void; clientX: number; clientY: number }): void;
  onDocumentMouseMove(event: { clientX: number; clientY: number }): void;
  onDocumentMouseUp(event?: unknown): void;
  onDocumentMouseDbClick(event?: unknown): void;
  onDocumentMouseWheel(event: { wheelDeltaY?: number; wheelDelta?: number; detail?: number }): void;
}

const LegacyFisheye3DCtor = loadLegacyModule<new () => LegacyFisheye3D>('Util/fishEye3D.js', 'Fisheye3D', {
  THREE,
  window: {
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    innerWidth: 1920,
    innerHeight: 1080,
    devicePixelRatio: 1,
    addEventListener: () => {},
    removeEventListener: () => {}
  }
});

function newLegacy(): LegacyFisheye3D {
  return new LegacyFisheye3DCtor();
}

function newPorted(): Fisheye3D {
  return new Fisheye3D();
}

/**
 * NOTE on scope: `lon`/`lat`/`distance`/`fov`/`isUserInteracting`/`camera`
 * are `var`-declared closure variables inside the `Fisheye3D()` factory
 * function in legacy — never assigned onto `this`/`Constructor.prototype`
 * anywhere, and never returned by any method either. That makes them
 * genuinely unobservable from outside the closure (stronger privacy than
 * this port's TypeScript `private` fields, which a test *could* peek at via
 * a cast — but doing so wouldn't be comparing against anything real on the
 * legacy side). The mouse/wheel-driven camera math is therefore only
 * verifiable through actual WebGL rendering output, i.e. BROWSER/contract
 * tier (Design doc §5.2), not old-vs-new parity — this suite covers only
 * the genuinely observable public contract: `fisheyeview`/`mesh`/`mount`
 * accessors and the fact that the interaction handlers don't throw.
 */
describe('Fisheye3D parity with the legacy player’s Util/fishEye3D.js (observable public contract only — see NOTE above)', () => {
  it('starts with fisheyeview=false identically', () => {
    const legacy = newLegacy();
    const ported = newPorted();
    expect(ported.fisheyeview).toBe(legacy.fisheyeview);
    expect(ported.fisheyeview).toBe(false);
  });

  describe('mount', () => {
    it('accepts "wall" and "Celling" (case-insensitively) without throwing, identically', () => {
      const legacy = newLegacy();
      const ported = newPorted();
      expect(() => (legacy.mount = 'WALL')).not.toThrow();
      expect(() => (ported.mount = 'WALL' as never)).not.toThrow();
      expect(() => (legacy.mount = 'Celling')).not.toThrow();
      expect(() => (ported.mount = 'Celling' as never)).not.toThrow();
    });

    it('throws the same ReferenceError for an invalid mount mode (confirmed legacy bug: FisheyeError is never defined)', () => {
      const legacy = newLegacy();
      const ported = newPorted();
      let legacyError: Error | null = null;
      let portedError: Error | null = null;
      try {
        legacy.mount = 'floor';
      } catch (e) {
        legacyError = e as Error;
      }
      try {
        ported.mount = 'floor' as never;
      } catch (e) {
        portedError = e as Error;
      }
      expect(portedError?.constructor.name).toBe(legacyError?.constructor.name);
      expect(portedError?.constructor.name).toBe('ReferenceError');
      expect(portedError?.message).toBe(legacyError?.message);
    });

    it('mount getter returns the same value as the mesh getter (confirmed legacy quirk: both back onto _mesh)', () => {
      const legacy = newLegacy();
      const ported = newPorted();
      expect(ported.mount).toBe(legacy.mount);
      expect(ported.mount).toBe(ported.mesh);
    });
  });

  describe('mouse/wheel interaction handlers (never throw pre-init(), identically)', () => {
    it('accepts a full down/move/up/dblclick/wheel sequence without throwing on either side, before init() has ever run', () => {
      const legacy = newLegacy();
      const ported = newPorted();

      const down = { preventDefault: () => {}, clientX: 200, clientY: 200 };
      const move = { clientX: 150, clientY: 230 };
      const wheel = { wheelDeltaY: 120 };

      expect(() => {
        legacy.onDocumentMouseDown(down);
        legacy.onDocumentMouseMove(move);
        legacy.onDocumentMouseWheel(wheel);
        legacy.onDocumentMouseDbClick();
        legacy.onDocumentMouseUp();
      }).not.toThrow();

      expect(() => {
        ported.onDocumentMouseDown(down as unknown as MouseEvent);
        ported.onDocumentMouseMove(move as unknown as MouseEvent);
        ported.onDocumentMouseWheel(wheel as unknown as WheelEvent);
        ported.onDocumentMouseDbClick();
        ported.onDocumentMouseUp();
      }).not.toThrow();
    });

    it('accepts the wall-mount interaction path without throwing, identically', () => {
      const legacy = newLegacy();
      const ported = newPorted();
      legacy.mount = 'wall';
      ported.mount = 'wall' as never;

      const down = { preventDefault: () => {}, clientX: 0, clientY: 0 };
      const move = { clientX: -10000, clientY: -10000 };

      expect(() => {
        legacy.onDocumentMouseDown(down);
        legacy.onDocumentMouseMove(move);
      }).not.toThrow();
      expect(() => {
        ported.onDocumentMouseDown(down as unknown as MouseEvent);
        ported.onDocumentMouseMove(move as unknown as MouseEvent);
      }).not.toThrow();
    });
  });

  describe('fisheyeview setter', () => {
    it('accepts an on/off round-trip without throwing, identically, and reports the toggled value back', () => {
      const legacy = newLegacy();
      const ported = newPorted();

      expect(() => {
        legacy.fisheyeview = true;
        legacy.fisheyeview = false;
      }).not.toThrow();
      expect(() => {
        ported.fisheyeview = true;
        ported.fisheyeview = false;
      }).not.toThrow();

      expect(ported.fisheyeview).toBe(legacy.fisheyeview);
      expect(ported.fisheyeview).toBe(false);
    });
  });
});
