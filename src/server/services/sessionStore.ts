import { randomUUID } from 'node:crypto';
import type { CreateSessionRequest, PublicSession, Session, YoutubeProbeResult } from '../types';

const sessions = new Map<string, Session>();
// 0-based, deliberately: RtspClient.ts's device="nvr" URI builder stores
// the <rtsp-over-websocket> `channel` attribute (1-based, matching the
// Player panel's "Channel" field) internally as `channelId = channel - 1`
// and embeds *that* in the RTSP request URI — so channel 0 here is what a
// client displaying/typing "1" actually asks for on the wire. See
// rtspOverWebSocket/rtspFraming.ts's extractChannel(), which reads the URI
// segment directly with no adjustment.
let nextChannel = 0;

export function toPublicSession(session: Session, isRunning: boolean): PublicSession {
  const { password: _password, ...requestWithoutPassword } = session.request;
  return { ...session, request: requestWithoutPassword, isRunning };
}

/** requestedChannel, if given, is the 0-based wire value (see the `channel`
 * field comment above) — caller (sessionRoutes.ts) is responsible for
 * checking it isn't already taken via findByChannel() first. */
export function createSession(request: CreateSessionRequest, probe: YoutubeProbeResult, requestedChannel?: number): Session {
  const id = randomUUID();
  const channel = requestedChannel !== undefined ? requestedChannel : nextChannel++;
  // Keep the auto-increment counter ahead of any manually-assigned channel
  // so a later auto-assigned session can't collide with it.
  if (requestedChannel !== undefined && requestedChannel >= nextChannel) nextChannel = requestedChannel + 1;
  const session: Session = {
    id,
    channel,
    status: 'starting',
    request,
    probe: { title: probe.title, durationSec: probe.durationSec, maxHeight: probe.maxHeight },
    mediaMtxPath: id,
    createdAt: new Date().toISOString()
  };
  sessions.set(id, session);
  return session;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function findByChannel(channel: number): Session | undefined {
  for (const session of sessions.values()) {
    if (session.channel === channel) return session;
  }
  return undefined;
}

export function listSessions(): Session[] {
  return Array.from(sessions.values());
}

export function updateStatus(id: string, status: Session['status'], error?: string): void {
  const session = sessions.get(id);
  if (!session) return;
  session.status = status;
  if (error !== undefined) session.error = error;
}

export function deleteSession(id: string): boolean {
  return sessions.delete(id);
}
