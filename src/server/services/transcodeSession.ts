import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BGUTIL_POT_PROVIDER_PORT, MEDIAMTX_HOST, MEDIAMTX_RTSP_PORT, resolveYtDlpBinary, TRANSCODE_STARTUP_TIMEOUT_MS } from '../config';
import { getAudioEncoder, getVideoEncoder } from './codecCapabilities';
import * as sessionStore from './sessionStore';
import type { AudioCodec, Session, VideoCodec } from '../types';

interface RunningTranscode {
  ytDlp: ChildProcess;
  ffmpeg: ChildProcess;
}

const processes = new Map<string, RunningTranscode>();

function videoEncoderArgs(codec: VideoCodec, encoder: string, height: number, bFrames: boolean): string[] {
  const scale = ['-vf', `scale=-2:${height}`];
  // bframes=0: forces an IPPP-only, camera-like stream. VideoTagPlayer.ts (Renderer Type
  // "video") now computes a real per-sample composition-time-offset (see
  // getVideoCompositionTimeOffset()) and mp4Generator.js's trun writer can encode it, so
  // B-frame content plays correctly there too — this is an opt-out for comparison/testing, not
  // a required workaround anymore. Confirmed live via chrome://media-internals that, before the
  // CTS fix, x265's default bframes setting made every H.265 demo session log repeating
  // "Decoded frame ... is out of order" / "Dropping frame ... which is earlier than the last
  // rendered frame" for the whole session (RTP packets arrive in decode order; each one's own
  // rtpTimestamp is still its true presentation time, so the arrival-order sequence is
  // inherently non-monotonic whenever a B-frame is in flight) — `canvas`-tag mode was never
  // affected, since its WASM decoder reorders B-frames internally regardless. Real Hanwha
  // encoders don't use B-frames for low-latency streaming, so this setting has no camera
  // equivalent either way.
  const bFramesArg = bFrames ? '' : ':bframes=0';
  switch (codec) {
    case 'MJPEG':
      return ['-c:v', encoder, '-q:v', '5', ...scale];
    case 'H264':
      // repeat-headers makes libx264 embed SPS/PPS in-band before every keyframe (confirmed empirically — the
      // `dump_extra` bitstream filter was tried first but only fires once at stream start, not per keyframe, so a
      // player joining mid-stream would still never see one). Without this, ffmpeg's rtsp muxer only declares
      // SPS/PPS out-of-band via SDP sprop-parameter-sets, which this player's H264Session never reads — matching
      // real IP camera encoders (which normally repeat parameter sets in-band) is what the player actually expects.
      //
      // force_key_frames forces a keyframe every 2s of output regardless of scene-cut detection — libx264's default
      // adaptive GOP sizing was observed producing keyframes over 5s apart on low-motion source video, longer than
      // the bridge's keyframe-gate timeout (KEYFRAME_GATE_TIMEOUT_MS), so a viewer joining mid-GOP could receive
      // non-keyframe slices with no cached SPS/PPS and fail to decode ("SPS payload is not available").
      return [
        '-c:v', encoder, '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
        '-x264-params', `repeat-headers=1${bFramesArg}`, '-force_key_frames', 'expr:gte(t,n_forced*2)', ...scale
      ];
    case 'H265':
      return [
        '-c:v', encoder, '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
        '-x265-params', `repeat-headers=1${bFramesArg}`, '-force_key_frames', 'expr:gte(t,n_forced*2)', ...scale
      ];
    // force_key_frames (VP8/VP9/AV1): same rationale as H264/H265 above, confirmed empirically —
    // without it, libvpx/libaom's default GOP sizing on this source produced *zero* keyframes in
    // 15-20s of playback, so a viewer connecting mid-stream could go a long time without ever
    // receiving one. VP8/VP9/AV1 have no in-band-parameter-set concept (unlike H264/H265's SPS/PPS
    // repeat-headers), but each keyframe is otherwise the *only* place the player can read a frame's
    // real width/height from (see player-side `VP8HeaderParser`/`VP9HeaderParser`/`AV1HeaderParser`)
    // and the only frame type a fresh `VideoDecoder` can start decoding from at all — so the need for
    // a reachable keyframe soon after connecting is, if anything, stricter here than for H264/H265.
    // -strict experimental (AV1): ffmpeg's RTP/RTSP muxer marks its AV1 payloader experimental,
    // same as VP9 below — confirmed live on ffmpeg 9.0, the first version whose muxer has an
    // AV1 rtpmap entry at all (4.4.2/7.1.1 had none, see README.md's "External tools" section).
    // Without this flag: "Packetizing AV1 is experimental ... Could not write header ... Experimental feature".
    case 'AV1':
      return encoder === 'libsvtav1'
        ? ['-c:v', encoder, '-preset', '10', '-pix_fmt', 'yuv420p', '-strict', 'experimental', '-force_key_frames', 'expr:gte(t,n_forced*2)', ...scale]
        : ['-c:v', encoder, '-cpu-used', '8', '-pix_fmt', 'yuv420p', '-strict', 'experimental', '-force_key_frames', 'expr:gte(t,n_forced*2)', ...scale];
    case 'VP8':
      return ['-c:v', encoder, '-deadline', 'realtime', '-cpu-used', '5', '-force_key_frames', 'expr:gte(t,n_forced*2)', ...scale];
    case 'VP9':
      // -strict experimental: ffmpeg's RTP/RTSP muxer marks its VP9 payloader (RFC-draft, never
      // finalized as an RFC) experimental and refuses to write the output header without this —
      // confirmed live: omitting it fails every VP9 session with "Packetizing VP9 is experimental
      // ... Could not write header for output file #0 ... Experimental feature", never reaching
      // MediaMTX at all.
      return [
        '-c:v', encoder, '-deadline', 'realtime', '-cpu-used', '5', '-pix_fmt', 'yuv420p', '-strict', 'experimental',
        '-force_key_frames', 'expr:gte(t,n_forced*2)', ...scale
      ];
  }
}

