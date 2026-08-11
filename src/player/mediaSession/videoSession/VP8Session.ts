import { RtpSession } from '../RtpSession';
import { parseRtpHeaderFlags, syncPlaybackTimestampFromRtpExtension } from '../rtpDepacketizeUtils';
import { RTSPOverWebSocketError } from '../../exceptions';

const SIZE_1_4K = Math.floor(1.4 * 1024);

/**
 * RTP payload format for VP8 (RFC 7741 §4.2) — depacketizes into a raw VP8
 * elementary bitstream (no start codes/length prefixes; VP8 has none),
 * suitable for a WebCodecs `VideoDecoder` configured with `codec: 'vp8'`.
 * Mirrors H264Session/H265Session's structure and error-handling style.
 */
export class VP8Session extends RtpSession {
  private inputBuffer = new Uint8Array(SIZE_1_4K);
  private inputLength = 0;
  private playback = false;
  private frameType: 'I' | 'P' = 'P';

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
        place: 'VP8Session.ts:depacketize',
        message: `it is not valid interleave header (RTSP over TCP). Interleaved[0] = ${rtspInterleaved[0].toString(16)}`
      });
    } else if (flags.csrcCount !== 0) {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: 0x0103,
        place: 'VP8Session.ts:depacketize',
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

    // RFC 7741 §4.2 mandatory payload descriptor (1 byte):
    // X(1) R(1) N(1) S(1) R(1) PID(3)
    const descriptor0 = payload[0];
    const extended = (descriptor0 & 0x80) !== 0;
    const startOfPartition = (descriptor0 & 0x10) !== 0;
    const partitionIndex = descriptor0 & 0x07;

    let descriptorLen = 1;
    if (extended) {
      // §4.2 extended control bits: I(1) L(1) T(1) K(1) RSV(4)
      const ext = payload[1];
      const pictureIdPresent = (ext & 0x80) !== 0;
      const tl0PicIdxPresent = (ext & 0x40) !== 0;
      const tidOrKeyIdxPresent = (ext & 0x20) !== 0 || (ext & 0x10) !== 0;
      descriptorLen = 2;

      if (pictureIdPresent) {
        const extendedPictureId = (payload[descriptorLen] & 0x80) !== 0;
        descriptorLen += extendedPictureId ? 2 : 1;
      }
      if (tl0PicIdxPresent) {
        descriptorLen += 1;
      }
      if (tidOrKeyIdxPresent) {
        descriptorLen += 1;
      }
    }

    if (descriptorLen >= payload.length) {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: 0x0101,
        place: 'VP8Session.ts:depacketize',
        message: `VP8 payload descriptor length (${descriptorLen}) leaves no room for payload data (payload length = ${payload.length})`
      });
    }

    const vp8Payload = payload.subarray(descriptorLen);

    // RFC 6386 §9.1: the first VP8 partition's uncompressed data chunk starts
    // with a 3-byte tag whose bit 0 is the (inverted) key-frame flag — only
    // meaningful on the first packet of the first partition of a frame.
    if (startOfPartition && partitionIndex === 0) {
      this.frameType = (vp8Payload[0] & 0x01) === 0 ? 'I' : 'P';
    }

    this.setBuffer(vp8Payload);

    if (flags.markerBit) {
      const inputBufferSub = this.inputBuffer.subarray(0, this.inputLength);
      this.rtpTimestamp = (rtpTimeStamp / this.clock).toFixed(0);
      this.inputLength = 0;

      if (this.isInitializeReceivedPacketCount()) {
        this.setStartTimeStamp(this.rtpTimestamp);
      }
      this.increaseNumberOfReceivedPacketCount();

      const playMode = this.playback ? 'Playback' : 'Live';
      const streamData = {
        interleaved: this.interleavedId,
        codecType: 'VP8',
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
        frameType: this.frameType,
        framerate: this.getFramerate()
      };

      this.eventVideoCallback?.(playMode, streamData, videoInfo);
      this.frameType = 'P';
    }
  }

  override close(): void {
    this.sessionId = null;
    this.stopStatisticsTimer();
  }
}
