import { describe, it, expect, vi } from 'vitest';
import { loadLegacyModule, loadLegacyModuleSlice, type LegacySandbox } from '../../test-support/loadLegacyModule';
import { BackupSession, type BackupVideoFrameInfo, type BackupAudioFrameInfo, type BackupSendCallback } from './BackupSession';

interface LegacyBackupSession {
  channelId: number | undefined;
  deviceType: string | undefined;
  filename: string;
  gmt: number | null | undefined;
  init(channelId?: number): void;
  setZipEncrypt(value: boolean): void;
  split(): void;
  onVideoData(frameInfo: BackupVideoFrameInfo, streamData: Uint8Array): void;
  onAudioData(frameInfo: BackupAudioFrameInfo, streamData: Uint8Array): void;
  endSession(): void;
}

/**
 * backupWorker.js's top level permanently patches the *real* `Date.prototype`
 * with a non-configurable `YYYYMMDDHHMMSS` property (and loadLegacyModule.ts
 * deliberately shares the host realm's Date with every vm context, so
 * Date.now()/`new Date()` mocking works elsewhere) — loading those lines
 * more than once would throw "Cannot redefine property" on the second
 * attempt. `loadLegacyModuleSlice` here deliberately excludes lines 1-125
 * (the importScripts/Date.prototype-patch/inheritObject preamble this test
 * doesn't need) and instead installs the *exact same* YYYYMMDDHHMMSS body
 * once, up front, with `configurable: true` so repeated test runs are safe —
 * this changes nothing about what the function computes, only where/how
 * many times the (identical) Object.defineProperty call happens.
 */
if (!Object.getOwnPropertyDescriptor(Date.prototype, 'YYYYMMDDHHMMSS')?.value) {
  Object.defineProperty(Date.prototype, 'YYYYMMDDHHMMSS', {
    configurable: true,
    value: function (this: Date) {
      function pad2(n: number): string {
        return (n < 10 ? '0' : '') + n;
      }
      const gmtRe = /GMT([-+]?\d{4})/;
      const tz = (gmtRe.exec(this.toString()) as RegExpExecArray)[1];
      const hour = parseInt(String(Number(tz) / 100), 10);
      const min = Number(tz) % 100;
      this.setHours(this.getHours() - hour);
      this.setMinutes(this.getMinutes() - min);
      return this.getFullYear() + pad2(this.getMonth() + 1) + pad2(this.getDate()) + pad2(this.getHours()) + pad2(this.getMinutes()) + pad2(this.getSeconds());
    }
  });
}

const legacyInheritObject = (baseObj: Record<string, unknown>, props: Record<string, unknown>): Record<string, unknown> => Object.assign(baseObj, props);

function loadLegacyBackupSession(postMessage: (event: unknown) => void): new () => LegacyBackupSession {
  const AviFormatWriter = loadLegacyModule('Worker/Backup/avi_format_writer.js', 'AviFormatWriter');
  const formatWriterSandbox: LegacySandbox = { inheritObject: legacyInheritObject, AviFormatWriter };
  const VideoHeader = loadLegacyModule('Worker/Backup/videoBackup.js', 'VideoHeader', formatWriterSandbox);
  const AudioHeader = loadLegacyModule('Worker/Backup/audioBackup.js', 'AudioHeader', formatWriterSandbox);
  const AviFileWriter = loadLegacyModule('Worker/Backup/avi_file_writer.js', 'AviFileWriter', {
    inheritObject: legacyInheritObject,
    AviFormatWriter,
    VideoHeader,
    AudioHeader
  });

  const base: LegacySandbox = { AviFileWriter, postMessage, close: () => {} };
  return loadLegacyModuleSlice<{ BackupSession: new () => LegacyBackupSession }>(
    'Worker/Backup/backupWorker.js',
    [
      [12, 14],
      [45, 51],
      [114, 120],
      [126, 861]
    ],
    ['BackupSession'],
    base
  ).BackupSession;
}

function newLegacy(postMessage: (event: unknown) => void = () => {}): LegacyBackupSession {
  const Ctor = loadLegacyBackupSession(postMessage);
  return new Ctor();
}

function newPorted(sendMessage: BackupSendCallback = vi.fn(), closeWorker: () => void = vi.fn()): BackupSession {
  return new BackupSession(sendMessage, closeWorker);
}

function videoFrame(overrides: Partial<BackupVideoFrameInfo> = {}): BackupVideoFrameInfo {
  return { type: 'video', frameType: 'I', framerate: 30, width: 640, height: 480, codectype: 'H264', PESsize: 4001, timestamp: 1000, timestamp_usec: 0, timezone: 0, ...overrides };
}

function audioFrame(overrides: Partial<BackupAudioFrameInfo> = {}): BackupAudioFrameInfo {
  return { type: 'audio', codectype: 'AAC', bitrate: 48000, PESsize: 501, ...overrides };
}

/**
 * Deep-clones a value, converting anything that looks like a typed array
 * (`ArrayBuffer.isView`) into a plain array. The legacy side's Uint8Array
 * instances are created inside an isolated vm context, so they are not
 * `instanceof` this (host) realm's `Uint8Array` — `toEqual` would otherwise
 * report a spurious mismatch between structurally-identical byte buffers.
 */
function normalize(value: unknown): unknown {
  if (ArrayBuffer.isView(value)) {
    return Array.from(value as unknown as ArrayLike<number>);
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalize(v)]));
  }
  return value;
}

