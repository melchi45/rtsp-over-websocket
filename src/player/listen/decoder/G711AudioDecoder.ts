import { AudioDecoder } from './AudioDecoder';
import { RTSPOverWebSocketError } from '../../exceptions';

const BIAS = 0x84;
const SIGN_BIT = 0x80;
const QUANT_MASK = 0xf;
const SEG_SHIFT = 4;
const SEG_MASK = 0x70;

function alaw2linearPcm(aValIn: number): number {
  let aVal = aValIn ^ 0x55;
  let t = (aVal & QUANT_MASK) << 4;
  const seg = (aVal & SEG_MASK) >> SEG_SHIFT;
  switch (seg) {
    case 0:
      t += 8;
      break;
    case 1:
      t += 0x108;
      break;
    default:
      t += 0x108;
      t <<= seg - 1;
  }
  return aVal & SIGN_BIT ? t : -t;
}

function ulaw2linearPcm(uVal: number): number {
  const uValc = ~uVal;
  let t = ((uValc & QUANT_MASK) << 3) + BIAS;
  t <<= (uValc & SEG_MASK) >> SEG_SHIFT;
  return uValc & SIGN_BIT ? BIAS - t : t - BIAS;
}

export type G711Mime = 'PCMU' | 'PCMA';

/** Ported from the legacy player’s Listen/Decoder/audioDecoderG711.js. */
export class G711AudioDecoder extends AudioDecoder {
  mime: G711Mime = 'PCMU';

  decode(buffer: ArrayLike<number>): Float32Array {
    const rawData = new Uint8Array(buffer);
    const pcmData = new Int16Array(rawData.length);
    for (let i = 0; i < rawData.length; i++) {
      if (this.mime === 'PCMU') {
        pcmData[i] = ulaw2linearPcm(rawData[i]);
      } else if (this.mime === 'PCMA') {
        pcmData[i] = alaw2linearPcm(rawData[i]);
      } else {
        // Unreachable in practice — `mime` is only ever set to PCMU/PCMA by
        // callers. The legacy branch referenced undefined globals here
        // (`channelId`, `error`), which would itself throw a ReferenceError;
        // this throws a real RTSPOverWebSocketError instead so the failure mode is at
        // least well-formed if ever hit.
        throw new RTSPOverWebSocketError({
          channelId: this.channelId,
          errorCode: 0x0310,
          place: 'G711AudioDecoder.decode',
          message: `Unsupported G.711 mime type: ${String(this.mime)}`
        });
      }
    }

    const jsData = new Float32Array(pcmData.length);
    for (let j = 0; j < pcmData.length; j++) {
      jsData[j] = pcmData[j] / Math.pow(2, 15);
    }
    return jsData;
  }
}
