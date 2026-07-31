/**
 * Ported from the legacy player’s Util/CircularTypedArrayQueue.js.
 *
 * Method names (enQueue/deQueue/peak/Clear) and `getLength()`'s naive
 * `this.queue.length` semantics (it does not subtract removed slots) are kept
 * as-is for behavioral parity — this is the actual public contract callers
 * throughout the codebase (videoPlayer.js, videoTagPlayer.js) rely on.
 */
export class CircularTypedArrayQueue<T = unknown> {
  static readonly MAX_SIZE = Math.pow(2, 53) - 1;

  maxSize: number;
  autodelete?: boolean;
  private items: (T | null)[] = [];
  private head = -1;
  private tail = -1;

  constructor(maxSize?: number, autodelete?: boolean) {
    this.maxSize = maxSize || CircularTypedArrayQueue.MAX_SIZE;
    this.autodelete = autodelete;
  }

  private reset(): void {
    this.tail = -1;
    this.head = -1;
  }

  private increment(value: number): number {
    return (value + 1) % this.maxSize;
  }

  setMaxSize(maxSize: number): void {
    this.maxSize = maxSize;
  }

  isFull(): boolean {
    return this.increment(this.tail) === this.head;
  }

  isEmpty(): boolean {
    return this.tail === -1 && this.head === -1;
  }

  enQueue(record: T): void {
    if (this.isFull()) {
      if (this.autodelete) {
        this.deQueue();
      } else {
        throw new Error("Queue is full can't add new records");
      }
    }
    if (this.isEmpty()) {
      this.head = this.increment(this.head);
    }
    this.tail = this.increment(this.tail);
    this.items[this.tail] = record;
  }

  push(record: T): void {
    this.enQueue(record);
  }

  insert(record: T): void {
    this.enQueue(record);
  }

  deQueue(): T | null {
    if (this.isEmpty()) {
      throw new Error("Can't remove element from an empty Queue");
    }
    const removedRecord = this.items[this.head];
    this.items[this.head] = null;
    if (this.tail === this.head) {
      this.reset();
    } else {
      this.head = this.increment(this.head);
    }
    return removedRecord;
  }

  pop(): T | null {
    return this.deQueue();
  }

  front(): T | null {
    return this.items[this.head] || null;
  }

  peak(): T | null {
    return this.front();
  }

  /** Deliberately mirrors the legacy naive implementation: total array length, not logical count. */
  getLength(): number {
    return this.items.length;
  }

  Clear(): void {
    if (this.isEmpty()) {
      throw new Error("Can't remove element from an empty Queue");
    }
    for (let i = this.head; i <= this.tail; i++) {
      this.items[i] = null;
    }
    this.items = [];
    this.reset();
  }

  toArray(): (T | null)[] {
    return this.items;
  }

  print(): void {
    for (let i = this.head; i <= this.tail; i++) {
      console.log(this.items[i]);
    }
  }
}
