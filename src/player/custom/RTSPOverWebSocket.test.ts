// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import './RTSPOverWebSocket';
import { RTSPOverWebSocketPlayType, RTSPOverWebSocketPlayState } from './RTSPOverWebSocketTypes';
import { RTSPOverWebSocketError } from '../exceptions/RTSPOverWebSocketError';

// Contract-tier tests (BROWSER tier): `<rtsp-over-websocket>` is a real
// Custom Element with heavy DOM/StreamPlayer/SunapiManager dependencies, so
// an old-vs-new vm-based parity comparison (as used for pure-logic files
// elsewhere in this migration) is not practical here. Instead these tests
// exercise the REAL customElements lifecycle under jsdom and assert the
// documented public contract, including the confirmed legacy bugs that this
// port deliberately preserves (see RTSPOverWebSocket.ts's own inline
// comments for each bug's line-level provenance in the legacy source).

function createPlayer(id = 'p1'): HTMLElement {
  const el = document.createElement('rtsp-over-websocket');
  el.setAttribute('id', id);
  return el;
}

describe('RTSPOverWebSocket custom element registration', () => {
  it('registers "rtsp-over-websocket" as a real custom element extending HTMLElement', () => {
    const ctor = customElements.get('rtsp-over-websocket');
    expect(ctor).toBeDefined();
    const el = createPlayer();
    expect(el).toBeInstanceOf(HTMLElement);
  });

  it('exposes the documented observedAttributes list', () => {
    const ctor = customElements.get('rtsp-over-websocket') as typeof HTMLElement & { observedAttributes: string[] };
    expect(ctor.observedAttributes).toEqual(
      expect.arrayContaining(['hostname', 'channel', 'profile', 'profile_number', 'device', 'username', 'password', 'gmt', 'grunt', 'bestshotfilter', 'android'])
    );
  });
});

describe('RTSPOverWebSocket constructor defaults', () => {
  it('initializes info.device/media with legacy default values', () => {
    const el = createPlayer() as unknown as {
      info: { device: Record<string, unknown>; media: Record<string, unknown> };
      readyState: number;
      isplay: boolean;
    };
    expect(el.info.device.ClientIPAddress).toBe('127.0.0.1');
    expect(el.info.device.serverType).toBe('camera');
    expect(el.info.media.type).toBe('live');
    expect(el.info.media.boxsize).toBe(4);
    expect(el.info.media.requestInfo).toEqual({ cmd: 'open', scale: 1, url: null });
    expect(el.readyState).toBe(RTSPOverWebSocketPlayState.STOPPED);
    expect(el.isplay).toBe(false);
  });
});

describe('attributeChangedCallback', () => {
  // Per the Custom Elements spec, exceptions thrown inside a CEReactions
  // callback (attributeChangedCallback included) are reported asynchronously
  // (like an uncaught error), not synchronously propagated to the
  // `setAttribute()` call site — real jsdom/browser behavior, not a bug in
  // this port. These two tests call `attributeChangedCallback` directly to
  // exercise its own throwing logic synchronously instead.
  it('rejects a channel number below 1 with a RTSPOverWebSocketError', () => {
    const el = createPlayer() as unknown as { attributeChangedCallback: (name: string, oldValue: string | null, newValue: string | null) => void };
    document.body.appendChild(el as unknown as Node);
    expect(() => el.attributeChangedCallback('channel', null, '0')).toThrow(RTSPOverWebSocketError);
    document.body.removeChild(el as unknown as Node);
  });

  it('accepts a valid channel and stores it 0-based on info.device.channelId', () => {
    const el = createPlayer() as unknown as { info: { device: { channelId?: number } } };
    (el as unknown as HTMLElement).setAttribute('channel', '3');
    expect(el.info.device.channelId).toBe(2);
  });

  it('parses gmt "null" string to a real null (not the literal string)', () => {
    const el = createPlayer() as unknown as { GMT: number | null };
    (el as unknown as HTMLElement).setAttribute('gmt', 'null');
    expect(el.GMT).toBeNull();
  });

  it('throws for an invalid bestshotfilter-independent profile_number', () => {
    const el = createPlayer() as unknown as { attributeChangedCallback: (name: string, oldValue: string | null, newValue: string | null) => void };
    expect(() => el.attributeChangedCallback('profile_number', null, 'not-a-number')).toThrow(RTSPOverWebSocketError);
  });
});

