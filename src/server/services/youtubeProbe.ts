import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveYtDlpBinary } from '../config';
import { RESOLUTION_LADDER } from '../types';
import type { YoutubeProbeResult } from '../types';

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 30000;

interface YtDlpFormat {
  height?: number | null;
  vcodec?: string | null;
  acodec?: string | null;
}

interface YtDlpInfo {
  id: string;
  title: string;
  duration?: number | null;
  formats: YtDlpFormat[];
}

export function extractVideoId(youtubeUrl: string): string {
  try {
    const url = new URL(youtubeUrl);
    if (url.hostname.includes('youtu.be')) return url.pathname.replace(/^\//, '');
    const v = url.searchParams.get('v');
    if (v) return v;
  } catch {
    // fall through — not a real URL, just use the raw string as an id-ish fallback
  }
  return youtubeUrl;
}

/** Shortens a yt-dlp vcodec/acodec string ("avc1.4d401f", "av01.0.05M.08")
 * down to the family name ("avc1", "av01") for a readable probe summary. */
function codecFamily(codec: string): string {
  return codec.split('.')[0];
}

const YT_DLP_STALE_WARNING_DAYS = 180;

export async function getYtDlpVersion(): Promise<string> {
  const { stdout } = await execFileAsync(resolveYtDlpBinary(), ['--version']);
  return stdout.trim();
}

/** yt-dlp's version string is its release date (YYYY.MM.DD) — YouTube changes
 * extraction/CDN behavior often enough that a build more than a few months
 * old routinely starts failing (confirmed live: a 2022.04.08 build hit both
 * outright "Precondition check failed" 400s on probe and silent multi-minute
 * hangs mid-download), so this is checked at startup instead of only
 * surfacing later as a confusing probe/transcode error. Returns false (don't
 * warn) for a version string that isn't a YYYY.MM.DD date — e.g. a git/dev
 * build — since its actual age can't be determined this way. */
export function isYtDlpVersionStale(version: string): boolean {
  const match = version.match(/^(\d{4})\.(\d{2})\.(\d{2})/);
  if (!match) return false;
  const [, y, m, d] = match;
  const releaseDate = new Date(Number(y), Number(m) - 1, Number(d));
  const ageDays = (Date.now() - releaseDate.getTime()) / (1000 * 60 * 60 * 24);
  return ageDays > YT_DLP_STALE_WARNING_DAYS;
}

export async function probeYoutubeVideo(youtubeUrl: string): Promise<YoutubeProbeResult> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(resolveYtDlpBinary(), ['-j', '--no-playlist', youtubeUrl], {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`yt-dlp probe failed for "${youtubeUrl}": ${message}`);
  }

  let info: YtDlpInfo;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new Error(`yt-dlp probe returned non-JSON output for "${youtubeUrl}"`);
  }

  const heights = (info.formats || [])
    .map((f) => f.height)
    .filter((h): h is number => typeof h === 'number' && h > 0);
  const maxHeight = heights.length > 0 ? Math.max(...heights) : 0;
  if (maxHeight === 0) {
    throw new Error(`yt-dlp reported no video formats with a known resolution for "${youtubeUrl}"`);
  }

  const availableResolutions = RESOLUTION_LADDER.filter((r) => r.height <= maxHeight);

  const sourceVideoCodecs = Array.from(
    new Set((info.formats || []).map((f) => f.vcodec).filter((c): c is string => !!c && c !== 'none').map(codecFamily))
  ).sort();
  const sourceAudioCodecs = Array.from(
    new Set((info.formats || []).map((f) => f.acodec).filter((c): c is string => !!c && c !== 'none').map(codecFamily))
  ).sort();

  return {
    youtubeUrl,
    videoId: info.id,
    title: info.title,
    durationSec: typeof info.duration === 'number' ? info.duration : null,
    maxHeight,
    availableResolutions,
    sourceVideoCodecs,
    sourceAudioCodecs
  };
}

