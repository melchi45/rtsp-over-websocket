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

function sleep(ms) {
  execSync(`sleep ${ms / 1000}`);
}

const pids = Array.from(new Set([...pidsListeningOn(HTTP_PORT), ...pidsListeningOn(HTTPS_PORT)]));

if (pids.length === 0) {
  console.log(`[stop-server] nothing listening on ${HTTP_PORT}/${HTTPS_PORT}`);
  process.exit(0);
}

for (const pid of pids) {
  try {
    process.kill(Number(pid), 'SIGTERM');
  } catch {
    // already gone
  }
}
console.log(`[stop-server] sent SIGTERM to pid(s) ${pids.join(', ')} (ports ${HTTP_PORT}/${HTTPS_PORT}) — waiting for the port(s) to free up...`);

// SIGTERM only requests shutdown — index.ts's handler still has to run
// stopAllTranscodes() (killing any live ffmpeg/yt-dlp children) before the
// port is actually released. Chained npm scripts (`stop-server.js && ...
// node dist/server/index.js`) would otherwise race the old process and hit
// EADDRINUSE on the new one, which is exactly the "previous server still up"
// scenario this script exists to clean up after a failed Ctrl+C.
const deadline = Date.now() + 5000;
let stillListening = pids;
while (Date.now() < deadline) {
  stillListening = Array.from(new Set([...pidsListeningOn(HTTP_PORT), ...pidsListeningOn(HTTPS_PORT)]));
  if (stillListening.length === 0) break;
  sleep(200);
}

if (stillListening.length > 0) {
  console.log(`[stop-server] pid(s) ${stillListening.join(', ')} didn't exit in time — sending SIGKILL`);
  for (const pid of stillListening) {
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {
      // already gone
    }
  }
  sleep(200);
}

console.log(`[stop-server] stopped pid(s) ${pids.join(', ')} (ports ${HTTP_PORT}/${HTTPS_PORT})`);
