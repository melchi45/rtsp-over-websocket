import { describe, it, expect, vi } from 'vitest';
import { loadLegacyModule, type LegacySandbox } from '../test-support/loadLegacyModule';
import { createMediaSessionLegacySandbox } from '../test-support/legacyGlobals';
import { RtpClient, type MediaRouterLike, type MediaRouterMessageType } from './RtpClient';
import type { SdpInfoEntry } from '../network/rtspOverWebsocket';

interface LegacyRtpClient {
  channelId: number;
  running: boolean;
  sendSdpInfo(sdpInfo: SdpInfoEntry[]): void;
  sendRtpData(rtspinterleave: Uint8Array, rtpheader: Uint8Array, rtpPacketArray: Uint8Array): void;
  addListener(type: string, func: (...args: unknown[]) => void): void;
  checkRtpSession(type: string): boolean;
  getRtpSession(interleavedId: number): { type?: string; codec?: string } | null;
  getRtpSessionWithType(type: string | number): { type?: string; codec?: string; running?: boolean } | null;
  close(): void;
}

class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  postMessage(): void {}
  terminate(): void {}
}

class FakeMediaRouter implements MediaRouterLike {
  channelId: number;
  deviceType = 'camera';
  onRtcpData = vi.fn();
  onVideoData = vi.fn();
  onAudioData = vi.fn();
  onMetadata = vi.fn();
  onWaiting = vi.fn();
  onStatistics = vi.fn();
  gotAudioSupport = vi.fn();
  private listener: ((msgType: MediaRouterMessageType, data: unknown) => void) | null = null;
  startAudioTalkCallback: ((stream: Uint8Array) => void) | null = null;
  startAudioTalkResolveWith = 8000;

  constructor(channelId: number) {
    this.channelId = channelId;
  }

  addListener(_type: 'rtpClient', callback: (msgType: MediaRouterMessageType, data: unknown) => void): void {
    this.listener = callback;
  }

  emit(msgType: MediaRouterMessageType, data?: unknown): void {
    this.listener?.(msgType, data);
  }

  startAudioTalk(callback: (stream: Uint8Array) => void): Promise<number> {
    this.startAudioTalkCallback = callback;
    return Promise.resolve(this.startAudioTalkResolveWith);
  }
}

function buildSandbox(): LegacySandbox {
  const base = createMediaSessionLegacySandbox();
  const sandbox: LegacySandbox = { ...base, Worker: FakeWorker };
  sandbox.Session = loadLegacyModule('MediaSession/session.js', 'Session', sandbox);
  sandbox.RTCPSession = loadLegacyModule('MediaSession/rtcpSession.js', 'RTCPSession', sandbox);
  sandbox.RtpSession = loadLegacyModule('MediaSession/rtpSession.js', 'RtpSession', sandbox);
  sandbox.H264Session = loadLegacyModule('MediaSession/VideoSession/h264Session.js', 'H264Session', sandbox);
  sandbox.H265Session = loadLegacyModule('MediaSession/VideoSession/h265Session.js', 'H265Session', sandbox);
  sandbox.MjpegSession = loadLegacyModule('MediaSession/VideoSession/mjpegSession.js', 'MjpegSession', sandbox);
  sandbox.G711Session = loadLegacyModule('MediaSession/AudioSession/g711Session.js', 'G711Session', sandbox);
  sandbox.G726Session = loadLegacyModule('MediaSession/AudioSession/g726Session.js', 'G726Session', sandbox);
  sandbox.AACSession = loadLegacyModule('MediaSession/AudioSession/aacSession.js', 'AACSession', sandbox);
  sandbox.MetaSession = loadLegacyModule('MediaSession/TextSession/metaSession.js', 'MetaSession', sandbox);
  sandbox.G711AudioEncoder = loadLegacyModule('Talk/Encoder/audioEncoderG711.js', 'G711AudioEncoder', sandbox);
  sandbox.AudioTalkSession = loadLegacyModule('MediaSession/AudioSession/audioTalkSession.js', 'AudioTalkSession', sandbox);
  return sandbox;
}

