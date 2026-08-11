#!/usr/bin/env node
// Runs before src/server starts (see package.json's start:server* scripts).
// src/server never spawns MediaMTX itself (see src/server/index.ts's header
// comment) — sessions just fail at the ffmpeg-publish step with a clear
// "Connection refused" if it isn't already up (see README.md's "External
// tools" section). This script closes that gap for local dev: if something
// is already reachable on MEDIAMTX_HOST:MEDIAMTX_RTSP_PORT, it's left alone
// untouched (it may be a shared/externally-managed instance this script
// didn't start and has no business killing); only if nothing answers does it
// start one and record the pid, so stop-server.js can later stop exactly
// (and only) the instance this script itself started.
'use strict';

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

require('./loadEnv').loadEnv();

const HOST = '127.0.0.1';
const PORT = Number(process.env.MEDIAMTX_RTSP_PORT) || 8554;
const PID_FILE = path.join(os.tmpdir(), 'rtsp-over-websocket-mediamtx.pid');
const LOG_FILE = path.join(os.tmpdir(), 'rtsp-over-websocket-mediamtx.log');
const DEFAULT_CONFIG = '/opt/mediamtx/mediamtx.yml';
const START_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 200;

function checkReachable() {
  return new Promise((resolve) => {
    const sock = net.connect({ host: HOST, port: PORT });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(1000, () => done(false));
  });
}

function resolveBinary() {
  if (process.env.MEDIAMTX_BIN) return process.env.MEDIAMTX_BIN;
  try {
    const onPath = execFileSync('which', ['mediamtx'], { encoding: 'utf8' }).trim();
    if (onPath) return onPath;
  } catch {
    // not on PATH — fall through to the well-known install location
  }
  return fs.existsSync('/opt/mediamtx/mediamtx') ? '/opt/mediamtx/mediamtx' : null;
}

function resolveConfig() {
  if (process.env.MEDIAMTX_CONFIG) return process.env.MEDIAMTX_CONFIG;
  return fs.existsSync(DEFAULT_CONFIG) ? DEFAULT_CONFIG : null;
}

function sleep(ms) {
  execFileSync('sleep', [String(ms / 1000)]);
}

async function main() {
  if (await checkReachable()) {
    console.log(`[ensure-mediamtx] already reachable at ${HOST}:${PORT} — leaving it as-is.`);
    return;
  }

  const bin = resolveBinary();
  if (!bin) {
    console.warn(
      '[ensure-mediamtx] WARNING: nothing reachable at ' +
        `${HOST}:${PORT} and no 'mediamtx' binary found (checked PATH and /opt/mediamtx/mediamtx) — ` +
        'transcode sessions will fail at the ffmpeg-publish step until MediaMTX is installed and running (see README.md).'
    );
    return;
  }

  const config = resolveConfig();
  const args = config ? [config] : [];
  console.log(`[ensure-mediamtx] starting '${bin}${config ? ` ${config}` : ''}' (nothing was reachable at ${HOST}:${PORT}) ...`);

  const log = fs.openSync(LOG_FILE, 'a');
  const child = spawn(bin, args, { stdio: ['ignore', log, log], detached: true });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await checkReachable()) {
      console.log(`[ensure-mediamtx] started pid ${child.pid}, reachable at ${HOST}:${PORT} (log: ${LOG_FILE})`);
      return;
    }
    sleep(POLL_INTERVAL_MS);
  }

  console.warn(
    `[ensure-mediamtx] WARNING: started pid ${child.pid} but ${HOST}:${PORT} still isn't reachable after ${START_TIMEOUT_MS}ms — ` +
      `check ${LOG_FILE} for why it failed to start.`
  );
}

main().catch((error) => {
  console.warn(`[ensure-mediamtx] WARNING: ${error instanceof Error ? error.message : String(error)} — continuing without MediaMTX.`);
});
