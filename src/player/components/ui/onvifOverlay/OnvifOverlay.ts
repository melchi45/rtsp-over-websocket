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

  /** One `<div class="onvif-overlay-box">`/`<div class="onvif-overlay-label">`
   *  pair per pool slot, index-aligned with `frame.objects` on the most
   *  recent `render()` call that actually drew something. Real problem,
   *  found live via a benchmark (see `docs/player/10-onvif-metadata-overlay.md`'s
   *  History): the original implementation did a full `removeChild` sweep
   *  plus fresh `createElement`/`appendChild` for every object on *every*
   *  `render()` call, i.e. on every single metadata frame -- real ONVIF
   *  analytics streams can send one of those per video frame while an event
   *  is active, so this was continuous DOM churn directly competing with
   *  video decode/paint on the same main thread, not an occasional cost.
   *  Reusing the same nodes across consecutive frames with the same object
   *  count (the common case for a tracked object) turns that into plain
   *  style-property writes on already-attached elements. This does NOT
   *  reintroduce cross-frame object tracking -- see `renderObject()`'s own
   *  comment -- every property on every pooled node is still fully
   *  recomputed from scratch each `render()` call; only the DOM node
   *  *objects themselves* are recycled. */
  private readonly boxPool: HTMLDivElement[] = [];
  private readonly labelPool: HTMLDivElement[] = [];

  /** The user's own ON/OFF preference (the "ONVIF Event" switch), independent
   *  of `suppressedByControls` below -- see `setVisible()`/`setSuppressed()`. */
  private visible = false;
  /** True while the native `<video controls>` bar is showing. This container
   *  is `position: absolute`, so -- same as `RTSPOverWebSocket`'s own
   *  `videoContainerElement` (see `applyVideoContainerVisibility()`'s doc
   *  comment) -- it paints above the video's native controls (including the
   *  overflow "more options" popup) regardless of DOM order or its own
   *  `pointer-events: none`, whenever it isn't `hidden`. Forcing it hidden
   *  while controls are showing, regardless of the user's own switch state,
   *  keeps that popup from being visually swallowed; `setVisible()` isn't
   *  touched by this so the user's preference is restored the moment
   *  controls are turned back off. */
  private suppressedByControls = false;

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

  /** If `frame` is null/empty (or intrinsic size isn't known yet), fully
   *  clears the pool -- matches the pre-pooling behavior other code (and
   *  `OnvifOverlay.test.ts`) already relies on: nothing stays in the DOM
   *  once there's nothing to draw. Otherwise resizes the pool to exactly
   *  `frame.objects.length` (creating/removing the delta only, not
   *  everything) and rewrites every pooled node's content/position/
   *  visibility from scratch -- still a full per-frame refresh (DESIGN.md
   *  §2.7's "Object lifecycle": no cross-frame interpolation/staleness
   *  tracking), just without discarding and recreating the DOM nodes
   *  themselves when the object count doesn't change frame-to-frame. */
  render(input: OnvifOverlayRenderInput): void {
    const frame = input.frame;
    const objects = frame !== null ? frame.objects : [];
    const canDraw = objects.length > 0 && input.videoIntrinsicSize.width > 0 && input.videoIntrinsicSize.height > 0;

    if (!canDraw) {
      this.resizePool(0);
      return;
    }

    this.resizePool(objects.length);
    const rendered = this.computeRenderedRect(input.videoIntrinsicSize, input.containerSize);
    objects.forEach((object, index) => this.renderObject(object, rendered, index));
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.applyHidden();
  }

  /** See `suppressedByControls`'s own doc comment above. Called from
   *  `RTSPOverWebSocket.applyVideoContainerVisibility()`, alongside its
   *  existing `videoContainerElement` handling, every time `controls` is
   *  toggled. */
  setSuppressed(suppressed: boolean): void {
    this.suppressedByControls = suppressed;
    this.applyHidden();
  }

  private applyHidden(): void {
    this.container.hidden = !this.visible || this.suppressedByControls;
  }

  destroy(): void {
    this.container.parentElement?.removeChild(this.container);
  }

  /** Grows or shrinks `boxPool`/`labelPool` to exactly `count` pairs,
   *  appending newly-created pairs or `remove()`-ing the excess -- never
   *  touches slots that stay within the new size, which is what makes a
   *  steady object count across frames free of DOM creation/removal. Static
   *  per-node styling (position/box-sizing/pointer-events/font/etc.) is set
   *  once here, at creation time, not re-applied every `render()`. */
  private resizePool(count: number): void {
    while (this.boxPool.length < count) {
      const box = document.createElement('div');
      box.setAttribute('class', 'onvif-overlay-box');
      box.style.cssText = 'position:absolute;box-sizing:border-box;pointer-events:none;';
      this.container.appendChild(box);
      this.boxPool.push(box);

      const label = document.createElement('div');
      label.setAttribute('class', 'onvif-overlay-label');
      label.style.cssText =
        'position:absolute;transform:translateY(-100%);color:#FFFFFF;font-family:sans-serif;' +
        'font-size:12px;padding:2px 4px;white-space:nowrap;pointer-events:none;';
      this.container.appendChild(label);
      this.labelPool.push(label);
    }
    while (this.boxPool.length > count) {
      this.boxPool.pop()?.remove();
      this.labelPool.pop()?.remove();
    }
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

  /** Writes object `index`'s pooled box/label pair (`resizePool()` already
   *  guarantees both exist) from scratch -- still a full per-object refresh,
   *  same as the pre-pooling version, just onto a recycled node instead of a
   *  freshly created one. Uses individual style-property assignment rather
   *  than replacing `style.cssText` wholesale, since the latter would blow
   *  away the static properties `resizePool()` set once at creation. */
  private renderObject(object: OnvifAnalyticsObject, rendered: RenderedRect, index: number): void {
    const box = this.boxPool[index];
    const label = this.labelPool[index];

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

      // box-sizing: border-box (set once in resizePool()) keeps the border
      // inside width/height instead of growing the box past the mapped
      // coordinates.
      box.style.display = '';
      box.style.left = `${x}px`;
      box.style.top = `${y}px`;
      box.style.width = `${width}px`;
      box.style.height = `${height}px`;
      box.style.border = `2px solid ${color}`;

      // REQ-PLY-113: label sits at the bounding box's top edge.
      labelX = x;
      labelY = y;
    } else if (object.centerOfGravity !== undefined) {
      box.style.display = 'none';
      const center = this.mapPoint(object.centerOfGravity.x, object.centerOfGravity.y, rendered);
      labelX = center.x;
      labelY = center.y;
    } else {
      // Nothing positional to draw against -- skip this object's label
      // entirely rather than guessing a location.
      box.style.display = 'none';
      label.style.display = 'none';
      return;
    }

    // translateY(-100%) (set once in resizePool()) sits the label just above
    // the anchor point (box top edge / center) regardless of its actual
    // rendered size -- a div's width/height auto-sizes to its text content.
    label.style.display = '';
    label.style.left = `${labelX}px`;
    label.style.top = `${labelY}px`;
    label.style.background = color;
    label.textContent = labelText;
  }
}
