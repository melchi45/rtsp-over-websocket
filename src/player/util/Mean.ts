/**
 * Ported from the legacy player’s Util/util (window.Mean, ~line 1019).
 * Simple running-average tracker used by videoTagPlayer's statistics.
 * `mean()` returns a *string* (`.toFixed(3)`) once at least one value has
 * been recorded, or the number `0` before that — a real mixed-type return
 * preserved as-is (callers already do `isNaN(x.mean())` checks that work
 * against both).
 */
export class Mean {
  count = 0;
  sum = 0;

  record(val: number): void {
    this.count++;
    this.sum += val;
  }

  variance(val: number): number {
    return Math.pow(val - Number(this.mean()), 2);
  }

  mean(): string | number {
    return this.count ? (this.sum / this.count).toFixed(3) : 0;
  }
}
