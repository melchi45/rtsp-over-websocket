/**
 * YouTube -> configurable transcode -> RTSP -> RTSP-over-WebSocket demo
 * server for src/player's <rtsp-over-websocket> element.
 *
 * Depends on a MediaMTX instance already listening on 127.0.0.1:8554 with a
 * permissive `paths: all_others:` catch-all (see ../../../mediamtx.yml in
 * the parent loitering_tracking project, which already runs one — this
 * server does NOT spawn its own MediaMTX: that shared instance is owned by
 * the parent LTS server process and used for live camera streaming, so
 * competing for the same ports would either fail outright (EADDRINUSE) or
 * destabilize unrelated camera sessions. If no MediaMTX is reachable at
 * startup, sessions will simply fail at the ffmpeg-publish step with a
 * clear connection-refused error — see services/transcodeSession.ts.
 */

import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import express from 'express';
import { HTTP_PORT, HTTPS_PORT, MEDIAMTX_HOST, MEDIAMTX_RTSP_PORT, TLS_KEY_PATH, TLS_CERT_PATH } from './config';
import { buildYoutubeRouter } from './api/youtubeRoutes';
import { buildSessionRouter } from './api/sessionRoutes';
import { buildCapabilitiesRouter } from './api/capabilitiesRoutes';
import { attachRtspOverWebSocketServer } from './rtspOverWebSocket/server';
import { stopAllTranscodes } from './services/transcodeSession';
import { getYtDlpVersion, isYtDlpVersionStale } from './services/youtubeProbe';

type ServerMode = 'http' | 'https' | 'both';

function modeFromFlagsOrEnv(): ServerMode | null {
  const args = process.argv.slice(2);
  if (args.includes('--http')) return 'http';
  if (args.includes('--https')) return 'https';
  if (args.includes('--both')) return 'both';
  const env = process.env.RTSP_WS_PROTOCOL;
  if (env === 'http' || env === 'https' || env === 'both') return env;
  return null;
}

function promptForMode(): Promise<ServerMode> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('Select which protocol(s) to start — [1] HTTP only  [2] HTTPS only  [3] Both (default, Enter): ', (answer) => {
      rl.close();
      const choice = answer.trim();
      if (choice === '1') resolve('http');
      else if (choice === '2') resolve('https');
      else resolve('both');
    });
  });
}

/** --http/--https/--both (or RTSP_WS_PROTOCOL env) picks the mode
 * non-interactively — needed so backgrounded/scripted runs never block on
 * stdin. With none given and a real TTY attached, ask; otherwise default to
 * 'both' (the original always-run-everything behavior). */
async function resolveServerMode(): Promise<ServerMode> {
  const explicit = modeFromFlagsOrEnv();
  if (explicit) return explicit;
  if (process.stdin.isTTY) return promptForMode();
  return 'both';
}

function checkMediaMtxReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: MEDIAMTX_HOST, port: MEDIAMTX_RTSP_PORT });
    const done = (ok: boolean): void => {
      sock.destroy();
      resolve(ok);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(2000, () => done(false));
  });
}

/** Without this, killing the server (`npm run stop:server`, or a manual
 * SIGTERM/SIGINT during a restart) leaves any live session's yt-dlp/ffmpeg
 * children running: Node's default SIGTERM behavior exits immediately with
 * no cleanup, and killing a parent process does not kill its children. */
function registerShutdownHandlers(): void {
  const shutdown = (signal: NodeJS.Signals): void => {
    console.log(`[server] ${signal} received — stopping active transcode sessions...`);
    stopAllTranscodes();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

async function main(): Promise<void> {
  registerShutdownHandlers();
  const app = express();
  app.use(express.json());
  // dist/index.html (and dist/player/*.js) are also servable straight from
  // this same app so http(s)://127.0.0.1:<port>/ shows the demo page
  // without needing scripts/serve-dist.js running separately. That script
  // still exists for standalone static-only serving on its own ports
  // (4010/4011) if wanted, but isn't required.
  app.use(express.static(path.resolve(__dirname, '..')));
  // Permissive CORS in case the page is instead opened from serve-dist.js
  // or another origin — local dev/test tool, no session cookies involved.
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use('/api/youtube', buildYoutubeRouter());
  app.use('/api/sessions', buildSessionRouter());
  app.use('/api/capabilities', buildCapabilitiesRouter());
  app.get('/health', (_req, res) => res.json({ ok: true }));

  const mode = await resolveServerMode();
  const wantHttp = mode === 'http' || mode === 'both';
  const wantHttps = mode === 'https' || mode === 'both';

  if (wantHttp) {
    // REST + ws://.../StreamingServer on the same plain HTTP server.
    const httpServer = http.createServer(app);
    attachRtspOverWebSocketServer(httpServer);
    httpServer.listen(HTTP_PORT, () => console.log(`[server] HTTP  http://127.0.0.1:${HTTP_PORT}  (REST + ws://.../StreamingServer)`));
  }

  if (wantHttps) {
    if (!fs.existsSync(TLS_KEY_PATH) || !fs.existsSync(TLS_CERT_PATH)) {
      console.error(
        `[server] fatal: TLS key/cert not found at ${TLS_KEY_PATH} / ${TLS_CERT_PATH} — ` +
          'run "npm run serve:player" once to generate the self-signed dev cert in certs/, then retry.'
      );
      process.exit(1);
    }
    const tlsOptions = { key: fs.readFileSync(TLS_KEY_PATH), cert: fs.readFileSync(TLS_CERT_PATH) };
    // REST + wss://.../StreamingServer on the same TLS server.
    const httpsServer = https.createServer(tlsOptions, app);
    attachRtspOverWebSocketServer(httpsServer);
    httpsServer.listen(HTTPS_PORT, () => console.log(`[server] HTTPS https://127.0.0.1:${HTTPS_PORT}  (REST + wss://.../StreamingServer)`));
  }

  try {
    const ytDlpVersion = await getYtDlpVersion();
    if (isYtDlpVersionStale(ytDlpVersion)) {
      console.warn(
        `[server] WARNING: yt-dlp ${ytDlpVersion} is old enough that YouTube sessions may fail in confusing ways ` +
          '(a "Precondition check failed" 400 on probe, or a transcode that silently hangs and times out with ' +
          '"ffmpeg produced no output") — upgrade yt-dlp before relying on YouTube sessions (see README).'
      );
    } else {
      console.log(`[server] yt-dlp ${ytDlpVersion}`);
    }
  } catch (error) {
    console.warn(
      `[server] WARNING: could not determine yt-dlp version (${error instanceof Error ? error.message : String(error)}) — is yt-dlp installed and on PATH?`
    );
  }

  const mediaMtxUp = await checkMediaMtxReachable();
  if (!mediaMtxUp) {
    console.warn(
      `[server] WARNING: MediaMTX is not reachable at ${MEDIAMTX_HOST}:${MEDIAMTX_RTSP_PORT} — ` +
        'sessions will fail at the ffmpeg-publish step until it is running (see index.ts header comment).'
    );
  } else {
    console.log(`[server] MediaMTX reachable at ${MEDIAMTX_HOST}:${MEDIAMTX_RTSP_PORT}`);
  }
}

main().catch((error) => {
  console.error('[server] fatal startup error:', error);
  process.exit(1);
});
