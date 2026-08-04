const BIAS = 0x84;
const SEG_END = [0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff, 0x3fff, 0x7fff];

export interface G711CodecInfo {
  type: string;
  samplingRate: number;
}

function search(val: number, table: number[]): number {
  for (let i = 0; i < table.length; i++) {
    if (val <= table[i]) return i;
  }
  return table.length;
}

function lin2Mulaw(pcmValIn: number): number {
  let pcmVal = pcmValIn;
  let mask: number;
  if (pcmVal < 0) {
    pcmVal = BIAS - pcmVal;
    mask = 0x7f;
  } else {
    pcmVal += BIAS;
    mask = 0xff;
  }
  const seg = search(pcmVal, SEG_END);
  if (seg >= 8) {
    return 0x7f ^ mask;
  }
  const uval = (seg << 4) | ((pcmVal >> (seg + 3)) & 0xf);
  return uval ^ mask;
}

export class G711AudioEncoder {
  private localSampleRate = 48000;
  private remainBuffer: Float32Array | null = null;
  private readonly codecInfo: G711CodecInfo = { type: 'G.711', samplingRate: 8000 };

  setSampleRate(sampleRate: number): void {
    this.localSampleRate = sampleRate;
  }

  private downsampleBuffer(buffer: Float32Array, rate: number): Float32Array {
    if (rate === this.localSampleRate) {
      return buffer;
    }
    if (rate > this.localSampleRate) {
      throw 'Downsampling rate show be smaller than original sample rate';
    }
    const sampleRateRatio = this.localSampleRate / rate;
    const newLength = Math.floor(buffer.length / sampleRateRatio);
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;

    while (offsetResult < result.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
      let accum = 0;
      let count = 0;
      for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
        accum += buffer[i];
        count++;
      }
      result[offsetResult] = accum / count;
      offsetResult++;
      offsetBuffer = nextOffsetBuffer;
    }

    this.remainBuffer = null;
    if (Math.round(offsetResult * sampleRateRatio) !== buffer.length) {
      const remainStartIndex = Math.round(offsetResult * sampleRateRatio);
      this.remainBuffer = new Float32Array(buffer.subarray(remainStartIndex, buffer.length));
    }

    return result;
  }

  encode(buffer: Float32Array): Uint8Array {
    let float32Array: Float32Array;
    if (this.remainBuffer !== null) {
      float32Array = new Float32Array(buffer.length + this.remainBuffer.length);
      float32Array.set(this.remainBuffer, 0);
      float32Array.set(buffer, this.remainBuffer.length);
    } else {
      float32Array = buffer;
    }

    float32Array = this.downsampleBuffer(float32Array, this.codecInfo.samplingRate);

    const pcmArray = new Int16Array(float32Array.length);
    const ulawArray = new Uint8Array(pcmArray.length);

    for (let i = 0; i < float32Array.length; i++) {
      pcmArray[i] = float32Array[i] * Math.pow(2, 15);
      ulawArray[i] = lin2Mulaw(pcmArray[i]);
    }

    return ulawArray;
  }

  getCodecInfo(): G711CodecInfo {
    return this.codecInfo;
  }
}
