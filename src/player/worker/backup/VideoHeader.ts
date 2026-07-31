import { AviFormatWriter } from './AviFormatWriter';

const SIZE_OF_CHUNK_HEADER = 8;
const SEC_TO_MS = 1000;
const DUMMY_COUNT_RESET_THRESHOLD = 200 + 10;

export interface VideoBackupFrame {
  codectype: string;
  width: number;
  height: number;
  framerate: number;
  frameType: string;
  PESsize: number;
  sourceInputMs: number;
}

export interface VideoBackupFileInfo {
  video_init?: boolean;
  last_ms?: number;
  frameCount?: number;
  pos: number;
}

/**
 * Ported from the legacy player’s Worker/Backup/videoBackup.js (`VideoHeader`) —
 * builds the AVI video stream header/format and tracks per-frame index
 * entries (including the "dummy frame" padding used to keep variable frame
 * rate video in sync with a constant-rate AVI timeline).
 */
export class VideoHeader extends AviFormatWriter {
  initHeader(videoFrame: VideoBackupFrame): void {
    this.setStreamHeader({
      aviFourCC: 'strh',
      aviBytesCount: 56,
      aviType: 'vids',
      aviHandler: videoFrame.codectype,
      aviFlags: 0,
      aviSuggestedBufferSize: Math.floor((videoFrame.width * videoFrame.height) / 2),
      aviRight: videoFrame.width,
      aviBottom: videoFrame.height,
      aviScale: SEC_TO_MS,
      aviRate: SEC_TO_MS * videoFrame.framerate,
      aviQuality: -1,
      aviSampleSize: 0
    });

    this.setStreamFormat({
      FourCC: 'strf',
      BytesCount: 40,
      Size: 40,
      Width: videoFrame.width,
      Height: videoFrame.height,
      Planes: 1,
      BitCount: 24,
      SizeImage: videoFrame.width * videoFrame.height * videoFrame.framerate,
      Compression: videoFrame.codectype
    });
  }

  override updateInfo(videoFrame: VideoBackupFrame, fileInfo: VideoBackupFileInfo): Uint8Array | null {
    const videoHeader = this.getStreamHeader();
    if (typeof videoHeader.last_ms === 'undefined') {
      videoHeader.last_ms = 0;
    }
    const aviIndexEntry = this.getIndexEntry();
    let size = videoFrame.PESsize;
    if (size % 2 !== 0) {
      size += 1;
    }

    aviIndexEntry.flag = videoFrame.frameType === 'I' ? 0x10 : 0x00;
    aviIndexEntry.chid = '00dc';

    const rate = Number((SEC_TO_MS / videoFrame.framerate).toFixed(1));

    if (typeof fileInfo.video_init === 'undefined' || fileInfo.video_init === false) {
      this.initHeader(videoFrame);
      videoHeader.width = videoFrame.width;
      videoHeader.height = videoFrame.height;
      videoHeader.compressor = videoFrame.codectype;
      fileInfo.last_ms = videoFrame.sourceInputMs;
      fileInfo.video_init = true;
      fileInfo.frameCount = 0;
    } else {
      // CHECK ERROR CASE ...........
      if (videoHeader.compressor !== videoFrame.codectype) {
        this.setErrorCode(-1); // BACKUP_STATUS.CODEC_CHANGED
        // eslint-disable-next-line no-console
        console.error('!!!!Backup Codec CHanged, backup must be stop.....!');
        return null;
      }
      if (videoHeader.width !== videoFrame.width || videoHeader.height !== videoFrame.height) {
        this.setErrorCode(-2); // BACKUP_STATUS.PROFILE_CHANGED
        // eslint-disable-next-line no-console
        console.error('[Video Profile] change stop!!!');
        return null;
      }
    }

    let dummycount: number;
    let diff = 0;
    if (videoFrame.sourceInputMs === 0 || fileInfo.last_ms === 0 || videoFrame.sourceInputMs <= (fileInfo.last_ms as number) + rate) {
      dummycount = 0;
    } else {
      diff = (videoFrame.sourceInputMs - (fileInfo.last_ms as number) - rate) / rate;
      dummycount = Math.floor(diff);

      if (dummycount === 0 && Math.floor((videoFrame.sourceInputMs - (fileInfo.last_ms as number) - rate) / (rate / 2))) {
        dummycount = 1;
      }
      if (diff < 0) {
        dummycount = 0;
      }
    }

    if (dummycount > DUMMY_COUNT_RESET_THRESHOLD) {
      // eslint-disable-next-line no-console
      console.log('Backup long distance... dummy count:%d, need to reset!', dummycount);
      dummycount = 0;
      fileInfo.last_ms = 0;
    }
    if (fileInfo.last_ms === 0 || Math.round(diff) < dummycount || diff < 0) {
      videoHeader.last_ms = videoFrame.sourceInputMs;
      fileInfo.last_ms = videoFrame.sourceInputMs;
    } else {
      videoHeader.last_ms += Number((rate * (dummycount + 1)).toFixed(1));
      fileInfo.last_ms = (fileInfo.last_ms as number) + Number((rate * (dummycount + 1)).toFixed(1));
    }

    aviIndexEntry.offset = fileInfo.pos;
    aviIndexEntry.size = 0;
    if (typeof videoHeader.aviLength === 'undefined') {
      videoHeader.aviLength = 0;
    }

    aviIndexEntry.dummycount = dummycount;
    for (let i = 0; i < dummycount; i++) {
      videoHeader.aviLength++;
      aviIndexEntry.offset += SIZE_OF_CHUNK_HEADER;
    }
    videoHeader.aviLength++;
    aviIndexEntry.size = size;

    fileInfo.pos = aviIndexEntry.offset + SIZE_OF_CHUNK_HEADER + size;

    this.chunkHeader.fourcc = '00dc';
    this.chunkHeader.payloadsize = size;
    this.writeChunkHeader(dummycount);
    this.setStreamHeader(videoHeader);
    this.setIndexEntry(aviIndexEntry);
    this.setChunkHeader(this.chunkHeader);
    return this.buffer;
  }
}
