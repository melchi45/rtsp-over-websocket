import { RtpSession } from '../RtpSession';
import { parseRtpHeaderFlags, syncPlaybackTimestampFromRtpExtension } from '../rtpDepacketizeUtils';
import { RTSPOverWebSocketError } from '../../exceptions';

const SIZE_1_4K = Math.floor(1.4 * 1024);

/** Reads a single bit from `byte`, indexed 0 (MSB) .. 7 (LSB) — matches the
 * bit-numbering VP9's uncompressed_header() syntax uses (RFC-style `f(n)`
 * reads, MSB first). */
function getBitFromMsb(byte: number, bitIndex: number): number {
  return (byte >> (7 - bitIndex)) & 0x1;
}

/**
 * RTP payload format for VP9 (draft-ietf-payload-vp9, the de facto deployed
 * revision — same descriptor shape Chrome/libwebrtc implement) — depacketizes
 * into a raw VP9 elementary bitstream (no start codes/length prefixes),
 * suitable for a WebCodecs `VideoDecoder` configured with `codec: 'vp9...'`.
 * Mirrors H264Session/H265Session's structure and error-handling style. The
 * scalability-structure (SS, `V` bit) is parsed just enough to skip past it
 * correctly — confirmed live that real encoders (e.g. ffmpeg's libvpx-vp9
 * RTP payloader) commonly set it on every keyframe even for a single,
 * non-scalable layer, so treating it as an unsupported/throw case (as
 * originally written, mirroring H264Session's STAP-B/MTAP throw) broke
 * ordinary single-layer streams in practice, not just multi-layer ones.
 */
export class VP9Session extends RtpSession {
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

  private parseFrameType(vp9Payload: Uint8Array): 'I' | 'P' {
    // VP9 uncompressed_header() (VP9 bitstream spec §6.2), read MSB-first:
    // frame_marker f(2), profile_low_bit f(1), profile_high_bit f(1),
    // [profile==3: reserved_zero f(1)], show_existing_frame f(1),
    // [!show_existing_frame: frame_type f(1)]. All of these fit in byte 0.
    const byte0 = vp9Payload[0];
    const profileLowBit = getBitFromMsb(byte0, 2);
    const profileHighBit = getBitFromMsb(byte0, 3);
    const profile = (profileHighBit << 1) | profileLowBit;

    let bitIndex = 4;
    if (profile === 3) {
      bitIndex += 1;
    }
    const showExistingFrame = getBitFromMsb(byte0, bitIndex);
    bitIndex += 1;
    if (showExistingFrame === 1) {
      // Not a newly coded frame — just a display reference to an already
      // decoded buffer. Treat as non-key for our purposes.
      return 'P';
    }
    return getBitFromMsb(byte0, bitIndex) === 0 ? 'I' : 'P';
  }

  override depacketize(rtspInterleaved: Uint8Array, rtpHeader: Uint8Array, rtpPayload: Uint8Array): void {
    const flags = parseRtpHeaderFlags(rtpHeader);
    let paddingSize = 0;
    this.debugLog.debug('depacketize()', `bytes=${rtpPayload.length}`, `marker=${flags.markerBit}`);

    if (rtspInterleaved[0] !== 0x24) {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: 0x0102,
        place: 'VP9Session.ts:depacketize',
        message: `it is not valid interleave header (RTSP over TCP). Interleaved[0] = ${rtspInterleaved[0].toString(16)}`
      });
    } else if (flags.csrcCount !== 0) {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: 0x0103,
        place: 'VP9Session.ts:depacketize',
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

    // Payload descriptor mandatory byte: I(1) P(1) L(1) F(1) B(1) E(1) V(1) Z(1)
    const descriptor0 = payload[0];
    const pictureIdPresent = (descriptor0 & 0x80) !== 0;
    const interPicturePredicted = (descriptor0 & 0x40) !== 0;
    const layerIndicesPresent = (descriptor0 & 0x20) !== 0;
    const flexibleMode = (descriptor0 & 0x10) !== 0;
    const startOfFrame = (descriptor0 & 0x08) !== 0;
    const scalabilityStructurePresent = (descriptor0 & 0x02) !== 0;

    let offset = 1;

    if (pictureIdPresent) {
      const extendedPictureId = (payload[offset] & 0x80) !== 0;
      offset += extendedPictureId ? 2 : 1;
    }

    if (layerIndicesPresent) {
      offset += 1; // TID(3) U(1) SID(3) D(1)
      if (!flexibleMode) {
        offset += 1; // TL0PICIDX
      }
    }

    if (interPicturePredicted && flexibleMode) {
      // Up to 3 reference-index (P_DIFF) octets, each with an N continuation bit.
      let referenceContinues = true;
      while (referenceContinues) {
        const refByte = payload[offset];
        referenceContinues = (refByte & 0x01) === 1;
        offset += 1;
      }
    }

    if (scalabilityStructurePresent) {
      // draft-ietf-payload-vp9 §4.2 SS: N_S(3) Y(1) G(1) -(3), then (if Y)
      // 4 bytes (2-byte width + 2-byte height) per spatial layer, then (if G)
      // a picture-group description this player has no use for — none of
      // these values are needed downstream (VP9HeaderParser.ts derives
      // width/height from the VP9 bitstream itself, not from this RTP-layer
      // hint), so this only needs to correctly skip past the structure to
      // find the real VP9 payload, not interpret it. Real encoders (e.g.
      // ffmpeg's libvpx-vp9 RTP payloader) commonly set this on every
      // keyframe even for a single, non-scalable layer — confirmed live —
      // so throwing here as "unsupported" broke ordinary single-layer
      // streams, not just genuinely multi-layer ones.
      const ssByte = payload[offset];
      const spatialLayerCount = ((ssByte >> 5) & 0x07) + 1; // N_S + 1
      const spatialResolutionsPresent = (ssByte & 0x10) !== 0; // Y
      const pictureGroupPresent = (ssByte & 0x08) !== 0; // G
      offset += 1;

      if (spatialResolutionsPresent) {
        offset += spatialLayerCount * 4;
      }

      if (pictureGroupPresent) {
        const pictureGroupSize = payload[offset];
        offset += 1;
        for (let i = 0; i < pictureGroupSize; i++) {
          const referenceCount = (payload[offset] >> 2) & 0x03; // R
          offset += 1 + referenceCount; // 1 header byte + R P_DIFF bytes
        }
      }
    }

    if (offset >= payload.length) {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: 0x0101,
        place: 'VP9Session.ts:depacketize',
        message: `VP9 payload descriptor length (${offset}) leaves no room for payload data (payload length = ${payload.length})`
      });
    }

    const vp9Payload = payload.subarray(offset);

    if (startOfFrame) {
      this.frameType = this.parseFrameType(vp9Payload);
    }

    this.setBuffer(vp9Payload);

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
        codecType: 'VP9',
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

      this.debugLog.info('depacketize() -> frame complete', `frameType=${this.frameType}`, `bytes=${inputBufferSub.length}`, `packetSeq=${this.getNumberOfReceivedPacketCount()}`);
      this.eventVideoCallback?.(playMode, streamData, videoInfo);
      this.frameType = 'P';
    }
  }

  override close(): void {
    this.sessionId = null;
    this.stopStatisticsTimer();
  }
}
