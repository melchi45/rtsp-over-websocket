import { RtpSession } from '../RtpSession';

const RTP_STACK_CHECK_NUM = 50;

export interface MjpegRtpDataEntry {
  deviceType: 'camera' | 'nvr';
  rtspInterleave: Uint8Array;
  interleavedId: number;
  channelId: number;
  header: Uint8Array;
  payload: Uint8Array;
}

export interface MjpegWorkerMessage {
  playMode: unknown;
  streamData: unknown;
  videoInfo: unknown;
}

export interface MjpegWorkerLike {
  onmessage: ((event: { data: MjpegWorkerMessage }) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

export type MjpegWorkerFactory = () => MjpegWorkerLike;

/**
 * Ported from the legacy player’s MediaSession/VideoSession/mjpegSession.
 *
 * The legacy player's always-on debug logger calls were originally not
 * reproduced. The RTP header fields legacy computed purely for that (dropped)
 * debug log — version/padding/extension/CSRC count/payload type/sequence
 * number — have no other observable effect (they're local closure vars,
 * never stored or read elsewhere) and stay dropped; only the marker bit and
 * timestamp are kept, since those drive real control flow below. Debug
 * tracing itself was reintroduced 2026-09-04, gated behind the `debug`
 * attribute (`util/debugLog.ts`, `video: ["MjpegSession"]`) rather than
 * always-on, and limited to what this class already computes for real
 * control flow (byte counts, queue depth) — not a full reproduction of the
 * legacy log's per-field header dump.
 *
 * `mjpegDepacketizeWorker` is a *per-instance* closure variable in legacy
 * (mjpegSession is a plain factory function, called fresh via `new` for
 * every session — not a singleton IIFE), so it's ported as a private
 * instance field, not shared module state.
 */
export class MjpegSession extends RtpSession {
  private worker: MjpegWorkerLike | null = null;
  private rtpDataArray: MjpegRtpDataEntry[] = [];
  private readonly workerFactory: MjpegWorkerFactory;

  constructor(
    workerFactory: MjpegWorkerFactory = () =>
      new Worker(new URL('../../worker/mjpegSession/mjpegDepacketizeWorker.ts', import.meta.url)) as unknown as MjpegWorkerLike
  ) {
    super();
    this.workerFactory = workerFactory;
  }

  override init(): void {
    if (this.worker === null) {
      this.worker = this.workerFactory();
      this.worker.onmessage = (event) => this.handleWorkerMessage(event.data);
    }
  }

  private handleWorkerMessage(message: MjpegWorkerMessage): void {
    const isMetaImage = this.information === 'MetaImageSession';
    this.debugLog.info('handleWorkerMessage() -> frame complete', `playMode=${message.playMode}`, `isMetaImage=${isMetaImage}`);
    this.eventVideoCallback?.(message.playMode, message.streamData, message.videoInfo, isMetaImage);
  }

  override depacketize(rtspInterleaved: Uint8Array, rtpHeader: Uint8Array, rtpPayload: Uint8Array): void {
    this.debugLog.debug('depacketize()', `bytes=${rtpPayload.length}`, `queued=${this.rtpDataArray.length}`);
    const rtpData: MjpegRtpDataEntry = {
      deviceType: this.deviceType === 'camera' ? 'camera' : 'nvr',
      rtspInterleave: rtspInterleaved,
      interleavedId: this.interleavedId,
      channelId: this.channelId,
      header: rtpHeader,
      payload: rtpPayload
    };

    const rtpMarkerBit = ((rtpHeader[1] & 0x80) >> 7) === 1;
    const rtpTimeStamp = this.ntohl(rtpHeader.subarray(4, 8));

    this.rtpDataArray.push(rtpData);
    if (rtpMarkerBit) {
      this.rtpTimestamp = (rtpTimeStamp / this.clock).toFixed(0);
      if (this.isInitializeReceivedPacketCount()) {
        this.setStartTimeStamp(this.rtpTimestamp);
      }
      this.increaseNumberOfReceivedPacketCount();
    }

    if (this.rtpDataArray.length >= RTP_STACK_CHECK_NUM || rtpMarkerBit) {
      const message = { dataArray: this.rtpDataArray.splice(0, RTP_STACK_CHECK_NUM) };
      this.worker?.postMessage(message);
    }
  }

  override close(): void {
    this.sessionId = null;
    this.stopStatisticsTimer();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}
