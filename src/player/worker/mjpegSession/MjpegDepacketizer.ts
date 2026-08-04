function undefinedGlobalError(name: string): ReferenceError {
  return new ReferenceError(`${name} is not defined`);
}

export interface MjpegTimeStamp {
  rtpTimestamp: string;
  timestamp: number | null;
  timestamp_usec: number | null;
  timezone: number | null;
}

export interface MjpegStreamData {
  interleavedId: number | undefined;
  codecType: 'MJPEG';
  frameData: Uint8Array;
  timeStamp: MjpegTimeStamp;
  objectId?: number;
}

export interface MjpegVideoInfo {
  frameType: 'I';
  width: number;
  height: number;
  framerate: number;
}

export interface MjpegFrameData {
  playMode: 'Playback' | 'Live';
  streamData: MjpegStreamData;
  videoInfo: MjpegVideoInfo;
}

const MARKERSOF0 = 0xc0; // start-of-frame, baseline scan
const MARKERSOI = 0xd8; // start of image
const MARKERSOS = 0xda; // start of scan
const MARKERDRI = 0xdd; // restart interval
const MARKERDQT = 0xdb; // define quantization tables
const MARKERDHT = 0xc4; // huffman tables
const MARKERAPPFIRST = 0xe0;

const lumDcCodelens = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const lumDcSymbols = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const lumAcCodelens = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
// prettier-ignore
const lumAcSymbols = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12,
  0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
  0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16,
  0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
  0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
  0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79,
  0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98,
  0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
  0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4,
  0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea,
  0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa
];
const chmDcCodelens = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const chmDcSymbols = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const chmAcCodelens = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
// prettier-ignore
const chmAcSymbols = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21,
  0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
  0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
  0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
  0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34,
  0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38,
  0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
  0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
  0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
  0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78,
  0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96,
  0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
  0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
  0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
  0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2,
  0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9,
  0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa
];
// The default 'luma' and 'chroma' quantizer tables, in zigzag order:
// prettier-ignore
const defaultQuantizers = [
  // luma table:
  16, 11, 12, 14, 12, 10, 16, 14,
  13, 14, 18, 17, 16, 19, 24, 40,
  26, 24, 22, 22, 24, 49, 35, 37,
  29, 40, 58, 51, 61, 60, 57, 51,
  56, 55, 64, 72, 92, 78, 64, 68,
  87, 69, 55, 56, 80, 109, 81, 87,
  95, 98, 103, 104, 103, 62, 77, 113,
  121, 112, 100, 120, 92, 101, 103, 99,
  // chroma table:
  17, 18, 18, 24, 21, 24, 47, 26,
  26, 47, 99, 66, 56, 66, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99
];

function createHuffmanHeader(
  ptr: Uint8Array,
  indexValue: number,
  codelens: number[],
  ncodes: number,
  symbols: number[],
  nsymbols: number,
  tableNo: number,
  tableClass: number
): number {
  let index = indexValue;
  ptr[index] = 0xff;
  index += 1;
  ptr[index] = MARKERDHT;
  index += 1;
  ptr[index] = 0;
  index += 1;
  /* length msb */
  ptr[index] = 3 + ncodes + nsymbols;
  index += 1;
  /* length lsb */
  ptr[index] = (tableClass << 4) | tableNo;
  index += 1;

  ptr.set(codelens, index);
  index += ncodes;
  ptr.set(symbols, index);
  index += nsymbols;
  return index;
}

function makeDefaultQtables(resultTables: Uint8Array, factorInput: number): void {
  let factor = factorInput;
  let q = 0;

  if (factorInput < 1) {
    factor = 1;
  } else if (factorInput > 99) {
    factor = 99;
  }

  if (factorInput < 50) {
    q = 5000 / factor;
  } else {
    q = 200 - factor * 2;
  }

  for (let i = 0; i < 128; i++) {
    let newVal = (defaultQuantizers[i] * q + 50) / 100;
    if (newVal < 1) {
      newVal = 1;
    } else if (newVal > 255) {
      newVal = 255;
    }
    resultTables[i] = newVal;
  }
}

