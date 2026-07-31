import { RtpSession } from '../RtpSession';

export interface PresentationTime {
  tv_sec: number;
  tv_usec: number;
}

/**
 * Ported from the legacy player’s MediaSession/VideoSession/videoRtcpSession.js
 * (legacy class name `RtcpSession` — renamed to `VideoRtcpSession` here to
 * avoid a case-only collision with mediaSession/RTCPSession.ts, which is a
 * distinct, unrelated class — a discovered pre-existing naming clash,
 * resolved by renaming rather than preserved as-is).
 */
export class VideoRtcpSession extends RtpSession {
  private ntpMsw = 0;
  private ntpLsw = 0;
  private rtpTimestampValue = 0;
  private fsyncTimestamp = 0;
  private fsyncTime: { seconds: number; useconds: number } = { seconds: 0, useconds: 0 };

  constructor(private readonly clockFreq: number) {
    super();
  }

  private noteIncomingSR(ntpmsw: number, ntplsw: number, rtptimestamp: number): void {
    const microseconds = (ntplsw * 15625.0) / 0x04000000;
    this.fsyncTime = { seconds: ntpmsw - 0x83aa7e80, useconds: microseconds + 0.5 };
    this.fsyncTimestamp = rtptimestamp;
  }

  SendRtpData(_rtspInterleaved: unknown, rtpHeader: Uint8Array, rtpPayload: Uint8Array): void {
    const rtcpSize = rtpPayload.length + 12;
    const rtcpBuffer = new Uint8Array(rtcpSize);
    rtcpBuffer.set(rtpHeader, 0);
    rtcpBuffer.set(rtpPayload, 12);

    const pt = rtcpBuffer[1];
    let startHeader = 4;
    startHeader += 4; // sender SSRC (unused beyond skipping the offset)

    if (pt === 200) {
      const ntpMswBytes = new Uint8Array(4);
      ntpMswBytes.set(rtcpBuffer.subarray(startHeader, startHeader + 4), 0);
      this.ntpMsw = this.ntohl(ntpMswBytes);
      startHeader += 4;

      const ntpLswBytes = new Uint8Array(4);
      ntpLswBytes.set(rtcpBuffer.subarray(startHeader, startHeader + 4), 0);
      this.ntpLsw = this.ntohl(ntpLswBytes);
      startHeader += 4;

      const rtpTimestampBytes = new Uint8Array(4);
      rtpTimestampBytes.set(rtcpBuffer.subarray(startHeader, startHeader + 4), 0);
      this.rtpTimestampValue = this.ntohl(rtpTimestampBytes);

      this.noteIncomingSR(this.ntpMsw, this.ntpLsw, this.rtpTimestampValue);
    }
  }

  override calculatePacketTime(rtpTimeStamp: number): PresentationTime {
    let timeDiff = (rtpTimeStamp - this.fsyncTimestamp) / this.clockFreq;
    const million = 1000000;
    let seconds: number;
    let uSeconds: number;

    if (this.fsyncTime.seconds === 0) {
      this.fsyncTime = { seconds: Math.round(Date.now() / 1000), useconds: 0 };
    }

    if (timeDiff >= 0.0) {
      seconds = this.fsyncTime.seconds + timeDiff;
      uSeconds = this.fsyncTime.useconds + (timeDiff - timeDiff) * million;
      if (uSeconds >= million) {
        uSeconds -= million;
        ++seconds;
      }
    } else {
      timeDiff = -timeDiff;
      seconds = this.fsyncTime.seconds - timeDiff;
      uSeconds = this.fsyncTime.useconds - (timeDiff - timeDiff) * million;
      if (uSeconds < 0) {
        uSeconds += million;
        --seconds;
      }
    }

    return { tv_sec: seconds, tv_usec: uSeconds };
  }
}