const LegacyRtpClientCtor = loadLegacyModule<new (mediaRouter: FakeMediaRouter) => LegacyRtpClient>(
  'MediaSession/rtpClient.js',
  'RtpClient',
  buildSandbox()
);

function videoAudioMetaSdp(): SdpInfoEntry[] {
  return [
    { Type: 'video', codecName: 'H264', trackID: 'trackID=1', ClockFreq: '90000', RtpInterlevedID: 0, RtcpInterlevedID: 1, SessionID: 'sess1' },
    {
      Type: 'audio',
      codecName: 'G.711',
      codecMime: 'PCMU',
      trackID: 'trackID=2',
      ClockFreq: '8000',
      Bitrate: 64,
      RtpInterlevedID: 2,
      RtcpInterlevedID: 3,
      SessionID: 'sess1'
    },
    { Type: 'application', codecName: 'MetaData', trackID: 'trackID=3', ClockFreq: '1000', RtpInterlevedID: 4, RtcpInterlevedID: 5, SessionID: 'sess1' }
  ];
}

function rtpHeader(marker: boolean, seq: number, timestamp: number): Uint8Array {
  const header = new Uint8Array(12);
  header[0] = 0x80;
  header[1] = (marker ? 0x80 : 0x00) | 0x60;
  header[2] = (seq >> 8) & 0xff;
  header[3] = seq & 0xff;
  header[4] = (timestamp >>> 24) & 0xff;
  header[5] = (timestamp >>> 16) & 0xff;
  header[6] = (timestamp >>> 8) & 0xff;
  header[7] = timestamp & 0xff;
  return header;
}

