export type VideoCodec = 'MJPEG' | 'H264' | 'H265' | 'AV1' | 'VP8' | 'VP9';
export type AudioCodec = 'OPUS' | 'AAC' | 'G711' | 'G726';

export interface ResolutionOption {
  /** Human label, e.g. "8K", "1080p". */
  label: string;
  height: number;
  /** 16:9 width derived from height; informational only — ffmpeg scales by height. */
  width: number;
}

/** Full ladder this server is willing to offer, independent of what any
 * particular source video actually has available (see YoutubeProbeResult.
 * availableResolutions for the intersection with the real source). */
export const RESOLUTION_LADDER: ResolutionOption[] = [
  { label: '8K', height: 4320, width: 7680 },
  { label: '4K', height: 2160, width: 3840 },
  { label: '1440p', height: 1440, width: 2560 },
  { label: '1080p', height: 1080, width: 1920 },
  { label: '720p', height: 720, width: 1280 },
  { label: '480p', height: 480, width: 854 },
  { label: '360p', height: 360, width: 640 },
  { label: '240p', height: 240, width: 426 },
  { label: '144p', height: 144, width: 256 }
];

export interface YoutubeProbeResult {
  youtubeUrl: string;
  videoId: string;
  title: string;
  durationSec: number | null;
  maxHeight: number;
  /** RESOLUTION_LADDER entries whose height is <= maxHeight (upscaling past
   * the source is still allowed at session-creation time; this list is just
   * "what the source actually has natively"). */
  availableResolutions: ResolutionOption[];
  sourceVideoCodecs: string[];
  sourceAudioCodecs: string[];
}

export interface CodecAvailability {
  codec: VideoCodec | AudioCodec;
  ffmpegEncoder: string;
  available: boolean;
  reason?: string;
}

export interface CreateSessionRequest {
  youtubeUrl: string;
  resolutionHeight: number;
  videoCodec: VideoCodec;
  audioCodec: AudioCodec;
  /** kbps */
  audioBitrateKbps: number;
  /** RTSP-over-WebSocket digest credentials this session will accept. */
  username: string;
  password: string;
}

export type SessionStatus = 'starting' | 'live' | 'stopped' | 'failed';

export interface Session {
  id: string;
  /** Numeric channel this session is reachable at over RTSP-over-WebSocket —
   * matches the channel segment RtspClient.ts embeds in its request URI
   * (device="nvr" mode: /LiveChannel/<channel>/media.smp/...). 0-based here
   * (the wire value) — the <rtsp-over-websocket> `channel` attribute/UI
   * fields are 1-based; RtspClient.ts subtracts 1 before building the URI. */
  channel: number;
  status: SessionStatus;
  request: CreateSessionRequest;
  probe: Pick<YoutubeProbeResult, 'title' | 'durationSec' | 'maxHeight'>;
  /** MediaMTX publish path this session's ffmpeg process pushes to. */
  mediaMtxPath: string;
  createdAt: string;
  error?: string;
}

export interface PublicSession extends Omit<Session, 'request'> {
  request: Omit<CreateSessionRequest, 'password'>;
  /** Whether this session's ffmpeg child process is actually alive right
   * now (transcodeSession.ts's isRunning()) — distinct from `status`:
   * 'starting' covers the async yt-dlp-resolve-then-spawn window before
   * ffmpeg exists yet, and 'live'/'failed' can both lag behind an ffmpeg
   * process exiting until the next status poll notices. */
  isRunning: boolean;
}
