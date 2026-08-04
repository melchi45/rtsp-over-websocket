import { AviFileWriter } from './AviFileWriter';
import type { VideoBackupFrame } from './VideoHeader';
import type { AudioBackupFrame } from './AudioHeader';

function pad2(n: number): string {
  return (n < 10 ? '0' : '') + n;
}

/**
 * Ported from backupWorker.js's `Date.prototype.YYYYMMDDHHMMSS` — legacy
 * monkey-patches the global `Date.prototype`; ported as a standalone
 * function taking an explicit `date` argument instead (same computation, no
 * global prototype pollution — this runs in a shared Worker global scope, so
 * patching a builtin here would leak into every other script sharing it).
 *
 * The original's `device`/`gmt`/`timezone` parameters are confirmed 100%
 * unused in the body — it derives the UTC offset from `date.toString()`'s
 * own embedded "GMT+HHMM" text (i.e. the *running machine's* local
 * timezone), not from any explicit timezone info the caller has — and are
 * dropped. Mutates `date` in place via setHours/setMinutes, matching legacy
 * exactly (harmless in practice since every call site passes a fresh Date).
 * `YYYYMMDDHHMMSSZ` (a second prototype patch, `return this.toISOString()`)
 * is confirmed to have zero call sites anywhere in backupWorker.js and is
 * dropped entirely.
 */
function formatYYYYMMDDHHMMSS(date: Date): string {
  const gmtRe = /GMT([-+]?\d{4})/;
  const match = gmtRe.exec(date.toString()) as RegExpExecArray;
  const tz = Number(match[1]);
  const hour = parseInt(String(tz / 100), 10);
  const min = tz % 100;
  date.setHours(date.getHours() - hour);
  date.setMinutes(date.getMinutes() - min);
  return String(date.getFullYear()) + pad2(date.getMonth() + 1) + pad2(date.getDate()) + pad2(date.getHours()) + pad2(date.getMinutes()) + pad2(date.getSeconds());
}

export interface BackupTimeInfo {
  timestamp: number | null;
  timestamp_usec: number | null;
  timezone: number | null;
}

/** `device` (legacy's first parameter) is confirmed unused in the body and dropped. */
function toDateFormat(data: BackupTimeInfo): string {
  if (typeof data.timezone !== 'undefined' && data.timezone !== null) {
    return formatYYYYMMDDHHMMSS(new Date(new Date((data.timestamp as number) * 1000 + (data.timestamp_usec as number)).valueOf() + data.timezone * 60000));
  }
  return formatYYYYMMDDHHMMSS(new Date(new Date((data.timestamp as number) * 1000 + (data.timestamp_usec as number)).valueOf()));
}

const HEADER_BYTES = 2048;
const G7XX_SAMPLING_RATE = 8000;
const AAC_SAMPLING_RATE = 16000;
const G711_BITRATE = 64000;
const AAC_BITRATE = 48000;
const KILOBYTE = 1000;
const MEGABYTE = KILOBYTE * KILOBYTE;
const MIN_DOUBLE_FIGURES = 10;
const MAX_FILESIZE_300 = 300 * 1.04858; // 300MiB
const MAX_FILESIZE_500 = 500 * 1.04858; // 500MiB
const MAX_FILESIZE_ZIP = 250 * 1.04858; // 250MiB
const MAX_BACKUP_DURATION_SEC = 5 * 60;

export interface BackupVideoFrameInfo {
  type: 'video';
  frameType: string;
  framerate: number;
  width: number;
  height: number;
  cropWidth?: number;
  cropHeight?: number;
  codectype: string;
  PESsize: number;
  timestamp?: number;
  timestamp_usec?: number;
  timezone?: number;
}

export interface BackupAudioFrameInfo {
  type: 'audio';
  codectype: string;
  bitrate: number;
  PESsize: number;
}

interface BackupFileInfo {
  pos: number;
  tailSize: number;
  width?: number;
  height?: number;
  fileSize?: number;
}

export interface BackupSendCallback {
  (type: string, data: unknown): void;
}

