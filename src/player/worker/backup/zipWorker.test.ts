import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ZipWorkerRequest } from './zipWorker';

class FakeMinizip {
  static appendCalls: { name: string; data: ArrayBuffer; options: unknown }[] = [];
  append(name: string, data: ArrayBuffer, options: unknown): void {
    FakeMinizip.appendCalls.push({ name, data, options });
  }
  zip(): Uint8Array {
    return new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // fake "PK.." zip signature
  }
}

/** Contract-tier test: zipWorker.js is entirely importScripts()/onmessage/postMessage glue around the vendored Minizip WASM build. */
describe('zipWorker contract tests (the legacy player’s Worker/Backup/zipWorker.js)', () => {
  let onmessage: ((event: { data: ZipWorkerRequest }) => void) | null;
  let postMessage: ReturnType<typeof vi.fn>;
  let importScripts: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    FakeMinizip.appendCalls = [];
    onmessage = null;
    postMessage = vi.fn();
    importScripts = vi.fn();
    vi.stubGlobal('Minizip', FakeMinizip);
    vi.stubGlobal('importScripts', importScripts);
    vi.stubGlobal('self', {
      get onmessage() {
        return onmessage;
      },
      set onmessage(handler) {
        onmessage = handler;
      },
      postMessage
    });
    vi.resetModules();
    await import('./zipWorker');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads the vendored Minizip bundle via importScripts on import', () => {
    expect(importScripts).toHaveBeenCalledTimes(1);
    const [url] = importScripts.mock.calls[0] as [string];
    expect(url).toMatch(/vendor\/minizip-asm\.js$/);
  });

  it('registers an onmessage handler on import', () => {
    expect(typeof onmessage).toBe('function');
  });

  it('concatenates the "whole" chunk array, appends it as "<fileName>.avi" with the given password, and posts the zipped result with its buffer transferred', () => {
    const whole = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
    onmessage!({ data: { fileName: 'clip1', password: 'secret', whole } });

    expect(FakeMinizip.appendCalls).toHaveLength(1);
    expect(FakeMinizip.appendCalls[0].name).toBe('clip1.avi');
    expect(FakeMinizip.appendCalls[0].options).toEqual({ compressLevel: 0, password: 'secret' });
    expect(Array.from(new Uint8Array(FakeMinizip.appendCalls[0].data))).toEqual([1, 2, 3, 4, 5]);

    expect(postMessage).toHaveBeenCalledTimes(1);
    const [result, transfer] = postMessage.mock.calls[0] as [Uint8Array, Transferable[]];
    expect(Array.from(result)).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(transfer).toEqual([result.buffer]);
  });
});