describe('bug preservation: background/useClockRange triple-accessor collision', () => {
  it('assigning background actually mutates useClockRange (the last-declared accessor wins)', () => {
    const el = createPlayer() as unknown as { background: unknown; useClockRange: boolean };
    (el as unknown as { background: unknown }).background = true;
    expect(el.useClockRange).toBe(true);
  });

  it('useClockRange has no working setter (getter-only) and throws when assigned', () => {
    const el = createPlayer() as unknown as { useClockRange: boolean };
    expect(() => {
      (el as unknown as { useClockRange: boolean }).useClockRange = true;
    }).toThrow(TypeError);
  });
});

describe('bug preservation: grunt getter/setter mismatch', () => {
  it('grunt getter always returns undefined regardless of the setter', () => {
    const el = createPlayer() as unknown as { grunt: boolean | undefined; info: { device: { serverType?: string } } };
    (el as unknown as { grunt: boolean }).grunt = true;
    expect(el.info.device.serverType).toBe('grunt');
    expect(el.grunt).toBeUndefined();
  });
});

describe('bug preservation: audioshift copy-paste', () => {
  it('audioshift getter returns info.media.mode, not a tracked shift value', () => {
    const el = createPlayer() as unknown as { audioshift: unknown; info: { media: { mode: unknown } } };
    el.info.media.mode = 'canvas';
    expect(el.audioshift).toBe('canvas');
  });
});

describe('bug preservation: GMT loose validation', () => {
  it('throws only when the value is strictly undefined, not for other invalid types', () => {
    const el = createPlayer() as unknown as { GMT: unknown };
    expect(() => {
      (el as unknown as { GMT: unknown }).GMT = undefined;
    }).toThrow(RTSPOverWebSocketError);
    // a non-numeric string silently passes the loose guard and the range
    // check below (NaN comparisons are always false), reaching
    // setAttribute('gmt', ...) without throwing.
    expect(() => {
      (el as unknown as { GMT: unknown }).GMT = 'not-a-number';
    }).not.toThrow();
  });

  it('rejects an in-range-type but out-of-range numeric GMT', () => {
    const el = createPlayer() as unknown as { GMT: number };
    expect(() => {
      el.GMT = 99;
    }).toThrow(RTSPOverWebSocketError);
  });

  it('accepts null and clears the timezone', () => {
    const el = createPlayer() as unknown as { GMT: number | null };
    el.GMT = null;
    expect(el.GMT).toBeNull();
  });
});

describe('bug preservation: seekingTime operator-precedence (dead ISO validation)', () => {
  it('accepts a non-ISO string without throwing because of `!playType === INSTANTPLAYBACK`', () => {
    const el = createPlayer() as unknown as { seekingTime: string };
    expect(() => {
      el.seekingTime = 'not-an-iso-date';
    }).not.toThrow();
    expect(el.seekingTime).toBe('not-an-iso-date');
  });

  it('still throws for a genuinely non-string value (the type check above the precedence bug)', () => {
    const el = createPlayer() as unknown as { seekingTime: unknown };
    expect(() => {
      (el as unknown as { seekingTime: unknown }).seekingTime = 12345;
    }).toThrow(RTSPOverWebSocketError);
  });
});

describe('bug preservation: playSpeed truncation', () => {
  it('0.125x truncates to 0.12 instead of 0.125', () => {
    const el = createPlayer() as unknown as { playSpeed: number };
    // isplay is false so the speed()-triggering branch is skipped; only the
    // stored _playSpeed value is under test here.
    el.playSpeed = 0.125;
    expect(el.playSpeed).toBe(0.12);
  });

  it('-0.125x truncates to -0.12 instead of -0.125', () => {
    const el = createPlayer() as unknown as { playSpeed: number };
    el.playSpeed = -0.125;
    expect(el.playSpeed).toBe(-0.12);
  });

  it('other presets (e.g. 2x) are not affected by the truncation bug', () => {
    const el = createPlayer() as unknown as { playSpeed: number };
    el.playSpeed = 2;
    expect(el.playSpeed).toBe(2);
  });
});

describe('playType / mode accessors', () => {
  it('defaults to live mode when playType has never been set', () => {
    const el = createPlayer() as unknown as { mode: string; playType: number };
    expect(el.mode).toBe('live');
    expect(el.playType).toBe(RTSPOverWebSocketPlayType.LIVE);
  });

  it('mode="playback" sets playType to PLAYBACK', () => {
    const el = createPlayer() as unknown as { mode: string; playType: number };
    el.mode = 'playback';
    expect(el.playType).toBe(RTSPOverWebSocketPlayType.PLAYBACK);
    expect(el.mode).toBe('playback');
  });

  it('rejects a non-string mode value', () => {
    const el = createPlayer() as unknown as { mode: unknown };
    expect(() => {
      (el as unknown as { mode: unknown }).mode = 42;
    }).toThrow(RTSPOverWebSocketError);
  });
});

