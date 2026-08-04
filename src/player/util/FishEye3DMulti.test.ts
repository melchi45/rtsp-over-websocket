import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three';
import { loadLegacyModule } from '../test-support/loadLegacyModule';
import { Fisheye3DMulti } from './FishEye3DMulti';

interface LegacyFisheye3DMulti {
  init(videoElement: unknown): void;
  onWindowResize(): void;
  onDocumentMouseDown(event: { preventDefault(): void; clientX: number; clientY: number }): void;
  onDocumentMouseMove(event: { clientX: number; clientY: number }): void;
  onDocumentMouseUp(event?: unknown): void;
  onDocumentMouseDbClick(event?: unknown): void;
  onDocumentMouseWheel(event: { wheelDeltaY?: number; wheelDelta?: number; detail?: number }): void;
}

const fakeDocument = { getElementById: () => null as unknown };

const LegacyFisheye3DMultiCtor = loadLegacyModule<new () => LegacyFisheye3DMulti>('Util/fishEye3D_multi.js', 'Fisheye3DMulti', {
  THREE,
  document: fakeDocument,
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

function newLegacy(): LegacyFisheye3DMulti {
  return new LegacyFisheye3DMultiCtor();
}

function newPorted(): Fisheye3DMulti {
  return new Fisheye3DMulti();
}

/**
 * NOTE on scope: same as FishEye3D.test.ts — `lon`/`lat`/`distance`/`fov`/
 * `camera`/etc. are closure-private in legacy, never exposed on the
 * instance, so the interactive/render state machine is only verifiable
 * through actual WebGL output (BROWSER/contract tier). This suite covers
 * the observable public contract only: `init()`'s early-return when its
 * fixed `#mi-full-camera` container is absent, the confirmed
 * `onWindowResize` ReferenceError bug, and that the interaction handlers
 * don't throw pre-init().
 */
describe('Fisheye3DMulti parity with the legacy player’s Util/fishEye3D_multi.js (observable public contract only — see NOTE above)', () => {
  beforeAll(() => {
    (globalThis as unknown as { document: unknown }).document = fakeDocument;
  });

  afterAll(() => {
    delete (globalThis as unknown as { document?: unknown }).document;
  });

  it('init() is a no-op (does not throw) when the #mi-full-camera container is absent, identically', () => {
    const legacy = newLegacy();
    const ported = newPorted();
    expect(() => legacy.init({ videoWidth: 100, videoHeight: 100 })).not.toThrow();
    expect(() => ported.init({ videoWidth: 100, videoHeight: 100, width: 100, height: 100 } as never)).not.toThrow();
  });

  it('onWindowResize throws the same ReferenceError identically (confirmed legacy bug: `container` is out of scope there)', () => {
    const legacy = newLegacy();
    const ported = newPorted();
    let legacyError: Error | null = null;
    let portedError: Error | null = null;
    try {
      legacy.onWindowResize();
    } catch (e) {
      legacyError = e as Error;
    }
    try {
      ported.onWindowResize();
    } catch (e) {
      portedError = e as Error;
    }
    expect(portedError?.constructor.name).toBe(legacyError?.constructor.name);
    expect(portedError?.constructor.name).toBe('ReferenceError');
    expect(portedError?.message).toBe(legacyError?.message);
  });

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
});
