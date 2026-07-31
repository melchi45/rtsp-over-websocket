import { BackupSession, type BackupVideoFrameInfo, type BackupAudioFrameInfo } from './BackupSession';

export interface BackupStartData {
  channelId: number;
  deviceType: string;
  gmt?: number | null;
  fileName?: string;
  password?: string;
  split?: boolean;
}

export type BackupWorkerMessage =
  | { type: 'start'; playMode?: string; data: BackupStartData }
  | { type: 'sendVideoFrame'; playMode?: string; data: { frameInfo: BackupVideoFrameInfo; streamData: Uint8Array } }
  | { type: 'sendAudioFrame'; playMode?: string; data: { frameInfo: BackupAudioFrameInfo; streamData: Uint8Array } }
  | { type: 'stop'; playMode?: string };

// Narrow local ambient typing for the classic Worker global scope this file
// touches — see mjpegDepacketizeWorker.ts for why the full `webworker` lib
// isn't used project-wide.
declare function addEventListener(type: 'message', listener: (event: MessageEvent<BackupWorkerMessage>) => void, useCapture: boolean): void;
declare function postMessage(message: unknown): void;
declare function close(): void;

/**
 * Ported from the legacy player’s Worker/Backup/backupWorker.js — the Worker entry
 * that owns one BackupSession, streaming AVI body chunks back to
 * BackupProvider.ts as video/audio frames arrive.
 *
 * Legacy's `isPlayback` is a *module-scope* variable shared between this
 * `receiveMessage` function and the current `BackupSession` instance's own
 * methods (see BackupSession.ts's `isPlayback` field doc comment) — set
 * whenever any incoming message carries `playMode === 'Playback'`, on
 * *every* message type (not just 'start'), and never reset back to `false`
 * from here (only `BackupSession.init()` — i.e. a new 'start' — resets it).
 * Setting it while no session exists yet is a legacy no-op (the next 'start'
 * always resets to `false` on construction anyway), so it's only forwarded
 * when a session is already active.
 */
let backupSession: BackupSession | null = null;

function receiveMessage(event: MessageEvent<BackupWorkerMessage>): void {
  const message = event.data;

  if (message.playMode === 'Playback' && backupSession !== null) {
    backupSession.isPlayback = true;
  }

  switch (message.type) {
    case 'start': {
      backupSession = new BackupSession(
        (type, data) => postMessage({ type, data }),
        () => close()
      );
      backupSession.channelId = message.data.channelId;
      backupSession.deviceType = message.data.deviceType;
      backupSession.gmt = message.data.gmt;
      backupSession.filename = message.data.fileName as string;
      backupSession.setZipEncrypt(!!message.data.password);
      // enable split function for backup
      if (message.data.split) {
        backupSession.split();
      }
      break;
    }
    case 'sendVideoFrame':
      backupSession!.onVideoData(message.data.frameInfo, message.data.streamData);
      break;
    case 'sendAudioFrame':
      backupSession!.onAudioData(message.data.frameInfo, message.data.streamData);
      break;
    case 'stop':
      backupSession!.endSession();
      backupSession = null;
      close();
      break;
    default:
      break;
  }
}

addEventListener('message', receiveMessage, false);
