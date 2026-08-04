/**
 * Ported from the legacy player’s Util/util (Uint8Array.prototype.indexOfMulti,
 * ~line 1823). The legacy version monkey-patches Uint8Array.prototype; this
 * port is a plain function instead (no global prototype mutation).
 */
export function indexOfMulti(data: Uint8Array, searchElements: number[], fromIndex = 0): number {
  const index = Array.prototype.indexOf.call(data, searchElements[0], fromIndex);
  if (searchElements.length === 1 || index === -1) {
    return index;
  }

  let i = index;
  let j = 0;
  for (; j < searchElements.length && i < data.length; i++, j++) {
    if (data[i] !== searchElements[j]) {
      return indexOfMulti(data, searchElements, index + 1);
    }
  }

  return i === index + searchElements.length ? index : -1;
}
