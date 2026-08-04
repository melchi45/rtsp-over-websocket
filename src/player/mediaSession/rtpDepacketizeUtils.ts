import type { RtpSession } from './RtpSession';

export interface RtpHeaderFlags {
  version: number;
  padding: boolean;
  extension: boolean;
  csrcCount: number;
  markerBit: boolean;
  payloadType: number;
}

/**
 * Shared RTP header flag parsing, identical across every codec session
 * (h264Session, h265Session, aacSession, g711Session,
 * g726Session, metaSession in the legacy codebase).
 */
export function parseRtpHeaderFlags(rtpHeader: Uint8Array): RtpHeaderFlags {
  return {
    version: (rtpHeader[0] & 0xc0) >> 6,
    padding: ((rtpHeader[0] & 0x20) >> 5) === 1,
    extension: ((rtpHeader[0] & 0x10) >> 4) === 1,
    csrcCount: rtpHeader[0] & 0x0f,
    markerBit: ((rtpHeader[1] & 0x80) >> 7) === 1,
    payloadType: rtpHeader[1] & 0x7f
  };
}

/**
 * Shared "playback NTP timestamp extension" sync logic, identical across the
 * same six codec sessions listed above: when the RTP extension header carries
 * a Hanwha playback timestamp marker (`0xAB 0xAD`/`0xAC`), decode the NTP
 * timestamp, estimate the framerate from the gap to the previous frame, and
 * record it via session.SetTimeStamp(). Returns the new `playback` flag value
 * (true once this marker has ever been seen, otherwise unchanged).
 */
export function syncPlaybackTimestampFromRtpExtension(
  session: RtpSession,
  rtpPayload: Uint8Array,
  currentPlayback: boolean
): boolean {
  if (rtpPayload[0] !== 0xab || (rtpPayload[1] !== 0xad && rtpPayload[1] !== 0xac)) {
    return currentPlayback;
  }

  let startHeader = 4;
  const ntpMsw = new Uint8Array(4);
  const ntpLsw = new Uint8Array(4);
  ntpMsw.set(rtpPayload.subarray(startHeader, startHeader + 4), 0);
  startHeader += 4;
  ntpLsw.set(rtpPayload.subarray(startHeader, startHeader + 4), 0);

  let timezone: number | null = null;
  if (session.deviceType === 'camera') {
    startHeader += 6;
    const gmt = new Uint8Array(2);
    gmt.set(rtpPayload.subarray(startHeader, startHeader + 2), 0);
    timezone = (((gmt[0] << 8) | gmt[1]) << 16) >> 16;
  }

  const tempTimestamp = (session.ntohl(ntpMsw) - 0x83aa7e80) >>> 0;
  const tempTimestampUsec = (session.ntohl(ntpLsw) / 0xffffffff) * 1000;

  const prev = session.GetTimeStamp();
  if (prev !== null && prev.timestamp !== null && prev.timestamp_usec !== null) {
    const timeGap = Math.abs(tempTimestamp - prev.timestamp);
    if (timeGap <= 1) {
      const distance = Math.abs(
        tempTimestamp * 1000 + tempTimestampUsec - (prev.timestamp * 1000 + prev.timestamp_usec)
      );
      if (distance !== 0) {
        session.setFramerate(Math.round(1000 / distance));
      }
    }
  }

  session.SetTimeStamp({ timestamp: tempTimestamp, timestamp_usec: tempTimestampUsec, timezone });
  return true;
}
