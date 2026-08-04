import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The RTSP-over-WebSocket bridge (/StreamingServer) shares whichever of
// these ports is active — ws:// rides on HTTP_PORT, wss:// on HTTPS_PORT
// (see attachRtspOverWebSocketServer in index.ts) — no separate port.
export const HTTP_PORT = parseInt(process.env.RTSP_WS_HTTP_PORT || '4000', 10);
export const HTTPS_PORT = parseInt(process.env.RTSP_WS_HTTPS_PORT || '4001', 10);
export const MEDIAMTX_RTSP_PORT = parseInt(process.env.MEDIAMTX_RTSP_PORT || '8554', 10);
export const MEDIAMTX_API_PORT = parseInt(process.env.MEDIAMTX_API_PORT || '9997', 10);
export const MEDIAMTX_HOST = '127.0.0.1';

// Same self-signed dev cert scripts/serve-dist.js generates/uses for the
// static player server, reused here so HTTPS/WSS work out of the box.
export const TLS_KEY_PATH = process.env.RTSP_WS_TLS_KEY || path.resolve(__dirname, '../../certs/dev-server.key');
export const TLS_CERT_PATH = process.env.RTSP_WS_TLS_CERT || path.resolve(__dirname, '../../certs/dev-server.crt');

/** Digest-auth realm sent in the WWW-Authenticate challenge — the client
 * (RtspClient.ts's DigestGenerator) reads this back from the challenge
 * itself, so any string works as long as server and verifyDigest() agree. */
export const REALM = 'rtsp-ws-youtube';

export const MAX_AUTH_ATTEMPTS = 3;
export const BACKEND_CONNECT_TIMEOUT_MS = 5000;
export const KEYFRAME_GATE_TIMEOUT_MS = 4000;
export const MAX_PENDING_RTSP_TEXT_BYTES = 1024 * 1024;

/** How long ffmpeg is given to report at least one encoded frame before a
 * session is declared failed-to-start. */
export const TRANSCODE_STARTUP_TIMEOUT_MS = 20000;

const LOCAL_YT_DLP_PATH = path.join(os.homedir(), '.local', 'bin', 'yt-dlp');

/** Prefers a user-local ~/.local/bin/yt-dlp over whatever a bare 'yt-dlp'
 * would resolve to via PATH. This dev environment's distro package
 * (/usr/bin/yt-dlp) is stuck on a years-old release that YouTube's current
 * extraction/CDN behavior routinely rejects (see scripts/ensure-yt-dlp.js,
 * which installs an up-to-date standalone binary to this exact path), and
 * relying on PATH ordering to prefer it instead would silently break again
 * on any shell/environment where ~/.local/bin isn't listed first. Falls back
 * to a plain PATH lookup if no local install exists. */
export function resolveYtDlpBinary(): string {
  return fs.existsSync(LOCAL_YT_DLP_PATH) ? LOCAL_YT_DLP_PATH : 'yt-dlp';
}
