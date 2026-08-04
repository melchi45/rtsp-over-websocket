import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadLegacyModule } from '../../test-support/loadLegacyModule';
import { createBaseLegacySandbox, fromHex } from '../../test-support/legacyGlobals';
import { SunapiRestClient, type SunapiInitDeviceInfo } from './SunapiRestClient';

interface LegacySunapiRestClient {
  init(deviceInfo: SunapiInitDeviceInfo): void;
}

const sandbox = {
  ...createBaseLegacySandbox(),
  location: { protocol: 'http:' },
  rtspOverWebSocketError: loadLegacyModule('Exception/RTSPOverWebSocketError.js', 'RTSPOverWebSocketError'),
  fromHex,
  fastJsonStringfy: () => ''
};

const LegacySunapiRestClientCtor = loadLegacyModule<new () => LegacySunapiRestClient>(
  'Network/http/sunapiRestClient.js',
  'sunapiRestClient',
  sandbox
);

function newLegacy(): LegacySunapiRestClient {
  return new LegacySunapiRestClientCtor();
}

function newPorted(): SunapiRestClient {
  return new SunapiRestClient();
}

function errorShape(fn: () => void): { errorCode?: number; place?: string; message?: string } {
  try {
    fn();
  } catch (error) {
    const err = error as { errorCode?: number; place?: string; message?: string };
    return { errorCode: err.errorCode, place: err.place, message: err.message };
  }
  return {};
}

describe('SunapiRestClient parity with the legacy player’s Network/http/sunapiRestClient.js', () => {
  beforeAll(() => {
    (globalThis as unknown as { window: { location: { protocol: string } } }).window = {
      location: { protocol: 'http:' }
    };
  });

  afterAll(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  describe('init', () => {
    it('throws identically when a camera device is missing cameraIp', () => {
      const legacy = newLegacy();
      const ported = newPorted();
      const deviceInfo: SunapiInitDeviceInfo = { deviceType: 'camera', password: 'pw', user: 'admin' };
      expect(errorShape(() => ported.init(deviceInfo))).toEqual(errorShape(() => legacy.init(deviceInfo)));
    });

    it('throws identically when a camera device is missing user', () => {
      const legacy = newLegacy();
      const ported = newPorted();
      const deviceInfo: SunapiInitDeviceInfo = { deviceType: 'camera', cameraIp: '192.168.1.100', password: 'pw' };
      expect(errorShape(() => ported.init(deviceInfo))).toEqual(errorShape(() => legacy.init(deviceInfo)));
    });

    it('throws identically when password is missing', () => {
      const legacy = newLegacy();
      const ported = newPorted();
      const deviceInfo: SunapiInitDeviceInfo = { deviceType: 'camera', cameraIp: '192.168.1.100', user: 'admin' };
      expect(errorShape(() => ported.init(deviceInfo))).toEqual(errorShape(() => legacy.init(deviceInfo)));
    });

    it('throws identically when an nvr device is missing username (hostname check is dead code due to legacy operator precedence)', () => {
      const legacy = newLegacy();
      const ported = newPorted();
      const deviceInfo: SunapiInitDeviceInfo = { deviceType: 'nvr', hostname: '192.168.1.200', password: 'pw' };
      expect(errorShape(() => ported.init(deviceInfo))).toEqual(errorShape(() => legacy.init(deviceInfo)));
    });

    it('does not throw for a well-formed camera device, identically', () => {
      const legacy = newLegacy();
      const ported = newPorted();
      const deviceInfo: SunapiInitDeviceInfo = {
        deviceType: 'camera',
        cameraIp: '192.168.1.100',
        user: 'admin',
        password: 'pw',
        port: 80,
        ClientIPAddress: '10.0.0.5'
      };
      expect(() => legacy.init(deviceInfo)).not.toThrow();
      expect(() => ported.init(deviceInfo)).not.toThrow();
    });

    it('does not throw for a well-formed nvr device, identically', () => {
      const legacy = newLegacy();
      const ported = newPorted();
      const deviceInfo: SunapiInitDeviceInfo = {
        deviceType: 'nvr',
        hostname: '192.168.1.200',
        username: 'admin',
        password: 'pw',
        port: 8443,
        ClientIPAddress: '10.0.0.5'
      };
      expect(() => legacy.init(deviceInfo)).not.toThrow();
      expect(() => ported.init(deviceInfo)).not.toThrow();
    });
  });

  describe('toQueryString (jsonToText)', () => {
    it('formats string/number/boolean fields identically', () => {
      const ported = newPorted();
      const json = { channel: 1, enable: true, disabled: false, name: 'cam-01' };
      // jsonToText is private in legacy (never exposed on the prototype), so
      // this only exercises the ported side directly against the known
      // legacy algorithm — see the source comment on toQueryString.
      expect(ported.toQueryString(json)).toBe('&channel=1&enable=True&disabled=False&name=cam-01');
    });

    it('returns an empty string for an empty object', () => {
      const ported = newPorted();
      expect(ported.toQueryString({})).toBe('');
    });
  });
});
