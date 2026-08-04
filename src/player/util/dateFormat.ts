function pad2(n: number): string {
  return (n < 10 ? '0' : '') + n;
}

/**
 * Ported from the legacy player’s Util/util's `Date.prototype.YYYYMMDDHHMMSS`
 * (~line 1124) — a main-thread-only Date prototype patch, ported as a
 * standalone function taking an explicit `date` argument instead (no global
 * prototype pollution). Formats in the LOCAL timezone with no GMT/offset
 * correction — distinct from `Worker/Backup/backupWorker`'s own
 * same-named prototype patch (ported separately as `worker/backup/
 * BackupSession.ts`'s private `formatYYYYMMDDHHMMSS`, which DOES apply a GMT
 * offset correction) — the two are independent per-realm monkeypatches with
 * genuinely different bodies, not the same function loaded twice.
 */
export function toYYYYMMDDHHMMSS(date: Date): string {
  return String(date.getFullYear()) + pad2(date.getMonth() + 1) + pad2(date.getDate()) + pad2(date.getHours()) + pad2(date.getMinutes()) + pad2(date.getSeconds());
}