function makeJPEGHeader(type: number, width: number, height: number, qtablesArray: Uint8Array, qtlen: number, dri: number | null): Uint8Array {
  const qtables = qtablesArray;
  const buf = new Uint8Array(new ArrayBuffer(1000));
  let index = 0;
  const ptr = buf;
  const numQtables = qtlen > 64 ? 2 : 1;
  let qtablesize = 0;

  // MARKER_SOI:
  ptr[index] = 0xff;
  index += 1;
  ptr[index] = MARKERSOI;
  index += 1;

  // MARKER_APP_FIRST:
  ptr[index] = 0xff;
  index += 1;
  ptr[index] = MARKERAPPFIRST;
  index += 1;
  ptr[index] = 0x00;
  index += 1;
  ptr[index] = 0x10;
  index += 1;
  ptr[index] = 0x4a;
  index += 1;
  ptr[index] = 0x46;
  index += 1;
  ptr[index] = 0x49;
  index += 1;
  ptr[index] = 0x46;
  index += 1;
  ptr[index] = 0x00;
  index += 1;
  ptr[index] = 0x01;
  index += 1;
  ptr[index] = 0x01;
  index += 1;
  ptr[index] = 0x00;
  index += 1;
  ptr[index] = 0x00;
  index += 1;
  ptr[index] = 0x01;
  index += 1;
  ptr[index] = 0x00;
  index += 1;
  ptr[index] = 0x01;
  index += 1;
  ptr[index] = 0x00;
  index += 1;
  ptr[index] = 0x00;
  index += 1;

  // MARKER_DRI:
  if (dri !== null && dri > 0) {
    ptr[index] = 0xff;
    index += 1;
    ptr[index] = MARKERDRI;
    index += 1;
    ptr[index] = 0x00;
    index += 1;
    ptr[index] = 0x04;
    index += 1;
    ptr[index] = dri >> 8;
    index += 1;
    ptr[index] = dri;
    index += 1;
  }

  // MARKER_DQT (luma):
  let tableSize = numQtables === 1 ? qtlen : qtlen / 2;
  ptr[index] = 0xff;
  index += 1;
  ptr[index] = MARKERDQT;
  index += 1;
  ptr[index] = 0x00;
  index += 1;
  ptr[index] = tableSize + 3;
  index += 1;
  ptr[index] = 0x00;
  index += 1;

  ptr.set(qtables.subarray(0, tableSize), index);
  qtablesize += tableSize;
  index += tableSize;

  if (numQtables > 1) {
    tableSize = qtlen - qtlen / 2;
    // MARKER_DQT (chroma):
    ptr[index] = 0xff;
    index += 1;
    ptr[index] = MARKERDQT;
    index += 1;
    ptr[index] = 0x00;
    index += 1;
    ptr[index] = tableSize + 3;
    index += 1;
    ptr[index] = 0x01;
    index += 1;
    ptr.set(qtables.subarray(qtablesize, qtablesize + tableSize), index);
    // legacy: `qtables += tableSize;` here — `qtables` is a Uint8Array, so
    // `+=` coerces it to a garbage string via string concatenation. Confirmed
    // 100% dead: the reassigned value is never read again (the function
    // returns shortly after, and every other reference to `qtables` in this
    // block already ran above this line) — dropped rather than reproduced.
    index += tableSize;
  }

  // MARKER_SOF0:
  ptr[index] = 0xff;
  index += 1;
  ptr[index] = MARKERSOF0;
  index += 1;
  ptr[index] = 0x00;
  index += 1;
  ptr[index] = 0x11;
  index += 1;
  ptr[index] = 0x08;
  index += 1;

  ptr[index] = height >> 8;
  index += 1;
  ptr[index] = height;
  index += 1; // number of lines (must be a multiple of 8)
  ptr[index] = width >> 8;
  index += 1;
  ptr[index] = width;
  index += 1; // number of columns (must be a multiple of 8)
  ptr[index] = 0x03;
  index += 1; // number of components
  ptr[index] = 0x01;
  index += 1; // id of component
  ptr[index] = type ? 0x22 : 0x21;
  index += 1; // sampling ratio (h,v)
  ptr[index] = 0x00;
  index += 1; // quant table id
  ptr[index] = 0x02;
  index += 1; // id of component
  ptr[index] = 0x11;
  index += 1; // sampling ratio (h,v)
  ptr[index] = numQtables === 1 ? 0x00 : 0x01;
  index += 1; // quant table id
  ptr[index] = 0x03;
  index += 1; // id of component
  ptr[index] = 0x11;
  index += 1; // sampling ratio (h,v)
  ptr[index] = 0x01;
  index += 1; // quant table id

  index = createHuffmanHeader(ptr, index, lumDcCodelens, lumDcCodelens.length, lumDcSymbols, lumDcSymbols.length, 0, 0);
  index = createHuffmanHeader(ptr, index, lumAcCodelens, lumAcCodelens.length, lumAcSymbols, lumAcSymbols.length, 0, 1);
  index = createHuffmanHeader(ptr, index, chmDcCodelens, chmDcCodelens.length, chmDcSymbols, chmDcSymbols.length, 1, 0);
  index = createHuffmanHeader(ptr, index, chmAcCodelens, chmAcCodelens.length, chmAcSymbols, chmAcSymbols.length, 1, 1);

  // MARKER_SOS:
  ptr[index] = 0xff;
  index += 1;
  ptr[index] = MARKERSOS;
  index += 1;
  ptr[index] = 0x00;
  index += 1;
  ptr[index] = 0x0c;
  index += 1; // size of chunk
  ptr[index] = 0x03;
  index += 1; // number of components
  ptr[index] = 0x01;
  index += 1; // id of component
  ptr[index] = 0x00;
  index += 1; // huffman table id (DC, AC)
  ptr[index] = 0x02;
  index += 1; // id of component
  ptr[index] = 0x11;
  index += 1; // huffman table id (DC, AC)
  ptr[index] = 0x03;
  index += 1; // id of component
  ptr[index] = 0x11;
  index += 1; // huffman table id (DC, AC)
  ptr[index] = 0x00;
  index += 1; // start of spectral
  ptr[index] = 0x3f;
  index += 1; // end of spectral
  ptr[index] = 0x00;
  index += 1; // successive approximation bit position (high, low)

  const tmpheader = new Uint8Array(new ArrayBuffer(index));
  tmpheader.set(ptr.subarray(0, index), 0);
  return tmpheader;
}

