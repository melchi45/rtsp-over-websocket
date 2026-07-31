export interface AviMainHeader {
  aviFourCC?: string;
  aviBytesCount?: number;
  aviMicroSecPerFrame?: number;
  aviMaxBytesPerSec?: number;
  aviPaddingGranularity?: number;
  aviFlags?: number;
  aviTotalFrames?: number;
  aviStreams?: number;
  aviWidth?: number;
  aviHeight?: number;
  aviSuggestedBufferSize?: number;
}

export interface AviStreamHeader {
  aviFourCC?: string;
  aviBytesCount?: number;
  aviType?: string;
  aviHandler?: string;
  aviFlags?: number;
  aviScale?: number;
  aviRate?: number;
  aviLength?: number;
  aviSuggestedBufferSize?: number;
  aviQuality?: number;
  aviSampleSize?: number;
  /** Set by VideoHeader/AudioHeader but never read by writeStreamHeader() (which always writes a hardcoded 0) — confirmed write-only, kept only for data fidelity. */
  aviInitialFrames?: number;
  last_ms?: number;
  width?: number;
  height?: number;
  compressor?: string;
  aviRight?: number;
  aviBottom?: number;
}

export interface AviStreamFormat {
  FourCC?: string;
  BytesCount?: number;
  Size?: number;
  Width?: number;
  Height?: number;
  Planes?: number;
  BitCount?: number;
  Compression?: string;
  SizeImage?: number;
  FormatTag?: number;
  Channels?: number;
  SamplesPerSec?: number;
  AvgBytesPerSec?: number;
  BlockAlign?: number;
  BitsPerSample?: number;
  AudioConfig?: number;
  /** legacy `settingG726` bug: assigns here instead of AviStreamHeader.aviSuggestedBufferSize — preserved faithfully, never read by any writer. */
  aviSuggestedBufferSize?: number;
}

export interface AviIndexEntry {
  chid?: string;
  flag?: number;
  offset?: number;
  size?: number;
  dummycount?: number;
}

export interface AviChunkHeader {
  fourcc?: string;
  payloadsize?: number;
}

const HEADER_BYTES = 2048;
const SIZE_OF_CHUNK_HEADER = 8;
const SIZE_OF_AVI_INDEX_ENTRY = 16;
const AVIF_WASCAPTUREFILE = 0x00010000;
const AVIF_HASINDEX = 0x00000010;
const SIZE_OF_AVI_MAIN_HEADER = 64;
const SIZE_OF_STREAM_HEADER = 64;
const SIZE_OF_BITMAP_INFO = 48;
const SIZE_OF_WAVE_FORMAT = 40;

/**
 * Ported from the legacy player’s Worker/Backup/avi_format_writer.js — the shared
 * AVI-container binary writer base class VideoHeader/AudioHeader/
 * AviFileWriter all build on (`inheritObject(new AviFormatWriter(), {...})`
 * in legacy; a real `extends` base class here).
 *
 * Legacy's constructor also sets `this.aviHeader = {}; this.aviHeader.pos =
 * 4;` — confirmed write-only across every file in this AVI-writer family
 * (grep finds no read site anywhere), so `aviHeader` is dropped entirely.
 */
export class AviFormatWriter {
  bufferIndex = 0;
  errorCase = 0;
  buffer: Uint8Array = new Uint8Array(0);
  mainHeader: AviMainHeader = {};
  streamHeader: AviStreamHeader = {};
  streamFormat: AviStreamFormat = {};
  aviIndexEntry: AviIndexEntry = {};
  chunkHeader: AviChunkHeader = {};

  setBuffer(buffer: Uint8Array): void {
    this.buffer = buffer;
    this.bufferIndex = 0;
  }

  writeInt8(val: number): void {
    this.buffer[this.bufferIndex] = val;
    this.bufferIndex++;
  }

  writeInt16(val: number): void {
    this.writeInt8(val & 0xff);
    this.writeInt8(val >> 8);
  }

  writeInt32(val: number): void {
    this.writeInt8(val & 0xff);
    this.writeInt8((val >> 8) & 0xff);
    this.writeInt8((val >> 16) & 0xff);
    this.writeInt8(val >> 24);
  }

  writeString(str: string): void {
    if (str === '') {
      this.bufferIndex += 4;
    }
    for (let i = 0; i < str.length; i++) {
      this.buffer[this.bufferIndex++] = str.charCodeAt(i);
    }
  }

  writeChunkHeader(dummyCountInput?: number): void {
    const dummyCount = dummyCountInput === undefined || dummyCountInput === null ? 0 : dummyCountInput;
    this.setBuffer(new Uint8Array(SIZE_OF_CHUNK_HEADER + SIZE_OF_CHUNK_HEADER * dummyCount));
    for (let i = 0; i < dummyCount; i++) {
      this.writeString(this.chunkHeader.fourcc as string);
      this.writeInt32(0);
    }
    this.writeString(this.chunkHeader.fourcc as string);
    this.writeInt32(this.chunkHeader.payloadsize as number);
  }