/** G.726 only actually supports 16/24/32/40 kbps — anything else ffmpeg's
 * encoder rejects outright, so round to the nearest supported rate instead
 * of failing the whole session over an off-ladder bitrate request. */
function nearestG726Bitrate(requestedKbps: number): number {
  const supported = [16, 24, 32, 40];
  return supported.reduce((best, rate) => (Math.abs(rate - requestedKbps) < Math.abs(best - requestedKbps) ? rate : best));
}

function audioEncoderArgs(codec: AudioCodec, encoder: string, bitrateKbps: number): string[] {
  switch (codec) {
    case 'OPUS':
      return ['-c:a', encoder, '-b:a', `${bitrateKbps}k`, '-ar', '48000', '-ac', '2'];
    case 'AAC':
      // -ac 2: YouTube's higher-quality audio formats are sometimes 5.1
      // (e.g. itag 258), which would otherwise pass through unchanged and
      // surprise RTSP-over-WebSocket clients expecting stereo.
      return ['-c:a', encoder, '-b:a', `${bitrateKbps}k`, '-ar', '48000', '-ac', '2'];
    case 'G711':
      // Fixed-rate PCM companding (64kbps @ 8kHz mono) — there is no bitrate
      // knob to turn, the requested audioBitrateKbps is intentionally unused.
      return ['-c:a', encoder, '-ar', '8000', '-ac', '1'];
    case 'G726':
      return ['-c:a', encoder, '-b:a', `${nearestG726Bitrate(bitrateKbps)}k`, '-ar', '8000', '-ac', '1'];
  }
}

/** yt-dlp's own downloader (not a raw googlevideo URL handed to ffmpeg) is
 * used deliberately — resolving a direct URL via `yt-dlp -g` and passing
 * that to ffmpeg's `-i` used to 403 (confirmed live): YouTube's CDN ties
 * those URLs to internal request context (headers/cookies/PO token
 * bookkeeping) that only yt-dlp's own HTTP client reliably reproduces.
 * Piping `yt-dlp ... -o -` into ffmpeg's stdin sidesteps that entirely —
 * yt-dlp does the fetching (and, for a DASH video+audio pair, the muxing)
 * and this process only ever sees the resulting bytes. */