function ntohl(buffer: Uint8Array): number {
  return ((buffer[0] << 24) + (buffer[1] << 16) + (buffer[2] << 8) + buffer[3]) >>> 0;
}

/**
 * Ported from the legacy player’s Worker/MjpegSession/mjpegDepacketizer — runs
 * inside the MJPEG depacketize Worker (see mjpegDepacketizeWorker.ts),
 * reassembling RTP/JPEG payload fragments into full JFIF frames.
 *
 * `depacketize()`'s 4th legacy parameter (`isBackup`) is dropped: it is never
 * read in the function body, and the only real call site
 * (mjpegDepacketizeWorker.js) never passes a 4th argument either — confirmed
 * dead on both ends.
 *
 * The RTP header fields legacy computes purely for its own (dropped) debug
 * log call — version, sequence number, payload type — have no other
 * observable effect and are dropped along with it; padding and CSRC count
 * ARE kept because they gate a real (if buggy — see `depacketize`) branch.
 */
export class MjpegDepacketizer {
  private _interleavedId: number | undefined;
  private _deviceType: 'camera' | 'nvr' | string = 'camera';

  private extensionHeaderLen: number | null = null;
  private width = 0;
  private height = 0;

  private payloadBuffer: Uint8Array[] = [];
  private skipDataSize = 0;
  private playback = false;
  private gotFrameCallback: ((data: MjpegFrameData) => void) | null = null;

