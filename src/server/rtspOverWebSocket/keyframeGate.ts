/**
 * Video keyframe gating (H.264/H.265). Ported near-verbatim from the
 * equivalent gating logic in a sibling camera-streaming server this
 * project's RTSP paths share heritage with (see that project's own
 * source for the full rationale): a brand-new RTSP-over-WebSocket viewer
 * opens a fresh MediaMTX reader session,
 * and MediaMTX does not wait for the next keyframe before forwarding
 * whatever the live GOP is doing "now" — without this gate, RtspClient.ts
 * would receive non-keyframe slices with no cached SPS/PPS (H.264) or
 * VPS/SPS/PPS (H.265) and fail to decode until the encoder's next GOP
 * boundary. These functions parse just enough of RTP/H.264 (RFC 6184) or
 * RTP/H.265 (RFC 7798) to hold back non-keyframe video packets until the
 * first keyframe (or an aggregate containing one) passes, then the caller
 * reverts to a plain relay for the rest of the connection. Every failure
 * mode (codec not confirmed H264/H265, gate timeout) fails OPEN — this is a
 * noise/latency optimization, never a hard requirement for playback.
 */

export interface SdpVideoTrack {
  control: string;
  codec: 'H264' | 'H265';
}

/** Finds the video media block in a DESCRIBE response's SDP body and
 * returns its `a=control:` value (used to match this track's later SETUP
 * request) plus which codec its rtpmap declares. Returns null for no video
 * block, or a codec that is neither (e.g. MJPEG/VP8/VP9/AV1) — gating stays
 * disabled for those, since the NAL parsing below is H.264/H.265-specific. */
export function parseSdpVideoTrack(sdpBody: string): SdpVideoTrack | null {
  const lines = sdpBody.split(/\r?\n/);
  let inVideo = false;
  let control: string | null = null;
  let codec: 'H264' | 'H265' | null = null;
  for (const line of lines) {
    if (/^m=video\b/.test(line)) {
      inVideo = true;
      continue;
    }
    if (/^m=/.test(line)) {
      if (inVideo) break;
      continue;
    }
    if (!inVideo) continue;
    const rtpmap = line.match(/^a=rtpmap:\d+\s+([\w-]+)\//i);
    if (rtpmap) {
      if (/^H264$/i.test(rtpmap[1])) codec = 'H264';
      else if (/^(H265|HEVC)$/i.test(rtpmap[1])) codec = 'H265';
    }
    const ctrl = line.match(/^a=control:(\S+)/i);
    if (ctrl) control = ctrl[1];
  }
  return control && codec ? { control, codec } : null;
}

/** Reads the RTP fixed header (RFC 3550 §5.1) and returns the payload that
 * follows it (CSRC list + optional extension header skipped). Returns null
 * if the packet is too short to hold what it claims to. */
export function rtpPayload(packet: Buffer): Buffer | null {
  if (packet.length < 12) return null;
  const cc = packet[0] & 0x0f;
  let offset = 12 + cc * 4;
  if (packet.length < offset) return null;
  const hasExtension = (packet[0] & 0x10) !== 0;
  if (hasExtension) {
    if (packet.length < offset + 4) return null;
    const extWords = packet.readUInt16BE(offset + 2);
    offset += 4 + extWords * 4;
  }
  return packet.length > offset ? packet.slice(offset) : null;
}

export interface GateDecision {
  forward: boolean;
  opensGate: boolean;
}

const H264_NON_IDR_SLICE_TYPES = new Set([1, 2, 3, 4, 19, 20]);

export function classifyH264RtpPacket(packet: Buffer): GateDecision {
  const payload = rtpPayload(packet);
  if (!payload || payload.length === 0) return { forward: true, opensGate: false };
  const nalType = payload[0] & 0x1f;

  if (nalType === 24) {
    // STAP-A aggregate — scan entries for an embedded IDR/SPS/PPS. Forwarding
    // unconditionally here was a bug: it assumed STAP-A is only ever used to
    // bundle parameter sets ahead of a keyframe, but this repo's own demo
    // server packs plain non-IDR slices into STAP-A too, which let
    // pre-keyframe slice data leak through the gate while closed. An
    // aggregate of only ordinary slices must be dropped like a standalone
    // non-IDR slice would be; one carrying SPS/PPS/IDR is still forwarded
    // (and only an IDR opens the gate).
    let off = 1;
    let sawIdr = false;
    let sawParamOrIdr = false;
    while (off + 2 <= payload.length) {
      const size = payload.readUInt16BE(off);
      off += 2;
      if (off + size > payload.length) break;
      const innerType = payload[off] & 0x1f;
      if (innerType === 5) sawIdr = true;
      if (innerType === 5 || innerType === 7 || innerType === 8) sawParamOrIdr = true;
      off += size;
    }
    return { forward: sawParamOrIdr, opensGate: sawIdr };
  }
  if (nalType === 28) {
    // FU-A fragment — original NAL type lives in the FU header byte
    if (payload.length < 2) return { forward: true, opensGate: false };
    const fragType = payload[1] & 0x1f;
    if (H264_NON_IDR_SLICE_TYPES.has(fragType)) return { forward: false, opensGate: false };
    return { forward: true, opensGate: fragType === 5 };
  }
  if (H264_NON_IDR_SLICE_TYPES.has(nalType)) return { forward: false, opensGate: false };
  return { forward: true, opensGate: nalType === 5 };
}

function isH265NonIrapVcl(nalType: number): boolean {
  return nalType <= 15;
}
function isH265Irap(nalType: number): boolean {
  return nalType >= 16 && nalType <= 23;
}

export function classifyH265RtpPacket(packet: Buffer): GateDecision {
  const payload = rtpPayload(packet);
  if (!payload || payload.length < 2) return { forward: true, opensGate: false };
  const nalType = (payload[0] >> 1) & 0x3f;

  if (nalType === 48) {
    // Aggregation Packet (RFC 7798 §4.4.2) — assumes no DONL field. Same fix
    // as classifyH264RtpPacket's STAP-A handling: only forward if it carries
    // an IRAP or a VPS/SPS/PPS parameter set, not unconditionally.
    let off = 2;
    let sawIrap = false;
    let sawParamOrIrap = false;
    while (off + 2 <= payload.length) {
      const size = payload.readUInt16BE(off);
      off += 2;
      if (off + size > payload.length || size < 2) break;
      const innerType = (payload[off] >> 1) & 0x3f;
      if (isH265Irap(innerType)) sawIrap = true;
      if (isH265Irap(innerType) || innerType === 32 || innerType === 33 || innerType === 34) sawParamOrIrap = true;
      off += size;
    }
    return { forward: sawParamOrIrap, opensGate: sawIrap };
  }
  if (nalType === 49) {
    // Fragmentation Unit (RFC 7798 §4.4.3) — 2-byte NAL header + 1-byte FU header
    if (payload.length < 3) return { forward: true, opensGate: false };
    const fragType = payload[2] & 0x3f;
    if (isH265NonIrapVcl(fragType)) return { forward: false, opensGate: false };
    return { forward: true, opensGate: isH265Irap(fragType) };
  }
  if (isH265NonIrapVcl(nalType)) return { forward: false, opensGate: false };
  return { forward: true, opensGate: isH265Irap(nalType) };
}

export function classifyVideoRtpPacket(videoCodec: 'H264' | 'H265', packet: Buffer): GateDecision {
  return videoCodec === 'H265' ? classifyH265RtpPacket(packet) : classifyH264RtpPacket(packet);
}
