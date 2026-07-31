/**
 * Type declarations for the vendored mux.js-derived fragmented-MP4 box
 * builder (the legacy player’s Util/mp4Generator.js, copied verbatim — not
 * rewritten, matching this migration's treatment of ffmpeg.js/ffmpegAAC.js/
 * minizip-asm.js). Shapes below reflect what videoTagPlayer.js actually
 * passes in, not the full internal box-building surface.
 */
export interface Mp4TimeStamp {
  rtpTimestamp?: number | string;
  timestamp?: number;
  timestamp_usec?: number;
  timezone?: number;
  utcTimeStamp?: number;
  mode?: string;
}

export interface Mp4Sample {
  size: number;
  frameData: Uint8Array;
  frameInfo?: unknown;
  timeStamp: Mp4TimeStamp;
  frameDuration?: number;
  duration?: number;
  rtpTimestamp?: number;
}

export interface Mp4VideoTrackInfo {
  id: number;
  width: number;
  height: number;
  type: 'video';
  codecType: string;
  sps: (Uint8Array | undefined)[];
  pps: (Uint8Array | undefined)[];
  profileIdc?: number;
  profileCompatibility?: number;
  levelIdc?: number;
  profileTierLevel?: number[];
  vps?: (Uint8Array | undefined)[];
}

export interface Mp4AudioTrackInfo {
  id: number;
  channelcount: number;
  samplesize: number;
  type: 'audio';
  codecType: string;
  audioobjecttype: number;
  samplingfrequencyindex: number;
  samplingDuration: number;
  interleavedId: number;
}

export interface Mp4BoxInfo {
  id: number;
  samples: Mp4Sample[];
  baseMediaDecodeTime: number;
  type: 'video' | 'audio';
  defaultSampleDuration?: number;
}

export function initSegment(tracks: (Mp4VideoTrackInfo | Mp4AudioTrackInfo)[]): Uint8Array;
export function mediaSegment(sequenceNumber: number, tracks: [Mp4BoxInfo], data: Uint8Array): Uint8Array;
export function dualTrackMediaSegment(sequenceNumber: number, tracks: [Mp4BoxInfo, Mp4BoxInfo], data: [Uint8Array, Uint8Array]): Uint8Array;