  private objectId: number | null = null;
  private frameRate = 0;
  private lastRtpTimeStamp = 0;
  private rtpExtension = false;

  // legacy reassigns the *whole* `timeData` reference in depacketize() (`timeData =
  // timeData.timestamp ? timeData : prevTimeData;`), not just its fields — so
  // `timeData` can end up literally aliasing the same object as `prevTimeData`.
  // Kept mutable (not readonly) to preserve that exact reference-swap behavior.
  private timeData: { timestamp: number | null; timestamp_usec: number | null; timezone: number | null } = {
    timestamp: null,
    timestamp_usec: null,
    timezone: null
  };
  private prevTimeData: { timestamp: number | null; timestamp_usec: number | null; timezone: number | null } = {
    timestamp: null,
    timestamp_usec: null,
    timezone: null
  };

  private readonly frameData: MjpegFrameData = {
    playMode: 'Live',
    streamData: { interleavedId: undefined, codecType: 'MJPEG', frameData: new Uint8Array(0), timeStamp: { rtpTimestamp: '0', timestamp: null, timestamp_usec: null, timezone: null } },
    videoInfo: { frameType: 'I', width: 0, height: 0, framerate: 0 }
  };

  private readonly NTPmsw = new Uint8Array(new ArrayBuffer(4));
  private readonly NTPlsw = new Uint8Array(new ArrayBuffer(4));
  private readonly gmt = new Uint8Array(new ArrayBuffer(2));

  get interleavedId(): number | undefined {
    return this._interleavedId;
  }

  set interleavedId(v: number | undefined) {
    this._interleavedId = v;
  }

  get deviceType(): string {
    return this._deviceType;
  }

  set deviceType(v: string) {
    this._deviceType = v;
  }

  // legacy's real call site (mjpegDepacketizeWorker.js) invokes `init()` with
  // zero arguments, then wires the callback separately via
  // setGotFrameCallback() — callback kept optional to match that faithfully.
  init(callback?: (data: MjpegFrameData) => void): void {
    this.playback = false;
    this.gotFrameCallback = callback ?? null;
  }

  setGotFrameCallback(callback: (data: MjpegFrameData) => void): void {
    this.gotFrameCallback = callback;
  }

  private getFramerate(): number {
    return this.frameRate;
  }

  private setFramerate(rate: number): void {
    this.frameRate = rate;
  }

  private getspecialheadersize(rtpPayload: Uint8Array): number {
    let resultSpecialHeaderSize = 8;
    const extensionHeaderLen = this.extensionHeaderLen ?? 0;
    const Type = rtpPayload[extensionHeaderLen + 4];
    const Q = rtpPayload[extensionHeaderLen + 5];

    if (Type > 63) {
      resultSpecialHeaderSize += 4;
    }
    if (Q > 127) {
      const MBZ = rtpPayload[extensionHeaderLen + resultSpecialHeaderSize];
      if (MBZ === 0) {
        const Length = (rtpPayload[extensionHeaderLen + resultSpecialHeaderSize + 2] << 8) | rtpPayload[extensionHeaderLen + resultSpecialHeaderSize + 3];
        resultSpecialHeaderSize += 4;
        resultSpecialHeaderSize += Length;
      }
    }
    return resultSpecialHeaderSize;
  }

