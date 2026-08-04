import { RTSPOverWebSocketError, RTCPError, RTSPError } from '../../exceptions';
import { IntervalTimer } from '../../util/IntervalTimer';
import { uint8ArrayToString, stringToUint8Array } from '../../util/binaryString';
import { indexOfMulti } from '../../util/indexOfMulti';
import { WebsocketStatusCode } from '../WebsocketStatusCode';

const MAGIC_NUMBER = 0x24;
const CR = 0x0d;
const LF = 0x0a;
const FOUR = 4;
const RTSP_INTERLEAVE_LENGTH = 4;
const RTP_HEADER_LENGTH = 12;

export interface CloseOrErrorEventLike {
  code: number;
  reason?: string;
}

export interface WebSocketLike {
  readyState: number;
  binaryType: string;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null;
  onclose: ((ev: CloseOrErrorEventLike) => void) | null;
  onerror: ((ev: CloseOrErrorEventLike) => void) | null;
  send(data: unknown): void;
  close(): void;
}

export type TransportEventType = 'rtsp' | 'rtp' | 'connected' | 'disconnected';

export interface TransportEvent<T = unknown> {
  type: TransportEventType;
  bubbles: boolean;
  detail: T;
  target?: unknown;
}

export type RtspCallback = (rtspData: string) => void;
export type RtpCallback = (interleave: Uint8Array, header: Uint8Array, payload: Uint8Array) => void;
export type ConnectionCallback = (status: 'open' | 'close' | 'error', data: unknown) => void;
export type ErrorCallback = (info: { channelId: number | undefined; errorCode: number; place: string; description: string }) => void;
export type ReceivedBytesCallback = (data: { channelId: number | undefined; current: number; total: number }) => void;
export type RtspResponseCallback = (response: string | Error) => void;

interface RTSPOverWebSocketErrorLike extends Error {
  errorCode?: number;
  place?: string;
}

/**
 * Ported from the legacy player’s Network/transport/transport — WebSocket
 * transport for RTSP-over-WebSocket, demultiplexing interleaved RTSP text
 * responses from RTP/RTCP binary packets on the same socket.
 *
 * Console/logger calls from the legacy file are not reproduced (see Design
 * doc, Layer 5/6 notes) — observability only, no effect on behavior. The
 * `typeof window.CustomEvent === 'function'` guards are also dropped since
 * CustomEvent is universally available in this library's target browsers;
 * events are always dispatched.
 */
export class Transport {
  websock: WebSocketLike | null = null;
  // NOTE: legacy transport never initializes channelId/readyState/autoconnection/index
  // in a constructor — they stay `undefined` until either `initializeWebsocket()` runs
  // (only ever called from within OnClose, not on construction) or a caller sets them
  // explicitly right after creating the Transport. Preserved as-is rather than defaulting
  // to 0/false, since real callers (rtspClient) always set channelId immediately anyway.
  channelId?: number;
  readyState?: number;
  autoconnection?: boolean;
  index?: number;

  private rtspCallback: RtspCallback | null = null;
  private rtpCallback: RtpCallback | null = null;
  private connectionCallback: ConnectionCallback | null = null;
  private errorCallback: ErrorCallback | null = null;
  private receivedCallback: ReceivedBytesCallback | null = null;
  private rtspResponseCallback: RtspResponseCallback | null = null;

  private currentReceivedBytes = 0;
  private totalReceivedBytes = 0;
  private statisticsTimer: IntervalTimer | null = null;
  private fragmentedData: Uint8Array | null = null;
  private readonly listeners = new Map<(event: TransportEvent) => void, { type: TransportEventType; listener: (event: TransportEvent) => void }>();

  constructor(private readonly serverAddr: string) {}

  /** WebSocket.CLOSED per the standard WebSocket readyState constants. */
  static readonly CLOSED = 3;
  static readonly OPEN = 1;

  private initializeWebsocket(): void {
    this.init();
    this.websock = null;
    this.channelId = 0;
    this.readyState = Transport.CLOSED;
    this.autoconnection = false;
    this.index = 0;
  }

