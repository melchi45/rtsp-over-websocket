export type AudioPlayerErrorCallback = (...args: unknown[]) => void;

/**
 * Ported from the legacy player’s Listen/Renderer/audioPlayer.js — the base class
 * `AudioPlayerGxx`/`AudioPlayerAAC` extend (via legacy's `inheritObject(new
 * AudioPlayer(), {...})` pattern, same as the MediaSession class hierarchy).
 * All methods here are legacy no-ops, overridden by the concrete subclasses.
 */
export class AudioPlayer {
  channelId = 0;
  protected errorCallbackFunc?: AudioPlayerErrorCallback;

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
