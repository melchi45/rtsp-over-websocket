import { describe, it, expect } from 'vitest';
import { loadLegacyModule } from '../../test-support/loadLegacyModule';
import { AviFormatWriter, type AviMainHeader, type AviStreamHeader, type AviStreamFormat, type AviIndexEntry, type AviChunkHeader } from './AviFormatWriter';

interface LegacyAviFormatWriter {
  buffer: Uint8Array;
  bufferIndex: number;
  mainHeader: AviMainHeader;
  streamHeader: AviStreamHeader;
  streamFormat: AviStreamFormat;
  aviIndexEntry: AviIndexEntry;
  chunkHeader: AviChunkHeader;
  setBuffer(buffer: Uint8Array): void;
  writeInt8(val: number): void;
  writeInt16(val: number): void;
  writeInt32(val: number): void;
  writeString(str: string): void;
  writeChunkHeader(dummyCount?: number): void;
  initMainHeader(frameInfo: { framerate: number; width: number; height: number }): void;
  appendBuffer(buffer: Uint8Array): void;
  getIndexBuffer(): Uint8Array;
  writeAviMainHeader(fileSize: number): void;
  getVideoHeader(): Uint8Array;
  getAudioHeader(): Uint8Array;
  writeJunk(pos: number): Uint8Array;
  writeAviTailHeader(tailSize: number): Uint8Array;
  getDuration(): number;
  setResolution(w: number, h: number, fps: number): void;
  getAviSampleSize(): number;
}

function newLegacy(): LegacyAviFormatWriter {
  const Ctor = loadLegacyModule<() => LegacyAviFormatWriter>('Worker/Backup/avi_format_writer.js', 'AviFormatWriter');
  return Ctor();
}

