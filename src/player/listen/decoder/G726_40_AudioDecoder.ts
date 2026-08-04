import { AudioDecoder } from './AudioDecoder';
import { CommonAudioUtil, type G726State } from '../../util';

const AUDIO_ENCODING_LINEAR = 3;
const DQLNTAB = [
  -2048, -66, 28, 104, 169, 224, 274, 318, 358, 395, 429, 459, 488, 514, 539, 566, 566, 539, 514, 488, 459, 429, 395,
  358, 318, 274, 224, 169, 104, 28, -66, -2048
];
const WITAB = [
  448, 448, 768, 1248, 1280, 1312, 1856, 3200, 4512, 5728, 7008, 8960, 11456, 14080, 16928, 22272, 22272, 16928,
  14080, 11456, 8960, 7008, 5728, 4512, 3200, 1856, 1312, 1280, 1248, 768, 448, 448
];
const FITAB = [
  0, 0, 0, 0, 0, 0x200, 0x200, 0x200, 0x200, 0x200, 0x400, 0x600, 0x800, 0xa00, 0xc00, 0xc00, 0xc00, 0xc00, 0xa00,
  0x800, 0x600, 0x400, 0x200, 0x200, 0x200, 0x200, 0x200, 0, 0, 0, 0, 0
];

export class G726_40_AudioDecoder extends AudioDecoder {
  private readonly commonAudioUtil = new CommonAudioUtil();
  private state: G726State = this.commonAudioUtil.g726_init_state();

  private decodeSample(iIn: number, outCoding: number): number {
    const i = iIn & 0x1f;
    const sezi = this.commonAudioUtil.predictor_zero(this.state);
    const sez = sezi >> 1;
    const sei = sezi + this.commonAudioUtil.predictor_pole(this.state);
    const se = sei >> 1;
    const y = this.commonAudioUtil.step_size(this.state);
    const dq = this.commonAudioUtil.reconstruct(i & 0x10, DQLNTAB[i], y);
    const sr = dq < 0 ? se - (dq & 0x7fff) : se + dq;
    const dqsez = sr - se + sez;
    this.state = this.commonAudioUtil.update(5, y, WITAB[i], FITAB[i], dq, sr, dqsez, this.state);

    switch (outCoding) {
      case AUDIO_ENCODING_LINEAR:
        return sr << 2;
      default:
        return -1;
    }
  }

  decode(buffer: ArrayLike<number>): Int16Array {
    const decoded = new Int16Array(Math.floor(buffer.length * 1.6));
    let n = 0;
    for (let i = 0; i < buffer.length - 5; i += 5) {
      let res = this.decodeSample(buffer[i] >> 3, AUDIO_ENCODING_LINEAR);
      decoded[n++] = res & 0x0000ff00;

      res = this.decodeSample((buffer[i] << 2) | (buffer[i + 1] >> 6), AUDIO_ENCODING_LINEAR);
      decoded[n++] = res & 0x0000ff00;

      res = this.decodeSample(buffer[i + 1] >> 1, AUDIO_ENCODING_LINEAR);
      decoded[n++] = res & 0x0000ff00;

      res = this.decodeSample((buffer[i + 1] << 4) | (buffer[i + 2] >> 4), AUDIO_ENCODING_LINEAR);
      decoded[n++] = res & 0x0000ff00;

      res = this.decodeSample((buffer[i + 2] << 1) | (buffer[i + 3] >> 7), AUDIO_ENCODING_LINEAR);
      decoded[n++] = res & 0x0000ff00;

      res = this.decodeSample(buffer[i + 3] >> 2, AUDIO_ENCODING_LINEAR);
      decoded[n++] = res & 0x0000ff00;

      res = this.decodeSample((buffer[i + 3] << 3) | (buffer[i + 4] >> 5), AUDIO_ENCODING_LINEAR);
      decoded[n++] = res & 0x0000ff00;

      res = this.decodeSample(buffer[i + 4] >> 0, AUDIO_ENCODING_LINEAR);
      decoded[n++] = res & 0x0000ff00;
    }
    return decoded;
  }
}
