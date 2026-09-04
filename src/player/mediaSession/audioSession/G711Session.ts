import { RtpSession } from '../RtpSession';
import { parseRtpHeaderFlags, syncPlaybackTimestampFromRtpExtension } from '../rtpDepacketizeUtils';
import { RTSPOverWebSocketError } from '../../exceptions';

export interface G711CodecInit {
  bitrate: number;
  clockFreq: number;
}

export class G711Session extends RtpSession {
  private bitrate = 0;
  private playback = false;

  override init(info?: G711CodecInit): void {
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
        place: 'G711Session.ts:66',
        message: `it is not valid interleave header (RTSP over TCP). Interleaved[0] = ${rtspInterleaved[0].toString(16)}`
      });
    } else if (flags.csrcCount !== 0) {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: 0x0103,
        place: 'G711Session.ts:73',
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

    // Unlike video (NAL fragments/aggregates spanning several packets) or AAC
    // (multiple access units per packet), G.711 has no framing to reassemble
    // — every RTP packet is already a complete, independent chunk of
    // continuous companded PCM, so there's nothing to gate on. Previously
    // gated on flags.markerBit (a leftover from the video-session pattern),
    // which silently dropped every packet against this repo's own demo
    // server: RFC 3551 only defines the marker bit's meaning for talk-spurt
    // boundaries under silence suppression, and ffmpeg's G.711 RTP muxer
    // (no silence suppression) never sets it. Real IP cameras happening to
    // set it on every packet is why that assumption went unnoticed.
    this.rtpTimestamp = (rtpTimeStamp / this.clock).toFixed(0);
    if (this.isInitializeReceivedPacketCount()) {
      this.setStartTimeStamp(this.rtpTimestamp);
    }
    this.increaseNumberOfReceivedPacketCount();

    const playMode = this.playback ? 'Playback' : 'Live';
    const streamData = {
      interleaved: this.interleavedId,
      codecType: 'G711',
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

    this.debugLog.debug('depacketize()', `bytes=${processedMessage.length}`, `packetSeq=${this.getNumberOfReceivedPacketCount()}`);
    this.eventAudioCallback?.(playMode, streamData, audioInfo);
  }

  override close(): void {
    this.sessionId = null;
    this.stopStatisticsTimer();
  }
}