  private createjpegheader(rtpPayload: Uint8Array): Uint8Array {
    let exHeaderLen = 0;
    let resultSpecialHeaderSize = 8;
    const extensionHeaderLen = this.extensionHeaderLen ?? 0;
    const Offset = (rtpPayload[extensionHeaderLen + 1] << 16) | (rtpPayload[extensionHeaderLen + 2] << 8) | rtpPayload[extensionHeaderLen + 3];
    const Type = rtpPayload[extensionHeaderLen + 4];
    const type = Type & 1;
    const Q = rtpPayload[extensionHeaderLen + 5];
    this.width = rtpPayload[extensionHeaderLen + 6] * 8;
    this.height = rtpPayload[extensionHeaderLen + 7] * 8;

    if (this.height === 0 || this.width === 0) {
      // special case
      if (rtpPayload[0] === 0xab && (rtpPayload[1] === 0xad || rtpPayload[1] === 0xac)) {
        exHeaderLen = 16;
        this.height = (rtpPayload[exHeaderLen + 9] << 8) | rtpPayload[exHeaderLen + 10];
        this.width = (rtpPayload[exHeaderLen + 11] << 8) | rtpPayload[exHeaderLen + 12];
      } else {
        this.height = (rtpPayload[9] << 8) | rtpPayload[10];
        this.width = (rtpPayload[11] << 8) | rtpPayload[12];
      }
    }

    let dri: number | null = null;
    let qtables: Uint8Array | null = null;
    let qtlen = 0;
    if (Type > 63) {
      // Restart Marker header present
      const RestartInterval = (rtpPayload[extensionHeaderLen + resultSpecialHeaderSize] << 8) | rtpPayload[extensionHeaderLen + resultSpecialHeaderSize + 1];
      dri = RestartInterval;
      resultSpecialHeaderSize += 4;
    }

    if (Offset === 0) {
      if (Q > 127) {
        // Quantization Table header present
        const MBZ = rtpPayload[extensionHeaderLen + resultSpecialHeaderSize];
        if (MBZ === 0) {
          const Length = (rtpPayload[extensionHeaderLen + resultSpecialHeaderSize + 2] << 8) | rtpPayload[extensionHeaderLen + resultSpecialHeaderSize + 3];
          resultSpecialHeaderSize += 4;
          qtlen = Length;
          qtables = new Uint8Array(new ArrayBuffer(Length));
          qtables.set(rtpPayload.subarray(extensionHeaderLen + resultSpecialHeaderSize, extensionHeaderLen + resultSpecialHeaderSize + Length), 0);
          resultSpecialHeaderSize += Length;
        }
      }
    }

    if (qtlen === 0) {
      // A quantization table was not present in the RTP JPEG header, so use
      // the default tables, scaled according to the "Q" factor:
      qtlen = 128;
      qtables = new Uint8Array(new ArrayBuffer(qtlen));
      makeDefaultQtables(qtables, Q);
    }
    return makeJPEGHeader(type, this.width, this.height, qtables as Uint8Array, qtlen, dri);
  }

  private frameDataReturn(count: number): void {
    const buffer = this.payloadBuffer.splice(0, count);

    let totalLength = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      totalLength += buffer[i].length;
    }