function buildYtDlpArgs(youtubeUrl: string, targetHeight: number, useMwebClient: boolean): string[] {
  // Prefer an avc1 (H.264) *source* codec over YouTube's plain "bestvideo"
  // (usually VP9 or AV1 at a given height) — independent of the requested
  // *output* codec, decoding VP9/AV1 is itself unreliable on some ffmpeg
  // builds (confirmed live: this project's ffmpeg 4.4.4 build's AV1 decoder
  // fails outright — "thread_get_buffer() failed" — on YouTube's AV1
  // formats), so avc1 is tried first and only falls back to "whatever's
  // best" if no avc1 source exists at this height.
  const formatSelector =
    `bestvideo[height<=${targetHeight}][vcodec^=avc1]+bestaudio/` +
    `bestvideo[height<=${targetHeight}]+bestaudio/` +
    `best[height<=${targetHeight}]`;
  // mp4, confirmed empirically: yt-dlp's --merge-output-format only accepts
  // a handful of named containers, and only mp4 actually produces bytes
  // when piped to stdout here — mkv silently emits 0 bytes and "ffmpeg
  // exited with code 1" (yt-dlp's own internal merge step needs seek
  // capability mkv's muxer doesn't have in pipe mode). mp4 isn't natively
  // streamable either (moov atom normally needs to be written after seeking
  // back to the start), but yt-dlp/ffmpeg transparently fall back to an
  // MPEG-TS-compatible bytestream for non-seekable (pipe) output, which is
  // exactly what this needs — ffmpeg auto-detects the actual container on
  // the reading end (`-i pipe:0`) regardless of the "mp4" label.
  const args = ['-f', formatSelector];
  // player_client=mweb — ONLY added when the caller (startTranscode, via
  // canUseMwebClient()) has confirmed both a PO Token provider and a JS
  // runtime are actually available. Forcing mweb without those is *worse*
  // than the default: confirmed live (2026-08-25) that mweb alone (no PO
  // Token, no JS runtime for the "n" challenge) fails outright with "No
  // video formats found!", even for a video the *default* (unforced) client
  // mix handles fine. With both available, though, mweb reliably beats the
  // default: yt-dlp's default (no player_client override) mixes formats
  // from multiple YouTube "clients", and for a same-numbered itag can end
  // up keeping an android_vr-origin URL over an equally-available
  // mweb-origin one — and that android_vr URL 403s regardless of PO Token/JS
  // runtime (unlike mweb/web, yt-dlp doesn't request it a PO Token at all).
  // mweb (unlike the plain "web" client) also exposes the full DASH ladder
  // up to source resolution rather than degrading to a 360p progressive
  // fallback. See CLAUDE.md's "Environment gotchas" and MEMORY.md for the
  // full investigation (including two prior explanations — no JS runtime,
  // then no PO Token — that were each necessary but not sufficient alone).
  if (useMwebClient) args.push('--extractor-args', 'youtube:player_client=mweb');
  args.push('--merge-output-format', 'mp4', '-o', '-', '--no-playlist', '--no-part', '--quiet', '--no-warnings', youtubeUrl);
  return args;
}

const DENO_BIN_DIR = join(homedir(), '.deno', 'bin');

function hasDeno(): boolean {
  return existsSync(join(DENO_BIN_DIR, 'deno'));
}

/** Quick, short-timeout reachability check for the bgutil-ytdlp-pot-provider
 * HTTP server (scripts/ensure-bgutil-pot-provider.js) — used to decide
 * whether forcing player_client=mweb (see buildYtDlpArgs) is safe, not to
 * actually fetch a token (yt-dlp's own plugin does that). */
function potProviderReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpGet(`http://127.0.0.1:${BGUTIL_POT_PROVIDER_PORT}/ping`, { timeout: 1000 }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 0) < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => req.destroy());
  });
}

/** yt-dlp needs a JS runtime (deno) on PATH to solve YouTube's signature/"n"
 * challenge for the mweb client above — not just a nice-to-have here (see
 * buildYtDlpArgs's comment). Rather than depending on whatever PATH the
 * shell that launched this Node process happened to have (bitten by exactly
 * this once already — a stale server process silently missing it, see
 * MEMORY.md), explicitly prepend deno's well-known user-local install
 * location if it exists, so this works regardless of shell setup. Safe to
 * add unconditionally (independent of the mweb decision above) — having
 * deno available can only help yt-dlp's default client mix too. */
function ytDlpEnv(): NodeJS.ProcessEnv {
  if (!hasDeno()) return process.env;
  return { ...process.env, PATH: `${DENO_BIN_DIR}:${process.env.PATH ?? ''}` };
}

async function buildFfmpegArgs(session: Session): Promise<string[]> {
  const { request } = session;
  const videoEncoder = await getVideoEncoder(request.videoCodec);
  const audioEncoder = await getAudioEncoder(request.audioCodec);
  if (!videoEncoder) throw new Error(`no ffmpeg encoder available for video codec ${request.videoCodec}`);
  if (!audioEncoder) throw new Error(`no ffmpeg encoder available for audio codec ${request.audioCodec}`);

  const rtspUrl = `rtsp://${MEDIAMTX_HOST}:${MEDIAMTX_RTSP_PORT}/${session.mediaMtxPath}`;

  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-stats',
    '-re',
    '-i',
    'pipe:0',
    '-map',
    '0:v:0',
    '-map',
    '0:a:0',
    ...videoEncoderArgs(request.videoCodec, videoEncoder, request.resolutionHeight, request.bFrames !== false),
    ...audioEncoderArgs(request.audioCodec, audioEncoder, request.audioBitrateKbps),
    '-f',
    'rtsp',
    '-rtsp_transport',
    'tcp',
    rtspUrl
  ];
}

