import { RtpSession } from '../RtpSession';
import { parseRtpHeaderFlags, syncPlaybackTimestampFromRtpExtension } from '../rtpDepacketizeUtils';
import { RTSPOverWebSocketError } from '../../exceptions';

const HEVC_NAL = {
  VPS: 32,
  SPS: 33,
  PPS: 34,
  AUD: 35,
  UNSPEC49: 49
} as const;

const PREFIX = Uint8Array.from([0x00, 0x00, 0x00, 0x01]);
const SIZE_1_4K = Math.floor(1.4 * 1024);

/** Ported from the legacy player’s MediaSession/VideoSession/h265Session.js. */
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

  override depacketize(rtspInterleaved: Uint8Array, rtpHeader: Uint8Array, rtpPayload: Uint8Array): void {
    const flags = parseRtpHeaderFlags(rtpHeader);
    let paddingSize = 0;

    // NOTE: unlike H264Session, the legacy h265Session.js checks raw bits here
    // instead of the computed csrcCount/padding flags — in particular the
    // "additional CSRC" branch only fires when the low nibble is exactly
    // 0x0F (CSRC count === 15), not merely nonzero. Preserved as-is.
    if (rtspInterleaved[0] !== 0x24) {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: 0x0102,
        place: 'h265Session.js:156',
        message: `it is not valid interleave header (RTSP over TCP). Interleaved[0] = ${rtspInterleaved[0].toString(16)}`
      });
    } else if ((rtpHeader[0] & 0x0f) === 0x0f) {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: 0x0103,
        place: 'h265Session.js:164',
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

    const nalType = (payload[0] >> 1) & 0x3f;
    if (nalType === 0) {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: 0x0101,
        place: 'h265Session.js:154',
        message: `This NAL type does not support on this application. nal_type = ${nalType}`
      });
    }

    switch (nalType) {
      case HEVC_NAL.VPS:
        this.setBuffer(PREFIX);
        this.setBuffer(payload);
        this.vpsPayload = payload;
        break;
      case HEVC_NAL.SPS:
        this.setBuffer(PREFIX);
        this.setBuffer(payload);
        this.spsPayload = payload;
        break;
      case HEVC_NAL.PPS:
        this.setBuffer(PREFIX);
        this.setBuffer(payload);
        this.ppsPayload = payload;
        break;
      case HEVC_NAL.AUD:
        break;
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

      this.eventVideoCallback?.(playMode, streamData, videoInfo);
    }
  }

  override close(): void {
    this.sessionId = null;
    this.stopStatisticsTimer();
  }
}
