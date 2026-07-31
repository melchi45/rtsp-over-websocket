/// <reference path="../../vendor/minizip-asm.d.ts" />

export interface ZipWorkerRequest {
  fileName: string;
  password?: string;
  whole: Uint8Array[];
}

// Narrow local ambient typing for the classic (non-module) Worker global
// scope this file touches — see mjpegDepacketizeWorker.ts for why the full
// `webworker` lib isn't used project-wide. `importScripts` loads the vendor
// UMD bundle as its own top-level classic script (see minizip-asm.d.ts for
// why that matters, rather than an ES `import`). The URL uses
// `new URL('...', import.meta.url)` so Vite emits vendor/minizip-asm.js as
// a build asset and rewrites this call to the final hashed path.
declare function importScripts(...urls: string[]): void;
declare const self: {
  onmessage: ((event: MessageEvent<ZipWorkerRequest>) => void) | null;
  postMessage(message: Uint8Array, transfer?: Transferable[]): void;
};

importScripts(new URL('../../vendor/minizip-asm.js', import.meta.url).href);

/**
 * Ported from the legacy player’s Worker/Backup/zipWorker.js — zips the backup
 * clip pieces FileMaker.ts/BackupProvider.ts stream into a Worker
 * (`whole`, an array of Uint8Array chunks) into a single password-protected
 * archive, using the vendored Minizip (minizip-asm.js) WASM build.
 */
self.onmessage = (event) => {
  const { fileName, password, whole } = event.data;

  let totalSize = 0;
  for (let i = 0; i < whole.length; i += 1) {
    totalSize += whole[i].length;
  }
  const buffer = new Uint8Array(new ArrayBuffer(totalSize));
  let bufferPos = 0;
  for (let i = 0; i < whole.length; i += 1) {
    buffer.set(whole[i], bufferPos);
    bufferPos += whole[i].length;
  }

  const mz = new Minizip();
  mz.append(fileName + '.avi', buffer.buffer, {
    compressLevel: 0,
    password
  });
  const result = mz.zip();
  self.postMessage(result, [result.buffer]);
};
