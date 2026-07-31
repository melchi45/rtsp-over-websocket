import { describe, it, expect } from 'vitest';
import { loadLegacyModule } from '../test-support/loadLegacyModule';
import { RTSPOverWebSocketMap } from './RTSPOverWebSocketMap';

interface LegacyMap {
  put(key: string, value: unknown): void;
  get(key: string): unknown;
  containsKey(key: string): boolean;
  containsValue(value: unknown): boolean;
  isEmpty(): boolean;
  clear(): void;
  remove(key: string): void;
  keys(): string[];
  values(): unknown[];
  size(): number;
}

const LegacyMap = loadLegacyModule<new () => LegacyMap>('Util/hashMap.js', 'RTSPOverWebSocketMap');

describe('RTSPOverWebSocketMap parity with the legacy player’s Util/hashMap.js', () => {
  it('put/get/size/keys/values match for the same operation sequence', () => {
    const legacy = new LegacyMap();
    const ported = new RTSPOverWebSocketMap<unknown>();

    legacy.put('a', 1);
    legacy.put('b', 'two');
    ported.put('a', 1);
    ported.put('b', 'two');

    expect(ported.size()).toBe(legacy.size());
    expect(ported.get('a')).toBe(legacy.get('a'));
    expect(ported.get('b')).toBe(legacy.get('b'));
    expect(ported.keys()).toEqual(legacy.keys());
    expect(ported.values()).toEqual(legacy.values());
    expect(ported.containsKey('a')).toBe(legacy.containsKey('a'));
    expect(ported.containsKey('missing')).toBe(legacy.containsKey('missing'));
  });

  it('preserves loose-equality containsValue semantics ("5" == 5)', () => {
    const legacy = new LegacyMap();
    const ported = new RTSPOverWebSocketMap<unknown>();
    legacy.put('a', '5');
    ported.put('a', '5');

    expect(ported.containsValue(5)).toBe(true);
    expect(ported.containsValue(5)).toBe(legacy.containsValue(5));
  });

  it('remove/clear/isEmpty match', () => {
    const legacy = new LegacyMap();
    const ported = new RTSPOverWebSocketMap<unknown>();
    legacy.put('a', 1);
    legacy.put('b', 2);
    ported.put('a', 1);
    ported.put('b', 2);

    legacy.remove('a');
    ported.remove('a');
    expect(ported.size()).toBe(legacy.size());
    expect(ported.isEmpty()).toBe(legacy.isEmpty());

    legacy.clear();
    ported.clear();
    expect(ported.isEmpty()).toBe(legacy.isEmpty());
    expect(ported.isEmpty()).toBe(true);
  });
});
