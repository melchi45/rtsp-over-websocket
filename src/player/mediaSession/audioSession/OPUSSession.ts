import { RtpSession } from '../RtpSession';
import { parseRtpHeaderFlags, syncPlaybackTimestampFromRtpExtension } from '../rtpDepacketizeUtils';
import { RTSPOverWebSocketError } from '../../exceptions';

export interface OPUSCodecInit {
  bitrate: number;
  clockFreq: number;
}

export class OPUSSession extends RtpSession {
  private bitrate = 0;
  private playback = false;

  override init(info?: OPUSCodecInit): void {
    if (!info) return;
    this.bitrate = info.bitrate;
    this.playback = false;
    this.timeData = { timestamp: null, timestamp_usec: null, timezone: null };
    // RFC 7587 §4.1: Opus RTP timestamps always run at a fixed 48000Hz clock
    // rate regardless of the codec's actual internal sample rate (or the SDP
    // rtpmap's own clock field, which is only ever "48000" by the same rule)
    // — hardcoded rather than trusting `info.clockFreq` in case a server ever
    // sends something else there.
    this.clock = 48000 * 0.001;
  }

  override depacketize(rtspInterleaved: Uint8Array, rtpHeader: Uint8Array, rtpPayload: Uint8Array): void {
    const flags = parseRtpHeaderFlags(rtpHeader);
    let paddingSize = 0;

    if (rtspInterleaved[0] !== 0x24) {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: 0x0102,
        place: 'OPUSSession.ts:depacketize',
        message: `it is not valid interleave header (RTSP over TCP). Interleaved[0] = ${rtspInterleaved[0].toString(16)}`
      });
    } else if (flags.csrcCount !== 0) {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: 0x0103,
        place: 'OPUSSession.ts:depacketize',
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

    // Like G.711/G.726, one RTP packet is always exactly one complete Opus
    // packet (RFC 7587 §4.2, "no fragmentation or aggregation") — nothing to
    // reassemble across packets, and (also like G.711/G.726 against this
    // repo's demo server) not gated on flags.markerBit: RFC 7587 §4.1 only
    // asks it be set on the first packet of a talkspurt and says nothing
    // about receivers requiring it, so encoders that never set it (no
    // silence-suppression) shouldn't have every packet silently dropped.
    this.rtpTimestamp = (rtpTimeStamp / this.clock).toFixed(0);
    if (this.isInitializeReceivedPacketCount()) {
      this.setStartTimeStamp(this.rtpTimestamp);
    }
    this.increaseNumberOfReceivedPacketCount();

    const playMode = this.playback ? 'Playback' : 'Live';
    const streamData = {
      interleaved: this.interleavedId,
      codecType: 'OPUS',
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
    // channelCount/sampleRate are fixed rather than derived from the stream
    // — see OPUSAudioDecoder.ts's comment on why this player only decodes
    // Opus as mono, and init()'s comment on the RFC 7587 fixed clock rate.
    const audioInfo = { bitrate: this.bitrate, channelCount: 1, sampleRate: 48000 };

    this.eventAudioCallback?.(playMode, streamData, audioInfo);
  }

  override close(): void {
    this.sessionId = null;
    this.stopStatisticsTimer();
  }
}
