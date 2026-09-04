import { describe, expect, it, vi } from 'vitest';
import { createDebugLogger, isDebugEnabled, isLevelEnabled, parseDebugAttribute, validateDebugConfig } from './debugLog';

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

  it('accepts a valid "level" key', () => {
    expect(validateDebugConfig({ level: 'warning' })).toEqual({ level: 'warning' });
    expect(validateDebugConfig({ level: 'debug', video: true })).toEqual({ level: 'debug', video: true });
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

  it('throws when "level" is not one of the four recognized strings', () => {
    expect(() => validateDebugConfig({ level: 'trace' })).toThrow(/"level"\] must be one of/);
    expect(() => validateDebugConfig({ level: 123 })).toThrow(/"level"\] must be one of/);
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

  it('mediaSession group aliases expand to their member classes', () => {
    const videoGroup = { mediaSession: ['videoSession'] };
    expect(isDebugEnabled(videoGroup, 'mediaSession', 'H264Session')).toBe(true);
    expect(isDebugEnabled(videoGroup, 'mediaSession', 'MjpegSession')).toBe(true);
    expect(isDebugEnabled(videoGroup, 'mediaSession', 'AACSession')).toBe(false);
    expect(isDebugEnabled(videoGroup, 'mediaSession', 'MediaRouter')).toBe(false);

    const audioGroup = { mediaSession: ['audioSession'] };
    expect(isDebugEnabled(audioGroup, 'mediaSession', 'AACSession')).toBe(true);
    expect(isDebugEnabled(audioGroup, 'mediaSession', 'AudioTalkSession')).toBe(true);
    expect(isDebugEnabled(audioGroup, 'mediaSession', 'H264Session')).toBe(false);

    const textGroup = { mediaSession: ['textSession'] };
    expect(isDebugEnabled(textGroup, 'mediaSession', 'MetaSession')).toBe(true);
    expect(isDebugEnabled(textGroup, 'mediaSession', 'RTCPSession')).toBe(false);

    const rtcpGroup = { mediaSession: ['rtcpSession'] };
    expect(isDebugEnabled(rtcpGroup, 'mediaSession', 'RTCPSession')).toBe(true);
    expect(isDebugEnabled(rtcpGroup, 'mediaSession', 'H264Session')).toBe(false);

    // rtpSession covers video+audio+text combined, but not RTCPSession or MediaRouter/RtpClient/MetaDataParser.
    const rtpGroup = { mediaSession: ['rtpSession'] };
    expect(isDebugEnabled(rtpGroup, 'mediaSession', 'H264Session')).toBe(true);
    expect(isDebugEnabled(rtpGroup, 'mediaSession', 'AACSession')).toBe(true);
    expect(isDebugEnabled(rtpGroup, 'mediaSession', 'MetaSession')).toBe(true);
    expect(isDebugEnabled(rtpGroup, 'mediaSession', 'RTCPSession')).toBe(false);
    expect(isDebugEnabled(rtpGroup, 'mediaSession', 'MediaRouter')).toBe(false);
  });

  it('group aliases are individual literal component names, not a group', () => {
    expect(isDebugEnabled({ mediaSession: ['H264Session'] }, 'mediaSession', 'H264Session')).toBe(true);
  });

  it('group aliases only apply to the mediaSession subsystem, not others', () => {
    // "videoSession" isn't a recognized name/alias under the `video` subsystem (that group uses
    // different class names entirely, e.g. VideoTagPlayer) -- confirms no accidental cross-subsystem leakage.
    expect(isDebugEnabled({ video: ['videoSession'] }, 'video', 'VideoTagPlayer')).toBe(false);
  });

  it('a group alias combines with individual class names in the same array', () => {
    const config = { mediaSession: ['videoSession', 'RTCPSession'] };
    expect(isDebugEnabled(config, 'mediaSession', 'H265Session')).toBe(true);
    expect(isDebugEnabled(config, 'mediaSession', 'RTCPSession')).toBe(true);
    expect(isDebugEnabled(config, 'mediaSession', 'AACSession')).toBe(false);
  });

  it('the "*" wildcard overrides every subsystem, enabled or not', () => {
    expect(isDebugEnabled({ '*': true }, 'backup', 'FileMaker')).toBe(true);
    expect(isDebugEnabled({ '*': true, video: false }, 'video', 'VideoTagPlayer')).toBe(true);
  });
});