/**
 * Ported from the legacy player’s Worker/Backup/backupWorker (`BackupSession`)
 * — drives an AviFileWriter across incoming video/audio frames, streaming
 * out AVI body chunks via `sendMessage`, and handling max-size/duration
 * triggered file splits or session termination.
 *
 * `channelId`/`deviceType`/`gmt`/`filename` are accessors here backed by
 * real private fields (a faithful simplification: legacy declares
 * closure-scope defaults like `_deviceType = "camera"` that are actually
 * dead — its getters/setters read/write `this._deviceType` etc., a *plain
 * instance property* that is never initialized to that closure default, so
 * the "camera" default is never actually observable through the public
 * accessor. Every real call site sets these immediately after construction
 * anyway, so this is not reproduced as a bug — there's no distinct
 * "this.property" vs "closure variable" split to preserve once ported to a
 * real class field).
 */
export class BackupSession {
  private _channelId: number | undefined;
  private _deviceType: string | undefined;
  private _timezone: number | undefined;
  private _filename: string | undefined;

  private fileInfo: BackupFileInfo | null = null;
  private splitEnabled = false;
  private zipEncrypt = false;

  /**
   * Public (not private): legacy's `isPlayback` is a *module-scope* variable
   * in backupWorker.js shared between `receiveMessage` (which sets it
   * whenever any incoming message carries `playMode === 'Playback'`) and
   * every `BackupSession` instance's methods — not private per-instance
   * state. `init()` still resets it to `false` on construction, matching
   * legacy exactly; backupWorker.ts is responsible for setting it back to
   * `true` from the outside when a later message signals playback mode.
   */
  isPlayback = false;

  private videoFrame: Partial<VideoBackupFrame> & { cropWidth?: number; cropHeight?: number } = {};
  private audioFrame: Partial<AudioBackupFrame> = {};

  private createAviFile: AviFileWriter | null = null;

  private startDate: BackupTimeInfo = { timestamp: null, timestamp_usec: null, timezone: null };
  private endDate: BackupTimeInfo = { timestamp: null, timestamp_usec: null, timezone: null };

  constructor(private readonly sendMessage: BackupSendCallback, private readonly closeWorker: () => void) {
    this.fileInfo = null;
    this.init();
    this.gmt = null;
  }

  get channelId(): number | undefined {
    return this._channelId;
  }

  set channelId(v: number | undefined) {
    this._channelId = v;
  }

  get deviceType(): string | undefined {
    return this._deviceType;
  }

  set deviceType(v: string | undefined) {
    this._deviceType = v;
  }

  get filename(): string {
    if (typeof this._filename === 'undefined' || this._filename === null || this._filename === '') {
      return this.makeFileName();
    }
    return this._filename;
  }

  set filename(v: string) {
    this._filename = v;
  }

  get gmt(): number | undefined {
    return this._timezone;
  }

  set gmt(v: number | null | undefined) {
    if (typeof v !== 'undefined' && v !== null) {
      this._timezone = v;
    }
  }

  init(channelId?: number): void {
    this.isPlayback = false;
    this.createAviFile = new AviFileWriter();
    this.filename = '';
    if (channelId !== null && channelId !== undefined) {
      this.channelId = channelId;
    }
  }

  setZipEncrypt(value: boolean): void {
    this.zipEncrypt = value;
  }

  split(): void {
    this.splitEnabled = true;
  }

  private makeFileName(): string {
    let temp = `${this.videoFrame.codectype} ${this.videoFrame.width}x${this.videoFrame.height}`;
    if (typeof this.audioFrame.codectype !== 'undefined') {
      temp += ' ' + this.audioFrame.codectype;
    }
    if (this.audioFrame.codectype === 'G726') {
      temp += '_' + (this.audioFrame.bitrate as number) / KILOBYTE;
    }
    const dt = new Date();
    temp += '_' + dt.getFullYear();
    temp += (dt.getMonth() + 1 < MIN_DOUBLE_FIGURES ? '0' + (dt.getMonth() + 1) : dt.getMonth() + 1) + '';
    temp += (dt.getDate() < MIN_DOUBLE_FIGURES ? '0' + dt.getDate() : dt.getDate()) + '_';
    temp += (dt.getHours() < MIN_DOUBLE_FIGURES ? '0' + dt.getHours() : dt.getHours()) + '';
    temp += (dt.getMinutes() < MIN_DOUBLE_FIGURES ? '0' + dt.getMinutes() : dt.getMinutes()) + '';
    temp += dt.getSeconds() < MIN_DOUBLE_FIGURES ? '0' + dt.getSeconds() : dt.getSeconds();
    return temp;
  }

