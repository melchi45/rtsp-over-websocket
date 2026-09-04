import { G726_16_AudioDecoder } from './G726_16_AudioDecoder';
import { G726_24_AudioDecoder } from './G726_24_AudioDecoder';
import { G726_32_AudioDecoder } from './G726_32_AudioDecoder';
import { G726_40_AudioDecoder } from './G726_40_AudioDecoder';
import type { DebugConfig } from '../../util/debugLog';

type G726Bits = 16 | 24 | 32 | 40;
type G726Decoder = G726_16_AudioDecoder | G726_24_AudioDecoder | G726_32_AudioDecoder | G726_40_AudioDecoder;

export class G726xAudioDecoder {
  private decoder: G726Decoder | null = null;

  constructor(bits: G726Bits) {
    switch (bits) {
      case 16:
        this.decoder = new G726_16_AudioDecoder();
        break;
      case 24:
        this.decoder = new G726_24_AudioDecoder();
        break;
      case 32:
        this.decoder = new G726_32_AudioDecoder();
        break;
      case 40:
        this.decoder = new G726_40_AudioDecoder();
        break;
      default:
        console.log('wrong bits');
        break;
    }
  }

  /** See util/debugLog.ts. Forwards to whichever concrete `G726_XX_AudioDecoder` the constructor
   *  picked -- `this.decoder` is itself an `AudioDecoder` subclass instance. */
  setDebugConfig(config: DebugConfig | null, componentName: string): void {
    this.decoder?.setDebugConfig(config, componentName);
  }

  decode(data: ArrayLike<number>): Float32Array {
    // NOTE: legacy leaves `decoder` unset (null) for an unrecognized `bits`
    // value and lets this call throw on the null dereference — preserved.
    const tBuffer = this.decoder!.decode(data);
    const jsData = new Float32Array(tBuffer.length);
    for (let i = 0; i < tBuffer.length; i++) {
      jsData[i] = tBuffer[i] / Math.pow(2, 15);
    }
    return jsData;
  }
}
