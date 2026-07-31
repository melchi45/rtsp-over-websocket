import { describe, it, expect } from 'vitest';
import { loadLegacyModule } from '../../test-support/loadLegacyModule';
import { SunapiException } from './SunapiException';

interface LegacySunapiException {
  name?: string;
  message?: string;
  toString(): string;
}

const LegacySunapiExceptionCtor = loadLegacyModule<new () => LegacySunapiException>(
  'Network/http/sunapiException.js',
  'sunapiException'
);

describe('SunapiException parity with the legacy player’s Network/http/sunapiException.js', () => {
  it('toString() falls back to "unknown"/"no description" when unset', () => {
    const legacy = new LegacySunapiExceptionCtor();
    const ported = new SunapiException();
    expect(ported.toString()).toBe(legacy.toString());
    expect(ported.toString()).toBe('[unknown] no description');
  });

  it('toString() reflects name/message when set', () => {
    const legacy = new LegacySunapiExceptionCtor();
    legacy.name = 'SunapiError';
    legacy.message = 'device offline';
    const ported = new SunapiException();
    ported.name = 'SunapiError';
    ported.message = 'device offline';
    expect(ported.toString()).toBe(legacy.toString());
  });
});