  private setVideoFrameInfo(data: BackupVideoFrameInfo): void {
    const isFirstFrame = typeof this.videoFrame.codectype === 'undefined';
    if (this.fileInfo === null) {
      this.fileInfo = { pos: 4, tailSize: 0 };
      this.sendMessage('backupResult', { channelId: this.channelId, errorCode: 0x0600, oldErrorCode: 0, description: 'backup', filename: this.filename });
    }

    this.videoFrame.framerate = data.framerate * 1;
    this.videoFrame.width = this.fileInfo.width = data.width * 1;
    this.videoFrame.height = this.fileInfo.height = data.height * 1;
    this.videoFrame.cropWidth = data.cropWidth;
    this.videoFrame.cropHeight = data.cropHeight;
    this.videoFrame.frameType = data.frameType;
    if (data.codectype === 'MJPEG') {
      this.videoFrame.codectype = 'MJPG';
    } else if (data.codectype === 'H264') {
      this.videoFrame.codectype = 'H264';
    } else if (data.codectype === 'H265') {
      this.videoFrame.codectype = 'HEVC';
    }
    this.videoFrame.PESsize = data.PESsize;
    this.videoFrame.sourceInputMs = (data.timestamp as number) * 1;

    if (typeof data.timestamp !== 'undefined' && typeof data.timestamp_usec !== 'undefined' && data.timestamp !== null && data.timestamp_usec !== null) {
      this.videoFrame.sourceInputMs *= 1000;
      this.videoFrame.sourceInputMs += Math.floor(data.timestamp_usec);
      this.videoFrame.sourceInputMs = Math.floor(this.videoFrame.sourceInputMs / 10) * 10;

      if (this.startDate.timestamp === null && this.startDate.timestamp_usec === null && this.startDate.timezone === null) {
        this.startDate.timestamp = data.timestamp;
        this.startDate.timestamp_usec = data.timestamp_usec;
        this.startDate.timezone = typeof data.timezone !== 'undefined' && data.timezone !== null ? data.timezone : typeof this.gmt !== 'undefined' && this.gmt !== null ? this.gmt * 60 : null;
      }

      this.endDate.timestamp = data.timestamp;
      this.endDate.timestamp_usec = data.timestamp_usec;
      this.endDate.timezone = typeof data.timezone !== 'undefined' && data.timezone !== null ? data.timezone : typeof this.gmt !== 'undefined' && this.gmt !== null ? this.gmt * 60 : null;

      this.sendMessage('timestamp', {
        channelId: this.channelId,
        errorCode: 0x0603,
        description: 'timestamp of backup',
        timeStamp: { timestamp: data.timestamp, timestamp_usec: data.timestamp_usec, timezone: data.timezone }
      });
    }

    if (isFirstFrame) {
      this.createAviFile!.initHeader('video', this.videoFrame as VideoBackupFrame);
    }
  }

  private setAudioFrameInfo(data: BackupAudioFrameInfo): void {
    const isFirstFrame = typeof this.audioFrame.codectype === 'undefined';
    this.audioFrame.codectype = data.codectype;
    if (data.codectype === 'G711') {
      this.audioFrame.audioSamplingRate = G7XX_SAMPLING_RATE;
      this.audioFrame.bitrate = G711_BITRATE;
    } else if (data.codectype === 'AAC') {
      this.audioFrame.audioSamplingRate = AAC_SAMPLING_RATE;
      this.audioFrame.bitrate = AAC_BITRATE;
    } else if (data.codectype === 'G726') {
      this.audioFrame.bitrate = data.bitrate * KILOBYTE;
      this.audioFrame.audioSamplingRate = G7XX_SAMPLING_RATE;
    }
    this.audioFrame.PESsize = data.PESsize;
    if (this.fileInfo === null) {
      this.fileInfo = { pos: 4, tailSize: 0 };
      this.sendMessage('backupResult', { channelId: this.channelId, errorCode: 0x0600, oldErrorCode: 0, description: 'backup', filename: this.filename });
    }
    if (isFirstFrame) {
      this.createAviFile!.initHeader('audio', undefined as unknown as VideoBackupFrame);
    }
  }

