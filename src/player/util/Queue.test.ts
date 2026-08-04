import { describe, it, expect } from 'vitest';
import { loadLegacyModule } from '../test-support/loadLegacyModule';
import { createNoopLoggerGlobal } from '../test-support/legacyGlobals';
import { Queue } from './Queue';

interface LegacyQueue<T> {
  getLength(): number;
  isEmpty(): boolean;
  isFull(): boolean;
  enqueue(item: T): void;
  dequeue(): T;
  peek(): T | undefined;
}

// Util/Queue.js calls `window.log.getLogger()` at construction time (dead code —
// the returned logger is never used), so the legacy sandbox needs a stub.
const LegacyQueueCtor = loadLegacyModule<new (maxSize?: number) => LegacyQueue<number>>('Util/Queue.js', 'Queue', {
  log: createNoopLoggerGlobal()
});

describe('Queue parity with the legacy player’s Util/Queue.js', () => {
  it('enqueue/dequeue/peek/getLength match across a mixed sequence', () => {
    const legacy = new LegacyQueueCtor();
    const ported = new Queue<number>();

    [1, 2, 3, 4, 5].forEach((n) => {
      legacy.enqueue(n);
      ported.enqueue(n);
    });

    expect(ported.getLength()).toBe(legacy.getLength());
    expect(ported.peek()).toBe(legacy.peek());
    expect(ported.dequeue()).toBe(legacy.dequeue());
    expect(ported.dequeue()).toBe(legacy.dequeue());
    expect(ported.getLength()).toBe(legacy.getLength());

    ported.enqueue(6);
    legacy.enqueue(6);
    expect(ported.peek()).toBe(legacy.peek());
    expect(ported.getLength()).toBe(legacy.getLength());
  });

  it('throws the same error message on dequeue from empty', () => {
    const legacy = new LegacyQueueCtor();
    const ported = new Queue<number>();
    expect(() => ported.dequeue()).toThrowError("Can't remove element from an empty Queue");
    expect(() => legacy.dequeue()).toThrowError("Can't remove element from an empty Queue");
  });

  it('throws the same error message when enqueueing past maxSize', () => {
    const legacy = new LegacyQueueCtor(2);
    const ported = new Queue<number>(2);
    legacy.enqueue(1);
    legacy.enqueue(2);
    ported.enqueue(1);
    ported.enqueue(2);
    expect(() => ported.enqueue(3)).toThrowError("Queue is full can't add new records");
    expect(() => legacy.enqueue(3)).toThrowError("Queue is full can't add new records");
  });
});
