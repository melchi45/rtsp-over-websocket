export class RTSPOverWebSocketMap<V = unknown> {
  private map: Record<string, V> = {};

  put(key: string | number, value: V): void {
    this.map[key as string] = value;
  }

  get(key: string | number): V | undefined {
    return this.map[key as string];
  }

  containsKey(key: string | number): boolean {
    return (key as string) in this.map;
  }

  containsValue(value: V): boolean {
    for (const prop in this.map) {
      // Legacy loose-equality (`==`) semantics preserved intentionally — see hashMap.js.
      if (this.map[prop] == value) return true; // eslint-disable-line eqeqeq
    }
    return false;
  }

  isEmpty(): boolean {
    return this.size() === 0;
  }

  clear(): void {
    for (const prop in this.map) {
      delete this.map[prop];
    }
  }

  remove(key: string | number): void {
    delete this.map[key as string];
  }

  keys(): string[] {
    const keys: string[] = [];
    for (const prop in this.map) keys.push(prop);
    return keys;
  }

  values(): V[] {
    const values: V[] = [];
    for (const prop in this.map) values.push(this.map[prop]);
    return values;
  }

  size(): number {
    return Object.keys(this.map).length;
  }
}
