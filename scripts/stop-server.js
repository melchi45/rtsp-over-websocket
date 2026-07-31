#!/usr/bin/env node
// Stops whatever src/server (npm run start:server) left listening on its
// REST/ws(s) ports — same RTSP_WS_HTTP_PORT/RTSP_WS_HTTPS_PORT env vars as
// src/server/config.ts, so this targets the right ports even if they were
// overridden at start time.
'use strict';

const { execSync } = require('child_process');

const HTTP_PORT = Number(process.env.RTSP_WS_HTTP_PORT) || 4000;
const HTTPS_PORT = Number(process.env.RTSP_WS_HTTPS_PORT) || 4001;

function pidsListeningOn(port) {
  try {
    const out = execSync(`lsof -ti:${port} -sTCP:LISTEN`, { encoding: 'utf8' });
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return []; // lsof exits non-zero when nothing matches that port
  }
}

const pids = Array.from(new Set([...pidsListeningOn(HTTP_PORT), ...pidsListeningOn(HTTPS_PORT)]));

if (pids.length === 0) {
  console.log(`[stop-server] nothing listening on ${HTTP_PORT}/${HTTPS_PORT}`);
  process.exit(0);
}

for (const pid of pids) {
  process.kill(Number(pid), 'SIGTERM');
}
console.log(`[stop-server] stopped pid(s) ${pids.join(', ')} (ports ${HTTP_PORT}/${HTTPS_PORT})`);
