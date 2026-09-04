import { describe, expect, it, vi } from 'vitest';
import { createDebugLogger, isDebugEnabled, parseDebugAttribute, validateDebugConfig } from './debugLog';

describe('parseDebugAttribute', () => {
  it('parses a valid JSON object into a DebugConfig', () => {
    expect(parseDebugAttribute('{"mediaSession":true,"network":["RtspClient"]}')).toEqual({
      mediaSession: true,
      network: ['RtspClient']
    });
  });

  it('throws on malformed JSON', () => {
    expect(() => parseDebugAttribute('{not json')).toThrow(/not valid JSON/);
  });

  it('throws on a non-object JSON value', () => {
    expect(() => parseDebugAttribute('"mediaSession"')).toThrow(/must be a JSON object/);
    expect(() => parseDebugAttribute('42')).toThrow(/must be a JSON object/);
    expect(() => parseDebugAttribute('["mediaSession"]')).toThrow(/must be a JSON object/);
    expect(() => parseDebugAttribute('null')).toThrow(/must be a JSON object/);
  });
});

describe('validateDebugConfig', () => {
  it('accepts every recognized subsystem key as boolean or string array', () => {
    const input = { mediaSession: true, network: false, listen: ['AudioPlayer'], video: true, backup: [] };
    expect(validateDebugConfig(input)).toEqual(input);
  });

  it('accepts the "*" wildcard key', () => {
    expect(validateDebugConfig({ '*': true })).toEqual({ '*': true });
  });

  it('throws on an unrecognized top-level key', () => {
    expect(() => validateDebugConfig({ vendor: true })).toThrow(/unrecognized key "vendor"/);
    expect(() => validateDebugConfig({ typo: true })).toThrow(/unrecognized key "typo"/);
  });

  it('throws when a subsystem value is neither boolean nor a string array', () => {
    expect(() => validateDebugConfig({ mediaSession: 'true' })).toThrow(/must be a boolean or an array/);
    expect(() => validateDebugConfig({ network: [1, 2] })).toThrow(/must be a boolean or an array/);
    expect(() => validateDebugConfig({ video: { on: true } })).toThrow(/must be a boolean or an array/);
  });

  it('throws when the "*" value is not a boolean', () => {
    expect(() => validateDebugConfig({ '*': ['mediaSession'] })).toThrow(/"\*"\] must be a boolean/);
  });
});

describe('isDebugEnabled', () => {
  it('is false for a null/undefined config', () => {
    expect(isDebugEnabled(null, 'video', 'VideoTagPlayer')).toBe(false);
    expect(isDebugEnabled(undefined, 'video', 'VideoTagPlayer')).toBe(false);
  });

  it('is false when the subsystem key is absent or false', () => {
    expect(isDebugEnabled({}, 'video', 'VideoTagPlayer')).toBe(false);
    expect(isDebugEnabled({ video: false }, 'video', 'VideoTagPlayer')).toBe(false);
  });

  it('is true for every component when the subsystem is `true`', () => {
    expect(isDebugEnabled({ video: true }, 'video', 'VideoTagPlayer')).toBe(true);
    expect(isDebugEnabled({ video: true }, 'video', 'CanvasTagPlayer')).toBe(true);
  });

  it('is true only for named components when the subsystem is a string array', () => {
    const config = { network: ['RtspClient'] };
    expect(isDebugEnabled(config, 'network', 'RtspClient')).toBe(true);
    expect(isDebugEnabled(config, 'network', 'AttributeService')).toBe(false);
  });

  it('the "*" wildcard overrides every subsystem, enabled or not', () => {
    expect(isDebugEnabled({ '*': true }, 'backup', 'FileMaker')).toBe(true);
    expect(isDebugEnabled({ '*': true, video: false }, 'video', 'VideoTagPlayer')).toBe(true);
  });
});

describe('createDebugLogger', () => {
  it('returns a no-op function when the component is not enabled', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = createDebugLogger(null, 'video', 'VideoTagPlayer');
    log('should not print');
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('returns a console.log-backed function prefixed with the component name when enabled', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = createDebugLogger({ video: ['VideoTagPlayer'] }, 'video', 'VideoTagPlayer');
    log('updateend #1', { foo: 'bar' });
    expect(consoleSpy).toHaveBeenCalledWith('[VideoTagPlayer]', 'updateend #1', { foo: 'bar' });
    consoleSpy.mockRestore();
  });
});
