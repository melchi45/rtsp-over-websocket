/** Ported from the legacy player’s Util/util.js (window.IntervalTimer, ~line 1040). */
export class IntervalTimer {
  private timerId?: ReturnType<typeof setInterval>;
  private startTime = 0;
  private remaining = 0;
  private state: 0 | 1 | 2 | 3 = 0; // 0 idle, 1 running, 2 paused, 3 resumed

  constructor(
    private readonly callback: () => void,
    private readonly interval: number
  ) {
    this.startTime = Date.now();
    this.timerId = setInterval(this.callback, this.interval);
    this.state = 1;
  }

  pause(): void {
    if (this.state !== 1) return;
    this.remaining = this.interval - (Date.now() - this.startTime);
    clearInterval(this.timerId);
    this.state = 2;
  }

  resume(): void {
    if (this.state !== 2) return;
    this.state = 3;
    setTimeout(() => this.timeoutCallback(), this.remaining);
  }

  private timeoutCallback(): void {
    if (this.state !== 3) return;
    this.callback();
    this.startTime = Date.now();
    this.timerId = setInterval(this.callback, this.interval);
    this.state = 1;
  }
}
