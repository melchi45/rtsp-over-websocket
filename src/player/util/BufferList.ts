/**
 * Ported from the legacy player’s Util/util.js (BufferNode/BufferList, ~line 1450).
 * Only the members actually consumed elsewhere in the ported codebase so far
 * (push/pop/clear/getCurIdx) are included — pushPop/searchNodeAt/remove/
 * removeTillCurrent are unused by any file ported so far and can be added
 * when a consumer needs them.
 */
export class BufferNode<T> {
  next: BufferNode<T> | null = null;
  previous: BufferNode<T> | null = null;

  constructor(public buffer: T | null) {}
}

export class BufferList<T> {
  protected length = 0;
  head: BufferNode<T> | null = null;
  tail: BufferNode<T> | null = null;
  curIdx = 0;

  getCurIdx(): number {
    return this.curIdx;
  }

  push(buffer: T): BufferNode<T> {
    const node = new BufferNode(buffer);
    if (this.length > 0) {
      this.tail!.next = node;
      node.previous = this.tail;
      this.tail = node;
    } else {
      this.head = node;
      this.tail = node;
    }
    this.length += 1;
    return node;
  }

  pop(): BufferNode<T> | null {
    let node: BufferNode<T> | null = null;
    if (this.length > 1) {
      node = this.head;
      this.head = this.head!.next;
      if (this.head !== null) {
        this.head.previous = null;
      } else {
        this.tail = null;
      }
      this.length -= 1;
    }
    return node;
  }

  clear(): void {
    let node = this.head;
    while (node !== null) {
      const nodeToDelete: BufferNode<T> | null = node;
      node = node.next;
      nodeToDelete.buffer = null;
    }
    this.length = 0;
    this.head = null;
    this.tail = null;
    this.curIdx = 0;
  }
}
