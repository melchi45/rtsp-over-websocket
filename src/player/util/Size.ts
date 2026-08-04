/**
 * Ported from the legacy player’s Util/util (window.Size, ~line 1279).
 *
 * Legacy's `Size` is written as a factory function that assigns
 * width/height/viewWidth/viewHeight onto a *freshly declared, per-call*
 * `Constructor.prototype` object rather than `this` — an unusual style, but
 * since exactly one `new Constructor(...)` is ever created per `Size(...)`
 * call (a fresh `Constructor` is declared inside the factory body every
 * time), no state is actually shared across different `Size` instances.
 * Behaviorally this is equivalent to a plain constructor, so it's ported as
 * a normal class.
 */
export class Size {
  w: number;
  h: number;
  viewWidth?: number;
  viewHeight?: number;

  constructor(width: number, height: number, viewWidth?: number, viewHeight?: number) {
    this.w = width;
    this.h = height;
    if (viewWidth !== undefined) {
      this.viewWidth = viewWidth;
    }
    if (viewHeight !== undefined) {
      this.viewHeight = viewHeight;
    }
  }

  toString(): string {
    return `(${this.w}, ${this.h})`;
  }

  getHalfSize(): Size {
    return new Size(this.w >>> 1, this.h >>> 1);
  }

  length(): number {
    return this.w * this.h;
  }
}
