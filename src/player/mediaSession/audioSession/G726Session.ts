import { RtpSession } from '../RtpSession';
import { parseRtpHeaderFlags, syncPlaybackTimestampFromRtpExtension } from '../rtpDepacketizeUtils';
import { RTSPOverWebSocketError } from '../../exceptions';

export interface G726CodecInit {
  bitrate: number;
  clockFreq: number;
}

/** Ported from the legacy player’s MediaSession/AudioSession/g726Session.js. */
export class G726Session extends RtpSession {
  private bitrate = 0;
  private playback = false;

  override init(info?: G726CodecInit): void {
    if (!info) return;
    this.bitrate = info.bitrate;
    this.playback = false;
    this.timeData = { timestamp: null, timestamp_usec: null, timezone: null };
    this.clock = info.clockFreq * 0.001;
  }

  override depacketize(rtspInterleaved: Uint8Array, rtpHeader: Uint8Array, rtpPayload: Uint8Array): void {
    const flags = parseRtpHeaderFlags(rtpHeader);
    let paddingSize = 0;

    if (rtspInterleaved[0] !== 0x24) {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: 0x0102,
        place: 'g726Session.js:65',
        message: `it is not valid interleave header (RTSP over TCP). Interleaved[0] = ${rtspInterleaved[0].toString(16)}`
      });
    } else if (flags.csrcCount !== 0) {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: 0x0103,
        place: 'g726Session.js:72',
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

    const processedMessage = rtpPayload.subarray(extensionHeaderLen, rtpPayload.length);
    void paddingSize;
    const rtpTimeStamp = this.ntohl(rtpHeader.subarray(4, 8));

    if (flags.markerBit) {
      this.rtpTimestamp = (rtpTimeStamp / this.clock).toFixed(0);
      if (this.isInitializeReceivedPacketCount()) {
        this.setStartTimeStamp(this.rtpTimestamp);
      }
      this.increaseNumberOfReceivedPacketCount();

      const playMode = this.playback ? 'Playback' : 'Live';
      const streamData = {
        interleaved: this.interleavedId,
        codecType: 'G726',
        codecMime: this.mime,
        frameData: processedMessage,
        channelId: this.channelId,
        timeStamp: {
          rtpTimestamp: this.rtpTimestamp,
          timestamp: this.timeData!.timestamp,
          timestamp_usec: this.timeData!.timestamp_usec,
          timezone: this.timeData!.timezone
        },
        rtcp_interleavedId: this.rtcpSession?.interleavedId
      };
      const audioInfo = { bitrate: this.bitrate };

      this.eventAudioCallback?.(playMode, streamData, audioInfo);
    }
  }

  override close(): void {
    this.sessionId = null;
    this.stopStatisticsTimer();
  }
}
