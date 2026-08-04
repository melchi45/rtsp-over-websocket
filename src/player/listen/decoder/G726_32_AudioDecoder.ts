import { AudioDecoder } from './AudioDecoder';
import { CommonAudioUtil, type G726State } from '../../util';

const AUDIO_ENCODING_LINEAR = 3;
const DQLNTAB = [-2048, 4, 135, 213, 273, 323, 373, 425, 425, 373, 323, 273, 213, 135, 4, -2048];
const WITAB = [-12, 18, 41, 64, 112, 198, 355, 1122, 1122, 355, 198, 112, 64, 41, 18, -12];
const FITAB = [0, 0, 0, 0x200, 0x200, 0x200, 0x600, 0xe00, 0xe00, 0x600, 0x200, 0x200, 0x200, 0, 0, 0];

export class G726_32_AudioDecoder extends AudioDecoder {
  private readonly commonAudioUtil = new CommonAudioUtil();
  private state: G726State = this.commonAudioUtil.g726_init_state();

  private decodeSample(iIn: number, outCoding: number): number {
    const i = iIn & 0x0f;
    const sezi = this.commonAudioUtil.predictor_zero(this.state);
    const sez = sezi >> 1;
    const sei = sezi + this.commonAudioUtil.predictor_pole(this.state);
    const se = sei >> 1;
    const y = this.commonAudioUtil.step_size(this.state);
    const dq = this.commonAudioUtil.reconstruct(i & 0x08, DQLNTAB[i], y);
    const sr = dq < 0 ? se - (dq & 0x3fff) : se + dq;
    const dqsez = sr - se + sez;
    this.state = this.commonAudioUtil.update(4, y, WITAB[i] << 5, FITAB[i], dq, sr, dqsez, this.state);

    switch (outCoding) {
      case AUDIO_ENCODING_LINEAR: {
        let lino = sr << 2;
        lino = lino > 32767 ? 32767 : lino;
        lino = lino < -32768 ? -32768 : lino;
        return lino;
      }
      default:
        return -1;
    }
  }

  decode(buffer: ArrayLike<number>): Int16Array {
    const decoded = new Int16Array(buffer.length * 2);
    let n = 0;
    for (let i = 0; i < buffer.length; i++) {
      const sec = (0xf0 & buffer[i]) >> 4;
      let res = this.decodeSample(sec, AUDIO_ENCODING_LINEAR);
      decoded[n++] = res & 0x0000ff00;

      const first = 0x0f & buffer[i];
      res = this.decodeSample(first, AUDIO_ENCODING_LINEAR);
      decoded[n++] = res & 0x0000ff00;
    }
    return decoded;
  }
}
