/**
 * Per-component `console.log` tracing, gated by the `debug` attribute/property on
 * `RTSPOverWebSocket.ts`. See docs/player/08-util.md and docs/player/01-elements-interface-exceptions.md
 * for the full design (propagation chain, why setters rather than constructor params, why class
 * names are hardcoded string literals rather than `constructor.name`, and the level-threshold +
 * per-component-gate interaction).
 *
 * This is the only file in the debug-logging feature allowed to call `console.*` directly --
 * every consuming class calls the gated `DebugLogger` `createDebugLogger()` returns instead, so no
 * other file needs its own `// eslint-disable-next-line no-console`.
 */

/** The six subsystems a component can be grouped under. `vendor/` is deliberately excluded --
 *  it has no real runtime classes (plain functions / minified Emscripten glue), nothing to gate. */
export type DebugSubsystem = 'mediaSession' | 'network' | 'listen' | 'video' | 'backup';

const DEBUG_SUBSYSTEMS: readonly DebugSubsystem[] = ['mediaSession', 'network', 'listen', 'video', 'backup'];

/** `true` enables every component under the subsystem; a string array enables only the named
 *  components (exact, case-sensitive match against the literal name each component's own `set
 *  debug()` passes to `createDebugLogger()`). Absent/`false` leaves the subsystem silent. Under
 *  `mediaSession` specifically, an array entry may also be a group alias (`"videoSession"`,
 *  `"audioSession"`, `"textSession"`, `"rtpSession"`, `"rtcpSession"`) instead of an individual
 *  class name -- see `MEDIA_SESSION_GROUPS`. */
export type DebugTarget = boolean | string[];

/** Severity order: `debug` < `info` < `warning` < `error`. A call at level `L` only prints once a
 *  component is enabled (see `isDebugEnabled`) AND `L`'s severity meets or exceeds the configured
 *  `level` threshold (default `'info'` when omitted -- see `DEFAULT_LOG_LEVEL`). This is a second,
 *  independent gate layered on top of the per-component enable check, not a replacement for it: an
 *  `error`-level call from a component that was never named in the `debug` config still prints
 *  nothing. Unrelated to, and doesn't change, this codebase's existing raw `console.error(...)`
 *  calls for real errors elsewhere -- those stay untouched and always-on, as before this feature
 *  existed. */
export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warning', 'error'];
const LOG_LEVEL_SEVERITY: Record<LogLevel, number> = { debug: 0, info: 1, warning: 2, error: 3 };
const DEFAULT_LOG_LEVEL: LogLevel = 'info';

export type DebugConfig = {
  [K in DebugSubsystem]?: DebugTarget;
} & {
  /** Shortcut: enables every component in every subsystem, overriding individual keys. */
  '*'?: boolean;
  /** Global severity threshold, applied uniformly across every enabled component -- not
   *  per-subsystem. Defaults to `'info'` when omitted. */
  level?: LogLevel;
};

/** One gated logging function per level. Every consuming class stores one of these (or
 *  `NOOP_DEBUG_LOGGER`) instead of a bare function -- see this file's own header comment and
 *  `createDebugLogger()`. */
