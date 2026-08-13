import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Minimal, dependency-free ".env" loader — a copy of scripts/loadEnv.js /
 * src/server/loadEnv.ts kept separate because this runs under vitest inside
 * src/player, a different build target (ESNext module output, no native
 * `__dirname`) than either of those. KEY=VALUE per line, '#' comments and
 * blank lines skipped; real env vars already set always win over the file.
 *
 * Exported (not a self-executing side effect like src/server/loadEnv.ts) so
 * callers — currently just SunapiManager.live.test.ts — decide when to load
 * it, rather than every module that happens to import this one paying for
 * a file read.
 */
export function loadEnv(envPath?: string): void {
  const resolved = envPath ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../.env');
  if (!fs.existsSync(resolved)) return;
  const lines = fs.readFileSync(resolved, 'utf8').split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