export async function startTranscode(session: Session): Promise<void> {
  const tag = session.id.slice(0, 8);
  // Both must be true — see buildYtDlpArgs's comment for why mweb alone
  // (missing either) is worse than not forcing a client at all.
  const useMwebClient = hasDeno() && (await potProviderReachable());
  console.log(
    `[transcodeSession][${tag}] player_client=${useMwebClient ? 'mweb (deno + PO Token provider both available)' : 'default (deno and/or PO Token provider unavailable — forcing mweb would be worse)'}`
  );
  const ytDlpArgs = buildYtDlpArgs(session.request.youtubeUrl, session.request.resolutionHeight, useMwebClient);
  const ffmpegArgs = await buildFfmpegArgs(session);
  console.log(`[transcodeSession][${tag}] yt-dlp ${ytDlpArgs.join(' ')}`);
  console.log(`[transcodeSession][${tag}] ffmpeg ${ffmpegArgs.join(' ')}`);

  // detached: true puts yt-dlp in its own process group (pgid === its own
  // pid) so killPid(..., group: true) below can also reach the *internal* ffmpeg
  // yt-dlp itself spawns to merge the separately-fetched video/audio DASH
  // streams — a grandchild this module never gets a ChildProcess handle to.
  // Without this, killing yt-dlp only signals yt-dlp; that merge ffmpeg was
  // observed surviving as an orphan (reparented to init) after a
  // timed-out/stopped session, still stuck mid-fetch from googlevideo.
  const ytDlp = spawn(resolveYtDlpBinary(), ytDlpArgs, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: ytDlpEnv() });
  const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
  processes.set(session.id, { ytDlp, ffmpeg });

  ytDlp.stdout.pipe(ffmpeg.stdin);
  // If ffmpeg exits/closes stdin first (e.g. it failed fast), yt-dlp would
  // otherwise crash the process on EPIPE the next time it writes.
  ffmpeg.stdin.on('error', () => {
    /* swallowed — expected once ffmpeg has already exited */
  });

  let settled = false;
  const startupTimer = setTimeout(() => {
    if (!settled) {
      settled = true;
      sessionStore.updateStatus(session.id, 'failed', `ffmpeg produced no output within ${TRANSCODE_STARTUP_TIMEOUT_MS}ms`);
      stopTranscode(session.id);
    }
  }, TRANSCODE_STARTUP_TIMEOUT_MS);

  const onProgressLine = (line: string): void => {
    if (!settled && /frame=\s*\d+/.test(line)) {
      settled = true;
      clearTimeout(startupTimer);
      sessionStore.updateStatus(session.id, 'live');
      console.log(`[transcodeSession][${tag}] live -> rtsp://${MEDIAMTX_HOST}:${MEDIAMTX_RTSP_PORT}/${session.mediaMtxPath}`);
    }
  };

  // The *first* ffmpeg stderr line that looks like an actual failure (not
  // just the last non-empty line — confirmed live: on a real failure ffmpeg
  // prints the real cause once (e.g. "Could not write header for output
  // file #0 ... Server returned 400 Bad Request") followed by unrelated
  // shutdown noise from other streams (e.g. "[aac ...] N frames left in the
  // queue on closing"), and the *last* line is that noise, not the cause).
  // Folded into the generic "exited with code N" failure message below —
  // without this, a failure's actual cause only ever showed up in the
  // server's own console log, not in the session status the API/UI surfaces.
  let firstFfmpegErrorLine = '';
  ffmpeg.stderr.setEncoding('utf8');
  ffmpeg.stderr.on('data', (chunk: string) => {
    for (const line of chunk.split(/\r|\n/)) {
      const trimmed = line.trim();
      if (trimmed) {
        console.log(`[ffmpeg][${tag}] ${trimmed}`);
        if (!firstFfmpegErrorLine && /error|could not|failed/i.test(trimmed)) firstFfmpegErrorLine = trimmed;
      }
      onProgressLine(line);
    }
  });
  ytDlp.stderr.setEncoding('utf8');
  ytDlp.stderr.on('data', (chunk: string) => {
    for (const line of chunk.split(/\r|\n/)) {
      if (line.trim()) console.log(`[yt-dlp][${tag}] ${line.trim()}`);
    }
  });

  const fail = (message: string): void => {
    if (settled && sessionStore.getSession(session.id)?.status === 'live') {
      // Already live and something exited afterward — handled by the
      // generic 'exit' handlers below as a stop/failure, not a startup
      // failure (the startup timer/settled flag is startup-phase-only).
      return;
    }
    settled = true;
    clearTimeout(startupTimer);
    sessionStore.updateStatus(session.id, 'failed', message);
    // killProcesses(), not stopTranscode() — stopTranscode also forces
    // status to 'stopped', which would immediately clobber the 'failed'
    // status just set above (confirmed live: a failed session's UI showed
    // status=stopped with the failure message still attached as .error).
    killProcesses(session.id);
  };

  ytDlp.on('error', (err) => fail(`yt-dlp failed to start: ${err.message}`));
  ffmpeg.on('error', (err) => fail(`ffmpeg failed to start: ${err.message}`));

  ytDlp.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) fail(signal ? `yt-dlp killed by ${signal}` : `yt-dlp exited with code ${code}`);
  });

  ffmpeg.on('exit', (code, signal) => {
    clearTimeout(startupTimer);
    processes.delete(session.id);
    if (!ytDlp.killed && typeof ytDlp.pid === 'number') killPid(ytDlp.pid, 'SIGTERM', true);
    const current = sessionStore.getSession(session.id);
    if (current && current.status !== 'stopped') {
      const reason = signal ? `ffmpeg killed by ${signal}` : `ffmpeg exited with code ${code}`;
      const message = code !== 0 && firstFfmpegErrorLine ? `${reason}: ${firstFfmpegErrorLine}` : reason;
      sessionStore.updateStatus(session.id, code === 0 ? 'stopped' : 'failed', message);
    }
  });
}

