// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { OnvifOverlay } from './OnvifOverlay';
import type { OnvifVideoAnalyticsFrame } from '../../../util/onvifMetadata';

function makeFrame(overrides: Partial<OnvifVideoAnalyticsFrame> = {}): OnvifVideoAnalyticsFrame {
  return {
    utcTime: '2026-09-04T00:00:00.000Z',
    objects: [
      {
        objectId: '0',
        boundingBox: { left: 0, top: 0, right: 1920, bottom: 1080 },
        classCandidates: [{ type: 'Human', likelihood: 0.9 }]
      }
    ],
    ...overrides
  };
}

describe('OnvifOverlay', () => {
  it('mounts a hidden <div class="onvif-overlay"> as a child of the host element', () => {
    const host = document.createElement('div');
    new OnvifOverlay(host);

    const overlay = host.querySelector('div.onvif-overlay') as HTMLDivElement;
    expect(overlay).not.toBeNull();
    expect(overlay.hidden).toBe(true);
  });

  it('maps a full-frame bounding box 1:1 when container matches intrinsic size exactly (no letterbox)', () => {
    const host = document.createElement('div');
    const overlay = new OnvifOverlay(host);

    overlay.render({
      frame: makeFrame(),
      videoIntrinsicSize: { width: 1920, height: 1080 },
      containerSize: { width: 1920, height: 1080 }
    });

    const box = host.querySelector('div.onvif-overlay-box') as HTMLDivElement;
    expect(box).not.toBeNull();
    expect(box.style.left).toBe('0px');
    expect(box.style.top).toBe('0px');
    expect(box.style.width).toBe('1920px');
    expect(box.style.height).toBe('1080px');
  });

  it('accounts for pillarboxing when the container is wider than the video aspect ratio', () => {
    const host = document.createElement('div');
    const overlay = new OnvifOverlay(host);

    // 1920x1080 (16:9) video in an 800x800 (1:1) box: object-fit: contain
    // scales by min(800/1920, 800/1080) = 0.4167, rendered 800x450,
    // vertically centered -> offsetX=0, offsetY=175.
    overlay.render({
      frame: makeFrame({
        objects: [
          {
            objectId: '0',
            boundingBox: { left: 960, top: 540, right: 1920, bottom: 1080 }, // bottom-right quadrant
            classCandidates: []
          }
        ]
      }),
      videoIntrinsicSize: { width: 1920, height: 1080 },
      containerSize: { width: 800, height: 800 }
    });

    const scale = Math.min(800 / 1920, 800 / 1080);
    const offsetY = (800 - 1080 * scale) / 2;

    const box = host.querySelector('div.onvif-overlay-box') as HTMLDivElement;
    expect(parseFloat(box.style.left)).toBeCloseTo(960 * scale, 5);
    expect(parseFloat(box.style.top)).toBeCloseTo(540 * scale + offsetY, 5);
    expect(parseFloat(box.style.width)).toBeCloseTo((1920 - 960) * scale, 5);
    expect(parseFloat(box.style.height)).toBeCloseTo((1080 - 540) * scale, 5);
  });

  it('colors the box by the highest-likelihood class candidate', () => {
    const host = document.createElement('div');
    const overlay = new OnvifOverlay(host);

    overlay.render({
      frame: makeFrame({
        objects: [
          {
            objectId: '0',
            boundingBox: { left: 0, top: 0, right: 100, bottom: 100 },
            classCandidates: [
              { type: 'Other', likelihood: 0.2 },
              { type: 'Vehicle', likelihood: 0.8 }
            ]
          }
        ]
      }),
      videoIntrinsicSize: { width: 100, height: 100 },
      containerSize: { width: 100, height: 100 }
    });

    const box = host.querySelector('div.onvif-overlay-box') as HTMLDivElement;
    expect(box.style.borderColor).toBe('rgb(59, 130, 246)'); // Vehicle's color, #3B82F6

    const label = host.querySelector('div.onvif-overlay-label') as HTMLDivElement;
    expect(label.textContent).toContain('Vehicle');
    expect(label.textContent).toContain('80%');
  });

  it('clears all previously-drawn objects on the next render()', () => {
    const host = document.createElement('div');
    const overlay = new OnvifOverlay(host);
    const size = { width: 100, height: 100 };

    overlay.render({ frame: makeFrame(), videoIntrinsicSize: size, containerSize: size });
    expect(host.querySelectorAll('div.onvif-overlay-box')).toHaveLength(1);

    overlay.render({ frame: null, videoIntrinsicSize: size, containerSize: size });
    expect(host.querySelectorAll('div.onvif-overlay-box')).toHaveLength(0);
  });

  it('setVisible toggles the hidden property without clearing content', () => {
    const host = document.createElement('div');
    const overlay = new OnvifOverlay(host);
    const size = { width: 100, height: 100 };
    overlay.render({ frame: makeFrame(), videoIntrinsicSize: size, containerSize: size });

    overlay.setVisible(true);
    const div = host.querySelector('div.onvif-overlay') as HTMLDivElement;
    expect(div.hidden).toBe(false);
    expect(host.querySelectorAll('div.onvif-overlay-box')).toHaveLength(1);

    overlay.setVisible(false);
    expect(div.hidden).toBe(true);
    expect(host.querySelectorAll('div.onvif-overlay-box')).toHaveLength(1);
  });

  it('destroy() removes the overlay <div> from the host', () => {
    const host = document.createElement('div');
    const overlay = new OnvifOverlay(host);

    overlay.destroy();

    expect(host.querySelector('div.onvif-overlay')).toBeNull();
  });
});