describe('BackupSession parity with the legacy player’s Worker/Backup/backupWorker.js', () => {
  it('channelId/deviceType round-trip, filename falls back to an auto-generated name, gmt ignores null', () => {
    const legacy = newLegacy();
    const ported = newPorted();

    legacy.channelId = 5;
    ported.channelId = 5;
    expect(ported.channelId).toBe(legacy.channelId);

    legacy.deviceType = 'nvr';
    ported.deviceType = 'nvr';
    expect(ported.deviceType).toBe(legacy.deviceType);

    legacy.gmt = null;
    ported.gmt = null;
    expect(ported.gmt).toBe(legacy.gmt);

    legacy.gmt = 9;
    ported.gmt = 9;
    expect(ported.gmt).toBe(legacy.gmt);
    expect(ported.gmt).toBe(9);
  });

  it('onVideoData on the first I-frame sends an identical sequence of messages (backupResult 0x0600, timestamp, backup/body)', () => {
    const legacyMessages: unknown[] = [];
    const portedMessages: unknown[] = [];
    const legacy = newLegacy((event) => legacyMessages.push(event));
    legacy.channelId = 1;
    const ported = newPorted((type, data) => portedMessages.push({ type, data }));
    ported.channelId = 1;

    const f = videoFrame();
    const stream = new Uint8Array(f.PESsize);

    legacy.onVideoData(f, stream);
    ported.onVideoData(f, stream);

    expect(normalize(portedMessages)).toEqual(normalize(legacyMessages));
  });

  it('onVideoData/onAudioData interleaved produce an identical message sequence', () => {
    const legacyMessages: unknown[] = [];
    const portedMessages: unknown[] = [];
    const legacy = newLegacy((event) => legacyMessages.push(event));
    legacy.channelId = 2;
    const ported = newPorted((type, data) => portedMessages.push({ type, data }));
    ported.channelId = 2;

    const vf = videoFrame();
    const af = audioFrame();

    legacy.onVideoData(vf, new Uint8Array(vf.PESsize));
    ported.onVideoData(vf, new Uint8Array(vf.PESsize));
    legacy.onAudioData(af, new Uint8Array(af.PESsize));
    ported.onAudioData(af, new Uint8Array(af.PESsize));
    legacy.onVideoData(videoFrame({ frameType: 'P' }), new Uint8Array(vf.PESsize));
    ported.onVideoData(videoFrame({ frameType: 'P' }), new Uint8Array(vf.PESsize));

    expect(normalize(portedMessages)).toEqual(normalize(legacyMessages));
  });

  it('endSession with no fileInfo sends backupResult(0x0604) identically and does not throw', () => {
    const legacyMessages: unknown[] = [];
    const portedMessages: unknown[] = [];
    const legacy = newLegacy((event) => legacyMessages.push(event));
    legacy.channelId = 3;
    const ported = newPorted((type, data) => portedMessages.push({ type, data }));
    ported.channelId = 3;

    expect(() => legacy.endSession()).not.toThrow();
    expect(() => ported.endSession()).not.toThrow();
    expect(normalize(portedMessages)).toEqual(normalize(legacyMessages));
  });

  it('a full video+audio+endSession sequence produces an identical message sequence, including the final "save"', () => {
    const legacyMessages: unknown[] = [];
    const portedMessages: unknown[] = [];
    const legacy = newLegacy((event) => legacyMessages.push(event));
    legacy.channelId = 4;
    const ported = newPorted((type, data) => portedMessages.push({ type, data }));
    ported.channelId = 4;

    const vf = videoFrame();
    const af = audioFrame();
    for (const session of [legacy, ported]) {
      session.onVideoData(vf, new Uint8Array(vf.PESsize));
      session.onAudioData(af, new Uint8Array(af.PESsize));
      session.endSession();
    }

    expect(normalize(portedMessages)).toEqual(normalize(legacyMessages));
    expect(portedMessages.some((m) => (m as { type: string }).type === 'backup' && (m as { data: { target: string } }).data.target === 'save')).toBe(true);
  });

  it('split() + a codec change on a non-I frame throws identically (legacy: fileSplit() nulls fileInfo, then the non-I-frame path unconditionally reads fileInfo.tailSize)', () => {
    // Only an I-frame re-generates the backup file after a mid-stream
    // fileSplit(); a P-frame falls through to code that assumes fileInfo is
    // still set, crashing. A real, faithfully-reproduced legacy bug — not
    // "fixed" here — since AviFileWriter always changes state before
    // returning null, so this is reachable whenever split() is enabled.
    const legacy = newLegacy();
    legacy.channelId = 6;
    legacy.split();
    const ported = newPorted();
    ported.channelId = 6;
    ported.split();

    const vf = videoFrame({ codectype: 'H264' });
    const changed = videoFrame({ codectype: 'H265', frameType: 'P' });

    legacy.onVideoData(vf, new Uint8Array(vf.PESsize));
    ported.onVideoData(vf, new Uint8Array(vf.PESsize));

    let legacyMessage = '';
    try {
      legacy.onVideoData(changed, new Uint8Array(changed.PESsize));
    } catch (error) {
      legacyMessage = (error as Error).message;
    }

    expect(legacyMessage).toContain('tailSize');
    expect(() => ported.onVideoData(changed, new Uint8Array(changed.PESsize))).toThrow(legacyMessage);
  });
});
