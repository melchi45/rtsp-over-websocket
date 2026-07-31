import { Session } from './Session';
import { IntervalTimer } from '../util/IntervalTimer';

const LOST_TIMEOUT = 5;
const DEFAULT_STATISTICS_INTERVAL = 1000;

export interface WaitingEvent {
  channelId: number;
  interleavedId: number;
  codec?: string;
  media?: string;
  duration: number;
  islost: boolean;
}

export interface RtpStatistics {
  channelId: number;
  interleavedId: number;
  codec?: string;
  media?: string;
  type: 'rtp';
  fps: number;
  interval: number;
  receviedPacket: number;
  droppedPacket: number;
}

/**
 * Ported from the legacy player’s MediaSession/rtpSession.js.
 * Debug-only logger calls are not reproduced (see Design doc, Layer 5 notes).
 * The large block of commented-out `addPacket`/mediaQueue code in the legacy
 * file was already dead and is dropped.
 */
export class RtpSession extends Session {
  decoder: unknown = null;
  codec = '';
  mime = '';
  rtcpSession: RTCPSessionLike | null = null;
  sessionId: string | null = null;
  information?: string;
  isLost = true;

  numberOfDroppedPacket = 0;
  numberOfReceivedPacket = 0;
  numberOfPrevTotalCount = 0;
  numberOfMediaTimerCount = 0;
  rtpLostCount = 0;
  frameRate?: number;
  startTimestamp?: number | string;
  sumOfInterval = 0;

  private govLength: number | null = null;
  private dropPer = 0;
  private dropCount = 0;
  private statisticsTimer: IntervalTimer | null = null;

  constructor() {
    super();
    this.deviceType = 'camera';
  }

  setFrameCallback(_cb: unknown): void {}
  setBufferingCallback(_cb: unknown): void {}
  setTimestampCallback(_cb: unknown): void {}
  setOutputSizeCallback(_cb: unknown): void {}
  setAACCodecInfo(_info: unknown): void {}
  override depacketize(_rtspInterleave: unknown, _rtpHeader: unknown, _rtpPacketArray: unknown): void {}
  bufferingRtpData(_rtspInterleave: unknown, _rtpHeader: unknown, _rtpPacketArray: unknown): void {}
  getRTPPacket(_channel: unknown, _rtpPayload: unknown): void {}
  calculatePacketTime(_rtpTimeStamp: unknown): void {}

  appendBuffer(currentBuffer: Uint8Array, newBuffer: Uint8Array, readLength: number): Uint8Array {
    const BUFFER_SIZE = 1024 * 1024;
    let buffer = currentBuffer;
    if (readLength + newBuffer.length >= buffer.length) {
      const tmp = new Uint8Array(buffer.length + BUFFER_SIZE);
      tmp.set(buffer, 0);
      buffer = tmp;
    }
    buffer.set(newBuffer, readLength);
    return buffer;
  }

  setFramerate(framerate: number): void {
    this.frameRate = framerate;
  }

  getFramerate(): number | undefined {
    return this.frameRate;
  }

  setGovLength(govLength: number): void {
    this.govLength = govLength;
  }

  getGovLength(): number | null {
    return this.govLength;
  }

  // NOTE: setDecodingTime/initStartTime/setCheckDelay are write-only in the
  // legacy file too (the values they set are never read anywhere) — kept as
  // no-ops here for API parity rather than storing genuinely dead state.
  setDecodingTime(_time: number): void {}

  getDropPercent(): number {
    return this.dropPer;
  }

  getDropCount(): number {
    return this.dropCount;
  }

  initStartTime(): void {}

  setCheckDelay(_checkDelay: number): void {}

  close(): void {
    this.sessionId = null;
  }

  startStatisticsTimer(interval?: number): void {
    const timerInterval = typeof interval !== 'undefined' ? interval : Math.floor(1000 / (this.frameRate ?? 1));
    if (this.statisticsTimer === null) {
      this.statisticsTimer = new IntervalTimer(() => this.onStatisticsTimer(), DEFAULT_STATISTICS_INTERVAL);
    }
    void timerInterval; // kept for parity with the legacy signature; the legacy code computed but never used it either.
  }

  stopStatisticsTimer(): void {
    if (this.statisticsTimer !== null) {
      this.statisticsTimer.pause();
      this.statisticsTimer = null;
    }
  }

  getStatisticsTimer(): IntervalTimer | null {
    return this.statisticsTimer;
  }

  setStartTimeStamp(timeStamp: number | string): void {
    this.startTimestamp = timeStamp;
    this.sumOfInterval = 0;
  }

  getTimerStamp(): number {
    return Number(this.startTimestamp) + this.sumOfInterval;
  }

  increaseNumberOfReceivedPacketCount(): void {
    this.numberOfReceivedPacket++;
    this.isLost = false;
  }

  getNumberOfReceivedPacketCount(): number {
    return this.numberOfReceivedPacket;
  }

  setNumberOfReceivedPacketCount(packetCount: number): void {
    this.numberOfReceivedPacket = Number(packetCount);
  }

  isInitializeReceivedPacketCount(): boolean {
    return this.numberOfReceivedPacket === 0;
  }

  increaseNumberOfDroppedPacket(): void {
    this.numberOfDroppedPacket++;
  }

  getNumberOfDroppedPacketCount(): number {
    return this.numberOfDroppedPacket;
  }

  onStatisticsTimer(): void {
    const compare = Math.abs(this.numberOfReceivedPacket - this.numberOfPrevTotalCount);
    const lostTimeout = this.eventWaitingTimeout || LOST_TIMEOUT;

    if (compare === 0) {
      if (this.rtpLostCount > lostTimeout) {
        if (
          this.eventWaitingCallback &&
          ((this.type === 'video' && typeof this.information === 'undefined') || this.type === 'audio') &&
          this.isLost !== true
        ) {
          this.isLost = true;
          this.eventWaitingCallback({
            channelId: this.channelId,
            interleavedId: this.interleavedId,
            codec: this.codec,
            media: this.type,
            duration: lostTimeout,
            islost: this.isLost
          } satisfies WaitingEvent);
        }
      }
      this.rtpLostCount++;
    } else {
      if (
        this.eventWaitingCallback &&
        (this.type === 'video' || this.type === 'audio') &&
        this.isLost === false &&
        this.rtpLostCount > lostTimeout
      ) {
        this.eventWaitingCallback({
          channelId: this.channelId,
          interleavedId: this.interleavedId,
          codec: this.codec,
          media: this.type,
          duration: lostTimeout,
          islost: this.isLost
        } satisfies WaitingEvent);
      }
      this.rtpLostCount = 0;
    }

    if (this.eventStatisticsCallback && !this.isLost) {
      this.eventStatisticsCallback({
        channelId: this.channelId,
        interleavedId: this.interleavedId,
        codec: typeof this.information === 'undefined' ? this.codec : this.information,
        media: this.type,
        type: 'rtp',
        fps: this.numberOfReceivedPacket - this.numberOfPrevTotalCount,
        interval: ~~(this.sumOfInterval / this.numberOfMediaTimerCount),
        receviedPacket: this.numberOfReceivedPacket,
        droppedPacket: this.numberOfDroppedPacket
      } satisfies RtpStatistics);
    }

    this.numberOfPrevTotalCount = this.numberOfReceivedPacket;
  }
}

interface RTCPSessionLike {
  interleavedId: number;
  rtpTimestamp?: number | string;
}
