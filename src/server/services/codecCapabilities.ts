import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AudioCodec, CodecAvailability, VideoCodec } from '../types';

const execFileAsync = promisify(execFile);

/** Preferred ffmpeg encoder per codec. Some codecs have more than one
 * plausible encoder across ffmpeg builds (e.g. AV1: libaom-av1 vs
 * libsvtav1) — VIDEO_ENCODER_CANDIDATES lists them in preference order,
 * and detectCapabilities() picks the first one the installed ffmpeg
 * actually has. */
const VIDEO_ENCODER_CANDIDATES: Record<VideoCodec, string[]> = {
  MJPEG: ['mjpeg'],
  H264: ['libx264'],
  H265: ['libx265'],
  AV1: ['libsvtav1', 'libaom-av1', 'av1_nvenc'],
  VP8: ['libvpx'],
  VP9: ['libvpx-vp9']
};

const AUDIO_ENCODER_CANDIDATES: Record<AudioCodec, string[]> = {
  OPUS: ['libopus'],
  AAC: ['libfdk_aac', 'aac'],
  // "G.711" covers both mu-law and A-law companding; mu-law (PCMU) is what
  // this project's other RTSP paths use ("audio: G.711" for a PCMU track
  // in this server's own camera-streaming logs), so it's the default
  // encoder here.
  G711: ['pcm_mulaw'],
  G726: ['g726', 'adpcm_g726']
};

let cache: { videoEncoders: Map<VideoCodec, string | null>; audioEncoders: Map<AudioCodec, string | null> } | null = null;

async function listFfmpegEncoderNames(): Promise<Set<string>> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('ffmpeg', ['-hide_banner', '-encoders']));
  } catch (error) {
    console.warn(`[codecCapabilities] ffmpeg not runnable (${error instanceof Error ? error.message : String(error)}) — reporting all codecs as unavailable`);
    return new Set();
  }
  const names = new Set<string>();
  for (const line of stdout.split('\n')) {
    // Encoder lines look like " VFS... mjpeg   MJPEG (Motion JPEG)" — a
    // fixed 6-character flag field (V/A/S media type plus any of
    // F/S/X/B/D capability flags, '.' for unset) followed by the encoder
    // name. Match on width (\S{6}) rather than enumerating flag letters —
    // an earlier version of this regex only allowed [VAS.], which silently
    // dropped every encoder whose flags included F/X/B/D (e.g. mjpeg's
    // "VFS...").
    const m = line.match(/^\s*\S{6}\s+(\S+)/);
    if (m) names.add(m[1]);
  }
  return names;
}

async function detectCapabilities(): Promise<NonNullable<typeof cache>> {
  if (cache) return cache;
  const names = await listFfmpegEncoderNames();

  const videoEncoders = new Map<VideoCodec, string | null>();
  for (const [codec, candidates] of Object.entries(VIDEO_ENCODER_CANDIDATES) as [VideoCodec, string[]][]) {
    videoEncoders.set(codec, candidates.find((c) => names.has(c)) ?? null);
  }

  const audioEncoders = new Map<AudioCodec, string | null>();
  for (const [codec, candidates] of Object.entries(AUDIO_ENCODER_CANDIDATES) as [AudioCodec, string[]][]) {
    audioEncoders.set(codec, candidates.find((c) => names.has(c)) ?? null);
  }

  cache = { videoEncoders, audioEncoders };
  return cache;
}

export async function getVideoEncoder(codec: VideoCodec): Promise<string | null> {
  return (await detectCapabilities()).videoEncoders.get(codec) ?? null;
}

export async function getAudioEncoder(codec: AudioCodec): Promise<string | null> {
  return (await detectCapabilities()).audioEncoders.get(codec) ?? null;
}

export async function listCapabilities(): Promise<{ video: CodecAvailability[]; audio: CodecAvailability[] }> {
  const { videoEncoders, audioEncoders } = await detectCapabilities();

  const video: CodecAvailability[] = Array.from(videoEncoders.entries()).map(([codec, encoder]) => ({
    codec,
    ffmpegEncoder: encoder ?? VIDEO_ENCODER_CANDIDATES[codec][0],
    available: encoder !== null,
    reason: encoder === null ? 'installed ffmpeg build has no encoder for this codec' : undefined
  }));

  const audio: CodecAvailability[] = Array.from(audioEncoders.entries()).map(([codec, encoder]) => ({
    codec,
    ffmpegEncoder: encoder ?? AUDIO_ENCODER_CANDIDATES[codec][0],
    available: encoder !== null,
    reason: encoder === null ? 'installed ffmpeg build has no encoder for this codec' : undefined
  }));

  return { video, audio };
}
