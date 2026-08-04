import { RtpSession } from '../RtpSession';
import { parseRtpHeaderFlags, syncPlaybackTimestampFromRtpExtension } from '../rtpDepacketizeUtils';
import { RTSPOverWebSocketError } from '../../exceptions';

export interface AACCodecInfo {
  config: string;
  bitrate: number;
  clockFreq: number;
  sizeLength?: number;
  indexLength?: number;
  indexDeltaLength?: number;
}

// AAC-LC (the only audioObjectType this depacketizer's ADTS generation
// targets) always codes 1024 PCM samples per access unit.
const AAC_FRAME_SAMPLES = 1024;

/** Ported from the legacy player’s mediaSession/audioSession/aacSession.ts. */
export class AACSession extends RtpSession {
  private config = '';
  private bitrate = 0;
  private channelCount = 1;
  // MPEG-4 samplingFrequencyIndex table value (ISO/IEC 14496-3 Table 1.16) — 8
  // is 16000Hz, the common rate for real IP-camera AAC audio (and the value
  // VideoTagPlayer.ts's setAudioInfo() used to hardcode for any real AAC
  // source). This repo's own demo server encodes AAC at 48000Hz (table value
  // 3), so that hardcode declared the wrong sample rate for it — same class
  // of bug as channelCount above, just for sample rate instead of channels.
  private samplingFrequencyIndex = 8;
  private sampleRate = 0;
  // RFC 3640 §3.3.6 AU-header-section bit widths (AAC-hbr mode, this
  // depacketizer's only supported MPEG4-GENERIC mode) — declared per-stream
  // via the SDP fmtp's sizelength/indexlength/indexdeltalength, with 13/3/3
  // as a fallback (this repo's own demo server's actual values, and a common
  // default elsewhere).
  private sizeLength = 13;
  private indexLength = 3;
  private indexDeltaLength = 3;
  private readonly adts = new Uint8Array(7);
  private playback = false;

  private genADTSAAC(frameSize: number): void {
    if (typeof this.config !== 'string') {
      return;
    }
    const firstTwoConfig = parseInt(this.config.substring(0, 2), 16);
    const mChannels = this.channelCount;

    const mAOT = firstTwoConfig >> 3;
    const freqIndex = this.samplingFrequencyIndex;

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
    this.sampleRate = info.clockFreq;
    if (info.sizeLength) this.sizeLength = info.sizeLength;
    if (info.indexLength) this.indexLength = info.indexLength;
    if (info.indexDeltaLength) this.indexDeltaLength = info.indexDeltaLength;
    // AudioSpecificConfig (ISO/IEC 14496-3 §1.6.2.1): 5-bit audioObjectType,
    // then 4-bit samplingFrequencyIndex, then 4-bit channelConfiguration.
    // Downstream consumers (ADTS header generation here, and the
    // video-tag/MSE player's fMP4 audio track) need the real values: this
    // repo's own demo server encodes AAC as 48000Hz stereo, not the
    // 16000Hz-mono a real IP camera typically sends, and declaring the wrong
    // one makes the browser's AAC decoder reject the audio track (either a
    // channel-count or sample-rate mismatch against what the raw_data_block
    // actually contains), which surfaces as an MSE decode error that aborts
    // playback shortly after the first video frame.
    if (this.config.length >= 4) {
      const firstTwoConfig = parseInt(this.config.substring(0, 2), 16);
      const lastTwoConfig = parseInt(this.config.substring(2, 4), 16);
      this.samplingFrequencyIndex = ((firstTwoConfig & 0x07) << 1) | ((lastTwoConfig & 0x80) >> 7);
      this.channelCount = (lastTwoConfig >> 3) & 0x07;
    }
  }

