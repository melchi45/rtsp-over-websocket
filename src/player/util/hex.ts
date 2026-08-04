export function toHex(decimal: number): string {
  return '0x' + (decimal + 0x10000).toString(16).substr(-4).toUpperCase();
}

export function fromHex(hex: string): number {
  return parseInt(hex, 16);
}

export function decimalToHex(dec: number, padding = 2): string {
  let hex = Number(dec).toString(16);
  while (hex.length < padding) {
    hex = '0' + hex;
  }
  return hex;
}