export interface DebugLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warning(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** Shared no-op instance -- the default value for every class's logger field before `set debug()`/
 *  `setDebugConfig()` first runs, and what `createDebugLogger()` effectively behaves as (four
 *  separately no-op methods, not literally this same object) when the component isn't enabled. */
export const NOOP_DEBUG_LOGGER: DebugLogger = {
  debug() {},
  info() {},
  warning() {},
  error() {}
};

function isDebugTarget(value: unknown): value is DebugTarget {
  return typeof value === 'boolean' || (Array.isArray(value) && value.every((v) => typeof v === 'string'));
}

/**
 * `mediaSession`-only group aliases -- convenience shortcuts for `debug["mediaSession"]`'s string
 * array, mirroring the real `mediaSession/` directory split (`videoSession/`, `audioSession/`,
 * `textSession/`, `RtpSession.ts`, `RTCPSession.ts`) rather than requiring every one of that
 * group's individual class names to be listed by hand. Requested directly by the user. No other
 * subsystem has this concept -- `network`/`listen`/`video`/`backup` are flat, single-level
 * groupings already.
 *
 * `"rtpSession"` covers every concrete `RtpSession` subclass (all of `videoSession`+`audioSession`+
 * `textSession` combined); `"rtcpSession"` is `RTCPSession` alone, included purely for symmetry
 * with `"rtpSession"` (it's already directly nameable as `"RTCPSession"`, this is just another
 * spelling for it). These are plain strings, not a new schema shape -- `debug["mediaSession"]`
 * stays a `string[]`, so `validateDebugConfig` needs no changes for this: an alias is valid
 * anywhere a class name is, and only `isDebugEnabled`'s membership check needs to know about it.
 */
const MEDIA_SESSION_VIDEO_SESSION_GROUP = ['H264Session', 'H265Session', 'VP8Session', 'VP9Session', 'AV1Session', 'MjpegSession'];
const MEDIA_SESSION_AUDIO_SESSION_GROUP = ['G711Session', 'G726Session', 'OPUSSession', 'AACSession', 'AudioTalkSession'];
const MEDIA_SESSION_TEXT_SESSION_GROUP = ['MetaSession'];
const MEDIA_SESSION_GROUPS: Readonly<Record<string, readonly string[]>> = {
  videoSession: MEDIA_SESSION_VIDEO_SESSION_GROUP,
  audioSession: MEDIA_SESSION_AUDIO_SESSION_GROUP,
  textSession: MEDIA_SESSION_TEXT_SESSION_GROUP,
  rtcpSession: ['RTCPSession'],
  rtpSession: [...MEDIA_SESSION_VIDEO_SESSION_GROUP, ...MEDIA_SESSION_AUDIO_SESSION_GROUP, ...MEDIA_SESSION_TEXT_SESSION_GROUP]
};

/**
 * Parses and validates the `debug` attribute's JSON string value into a `DebugConfig`. Throws a
 * plain `Error` (not `RTSPOverWebSocketError`) on malformed JSON or an unrecognized shape --
 * `RTSPOverWebSocket.ts`'s `attributeChangedCallback` `case 'debug'` catches this and re-throws as
 * `RTSPOverWebSocketError` (errorCode `0x0414`, the same generic "invalid attribute value" code
 * every other malformed-attribute case already uses), matching how validation is layered
 * elsewhere in this codebase (parsing/shape logic in a plain helper, the element-specific error
 * wrapping at the attribute-case call site).
 */
export function parseDebugAttribute(raw: string): DebugConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`debug attribute is not valid JSON: ${(error as Error).message}`);
  }
  return validateDebugConfig(parsed);
}

/** Shared by `parseDebugAttribute()` (JSON string from the attribute) and the `debug` property
 *  setter (which also accepts an already-parsed object directly). */
export function validateDebugConfig(value: unknown): DebugConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('debug value must be a JSON object');
  }
  const input = value as Record<string, unknown>;
  const result: DebugConfig = {};
  for (const key of Object.keys(input)) {
    if (key === '*') {
      if (typeof input[key] !== 'boolean') {
        throw new Error(`debug["*"] must be a boolean, got ${typeof input[key]}`);
      }
      result['*'] = input[key] as boolean;
      continue;
    }
    if (key === 'level') {
      if (typeof input[key] !== 'string' || !LOG_LEVELS.includes(input[key] as LogLevel)) {
        throw new Error(`debug["level"] must be one of ${LOG_LEVELS.join(', ')}, got ${JSON.stringify(input[key])}`);
      }
      result.level = input[key] as LogLevel;
      continue;
    }
    if (!DEBUG_SUBSYSTEMS.includes(key as DebugSubsystem)) {
      throw new Error(`debug has unrecognized key "${key}" -- expected one of ${DEBUG_SUBSYSTEMS.join(', ')}, "level", or "*"`);
    }
    const target = input[key];
    if (!isDebugTarget(target)) {
      throw new Error(`debug["${key}"] must be a boolean or an array of component-name strings`);
    }
    result[key as DebugSubsystem] = target;
  }
  return result;
}