  private checkMaxSize(): boolean {
    const maxFilesize = this.zipEncrypt ? MAX_FILESIZE_ZIP : this.splitEnabled ? MAX_FILESIZE_300 : MAX_FILESIZE_500;
    const fileInfo = this.fileInfo as BackupFileInfo;
    if ((HEADER_BYTES + fileInfo.pos + fileInfo.tailSize + 4) / MEGABYTE > maxFilesize) {
      if (this.splitEnabled) {
        this.fileSplit();
      } else {
        this.writeAviHeader();
        this.writeAviTail();
        this.sendMessage('backupResult', {
          channelId: this.channelId,
          errorCode: 0x0608,
          oldErrorCode: -4,
          from: this.startDate,
          to: this.endDate,
          data: this.filename,
          description: 'backup'
        });
        this.endSession();
      }
      return true;
    }
    return false;
  }

  private fileSplit(): void {
    this.writeAviHeader();
    this.writeAviTail();
    const strStart = toDateFormat(this.startDate);
    const strEnd = toDateFormat(this.endDate);
    this.sendMessage('backup', { target: 'save', from: this.startDate, to: this.endDate, data: this.filename + ' ' + strStart + '-' + strEnd });
    this.sendMessage('backupResult', {
      channelId: this.channelId,
      errorCode: 0x0607,
      from: this.startDate,
      to: this.endDate,
      data: this.filename + ' ' + strStart + '-' + strEnd
    });
    this.fileInfo = null;
    this.videoFrame = {};
    this.startDate = { timestamp: null, timestamp_usec: null, timezone: null };
  }

  onVideoData(frameInfo: BackupVideoFrameInfo, streamData: Uint8Array): void {
    if (this.createAviFile === null) {
      return;
    }
    let needToAddDummy = false;
    if (this.fileInfo === null && frameInfo.frameType !== 'I') {
      return;
    }

    this.setVideoFrameInfo(frameInfo);
    if (this.checkMaxSize() === false) {
      let header = this.createAviFile.updateInfo(frameInfo.type, this.videoFrame as VideoBackupFrame, this.fileInfo as BackupFileInfo);
      if (header === null) {
        const errorCode = this.createAviFile.getErrorCode(frameInfo.type);
        if (errorCode < 0) {
          // The video would be split when resolution or codec does not
          // match the previous frame data.
          if (this.splitEnabled) {
            this.fileSplit();
            // If frame type is an I-frame, the backup file will be re-generated.
            if (frameInfo.frameType === 'I') {
              this.setVideoFrameInfo(frameInfo);
              if (this.checkMaxSize() === false) {
                header = this.createAviFile.updateInfo(frameInfo.type, this.videoFrame as VideoBackupFrame, this.fileInfo as BackupFileInfo);
                if (header === null) {
                  const retryErrorCode = this.createAviFile.getErrorCode(frameInfo.type);
                  if (retryErrorCode < 0) {
                    // eslint-disable-next-line no-console
                    console.error('Error. The Frame information is not correct.');
                  }
                }
              } else {
                return;
              }
            }
          } else {
            this.sendMessage('backupResult', {
              channelId: this.channelId,
              errorCode: errorCode === -1 ? 0x060b : 0x060a,
              oldErrorCode: errorCode,
              description: 'backup',
              filename: this.filename
            });
            this.endSession();
            return;
          }
        }
      }
      if (streamData.length < (this.createAviFile.getChunkPayloadSize(frameInfo.type) as number)) {
        needToAddDummy = true;
      }
      if (this.createAviFile === null) {
        return;
      }
      const videoIdxBuffer = this.createAviFile.getIdxBuffer(frameInfo.type);
      this.sendMessage('backup', { target: 'tailBody', data: videoIdxBuffer });
      (this.fileInfo as BackupFileInfo).tailSize += videoIdxBuffer.length;

      this.sendMessage('backup', { target: 'body', data: header });
      this.sendMessage('backup', { target: 'body', data: streamData });
      if (needToAddDummy) {
        this.sendMessage('backup', { target: 'body', data: new Uint8Array(1) });
      }
    } else {
      return;
    }

    if (!this.splitEnabled) {
      if (!this.isPlayback && this.createAviFile.getDuration() >= MAX_BACKUP_DURATION_SEC) {
        this.sendMessage('backupResult', {
          channelId: this.channelId,
          errorCode: 0x0601,
          oldErrorCode: 1,
          from: this.startDate,
          to: this.endDate,
          description: 'backup',
          filename: this.filename
        });
        this.endSession();
        return;
      }
    }
  }

