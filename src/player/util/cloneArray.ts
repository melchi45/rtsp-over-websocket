/**
 * Ported from the legacy player’s Util/util (window.cloneArray, ~line 1438).
 * Legacy's implementation is generically typed-array-agnostic, but the only
 * real caller anywhere in the codebase (mediaRouter's backup-data path)
 * always passes a `Uint8Array` (`streamData.frameData`) — narrowed to that
 * concrete type rather than keeping a generic signature that TS's lib types
 * can't actually satisfy (a TypedArray's `.constructor` is typed as plain
 * `Function`, not a specific `new (buffer) => T`, so a generic constraint
 * bound to it is never satisfiable at real call sites).
 */
export function cloneArray(array: Uint8Array): Uint8Array {
  const bo = array.byteOffset;
  const n = array.length;
  return new Uint8Array((array.buffer as ArrayBuffer).slice(bo, bo + n));
}
