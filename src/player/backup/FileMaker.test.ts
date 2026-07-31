import { describe, it, expect, vi } from 'vitest';
import { FileMaker } from './FileMaker';

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
}

/**
 * Contract-tier tests (not old-vs-new vm parity): FileMaker.js is entirely
 * Worker/Blob/file-saver driven (spins up a real zipWorker, calls the real
 * `saveAs`), which isn't meaningfully comparable via the vm-sandbox harness
 * used elsewhere — same judgment as CanvasTagPlayer/VideoTagPlayer's
 * DOM-heavy surfaces. Assembly/ordering logic is verified against the
 * ported class directly instead.
 */
describe('FileMaker contract tests (the legacy player’s Backup/FileMaker.js)', () => {
  function newFileMaker(): { fileMaker: FileMaker; getWorker: () => FakeWorker } {
    let worker: FakeWorker | undefined;
    const fileMaker = new FileMaker(() => {
      worker = new FakeWorker();
      return worker as unknown as Worker;
    });
    return { fileMaker, getWorker: () => worker as FakeWorker };
  }

  it('processMessage("save", fileName) with no password creates an AVI blob and does not touch the zip worker', () => {
    const { fileMaker, getWorker } = newFileMaker();

    fileMaker.processMessage('mainHeader', new Uint8Array([1]));
    fileMaker.processMessage('body', new Uint8Array([2]));
    fileMaker.processMessage('body', new Uint8Array([3]));
    fileMaker.processMessage('tailHeader', new Uint8Array([4]));
    fileMaker.processMessage('tailBody', new Uint8Array([5]));

    expect(() => fileMaker.processMessage('save', 'myfile')).not.toThrow();
    expect(getWorker()).toBeUndefined();
  });

  it('processMessage("save", fileName) with a password set creates a zip via the injected worker and reports COMPRESS_START', () => {
    const { fileMaker, getWorker } = newFileMaker();
    const compressCb = vi.fn();
    fileMaker.setCompressCallback(compressCb);
    fileMaker.setPassword('secret');

    fileMaker.processMessage('mainHeader', new Uint8Array([1]));
    fileMaker.processMessage('body', new Uint8Array([2]));
    fileMaker.processMessage('tailHeader', new Uint8Array([3]));

    fileMaker.processMessage('save', 'myfile');

    expect(getWorker()).toBeInstanceOf(FakeWorker);
    expect(getWorker().postMessage).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'myfile', password: 'secret' }), expect.anything());
    expect(compressCb).toHaveBeenCalledWith(expect.any(Number)); // COMPRESS_START
  });

  it('zipWorker onmessage completion reports COMPRESS_STOP and terminates the worker', () => {
    const { fileMaker, getWorker } = newFileMaker();
    const compressCb = vi.fn();
    fileMaker.setCompressCallback(compressCb);
    fileMaker.setPassword('secret');
    fileMaker.processMessage('mainHeader', new Uint8Array([1]));
    fileMaker.processMessage('save', 'myfile');

    const worker = getWorker();
    expect(worker.onmessage).toBeTypeOf('function');
    worker.onmessage!({ data: new Uint8Array([9, 9]) } as MessageEvent);

    expect(worker.terminate).toHaveBeenCalled();
    expect(compressCb).toHaveBeenCalledTimes(2); // START then STOP
  });

  it('a second processMessage("save") is a no-op once a blob already exists (blob === null guard)', () => {
    const { fileMaker, getWorker } = newFileMaker();
    fileMaker.processMessage('mainHeader', new Uint8Array([1]));
    fileMaker.processMessage('save', 'first');
    expect(() => fileMaker.processMessage('save', 'second')).not.toThrow();
    expect(getWorker()).toBeUndefined(); // no password => AVI path, no worker either time
  });
});