/** Signals `pid` (or, if `group` is true, its whole process group via a
 * negative pid — reaches a grandchild spawned internally, e.g. yt-dlp's own
 * merge ffmpeg for split video/audio streams, that this module never gets a
 * handle to), escalating to SIGKILL ~3s later if it's still around. A stuck
 * fetch/merge can land in an uninterruptible (D-state) sleep that ignores
 * SIGTERM until its blocking syscall returns — confirmed live for *both*
 * this module's own encoding ffmpeg and yt-dlp's internal merge ffmpeg, each
 * surviving a lone SIGTERM and only clearing on SIGKILL.
 *
 * Deliberately does not check whether the tracked ChildProcess has already
 * exited before signaling: for the grouped case that was the actual bug —
 * yt-dlp routinely exits (handing off to/having already spawned its merge
 * ffmpeg) well before that ffmpeg finishes, so bailing out once yt-dlp
 * itself was gone meant the group kill never even ran, leaving the merge
 * ffmpeg to be orphaned every time instead of just when it wedged. */
function killPid(pid: number, signal: NodeJS.Signals, group: boolean): void {
  const send = (sig: NodeJS.Signals): void => {
    try {
      process.kill(group ? -pid : pid, sig);
    } catch {
      // ESRCH — process (or, for a group kill, every member of it) already gone.
    }
  };
  send(signal);
  if (signal === 'SIGKILL') return;
  setTimeout(() => send('SIGKILL'), 3000).unref();
}

/** Kills this session's yt-dlp/ffmpeg children without touching its status
 * — used where the caller (e.g. fail()) is setting its own status and a
 * forced 'stopped' would overwrite it. */
function killProcesses(sessionId: string): void {
  const running = processes.get(sessionId);
  if (!running) return;
  if (typeof running.ffmpeg.pid === 'number') killPid(running.ffmpeg.pid, 'SIGTERM', false);
  if (typeof running.ytDlp.pid === 'number') killPid(running.ytDlp.pid, 'SIGTERM', true);
  processes.delete(sessionId);
}

export function stopTranscode(sessionId: string): void {
  if (!processes.has(sessionId)) return;
  sessionStore.updateStatus(sessionId, 'stopped');
  killProcesses(sessionId);
}

export function isRunning(sessionId: string): boolean {
  return processes.has(sessionId);
}

/** Stops every currently-running session's yt-dlp/ffmpeg children — called
 * on server shutdown (see index.ts's SIGTERM/SIGINT handler) so `npm run
 * stop:server` (or a restart) can't leave them orphaned: Node doesn't kill a
 * process's children automatically when the process itself is killed. */
export function stopAllTranscodes(): void {
  for (const sessionId of Array.from(processes.keys())) {
    stopTranscode(sessionId);
  }
}
