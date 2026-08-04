import { describe, it, expect } from 'vitest';
import { loadLegacyModule } from '../test-support/loadLegacyModule';
import { createNoopLoggerGlobal } from '../test-support/legacyGlobals';
import { WebsocketStatusCode } from './WebsocketStatusCode';

interface LegacyWebsocketStatusCode {
  getDescription(): string;
  getStatusCode(): number;
  getName(): string;
  getObject(): unknown;
}

const LegacyWebsocketStatusCodeCtor = loadLegacyModule<new (code: number) => LegacyWebsocketStatusCode>(
  'Network/websocketStatusCode.js',
  'WebsocketStatusCode',
  { log: createNoopLoggerGlobal() }
);

describe('WebsocketStatusCode parity with the legacy player’s Network/websocketStatusCode.js', () => {
  it.each([500, 1000, 1006, 1012, 1500, 2500, 3500, 4500, 12592, 9999999])(
    'code %s resolves to the same description/name/object',
    (code) => {
      const legacy = new LegacyWebsocketStatusCodeCtor(code);
      const ported = new WebsocketStatusCode(code);
      expect(ported.getDescription()).toBe(legacy.getDescription());
      expect(ported.getStatusCode()).toBe(legacy.getStatusCode());
      expect(ported.getName()).toBe(legacy.getName());
      expect(ported.getObject()).toEqual(legacy.getObject());
    }
  );

  it('code 1004 diverges intentionally (legacy crashes on a table-key typo; port resolves it)', () => {
    expect(() => new LegacyWebsocketStatusCodeCtor(1004).getStatusCode()).toThrow();
    const ported = new WebsocketStatusCode(1004);
    expect(ported.getStatusCode()).toBe(1004);
    expect(ported.getName()).toBe('Reserved');
  });
});
