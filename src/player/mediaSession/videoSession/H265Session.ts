import { RtpSession } from '../RtpSession';
import { parseRtpHeaderFlags, syncPlaybackTimestampFromRtpExtension } from '../rtpDepacketizeUtils';
import { RTSPOverWebSocketError } from '../../exceptions';

const HEVC_NAL = {
  VPS: 32,
  SPS: 33,
  PPS: 34,
  AUD: 35,
  AP: 48,
  UNSPEC49: 49
} as const;

const PREFIX = Uint8Array.from([0x00, 0x00, 0x00, 0x01]);
const SIZE_1_4K = Math.floor(1.4 * 1024);

export class H265Session extends RtpSession {
  private inputBuffer = new Uint8Array(SIZE_1_4K);
  private inputLength = 0;
  private playback = false;
  private vpsPayload: Uint8Array | null = null;
  private spsPayload: Uint8Array | null = null;
  private ppsPayload: Uint8Array | null = null;

  override init(): void {
    this.playback = false;
    this.timeData = { timestamp: null, timestamp_usec: null, timezone: null };
  }

  private setBuffer(chunk: Uint8Array): Uint8Array {
    if (this.inputLength + chunk.length > this.inputBuffer.length) {
      const tmp = this.inputBuffer;
      this.inputBuffer = new Uint8Array(tmp.length + chunk.length);
      this.inputBuffer.set(tmp, 0);
    }
    this.inputBuffer.set(chunk, this.inputLength);
    this.inputLength += chunk.length;
    return this.inputBuffer;
  }

  /** Buffers one already-unwrapped NAL unit (Annex-B prefixed) and, for
   * VPS/SPS/PPS, stashes its payload — shared between a standalone
   * single-NAL-unit RTP packet (the main `switch` below) and each NAL unit
   * an Aggregation Packet unpacks into (see HEVC_NAL.AP below). */
  private handleSingleNalUnit(nalType: number, nalUnit: Uint8Array): void {
    switch (nalType) {
      case HEVC_NAL.VPS:
        this.setBuffer(PREFIX);
        this.setBuffer(nalUnit);
        this.vpsPayload = nalUnit;
        break;
      case HEVC_NAL.SPS:
        this.setBuffer(PREFIX);
        this.setBuffer(nalUnit);
        this.spsPayload = nalUnit;
        break;
      case HEVC_NAL.PPS:
        this.setBuffer(PREFIX);
        this.setBuffer(nalUnit);
        this.ppsPayload = nalUnit;
        break;
      case HEVC_NAL.AUD:
        break;
      default:
        this.setBuffer(PREFIX);
        this.setBuffer(nalUnit);
        break;
    }
  }

