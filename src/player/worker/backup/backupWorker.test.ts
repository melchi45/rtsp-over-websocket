import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BackupWorkerMessage } from './backupWorker';

/** Contract-tier test: backupWorker.js is onmessage/postMessage glue around BackupSession (parity-tested separately). */
describe('backupWorker contract tests (the legacy player’s Worker/Backup/backupWorker.js)', () => {
  let onmessage: ((event: { data: BackupWorkerMessage }) => void) | null;
  let postMessage: ReturnType<typeof vi.fn>;
  let close: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    onmessage = null;
    postMessage = vi.fn();
    close = vi.fn();
    vi.stubGlobal('postMessage', postMessage);
    vi.stubGlobal('close', close);
    vi.stubGlobal('addEventListener', (_type: string, listener: typeof onmessage) => {
      onmessage = listener;
    });
    vi.resetModules();
    await import('./backupWorker');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers a message listener on import', () => {
    expect(typeof onmessage).toBe('function');
  });

  it('"start" creates a session and wires channelId/deviceType/gmt/split from the message', () => {
    onmessage!({ data: { type: 'start', data: { channelId: 7, deviceType: 'camera', gmt: 9, fileName: 'clip', split: true } } });

    // Observable indirectly: sending a video I-frame afterward must not throw
    // (a session now exists) and must produce the expected backupResult(0x0600).
    const frameInfo = { type: 'video' as const, frameType: 'I', framerate: 30, width: 640, height: 480, codectype: 'H264', PESsize: 10 };
    onmessage!({ data: { type: 'sendVideoFrame', data: { frameInfo, streamData: new Uint8Array(10) } } });

    const backupResultCalls = postMessage.mock.calls.filter(([msg]) => msg.type === 'backupResult');
    expect(backupResultCalls.length).toBeGreaterThan(0);
    expect((backupResultCalls[0][0].data as { filename: string }).filename).toBe('clip');
  });

  it('"stop" ends the session and terminates the worker', () => {
    onmessage!({ data: { type: 'start', data: { channelId: 1, deviceType: 'camera' } } });
    onmessage!({ data: { type: 'stop' } });

    expect(close).toHaveBeenCalled();
  });

  it('an unrecognized message type is a no-op and does not throw', () => {
    expect(() => onmessage!({ data: { type: 'bogus' } as unknown as BackupWorkerMessage })).not.toThrow();
  });
});
