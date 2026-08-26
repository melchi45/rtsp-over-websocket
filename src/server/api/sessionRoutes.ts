import { Router } from 'express';
import * as sessionStore from '../services/sessionStore';
import { getAudioEncoder, getVideoEncoder } from '../services/codecCapabilities';
import { probeYoutubeVideo } from '../services/youtubeProbe';
import { startTranscode, stopTranscode, isRunning } from '../services/transcodeSession';
import { RESOLUTION_LADDER } from '../types';
import type { AudioCodec, CreateSessionRequest, VideoCodec } from '../types';

const VIDEO_CODECS: VideoCodec[] = ['MJPEG', 'H264', 'H265', 'AV1', 'VP8', 'VP9'];
const AUDIO_CODECS: AudioCodec[] = ['OPUS', 'AAC', 'G711', 'G726'];

function validateCreateRequest(body: unknown): { value: CreateSessionRequest; channel?: number } | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'request body must be a JSON object' };
  const b = body as Record<string, unknown>;

  if (typeof b.youtubeUrl !== 'string' || !/^https?:\/\//.test(b.youtubeUrl)) {
    return { error: '"youtubeUrl" must be an http(s) URL string' };
  }
  if (typeof b.resolutionHeight !== 'number' || !RESOLUTION_LADDER.some((r) => r.height === b.resolutionHeight)) {
    return { error: `"resolutionHeight" must be one of ${RESOLUTION_LADDER.map((r) => r.height).join(', ')}` };
  }
  if (typeof b.videoCodec !== 'string' || !VIDEO_CODECS.includes(b.videoCodec as VideoCodec)) {
    return { error: `"videoCodec" must be one of ${VIDEO_CODECS.join(', ')}` };
  }
  if (typeof b.audioCodec !== 'string' || !AUDIO_CODECS.includes(b.audioCodec as AudioCodec)) {
    return { error: `"audioCodec" must be one of ${AUDIO_CODECS.join(', ')}` };
  }
  if (typeof b.audioBitrateKbps !== 'number' || b.audioBitrateKbps <= 0 || b.audioBitrateKbps > 512) {
    return { error: '"audioBitrateKbps" must be a number between 1 and 512' };
  }
  // Empty string is allowed for both — it opts the session out of RTSP
  // Digest auth entirely (see CreateSessionRequest.username's comment in
  // types.ts). One empty and the other not is rejected: there's no sensible
  // half-authenticated state to start a session in.
  if (typeof b.username !== 'string') return { error: '"username" must be a string (empty string for an unauthenticated session)' };
  if (typeof b.password !== 'string') return { error: '"password" must be a string (empty string for an unauthenticated session)' };
  if ((b.username.length === 0) !== (b.password.length === 0)) {
    return { error: '"username" and "password" must either both be set or both be left empty' };
  }

  // Optional — 0-based wire value (see Session.channel's comment in
  // types.ts). Omitted/undefined means "auto-assign the next free one".
  let channel: number | undefined;
  if (b.channel !== undefined && b.channel !== null && b.channel !== '') {
    const n = typeof b.channel === 'number' ? b.channel : NaN;
    if (!Number.isInteger(n) || n < 0) return { error: '"channel" must be a non-negative integer' };
    channel = n;
  }

  // Optional — see CreateSessionRequest.bFrames's comment in types.ts. Omitted/undefined
  // defaults to true (ffmpeg's own default: B-frames on).
  let bFrames = true;
  if (b.bFrames !== undefined && b.bFrames !== null) {
    if (typeof b.bFrames !== 'boolean') return { error: '"bFrames" must be a boolean' };
    bFrames = b.bFrames;
  }

  return {
    value: {
      youtubeUrl: b.youtubeUrl,
      resolutionHeight: b.resolutionHeight,
      videoCodec: b.videoCodec as VideoCodec,
      audioCodec: b.audioCodec as AudioCodec,
      audioBitrateKbps: b.audioBitrateKbps,
      username: b.username,
      password: b.password,
      bFrames
    },
    channel
  };
}

export function buildSessionRouter(): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    const validated = validateCreateRequest(req.body);
    if ('error' in validated) {
      res.status(400).json({ error: validated.error });
      return;
    }
    const { value: request, channel } = validated;

    // Sessions never get garbage-collected from the store on their own (only
    // an explicit DELETE removes one) — a session whose ffmpeg naturally
    // finished/crashed sits there forever at 'stopped'/'failed'. Only
    // 'starting'/'live' sessions are actually occupying the channel; a
    // terminal one shouldn't block reusing its channel for a new session —
    // but it must be removed here (not just ignored), or findByChannel()
    // would end up with two sessions on the same channel and nondeterministically
    // match the stale one instead of the new live one.
    const existingOnChannel = channel !== undefined ? sessionStore.findByChannel(channel) : undefined;
    if (existingOnChannel) {
      if (existingOnChannel.status === 'starting' || existingOnChannel.status === 'live') {
        res.status(409).json({ error: `channel ${channel} is already in use by another active session (status=${existingOnChannel.status})` });
        return;
      }
      sessionStore.deleteSession(existingOnChannel.id);
    }

    const [videoEncoder, audioEncoder] = await Promise.all([getVideoEncoder(request.videoCodec), getAudioEncoder(request.audioCodec)]);
    if (!videoEncoder) {
      res.status(422).json({ error: `video codec ${request.videoCodec} is not supported by the installed ffmpeg build — see GET /api/capabilities` });
      return;
    }
    if (!audioEncoder) {
      res.status(422).json({ error: `audio codec ${request.audioCodec} is not supported by the installed ffmpeg build — see GET /api/capabilities` });
      return;
    }

    let probe;
    try {
      probe = await probeYoutubeVideo(request.youtubeUrl);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const session = sessionStore.createSession(request, probe, channel);
    // startTranscode() below hasn't run yet at this point (fire-and-forget,
    // after the response is sent) — ffmpeg can't be running yet either way.
    res.status(201).json(sessionStore.toPublicSession(session, false));

    startTranscode(session).catch((error: unknown) => {
      sessionStore.updateStatus(session.id, 'failed', error instanceof Error ? error.message : String(error));
    });
  });

  router.get('/', (_req, res) => {
    res.json(sessionStore.listSessions().map((session) => sessionStore.toPublicSession(session, isRunning(session.id))));
  });

  router.get('/:id', (req, res) => {
    const session = sessionStore.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    res.json(sessionStore.toPublicSession(session, isRunning(session.id)));
  });

  router.delete('/:id', (req, res) => {
    const session = sessionStore.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    stopTranscode(session.id);
    sessionStore.deleteSession(session.id);
    res.status(204).end();
  });

  return router;
}
