import { createDebugLogger, type DebugConfig } from '../../util/debugLog';

export type AudioPlayerErrorCallback = (...args: unknown[]) => void;

/**
 * Ported from the legacy player’s Listen/Renderer/audioPlayer — the base class
 * `AudioPlayerGxx`/`AudioPlayerAAC` extend (via legacy's `inheritObject(new
 * AudioPlayer(), {...})` pattern, same as the MediaSession class hierarchy).
 * All methods here are legacy no-ops, overridden by the concrete subclasses.
 */
export class AudioPlayer {
  channelId = 0;
  protected errorCallbackFunc?: AudioPlayerErrorCallback;
  /** See util/debugLog.ts. Logged as `'AudioPlayer'` regardless of whether the concrete instance
   *  is `AudioPlayerGxx`/`AudioPlayerAAC` -- `MediaRouter`'s `createAudioPlayer()` factory call
   *  site is generic and doesn't know which concrete subclass it got back (unlike
   *  `RtpClient`'s per-codec `*Session` construction, which always knows and passes its own
   *  literal name -- see `Session.ts`'s `setDebugConfig()`). One shared logger here covers both
   *  subclasses; `debug["listen"]: ["AudioPlayer"]` is the matching filter name. */
  protected debugLog: (...args: unknown[]) => void = () => {};
  protected debugConfig: DebugConfig | null = null;
  set debug(config: DebugConfig | null) {
    this.debugConfig = config;
    this.debugLog = createDebugLogger(config, 'listen', 'AudioPlayer');
  }

  addEventListener(event: 'error', callbackFunc?: AudioPlayerErrorCallback): void {
    switch (event) {
      case 'error':
        if (typeof callbackFunc !== 'undefined') {
          this.errorCallbackFunc = callbackFunc;
        }
        break;
      default:
        break;
    }
  }

  audioInit(..._args: unknown[]): unknown {
    return undefined;
  }
  isInit(): unknown {
    return undefined;
  }
  Play(): void {}
  Stop(): void {}
  BufferAudio(..._args: unknown[]): void {}
  ControlVolume(..._args: unknown[]): void {}
}
