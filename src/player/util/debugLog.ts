/**
 * Per-component `console.log` tracing, gated by the `debug` attribute/property on
 * `RTSPOverWebSocket.ts`. See docs/player/08-util.md and docs/player/01-elements-interface-exceptions.md
 * for the full design (propagation chain, why setters rather than constructor params, why class
 * names are hardcoded string literals rather than `constructor.name`).
 *
 * This is the only file in the debug-logging feature allowed to call `console.log` directly --
 * every consuming class calls the gated function `createDebugLogger()` returns instead, so no
 * other file needs its own `// eslint-disable-next-line no-console`.
 */

/** The six subsystems a component can be grouped under. `vendor/` is deliberately excluded --
 *  it has no real runtime classes (plain functions / minified Emscripten glue), nothing to gate. */
export type DebugSubsystem = 'mediaSession' | 'network' | 'listen' | 'video' | 'backup';

const DEBUG_SUBSYSTEMS: readonly DebugSubsystem[] = ['mediaSession', 'network', 'listen', 'video', 'backup'];

/** `true` enables every component under the subsystem; a string array enables only the named
 *  components (exact, case-sensitive match against the literal name each component's own `set
 *  debug()` passes to `createDebugLogger()`). Absent/`false` leaves the subsystem silent. */
export type DebugTarget = boolean | string[];

export type DebugConfig = {
  [K in DebugSubsystem]?: DebugTarget;
} & {
  /** Shortcut: enables every component in every subsystem, overriding individual keys. */
  '*'?: boolean;
};

function isDebugTarget(value: unknown): value is DebugTarget {
  return typeof value === 'boolean' || (Array.isArray(value) && value.every((v) => typeof v === 'string'));
}

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
    if (!DEBUG_SUBSYSTEMS.includes(key as DebugSubsystem)) {
      throw new Error(`debug has unrecognized key "${key}" -- expected one of ${DEBUG_SUBSYSTEMS.join(', ')}, or "*"`);
    }
    const target = input[key];
    if (!isDebugTarget(target)) {
      throw new Error(`debug["${key}"] must be a boolean or an array of component-name strings`);
    }
    result[key as DebugSubsystem] = target;
  }
  return result;
}

/** True if `componentName` under `subsystem` should log, per `config`. `config` of `null`/
 *  `undefined` (the default, `debug` attribute never set) always resolves to `false`. */
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
  return target.includes(componentName);
}

/**
 * Returns a `console.log`-backed function prefixed `[componentName]`, or a no-op when
 * `componentName` isn't enabled in `config` -- resolved once at call time (not memoized), since
 * each consuming class re-creates its logger every time its own `set debug()` runs.
 */
export function createDebugLogger(config: DebugConfig | null | undefined, subsystem: DebugSubsystem, componentName: string): (...args: unknown[]) => void {
  if (!isDebugEnabled(config, subsystem, componentName)) {
    return () => {};
  }
  return (...args: unknown[]) => {
    // eslint-disable-next-line no-console
    console.log(`[${componentName}]`, ...args);
  };
}
