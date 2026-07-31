/** Ported from the legacy player’s Util/util.js (window.fastJsonStringfy, ~line 815). */
export function fastJsonStringfy(obj: unknown): string {
  const cache: unknown[] = [];
  const data = JSON.stringify(obj, (_key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (cache.indexOf(value) !== -1) {
        return undefined;
      }
      cache.push(value);
    }
    return value;
  });
  return data ?? '';
}
