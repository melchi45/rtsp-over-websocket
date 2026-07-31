import { describe, it, expect } from 'vitest';
import { loadLegacyModule } from '../test-support/loadLegacyModule';
import { createNoopLoggerGlobal } from '../test-support/legacyGlobals';
import { RtspStatusCode } from './RtspStatusCode';

interface LegacyRtspStatusCode {
  getDescription(): string;
  getStatusCode(): number;
  getName(): string;
  getObject(): unknown;
}

// rtspStatusCode.js calls `window.log.getLogger("rtspstatus")` — dead-code-only logger, stubbed.
const LegacyRtspStatusCodeCtor = loadLegacyModule<new (code: number) => LegacyRtspStatusCode>(
  'Network/rtspStatusCode.js',
  'RtspStatusCode',
  { log: createNoopLoggerGlobal() }
);

describe('RtspStatusCode parity with the legacy player’s Network/rtspStatusCode.js', () => {
  it.each([100, 200, 404, 454, 500, 702, -1, 9999])('code %s resolves to the same description/name/object', (code) => {
    const legacy = new LegacyRtspStatusCodeCtor(code);
    const ported = new RtspStatusCode(code);
    expect(ported.getDescription()).toBe(legacy.getDescription());
    expect(ported.getStatusCode()).toBe(legacy.getStatusCode());
    expect(ported.getName()).toBe(legacy.getName());
    expect(ported.getObject()).toEqual(legacy.getObject());
  });
});
