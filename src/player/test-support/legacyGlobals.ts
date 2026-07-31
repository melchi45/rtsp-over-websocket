import CryptoJS from 'crypto-js';
import { loadLegacyModule, loadLegacyModuleSlice, type LegacySandbox } from './loadLegacyModule';
import { decimalToHex, toHex, fromHex } from '../util/hex';
import { fastJsonStringfy } from '../util/fastJsonStringfy';

export { decimalToHex, toHex, fromHex, fastJsonStringfy };

// Note: the Object.prototype.Enum / Uint8Array.prototype.indexOfMulti
// polyfills legacy files depend on (via util.js) are installed per-vm-context
// by loadLegacyModule itself — each vm.createContext() realm has its own
// separate Object/Uint8Array intrinsics, so a polyfill installed on this
// (host) realm's prototypes would have no effect inside the sandbox. See
// loadLegacyModule.ts.

/** Minimal stand-in for the log4javascript-backed window.log used by legacy files. Covers both fire-and-forget calls (debug/info/warn/...) and the isDebugEnabled()/isInfoEnabled() guards several MediaSession files use before building verbose log strings. */
export function createNoopLoggerGlobal(): { getLogger: () => Record<string, (...args: unknown[]) => unknown> } {
  const noopLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    trace: () => {},
    isDebugEnabled: () => false,
    isInfoEnabled: () => false
  };
  return { getLogger: () => noopLogger };
}

/** Base globals shared by every legacy-loader sandbox in the Phase 1 parity suite. */
export function createBaseLegacySandbox(): LegacySandbox {
  return {
    CryptoJS,
    decimalToHex,
    log: createNoopLoggerGlobal()
  };
}

/** Verbatim port of window.inheritObject from the legacy player’s Util/util.js (~line 1319). */
export function inheritObject<T extends object>(base: T, properties: Record<string, unknown>): T {
  for (const key of Object.keys(properties)) {
    (base as Record<string, unknown>)[key] = properties[key];
  }
  return base;
}

/**
 * Globals shared by legacy Listen/Decoder and Talk/Encoder audio codec files:
 * `inheritObject` (util.js mixin helper), and the already-ported `AudioDecoder`/
 * `CommonAudioUtil` base classes those decoders construct via `new AudioDecoder()`/
 * `new CommonAudioUtil()`.
 */
export function createAudioDecoderLegacySandbox(): LegacySandbox {
  return {
    inheritObject,
    AudioDecoder: loadLegacyModule('Listen/Decoder/audioDecoder.js', 'AudioDecoder'),
    CommonAudioUtil: loadLegacyModule('Util/audioUtil.js', 'CommonAudioUtil')
  };
}

/** Verbatim port of window.inherit from the legacy player’s Util/util.js (~line 1310). */
export function inherit<B extends { prototype: object }>(base: B, properties: Record<string, unknown>): object {
  const prot = Object.create(base.prototype);
  for (const key of Object.keys(properties)) {
    prot[key] = properties[key];
  }
  return prot;
}

/**
 * IntervalTimer (window.IntervalTimer, util.js ~line 1040), loaded as a
 * targeted line-range slice for the same reason as the BufferList slice in
 * VideoBufferList.test.ts — the rest of util.js reaches for real-browser
 * globals not worth stubbing just to reach this one self-contained class.
 * Depends on `window.setInterval`/`window.clearInterval`, so those are
 * shared cross-realm from Node's real timer functions.
 */
export function createIntervalTimerLegacySandbox(): LegacySandbox {
  const windowTimers = { setInterval, clearInterval, setTimeout, clearTimeout };
  const { IntervalTimer } = loadLegacyModuleSlice<{ IntervalTimer: unknown }>(
    'Util/util.js',
    [[1040, 1072]],
    ['IntervalTimer'],
    windowTimers
  );
  return { IntervalTimer, ...windowTimers };
}

/**
 * Globals shared by legacy MediaSession/* files: logger stub, `inheritObject`/
 * `inherit`, `rtspOverWebSocketError`/`RTCPError` exception ctors, `IntervalTimer`, and the
 * hex/JSON helpers those depacketizers reference on the (legacy) global `window`.
 */
export function createMediaSessionLegacySandbox(): LegacySandbox {
  return {
    log: createNoopLoggerGlobal(),
    inheritObject,
    inherit,
    fromHex,
    toHex,
    fastJsonStringfy,
    // h264/h265/metaSession.js call the bare browser global `performance.now()`
    // for stream statistics — Node exposes an equivalent global directly.
    performance,
    rtspOverWebSocketError: loadLegacyModule('Exception/RTSPOverWebSocketError.js', 'RTSPOverWebSocketError'),
    RTCPError: loadLegacyModule('Exception/RTCPError.js', 'RTCPError'),
    ...createIntervalTimerLegacySandbox()
  };
}

/** Minimal browser-like stand-ins for a fake CustomEvent constructor, matching just the shape the legacy Network files touch (bubbles/detail + Event-like target). */
export class FakeCustomEvent<T = unknown> {
  type: string;
  bubbles: boolean;
  detail: T;
  target: unknown = null;

  constructor(type: string, init: { bubbles?: boolean; detail: T }) {
    this.type = type;
    this.bubbles = init.bubbles ?? false;
    this.detail = init.detail;
  }
}

/**
 * Globals shared by legacy Network/* (transport/RTSPoverWebsocket/http)
 * files: everything from createMediaSessionLegacySandbox, plus
 * uint8ArrayToString/stringToUint8Array/Hex2Ascii/BrowserDetect/CustomEvent
 * and the already-ported WebsocketStatusCode/RtspStatusCode/RTSPError/AuthError.
 * `WebSocket` is deliberately *not* included — no test in this suite opens a
 * real socket; Transport methods that need `this.websock` inject a fake stub
 * object instead (see Transport.test.ts).
 */
export function createNetworkLegacySandbox(): LegacySandbox {
  return {
    ...createMediaSessionLegacySandbox(),
    uint8ArrayToString: (data: ArrayLike<number>) => String.fromCharCode.apply(null, data as number[]),
    stringToUint8Array: (input: string) => {
      const out = new Uint8Array(input.length);
      for (let i = 0; i < input.length; i++) out[i] = input.charCodeAt(i);
      return out;
    },
    Hex2Ascii: (hex: string | number) => {
      const hexx = hex.toString();
      let str = '';
      for (let i = 0; i < hexx.length && hexx.substr(i, 2) !== '00'; i += 2) {
        str += String.fromCharCode(parseInt(hexx.substr(i, 2), 16));
      }
      return str;
    },
    BrowserDetect: () => 'chrome',
    CustomEvent: FakeCustomEvent,
    // Static readyState constants only (real values per the WebSocket spec) —
    // no test in this suite opens a real socket, so a constructible WebSocket
    // class isn't needed here.
    WebSocket: { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
    AuthError: loadLegacyModule('Exception/AuthError.js', 'AuthError'),
    RTSPError: loadLegacyModule('Exception/RTSPError.js', 'RTSPError'),
    RtspStatusCode: loadLegacyModule('Network/rtspStatusCode.js', 'RtspStatusCode', { log: createNoopLoggerGlobal() }),
    WebsocketStatusCode: loadLegacyModule('Network/websocketStatusCode.js', 'WebsocketStatusCode', {
      log: createNoopLoggerGlobal()
    })
  };
}