  initMainHeader(frameInfo: { framerate: number; width: number; height: number }): void {
    this.mainHeader.aviFourCC = 'avih';
    this.mainHeader.aviBytesCount = 56;
    this.mainHeader.aviMicroSecPerFrame = 1000000 / frameInfo.framerate;
    this.mainHeader.aviMaxBytesPerSec = 0;
    this.mainHeader.aviPaddingGranularity = 0;
    this.mainHeader.aviFlags = AVIF_WASCAPTUREFILE | AVIF_HASINDEX;
    this.mainHeader.aviStreams = 2;
    this.mainHeader.aviWidth = frameInfo.width;
    this.mainHeader.aviHeight = frameInfo.height;
    this.mainHeader.aviSuggestedBufferSize = 128 * 1024;
  }

  updateInfo(_frameInfo: unknown, _fileInfo: unknown, _streamData?: unknown): unknown {
    return undefined;
  }

  getStreamHeader(): AviStreamHeader {
    return this.streamHeader;
  }

  setStreamHeader(streamHeader: AviStreamHeader): void {
    this.streamHeader = streamHeader;
  }

  getStreamFormat(): AviStreamFormat {
    return this.streamFormat;
  }

  setStreamFormat(streamFormat: AviStreamFormat): void {
    this.streamFormat = streamFormat;
  }

  appendBuffer(buffer: Uint8Array): void {
    this.buffer.set(buffer, this.bufferIndex);
    this.bufferIndex += buffer.length;
  }

  getIndexBuffer(): Uint8Array {
    this.setBuffer(new Uint8Array(SIZE_OF_AVI_INDEX_ENTRY * (1 + (this.aviIndexEntry.dummycount ?? 0))));
    for (let i = this.aviIndexEntry.dummycount ?? 0; i > 0; i--) {
      this.writeString(this.aviIndexEntry.chid as string);
      this.writeInt32(this.aviIndexEntry.flag as number);
      this.writeInt32((this.aviIndexEntry.offset as number) - SIZE_OF_CHUNK_HEADER * (this.aviIndexEntry.dummycount as number));
      this.writeInt32(0);
    }
    this.writeString(this.aviIndexEntry.chid as string);
    this.writeInt32(this.aviIndexEntry.flag as number);
    this.writeInt32(this.aviIndexEntry.offset as number);
    this.writeInt32(this.aviIndexEntry.size as number);
    return this.buffer;
  }

  writeMainHeader(): void {
    this.writeString(this.mainHeader.aviFourCC as string);
    this.writeInt32(this.mainHeader.aviBytesCount as number);
    this.writeInt32(this.mainHeader.aviMicroSecPerFrame as number);
    this.writeInt32(this.mainHeader.aviMaxBytesPerSec as number);
    this.writeInt32(this.mainHeader.aviPaddingGranularity as number);
    this.writeInt32(this.mainHeader.aviFlags as number);
    this.writeInt32(this.mainHeader.aviTotalFrames as number);
    this.writeInt32(0); // aviInitialFrames
    this.writeInt32(this.mainHeader.aviStreams as number);
    this.writeInt32(this.mainHeader.aviSuggestedBufferSize as number);
    this.writeInt32(this.mainHeader.aviWidth as number);
    this.writeInt32(this.mainHeader.aviHeight as number);
    this.writeInt32(0);
    this.writeInt32(0);
    this.writeInt32(0);
    this.writeInt32(0);
  }

  writeStreamHeader(): void {
    this.writeString(this.streamHeader.aviFourCC as string);
    this.writeInt32(this.streamHeader.aviBytesCount as number);
    this.writeString(this.streamHeader.aviType as string);
    this.writeString(this.streamHeader.aviHandler as string);
    this.writeInt32(this.streamHeader.aviFlags as number);
    this.writeInt16(0); // aviPriority
    this.writeInt16(0); // aviLanguage
    this.writeInt32(0); // aviInitialFrames
    this.writeInt32(this.streamHeader.aviScale as number);
    this.writeInt32(this.streamHeader.aviRate as number);
    this.writeInt32(0); // aviStart
    this.writeInt32(this.streamHeader.aviLength as number);
    this.writeInt32(this.streamHeader.aviSuggestedBufferSize as number);
    this.writeInt32(this.streamHeader.aviQuality as number);
    this.writeInt32(this.streamHeader.aviSampleSize as number);
    this.writeInt16(0);
    this.writeInt16(0);
    this.writeInt16(0);
    this.writeInt16(0);
  }

  writeBitmapInfo(): void {
    this.writeString(this.streamFormat.FourCC as string);
    this.writeInt32(this.streamFormat.BytesCount as number);
    this.writeInt32(this.streamFormat.Size as number);
    this.writeInt32(this.streamFormat.Width as number);
    this.writeInt32(this.streamFormat.Height as number);
    this.writeInt16(this.streamFormat.Planes as number);
    this.writeInt16(this.streamFormat.BitCount as number);
    this.writeString(this.streamFormat.Compression as string);
    this.writeInt32(this.streamFormat.SizeImage as number);
    this.writeInt32(0); // XPelsPerMeter
    this.writeInt32(0); // YPelsPerMeter
    this.writeInt32(0); // ClrUsed
    this.writeInt32(0); // ClrImportant
  }