  OnReceive = (event: { data: ArrayBuffer }): void => {
    let byteData: Uint8Array;
    let index = 0;
    let length = 0;

    this.currentReceivedBytes += event.data.byteLength;

    if (this.fragmentedData) {
      byteData = new Uint8Array(this.fragmentedData.byteLength + event.data.byteLength);
      byteData.set(this.fragmentedData, 0);
      byteData.set(new Uint8Array(event.data), this.fragmentedData.byteLength);
    } else {
      byteData = new Uint8Array(event.data);
    }

    try {
      if (uint8ArrayToString(byteData.subarray(0, 4)) === 'RTSP') {
        index = indexOfMulti(byteData, [CR, LF, CR, LF]);
        index += FOUR;
        let rtspData: string;
        if (typeof TextDecoder === 'function') {
          rtspData = new TextDecoder().decode(byteData.subarray(0, index));
        } else {
          rtspData = uint8ArrayToString(byteData.subarray(0, index));
        }

        const found = rtspData.match(/Content-Length: (\d+)/);
        if (found) {
          if (index + Number(found[1]) > byteData.length) {
            this.fragmentedData = byteData;
            return;
          }
          rtspData += uint8ArrayToString(byteData.subarray(index, (index += Number(found[1]))));
        }

        this.rtspCallback?.(rtspData);
        if (this.rtspResponseCallback !== null) {
          this.rtspResponseCallback(rtspData);
          this.rtspResponseCallback = null;
        }

        this.dispatchEvent({ type: 'rtsp', bubbles: true, detail: { channel: this.channelId, data: { rtsp: rtspData } } });

        if (index < byteData.length) {
          byteData = byteData.subarray(index);
          index = 0;
        } else {
          this.fragmentedData = null;
          return;
        }
      }

      if (byteData[0] === MAGIC_NUMBER) {
        while (index + RTSP_INTERLEAVE_LENGTH <= byteData.length) {
          length = (byteData[index + 2] << 8) + byteData[index + 3];
          if (index + RTSP_INTERLEAVE_LENGTH + length > byteData.length) {
            break;
          }
          const interleave = byteData.subarray(index, (index += RTSP_INTERLEAVE_LENGTH));
          const header = byteData.subarray(index, (index += RTP_HEADER_LENGTH));
          const payload = byteData.subarray(index, (index += length - RTP_HEADER_LENGTH));

          this.rtpCallback?.(interleave, header, payload);
          this.dispatchEvent({
            type: 'rtp',
            bubbles: true,
            detail: { channel: this.channelId, data: { interleave, rtpheader: header, rtppacket: payload } }
          });

          if (uint8ArrayToString(byteData.subarray(index, index + 4)) === 'RTSP') {
            const start = index;
            index = indexOfMulti(byteData, [CR, LF, CR, LF]);
            index += FOUR;
            let rtspData = uint8ArrayToString(byteData.subarray(start, index));
            const found = rtspData.match(/Content-Length: (\d+)/);
            if (index <= 4 || rtspData.length <= 1) {
              this.fragmentedData = byteData.subarray(start, byteData.length);
              return;
            }
            if (found) {
              if (index + Number(found[1]) > byteData.length) {
                this.fragmentedData = byteData;
                return;
              }
              rtspData += uint8ArrayToString(byteData.subarray(index, (index += Number(found[1]))));
            }

            this.rtspCallback?.(rtspData);
            if (this.rtspResponseCallback !== null) {
              this.rtspResponseCallback(rtspData);
              this.rtspResponseCallback = null;
            }

            this.dispatchEvent({ type: 'rtsp', bubbles: true, detail: { channel: this.channelId, data: { rtsp: rtspData } } });

            if (index < byteData.length) {
              byteData = byteData.subarray(index);
              index = 0;
            }
            break;
          }
        }
        this.fragmentedData = index < byteData.length ? byteData.subarray(index) : null;
      } else {
        this.errorCallback?.({
          channelId: this.channelId,
          errorCode: 0x0200,
          place: 'Transport.ts:OnReceive',
          description: 'Invalid RTSP/RTP data in the channel'
        });
        this.fragmentedData = null;
      }
    } catch (error) {
      if (error instanceof RTCPError) {
        return;
      }

      const rtspError = error as RTSPOverWebSocketErrorLike;
      this.errorCallback?.({
        channelId: this.channelId,
        errorCode: rtspError.errorCode ?? 0,
        place: rtspError.place ?? '',
        description: rtspError.message
      });

      if (error instanceof RTSPError && this.rtspResponseCallback !== null) {
        this.rtspResponseCallback(error);
        this.rtspResponseCallback = null;
      }

      this.fragmentedData = null;
    }
  };

