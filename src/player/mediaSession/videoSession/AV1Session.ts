import { RtpSession } from '../RtpSession';
import { parseRtpHeaderFlags, syncPlaybackTimestampFromRtpExtension } from '../rtpDepacketizeUtils';
import { RTSPOverWebSocketError } from '../../exceptions';

const SIZE_1_4K = Math.floor(1.4 * 1024);

/** AV1 OBU types (AV1 Bitstream & Decoding Process spec §6.2.2) that this
 * session inspects; every other type is opaque payload as far as
 * depacketizing is concerned. */
const OBU_SEQUENCE_HEADER = 1;

interface Leb128Result {
  value: number;
  bytesRead: number;
}

/** Reads an unsigned LEB128 value (AV1 RTP payload spec §4.4 OBU element
 * length field), matching the `leb128()` parse used throughout the AV1
 * bitstream spec itself. */
function readLeb128(data: Uint8Array, offset: number): Leb128Result {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;

  while (bytesRead < 8) {
    if (offset + bytesRead >= data.length) {
      throw new RTSPOverWebSocketError({
        errorCode: 0x0101,
        place: 'AV1Session.ts:readLeb128',
        message: 'AV1 OBU element leb128 size field runs past the end of the RTP payload.'
      });
    }
    const byte = data[offset + bytesRead];
    value |= (byte & 0x7f) << shift;
    bytesRead += 1;
    if ((byte & 0x80) === 0) {
      break;
    }
    shift += 7;
  }

  return { value: value >>> 0, bytesRead };
}

/**
 * RTP payload format for AV1 (AOM "RTP Payload Format For AV1" v1.0) —
 * depacketizes into a raw AV1 low-overhead-bitstream-format OBU stream (no
 * extra framing beyond what the OBUs themselves carry), suitable for a
 * WebCodecs `VideoDecoder` configured with `codec: 'av01...'`. Mirrors
 * H264Session/H265Session's structure and error-handling style.
 */
export class AV1Session extends RtpSession {
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

  /** Splits the OBU-element region of one RTP packet's payload (i.e. after
   * the 1-byte aggregation header) into individual OBU element byte ranges,
   * per AV1 RTP payload spec §4.4. */
  private splitObuElements(payload: Uint8Array, obuCount: number): Uint8Array[] {
    const elements: Uint8Array[] = [];
    let pos = 1;

    if (obuCount === 0) {
      // Unknown element count: every element (including the last) is
      // preceded by an explicit leb128 length field.
      while (pos < payload.length) {
        const { value: size, bytesRead } = readLeb128(payload, pos);
        pos += bytesRead;
        elements.push(payload.subarray(pos, pos + size));
        pos += size;
      }
    } else {
      // Known element count: the first (obuCount - 1) elements are
      // length-prefixed; the final element runs to the end of the packet.
      for (let i = 0; i < obuCount - 1; i++) {
        const { value: size, bytesRead } = readLeb128(payload, pos);
        pos += bytesRead;
        elements.push(payload.subarray(pos, pos + size));
        pos += size;
      }
      elements.push(payload.subarray(pos));
    }

    return elements;
  }

  override depacketize(rtspInterleaved: Uint8Array, rtpHeader: Uint8Array, rtpPayload: Uint8Array): void {
    const flags = parseRtpHeaderFlags(rtpHeader);
    let paddingSize = 0;

    if (rtspInterleaved[0] !== 0x24) {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: 0x0102,
        place: 'AV1Session.ts:depacketize',
        message: `it is not valid interleave header (RTSP over TCP). Interleaved[0] = ${rtspInterleaved[0].toString(16)}`
      });
    } else if (flags.csrcCount !== 0) {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: 0x0103,
        place: 'AV1Session.ts:depacketize',
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

    // Aggregation header (1 byte, every packet): Z(1) Y(1) W(2) N(1) -(3)
    const aggregationHeader = payload[0];
    const continuesFragment = (aggregationHeader & 0x80) !== 0; // Z
    const obuCount = (aggregationHeader & 0x30) >> 4; // W

    const elements = this.splitObuElements(payload, obuCount);

    for (let i = 0; i < elements.length; i++) {
      const element = elements[i];
      // An element that continues a fragment split across packets (the
      // first element of this packet when Z=1) doesn't start with a fresh
      // obu_header — don't misread its continuation bytes as one.
      const isFragmentContinuation = i === 0 && continuesFragment;
      if (!isFragmentContinuation && element.length > 0) {
        const obuType = (element[0] >> 3) & 0x0f;
        if (obuType === OBU_SEQUENCE_HEADER) {
          // Encoders emit a Sequence Header OBU only ahead of a key frame;
          // used here the same way H264Session/H265Session treat the
          // presence of SPS/VPS as the key-frame signal.
          this.frameType = 'I';
        }
      }
      this.setBuffer(element);
    }

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
        codecType: 'AV1',
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
