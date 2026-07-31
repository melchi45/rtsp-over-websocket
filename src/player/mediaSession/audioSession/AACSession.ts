import { RtpSession } from '../RtpSession';
import { parseRtpHeaderFlags, syncPlaybackTimestampFromRtpExtension } from '../rtpDepacketizeUtils';
import { RTSPOverWebSocketError } from '../../exceptions';

export interface AACCodecInfo {
  config: string;
  bitrate: number;
  clockFreq: number;
}

/** Ported from the legacy player’s MediaSession/AudioSession/aacSession.js. */
export class AACSession extends RtpSession {
  private config = '';
  private bitrate = 0;
  private readonly adts = new Uint8Array(7);
  private playback = false;

  private genADTSAAC(frameSize: number): void {
    if (typeof this.config !== 'string') {
      return;
    }
    const firstTwoConfig = parseInt(this.config.substring(0, 2), 16);
    const lastTwoConfig = parseInt(this.config.substring(2, 4), 16);
    const mChannels = 1;

    const mAOT = firstTwoConfig >> 3;
    const freqIndex = ((firstTwoConfig & 0x07) << 1) | ((lastTwoConfig & 0x80) >> 7);

    this.adts[0] = 0xff;
    this.adts[1] = 0xf9;
    this.adts[2] = (mAOT - 1) << 6;
    this.adts[2] |= freqIndex << 2;
    this.adts[2] |= mChannels >> 2;
    this.adts[3] = mChannels << 6;
    this.adts[3] |= ((frameSize + 7) & 0x1800) >> 11;
    this.adts[4] = ((frameSize + 7) & 0x07f8) >> 3;
    this.adts[5] = ((frameSize + 7) & 0x07) << 5;
    this.adts[5] |= 0x01;
    this.adts[6] = 0x54;
  }

  override init(info?: AACCodecInfo): void {
    if (!info) return;
    this.config = info.config;
    this.bitrate = info.bitrate;
    this.playback = false;
    this.timeData = { timestamp: null, timestamp_usec: null, timezone: null };
    this.clock = info.clockFreq * 0.001;
  }

  override depacketize(rtspInterleaved: Uint8Array, rtpHeader: Uint8Array, rtpPayload: Uint8Array): void {
    const headerLen = 4;
    const flags = parseRtpHeaderFlags(rtpHeader);
    let paddingSize = 0;

    if (rtspInterleaved[0] !== 0x24) {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: 0x0102,
        place: 'accSession.js:105',
        message: `it is not valid interleave header (RTSP over TCP). Interleaved[0] = ${rtspInterleaved[0].toString(16)}`
      });
    } else if (flags.csrcCount !== 0) {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: 0x0103,
        place: 'accSession.js:112',
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

    const rtpTimeStamp = this.ntohl(rtpHeader.subarray(4, 8));

    if (flags.markerBit) {
      this.rtpTimestamp = (rtpTimeStamp / this.clock).toFixed(0);
      if (this.isInitializeReceivedPacketCount()) {
        this.setStartTimeStamp(this.rtpTimestamp);
      }
      this.increaseNumberOfReceivedPacketCount();

      const frameSize = rtpPayload.length - (headerLen + extensionHeaderLen);
      const rawPayload = rtpPayload.subarray(headerLen + extensionHeaderLen, rtpPayload.length);

      // If the ADT header isn't already present, (re)generate it into `this.adts`
      // — the legacy code discards genADTSAAC()'s return value and relies only
      // on this side effect.
      if (!(rawPayload[0] === 0xff && (rawPayload[1] & 0xf0) === 0xf0)) {
        this.genADTSAAC(frameSize);
      }

      void paddingSize;
      const playMode = this.playback ? 'Playback' : 'Live';
      const streamData = {
        interleaved: this.interleavedId,
        codecType: 'AAC',
        codecMime: this.mime,
        ADTs: this.adts,
        frameData: rawPayload,
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
