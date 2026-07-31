/** Ported from the legacy player’s Util/util.js (window.stringToUint8Array, ~line 901). */
export function stringToUint8Array(inputString: string): Uint8Array {
  const output = new Uint8Array(inputString.length);
  for (let i = 0; i < inputString.length; i++) {
    output[i] = inputString.charCodeAt(i);
  }
  return output;
}

/** Ported from the legacy player’s Util/util.js (window.uint8ArrayToString, ~line 912). */
export function uint8ArrayToString(byteData: ArrayLike<number>): string {
  return String.fromCharCode.apply(null, byteData as number[]);
}

/** Ported from the legacy player’s Util/util.js (window.Hex2Ascii, ~line 881). */
export function hex2Ascii(hex: string | number): string {
  const hexx = hex.toString();
  let str = '';
  for (let i = 0; i < hexx.length && hexx.substr(i, 2) !== '00'; i += 2) {
    str += String.fromCharCode(parseInt(hexx.substr(i, 2), 16));
  }
  return str;
}
