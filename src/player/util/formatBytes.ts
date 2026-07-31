/** Ported from the legacy player’s Util/util.js (window.formatBytes). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' Bytes';
  else if (bytes < 1048576) return (bytes / 1024).toFixed(3) + ' KB';
  else if (bytes < 1073741824) return (bytes / 1048576).toFixed(3) + ' MB';
  else return (bytes / 1073741824).toFixed(3) + ' GB';
}

/** Ported from the legacy player’s Util/util.js (window.formatBps). */
export function formatBps(bits: number): string {
  if (bits < 1024) return bits + ' bps';
  else if (bits < 1048576) return (bits / 1024).toFixed(3) + ' Kbps';
  else if (bits < 1073741824) return (bits / 1048576).toFixed(3) + ' Mbps';
  else return (bits / 1073741824).toFixed(3) + ' Gbps';
}
