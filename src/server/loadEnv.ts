import fs from 'node:fs';
import path from 'node:path';

/**
 * Minimal, dependency-free ".env" loader — a TS copy of scripts/loadEnv.js
 * kept separate because this runs inside the compiled server process (a
 * different module system than the plain CJS scripts/ helpers), not shared
 * code between them. KEY=VALUE per line, '#' comments and blank lines
 * skipped; real env vars already set always win over the file.
 *
 * Must be imported before ./config (and anything else that reads
 * process.env at module-load time) — see this file's only import site in
 * index.ts, which imports it first for exactly that reason.
 */
function loadEnv(envPath: string = path.resolve(__dirname, '../../.env')): void {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
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

loadEnv();