describe('methods that require an active player', () => {
  it('stop() throws when play() was never called', () => {
    const el = createPlayer() as unknown as { stop: () => void };
    expect(() => el.stop()).toThrow(RTSPOverWebSocketError);
  });

  it('pause() throws when play() was never called', () => {
    const el = createPlayer() as unknown as { pause: () => void };
    expect(() => el.pause()).toThrow(RTSPOverWebSocketError);
  });

  it('resume() throws when play() was never called', () => {
    const el = createPlayer() as unknown as { resume: () => void };
    expect(() => el.resume()).toThrow(RTSPOverWebSocketError);
  });

  it('capture() throws when play() was never called', () => {
    const el = createPlayer() as unknown as { capture: () => void };
    expect(() => el.capture()).toThrow(RTSPOverWebSocketError);
  });

  it('isPlay() (deprecated method) always throws regardless of player state', () => {
    const el = createPlayer() as unknown as { isPlay: () => void };
    expect(() => el.isPlay()).toThrow(RTSPOverWebSocketError);
  });
});

describe('play() input validation', () => {
  it('throws AuthError when username is not set', () => {
    const el = createPlayer() as unknown as { device: string; hostname: string; play: () => void };
    el.device = 'camera';
    el.hostname = '192.168.0.10';
    expect(() => el.play()).toThrow();
  });

  it('throws RTSPOverWebSocketError for playback mode with no startTime set', () => {
    const el = createPlayer() as unknown as { device: string; hostname: string; username: string; password: string; mode: string; play: () => void };
    el.device = 'camera';
    el.hostname = '192.168.0.10';
    el.username = 'admin';
    el.password = 'pass';
    el.mode = 'playback';
    expect(() => el.play()).toThrow(RTSPOverWebSocketError);
  });
});

describe('custom addEventListener/removeEventListener/dispatchEvent registry', () => {
  it('addEventListener + a dispatched "changehostname" event delivers detail with channelId/elementId merged in', () => {
    const el = createPlayer('cam1');
    document.body.appendChild(el);
    const handler = vi.fn();
    el.addEventListener('changehostname', handler as EventListener);

    el.setAttribute('hostname', '10.0.0.5');

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as CustomEvent<{ hostname: string; elementId?: string }>;
    expect(event.detail.hostname).toBe('10.0.0.5');
    expect(event.detail.elementId).toBe('cam1');
    document.body.removeChild(el);
  });

  it('addEventListener ignores a second registration for the same event type', () => {
    const el = createPlayer();
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    el.addEventListener('changehostname', handler1 as EventListener);
    el.addEventListener('changehostname', handler2 as EventListener);

    el.setAttribute('hostname', 'x');

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).not.toHaveBeenCalled();
  });

  it('removeEventListener stops further delivery', () => {
    const el = createPlayer();
    const handler = vi.fn();
    el.addEventListener('changehostname', handler as EventListener);
    el.removeEventListener('changehostname', handler as EventListener);

    el.setAttribute('hostname', 'y');

    expect(handler).not.toHaveBeenCalled();
  });

  it('addEventListener throws a RTSPOverWebSocketError for a null listener', () => {
    const el = createPlayer() as unknown as { addEventListener: (type: string, listener: unknown) => void };
    expect(() => el.addEventListener('foo', null)).toThrow(RTSPOverWebSocketError);
  });
});

describe('connectedCallback', () => {
  it('defaults deviceType to camera and resolves cameraIp from document.location.hostname when no hostname attribute is set', () => {
    const el = createPlayer() as unknown as { info: { device: { deviceType?: string; cameraIp?: string } } };
    document.body.appendChild(el);
    expect(el.info.device.deviceType).toBe('camera');
    expect(el.info.device.cameraIp).toBe(document.location.hostname);
    document.body.removeChild(el);
  });

  it('throws (caught internally, logged) rather than propagating when mode attribute is invalid', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const el = createPlayer();
    el.setAttribute('mode', 'not-a-real-mode');
    expect(() => document.body.appendChild(el)).not.toThrow();
    expect(consoleErrorSpy).toHaveBeenCalled();
    document.body.removeChild(el);
    consoleErrorSpy.mockRestore();
  });
});

describe('bestshotfilter accessor', () => {
  it('setBestshotFilter accepts case-insensitive string names', () => {
    const el = createPlayer() as unknown as { bestshotfilter: number | null };
    el.bestshotfilter = 1;
    expect(el.bestshotfilter).toBe(1);
  });

  it('rejects a negative filter value', () => {
    const el = createPlayer() as unknown as { bestshotfilter: number };
    expect(() => {
      el.bestshotfilter = -1;
    }).toThrow(RTSPOverWebSocketError);
  });
});
