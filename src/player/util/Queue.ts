export class Queue<T = unknown> {
  private static readonly DEFAULT_MAX_SIZE = Math.pow(2, 53) - 1;

  private readonly maxSize: number;
  private items: T[] = [];
  private offset = 0;

  constructor(maxSize?: number) {
    this.maxSize = maxSize || Queue.DEFAULT_MAX_SIZE;
  }

  getLength(): number {
    return this.items.length - this.offset;
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  isFull(): boolean {
    return this.items.length - this.offset >= this.maxSize;
  }

  enqueue(item: T): void {
    if (this.isFull()) {
      throw new Error("Queue is full can't add new records");
    }
    this.items.push(item);
  }

  dequeue(): T {
    if (this.isEmpty()) {
      throw new Error("Can't remove element from an empty Queue");
    }
    const item = this.items[this.offset];
    this.offset += 1;
    if (this.offset * 2 >= this.items.length) {
      this.items = this.items.slice(this.offset);
      this.offset = 0;
    }
    return item;
  }

  peek(): T | undefined {
    return this.items.length > 0 ? this.items[this.offset] : undefined;
  }

  print(): void {
    console.log(`Queue Length: ${this.getLength()}\r\n`);
    for (let i = this.offset; i < this.items.length; i++) {
      console.log(this.items[i]);
    }
  }
}
