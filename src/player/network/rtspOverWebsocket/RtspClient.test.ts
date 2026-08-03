import { describe, it, expect } from 'vitest';
import { loadLegacyModule } from '../../test-support/loadLegacyModule';
import { createNetworkLegacySandbox, decimalToHex } from '../../test-support/legacyGlobals';
import { RtspClient, type RtpClientLike, type RtpSessionLike } from './RtspClient';

interface LegacyRtspClient {
  rtpClient?: RtpClientLike;
  parseDescribeResponse(response: string): unknown;
  parseRtspResponse(message: string): unknown;
  parseWWWAuthenticate(authenticateString: string): unknown;
  toStringExtensionScale(value: number | string, direction?: 'forward' | 'backward'): string;
  getSessionId(interleavedId?: number): string | number;
  getCurrentState(): string;
}

const sandbox = {
  ...createNetworkLegacySandbox(),
  decimalToHex,
  DigestGenerator: loadLegacyModule('Util/digestGenerator.js', 'DigestGenerator', {
    CryptoJS: createNetworkLegacySandbox().CryptoJS,
    decimalToHex,
    log: createNetworkLegacySandbox().log
  })
};

const LegacyRtspClientCtor = loadLegacyModule<new () => LegacyRtspClient>(
  'Network/RTSPoverWebsocket/rtspClient.js',
  'RtspClient',
  sandbox
);

function newLegacy(): LegacyRtspClient {
  return new LegacyRtspClientCtor();
}

function newPorted(): RtspClient {
  return new RtspClient();
}

const sdpBody = [
  'v=0',
  'o=- 1234567890 1 IN IP4 192.168.1.100',
  's=Session streamed by "testserver"',
  'i=Test session information',
  'c=IN IP4 192.168.1.100',
  't=0 0',
  'a=control:*',
  'm=video 0 RTP/AVP 96',
  'a=control:trackID=1',
  'a=rtpmap:96 H264/90000',
  'a=framerate:30.000000',
  'a=framesize:96 1920-1080',
  'a=fmtp:96 packetization-mode=1;profile-level-id=4D0028;sprop-parameter-sets=Z00AKpY1QPAET8s3AQEBQAAA+kAAHUwB,aO48gA==',
  'b=AS:2048',
  'i=video track info',
  'm=audio 0 RTP/AVP 0',
  'a=control:trackID=t2',
  'a=rtpmap:0 PCMU/8000',
  'b=AS:64',
  'm=application 0 RTP/AVP 107',
  'a=control:trackID=3',
  'a=rtpmap:107 vnd.onvif.metadata/1000',
  ''
].join('\r\n');

const describeResponse =
  'RTSP/1.0 200 OK\r\nCSeq: 2\r\nContent-Base: rtsp://192.168.1.100/profile1/\r\nContent-Type: application/sdp\r\nContent-Length: ' +
  sdpBody.length +
  '\r\n\r\n' +
  sdpBody;

