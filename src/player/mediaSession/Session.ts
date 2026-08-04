export interface TimeData {
  timestamp: number | null;
  timestamp_usec: number | null;
  timezone: number | null;
}

export type SessionEventName = 'text' | 'video' | 'metaImage' | 'audio' | 'rtcp' | 'statistics' | 'waiting';
export type SessionEventCallback = (...args: unknown[]) => void;

export class Session {
  interleavedId = 0;
  channelId = 0;
  timeData: TimeData | null = null;
  running = false;
  clock = 90;
  type?: string;
  deviceType?: string;
  rtpTimestamp?: number | string;

  eventMetaCallback?: SessionEventCallback | null;
  eventVideoCallback?: SessionEventCallback | null;
  eventMetaImageCallback?: SessionEventCallback | null;
  eventAudioCallback?: SessionEventCallback | null;
  eventRtcpCallback?: SessionEventCallback;
  eventStatisticsCallback?: SessionEventCallback | null;
  eventWaitingCallback?: SessionEventCallback;
  eventWaitingTimeout?: number;

  // Optional/untyped `info` so codec subclasses (AACSession, G711Session, ...)
  // can override with their own required codec-info parameter — the legacy
  // JS is duck-typed here and each subtype's init() takes whatever it needs.
  init(_info?: unknown): void {}

  depacketize(_rtspInterleaved: unknown, _rtpHeader: unknown, _rtpPayload: unknown): void {}

  /** Host byte order (little-endian) -> network byte order (big-endian), 32-bit. */
  htonl(h: number): number[] {
    return [(h & 0xff000000) >>> 24, (h & 0x00ff0000) >>> 16, (h & 0x0000ff00) >>> 8, (h & 0x000000ff) >>> 0];
  }

  /** Network byte order (big-endian) -> host byte order (little-endian), 32-bit. */
  ntohl(n: ArrayLike<number>): number {
    return (((0xff & n[0]) << 24) + ((0xff & n[1]) << 16) + ((0xff & n[2]) << 8) + (0xff & n[3])) >>> 0;
  }

  /** Host byte order (little-endian) -> network byte order (big-endian), 16-bit. */
  htons(h: number): number[] {
    return [(h & 0xff00) >>> 8, (h & 0x00ff) >>> 0];
  }

  /** Network byte order (big-endian) -> host byte order (little-endian), 16-bit. */
  ntohs(n: ArrayLike<number>): number {
    return ((0xff & n[0]) << 8) + (0xff & n[1]) >>> 0;
  }

  addEventListener(event: SessionEventName, eventCallback: SessionEventCallback, extraInfo?: { waitingTimeout?: number }): void {
    switch (event) {
      case 'text':
        this.eventMetaCallback = eventCallback;
        break;
      case 'video':
        this.eventVideoCallback = eventCallback;
        break;
      case 'metaImage':
        this.eventMetaImageCallback = eventCallback;
        break;
      case 'audio':
        this.eventAudioCallback = eventCallback;
        break;
      case 'rtcp':
        this.eventRtcpCallback = eventCallback;
        break;
      case 'statistics':
        this.eventStatisticsCallback = eventCallback;
        break;
      case 'waiting':
        this.eventWaitingCallback = eventCallback;
        if (extraInfo) {
          this.eventWaitingTimeout = extraInfo.waitingTimeout;
        }
        break;
    }
  }

  removeEventListener(event: SessionEventName): void {
    switch (event) {
      case 'text':
        this.eventMetaCallback = null;
        break;
      case 'video':
        this.eventVideoCallback = null;
        break;
      case 'metaImage':
        this.eventMetaImageCallback = null;
        break;
      case 'audio':
        this.eventAudioCallback = null;
        break;
      case 'statistics':
        this.eventStatisticsCallback = null;
        break;
    }
  }

  SetTimeStamp(data: TimeData): void {
    this.timeData = data;
  }

  GetTimeStamp(): TimeData | null {
    return this.timeData;
  }
}
