import { RtpSession } from '../RtpSession';
import { parseRtpHeaderFlags, syncPlaybackTimestampFromRtpExtension } from '../rtpDepacketizeUtils';
import { RTSPOverWebSocketError } from '../../exceptions';

const H264_NAL = {
  SPS: 7,
  PPS: 8,
  AUD: 9,
  SPS_EXT: 13,
  SUB_SPS: 15,
  STAP_A: 24,
  STAP_B: 25,
  MTAP16: 26,
  MTAP24: 27,
  UNSPECIFIED28: 28
} as const;

const PREFIX = Uint8Array.from([0x00, 0x00, 0x00, 0x01]);
const SIZE_1_4K = Math.floor(1.4 * 1024);

/** Ported from the legacy player’s MediaSession/VideoSession/h264Session.js. */
export class H264Session extends RtpSession {
  private inputBuffer = new Uint8Array(SIZE_1_4K);
  private inputLength = 0;
  private playback = false;
  private spsSegment: Uint8Array | null = null;
  private ppsSegment: Uint8Array | null = null;

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

    if (rtspInterleaved[0] !== 0x24) {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: 0x0102,
        place: 'h264Session.js:87',
        message: `it is not valid interleave header (RTSP over TCP). Interleaved[0] = ${rtspInterleaved[0].toString(16)}`
      });
    } else if (flags.csrcCount !== 0) {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: 0x0103,
        place: 'h264Session.js:94',
        message: `There is additional CSRC which is not handled in this version. CSRC count = ${flags.csrcCount}`
      });
    } else if (flags.padding) {
      paddingSize = rtpPayload[rtpPayload.length - 1];
    }

    let extensionHeaderLen = 0;
    if (flags.extension) {
      extensionHeaderLen = ((rtpPayload[2] << 8) | rtpPayload[3]) * 4 + 4;
      this.playback = syncPlaybackTimestampFromRtpExtension(this, rtpPayload, this.playback);
    }

    const payload = rtpPayload.subarray(extensionHeaderLen, rtpPayload.length - paddingSize);
    const rtpTimeStamp = this.ntohl(rtpHeader.subarray(4, 8));

    const nalType = payload[0] & 0x1f;
    if (nalType === 0) {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: 0x0101,
        place: 'h264Session.js:155',
        message: `This NAL type does not support on this application. nal_type = ${nalType}`
      });
    }

    switch (nalType) {
      case H264_NAL.SPS:
        this.setBuffer(PREFIX);
        this.setBuffer(payload);
        this.spsSegment = payload;
        break;
      case H264_NAL.PPS:
        this.setBuffer(PREFIX);
        this.setBuffer(payload);
        this.ppsSegment = payload;
        break;
      case H264_NAL.STAP_A: {
        // Single-time aggregation packet (RFC 6184 §5.7.1): payload[0] is the
        // STAP-A NAL header; aggregated units follow as repeated
        // [2-byte big-endian size][NAL unit] entries.
        let stapOffset = 1;
        while (stapOffset + 2 <= payload.length) {
          const aggregatedSize = (payload[stapOffset] << 8) | payload[stapOffset + 1];
          stapOffset += 2;
          if (aggregatedSize <= 0 || stapOffset + aggregatedSize > payload.length) {
            break;
          }
          const aggregatedNal = payload.subarray(stapOffset, stapOffset + aggregatedSize);
          const aggregatedType = aggregatedNal[0] & 0x1f;
          this.setBuffer(PREFIX);
          this.setBuffer(aggregatedNal);
          if (aggregatedType === H264_NAL.SPS) {
            this.spsSegment = aggregatedNal;
          } else if (aggregatedType === H264_NAL.PPS) {
            this.ppsSegment = aggregatedNal;
          }
          stapOffset += aggregatedSize;
        }
        break;
      }
      case H264_NAL.STAP_B:
      case H264_NAL.MTAP16:
      case H264_NAL.MTAP24:
        throw new RTSPOverWebSocketError({
          channelId: this.channelId,
          errorCode: 0x0101,
          place: 'h264Session.js:STAP-B/MTAP',
          message: `STAP-B/MTAP16/MTAP24 aggregation is additional which is not handled in this version. NALType = ${nalType}`
        });
      case H264_NAL.SPS_EXT:
        throw new RTSPOverWebSocketError({
          channelId: this.channelId,
          errorCode: 0x0101,
          place: 'h264Session.js:195',
          message: `SPS (Sequence Parameter Set) extension is additional which is not handled in this version. NALType  = ${nalType}`
        });
      case H264_NAL.SUB_SPS:
        throw new RTSPOverWebSocketError({
          channelId: this.channelId,
          errorCode: 0x0101,
          place: 'h264Session.js:204',
          message: `SSPS (Subset Sequence parameter Set) is additional which is not handled in this version. NALType  = ${nalType}`
        });
      case H264_NAL.UNSPECIFIED28: {
        // Fragmentation Unit (FU-A), RFC 6184 §5.8.
        const startBit = (payload[1] & 0x80) === 0x80;
        const endBit = (payload[1] & 0x40) === 0x40;
        const fuType = payload[1] & 0x1f;
        const payloadStartIndex = 2;

        if (startBit && !endBit) {
          const newNalHeader = new Uint8Array([(payload[0] & 0x60) | fuType]);
          this.setBuffer(PREFIX);
          this.setBuffer(newNalHeader);
          this.setBuffer(payload.subarray(payloadStartIndex, payload.length));
        } else {
          this.setBuffer(payload.subarray(payloadStartIndex, payload.length));
        }
        break;
      }
      case H264_NAL.AUD:
        break;
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

      if ((inputBufferSub[3] & 0x1f) === 0x07) {
        throw new RTSPOverWebSocketError({
          channelId: this.channelId,
          errorCode: 0x0101,
          place: 'h264Session.js:264',
          message: `3 byte start code is additional which is not handled in this version. inputBufferSub[3].toString(16): ${inputBufferSub[3].toString(16)}`
        });
      }

      const frameType = (inputBufferSub[4] & 0x1f) === 0x07 || (inputBufferSub[4] & 0x1f) === 0x09 ? 'I' : 'P';
      const playMode = this.playback ? 'Playback' : 'Live';
      const streamData = {
        interleaved: this.interleavedId,
        codecType: 'H264',
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
        spsPayload: this.spsSegment,
        ppsPayload: this.ppsSegment,
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
