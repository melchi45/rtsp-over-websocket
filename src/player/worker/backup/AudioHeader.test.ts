import { describe, it, expect } from 'vitest';
import { loadLegacyModule, type LegacySandbox } from '../../test-support/loadLegacyModule';
import { inheritObject } from '../../test-support/legacyGlobals';
import { AudioHeader, type AudioBackupFrame, type AudioBackupFileInfo } from './AudioHeader';

interface LegacyAudioHeader {
  buffer: Uint8Array;
  streamHeader: Record<string, unknown>;
  streamFormat: Record<string, unknown>;
  aviIndexEntry: Record<string, unknown>;
  errorCase: number;
  initHeader(): void;
  settingAAC(audioFrame: AudioBackupFrame): void;
  settingG711(): void;
  settingG726(audioFrame: AudioBackupFrame): void;
  checkAudioFrameInfo(audioFrame: AudioBackupFrame, fileInfo: AudioBackupFileInfo): number;
  updateInfo(audioFrame: AudioBackupFrame, fileInfo: AudioBackupFileInfo): Uint8Array | null;
  getErrorCode(): number;
}

function buildSandbox(): LegacySandbox {
  return {
    inheritObject,
    AviFormatWriter: loadLegacyModule('Worker/Backup/avi_format_writer.js', 'AviFormatWriter')
  };
}

function newLegacy(): LegacyAudioHeader {
  const Ctor = loadLegacyModule<() => LegacyAudioHeader>('Worker/Backup/audioBackup.js', 'AudioHeader', buildSandbox());
  return Ctor();
}

function aacFrame(overrides: Partial<AudioBackupFrame> = {}): AudioBackupFrame {
  return { codectype: 'AAC', bitrate: 64000, audioSamplingRate: 44100, PESsize: 501, ...overrides };
}