describe('isLevelEnabled', () => {
  it('defaults the threshold to "warning" when config/level is absent', () => {
    expect(isLevelEnabled(null, 'debug')).toBe(false);
    expect(isLevelEnabled({}, 'debug')).toBe(false);
    expect(isLevelEnabled(null, 'info')).toBe(false);
    expect(isLevelEnabled({}, 'info')).toBe(false);
    expect(isLevelEnabled(null, 'warning')).toBe(true);
    expect(isLevelEnabled(null, 'error')).toBe(true);
  });

  it('threshold "debug" lets every level through', () => {
    const config = { level: 'debug' as const };
    expect(isLevelEnabled(config, 'debug')).toBe(true);
    expect(isLevelEnabled(config, 'info')).toBe(true);
    expect(isLevelEnabled(config, 'warning')).toBe(true);
    expect(isLevelEnabled(config, 'error')).toBe(true);
  });

  it('threshold "warning" suppresses debug/info but lets warning/error through', () => {
    const config = { level: 'warning' as const };
    expect(isLevelEnabled(config, 'debug')).toBe(false);
    expect(isLevelEnabled(config, 'info')).toBe(false);
    expect(isLevelEnabled(config, 'warning')).toBe(true);
    expect(isLevelEnabled(config, 'error')).toBe(true);
  });

  it('threshold "error" lets only error through', () => {
    const config = { level: 'error' as const };
    expect(isLevelEnabled(config, 'debug')).toBe(false);
    expect(isLevelEnabled(config, 'info')).toBe(false);
    expect(isLevelEnabled(config, 'warning')).toBe(false);
    expect(isLevelEnabled(config, 'error')).toBe(true);
  });
});

describe('createDebugLogger', () => {
  it('returns an all-no-op logger when the component is not enabled, regardless of level', () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createDebugLogger({ level: 'debug' }, 'video', 'VideoTagPlayer');
    logger.debug('a');
    logger.info('b');
    logger.warning('c');
    logger.error('d');
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    consoleLog.mockRestore();
    consoleWarn.mockRestore();
    consoleError.mockRestore();
  });

  it('the per-component gate and the level threshold are independent -- enabled component still filters by level', () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // default threshold is 'warning': debug/info are enabled-but-filtered, only warning/error print.
    const logger = createDebugLogger({ video: ['VideoTagPlayer'] }, 'video', 'VideoTagPlayer');
    logger.debug('suppressed');
    logger.info('suppressed too');
    logger.warning('shown');
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    expect(consoleWarn).toHaveBeenCalledWith('%c[VideoTagPlayer]', 'color:#b58900;font-weight:bold', 'shown');
    consoleLog.mockRestore();
    consoleWarn.mockRestore();
  });

  it('debug/info print via console.log with no style argument', () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createDebugLogger({ level: 'debug', video: ['VideoTagPlayer'] }, 'video', 'VideoTagPlayer');
    logger.debug('updateend #1', { foo: 'bar' });
    logger.info('info message');
    expect(consoleLog).toHaveBeenNthCalledWith(1, '[VideoTagPlayer]', 'updateend #1', { foo: 'bar' });
    expect(consoleLog).toHaveBeenNthCalledWith(2, '[VideoTagPlayer]', 'info message');
    consoleLog.mockRestore();
  });

  it('warning prints via console.warn with a yellow %c style', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logger = createDebugLogger({ level: 'debug', video: ['VideoTagPlayer'] }, 'video', 'VideoTagPlayer');
    logger.warning('careful');
    expect(consoleWarn).toHaveBeenCalledWith('%c[VideoTagPlayer]', 'color:#b58900;font-weight:bold', 'careful');
    consoleWarn.mockRestore();
  });

  it('error prints via console.error with a red %c style', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createDebugLogger({ level: 'debug', video: ['VideoTagPlayer'] }, 'video', 'VideoTagPlayer');
    logger.error('broken');
    expect(consoleError).toHaveBeenCalledWith('%c[VideoTagPlayer]', 'color:#dc2626;font-weight:bold', 'broken');
    consoleError.mockRestore();
  });
});