  onAudioData(frameInfo: BackupAudioFrameInfo, streamData: Uint8Array): void {
    if (this.createAviFile === null) {
      return;
    }
    if (this.fileInfo === null) {
      return;
    }
    this.setAudioFrameInfo(frameInfo);
    const header = this.createAviFile.updateInfo(frameInfo.type, this.audioFrame as AudioBackupFrame, this.fileInfo);
    if (header === null) {
      const errorCode = this.createAviFile.getErrorCode(frameInfo.type);
      if (errorCode < 0) {
        if (this.splitEnabled) {
          this.fileSplit();
          return;
        }
        this.sendMessage('backupResult', { errorCode: errorCode === -1 ? 0x060b : 0x060a, oldErrorCode: errorCode, description: 'backup', filename: this.filename });
        this.endSession();
        return;
      }
    }
    if (this.checkMaxSize() === false) {
      if (this.createAviFile === null) {
        return;
      }
      const audioIdxBuffer = this.createAviFile.getIdxBuffer(frameInfo.type);
      this.sendMessage('backup', { target: 'tailBody', data: audioIdxBuffer });
      this.fileInfo.tailSize += audioIdxBuffer.length;

      this.sendMessage('backup', { target: 'body', data: header });
      this.sendMessage('backup', { target: 'body', data: streamData });
      if (frameInfo.codectype === 'AAC' && streamData.length < (this.createAviFile.getChunkPayloadSize(frameInfo.type) as number)) {
        this.sendMessage('backup', { target: 'body', data: new Uint8Array(1) });
      }
    } else {
      return;
    }

    if (!this.splitEnabled) {
      if (!this.isPlayback && this.createAviFile.getDuration() >= MAX_BACKUP_DURATION_SEC) {
        this.sendMessage('backupResult', {
          channelId: this.channelId,
          errorCode: 0x0601,
          oldErrorCode: 1,
          from: this.startDate,
          to: this.endDate,
          description: 'backup',
          filename: this.filename
        });
        this.endSession();
        return;
      }
    }
  }

  private writeAviHeader(): void {
    const fileInfo = this.fileInfo as BackupFileInfo;
    const idxlen = 8 + fileInfo.tailSize;
    fileInfo.fileSize = HEADER_BYTES + fileInfo.pos - 4 + idxlen;
    const aviHeader = (this.createAviFile as AviFileWriter).makeAviHeader(fileInfo.fileSize, fileInfo.pos);
    this.sendMessage('backup', { target: 'mainHeader', data: aviHeader });
  }

  private writeAviTail(): void {
    const fileInfo = this.fileInfo as BackupFileInfo;
    const tailHeader = (this.createAviFile as AviFileWriter).makeAviTail(fileInfo.tailSize);
    this.sendMessage('backup', { target: 'tailHeader', data: tailHeader });
  }

  endSession(): void {
    if (this.createAviFile === null) {
      return;
    }
    if (this.fileInfo === null) {
      this.sendMessage('backupResult', { channelId: this.channelId, errorCode: 0x0604, oldErrorCode: -3, description: 'backup', filename: this.filename });
      return;
    }
    this.writeAviHeader();
    this.writeAviTail();
    const strStart = toDateFormat(this.startDate);
    const strEnd = toDateFormat(this.endDate);

    if (this.splitEnabled) {
      this.sendMessage('backup', { target: 'save', from: this.startDate, to: this.endDate, data: this.filename + ' ' + strStart + '-' + strEnd });
    } else {
      this.sendMessage('backup', { target: 'save', from: this.startDate, to: strEnd, data: this.filename });
    }

    if (this.createAviFile.getErrorCode('video') === 0 && this.createAviFile.getErrorCode('audio') === 0) {
      this.sendMessage('backupResult', {
        channelId: this.channelId,
        errorCode: 0x0601,
        oldErrorCode: 1,
        from: this.startDate,
        to: this.endDate,
        description: 'backup',
        filename: this.splitEnabled ? this.filename + ' ' + strStart + '-' + strEnd : this.filename
      });
    }
    this.closeWorker();
    this.fileInfo = null;
    this.createAviFile = null;
  }
}
