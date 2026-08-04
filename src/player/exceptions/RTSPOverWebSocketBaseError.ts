/**
 * Shared construction logic for this library's error hierarchy.
 *
 * Ported from the legacy player’s Exception/{RTSPOverWebSocketError,AuthError,RTCPError,RTSPError,SunapiError},
 * which were five independently copy-pasted IIFEs implementing identical
 * `arguments`-based construction logic. The legacy constructors also support a
 * variadic `(messageTemplate, ...interpolationArgs)` calling form, but a
 * repository-wide search of every `new <X>Error(...)` call site found the
 * options-object form — `new SunapiError({ message, channelId, elementId, errorCode, place })`
 * — is the only form actually used anywhere in the codebase. This port narrows
 * the public constructor to that form; the parity tests exercise it exactly as
 * production code does.
 */
export interface RTSPOverWebSocketErrorOptions {
  message?: string;
  channelId?: number;
  elementId?: string;
  errorCode?: number;
  place?: string;
}

export abstract class RTSPOverWebSocketBaseError extends Error {
  readonly channel?: number;
  readonly element?: string;
  readonly errorCode?: number;
  readonly place?: string;

  protected constructor(errorName: string, options: RTSPOverWebSocketErrorOptions = {}) {
    // Legacy behavior: when `message` is omitted, `new Error(undefined).message`
    // resolves to '' (not the "An exception has occurred" fallback — that fallback
    // lived on the unused variadic-args code path). Preserved as-is here.
    super(options.message);
    this.name = errorName;
    this.channel = options.channelId;
    this.element = options.elementId;
    this.errorCode = options.errorCode;
    this.place = options.place;
    // Restores the prototype chain when `Error` is subclassed under downlevel
    // (pre-ES2015) compilation targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