  startStatisticsTimer(): void {
    if (this.statisticsTimer !== null) {
      this.statisticsTimer.pause();
      this.statisticsTimer = null;
    }
    this.statisticsTimer = new IntervalTimer(() => this.onStatisticsTimer(), 1000);
  }

  OnOpen = (message: unknown): void => {
    this.connectionCallback?.('open', message);

    if (this.websock) {
      this.readyState = this.websock.readyState;
      this.websock.onclose = this.OnClose;
      this.websock.onerror = this.OnError;
      this.startStatisticsTimer();
    }

    this.dispatchEvent({ type: 'connected', bubbles: true, detail: { channel: this.channelId, data: { status: 'open', event: message } } });
  };

  OnClose = (event: { code: number; reason?: string }): void => {
    try {
      this.readyState = this.websock ? this.websock.readyState : Transport.CLOSED;
      let code = event.code;
      if (event.code === 12592 && event.reason !== '') {
        // Legacy quirk preserved: parses a made-up decimal string out of a hex/reason
        // concatenation for this one specific close code (see transport:OnClose).
        code = parseInt(hex2AsciiForCloseCode(event.code) + (event.reason ?? ''), 10);
      }
      const state = new WebsocketStatusCode(code);

      this.dispatchEvent({
        type: 'disconnected',
        bubbles: true,
        detail: { status: 'close', index: this.index, channelId: this.channelId, event: state }
      });

      switch (state.getStatusCode()) {
        case 1000:
        case 1001:
          this.connectionCallback?.('close', state);
          this.autoconnection = false;
          break;
        default:
          this.connectionCallback?.('error', state);
          break;
      }

      if (this.statisticsTimer !== null) {
        this.statisticsTimer.pause();
        this.statisticsTimer = null;
      }

      if (this.websock !== null) {
        this.websock.close();
        if (this.autoconnection) {
          setTimeout(() => this.Connect(), 500);
        }
      }
    } finally {
      if (!this.autoconnection) {
        this.initializeWebsocket();
      }
    }
  };

  OnError = (event: { code: number; reason?: string }): void => {
    try {
      this.readyState = this.websock ? this.websock.readyState : Transport.CLOSED;
      let code = event.code;
      if (event.code === 12592 && event.reason !== '') {
        code = parseInt(hex2AsciiForCloseCode(event.code) + (event.reason ?? ''), 10);
      }
      const state = new WebsocketStatusCode(code);

      this.dispatchEvent({ type: 'disconnected', bubbles: true, detail: { status: 'close', event: state } });
    } catch {
      // legacy swallows OnError's own internal errors after logging them; preserved.
    }
  };

  SetCallback(
    connectionCbFunc: ConnectionCallback,
    rtspCbFunc: RtspCallback,
    rtpCbFunc: RtpCallback,
    errorCbFunc: ErrorCallback,
    receivedBytesCbFunc?: ReceivedBytesCallback
  ): void {
    this.rtspCallback = rtspCbFunc;
    this.rtpCallback = rtpCbFunc;
    this.connectionCallback = connectionCbFunc;
    this.errorCallback = errorCbFunc;
    this.receivedCallback = receivedBytesCbFunc ?? null;
  }