  writeWaveFormatEx(): void {
    this.writeString(this.streamFormat.FourCC as string);
    this.writeInt32(this.streamFormat.BytesCount as number);
    this.writeInt16(this.streamFormat.FormatTag as number);
    this.writeInt16(this.streamFormat.Channels as number);
    this.writeInt32(this.streamFormat.SamplesPerSec as number);
    this.writeInt32(this.streamFormat.AvgBytesPerSec as number);
    this.writeInt16(this.streamFormat.BlockAlign as number);
    this.writeInt16(this.streamFormat.BitsPerSample as number);
    this.writeInt16(this.streamFormat.Size as number);
    this.writeInt16(this.streamFormat.AudioConfig as number);
    this.writeInt16(0); // Id
    this.writeInt32(0); // Flags
    this.writeInt16(0); // BlockSize
    this.writeInt16(0); // FramesPerBlock
    this.writeInt16(0); // CodecDelay
  }

  writeAviMainHeader(fileSize: number): void {
    this.setBuffer(new Uint8Array(2048));
    const hdrlBytes = 4 + SIZE_OF_AVI_MAIN_HEADER + 2 * (12 + SIZE_OF_STREAM_HEADER) + SIZE_OF_BITMAP_INFO + SIZE_OF_WAVE_FORMAT;
    this.writeString('RIFF');
    this.writeInt32(fileSize - 8);
    this.writeString('AVI '); // Be very careful with this;

    this.writeString('LIST'); // top list
    this.writeInt32(hdrlBytes);
    this.writeString('hdrl');
    this.writeMainHeader();
  }

  getVideoHeader(): Uint8Array {
    this.setBuffer(new Uint8Array(31 * 4));
    this.writeString('LIST'); // video list
    this.writeInt32(4 + 64 + 48);
    this.writeString('strl');
    this.writeStreamHeader();
    this.writeBitmapInfo();
    return this.buffer;
  }

  getAudioHeader(): Uint8Array {
    this.setBuffer(new Uint8Array(29 * 4));
    this.writeString('LIST'); // Audio list
    this.writeInt32(4 + SIZE_OF_STREAM_HEADER + SIZE_OF_WAVE_FORMAT);
    this.writeString('strl');
    this.writeStreamHeader();
    this.writeWaveFormatEx();
    return this.buffer;
  }

  writeJunk(pos: number): Uint8Array {
    this.writeString('JUNK');
    const njunk = HEADER_BYTES - this.bufferIndex - 4 - 12;
    this.writeInt32(njunk);
    for (let i = 0; i < njunk; i++) {
      this.writeInt8(0);
    }
    this.writeString('LIST');
    this.writeInt32(pos);
    this.writeString('movi');
    return this.buffer;
  }

  writeAviTailHeader(tailSize: number): Uint8Array {
    this.setBuffer(new Uint8Array(8));
    this.writeString('idx1');
    this.writeInt32(tailSize);
    return this.buffer;
  }

  getMainHeader(): AviMainHeader {
    return this.mainHeader;
  }

  setMainHeader(mainHeader: AviMainHeader): void {
    this.mainHeader = mainHeader;
  }

  getIndexEntry(): AviIndexEntry {
    return this.aviIndexEntry;
  }

  setIndexEntry(aviIndexEntry: AviIndexEntry): void {
    this.aviIndexEntry = aviIndexEntry;
  }

  setChunkHeader(chunkHeader: AviChunkHeader): void {
    this.chunkHeader = chunkHeader;
  }

  getChunkPayloadSize(): number | undefined {
    return this.chunkHeader.payloadsize;
  }

  setErrorCode(errorCode: number): void {
    this.errorCase = errorCode;
  }

  getErrorCode(): number {
    return this.errorCase;
  }

  getTotalFrames(): number | undefined {
    return this.streamHeader.aviLength;
  }

  getDuration(): number {
    const fps = (this.streamHeader.aviRate as number) / 1000;
    return (this.streamHeader.aviLength as number) / fps;
  }

  setResolution(w: number, h: number, fps: number): void {
    this.streamHeader.aviRight = this.streamHeader.width = w;
    this.streamHeader.aviBottom = this.streamHeader.height = h;
    this.streamHeader.aviSuggestedBufferSize = Math.floor((w * h) / 2);

    this.streamFormat.Width = w;
    this.streamFormat.Height = h;
    this.streamFormat.SizeImage = w * h * fps;
  }

  getAviSampleSize(): number {
    let size = Math.floor(((this.streamFormat.BitsPerSample as number) + 7) / 8) * (this.streamFormat.Channels as number);
    if (size === 0) {
      size = 1;
    }
    return size;
  }
}
