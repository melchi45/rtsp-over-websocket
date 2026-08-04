import { AviFormatWriter } from './AviFormatWriter';

const SIZE_OF_CHUNK_HEADER = 8;
const SIZE_OF_WAVE_FORMAT = 40;
const SIZE_OF_STREAM_HEADER = 64;
const MEDIASUBTYPE_RAW_AAC1 = 0x00ff;
const AAC_PER_SAMPLE = 1024;
const AAC_FORMAT_SIZE = 2;
const AAC_BUF_SIZE = 8192;
const WAVE_FORMAT_MULAW = 0x0007;

const BITRATE = {
  _16K: 16000,
  _24K: 24000,
  _32K: 32000,
  _40K: 40000
};

export interface AudioBackupFrame {
  codectype: string;
  bitrate: number;
  audioSamplingRate: number;
  PESsize: number;
}

export interface AudioBackupFileInfo {
  audioInit?: boolean;
  audioStrn?: number;
  audioBytes?: number;
  codectype?: string;
  bitrate?: number;
  samplingRate?: number;
  pos: number;
}

function makeAudioConfig(samplerate: number, channels: number): number {
  let bitcnt = 0;

  switch (samplerate) {
    case 48000:
      bitcnt |= 0x8001;
      break;
    case 44100:
      bitcnt |= 0x0002;
      break;
    case 32000:
      bitcnt |= 0x8002;
      break;
    case 24000:
      bitcnt |= 0x0003;
      break;
    case 16000:
      bitcnt |= 0x0004;
      break;
    case 8000:
      bitcnt |= 0x8005;
      break;
    default:
      return 0;
  }

  switch (channels) {
    case 1:
      bitcnt |= 0x0800;
      break;
    case 2:
      bitcnt |= 0x1000;
      break;
    case 3:
      bitcnt |= 0x1800;
      break;
    case 4:
      bitcnt |= 0x2000;
      break;
    case 5:
      bitcnt |= 0x2800;
      break;
    case 6:
      bitcnt |= 0x3000;
      break;
    case 8:
      bitcnt |= 0x3800;
      break;
    default:
      return 0;
  }
  // 0x0010 : AAC-LC
  return bitcnt | 0x0010;
}

/**
 * Ported from the legacy player’s Worker/Backup/audioBackup (`AudioHeader`) —
 * builds the AVI audio stream header/format for AAC/G.711/G.726 backup
 * audio.
 *
 * `settingG726`'s `audioFormat.aviSuggestedBufferSize = audioHeader.aviRate;`
 * is a real legacy typo (assigns to the *format* object, not the *header*
 * object it clearly means to update) — preserved faithfully rather than
 * "fixed"; see AviFormatWriter.ts's `AviStreamFormat.aviSuggestedBufferSize`
 * doc comment. Likewise `aviInitialFrames` is set here but never read by any
 * writer (see AviStreamHeader's doc comment) and is kept for data fidelity.
 */
export class AudioHeader extends AviFormatWriter {
  initHeader(): void {
    this.setStreamHeader({
      aviFourCC: 'strh',
      aviBytesCount: SIZE_OF_STREAM_HEADER - 8,
      aviQuality: -1,
      aviType: '',
      aviFlags: 0,
      aviInitialFrames: 0,
      aviHandler: '',
      aviScale: 0,
      aviRate: 0,
      aviSuggestedBufferSize: 0,
      aviLength: 0,
      aviSampleSize: 0
    });

    this.setStreamFormat({
      FourCC: 'strf',
      BytesCount: SIZE_OF_WAVE_FORMAT - 8,
      Channels: 1,
      FormatTag: 0,
      SamplesPerSec: 0,
      AvgBytesPerSec: 0,
      BitsPerSample: 0,
      BlockAlign: 0,
      Size: 0,
      AudioConfig: 0
    });
  }

  settingAAC(audioFrame: AudioBackupFrame): void {
    const audioHeader = this.getStreamHeader();
    audioHeader.aviQuality = 0;
    audioHeader.aviType = 'auds';
    audioHeader.aviFlags = 1;
    audioHeader.aviInitialFrames = 0;
    audioHeader.aviScale = AAC_PER_SAMPLE;
    audioHeader.aviRate = audioFrame.audioSamplingRate;
    audioHeader.aviSuggestedBufferSize = AAC_BUF_SIZE;
    this.setStreamHeader(audioHeader);

    const audioFormat = this.getStreamFormat();
    const audioConfiguration = makeAudioConfig(audioFrame.audioSamplingRate, 1);
    audioFormat.FormatTag = MEDIASUBTYPE_RAW_AAC1;
    audioFormat.SamplesPerSec = audioFrame.audioSamplingRate;
    audioFormat.AvgBytesPerSec = (audioFormat.Channels as number) * (audioFrame.bitrate / 8);
    audioFormat.BitsPerSample = 16;
    audioFormat.BlockAlign = AAC_PER_SAMPLE;
    audioFormat.Size = AAC_FORMAT_SIZE;
    audioFormat.AudioConfig = audioConfiguration;
    this.setStreamFormat(audioFormat);
  }

