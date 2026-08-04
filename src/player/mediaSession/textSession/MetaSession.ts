import { RtpSession } from '../RtpSession';
import { parseRtpHeaderFlags, syncPlaybackTimestampFromRtpExtension } from '../rtpDepacketizeUtils';
import { RTSPOverWebSocketError } from '../../exceptions';

const SIZE_1_4K = Math.floor(1.4 * 1024);

export class MetaSession extends RtpSession {
  private inputBuffer = new Uint8Array(SIZE_1_4K);
  private inputLength = 0;
  private playback = false;

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
        place: 'MetaSession.ts:53',
        message: `it is not valid interleave header (RTSP over TCP). Interleaved[0] = ${rtspInterleaved[0].toString(16)}`
      });
    } else if (flags.csrcCount !== 0) {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: 0x0103,
        place: 'MetaSession.ts:60',
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
    this.setBuffer(payload);

    if (flags.markerBit) {
      const inputBufferSub = this.inputBuffer.subarray(0, this.inputLength);
      this.rtpTimestamp = (rtpTimeStamp / this.clock).toFixed(0);
      this.inputLength = 0;

      const streamData = {
        frameData: inputBufferSub,
        channelId: this.channelId,
        receiveClock: performance.now(),
        timeStamp: {
          rtpTimestamp: this.rtpTimestamp,
          timestamp: this.timeData!.timestamp,
          timestamp_usec: this.timeData!.timestamp_usec,
          timezone: this.timeData!.timezone
        },
        rtcp_interleavedId: this.rtcpSession?.interleavedId
      };
      this.eventMetaCallback?.(streamData);
    }
  }

  override close(): void {
    this.sessionId = null;
    this.stopStatisticsTimer();
  }
}