describe('AviFormatWriter parity with the legacy player’s Worker/Backup/avi_format_writer.js', () => {
  it('writeInt8/16/32 write identical little-endian bytes', () => {
    const legacy = newLegacy();
    const ported = new AviFormatWriter();
    legacy.setBuffer(new Uint8Array(16));
    ported.setBuffer(new Uint8Array(16));

    legacy.writeInt8(0xab);
    ported.writeInt8(0xab);
    legacy.writeInt16(0x1234);
    ported.writeInt16(0x1234);
    legacy.writeInt32(0x89abcdef);
    ported.writeInt32(0x89abcdef);

    expect(Array.from(ported.buffer)).toEqual(Array.from(legacy.buffer));
    expect(ported.bufferIndex).toBe(legacy.bufferIndex);
  });

  it('writeString advances bufferIndex by 4 for an empty string (legacy quirk), and writes char codes otherwise', () => {
    const legacy = newLegacy();
    const ported = new AviFormatWriter();
    legacy.setBuffer(new Uint8Array(16));
    ported.setBuffer(new Uint8Array(16));

    legacy.writeString('');
    ported.writeString('');
    expect(ported.bufferIndex).toBe(legacy.bufferIndex);
    expect(ported.bufferIndex).toBe(4);

    legacy.writeString('RIFF');
    ported.writeString('RIFF');
    expect(Array.from(ported.buffer)).toEqual(Array.from(legacy.buffer));
  });

  it('writeChunkHeader (with and without dummy count) produces identical buffers', () => {
    const legacy = newLegacy();
    const ported = new AviFormatWriter();
    legacy.chunkHeader = { fourcc: '00dc', payloadsize: 1234 };
    ported.chunkHeader = { fourcc: '00dc', payloadsize: 1234 };

    legacy.writeChunkHeader();
    ported.writeChunkHeader();
    expect(Array.from(ported.buffer)).toEqual(Array.from(legacy.buffer));

    legacy.writeChunkHeader(3);
    ported.writeChunkHeader(3);
    expect(Array.from(ported.buffer)).toEqual(Array.from(legacy.buffer));
  });

  it('initMainHeader computes identical header fields', () => {
    const legacy = newLegacy();
    const ported = new AviFormatWriter();
    const frameInfo = { framerate: 25, width: 1920, height: 1080 };

    legacy.initMainHeader(frameInfo);
    ported.initMainHeader(frameInfo);

    expect(ported.mainHeader).toEqual(legacy.mainHeader);
  });

  it('writeAviMainHeader + getVideoHeader + getAudioHeader + writeJunk produce byte-identical output for a full header sequence', () => {
    const legacy = newLegacy();
    const ported = new AviFormatWriter();
    const frameInfo = { framerate: 30, width: 640, height: 480 };

    for (const w of [legacy, ported]) {
      w.initMainHeader(frameInfo);
      w.mainHeader.aviTotalFrames = 100;
      w.streamHeader = {
        aviFourCC: 'strh',
        aviBytesCount: 56,
        aviType: 'vids',
        aviHandler: 'H264',
        aviFlags: 0,
        aviScale: 1000,
        aviRate: 30000,
        aviLength: 100,
        aviSuggestedBufferSize: 460800,
        aviQuality: -1,
        aviSampleSize: 0
      };
      w.streamFormat = {
        FourCC: 'strf',
        BytesCount: 40,
        Size: 40,
        Width: 640,
        Height: 480,
        Planes: 1,
        BitCount: 24,
        Compression: 'H264',
        SizeImage: 640 * 480 * 30
      };
    }

    legacy.writeAviMainHeader(5000);
    ported.writeAviMainHeader(5000);
    expect(Array.from(ported.buffer)).toEqual(Array.from(legacy.buffer));

    const legacyVideoHeader = legacy.getVideoHeader();
    const portedVideoHeader = ported.getVideoHeader();
    expect(Array.from(portedVideoHeader)).toEqual(Array.from(legacyVideoHeader));

    for (const w of [legacy, ported]) {
      w.streamFormat = {
        ...w.streamFormat,
        FormatTag: 1,
        Channels: 1,
        SamplesPerSec: 8000,
        AvgBytesPerSec: 8000,
        BlockAlign: 1,
        BitsPerSample: 8,
        AudioConfig: 0
      };
    }
    const legacyAudioHeader = legacy.getAudioHeader();
    const portedAudioHeader = ported.getAudioHeader();
    expect(Array.from(portedAudioHeader)).toEqual(Array.from(legacyAudioHeader));

    const legacyJunk = legacy.writeJunk(2048);
    const portedJunk = ported.writeJunk(2048);
    expect(Array.from(portedJunk)).toEqual(Array.from(legacyJunk));
  });

  it('getIndexBuffer produces identical bytes, including the dummy-count-repeated-entries branch', () => {
    const legacy = newLegacy();
    const ported = new AviFormatWriter();
    const entry: AviIndexEntry = { chid: '00dc', flag: 0x10, offset: 4096, size: 512, dummycount: 2 };
    legacy.aviIndexEntry = { ...entry };
    ported.aviIndexEntry = { ...entry };

    expect(Array.from(ported.getIndexBuffer())).toEqual(Array.from(legacy.getIndexBuffer()));
  });

  it('writeAviTailHeader produces identical bytes', () => {
    const legacy = newLegacy();
    const ported = new AviFormatWriter();
    expect(Array.from(ported.writeAviTailHeader(999))).toEqual(Array.from(legacy.writeAviTailHeader(999)));
  });

  it('getDuration/setResolution/getAviSampleSize compute identically', () => {
    const legacy = newLegacy();
    const ported = new AviFormatWriter();
    legacy.streamHeader = { aviRate: 30000, aviLength: 300 };
    ported.streamHeader = { aviRate: 30000, aviLength: 300 };
    expect(ported.getDuration()).toBe(legacy.getDuration());

    legacy.setResolution(320, 240, 15);
    ported.setResolution(320, 240, 15);
    expect(ported.streamHeader).toEqual(legacy.streamHeader);
    expect(ported.streamFormat).toEqual(legacy.streamFormat);

    legacy.streamFormat = { BitsPerSample: 16, Channels: 2 };
    ported.streamFormat = { BitsPerSample: 16, Channels: 2 };
    expect(ported.getAviSampleSize()).toBe(legacy.getAviSampleSize());
  });

  it('appendBuffer writes into the current buffer at bufferIndex and advances it, identically', () => {
    const legacy = newLegacy();
    const ported = new AviFormatWriter();
    legacy.setBuffer(new Uint8Array(8));
    ported.setBuffer(new Uint8Array(8));
    legacy.bufferIndex = 2;
    ported.bufferIndex = 2;

    legacy.appendBuffer(new Uint8Array([1, 2, 3]));
    ported.appendBuffer(new Uint8Array([1, 2, 3]));

    expect(Array.from(ported.buffer)).toEqual(Array.from(legacy.buffer));
    expect(ported.bufferIndex).toBe(legacy.bufferIndex);
  });
});