  settingG711(): void {
    const audioHeader = this.getStreamHeader();
    audioHeader.aviQuality = 0;
    audioHeader.aviType = 'auds';
    audioHeader.aviScale = 1;
    audioHeader.aviRate = 8000;
    audioHeader.aviSuggestedBufferSize = 8000;

    const audioFormat = this.getStreamFormat();
    audioFormat.FormatTag = WAVE_FORMAT_MULAW;
    audioFormat.SamplesPerSec = 8000;
    audioFormat.AvgBytesPerSec = 8000;
    audioFormat.BitsPerSample = 8;
    audioFormat.BlockAlign = 1;

    audioHeader.aviSampleSize = this.getAviSampleSize();

    this.setStreamHeader(audioHeader);
    this.setStreamFormat(audioFormat);
  }

  settingG726(audioFrame: AudioBackupFrame): void {
    const audioHeader = this.getStreamHeader();
    const audioFormat = this.getStreamFormat();
    audioHeader.aviType = 'auds';
    audioHeader.aviScale = 1;
    audioHeader.aviSampleSize = 2;
    if (audioFrame.bitrate === BITRATE._16K) {
      audioFormat.AvgBytesPerSec = audioHeader.aviRate = 2000;
      audioFormat.BitsPerSample = 2;
    } else if (audioFrame.bitrate === BITRATE._24K) {
      audioFormat.AvgBytesPerSec = audioHeader.aviRate = 3000;
      audioFormat.BitsPerSample = 3;
    } else if (audioFrame.bitrate === BITRATE._32K) {
      audioFormat.AvgBytesPerSec = audioHeader.aviRate = 4000;
      audioFormat.BitsPerSample = 4;
    } else if (audioFrame.bitrate === BITRATE._40K) {
      audioFormat.AvgBytesPerSec = audioHeader.aviRate = 5000;
      audioFormat.BitsPerSample = 5;
    }
    audioFormat.FormatTag = 0x0045;
    // legacy bug: assigns to audioFormat, not audioHeader — see class doc comment.
    audioFormat.aviSuggestedBufferSize = audioHeader.aviRate;
    audioFormat.SamplesPerSec = 8000;
    audioFormat.BlockAlign = 1;
    this.setStreamHeader(audioHeader);
    this.setStreamFormat(audioFormat);
  }

  checkAudioFrameInfo(audioFrame: AudioBackupFrame, fileInfo: AudioBackupFileInfo): number {
    // First setting audio config.
    if (typeof fileInfo.audioInit === 'undefined' || fileInfo.audioInit === false) {
      if (audioFrame.codectype === 'AAC') {
        this.settingAAC(audioFrame);
      } else if (audioFrame.codectype === 'G711') {
        this.settingG711();
      } else if (audioFrame.codectype === 'G726') {
        this.settingG726(audioFrame);
      }
      fileInfo.audioInit = true;
      fileInfo.audioStrn = 0;
      fileInfo.audioBytes = 0;
      fileInfo.codectype = audioFrame.codectype;
      fileInfo.bitrate = audioFrame.bitrate;
      fileInfo.samplingRate = audioFrame.audioSamplingRate;
      return 0;
    }
    // check previous config
    if (fileInfo.codectype !== audioFrame.codectype) {
      return -1;
    }
    if (fileInfo.bitrate !== audioFrame.bitrate) {
      return -1;
    }
    if (fileInfo.samplingRate !== audioFrame.audioSamplingRate) {
      return -1;
    }
    return 0;
  }

  override updateInfo(audioFrame: AudioBackupFrame, fileInfo: AudioBackupFileInfo): Uint8Array | null {
    const audioHeader = this.getStreamHeader();
    const aviIndexEntry = this.getIndexEntry();
    let size = audioFrame.PESsize;
    if (size % 2 !== 0) {
      size += 1;
    }
    aviIndexEntry.flag = 0x10;
    aviIndexEntry.chid = '01wb';
    if (this.checkAudioFrameInfo(audioFrame, fileInfo) !== 0) {
      this.setErrorCode(-1); // BACKUP_STATUS.CODEC_CHANGED
      // eslint-disable-next-line no-console
      console.error('check Audio Frame info failed!!!!!');
      return null;
    }
    if (audioFrame.codectype === 'AAC') {
      this.settingAAC(audioFrame);
      fileInfo.audioStrn = (fileInfo.audioStrn ?? 0) + 1;
      audioHeader.aviLength = fileInfo.audioStrn;
    } else if (audioFrame.codectype === 'G711' || audioFrame.codectype === 'G726') {
      if (audioFrame.codectype === 'G711') {
        this.settingG711();
      } else {
        this.settingG726(audioFrame);
      }
      fileInfo.audioBytes = (fileInfo.audioBytes ?? 0) + size;
      audioHeader.aviLength = fileInfo.audioBytes / this.getAviSampleSize();
    }

    aviIndexEntry.offset = fileInfo.pos;
    aviIndexEntry.size = size;
    aviIndexEntry.dummycount = 0;

    fileInfo.pos = (this.aviIndexEntry.offset as number) + SIZE_OF_CHUNK_HEADER + size;
    this.chunkHeader.fourcc = this.aviIndexEntry.chid;
    this.chunkHeader.payloadsize = size;
    this.writeChunkHeader();
    this.setChunkHeader(this.chunkHeader);
    this.setStreamHeader(audioHeader);
    this.setIndexEntry(aviIndexEntry);
    return this.buffer;
  }
}