    const jpegFrameData = new Uint8Array(totalLength);
    let index = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      jpegFrameData.set(buffer[i], index);
      index += buffer[i].length;
    }

    this.frameData.playMode = this.playback === true ? 'Playback' : 'Live';
    this.frameData.streamData = {
      interleavedId: this.interleavedId,
      codecType: 'MJPEG',
      frameData: jpegFrameData,
      timeStamp: {
        rtpTimestamp: (this.lastRtpTimeStamp / 90).toFixed(0),
        timestamp: this.timeData.timestamp,
        timestamp_usec: this.timeData.timestamp_usec,
        timezone: this.timeData.timezone
      }
    };
    this.frameData.videoInfo = {
      frameType: 'I',
      width: this.width,
      height: this.height,
      framerate: this.getFramerate()
    };
    if (this.objectId !== null) {
      this.frameData.streamData.objectId = this.objectId;
    }

    this.gotFrameCallback?.(this.frameData);
  }

  private parseExtensionHeader(rtpHeader: Uint8Array, rtpPayload: Uint8Array): void {
    void rtpHeader;
    if (!this.rtpExtension) {
      return;
    }
    // RTP Header Extension bit set
    if (rtpPayload[0] === 0xab && (rtpPayload[1] === 0xad || rtpPayload[1] === 0xac)) {
      let startHeader = 4;
      this.extensionHeaderLen = ((rtpPayload[2] << 8 | rtpPayload[3]) * 4) + 4;
      if (this.deviceType === 'nvr') {
        const timestampExtensionLen = 16; // 16 byte Replay Extension header
        if (rtpPayload[timestampExtensionLen] === 0xff && rtpPayload[timestampExtensionLen + 1] === 0xdd) {
          this.extensionHeaderLen = timestampExtensionLen + 8;
          if (rtpPayload[this.extensionHeaderLen] === 0xff && rtpPayload[this.extensionHeaderLen + 1] === 0xd8) {
            this.extensionHeaderLen += ((rtpPayload[this.extensionHeaderLen + 2] << 8 | rtpPayload[this.extensionHeaderLen + 3]) * 4) + 4; // MJPEG extensionHeader
          }
          this.objectId = (rtpPayload[timestampExtensionLen + 4] << 24) | (rtpPayload[timestampExtensionLen + 5] << 16) | (rtpPayload[timestampExtensionLen + 6] << 8) | rtpPayload[timestampExtensionLen + 7];
          // eslint-disable-next-line no-console
          console.log('objectId:', this.objectId);
        } else if (
          (rtpPayload[timestampExtensionLen] === 0xff && rtpPayload[timestampExtensionLen + 1] === 0xd8) ||
          (rtpPayload[timestampExtensionLen] === 0xbe && rtpPayload[timestampExtensionLen + 1] === 0xde)
        ) {
          this.extensionHeaderLen = timestampExtensionLen + ((rtpPayload[timestampExtensionLen + 2] << 8) | (rtpPayload[timestampExtensionLen + 3]) * 4) + 4; // MJPEG extensionHeader
        }
      }

      this.NTPmsw.set(rtpPayload.subarray(startHeader, startHeader + 4), 0);
      startHeader += 4;
      this.NTPlsw.set(rtpPayload.subarray(startHeader, startHeader + 4), 0);
      if (this.deviceType === 'camera') {
        startHeader += 6;
        this.gmt.set(rtpPayload.subarray(startHeader, startHeader + 2), 0);
      }

      this.timeData.timestamp = (ntohl(this.NTPmsw) - 0x83aa7e80) >>> 0;
      this.timeData.timestamp_usec = (ntohl(this.NTPlsw) / 0xffffffff) * 1000;

      if (this.deviceType === 'camera') {
        this.timeData.timezone = ((this.gmt[0] << 8) | this.gmt[1]) << 16 >> 16;
      }

      if (this.prevTimeData.timestamp && this.prevTimeData.timestamp_usec) {
        const timeGap = Math.abs(this.timeData.timestamp - this.prevTimeData.timestamp);
        if (timeGap <= 1) {
          const diffSecond = this.timeData.timestamp - this.prevTimeData.timestamp;
          const diffUsec = this.timeData.timestamp_usec - this.prevTimeData.timestamp_usec;
          const distance = Math.abs(diffSecond * 1000 + diffUsec);
          if (distance !== 0) {
            this.setFramerate(Math.round(1000 / distance));
          }
        }
      }
      this.prevTimeData = {
        timestamp: this.timeData.timestamp,
        timestamp_usec: this.timeData.timestamp_usec,
        timezone: this.timeData.timezone
      };
      this.playback = true;
    } else if (rtpPayload[0] === 0xff && rtpPayload[1] === 0xdd) {
      this.extensionHeaderLen = 8;
      if (rtpPayload[this.extensionHeaderLen] === 0xff && rtpPayload[this.extensionHeaderLen + 1] === 0xd8) {
        this.extensionHeaderLen += ((rtpPayload[this.extensionHeaderLen + 2] << 8 | rtpPayload[this.extensionHeaderLen + 3]) * 4) + 4; // MJPEG extensionHeader
      }
      this.objectId = (rtpPayload[4] << 24) | (rtpPayload[5] << 16) | (rtpPayload[6] << 8) | rtpPayload[7];
    } else if ((rtpPayload[0] === 0xff && rtpPayload[1] === 0xd8) || (rtpPayload[0] === 0xbe && rtpPayload[1] === 0xde)) {
      this.extensionHeaderLen = ((rtpPayload[2] << 8) | (rtpPayload[3]) * 4) + 4; // MJPEG extensionHeader
    }
  }

  depacketize(rtspInterleaved: Uint8Array, rtpHeader: Uint8Array, rtpPayload: Uint8Array): void {
    const payloadsize = ((rtspInterleaved[2] << 8) + rtspInterleaved[3]) - 12; // RTP Header: 12 bytes

    // Reference: https://tools.ietf.org/html/rfc3550
    // Reference: https://tools.ietf.org/html/rfc3984
    const rtpPadding = ((rtpHeader[0] & 0x20) >> 5) === 1;
    this.rtpExtension = ((rtpHeader[0] & 0x10) >> 4) === 1;
    const rtpCSRCCount = rtpHeader[0] & 0x0f;
    const rtpMarkerBit = ((rtpHeader[1] & 0x80) >> 7) === 1;

    if (rtpCSRCCount !== 0) {
      // eslint-disable-next-line no-console
      console.error('There is additional CSRC which is not handled in this version. CSRC count = ' + rtpCSRCCount);
    } else if (rtpPadding) {
      // legacy: `PaddingSize = rtpPayload[rtpPayload.length - 1];` — `PaddingSize`
      // is never declared anywhere in mjpegDepacketizer.js, and the file runs
      // in strict mode, so this throws ReferenceError whenever an MJPEG RTP
      // packet has the padding bit set with no CSRC. Preserved faithfully.
      throw undefinedGlobalError('PaddingSize');
    }

    if (this.rtpExtension) {
      this.parseExtensionHeader(rtpHeader, rtpPayload);
    } else {
      this.extensionHeaderLen = 0;
    }

    this.lastRtpTimeStamp = ntohl(rtpHeader.subarray(4, 8));
    // legacy also computes `rtpSquenceNumber = ntohs(rtpHeader.subarray(2, 4));`
    // here — a pure, side-effect-free call assigned only to a write-only var
    // (confirmed no other read site) — dropped entirely.

    const extensionHeaderLen = this.extensionHeaderLen ?? 0;
    const fragmentOffset = (rtpPayload[extensionHeaderLen + 1] << 16) | (rtpPayload[extensionHeaderLen + 2] << 8) | rtpPayload[extensionHeaderLen + 3];

    let skipDataSize: number;
    if (fragmentOffset === 0) {
      this.payloadBuffer = [this.createjpegheader(rtpPayload)]; // Create JPEG Frame Header (start of MJPEG frame)
      skipDataSize = this.getspecialheadersize(rtpPayload) + extensionHeaderLen;
    } else {
      skipDataSize = 8 + extensionHeaderLen;
      if (rtpPayload[extensionHeaderLen + 4] > 63) {
        skipDataSize += 4;
      }
      if (payloadsize < skipDataSize) {
        // We got only partial jpeg header — this should not happen.
        return;
      }
    }
    this.skipDataSize = skipDataSize;

    this.payloadBuffer.push(rtpPayload.subarray(this.skipDataSize, payloadsize));

    if (rtpMarkerBit) {
      if (this.playback === true) {
        // call decoder callback — legacy reassigns the whole `timeData`
        // reference to `prevTimeData` (not a per-field merge) when
        // `timestamp` is falsy; can leave `timeData` aliasing `prevTimeData`.
        this.timeData = this.timeData.timestamp ? this.timeData : this.prevTimeData;
      }
      this.frameDataReturn(this.payloadBuffer.length);
    }
  }
}
