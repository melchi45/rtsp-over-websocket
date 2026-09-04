import { saveAs } from 'file-saver';
import { fromHex } from '../util/hex';
import { createDebugLogger, type DebugConfig, type DebugLogger, NOOP_DEBUG_LOGGER } from '../util/debugLog';

export type ZipWorkerFactory = () => Worker;

/**
 * Ported from the legacy player’s Backup/FileMaker — assembles AVI/ZIP backup
 * files from the pieces backupWorker streams in (header/body/tailHeader/
 * tailBody), then saves via file-saver.
 */
export class FileMaker {
  private header: unknown = [];
  private parts: unknown[] = [];
  private tails: unknown[] = [];
  private tailHeader: unknown = [];
  private blob: Blob | null = null;
  private zipPassword: string | null = null;
  private compressCallback: ((errorCode: number) => void) | null = null;
  /** See util/debugLog.ts. */
  private debugLog: DebugLogger = NOOP_DEBUG_LOGGER;
  set debug(config: DebugConfig | null) {
    this.debugLog = createDebugLogger(config, 'backup', 'FileMaker');
  }

  constructor(
    private readonly zipWorkerFactory: ZipWorkerFactory = () => new Worker(new URL('../worker/backup/zipWorker.ts', import.meta.url))
  ) {}

  private addBody(part: unknown): void {
    this.parts.push(part);
    this.blob = null;
  }

  private addMainHeader(header: unknown): void {
    this.header = header;
  }

  private addTailHeader(header: unknown): void {
    this.tailHeader = header;
  }

  private addTail(tail: unknown): void {
    this.tails.push(tail);
  }

  private clearMemory(): void {
    this.header = null;
    this.tailHeader = null;
    this.parts = [];
    this.tails = [];
    this.blob = null;
  }

  private createZipFile(fileName: string, whole: Uint8Array[]): void {
    const zipWorker = this.zipWorkerFactory();
    zipWorker.onmessage = (e: MessageEvent<BlobPart>) => {
      this.blob = new Blob([e.data], { type: 'application/octet-stream' });
      saveAs(this.blob, fileName + '.zip');
      this.zipPassword = null;
      this.clearMemory();
      zipWorker.terminate();
      (this.compressCallback as (errorCode: number) => void)(fromHex('0x060D')); // "COMPRESS_STOP"
    };
    const message = { fileName, password: this.zipPassword, whole };
    const transferList = whole.map((arr) => arr.buffer);
    zipWorker.postMessage(message, transferList as Transferable[]);
    (this.compressCallback as (errorCode: number) => void)(fromHex('0x060C')); // "COMPRESS_START"
  }

  private createAviFile(fileName: string, whole: unknown[]): void {
    this.blob = new Blob(whole as BlobPart[], { type: 'application/octet-stream' });
    saveAs(this.blob, fileName + '.avi');
    this.clearMemory();
  }

  private createFile(fileName: string): void {
    if (this.blob === null) {
      const whole: unknown[] = [];
      whole.push(this.header);
      for (let i = 0; i < this.parts.length; i++) {
        whole.push(this.parts[i]);
      }
      whole.push(this.tailHeader);
      for (let i = 0; i < this.tails.length; i++) {
        whole.push(this.tails[i]);
      }

      if (this.zipPassword) {
        this.createZipFile(fileName, whole as Uint8Array[]);
      } else {
        this.createAviFile(fileName, whole);
      }
    }
  }

  processMessage(target: string, data: unknown): void {
    this.debugLog.debug('processMessage()', target);
    if (target === 'body') {
      this.addBody(data);
    } else if (target === 'mainHeader') {
      this.addMainHeader(data);
    } else if (target === 'tailHeader') {
      this.addTailHeader(data);
    } else if (target === 'tailBody') {
      this.addTail(data);
    } else if (target === 'save') {
      this.createFile(data as string);
    }
  }

  setPassword(password: string | null): void {
    this.zipPassword = password;
  }

  setCompressCallback(callback: (errorCode: number) => void): void {
    this.compressCallback = callback;
  }
}
