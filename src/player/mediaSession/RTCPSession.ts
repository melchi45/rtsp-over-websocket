import { Session } from './Session';
import { RTCPError } from '../exceptions';

const RTCP_TYPE = {
  RTCP_SR: 200,
  RTCP_RR: 201,
  RTCP_SDES: 202,
  RTCP_BYE: 203,
  RTCP_APP: 204
} as const;

export interface SdesEntry {
  type: number;
  length: number;
  content: string;
}

/**
 * Ported from the legacy player’s MediaSession/rtcpSession.
 * The legacy file's always-on debug logger calls were originally not
 * reproduced (see Design doc, Layer 5 notes) — they carried no behavior,
 * only console noise. Reintroduced 2026-09-04, this time gated behind the
 * `debug` attribute (`util/debugLog.ts`, `mediaSession: ["RTCPSession"]`)
 * instead of always-on.
 */
export class RTCPSession extends Session {
  sessionId: string | null = null;
  private readonly ssrc = new Uint8Array(4);
  private readonly ntpMsw = new Uint8Array(4);
  private readonly ntpLsw = new Uint8Array(4);
  private readonly rtp = new Uint8Array(4);
  private readonly spc = new Uint8Array(4);
  private readonly soc = new Uint8Array(4);

  override init(): void {
    this.timeData = { timestamp: null, timestamp_usec: null, timezone: null };
  }

  sdesParse(sdes: Uint8Array): SdesEntry[] {
    let ptr = 0;
    const list: SdesEntry[] = [];
    do {
      const sdesType = sdes[ptr];
      ptr += 1;
      const sdesLength = sdes[ptr];
      ptr += 1;
      const content = String.fromCharCode(...sdes.subarray(ptr, ptr + sdesLength));
      ptr += sdesLength;
      list.push({ type: sdesType, length: sdesLength, content });
    } while (ptr < sdes.length);
    return list;
  }

  parse(rtcpData: Uint8Array): void {
    const rtcpType = rtcpData[1];

    switch (rtcpType) {
      case RTCP_TYPE.RTCP_SR: {
        let ptr = 4;
        this.ssrc.set(rtcpData.subarray(ptr, (ptr += 4)), 0);
        this.ntpMsw.set(rtcpData.subarray(ptr, (ptr += 4)), 0);
        this.ntpLsw.set(rtcpData.subarray(ptr, (ptr += 4)), 0);

        this.SetTimeStamp({
          timestamp: (this.ntohl(this.ntpMsw) - 0x83aa7e80) >>> 0,
          timestamp_usec: (this.ntohl(this.ntpLsw) / 0xffffffff) * 1000,
          // NOTE: legacy rtcpSession never sets `timezone` in this branch
          // (unlike the codec sessions' NTP-extension sync) — its tempdata
          // object simply never had the field, so it reads back `undefined`.
          timezone: undefined as unknown as number | null
        });

        this.rtp.set(rtcpData.subarray(ptr, (ptr += 4)), 0);
        this.rtpTimestamp = (this.ntohl(this.rtp) / this.clock).toFixed(0);

        this.spc.set(rtcpData.subarray(ptr, (ptr += 4)), 0);
        this.soc.set(rtcpData.subarray(ptr, (ptr += 4)), 0);

        const data = {
          interleaved: this.interleavedId,
          packetCount: this.ntohl(this.spc),
          octetCount: this.ntohl(this.soc),
          timeStamp: {
            rtpTimestamp: this.rtpTimestamp,
            timestamp: this.timeData!.timestamp,
            timestamp_usec: this.timeData!.timestamp_usec,
            timezone: this.timeData!.timezone
          }
        };
        this.debugLog.info('parse() -> sender report', `packetCount=${data.packetCount}`, `octetCount=${data.octetCount}`);
        this.eventRtcpCallback?.(data);
        break;
      }
      case RTCP_TYPE.RTCP_SDES: {
        const ptr = 4;
        this.ssrc.set(rtcpData.subarray(ptr, ptr + 4), 0);
        const sdesEntries = this.sdesParse(rtcpData.subarray(ptr + 4, rtcpData.length));
        this.debugLog.debug('parse() -> SDES', `entries=${sdesEntries.length}`);
        break;
      }
      case RTCP_TYPE.RTCP_BYE:
        this.debugLog.info('parse() -> BYE');
        if (this.type === 'video') {
          throw new RTCPError({
            channelId: this.channelId,
            errorCode: 0x0209,
            place: 'RTCPSession.ts:parse',
            message: 'RTCP goodbye message'
          });
        }
        break;
    }
  }

  override depacketize(_rtspInterleaved: unknown, rtcpHeader: Uint8Array, rtpPayload: Uint8Array): void {
    this.debugLog.debug('depacketize()', `bytes=${rtcpHeader.length + rtpPayload.length}`);
    const data = new Uint8Array(rtcpHeader.length + rtpPayload.length);
    data.set(rtcpHeader, 0);
    data.set(rtpPayload, rtcpHeader.length);

    let ptr = 0;
    while (ptr < data.length) {
      const rtcpLength = (data[ptr + 2] << 8) + data[ptr + 3];
      this.parse(data.subarray(ptr, (ptr += 4 + 4 * rtcpLength)));
    }
  }

  close(): void {
    this.sessionId = null;
  }
}
