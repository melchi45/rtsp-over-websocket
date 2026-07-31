import { describe, it, expect } from 'vitest';
import { loadLegacyModule } from '../test-support/loadLegacyModule';
import { CircularTypedArrayQueue } from './CircularTypedArrayQueue';

interface LegacyCircularQueue<T> {
  enQueue(record: T): void;
  push(record: T): void;
  insert(record: T): void;
  deQueue(): T | null;
  pop(): T | null;
  front(): T | null;
  peak(): T | null;
  isFull(): boolean;
  isEmpty(): boolean;
  getLength(): number;
  Clear(): void;
  toArray(): (T | null)[];
}

const LegacyCircularQueueCtor = loadLegacyModule<new (maxSize?: number, autodelete?: boolean) => LegacyCircularQueue<number>>(
  'Util/CircularTypedArrayQueue.js',
  'CircularTypedArrayQueue'
);

describe('CircularTypedArrayQueue parity with the legacy player’s Util/CircularTypedArrayQueue.js', () => {
  it('enQueue/deQueue/front/getLength match across a mixed sequence', () => {
    const legacy = new LegacyCircularQueueCtor(4);
    const ported = new CircularTypedArrayQueue<number>(4);

    [1, 2, 3].forEach((n) => {
      legacy.enQueue(n);
      ported.enQueue(n);
    });

    expect(ported.front()).toBe(legacy.front());
    expect(ported.getLength()).toBe(legacy.getLength());
    expect(ported.toArray()).toEqual(legacy.toArray());
    expect(ported.deQueue()).toBe(legacy.deQueue());
    expect(ported.front()).toBe(legacy.front());
  });

  it('autodelete evicts the oldest record instead of throwing when full', () => {
    const legacy = new LegacyCircularQueueCtor(2, true);
    const ported = new CircularTypedArrayQueue<number>(2, true);

    [1, 2, 3, 4].forEach((n) => {
      legacy.enQueue(n);
      ported.enQueue(n);
    });

    expect(ported.front()).toBe(legacy.front());
    expect(ported.isFull()).toBe(legacy.isFull());
  });

  it('throws the same error when full without autodelete', () => {
    const legacy = new LegacyCircularQueueCtor(1, false);
    const ported = new CircularTypedArrayQueue<number>(1, false);
    legacy.enQueue(1);
    ported.enQueue(1);
    expect(() => ported.enQueue(2)).toThrowError("Queue is full can't add new records");
    expect(() => legacy.enQueue(2)).toThrowError("Queue is full can't add new records");
  });

  it('push/insert/pop/peak aliases behave identically', () => {
    const legacy = new LegacyCircularQueueCtor(3);
    const ported = new CircularTypedArrayQueue<number>(3);
    legacy.push(10);
    ported.push(10);
    legacy.insert(20);
    ported.insert(20);
    expect(ported.peak()).toBe(legacy.peak());
    expect(ported.pop()).toBe(legacy.pop());
  });
});