describe('RtpClient parity with the legacy player’s MediaSession/rtpClient.js', () => {
  it('registers with mediaRouter and starts with running=false, channelId from mediaRouter, identically', () => {
    const legacyRouter = new FakeMediaRouter(7);
    const legacy = new LegacyRtpClientCtor(legacyRouter);
    const portedRouter = new FakeMediaRouter(7);
    const ported = new RtpClient(portedRouter);

    expect(ported.channelId).toBe(legacy.channelId);
    expect(ported.running).toBe(legacy.running);
    expect(ported.running).toBe(false);
  });

  it('sendSdpInfo creates video/audio/meta sessions and reports audio support identically', () => {
    const legacyRouter = new FakeMediaRouter(1);
    const legacy = new LegacyRtpClientCtor(legacyRouter);
    const portedRouter = new FakeMediaRouter(1);
    const ported = new RtpClient(portedRouter);

    legacy.sendSdpInfo(videoAudioMetaSdp());
    ported.sendSdpInfo(videoAudioMetaSdp());

    expect(portedRouter.gotAudioSupport.mock.calls).toEqual(legacyRouter.gotAudioSupport.mock.calls);
    expect(portedRouter.gotAudioSupport).toHaveBeenCalledWith(true);

    const legacyVideo = legacy.getRtpSessionWithType('video')!;
    const portedVideo = ported.getRtpSessionWithType('video')!;
    expect(portedVideo.codec).toBe(legacyVideo.codec);

    const legacyAudio = legacy.getRtpSessionWithType('audio')!;
    const portedAudio = ported.getRtpSessionWithType('audio')!;
    expect(portedAudio.codec).toBe(legacyAudio.codec);

    expect(legacy.getRtpSession(0)).not.toBeNull();
    expect(ported.getRtpSession(0)).not.toBeNull();
    expect(legacy.checkRtpSession('application')).toBe(ported.checkRtpSession('application'));
    expect(ported.checkRtpSession('application')).toBe(true);
  });

  it('sendSdpInfo starts an audio-talk backchannel (no separate audio session added) identically', () => {
    const legacyRouter = new FakeMediaRouter(1);
    const legacy = new LegacyRtpClientCtor(legacyRouter);
    const portedRouter = new FakeMediaRouter(1);
    const ported = new RtpClient(portedRouter);

    const talkSdp: SdpInfoEntry[] = [
      {
        Type: 'audio',
        codecName: 'G.711',
        codecMime: 'PCMU',
        trackID: 'trackID=t',
        ClockFreq: '8000',
        Bitrate: 64,
        RtpInterlevedID: 0,
        RtcpInterlevedID: 1,
        SessionID: 'sess1'
      }
    ];

    legacy.sendSdpInfo(talkSdp);
    ported.sendSdpInfo(talkSdp);

    expect(legacyRouter.startAudioTalkCallback).not.toBeNull();
    expect(portedRouter.startAudioTalkCallback).not.toBeNull();
    // No rtp/rtcp session pair is registered for the talk-back track itself.
    expect(legacy.getRtpSessionWithType('audio')).toBeNull();
    expect(ported.getRtpSessionWithType('audio')).toBeNull();
    expect(legacyRouter.gotAudioSupport.mock.calls).toEqual(portedRouter.gotAudioSupport.mock.calls);
  });

  it('sendRtpData routes to the matching session by interleavedId and is a no-op for an unknown id, identically', () => {
    const legacyRouter = new FakeMediaRouter(1);
    const legacy = new LegacyRtpClientCtor(legacyRouter);
    const portedRouter = new FakeMediaRouter(1);
    const ported = new RtpClient(portedRouter);

    legacy.sendSdpInfo(videoAudioMetaSdp());
    ported.sendSdpInfo(videoAudioMetaSdp());

    const interleaved = Uint8Array.from([0x24, 0]);
    const header = rtpHeader(true, 1, 3000);
    const nal = Uint8Array.from([0x67, 0x42, 0x00, 0x1e]);

    expect(() => legacy.sendRtpData(interleaved, header, nal)).not.toThrow();
    expect(() => ported.sendRtpData(interleaved, header, nal)).not.toThrow();
    expect(portedRouter.onVideoData.mock.calls.length).toBe(legacyRouter.onVideoData.mock.calls.length);

    const unknownInterleaved = Uint8Array.from([0x24, 99]);
    expect(() => legacy.sendRtpData(unknownInterleaved, header, nal)).not.toThrow();
    expect(() => ported.sendRtpData(unknownInterleaved, header, nal)).not.toThrow();
  });

  it('running=true cascades to every session identically', () => {
    const legacyRouter = new FakeMediaRouter(1);
    const legacy = new LegacyRtpClientCtor(legacyRouter);
    const portedRouter = new FakeMediaRouter(1);
    const ported = new RtpClient(portedRouter);

    legacy.sendSdpInfo(videoAudioMetaSdp());
    ported.sendSdpInfo(videoAudioMetaSdp());

    legacy.running = true;
    ported.running = true;

    expect(ported.getRtpSessionWithType('video')!.running).toBe(legacy.getRtpSessionWithType('video')!.running);
    expect(ported.getRtpSessionWithType('video')!.running).toBe(true);
  });

  it('mediaRouterMessage("close") and close() both clear all sessions identically', () => {
    const legacyRouter = new FakeMediaRouter(1);
    const legacy = new LegacyRtpClientCtor(legacyRouter);
    const portedRouter = new FakeMediaRouter(1);
    const ported = new RtpClient(portedRouter);

    legacy.sendSdpInfo(videoAudioMetaSdp());
    ported.sendSdpInfo(videoAudioMetaSdp());
    legacyRouter.emit('close');
    portedRouter.emit('close');
    expect(legacy.getRtpSessionWithType('video')).toBe(ported.getRtpSessionWithType('video'));
    expect(ported.getRtpSessionWithType('video')).toBeNull();

    legacy.sendSdpInfo(videoAudioMetaSdp());
    ported.sendSdpInfo(videoAudioMetaSdp());
    legacy.close();
    ported.close();
    expect(legacy.getRtpSessionWithType('video')).toBe(ported.getRtpSessionWithType('video'));
    expect(ported.getRtpSessionWithType('video')).toBeNull();

    expect(() => legacy.close()).not.toThrow();
    expect(() => ported.close()).not.toThrow();
  });
});
