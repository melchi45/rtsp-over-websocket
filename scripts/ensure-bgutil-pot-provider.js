#!/usr/bin/env node
// Runs before src/server starts (see package.json's start:server* scripts).
// Starts the bgutil-ytdlp-pot-provider HTTP server (a PO Token provider —
// see https://github.com/Brainicism/bgutil-ytdlp-pot-provider and
// https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide) if nothing is
// already reachable on its port. Without a PO Token, YouTube 403s most
// yt-dlp DASH format fetches regardless of a JS runtime being present (see
// CLAUDE.md's "Environment gotchas" and MEMORY.md for the full
// investigation — a JS runtime alone was confirmed NOT sufficient).
//
// This mirrors ensure-mediamtx.js's shape exactly: leave an already-running
// (possibly externally-managed) instance alone; only start + pid-track one
// if nothing answers, so stop-server.js can later stop exactly (and only)
// the instance this script itself started. Unlike MediaMTX, though, this
// project doesn't vendor/install the provider itself — it must already be
// git-cloned + built at BGUTIL_POT_PROVIDER_DIR (default
// ~/bgutil-ytdlp-pot-provider, matching the provider project's own default
// expected location) per README.md's "External tools" section. Missing
// install is a WARNING, not a failure — sessions still work for whatever
// YouTube doesn't gate behind a PO Token, same graceful-degradation
// philosophy as ensure-mediamtx.js.
'use strict';

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

require('./loadEnv').loadEnv();

const HOST = '127.0.0.1';
const PORT = Number(process.env.BGUTIL_POT_PROVIDER_PORT) || 4416;
const PID_FILE = path.join(os.tmpdir(), 'rtsp-over-websocket-bgutil-pot-provider.pid');
const LOG_FILE = path.join(os.tmpdir(), 'rtsp-over-websocket-bgutil-pot-provider.log');
const START_TIMEOUT_MS = 8000;
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

function resolveProviderDir() {
  const dir = process.env.BGUTIL_POT_PROVIDER_DIR || path.join(os.homedir(), 'bgutil-ytdlp-pot-provider');
  const mainJs = path.join(dir, 'server', 'build', 'main.js');
  return fs.existsSync(mainJs) ? { dir, mainJs } : null;
}

/** The provider's package.json requires Node >=22 (uses APIs this repo's
 * own pinned Node 20 doesn't have — see CLAUDE.md) — a separate runtime
 * requirement from the rest of this project. Checked explicitly rather than
 * just trying to spawn and letting it fail, since a too-old Node still
 * starts far enough to bind the port before erroring on first real request,
 * which would otherwise look like a successful start. */
function resolveNode22() {
  const configured = process.env.BGUTIL_POT_PROVIDER_NODE_BIN;
  const candidates = configured
    ? [configured]
    : [
        ...findNvmNodeBins(),
        'node' // last resort — PATH lookup, checked for version below
      ];
  for (const bin of candidates) {
    try {
      const version = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
      const major = Number(version.replace(/^v/, '').split('.')[0]);
      if (major >= 22) return { bin, version };
    } catch {
      // candidate doesn't exist / isn't executable — try the next one
    }
  }
  return null;
}

/** nvm installs land at ~/.nvm/versions/node/vX.Y.Z/bin/node — this repo
 * doesn't depend on nvm itself, but checks there as a convenience since
 * that's how Node 22 was actually installed for this provider (nvm install
 * 22) rather than changing this repo's own pinned Node 20 (see CLAUDE.md's
 * "system default node may be too old" gotcha, which cuts the other way —
 * both a too-old *and* the wrong-too-new default matter here). */
function findNvmNodeBins() {
  const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node');
  if (!fs.existsSync(nvmDir)) return [];
  try {
    return fs
      .readdirSync(nvmDir)
      .sort()
      .reverse()
      .map((v) => path.join(nvmDir, v, 'bin', 'node'))
      .filter((p) => fs.existsSync(p));
  } catch {
    return [];
  }
}

/** The provider's own outbound HTTPS requests (BotGuard challenge fetch
 * from google.com) need to trust whatever CA issued this machine's TLS-
 * intercepting network path, if any — Node's bundled CA store doesn't
 * automatically pick up the OS trust store the way curl/OpenSSL do.
 * Confirmed live: without this, the provider logs "self-signed certificate
 * in certificate chain" and every PO Token request fails. Only set if the
 * bundle actually exists — most non-Debian/Ubuntu systems won't have this
 * exact path and don't need it anyway. */
function resolveExtraCaCerts() {
  if (process.env.BGUTIL_POT_PROVIDER_CA_CERTS) return process.env.BGUTIL_POT_PROVIDER_CA_CERTS;
  const debianBundle = '/etc/ssl/certs/ca-certificates.crt';
  return fs.existsSync(debianBundle) ? debianBundle : undefined;
}

function sleep(ms) {
  execFileSync('sleep', [String(ms / 1000)]);
}

async function main() {
  if (await checkReachable()) {
    console.log(`[ensure-bgutil-pot-provider] already reachable at ${HOST}:${PORT} — leaving it as-is.`);
    return;
  }

  const provider = resolveProviderDir();
  if (!provider) {
    console.warn(
      '[ensure-bgutil-pot-provider] WARNING: nothing reachable at ' +
        `${HOST}:${PORT} and no built server found (checked BGUTIL_POT_PROVIDER_DIR / ~/bgutil-ytdlp-pot-provider) — ` +
        'YouTube sessions will still work for anything not PO-Token-gated, but most modern videos will 403 at real ' +
        'resolutions. See README.md\'s "External tools" section to set this up.'
    );
    return;
  }

  const node22 = resolveNode22();
  if (!node22) {
    console.warn(
      `[ensure-bgutil-pot-provider] WARNING: found ${provider.mainJs} but no Node.js >=22 available ` +
        '(checked BGUTIL_POT_PROVIDER_NODE_BIN, ~/.nvm/versions/node/*, and PATH) — the provider requires it. ' +
        'See README.md\'s "External tools" section.'
    );
    return;
  }

  const extraCaCerts = resolveExtraCaCerts();
  console.log(
    `[ensure-bgutil-pot-provider] starting '${node22.bin} ${provider.mainJs}' (node ${node22.version}` +
      `${extraCaCerts ? `, NODE_EXTRA_CA_CERTS=${extraCaCerts}` : ''}) — nothing reachable at ${HOST}:${PORT} ...`
  );

  const log = fs.openSync(LOG_FILE, 'a');
  const env = { ...process.env };
  if (extraCaCerts) env.NODE_EXTRA_CA_CERTS = extraCaCerts;
  const child = spawn(node22.bin, [provider.mainJs, '--port', String(PORT)], {
    cwd: path.dirname(provider.mainJs),
    stdio: ['ignore', log, log],
    detached: true,
    env
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await checkReachable()) {
      console.log(`[ensure-bgutil-pot-provider] started pid ${child.pid}, reachable at ${HOST}:${PORT} (log: ${LOG_FILE})`);
      return;
    }
    sleep(POLL_INTERVAL_MS);
  }

  console.warn(
    `[ensure-bgutil-pot-provider] WARNING: started pid ${child.pid} but ${HOST}:${PORT} still isn't reachable after ${START_TIMEOUT_MS}ms — ` +
      `check ${LOG_FILE} for why it failed to start.`
  );
}

main().catch((error) => {
  console.warn(`[ensure-bgutil-pot-provider] WARNING: ${error instanceof Error ? error.message : String(error)} — continuing without a PO Token provider.`);
});
