/**
 * RTSP-over-WebSocket bridge for this server's own transcoded YouTube
 * sessions. Adapted from the equivalent bridge in a sibling
 * camera-streaming server this project shares heritage with (see that
 * project's own source for the full original design) — same wire protocol
 * so src/player's
 * <rtsp-over-websocket> element (RtspClient.ts) connects unmodified:
 * `<rtsp-over-websocket>` opens a plain WebSocket to `ws(s)://<host>/StreamingServer`
 * and tunnels RTSP-over-TCP interleaved framing (RFC 7826 §10.12) through
 * it. This bridge reads the first request's URI to identify which session
 * the client wants (the channel number createSession() assigned), performs
 * one RTSP Digest (MD5) challenge/response against that session's own
 * username/password (set at session-creation time, not a real camera's
 * credentials) — or, if that session was created with empty username/
 * password, skips the challenge entirely — then relays between the WebSocket and a local TCP
 * connection to this session's own MediaMTX publish path — the one this
 * server's own ffmpeg process is continuously pushing to (see
 * services/transcodeSession.ts), so there is no on-demand fan-out or
 * viewer refcounting to manage here, unlike the parent project's camera-
 * backed version.
 */

import { randomBytes } from 'node:crypto';
import net from 'node:net';
import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import { WebSocketServer, type WebSocket } from 'ws';
import { BACKEND_CONNECT_TIMEOUT_MS, KEYFRAME_GATE_TIMEOUT_MS, MEDIAMTX_HOST, MEDIAMTX_RTSP_PORT, MAX_AUTH_ATTEMPTS } from '../config';
import { verifyDigest } from './digest';
import {
  buildRtspResponse,
  extractChannel,
  extractRtspResponseText,
  MAX_PENDING_RTSP_TEXT_BYTES,
  parseDigestAuthorization,
  parseHeader,
  parseRtspRequestLine,
  rewriteRequestUri
} from './rtspFraming';
import { classifyVideoRtpPacket, parseSdpVideoTrack } from './keyframeGate';
import * as sessionStore from '../services/sessionStore';
import type { Session } from '../types';

// Hardcoded client-side in src/player/interface/StreamPlayer.ts's
// startStreaming() (`${protocol}${addr}/StreamingServer${pathName}`) — not
// configurable via any <rtsp-over-websocket> attribute, so this must match
// exactly for the existing player element to connect unmodified.
const WS_PATH = '/StreamingServer';
/** How long to wait for a session's ffmpeg publish to reach MediaMTX before
 * giving up on a freshly-authenticated viewer (covers the "client connected
 * within the first couple seconds of POST /api/sessions" race). */
const SESSION_LIVE_WAIT_MS = 15000;
const SESSION_LIVE_POLL_MS = 200;

function connectBackend(port: number, cb: (err: Error | null, socket?: net.Socket) => void): void {
  const sock = net.connect({ host: MEDIAMTX_HOST, port });
  const timer = setTimeout(() => {
    sock.destroy();
    cb(new Error('backend connect timeout'));
  }, BACKEND_CONNECT_TIMEOUT_MS);
  sock.once('connect', () => {
    clearTimeout(timer);
    cb(null, sock);
  });
  sock.once('error', (err) => {
    clearTimeout(timer);
    cb(err);
  });
}

function waitForLive(session: Session, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = (): void => {
      const current = sessionStore.getSession(session.id);
      if (!current || current.status === 'failed' || current.status === 'stopped') {
        resolve(false);
        return;
      }
      if (current.status === 'live') {
        resolve(true);
        return;
      }
      if (Date.now() > deadline) {
        resolve(false);
        return;
      }
      setTimeout(poll, SESSION_LIVE_POLL_MS);
    };
    poll();
  });
}

