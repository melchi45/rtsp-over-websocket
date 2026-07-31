import { describe, it, expect } from 'vitest';
import { loadLegacyModule, type LegacySandbox } from '../../test-support/loadLegacyModule';
import { inheritObject } from '../../test-support/legacyGlobals';
import { VideoHeader, type VideoBackupFrame, type VideoBackupFileInfo } from './VideoHeader';

interface LegacyVideoHeader {
  buffer: Uint8Array;
  streamHeader: Record<string, unknown>;
  aviIndexEntry: Record<string, unknown>;
  errorCase: number;
  initHeader(videoFrame: VideoBackupFrame): void;
  updateInfo(videoFrame: VideoBackupFrame, fileInfo: VideoBackupFileInfo): Uint8Array | null;
  getErrorCode(): number;
}

function buildSandbox(): LegacySandbox {
  return {
    inheritObject,
    AviFormatWriter: loadLegacyModule('Worker/Backup/avi_format_writer.js', 'AviFormatWriter')
  };
}

function newLegacy(): LegacyVideoHeader {
  const Ctor = loadLegacyModule<() => LegacyVideoHeader>('Worker/Backup/videoBackup.js', 'VideoHeader', buildSandbox());
  return Ctor();
}

function frame(overrides: Partial<VideoBackupFrame> = {}): VideoBackupFrame {
  return { codectype: 'H264', width: 1920, height: 1080, framerate: 30, frameType: 'I', PESsize: 4001, sourceInputMs: 1000, ...overrides };
}

describe('VideoHeader parity with the legacy player’s Worker/Backup/videoBackup.js', () => {
  it('initHeader produces identical stream header/format fields', () => {
    const legacy = newLegacy();
    const ported = new VideoHeader();
    const f = frame();

    legacy.initHeader(f);
    ported.initHeader(f);

    expect(ported.streamHeader).toEqual(legacy.streamHeader);
    expect(ported.streamFormat).toEqual(legacy.streamFormat);
  });

  it('updateInfo on the first call initializes the header and returns an identical chunk-header buffer (odd PESsize rounded up)', () => {
    const legacy = newLegacy();
    const ported = new VideoHeader();
    const fileInfoLegacy: VideoBackupFileInfo = { pos: 2048 };
    const fileInfoPorted: VideoBackupFileInfo = { pos: 2048 };
    const f = frame({ PESsize: 4001 });

    const legacyResult = legacy.updateInfo(f, fileInfoLegacy);
    const portedResult = ported.updateInfo(f, fileInfoPorted);

    expect(Array.from(portedResult as Uint8Array)).toEqual(Array.from(legacyResult as Uint8Array));
    expect(fileInfoPorted).toEqual(fileInfoLegacy);
    expect(ported.streamHeader).toEqual(legacy.streamHeader);
    expect(ported.aviIndexEntry).toEqual(legacy.aviIndexEntry);
  });

  it('updateInfo across a sequence of frames (dummy-frame padding for irregular timing) stays identical', () => {
    const legacy = newLegacy();
    const ported = new VideoHeader();
    const fileInfoLegacy: VideoBackupFileInfo = { pos: 2048 };
    const fileInfoPorted: VideoBackupFileInfo = { pos: 2048 };

    const frames = [
      frame({ frameType: 'I', sourceInputMs: 0, PESsize: 5000 }),
      frame({ frameType: 'P', sourceInputMs: 33, PESsize: 1200 }),
      frame({ frameType: 'P', sourceInputMs: 200, PESsize: 1100 }), // gap -> dummy frames
      frame({ frameType: 'P', sourceInputMs: 233, PESsize: 1300 })
    ];

    for (const f of frames) {
      const legacyResult = legacy.updateInfo(f, fileInfoLegacy);
      const portedResult = ported.updateInfo(f, fileInfoPorted);
      expect(Array.from(portedResult as Uint8Array)).toEqual(Array.from(legacyResult as Uint8Array));
    }

    expect(fileInfoPorted).toEqual(fileInfoLegacy);
    expect(ported.streamHeader).toEqual(legacy.streamHeader);
  });

  it('updateInfo returns null and sets an error code identically when the codec changes mid-backup', () => {
    const legacy = newLegacy();
    const ported = new VideoHeader();
    const fileInfoLegacy: VideoBackupFileInfo = { pos: 0 };
    const fileInfoPorted: VideoBackupFileInfo = { pos: 0 };

    legacy.updateInfo(frame({ codectype: 'H264' }), fileInfoLegacy);
    ported.updateInfo(frame({ codectype: 'H264' }), fileInfoPorted);

    const legacyResult = legacy.updateInfo(frame({ codectype: 'H265' }), fileInfoLegacy);
    const portedResult = ported.updateInfo(frame({ codectype: 'H265' }), fileInfoPorted);

    expect(portedResult).toBeNull();
    expect(legacyResult).toBeNull();
    expect(ported.getErrorCode()).toBe(legacy.getErrorCode());
    expect(ported.getErrorCode()).toBe(-1);
  });

  it('updateInfo returns null and sets an error code identically when the resolution changes mid-backup', () => {
    const legacy = newLegacy();
    const ported = new VideoHeader();
    const fileInfoLegacy: VideoBackupFileInfo = { pos: 0 };
    const fileInfoPorted: VideoBackupFileInfo = { pos: 0 };

    legacy.updateInfo(frame({ width: 1920, height: 1080 }), fileInfoLegacy);
    ported.updateInfo(frame({ width: 1920, height: 1080 }), fileInfoPorted);

    const legacyResult = legacy.updateInfo(frame({ width: 1280, height: 720 }), fileInfoLegacy);
    const portedResult = ported.updateInfo(frame({ width: 1280, height: 720 }), fileInfoPorted);

    expect(portedResult).toBeNull();
    expect(legacyResult).toBeNull();
    expect(ported.getErrorCode()).toBe(-2);
    expect(ported.getErrorCode()).toBe(legacy.getErrorCode());
  });
});
