import type { OnvifAnalyticsObject, OnvifVideoAnalyticsFrame } from '../../../util/onvifMetadata';
import { getOnvifEventColor } from './onvifEventColors';

export interface OnvifOverlaySize {
  width: number;
  height: number;
}

export interface OnvifOverlayRenderInput {
  frame: OnvifVideoAnalyticsFrame | null;
  /** The video's own intrinsic (decoded) pixel resolution -- what
   *  `onRTSPOverWebSocketResize` already tracks as `videoWidth`/`videoHeight`. */
  videoIntrinsicSize: OnvifOverlaySize;
  /** The element's own rendered CSS box (what the video/canvas element is
   *  actually laid out at, e.g. `clientWidth`/`clientHeight`) -- NOT
   *  necessarily the same aspect ratio as `videoIntrinsicSize` once
   *  `object-fit: contain` letterboxes/pillarboxes it. */
  containerSize: OnvifOverlaySize;
}

interface RenderedRect {
  offsetX: number;
  offsetY: number;
  scale: number;
}

/**
 * Mounts an absolutely-positioned `<div>` overlay on top of the video/canvas
 * element and draws ONVIF `VideoAnalytics` bounding boxes/labels onto it as
 * plain positioned `<div>`s (a bordered box `<div>` plus a label `<div>` per
 * object) -- not SVG. See `docs/player/10-onvif-metadata-overlay.md` for the
 * full reference and `docs/DESIGN.md` §2.7 for the coordinate-mapping
 * algorithm.
 */
export class OnvifOverlay {
  private readonly container: HTMLDivElement;

  constructor(hostElement: HTMLElement) {
    this.container = document.createElement('div');
    this.container.setAttribute('class', 'onvif-overlay');
    // pointer-events: none is load-bearing -- this overlay fully covers the
    // video/canvas element underneath it; without this, it would swallow
    // clicks meant to open the context menu.
    this.container.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
    this.container.hidden = true;
    hostElement.appendChild(this.container);
  }

  /** Clears any previously-drawn objects and, if `frame` is non-null and
   *  has at least one object, draws the new frame's objects -- each
   *  `render()` call is a full refresh, no cross-frame object tracking
   *  (see DESIGN.md §2.7's "Object lifecycle"). */
  render(input: OnvifOverlayRenderInput): void {
    while (this.container.firstChild) {
      this.container.removeChild(this.container.firstChild);
    }

    const frame = input.frame;
    if (frame === null || frame.objects.length === 0) {
      return;
    }
    if (input.videoIntrinsicSize.width <= 0 || input.videoIntrinsicSize.height <= 0) {
      return;
    }

    const rendered = this.computeRenderedRect(input.videoIntrinsicSize, input.containerSize);
    for (const object of frame.objects) {
      this.renderObject(object, rendered);
    }
  }

  setVisible(visible: boolean): void {
    this.container.hidden = !visible;
  }

  destroy(): void {
    this.container.parentElement?.removeChild(this.container);
  }

  /** `object-fit: contain`'s own containment math, computed here (not read
   *  back from the DOM) since this overlay is a sibling element, not a
   *  child, of the video/canvas element it's matching. */
  private computeRenderedRect(intrinsicSize: OnvifOverlaySize, containerSize: OnvifOverlaySize): RenderedRect {
    if (containerSize.width <= 0 || containerSize.height <= 0) {
      return { offsetX: 0, offsetY: 0, scale: 0 };
    }
    const scale = Math.min(containerSize.width / intrinsicSize.width, containerSize.height / intrinsicSize.height);
    const renderedWidth = intrinsicSize.width * scale;
    const renderedHeight = intrinsicSize.height * scale;
    return {
      offsetX: (containerSize.width - renderedWidth) / 2,
      offsetY: (containerSize.height - renderedHeight) / 2,
      scale
    };
  }

  private mapPoint(px: number, py: number, rendered: RenderedRect): { x: number; y: number } {
    return { x: rendered.offsetX + px * rendered.scale, y: rendered.offsetY + py * rendered.scale };
  }

  private renderObject(object: OnvifAnalyticsObject, rendered: RenderedRect): void {
    const bestCandidate = object.classCandidates.reduce<(typeof object.classCandidates)[number] | undefined>(
      (best, candidate) => (best === undefined || candidate.likelihood > best.likelihood ? candidate : best),
      undefined
    );
    const color = getOnvifEventColor(bestCandidate?.type ?? '');
    const labelText = bestCandidate
      ? `#${object.objectId} ${bestCandidate.type} ${(bestCandidate.likelihood * 100).toFixed(0)}%`
      : `#${object.objectId}`;

    let labelX: number;
    let labelY: number;

    if (object.boundingBox !== undefined) {
      const topLeft = this.mapPoint(object.boundingBox.left, object.boundingBox.top, rendered);
      const bottomRight = this.mapPoint(object.boundingBox.right, object.boundingBox.bottom, rendered);
      const x = Math.min(topLeft.x, bottomRight.x);
      const y = Math.min(topLeft.y, bottomRight.y);
      const width = Math.abs(bottomRight.x - topLeft.x);
      const height = Math.abs(bottomRight.y - topLeft.y);

      const box = document.createElement('div');
      box.setAttribute('class', 'onvif-overlay-box');
      // box-sizing: border-box keeps the border inside width/height instead
      // of growing the box past the mapped coordinates.
      box.style.cssText =
        `position:absolute;left:${x}px;top:${y}px;width:${width}px;height:${height}px;` +
        `border:2px solid ${color};box-sizing:border-box;pointer-events:none;`;
      this.container.appendChild(box);

      // REQ-PLY-113: label sits at the bounding box's top edge.
      labelX = x;
      labelY = y;
    } else if (object.centerOfGravity !== undefined) {
      const center = this.mapPoint(object.centerOfGravity.x, object.centerOfGravity.y, rendered);
      labelX = center.x;
      labelY = center.y;
    } else {
      // Nothing positional to draw against -- skip this object's label
      // entirely rather than guessing a location.
      return;
    }

    this.renderLabel(labelText, labelX, labelY, color);
  }

  private renderLabel(text: string, x: number, y: number, color: string): void {
    const label = document.createElement('div');
    label.setAttribute('class', 'onvif-overlay-label');
    // translateY(-100%) sits the label just above the anchor point (box top
    // edge / center) regardless of its actual rendered size -- a div's
    // width/height auto-sizes to its text content, unlike an SVG <rect>
    // which needed a hand-measured width/height computed up front.
    label.style.cssText =
      `position:absolute;left:${x}px;top:${y}px;transform:translateY(-100%);` +
      `background:${color};color:#FFFFFF;font-family:sans-serif;font-size:12px;` +
      'padding:2px 4px;white-space:nowrap;pointer-events:none;';
    label.textContent = text;
    this.container.appendChild(label);
  }
}