  /** Reads the AU-header-section starting at bit `(byteOffset)*8` (RFC 3640
   * §3.3.6): a 2-byte AU-headers-length (in *bits*), then that many bits of
   * back-to-back AU headers — sizeLength+indexLength bits for the first,
   * sizeLength+indexDeltaLength bits for each one after — each yielding one
   * AU's byte size. Returns the sizes plus the byte offset where the actual
   * AU data (concatenated in the same order) begins. */
  private parseAuHeaders(payload: Uint8Array, byteOffset: number): { auSizes: number[]; dataStart: number } {
    const auHeadersLengthBits = (payload[byteOffset] << 8) | payload[byteOffset + 1];
    const dataStart = byteOffset + 2 + Math.ceil(auHeadersLengthBits / 8);
    const sectionEndBit = (byteOffset + 2) * 8 + auHeadersLengthBits;

    const auSizes: number[] = [];
    let bitOffset = (byteOffset + 2) * 8;
    let first = true;
    while (bitOffset < sectionEndBit) {
      const indexBits = first ? this.indexLength : this.indexDeltaLength;
      const width = this.sizeLength + indexBits;
      let value = 0;
      for (let b = 0; b < width; b++) {
        const byteIdx = bitOffset >> 3;
        const bitIdx = 7 - (bitOffset & 7);
        value = (value << 1) | ((payload[byteIdx] >> bitIdx) & 1);
        bitOffset++;
      }
      auSizes.push(value >>> indexBits);
      first = false;
    }
    return { auSizes, dataStart };
  }

  override depacketize(rtspInterleaved: Uint8Array, rtpHeader: Uint8Array, rtpPayload: Uint8Array): void {
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

    if (!flags.markerBit) return;

    this.rtpTimestamp = (rtpTimeStamp / this.clock).toFixed(0);
    if (this.isInitializeReceivedPacketCount()) {
      this.setStartTimeStamp(this.rtpTimestamp);
    }
    this.increaseNumberOfReceivedPacketCount();

    // A single RTP packet commonly aggregates *multiple* complete AAC access
    // units this way (this repo's own demo server does — e.g. bundling 3-4
    // ~350B AAC frames per packet at 48kHz/96kbps to cut packet overhead).
    // Treating the whole payload as a single AU — this depacketizer's
    // previous behavior, which hardcoded a 4-byte AU-header-section assuming
    // exactly one AU — fed the decoder a buffer that was actually several
    // concatenated AAC frames, desyncing partway through and failing to
    // decode. Real IP cameras typically send one AU per packet, which is why
    // that assumption went unnoticed until a stream that aggregates hit it.
    const { auSizes, dataStart } = this.parseAuHeaders(rtpPayload, extensionHeaderLen);
    if (auSizes.length === 0) return;

    const playMode = this.playback ? 'Playback' : 'Live';
    const dataEnd = rtpPayload.length - paddingSize;
    let dataOffset = dataStart;
    let auRtpTimeStamp = rtpTimeStamp;

    for (const auSize of auSizes) {
      if (dataOffset + auSize > dataEnd) break;
      const rawPayload = rtpPayload.subarray(dataOffset, dataOffset + auSize);
      dataOffset += auSize;

      // If the ADT header isn't already present, (re)generate it into `this.adts`
      // — the legacy code discards genADTSAAC()'s return value and relies only
      // on this side effect.
      if (!(rawPayload[0] === 0xff && (rawPayload[1] & 0xf0) === 0xf0)) {
        this.genADTSAAC(auSize);
      }

      const auTimestamp = (auRtpTimeStamp / this.clock).toFixed(0);
      const streamData = {
        interleaved: this.interleavedId,
        codecType: 'AAC',
        codecMime: this.mime,
        ADTs: this.adts,
        frameData: rawPayload,
        channelId: this.channelId,
        timeStamp: {
          rtpTimestamp: auTimestamp,
          timestamp: this.timeData!.timestamp,
          timestamp_usec: this.timeData!.timestamp_usec,
          timezone: this.timeData!.timezone
        },
        rtcp_interleavedId: this.rtcpSession?.interleavedId
      };
      const audioInfo = {
        bitrate: this.bitrate,
        channelCount: this.channelCount,
        samplingFrequencyIndex: this.samplingFrequencyIndex,
        sampleRate: this.sampleRate
      };

      this.eventAudioCallback?.(playMode, streamData, audioInfo);

      // Consecutive AUs aggregated into one packet are back-to-back in time
      // (index-delta 0 — the standard case for a CBR-ish stream, and the
      // only one this depacketizer decodes the per-AU index-delta *value*
      // for beyond its bit width).
      auRtpTimeStamp += AAC_FRAME_SAMPLES;
    }
  }

  override close(): void {
    this.sessionId = null;
    this.stopStatisticsTimer();
  }
}
