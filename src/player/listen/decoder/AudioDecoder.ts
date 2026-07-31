/** Ported from the legacy player’s Listen/Decoder/audioDecoder.js. */
export class AudioDecoder {
  channelId = 0;

  decode(_buffer: unknown): unknown {
    return undefined;
  }

  close(): void {}
}