describe('RtspClient parity with the legacy player’s Network/RTSPoverWebsocket/rtspClient.js', () => {
  describe('parseDescribeResponse', () => {
    it('parses origin/connection/session-level and per-media SDP fields identically', () => {
      const legacy = newLegacy();
      const ported = newPorted();
      expect(ported.parseDescribeResponse(describeResponse)).toEqual(legacy.parseDescribeResponse(describeResponse));
    });

    it('throws the same RTSPOverWebSocketError-shaped error for an unsupported SDP version', () => {
      const legacy = newLegacy();
      const ported = newPorted();
      const badSdp = 'v=1\r\no=- 1 1 IN IP4 1.2.3.4\r\n';
      let legacyMessage = '';
      let portedMessage = '';
      try {
        legacy.parseDescribeResponse(badSdp);
      } catch (error) {
        legacyMessage = (error as Error).message;
      }
      try {
        ported.parseDescribeResponse(badSdp);
      } catch (error) {
        portedMessage = (error as Error).message;
      }
      expect(portedMessage).toBe(legacyMessage);
      expect(portedMessage).not.toBe('');
    });
  });

  describe('parseRtspResponse', () => {
    it('delegates to parseDescribeResponse for a 200 OK DESCRIBE response identically', () => {
      const legacy = newLegacy();
      const ported = newPorted();
      expect(ported.parseRtspResponse(describeResponse)).toEqual(legacy.parseRtspResponse(describeResponse));
    });

    it('parses Session/Transport/Public headers for a 200 OK SETUP response identically', () => {
      const legacy = newLegacy();
      const ported = newPorted();
      const setupResponse =
        'RTSP/1.0 200 OK\r\nCSeq: 3\r\nSession: 638a99d24ab3c501;timeout=60\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\nPublic: OPTIONS,DESCRIBE,SETUP,PLAY,PAUSE,TEARDOWN,GET_PARAMETER\r\n\r\n';
      expect(ported.parseRtspResponse(setupResponse)).toEqual(legacy.parseRtspResponse(setupResponse));
    });

    it('parses RTP-Info for a 200 OK PLAY response identically', () => {
      const legacy = newLegacy();
      const ported = newPorted();
      const playResponse =
        'RTSP/1.0 200 OK\r\nCSeq: 4\r\nSession: 638a99d24ab3c501\r\nRTP-Info: url=rtsp://192.168.1.100/profile1/trackID=1;seq=12345,url=rtsp://192.168.1.100/profile1/trackID=t2;seq=6789\r\n\r\n';
      expect(ported.parseRtspResponse(playResponse)).toEqual(legacy.parseRtspResponse(playResponse));
    });

    it('parses the WWW-Authenticate challenge for a 401 response identically', () => {
      const legacy = newLegacy();
      const ported = newPorted();
      const unauthorized =
        'RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\nWWW-Authenticate: Digest realm="HanwhaVision", nonce="abc123nonce", qop="auth", algorithm="MD5", opaque="5ccc069c403ebaf9f0171e9517f40e41"\r\n\r\n';
      expect(ported.parseRtspResponse(unauthorized)).toEqual(legacy.parseRtspResponse(unauthorized));
    });

    it('leaves ResponseCode/ResponseMessage undefined for a malformed status line identically', () => {
      const legacy = newLegacy();
      const ported = newPorted();
      const malformed = 'not a real rtsp response\r\n\r\n';
      expect(ported.parseRtspResponse(malformed)).toEqual(legacy.parseRtspResponse(malformed));
    });
  });

  describe('parseWWWAuthenticate', () => {
    it('parses a full Digest challenge identically', () => {
      const legacy = newLegacy();
      const ported = newPorted();
      const challenge = 'Digest realm="HanwhaVision", nonce="abc123nonce", qop="auth", algorithm="MD5", opaque="5ccc069c403ebaf9f0171e9517f40e41"';
      expect(ported.parseWWWAuthenticate(challenge)).toEqual(legacy.parseWWWAuthenticate(challenge));
    });

    it('parses a Basic challenge (no realm/nonce/qop) identically', () => {
      const legacy = newLegacy();
      const ported = newPorted();
      const challenge = 'Basic realm="HanwhaVision"';
      expect(ported.parseWWWAuthenticate(challenge)).toEqual(legacy.parseWWWAuthenticate(challenge));
    });
  });

  describe('toStringExtensionScale', () => {
    it('formats a string value verbatim, identically', () => {
      const legacy = newLegacy();
      const ported = newPorted();
      expect(ported.toStringExtensionScale('2.500000')).toBe(legacy.toStringExtensionScale('2.500000'));
    });

    it('formats a zero scale with a forward-direction sign identically', () => {
      const legacy = newLegacy();
      const ported = newPorted();
      expect(ported.toStringExtensionScale(0, 'forward')).toBe(legacy.toStringExtensionScale(0, 'forward'));
    });

    it('formats a zero scale with a backward-direction sign identically', () => {
      const legacy = newLegacy();
      const ported = newPorted();
      expect(ported.toStringExtensionScale(0, 'backward')).toBe(legacy.toStringExtensionScale(0, 'backward'));
    });

    it('formats a zero scale with no direction identically', () => {
      const legacy = newLegacy();
      const ported = newPorted();
      expect(ported.toStringExtensionScale(0)).toBe(legacy.toStringExtensionScale(0));
    });

    it('formats a non-zero numeric scale identically', () => {
      const legacy = newLegacy();
      const ported = newPorted();
      expect(ported.toStringExtensionScale(-2)).toBe(legacy.toStringExtensionScale(-2));
      expect(ported.toStringExtensionScale(1.5)).toBe(legacy.toStringExtensionScale(1.5));
    });
  });

  describe('getSessionId', () => {
    it('returns -1 when no rtpClient has been set, identically', () => {
      const legacy = newLegacy();
      const ported = newPorted();
      expect(ported.getSessionId()).toBe(legacy.getSessionId());
    });

    it('returns the video session id (preferred over audio/meta) when no interleavedId is given, identically', () => {
      const legacy = newLegacy();
      const ported = newPorted();
      const fakeRtpClient: RtpClientLike = {
        running: false,
        getRtpSession: () => null,
        getRtpSessionWithType: (type: string): RtpSessionLike | null => {
          if (type === 'video') return { type: 'video', sessionId: 'vid-session-1', getStatisticsTimer: () => null };
          if (type === 'audio') return { type: 'audio', sessionId: 'aud-session-1', getStatisticsTimer: () => null };
          return null;
        },
        sendSdpInfo: () => {},
        addListener: () => {},
        sendRtpData: () => {},
        close: () => {}
      };
      legacy.rtpClient = fakeRtpClient;
      ported.rtpClient = fakeRtpClient;
      expect(ported.getSessionId()).toBe(legacy.getSessionId());
    });

    it('returns the session for a given interleavedId, identically', () => {
      const legacy = newLegacy();
      const ported = newPorted();
      const fakeRtpClient: RtpClientLike = {
        running: false,
        getRtpSession: (interleavedId: number) =>
          interleavedId === 2 ? { type: 'audio', sessionId: 'by-interleave', getStatisticsTimer: () => null } : null,
        getRtpSessionWithType: () => null,
        sendSdpInfo: () => {},
        addListener: () => {},
        sendRtpData: () => {},
        close: () => {}
      };
      legacy.rtpClient = fakeRtpClient;
      ported.rtpClient = fakeRtpClient;
      expect(ported.getSessionId(2)).toBe(legacy.getSessionId(2));
      expect(ported.getSessionId(99)).toBe(legacy.getSessionId(99));
    });
  });

  describe('getCurrentState', () => {
    it('starts in the same initial state', () => {
      const legacy = newLegacy();
      const ported = newPorted();
      expect(ported.getCurrentState()).toBe(legacy.getCurrentState());
    });
  });

  // Not a legacy-parity case: the legacy source was never exercised against
  // this SDP variant, so there is nothing to compare it to. MediaMTX's g726
  // encoder (used by this repo's own demo server) announces G.726 as
  // "AAL2-G726-32" rather than the bare "G726-32" real hardware sends, which
  // the codec-name assignment in RtspResponseHandler's Describe branch used
  // to match with `===` only — silently dropping the audio track (no
  // G726Session ever got created) instead of erroring, because the SETUP
  // sequence itself doesn't depend on codecName being resolved.
  describe('RtspResponseHandler — audio codec-name recognition', () => {
    function describeResponseWithAudio(rtpmapLine: string): string {
      const sdp = [
        'v=0',
        'o=- 0 0 IN IP4 127.0.0.1',
        's=No Name',
        'c=IN IP4 0.0.0.0',
        't=0 0',
        'm=audio 0 RTP/AVP 97',
        'a=control:trackID=1',
        rtpmapLine,
        ''
      ].join('\r\n');
      return `RTSP/1.0 200 OK\r\nCSeq: 1\r\nContent-Base: rtsp://127.0.0.1/session/\r\nContent-Type: application/sdp\r\nContent-Length: ${sdp.length}\r\n\r\n${sdp}`;
    }

    function sdpInfoFor(rtpmapLine: string): { codecName?: string; codecMime?: string } {
      const ported = newPorted() as unknown as {
        currentState: string;
        errorCallbackFunc: () => void;
        RtspResponseHandler(message: string): void;
        SDPinfo: { codecName?: string; codecMime?: string }[];
      };
      ported.currentState = 'Describe';
      ported.errorCallbackFunc = () => {};
      ported.RtspResponseHandler(describeResponseWithAudio(rtpmapLine));
      return ported.SDPinfo[0];
    }

    it('recognizes the bare RFC 3551 G.726 name ("G726-32"), matching real-camera SDP', () => {
      expect(sdpInfoFor('a=rtpmap:97 G726-32/8000').codecName).toBe('G.726-32');
    });

    it('also recognizes the AAL2-mode name ("AAL2-G726-32") MediaMTX/ffmpeg announces', () => {
      expect(sdpInfoFor('a=rtpmap:97 AAL2-G726-32/8000').codecName).toBe('G.726-32');
    });

    it('recognizes AAL2-mode names for the other three G.726 bitrates', () => {
      expect(sdpInfoFor('a=rtpmap:97 AAL2-G726-16/8000').codecName).toBe('G.726-16');
      expect(sdpInfoFor('a=rtpmap:97 AAL2-G726-24/8000').codecName).toBe('G.726-24');
      expect(sdpInfoFor('a=rtpmap:97 AAL2-G726-40/8000').codecName).toBe('G.726-40');
    });
  });
});
