import { AudioDecoder } from './AudioDecoder';
import { CommonAudioUtil, type G726State } from '../../util';

const AUDIO_ENCODING_LINEAR = 3;
const DQLNTAB = [-2048, 135, 273, 373, 373, 273, 135, -2048];
const WITAB = [-128, 960, 4384, 18624, 18624, 4384, 960, -128];
const FITAB = [0, 0x200, 0x400, 0xe00, 0xe00, 0x400, 0x200, 0];

export class G726_24_AudioDecoder extends AudioDecoder {
  private readonly commonAudioUtil = new CommonAudioUtil();
  private state: G726State = this.commonAudioUtil.g726_init_state();

  private decodeSample(iIn: number, outCoding: number): number {
    const i = iIn & 0x07;
    const sezi = this.commonAudioUtil.predictor_zero(this.state);
    const sez = sezi >> 1;
    const sei = sezi + this.commonAudioUtil.predictor_pole(this.state);
    const se = sei >> 1;
    const y = this.commonAudioUtil.step_size(this.state);
    const dq = this.commonAudioUtil.reconstruct(i & 0x04, DQLNTAB[i], y);
    const sr = dq < 0 ? se - (dq & 0x3fff) : se + dq;
    const dqsez = sr - se + sez;
    this.state = this.commonAudioUtil.update(3, y, WITAB[i], FITAB[i], dq, sr, dqsez, this.state);

    switch (outCoding) {
      case AUDIO_ENCODING_LINEAR:
        return sr << 2;
      default:
        return -1;
    }
  }

  decode(buffer: ArrayLike<number>): Int16Array {
    const decoded = new Int16Array(Math.floor((buffer.length * 8) / 3));
    let n = 0;
    for (let i = 0; i < buffer.length - 3; i += 3) {
      let res = this.decodeSample(buffer[i] >> 5, AUDIO_ENCODING_LINEAR);
      decoded[n++] = res & 0x0000ff00;

      res = this.decodeSample(buffer[i] >> 2, AUDIO_ENCODING_LINEAR);
      decoded[n++] = res & 0x0000ff00;

      res = this.decodeSample((buffer[i] << 1) | (buffer[i + 1] >> 7), AUDIO_ENCODING_LINEAR);
      decoded[n++] = res & 0x0000ff00;

      res = this.decodeSample(buffer[i + 1] >> 4, AUDIO_ENCODING_LINEAR);
      decoded[n++] = res & 0x0000ff00;

      res = this.decodeSample(buffer[i + 1] >> 1, AUDIO_ENCODING_LINEAR);
      decoded[n++] = res & 0x0000ff00;

      res = this.decodeSample((buffer[i + 1] << 2) | (buffer[i + 2] >> 6), AUDIO_ENCODING_LINEAR);
      decoded[n++] = res & 0x0000ff00;

      res = this.decodeSample(buffer[i + 2] >> 3, AUDIO_ENCODING_LINEAR);
      decoded[n++] = res & 0x0000ff00;

      res = this.decodeSample(buffer[i + 2] >> 0, AUDIO_ENCODING_LINEAR);
      decoded[n++] = res & 0x0000ff00;
    }
    return decoded;
  }
}
