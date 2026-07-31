import { describe, it, expect } from 'vitest';
import { loadLegacyModule } from '../../test-support/loadLegacyModule';
import { HTTP_STATUS_CODES } from './HttpStatusCode';

const legacy = loadLegacyModule<Record<string, string>>('Network/http/httpStatusCode.js', 'HTTP_STATUS_CODES');

describe('HTTP_STATUS_CODES parity with the legacy player’s Network/http/httpStatusCode.js', () => {
  it('matches every key/value pair', () => {
    expect(HTTP_STATUS_CODES).toEqual(legacy);
  });
});
