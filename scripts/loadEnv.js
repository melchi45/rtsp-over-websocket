#!/usr/bin/env node
// Minimal, dependency-free ".env" loader (KEY=VALUE per line, '#' comments
// and blank lines skipped) — good enough for local dev config, no need to
// pull in a package for this. Real env vars already set (shell `export`,
// or `FOO=bar npm run ...`) always win over the file, matching common
// dotenv convention. Required independently by every script in start:server*
// (stop-server.js, ensure-mediamtx.js) because each npm-script step runs as
// its own process — a `&&`-chained command doesn't inherit process.env
// mutations a previous step made in-process, only real exported env vars do.
'use strict';

const fs = require('fs');
const path = require('path');

function loadEnv(envPath) {
  const resolved = envPath || path.resolve(__dirname, '..', '.env');
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

module.exports = { loadEnv };
