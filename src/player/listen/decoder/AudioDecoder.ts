import { createDebugLogger, type DebugConfig, type DebugLogger, NOOP_DEBUG_LOGGER } from '../../util/debugLog';

export class AudioDecoder {
  channelId = 0;

  /** See util/debugLog.ts. `componentName` is the concrete subclass's own literal name (e.g.
   *  `'AACAudioDecoder'`) -- `AudioPlayerGxx.audioInit()` always knows exactly which decoder
   *  class it just constructed, same reasoning as `Session.setDebugConfig()`. */
  protected debugLog: DebugLogger = NOOP_DEBUG_LOGGER;
  setDebugConfig(config: DebugConfig | null, componentName: string): void {
    this.debugLog = createDebugLogger(config, 'listen', componentName);
  }

  decode(_buffer: unknown): unknown {
    return undefined;
  }

  close(): void {}
}