  init(): void {
    if (this.websock) {
      this.websock.onmessage = null;
      this.websock.onopen = null;
      this.websock.onclose = null;
      this.websock.onerror = null;
    }
  }

  /** Overridable factory so tests can inject a fake socket instead of opening a real connection. */
  protected createWebSocket(serverAddr: string): WebSocketLike {
    return new WebSocket(serverAddr) as unknown as WebSocketLike;
  }

  Connect(): void {
    try {
      if (this.websock === null) {
        this.websock = this.createWebSocket(this.serverAddr);
        this.websock.binaryType = 'arraybuffer';
        this.websock.onopen = this.OnOpen;
        this.websock.onmessage = this.OnReceive;
        this.websock.onclose = this.OnClose;
      }
    } catch (error) {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: 0x0002,
        place: 'Transport.ts:Connect',
        message: `Fail to connect websock with error: ${(error as Error).message}`
      });
    }
  }

  Disconnect(): void {
    try {
      if (this.websock !== null) {
        this.websock.close();
      }
    } catch (error) {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: 0x0003,
        place: 'Transport.ts:330',
        message: `error of weboskcet disconnect: ${(error as Error).message}`
      });
    }
  }

  SendRtspCommand(sendMessage: string | null, response?: RtspResponseCallback): unknown {
    try {
      if (this.rtspResponseCallback !== null) {
        const err = new Error('Another command is processing');
        return response?.(err as unknown as string);
      }

      if (this.websock !== null && this.websock.readyState === Transport.OPEN && sendMessage !== null) {
        this.websock.send(stringToUint8Array(sendMessage));
        if (response) {
          this.rtspResponseCallback = response;
        }
      }
    } catch (error) {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: 0x0004,
        place: 'Transport.ts:SendRtspCommand',
        message: `error of rtsp packet transmission: ${(error as Error).message}`
      });
    }
    return undefined;
  }

  SendRtpData(rtpdata: unknown): void {
    if (this.websock !== null && this.websock.readyState === Transport.OPEN) {
      this.websock.send(rtpdata);
    }
    // NOTE: legacy's else-branch threw `new RTSPOverWebSocketError(...)` while referencing an
    // undefined `error` variable (a pre-existing ReferenceError bug), immediately
    // swallowed by its own empty catch block — net effect is a silent no-op,
    // reproduced here directly as a no-op instead of throw-then-swallow.
  }

  close(): void {
    if (this.websock !== undefined && this.websock !== null && this.websock.readyState === Transport.OPEN) {
      this.websock.close();
    }
  }

  onStatisticsTimer(): void {
    this.totalReceivedBytes += this.currentReceivedBytes;
    this.receivedCallback?.({
      channelId: this.channelId,
      current: this.currentReceivedBytes * 8,
      total: this.totalReceivedBytes * 8
    });
    this.currentReceivedBytes = 0;
  }

  addEventListener(type: TransportEventType, listener: (event: TransportEvent) => void): void {
    this.listeners.set(listener.bind(this), { type, listener });
  }

  removeEventListener(type: TransportEventType, listener: (event: TransportEvent) => void): void {
    for (const [key, value] of this.listeners) {
      if (value.type !== type || value.listener !== listener) {
        continue;
      }
      this.listeners.delete(key);
    }
  }

  dispatchEvent(event: TransportEvent): void {
    event.target = this;
    const handler = (this as unknown as Record<string, ((event: TransportEvent) => void) | undefined>)['on' + event.type];
    handler?.(event);

    for (const [key, value] of this.listeners) {
      if (value.type !== event.type) {
        continue;
      }
      key(event);
    }
  }
}

function hex2AsciiForCloseCode(code: number): string {
  const hexx = code.toString(16);
  let str = '';
  for (let i = 0; i < hexx.length && hexx.substr(i, 2) !== '00'; i += 2) {
    str += String.fromCharCode(parseInt(hexx.substr(i, 2), 16));
  }
  return str;
}
