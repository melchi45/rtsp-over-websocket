import { describe, it, expect } from 'vitest';
import { loadLegacyModule, type LegacySandbox } from '../../test-support/loadLegacyModule';
import { inheritObject } from '../../test-support/legacyGlobals';
import { AviFileWriter } from './AviFileWriter';
import type { VideoBackupFrame, VideoBackupFileInfo } from './VideoHeader';
import type { AudioBackupFrame, AudioBackupFileInfo } from './AudioHeader';

interface LegacyAviFileWriter {
  initHeader(type: 'video' | 'audio', frameInfo: VideoBackupFrame): void;
  updateInfo(type: 'video' | 'audio', frameInfo: unknown, fileInfo: unknown): Uint8Array | null;
  getErrorCode(type: 'video' | 'audio'): number;
  getChunkPayloadSize(type: 'video' | 'audio'): number | undefined;
  getIdxBuffer(type: 'video' | 'audio'): Uint8Array;
  getDuration(): number;
  makeAviHeader(fileSize: number, filePos: number): Uint8Array;
  makeAviTail(tailSize: number): Uint8Array;
  setResolution(width: number, height: number, fps: number): void;
}

function buildSandbox(): LegacySandbox {
  const aviFormatWriterModule = 'Worker/Backup/avi_format_writer.js';
  const base: LegacySandbox = {
    inheritObject,
    AviFormatWriter: loadLegacyModule(aviFormatWriterModule, 'AviFormatWriter')
  };
  return {
    ...base,
    VideoHeader: loadLegacyModule('Worker/Backup/videoBackup.js', 'VideoHeader', base),
    AudioHeader: loadLegacyModule('Worker/Backup/audioBackup.js', 'AudioHeader', base)
  };
}

function newLegacy(): LegacyAviFileWriter {
  const Ctor = loadLegacyModule<() => LegacyAviFileWriter>('Worker/Backup/avi_file_writer.js', 'AviFileWriter', buildSandbox());
  return Ctor();
}

function videoFrame(overrides: Partial<VideoBackupFrame> = {}): VideoBackupFrame {
  return { codectype: 'H264', width: 640, height: 480, framerate: 30, frameType: 'I', PESsize: 4001, sourceInputMs: 0, ...overrides };
}

function audioFrame(overrides: Partial<AudioBackupFrame> = {}): AudioBackupFrame {
  return { codectype: 'AAC', bitrate: 64000, audioSamplingRate: 44100, PESsize: 501, ...overrides };
}

describe('AviFileWriter parity with the legacy player’s Worker/Backup/avi_file_writer.js', () => {
  it('initHeader("video") initializes both video and audio headers identically', () => {
    const legacy = newLegacy();
    const ported = new AviFileWriter();
    const f = videoFrame();

    legacy.initHeader('video', f);
    ported.initHeader('video', f);

    // Observable via a subsequent updateInfo call producing identical bytes.
    const fileInfoLegacy: VideoBackupFileInfo = { pos: 2048 };
    const fileInfoPorted: VideoBackupFileInfo = { pos: 2048 };
    const legacyResult = legacy.updateInfo('video', f, fileInfoLegacy);
    const portedResult = ported.updateInfo('video', f, fileInfoPorted);
    expect(Array.from(portedResult as Uint8Array)).toEqual(Array.from(legacyResult as Uint8Array));
  });

  it('updateInfo dispatches to the video/audio sub-writer identically across a mixed sequence', () => {
    const legacy = newLegacy();
    const ported = new AviFileWriter();
    const vf = videoFrame();
    legacy.initHeader('video', vf);
    ported.initHeader('video', vf);

    const videoFileInfoLegacy: VideoBackupFileInfo = { pos: 2048 };
    const videoFileInfoPorted: VideoBackupFileInfo = { pos: 2048 };
    const audioFileInfoLegacy: AudioBackupFileInfo = { pos: 2048 };
    const audioFileInfoPorted: AudioBackupFileInfo = { pos: 2048 };

    for (let i = 0; i < 2; i++) {
      const legacyV = legacy.updateInfo('video', vf, videoFileInfoLegacy);
      const portedV = ported.updateInfo('video', vf, videoFileInfoPorted);
      expect(Array.from(portedV as Uint8Array)).toEqual(Array.from(legacyV as Uint8Array));

      const af = audioFrame({ PESsize: 500 + i });
      const legacyA = legacy.updateInfo('audio', af, audioFileInfoLegacy);
      const portedA = ported.updateInfo('audio', af, audioFileInfoPorted);
      expect(Array.from(portedA as Uint8Array)).toEqual(Array.from(legacyA as Uint8Array));
    }

    expect(ported.getDuration()).toBe(legacy.getDuration());
    expect(ported.getErrorCode('video')).toBe(legacy.getErrorCode('video'));
    expect(ported.getErrorCode('audio')).toBe(legacy.getErrorCode('audio'));
    expect(ported.getChunkPayloadSize('video')).toBe(legacy.getChunkPayloadSize('video'));
    expect(ported.getChunkPayloadSize('audio')).toBe(legacy.getChunkPayloadSize('audio'));
    expect(Array.from(ported.getIdxBuffer('video'))).toEqual(Array.from(legacy.getIdxBuffer('video')));
    expect(Array.from(ported.getIdxBuffer('audio'))).toEqual(Array.from(legacy.getIdxBuffer('audio')));
  });

  it('makeAviHeader/makeAviTail produce byte-identical output after a video+audio frame sequence', () => {
    const legacy = newLegacy();
    const ported = new AviFileWriter();
    const vf = videoFrame();
    legacy.initHeader('video', vf);
    ported.initHeader('video', vf);

    legacy.updateInfo('video', vf, { pos: 2048 });
    ported.updateInfo('video', vf, { pos: 2048 });
    const af = audioFrame();
    legacy.updateInfo('audio', af, { pos: 2048 + 4008 });
    ported.updateInfo('audio', af, { pos: 2048 + 4008 });

    const legacyHeader = legacy.makeAviHeader(9000, 2048);
    const portedHeader = ported.makeAviHeader(9000, 2048);
    expect(Array.from(portedHeader)).toEqual(Array.from(legacyHeader));

    const legacyTail = legacy.makeAviTail(160);
    const portedTail = ported.makeAviTail(160);
    expect(Array.from(portedTail)).toEqual(Array.from(legacyTail));
  });

  it('setResolution forwards to the video header identically', () => {
    const legacy = newLegacy();
    const ported = new AviFileWriter();
    legacy.initHeader('video', videoFrame());
    ported.initHeader('video', videoFrame());

    legacy.setResolution(320, 240, 15);
    ported.setResolution(320, 240, 15);

    const fileInfoLegacy: VideoBackupFileInfo = { pos: 0 };
    const fileInfoPorted: VideoBackupFileInfo = { pos: 0 };
    const legacyResult = legacy.updateInfo('video', videoFrame({ width: 320, height: 240 }), fileInfoLegacy);
    const portedResult = ported.updateInfo('video', videoFrame({ width: 320, height: 240 }), fileInfoPorted);
    expect(Array.from(portedResult as Uint8Array)).toEqual(Array.from(legacyResult as Uint8Array));
  });
});
