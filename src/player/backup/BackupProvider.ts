import { FileMaker } from './FileMaker';
import type { VideoStreamData, VideoInfo, AudioStreamData, AudioInfo } from '../mediaSession';

export type BackupWorkerFactory = () => Worker;

const MAX_FPS = 200;

const BACKUP_STATUS = {
  WAIT: 0,
  PROCESSING: 1,
  DONE: 2
} as const;

export interface BackupInitData {
  callback: (data: unknown) => void;
  timestamp?: (data: unknown) => void;
  password?: string | null;
  fileName?: string;
  split?: unknown;
  gmt?: unknown;
}

// Shared across *every* BackupProvider instance, matching legacy's
// module-level `var fileMaker = null;` (declared outside the BackupProvider
// factory function, unlike the rest of its state which is per-instance) —
// only ever constructed once, on whichever channel starts a backup first.
let sharedFileMaker: FileMaker | null = null;

/**
 * Ported from the legacy player’s Backup/backupProvider.js.
 * `backupWorkerMessage` is assigned directly as `backupWorker.onmessage =
 * this.backupWorkerMessage` in legacy (an unbound reference) — but its body
 * only reads closure state (fileMaker/callback/timestamp_callback), never
 * `this`, so the detachment has no observable effect (same class of
 * "harmless because it never used `this` anyway" pattern documented in
 * CanvasTagPlayer.ts). Written here as a normal bound method.
 */
export class BackupProvider {
  channelId = 0;
  deviceType: string | undefined;

  private backupStatus: (typeof BACKUP_STATUS)[keyof typeof BACKUP_STATUS] = BACKUP_STATUS.WAIT;
  private backupWorker: Worker | null = null;
  private callback: ((data: unknown) => void) | null = null;
  private timestampCallback: ((data: unknown) => void) | null = null;

  constructor(
    private readonly backupWorkerFactory: BackupWorkerFactory = () => new Worker(new URL('../worker/backup/backupWorker.ts', import.meta.url))
  ) {}

  private readonly compressCallback = (errorCode: number): void => {
    (this.callback as (data: unknown) => void)({
      channelId: this.channelId,
      description: 'backup',
      errorCode
    });
  };

  init(data: BackupInitData): void {
    this.backupStatus = BACKUP_STATUS.WAIT;
    this.backupWorker = this.backupWorkerFactory();
    this.backupWorker.onmessage = (event: MessageEvent) => this.backupWorkerMessage(event);
    this.callback = data.callback;
    this.timestampCallback = data.timestamp ?? null;
    if (sharedFileMaker === null) {
      sharedFileMaker = new FileMaker();
    }
    sharedFileMaker.setPassword(data.password ?? null);
    sharedFileMaker.setCompressCallback(this.compressCallback);

    const message = {
      type: 'start',
      data: {
        channelId: this.channelId,
        fileName: typeof data.fileName === 'undefined' ? '' : data.fileName,
        deviceType: this.deviceType,
        password: data.password,
        split: data.split,
        gmt: data.gmt
      }
    };
    this.backupWorker.postMessage(message);
  }

  onVideoData(streamData: VideoStreamData, videoInfo: VideoInfo): void {
    if (this.backupStatus === BACKUP_STATUS.WAIT) {
      this.backupStatus = BACKUP_STATUS.PROCESSING;
    }
    if (this.backupStatus === BACKUP_STATUS.PROCESSING) {
      const frameInfo = {
        type: 'video',
        channelId: (streamData as unknown as { channelId?: number }).channelId,
        frameType: videoInfo.frameType,
        codectype: streamData.codecType,
        PESsize: streamData.frameData.length,
        framerate: typeof streamData.timeStamp.timestamp_usec !== 'undefined' ? MAX_FPS : videoInfo.framerate,
        timestamp: streamData.timeStamp.timestamp === null ? (streamData.timeStamp as unknown as { rtpTimestamp?: unknown }).rtpTimestamp : streamData.timeStamp.timestamp,
        timestamp_usec: streamData.timeStamp.timestamp_usec,
        timezone: streamData.timeStamp.timezone,
        width: videoInfo.width,
        height: videoInfo.height,
        cropWidth: videoInfo.cropWidth,
        cropHeight: videoInfo.cropHeight
      };
      const message = {
        type: 'sendVideoFrame',
        playMode: videoInfo.playMode,
        data: {
          frameInfo,
          streamData: streamData.frameData
        }
      };
      (this.backupWorker as Worker).postMessage(message);
    }
  }

  receiveAudioData(streamData: AudioStreamData, audioInfo: AudioInfo): void {
    if (this.backupStatus === BACKUP_STATUS.PROCESSING && this.backupWorker !== null) {
      const frameInfo = {
        type: 'audio',
        channelId: streamData.channelId,
        bitrate: audioInfo.bitrate,
        codectype: streamData.codecType,
        PESsize: streamData.frameData.length
      };
      const message = {
        type: 'sendAudioFrame',
        data: {
          frameInfo,
          streamData: streamData.frameData
        }
      };
      this.backupWorker.postMessage(message);
    }
  }

  closeStream(): void {
    if (this.backupWorker !== null) {
      const endMessage = { type: 'stop' };
      this.backupWorker.postMessage(endMessage);
      this.backupStatus = BACKUP_STATUS.WAIT;
    }
  }

  private backupWorkerMessage(event: MessageEvent): void {
    const message = event.data as { type: string; data: unknown };
    switch (message.type) {
      case 'backup':
        if (sharedFileMaker !== null) {
          const backupData = message.data as { target: string; data: unknown };
          sharedFileMaker.processMessage(backupData.target, backupData.data);
        }
        break;
      case 'backupResult':
        if (typeof this.callback !== 'undefined' && this.callback !== null) {
          this.callback(message.data);
        }
        break;
      case 'timestamp':
        if (typeof this.timestampCallback !== 'undefined' && this.timestampCallback !== null) {
          this.timestampCallback(message.data);
        }
        break;
      case 'terminate':
        break;
    }
  }
}
