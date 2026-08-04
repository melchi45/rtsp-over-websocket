import { describe, it, expect, vi } from 'vitest';
import { BackupProvider } from './BackupProvider';
import type { VideoStreamData, VideoInfo, AudioStreamData, AudioInfo } from '../mediaSession';

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
}

function newProvider(): { provider: BackupProvider; getWorker: () => FakeWorker } {
  let worker: FakeWorker | undefined;
  const provider = new BackupProvider(() => {
    worker = new FakeWorker();
    return worker as unknown as Worker;
  });
  return { provider, getWorker: () => worker as FakeWorker };
}

function videoFrame(): { streamData: VideoStreamData; videoInfo: VideoInfo } {
  return {
    streamData: { codecType: 'H264', frameData: new Uint8Array([1, 2, 3]), timeStamp: { timestamp: 1000, timestamp_usec: 0, timezone: 0 } },
    videoInfo: { frameType: 'I', width: 640, height: 480, framerate: 30 }
  };
}

function audioFrame(): { streamData: AudioStreamData; audioInfo: AudioInfo } {
  return {
    streamData: { codecType: 'AAC', frameData: new Uint8Array([4, 5]), timeStamp: { timestamp: 1000, timestamp_usec: 0, timezone: 0 } },
    audioInfo: { bitrate: 64000 }
  };
}

/** Contract-tier tests: backupProvider.js is entirely Worker-message-driven. */
describe('BackupProvider contract tests (the legacy player’s Backup/backupProvider)', () => {
  it('channelId/deviceType are plain, freely settable fields (real per-instance accessors in legacy, no side effects)', () => {
    const { provider } = newProvider();
    provider.channelId = 5;
    provider.deviceType = 'nvr';
    expect(provider.channelId).toBe(5);
    expect(provider.deviceType).toBe('nvr');
  });

  it('init() creates a backup worker and posts a "start" message with the given fileName/password/split/gmt', () => {
    const { provider, getWorker } = newProvider();
    const callback = vi.fn();
    provider.channelId = 1;
    provider.deviceType = 'camera';

    provider.init({ callback, fileName: 'clip1', password: 'pw', split: 100, gmt: 0 });

    expect(getWorker().postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'start',
        data: expect.objectContaining({ channelId: 1, fileName: 'clip1', deviceType: 'camera', password: 'pw', split: 100, gmt: 0 })
      })
    );
  });

  it('onVideoData() before any frame arrives transitions WAIT->PROCESSING and posts a "sendVideoFrame" message', () => {
    const { provider, getWorker } = newProvider();
    provider.init({ callback: vi.fn() });
    getWorker().postMessage.mockClear();

    const { streamData, videoInfo } = videoFrame();
    provider.onVideoData(streamData, videoInfo);

    expect(getWorker().postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'sendVideoFrame', playMode: undefined }));
  });

  it('receiveAudioData() only posts once backup has started processing (after the first onVideoData call)', () => {
    const { provider, getWorker } = newProvider();
    provider.init({ callback: vi.fn() });
    getWorker().postMessage.mockClear();

    const { streamData: audioStream, audioInfo } = audioFrame();
    provider.receiveAudioData(audioStream, audioInfo);
    expect(getWorker().postMessage).not.toHaveBeenCalled();

    const { streamData: videoStream, videoInfo } = videoFrame();
    provider.onVideoData(videoStream, videoInfo);
    getWorker().postMessage.mockClear();

    provider.receiveAudioData(audioStream, audioInfo);
    expect(getWorker().postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'sendAudioFrame' }));
  });

  it('closeStream() posts a "stop" message and resets status back to WAIT (a subsequent onVideoData re-transitions WAIT->PROCESSING)', () => {
    const { provider, getWorker } = newProvider();
    provider.init({ callback: vi.fn() });
    const { streamData, videoInfo } = videoFrame();
    provider.onVideoData(streamData, videoInfo);

    provider.closeStream();
    expect(getWorker().postMessage).toHaveBeenCalledWith({ type: 'stop' });

    getWorker().postMessage.mockClear();
    provider.onVideoData(streamData, videoInfo);
    expect(getWorker().postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'sendVideoFrame' }));
  });

  it('the backup worker\'s "backupResult" message forwards to the registered callback', () => {
    const { provider, getWorker } = newProvider();
    const callback = vi.fn();
    provider.init({ callback });

    const worker = getWorker();
    expect(worker.onmessage).toBeTypeOf('function');
    worker.onmessage!({ data: { type: 'backupResult', data: { errorCode: 0 } } } as MessageEvent);

    expect(callback).toHaveBeenCalledWith({ errorCode: 0 });
  });

  it('the backup worker\'s "timestamp" message forwards to the registered timestamp callback', () => {
    const { provider, getWorker } = newProvider();
    const timestampCb = vi.fn();
    provider.init({ callback: vi.fn(), timestamp: timestampCb });

    getWorker().onmessage!({ data: { type: 'timestamp', data: { timestamp: 42 } } } as MessageEvent);

    expect(timestampCb).toHaveBeenCalledWith({ timestamp: 42 });
  });

  it('an unrecognized worker message type ("terminate") does not throw', () => {
    const { provider, getWorker } = newProvider();
    provider.init({ callback: vi.fn() });
    expect(() => getWorker().onmessage!({ data: { type: 'terminate' } } as MessageEvent)).not.toThrow();
  });
});
