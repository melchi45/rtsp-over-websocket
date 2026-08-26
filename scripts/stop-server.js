#!/usr/bin/env node
// Stops whatever src/server (npm run start:server) left listening on its
// REST/ws(s) ports — same RTSP_WS_HTTP_PORT/RTSP_WS_HTTPS_PORT env vars as
// src/server/config.ts, so this targets the right ports even if they were
// overridden at start time. Also stops MediaMTX, but *only* if it was
// started by this repo's own scripts/ensure-mediamtx.js (tracked via the pid
// file it writes) — a MediaMTX instance this repo didn't start (e.g. run
// manually, or shared with something else) is left running untouched.
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

require('./loadEnv').loadEnv();

const HTTP_PORT = Number(process.env.RTSP_WS_HTTP_PORT) || 4000;
const HTTPS_PORT = Number(process.env.RTSP_WS_HTTPS_PORT) || 4001;
const MEDIAMTX_PID_FILE = path.join(os.tmpdir(), 'rtsp-over-websocket-mediamtx.pid');
const BGUTIL_POT_PROVIDER_PID_FILE = path.join(os.tmpdir(), 'rtsp-over-websocket-bgutil-pot-provider.pid');

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

function processCommand(pid) {
  try {
    return execSync(`ps -p ${pid} -o comm=`, { encoding: 'utf8' }).trim();
  } catch {
    return null; // no such pid
  }
}

/** Only kills the pid recorded in MEDIAMTX_PID_FILE, and only if that pid is
 * still actually a mediamtx process (guards against a stale pid file
 * outliving a reboot and getting reused by an unrelated process). Always
 * removes the pid file afterward so a dead/stale entry doesn't linger. */
function stopOwnedMediaMtx() {
  if (!fs.existsSync(MEDIAMTX_PID_FILE)) return;
  const pid = Number(fs.readFileSync(MEDIAMTX_PID_FILE, 'utf8').trim());
  const command = pid && processCommand(pid);
  if (!command) {
    console.log(`[stop-server] ${MEDIAMTX_PID_FILE} pid ${pid || '(invalid)'} is no longer running — removing stale pid file`);
  } else if (!command.includes('mediamtx')) {
    console.log(`[stop-server] pid ${pid} in ${MEDIAMTX_PID_FILE} is now '${command}', not mediamtx — leaving it alone`);
  } else {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`[stop-server] sent SIGTERM to mediamtx pid ${pid}`);
    } catch {
      // already gone
    }
  }
  fs.unlinkSync(MEDIAMTX_PID_FILE);
}

/** Same shape as stopOwnedMediaMtx() — only kills the pid this repo's own
 * ensure-bgutil-pot-provider.js recorded, and only if that pid is still
 * actually running a "node" process (guards against a stale pid file
 * outliving a reboot and getting reused by an unrelated process). */
function stopOwnedBgutilPotProvider() {
  if (!fs.existsSync(BGUTIL_POT_PROVIDER_PID_FILE)) return;
  const pid = Number(fs.readFileSync(BGUTIL_POT_PROVIDER_PID_FILE, 'utf8').trim());
  const command = pid && processCommand(pid);
  if (!command) {
    console.log(`[stop-server] ${BGUTIL_POT_PROVIDER_PID_FILE} pid ${pid || '(invalid)'} is no longer running — removing stale pid file`);
  } else if (!command.includes('node')) {
    console.log(`[stop-server] pid ${pid} in ${BGUTIL_POT_PROVIDER_PID_FILE} is now '${command}', not node — leaving it alone`);
  } else {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`[stop-server] sent SIGTERM to bgutil-pot-provider pid ${pid}`);
    } catch {
      // already gone
    }
  }
  fs.unlinkSync(BGUTIL_POT_PROVIDER_PID_FILE);
}

stopOwnedMediaMtx();
stopOwnedBgutilPotProvider();

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
