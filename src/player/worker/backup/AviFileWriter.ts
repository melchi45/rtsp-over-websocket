import { AviFormatWriter } from './AviFormatWriter';
import { VideoHeader, type VideoBackupFrame, type VideoBackupFileInfo } from './VideoHeader';
import { AudioHeader, type AudioBackupFrame, type AudioBackupFileInfo } from './AudioHeader';

/**
 * Ported from the legacy player’s Worker/Backup/avi_file_writer — the top-level
 * AVI writer backupWorker.ts drives directly, delegating per-stream-type
 * (video/audio) work to a VideoHeader/AudioHeader pair.
 *
 * Legacy builds this via `inheritObject(new AviFormatWriter(), {...})`,
 * which is really object composition (copy the override methods onto a
 * fresh AviFormatWriter instance) rather than classical inheritance — several
 * of the overrides here (`getErrorCode`, `getChunkPayloadSize`) take a
 * `type` parameter the base AviFormatWriter method doesn't have, which a
 * real `extends` relationship can't type-check safely. This is ported as
 * composition (a private `AviFormatWriter` instance, forwarded explicitly)
 * to match what `inheritObject` actually does, not as a subclass.
 */
export class AviFileWriter {
  private readonly writer = new AviFormatWriter();
  private readonly createVideoHeader = new VideoHeader();
  private readonly createAudioHeader = new AudioHeader();

  initHeader(type: 'video' | 'audio', frameInfo: VideoBackupFrame): void {
    if (type === 'video') {
      this.writer.initMainHeader(frameInfo);
      this.createVideoHeader.initHeader(frameInfo);
      this.createAudioHeader.initHeader();
    } else {
      this.createAudioHeader.initHeader();
    }
  }

  updateInfo(type: 'video' | 'audio', frameInfo: VideoBackupFrame | AudioBackupFrame, fileInfo: VideoBackupFileInfo | AudioBackupFileInfo): Uint8Array | null {
    if (type === 'video') {
      return this.createVideoHeader.updateInfo(frameInfo as VideoBackupFrame, fileInfo as VideoBackupFileInfo);
    }
    return this.createAudioHeader.updateInfo(frameInfo as AudioBackupFrame, fileInfo as AudioBackupFileInfo);
  }

  getErrorCode(type: 'video' | 'audio'): number {
    if (type === 'video') {
      return this.createVideoHeader.getErrorCode();
    }
    return this.createAudioHeader.getErrorCode();
  }

  getChunkPayloadSize(type: 'video' | 'audio'): number | undefined {
    if (type === 'video') {
      return this.createVideoHeader.getChunkPayloadSize();
    }
    return this.createAudioHeader.getChunkPayloadSize();
  }

  getIdxBuffer(type: 'video' | 'audio'): Uint8Array {
    if (type === 'video') {
      return this.createVideoHeader.getIndexBuffer();
    }
    return this.createAudioHeader.getIndexBuffer();
  }

  getDuration(): number {
    return this.createVideoHeader.getDuration();
  }

  makeAviHeader(fileSize: number, filePos: number): Uint8Array {
    const mainHeader = this.writer.getMainHeader();
    mainHeader.aviTotalFrames = this.createVideoHeader.getTotalFrames();
    this.writer.setMainHeader(mainHeader);
    this.writer.writeAviMainHeader(fileSize);
    this.writer.appendBuffer(this.createVideoHeader.getVideoHeader());
    this.writer.appendBuffer(this.createAudioHeader.getAudioHeader());
    return this.writer.writeJunk(filePos);
  }

  makeAviTail(tailSize: number): Uint8Array {
    return this.writer.writeAviTailHeader(tailSize);
  }

  setResolution(width: number, height: number, fps: number): void {
    this.createVideoHeader.setResolution(width, height, fps);
  }
}
