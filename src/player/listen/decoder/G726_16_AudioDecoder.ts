import { AudioDecoder } from './AudioDecoder';
import { CommonAudioUtil, type G726State } from '../../util';

const AUDIO_ENCODING_LINEAR = 3;
const DQLNTAB = [116, 365, 365, 116];
const WITAB = [-704, 14048, 14048, -704];
const FITAB = [0, 0xe00, 0xe00, 0];

/** Ported from the legacy player’s Listen/Decoder/audioDecoderG726_16.js. */
export class G726_16_AudioDecoder extends AudioDecoder {
  private readonly commonAudioUtil = new CommonAudioUtil();
  private state: G726State = this.commonAudioUtil.g726_init_state();

  private decodeSample(iIn: number, outCoding: number): number {
    const i = iIn & 0x03;
    const sezi = this.commonAudioUtil.predictor_zero(this.state);
    const sez = sezi >> 1;
    const sei = sezi + this.commonAudioUtil.predictor_pole(this.state);
    const se = sei >> 1;
    const y = this.commonAudioUtil.step_size(this.state);
    const dq = this.commonAudioUtil.reconstruct(i & 0x02, DQLNTAB[i], y);
    const sr = dq < 0 ? se - (dq & 0x3fff) : se + dq;
    const dqsez = sr - se + sez;
    this.state = this.commonAudioUtil.update(2, y, WITAB[i], FITAB[i], dq, sr, dqsez, this.state);

    switch (outCoding) {
      case AUDIO_ENCODING_LINEAR:
        return sr << 2;
      default:
        return -1;
    }
  }

  decode(buffer: ArrayLike<number>): Int16Array {
    const decoded = new Int16Array(buffer.length * 4);
    let n = 0;
    for (let i = 0; i < buffer.length; i++) {
      let res = this.decodeSample(buffer[i] >> 6, AUDIO_ENCODING_LINEAR);
      decoded[n++] = res & 0x0000ff00;

      res = this.decodeSample(buffer[i] >> 4, AUDIO_ENCODING_LINEAR);
      decoded[n++] = res & 0x0000ff00;

      res = this.decodeSample(buffer[i] >> 2, AUDIO_ENCODING_LINEAR);
      decoded[n++] = res & 0x0000ff00;

      res = this.decodeSample(buffer[i], AUDIO_ENCODING_LINEAR);
      decoded[n++] = res & 0x0000ff00;
    }
    return decoded;
  }
}