  override depacketize(rtspInterleaved: Uint8Array, rtpHeader: Uint8Array, rtpPayload: Uint8Array): void {
    const flags = parseRtpHeaderFlags(rtpHeader);
    let paddingSize = 0;
    this.debugLog.debug('depacketize()', `bytes=${rtpPayload.length}`, `marker=${flags.markerBit}`);

    // NOTE: unlike H264Session, the legacy h265Session checks raw bits here
    // instead of the computed csrcCount/padding flags — in particular the
    // "additional CSRC" branch only fires when the low nibble is exactly
    // 0x0F (CSRC count === 15), not merely nonzero. Preserved as-is.
    if (rtspInterleaved[0] !== 0x24) {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: 0x0102,
        place: 'H265Session.ts:156',
        message: `it is not valid interleave header (RTSP over TCP). Interleaved[0] = ${rtspInterleaved[0].toString(16)}`
      });
    } else if ((rtpHeader[0] & 0x0f) === 0x0f) {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: 0x0103,
        place: 'H265Session.ts:164',
        message: `There is additional CSRC which is not handled in this version. CSRC count = ${flags.csrcCount}`
      });
    } else if ((rtpHeader[0] & 0x20) === 0x20) {
      paddingSize = rtpPayload[rtpPayload.length - 1];
    }

    let extensionHeaderLen = 0;
    if (flags.extension) {
      extensionHeaderLen = ((rtpPayload[2] << 8) | rtpPayload[3]) * 4 + 4;
      this.playback = syncPlaybackTimestampFromRtpExtension(this, rtpPayload, this.playback);
    }

    const payload = rtpPayload.subarray(extensionHeaderLen, rtpPayload.length - paddingSize);
    const rtpTimeStamp = this.ntohl(rtpHeader.subarray(4, 8));

    // Unlike H264Session's equivalent guard (H.264 NAL type 0 really is
    // "Unspecified"/unused, RFC 6184 Table 7-1) — this used to also throw
    // on `nalType === 0`, copied over from that same pattern without
    // accounting for H.265 having an entirely different, wider NAL type
    // numbering. H.265 type 0 is TRAIL_N (RFC 7798 Table 1 / H.265 Table
    // 7-1): an ordinary, common non-reference trailing-picture slice, not
    // reserved or invalid — falls through to the `default` case below like
    // every other slice type (TRAIL_R=1, IDR_W_RADL=19, CRA_NUT=21, etc.,
    // none of which have their own switch case either). Rejecting it broke
    // any H.265 source whose encoder actually emits TRAIL_N — confirmed via
    // this repo's own YouTube-to-RTSP transcoding demo server (ffmpeg does),
    // while real Hanwha devices apparently don't hit it either way.
    const nalType = (payload[0] >> 1) & 0x3f;

    switch (nalType) {
      case HEVC_NAL.VPS:
      case HEVC_NAL.SPS:
      case HEVC_NAL.PPS:
      case HEVC_NAL.AUD:
        this.handleSingleNalUnit(nalType, payload);
        break;
      case HEVC_NAL.AP: {
        // Aggregation Packet, RFC 7798 §4.4.2 — bundles multiple NAL units
        // (typically VPS+SPS+PPS+IDR slice) into one RTP payload, instead of
        // each arriving as its own single-NAL-unit packet (the cases above).
        // Previously unhandled here (fell through to `default`, buffering
        // the whole aggregate as one opaque blob) — meaning VPS/SPS/PPS sent
        // this way were never captured into vpsPayload/spsPayload/ppsPayload
        // at all, surfacing downstream as MediaRouter's "SPS payload is not
        // available ... encoder may be sending SPS/PPS through an
        // aggregation packet type that is not supported" error. Confirmed:
        // real Hanwha devices send VPS/SPS/PPS as separate single-NAL-unit
        // packets (works fine today), but at least ffmpeg's HEVC RTP
        // payloader (this repo's own YouTube-to-RTSP transcoding demo
        // server) uses APs instead — this was a real gap, not a
        // camera-specific one.
        //
        // Format after the 2-byte PayloadHdr already consumed as `payload[0..1]`
        // (its type is this AP marker, 48 — the *individual* NAL units inside
        // carry their own real types, read from each unit's own first two
        // bytes below): a sequence of `{ 2-byte NALU size (big-endian), that
        // many bytes of NALU data }`, no DONL field, since DON isn't
        // negotiated (`sprop-max-don-diff`) anywhere in this player.
        let offset = 2;
        while (offset + 2 <= payload.length) {
          const nalUnitSize = (payload[offset] << 8) | payload[offset + 1];
          offset += 2;
          if (nalUnitSize <= 0 || offset + nalUnitSize > payload.length) {
            break;
          }
          const nalUnit = payload.subarray(offset, offset + nalUnitSize);
          offset += nalUnitSize;
          const subNalType = (nalUnit[0] >> 1) & 0x3f;
          this.handleSingleNalUnit(subNalType, nalUnit);
        }
        break;
      }
      case HEVC_NAL.UNSPEC49: {
        // Fragmentation Unit, RFC 7798 §4.4.3.
        const startBit = (payload[2] & 0x80) === 0x80;
        const endBit = (payload[2] & 0x40) === 0x40;
        const fuType = payload[2] & 0x3f;
        const payloadStartIndex = 3;

        if (startBit && !endBit) {
          const newNalHeader = new Uint8Array([(payload[0] & 0x81) | (fuType << 1), payload[1]]);
          this.setBuffer(PREFIX);
          this.setBuffer(newNalHeader);
          this.setBuffer(payload.subarray(payloadStartIndex, payload.length));
        } else {
          this.setBuffer(payload.subarray(payloadStartIndex, payload.length));
        }
        break;
      }
      default:
        this.setBuffer(PREFIX);
        this.setBuffer(payload);
        break;
    }

    if (flags.markerBit) {
      const inputBufferSub = this.inputBuffer.subarray(0, this.inputLength);
      this.rtpTimestamp = (rtpTimeStamp / this.clock).toFixed(0);
      this.inputLength = 0;

      if (this.isInitializeReceivedPacketCount()) {
        this.setStartTimeStamp(this.rtpTimestamp);
      }
      this.increaseNumberOfReceivedPacketCount();

      const frameType = inputBufferSub[4] === 0x40 ? 'I' : 'P';
      const playMode = this.playback ? 'Playback' : 'Live';
      const streamData = {
        interleaved: this.interleavedId,
        codecType: 'H265',
        frameData: inputBufferSub,
        channelId: this.channelId,
        packetSeq: this.getNumberOfReceivedPacketCount(),
        receiveClock: performance.now(),
        timeStamp: {
          rtpTimestamp: this.rtpTimestamp,
          timestamp: this.timeData!.timestamp,
          timestamp_usec: this.timeData!.timestamp_usec,
          timezone: this.timeData!.timezone
        },
        rtcp_interleavedId: this.rtcpSession?.interleavedId
      };
      const videoInfo = {
        frameType,
        vpsPayload: this.vpsPayload,
        spsPayload: this.spsPayload,
        ppsPayload: this.ppsPayload,
        framerate: this.getFramerate()
      };

      this.debugLog.info('depacketize() -> frame complete', `frameType=${frameType}`, `bytes=${inputBufferSub.length}`, `packetSeq=${this.getNumberOfReceivedPacketCount()}`);
      this.eventVideoCallback?.(playMode, streamData, videoInfo);
    }
  }

  override close(): void {
    this.sessionId = null;
    this.stopStatisticsTimer();
  }
}