/** True if `componentName` under `subsystem` should log at all, per `config` -- the per-component
 *  gate, independent of `level` (see `isLevelEnabled`). `config` of `null`/`undefined` (the
 *  default, `debug` attribute never set) always resolves to `false`. */
export function isDebugEnabled(config: DebugConfig | null | undefined, subsystem: DebugSubsystem, componentName: string): boolean {
  if (config === null || typeof config === 'undefined') {
    return false;
  }
  if (config['*'] === true) {
    return true;
  }
  const target = config[subsystem];
  if (typeof target === 'undefined' || target === false) {
    return false;
  }
  if (target === true) {
    return true;
  }
  if (target.includes(componentName)) {
    return true;
  }
  // mediaSession-only: expand any group alias (videoSession/audioSession/textSession/rtpSession/
  // rtcpSession) present in the array -- see MEDIA_SESSION_GROUPS' own comment.
  if (subsystem === 'mediaSession') {
    return target.some((entry) => MEDIA_SESSION_GROUPS[entry]?.includes(componentName) ?? false);
  }
  return false;
}

/** True if `level`'s severity meets or exceeds `config`'s configured threshold (default `'info'`
 *  when `config`/`config.level` is absent). Independent of, and always checked alongside,
 *  `isDebugEnabled()` -- see `LogLevel`'s own doc comment for why these are two separate gates. */
export function isLevelEnabled(config: DebugConfig | null | undefined, level: LogLevel): boolean {
  const threshold = config?.level ?? DEFAULT_LOG_LEVEL;
  return LOG_LEVEL_SEVERITY[level] >= LOG_LEVEL_SEVERITY[threshold];
}

/**
 * Returns a `DebugLogger` -- four independently-gated methods, one per `LogLevel` -- for
 * `componentName` under `subsystem`. Each method is a real no-op (not just silently skipped
 * output) when either gate fails, resolved once per call (not memoized), since each consuming
 * class re-creates its logger every time its own `set debug()`/`setDebugConfig()` runs.
 *
 * `debug`/`info` print via `console.log`, unstyled. `warning`/`error` print via `console.warn`/
 * `console.error` (so DevTools' own Warnings/Errors filters still work) with a `%c` CSS style
 * coloring the `[componentName]` tag yellow/red respectively -- `%c` only colors the literal
 * string segment it applies to; any trailing object/array args still print in the console's normal
 * inspector styling, an inherent Console API limitation, not something to work around here.
 */
export function createDebugLogger(config: DebugConfig | null | undefined, subsystem: DebugSubsystem, componentName: string): DebugLogger {
  const enabled = isDebugEnabled(config, subsystem, componentName);
  if (!enabled) {
    return NOOP_DEBUG_LOGGER;
  }
  const log = (level: LogLevel, ...args: unknown[]): void => {
    if (!isLevelEnabled(config, level)) {
      return;
    }
    switch (level) {
      case 'debug':
      case 'info':
        // eslint-disable-next-line no-console
        console.log(`[${componentName}]`, ...args);
        break;
      case 'warning':
        // eslint-disable-next-line no-console
        console.warn(`%c[${componentName}]`, 'color:#b58900;font-weight:bold', ...args);
        break;
      case 'error':
        // eslint-disable-next-line no-console
        console.error(`%c[${componentName}]`, 'color:#dc2626;font-weight:bold', ...args);
        break;
    }
  };
  return {
    debug: (...args) => log('debug', ...args),
    info: (...args) => log('info', ...args),
    warning: (...args) => log('warning', ...args),
    error: (...args) => log('error', ...args)
  };
}