describe('AudioHeader parity with the legacy player’s Worker/Backup/audioBackup.js', () => {
  it('initHeader produces identical stream header/format fields', () => {
    const legacy = newLegacy();
    const ported = new AudioHeader();
    legacy.initHeader();
    ported.initHeader();
    expect(ported.streamHeader).toEqual(legacy.streamHeader);
    expect(ported.streamFormat).toEqual(legacy.streamFormat);
  });

  it('settingAAC computes identical header/format fields, including the AudioConfig bitfield', () => {
    const legacy = newLegacy();
    const ported = new AudioHeader();
    legacy.initHeader();
    ported.initHeader();
    const f = aacFrame({ audioSamplingRate: 32000, bitrate: 48000 });

    legacy.settingAAC(f);
    ported.settingAAC(f);

    expect(ported.streamHeader).toEqual(legacy.streamHeader);
    expect(ported.streamFormat).toEqual(legacy.streamFormat);
  });

  it('settingG711 computes identical header/format fields', () => {
    const legacy = newLegacy();
    const ported = new AudioHeader();
    legacy.initHeader();
    ported.initHeader();

    legacy.settingG711();
    ported.settingG711();

    expect(ported.streamHeader).toEqual(legacy.streamHeader);
    expect(ported.streamFormat).toEqual(legacy.streamFormat);
  });

  it('settingG726 computes identical fields for every known bitrate tier, including the aviSuggestedBufferSize-on-format typo', () => {
    for (const bitrate of [16000, 24000, 32000, 40000]) {
      const legacy = newLegacy();
      const ported = new AudioHeader();
      legacy.initHeader();
      ported.initHeader();
      const f = aacFrame({ codectype: 'G726', bitrate });

      legacy.settingG726(f);
      ported.settingG726(f);

      expect(ported.streamHeader).toEqual(legacy.streamHeader);
      expect(ported.streamFormat).toEqual(legacy.streamFormat);
      expect(ported.streamFormat).toHaveProperty('aviSuggestedBufferSize');
    }
  });

  it('settingG726 with an unrecognized bitrate leaves rate/format fields at their prior (unset) values, identically', () => {
    const legacy = newLegacy();
    const ported = new AudioHeader();
    legacy.initHeader();
    ported.initHeader();
    const f = aacFrame({ codectype: 'G726', bitrate: 999999 });

    legacy.settingG726(f);
    ported.settingG726(f);

    expect(ported.streamHeader).toEqual(legacy.streamHeader);
    expect(ported.streamFormat).toEqual(legacy.streamFormat);
  });

  it('checkAudioFrameInfo initializes fileInfo on the first call and validates on subsequent calls, identically', () => {
    const legacy = newLegacy();
    const ported = new AudioHeader();
    legacy.initHeader();
    ported.initHeader();
    const fileInfoLegacy: AudioBackupFileInfo = { pos: 0 };
    const fileInfoPorted: AudioBackupFileInfo = { pos: 0 };
    const f = aacFrame();

    expect(ported.checkAudioFrameInfo(f, fileInfoPorted)).toBe(legacy.checkAudioFrameInfo(f, fileInfoLegacy));
    expect(fileInfoPorted).toEqual(fileInfoLegacy);

    // Same config again -> 0.
    expect(ported.checkAudioFrameInfo(f, fileInfoPorted)).toBe(legacy.checkAudioFrameInfo(f, fileInfoLegacy));

    // Codec changed -> -1.
    const changed = aacFrame({ codectype: 'G711' });
    expect(ported.checkAudioFrameInfo(changed, fileInfoPorted)).toBe(legacy.checkAudioFrameInfo(changed, fileInfoLegacy));
    expect(ported.checkAudioFrameInfo(changed, fileInfoPorted)).toBe(-1);
  });

  it('updateInfo for a sequence of AAC frames produces byte-identical buffers and identical fileInfo/streamHeader state', () => {
    const legacy = newLegacy();
    const ported = new AudioHeader();
    const fileInfoLegacy: AudioBackupFileInfo = { pos: 2048 };
    const fileInfoPorted: AudioBackupFileInfo = { pos: 2048 };

    for (let i = 0; i < 3; i++) {
      const f = aacFrame({ PESsize: 500 + i });
      const legacyResult = legacy.updateInfo(f, fileInfoLegacy);
      const portedResult = ported.updateInfo(f, fileInfoPorted);
      expect(Array.from(portedResult as Uint8Array)).toEqual(Array.from(legacyResult as Uint8Array));
    }
    expect(fileInfoPorted).toEqual(fileInfoLegacy);
    expect(ported.streamHeader).toEqual(legacy.streamHeader);
    expect(ported.aviIndexEntry).toEqual(legacy.aviIndexEntry);
  });

  it('updateInfo for a sequence of G711 frames produces byte-identical buffers (aviLength derived from getAviSampleSize)', () => {
    const legacy = newLegacy();
    const ported = new AudioHeader();
    const fileInfoLegacy: AudioBackupFileInfo = { pos: 0 };
    const fileInfoPorted: AudioBackupFileInfo = { pos: 0 };
    const f: AudioBackupFrame = { codectype: 'G711', bitrate: 64000, audioSamplingRate: 8000, PESsize: 160 };

    for (let i = 0; i < 3; i++) {
      const legacyResult = legacy.updateInfo(f, fileInfoLegacy);
      const portedResult = ported.updateInfo(f, fileInfoPorted);
      expect(Array.from(portedResult as Uint8Array)).toEqual(Array.from(legacyResult as Uint8Array));
    }
    expect(fileInfoPorted).toEqual(fileInfoLegacy);
    expect(ported.streamHeader).toEqual(legacy.streamHeader);
  });

  it('updateInfo returns null and sets an error code identically when the codec config changes mid-backup', () => {
    const legacy = newLegacy();
    const ported = new AudioHeader();
    const fileInfoLegacy: AudioBackupFileInfo = { pos: 0 };
    const fileInfoPorted: AudioBackupFileInfo = { pos: 0 };

    legacy.updateInfo(aacFrame(), fileInfoLegacy);
    ported.updateInfo(aacFrame(), fileInfoPorted);

    const legacyResult = legacy.updateInfo(aacFrame({ bitrate: 32000 }), fileInfoLegacy);
    const portedResult = ported.updateInfo(aacFrame({ bitrate: 32000 }), fileInfoPorted);

    expect(portedResult).toBeNull();
    expect(legacyResult).toBeNull();
    expect(ported.getErrorCode()).toBe(legacy.getErrorCode());
    expect(ported.getErrorCode()).toBe(-1);
  });
});