function handleConnection(ws: WebSocket): void {
  let state: 'awaiting-auth' | 'relaying' = 'awaiting-auth';
  let nonce: string | null = null;
  let attempts = 0;
  let session: Session | null = null;
  let clientBaseUri: string | null = null;
  let backendTargetUri: string | null = null;
  let backendSocket: net.Socket | null = null;
  let pendingRelay: Buffer[] = [];
  let closed = false;

  // Keyframe gate state — see keyframeGate.ts.
  let videoControl: string | null = null;
  let videoCodec: 'H264' | 'H265' | null = null;
  let videoRtpChannel: number | null = null;
  let gatingEnabled = false;
  let gateOpen = false;
  let gateDeadline = 0;
  const pendingCseqMethod = new Map<string, string>();
  const pendingSetupIsVideo = new Map<string, boolean>();

  const recordOutgoingRequest = (text: string): void => {
    const reqLine = parseRtspRequestLine(text);
    if (!reqLine) return;
    const cseq = parseHeader(text, 'CSeq');
    if (!cseq) return;
    pendingCseqMethod.set(cseq, reqLine.method);
    if (reqLine.method === 'SETUP') {
      pendingSetupIsVideo.set(cseq, !!(videoControl && reqLine.uri.includes(videoControl)));
    }
  };

  const handleBackendResponse = (headerText: string, body: string): void => {
    const cseq = parseHeader(headerText, 'CSeq');
    const method = cseq ? pendingCseqMethod.get(cseq) : null;
    if (cseq) pendingCseqMethod.delete(cseq);

    if (method === 'DESCRIBE' && body && !videoControl) {
      const track = parseSdpVideoTrack(body);
      if (track) {
        videoControl = track.control;
        videoCodec = track.codec;
      }
      return;
    }
    if (method === 'SETUP' && cseq) {
      const isVideoSetup = pendingSetupIsVideo.get(cseq);
      pendingSetupIsVideo.delete(cseq);
      if (isVideoSetup && videoCodec) {
        const transport = parseHeader(headerText, 'Transport');
        const m = transport && transport.match(/interleaved=(\d+)-(\d+)/);
        if (m) {
          videoRtpChannel = parseInt(m[1], 10);
          gatingEnabled = true;
          gateOpen = false;
          gateDeadline = Date.now() + KEYFRAME_GATE_TIMEOUT_MS;
          console.log(`[RtspOverWebSocket][${session?.id.slice(0, 8)}] ${videoCodec} video RTP interleaved channel=${videoRtpChannel} — gating relay until first IDR`);
        }
      }
    }
  };

  const challenge = (cseq: string): void => {
    nonce = randomBytes(16).toString('hex');
    attempts += 1;
    if (attempts > MAX_AUTH_ATTEMPTS) {
      ws.close(1008, 'too many auth attempts');
      return;
    }
    ws.send(Buffer.from(buildRtspResponse(401, 'Unauthorized', cseq, `WWW-Authenticate: Digest realm="rtsp-ws-youtube", nonce="${nonce}"\r\n`)));
  };

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (backendSocket) {
      try {
        backendSocket.destroy();
      } catch {
        /* already gone */
      }
      backendSocket = null;
    }
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);

  const relayToBackend = (rawData: Buffer | string): void => {
    const original = Buffer.isBuffer(rawData) ? rawData.toString('utf8') : String(rawData);
    const rewrittenText = rewriteRequestUri(original, clientBaseUri, backendTargetUri);
    recordOutgoingRequest(rewrittenText);
    const rewritten = Buffer.from(rewrittenText, 'utf8');
    if (backendSocket && !backendSocket.destroyed) backendSocket.write(rewritten);
    else pendingRelay.push(rewritten);
  };

  ws.on('message', (data: Buffer) => {
    if (state === 'relaying') {
      relayToBackend(data);
      return;
    }

    const text = data.toString('utf8');
    const reqLine = parseRtspRequestLine(text);
    if (!reqLine) {
      console.warn(`[RtspOverWebSocket] close 1002: first line did not parse as an RTSP request — "${text.split('\r\n')[0]}"`);
      ws.close(1002, 'invalid RTSP request');
      return;
    }
    const cseq = parseHeader(text, 'CSeq') || '1';

    if (session === null) {
      const channel = extractChannel(reqLine.uri);
      if (channel === null) {
        console.warn(`[RtspOverWebSocket] close 1008: no numeric channel segment found in URI "${reqLine.uri}"`);
        ws.close(1008, 'no channel in request URI');
        return;
      }
      const found = sessionStore.findByChannel(channel);
      if (!found) {
        console.warn(`[RtspOverWebSocket] close 1008: no session on channel=${channel} (parsed from URI "${reqLine.uri}")`);
        ws.send(Buffer.from(buildRtspResponse(404, 'Not Found', cseq)));
        ws.close(1008, 'unknown channel');
        return;
      }
      session = found;
      clientBaseUri = reqLine.uri;
      backendTargetUri = `rtsp://${MEDIAMTX_HOST}:${MEDIAMTX_RTSP_PORT}/${session.mediaMtxPath}`;
      console.log(`[RtspOverWebSocket][${session.id.slice(0, 8)}] matched channel=${channel} -> ${backendTargetUri} (client base "${clientBaseUri}")`);
    }

    // Empty username/password means this session opted out of auth
    // (sessionRoutes.ts only allows both-empty or both-non-empty) — skip
    // the Digest challenge entirely and relay from the very first request.
    if (session.request.username) {
      const auth = parseDigestAuthorization(text);
      if (!auth || !verifyDigest(auth, reqLine.method, session.request.username, session.request.password, nonce)) {
        challenge(cseq);
        return;
      }
      console.log(`[RtspOverWebSocket][${session.id.slice(0, 8)}] digest auth OK — switching to relay`);
    } else {
      console.log(`[RtspOverWebSocket][${session.id.slice(0, 8)}] session has no credentials — skipping digest auth, switching to relay`);
    }
    state = 'relaying';

    (async () => {
      const live = await waitForLive(session as Session, SESSION_LIVE_WAIT_MS);
      if (closed) return;
      if (!live) {
        ws.close(1011, 'transcode session never went live');
        return;
      }
      connectBackend(MEDIAMTX_RTSP_PORT, (err, sock) => {
        if (closed) {
          try {
            sock?.destroy();
          } catch {
            /* ignore */
          }
          return;
        }
        if (err || !sock || ws.readyState !== ws.OPEN) {
          try {
            sock?.destroy();
          } catch {
            /* ignore */
          }
          ws.close(1011, 'backend unavailable');
          return;
        }
        backendSocket = sock;
        for (const chunk of pendingRelay) backendSocket.write(chunk);
        pendingRelay = [];

        let backendBuf: Buffer = Buffer.alloc(0);
        backendSocket.on('data', (chunk: Buffer) => {
          backendBuf = backendBuf.length ? Buffer.concat([backendBuf, chunk]) : chunk;

          for (;;) {
            if (backendBuf.length === 0) break;

            if (backendBuf[0] === 0x24) {
              // '$' — interleaved binary frame
              if (backendBuf.length < 4) break;
              const channelId = backendBuf[1];
              const len = backendBuf.readUInt16BE(2);
              const total = 4 + len;
              if (backendBuf.length < total) break;
              const frame = backendBuf.slice(0, total);
              backendBuf = backendBuf.slice(total);

              if (gatingEnabled && !gateOpen && channelId === videoRtpChannel) {
                if (Date.now() > gateDeadline) {
                  gateOpen = true;
                  console.warn(`[RtspOverWebSocket][${session?.id.slice(0, 8)}] no IDR within ${KEYFRAME_GATE_TIMEOUT_MS}ms — releasing gate anyway`);
                } else {
                  const { forward, opensGate } = classifyVideoRtpPacket(videoCodec as 'H264' | 'H265', frame.slice(4));
                  if (opensGate) gateOpen = true;
                  if (!forward) continue; // pre-keyframe non-IDR slice — drop
                }
              }
              if (ws.readyState === ws.OPEN) ws.send(Buffer.from(frame));
              continue;
            }

            const parsed = extractRtspResponseText(backendBuf);
            if (!parsed) {
              if (backendBuf.length > MAX_PENDING_RTSP_TEXT_BYTES) {
                console.warn(`[RtspOverWebSocket][${session?.id.slice(0, 8)}] backend stream did not resolve to a complete RTSP response after ${backendBuf.length}B — disabling keyframe gating and relaying raw`);
                if (ws.readyState === ws.OPEN) ws.send(Buffer.from(backendBuf));
                backendBuf = Buffer.alloc(0);
                gatingEnabled = false;
              }
              break;
            }
            backendBuf = backendBuf.slice(parsed.consumed);
            handleBackendResponse(parsed.headerText, parsed.body);
            if (ws.readyState === ws.OPEN) ws.send(Buffer.from(parsed.raw));
          }
        });
        backendSocket.on('close', () => ws.close());
        backendSocket.on('error', () => ws.close());

        const initialRequest = rewriteRequestUri(text, clientBaseUri, backendTargetUri);
        recordOutgoingRequest(initialRequest);
        backendSocket.write(Buffer.from(initialRequest, 'utf8'));
      });
    })().catch(() => {
      /* connection already closing */
    });
  });
}

/** Attaches the RTSP-over-WebSocket bridge to an existing HTTP(S) server at
 * WS_PATH, using `noServer: true` + a manual 'upgrade' listener so it can
 * coexist with any other upgrade handling on the same server. */
export function attachRtspOverWebSocketServer(httpServer: HttpServer | HttpsServer): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith(WS_PATH)) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });
  wss.on('connection', (ws: WebSocket) => handleConnection(ws));
  console.log(`[RtspOverWebSocket] ${WS_PATH} bridge attached`);
  return wss;
}
