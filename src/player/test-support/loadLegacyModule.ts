import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const currentDir = dirname(fileURLToPath(import.meta.url));

// legacy-player is the canonical (untouched) legacy player source, expected
// as a nested git submodule at the repo root — it is not checked out in
// every environment (this repo does not vendor it directly), so tests that
// load from it will fail with ENOENT until it's present. Parity tests
// execute the original file text directly so any legacy behavior
// (including bugs/quirks) is compared byte-for-byte against the new
// src/player port, rather than against a hand-copied description of it.
const LEGACY_SOURCE_ROOT = resolve(currentDir, '../../../legacy-player');

export interface LegacySandbox {
  [key: string]: unknown;
}

/**
 * Creates an isolated vm context seeded with `globals`, with the cross-realm
 * fixes every legacy file needs already applied:
 *  - context.Error/Math are shared with the host realm (see inline notes),
 *  - Object.prototype.Enum is installed as script code run *inside* the
 *    context (several legacy files call `.Enum(...)` via the util.js polyfill).
 */
function createLegacyContext(globals: LegacySandbox): { context: vm.Context; sandbox: LegacySandbox; windowShim: LegacySandbox } {
  const windowShim: LegacySandbox = { ...globals };
  const sandbox: LegacySandbox = {
    window: windowShim,
    console,
    ...globals
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const context = vm.createContext(sandbox);

  // vm.createContext() gives the new realm its own separate Error/Math/Date/
  // Object intrinsics. Left alone, `new LegacyError() instanceof Error` (using
  // the host realm's Error) would always be false, and `vi.spyOn(Math, 'random')`
  // / `vi.spyOn(Date, 'now')` in a test would silently have no effect on legacy
  // code (which would keep using the context's own, unmocked Math/Date — e.g.
  // audioTalkSession.js's `new Date()` RTP timestamp would use real wall-clock
  // time no matter what the test mocks on the host's Date). Sharing
  // Error/Math/Date is a plain property write and safe to do from the outside.
  context.Error = Error;
  context.Math = Math;
  context.Date = Date;

  // Object.prototype.Enum, by contrast, must be installed *as script code
  // run inside the context* (vm.runInContext), not by reaching in and poking
  // `context.Object.prototype` from the host: standard-built-in properties
  // like `Object` on a freshly contextified sandbox are only guaranteed to
  // reflect the context's own realm once code has actually executed there,
  // so touching `context.Object` from the host before that risks silently
  // patching the *host's* Object.prototype instead. Several legacy files
  // (digestGenerator.js, the custom-element source, *Session.js) call
  // `.Enum(...)` on plain object literals and rely on this having already run.
  vm.runInContext(
    `if (!Object.prototype.hasOwnProperty.call(Object.prototype, 'Enum')) {
      Object.defineProperty(Object.prototype, 'Enum', {
        value: function () {
          for (var i = 0; i < arguments.length; i++) {
            Object.defineProperty(this, arguments[i], {
              value: (isNaN(this.enumIndex) ? 0 : this.enumIndex) + i,
              writable: false,
              enumerable: true,
              configurable: true
            });
          }
        },
        enumerable: false,
        writable: false,
        configurable: false
      });
    }`,
    context
  );

  // Same rationale as Object.prototype.Enum above: Uint8Array.prototype.indexOfMulti
  // (util.js ~line 1823) must be installed inside the context's own realm.
  // transport.js calls `byteData.indexOfMulti(...)` as an instance method.
  vm.runInContext(
    `if (!Uint8Array.prototype.indexOfMulti) {
      Uint8Array.prototype.indexOfMulti = function (searchElements, fromIndex) {
        fromIndex = fromIndex || 0;
        var index = Array.prototype.indexOf.call(this, searchElements[0], fromIndex);
        if (searchElements.length === 1 || index === -1) {
          return index;
        }
        for (var i = index, j = 0; j < searchElements.length && i < this.length; i++, j++) {
          if (this[i] !== searchElements[j]) {
            return this.indexOfMulti(searchElements, index + 1);
          }
        }
        return (i === index + searchElements.length) ? index : -1;
      };
    }`,
    context
  );

  // `_slicedToArray` is a Babel helper the real build pipeline (grunt-browserify
  // + babelify) injects automatically wherever a legacy file destructures a
  // for-of loop variable (e.g. `var [key, value] = entry` compiled down for
  // ES5). It is referenced but never defined in the raw source files
  // themselves (see transport.js's Map-iteration code in removeEventListener/
  // dispatchEvent), so loading raw source directly here needs it provided —
  // otherwise the destructuring throws a ReferenceError that those functions'
  // own empty catch blocks silently swallow. Map/Set entries here are always
  // real arrays already, so the simple case is sufficient.
  vm.runInContext(
    `if (typeof _slicedToArray === 'undefined') {
      function _slicedToArray(arr, i) {
        if (Array.isArray(arr)) return arr;
        var result = [];
        var iterator = arr && arr[Symbol.iterator] && arr[Symbol.iterator]();
        if (!iterator) return result;
        var step;
        while (!(step = iterator.next()).done) {
          result.push(step.value);
          if (i && result.length === i) break;
        }
        return result;
      }
    }`,
    context
  );

  return { context, sandbox, windowShim };
}

/**
 * Executes a legacy-player/**\/*.js file (global-script style, no module
 * system) inside an isolated VM context seeded with `globals`, then returns the
 * value it assigned to `exportName` (checked on both the sandbox's top level and
 * on `sandbox.window`, since legacy files use both `var Foo = ...` and `window.Foo = ...`).
 */
export function loadLegacyModule<T>(relativePath: string, exportName: string, globals: LegacySandbox = {}): T {
  const absolutePath = resolve(LEGACY_SOURCE_ROOT, relativePath);
  const code = readFileSync(absolutePath, 'utf-8');

  const { context, sandbox, windowShim } = createLegacyContext(globals);
  vm.runInContext(code, context, { filename: absolutePath });

  const exported = (sandbox[exportName] ?? windowShim[exportName]) as T | undefined;
  if (exported === undefined) {
    throw new Error(`Legacy module "${relativePath}" did not expose "${exportName}"`);
  }
  return exported;
}

/**
 * Like loadLegacyModule, but for files that define several globals which
 * reference each other within the same execution (e.g. bufferStatus.js's six
 * state classes, each of which constructs the others by name) — loading them
 * individually would put each in its own isolated vm context, breaking those
 * cross-references. Returns every requested name from one single execution.
 */
export function loadLegacyModuleExports<T extends Record<string, unknown>>(
  relativePath: string,
  exportNames: (keyof T & string)[],
  globals: LegacySandbox = {}
): T {
  const absolutePath = resolve(LEGACY_SOURCE_ROOT, relativePath);
  const code = readFileSync(absolutePath, 'utf-8');

  const { context, sandbox, windowShim } = createLegacyContext(globals);
  vm.runInContext(code, context, { filename: absolutePath });

  const result = {} as T;
  for (const name of exportNames) {
    const value = sandbox[name] ?? windowShim[name];
    if (value === undefined) {
      throw new Error(`Legacy module "${relativePath}" did not expose "${name}"`);
    }
    (result as Record<string, unknown>)[name] = value;
  }
  return result;
}

/**
 * Executes only specific 1-indexed inclusive line ranges of a legacy file,
 * concatenated in order. Used for files like Util/util.js where the handful
 * of functions a test actually needs (e.g. BufferNode/BufferList) sit inside
 * a much larger file whose *other* top-level code reaches for real-browser
 * globals (document/navigator/screen/log4javascript internals) that aren't
 * worth stubbing out just to load a couple of unrelated functions. Still
 * executes the real file's own text for the requested lines — not a
 * hand-copied re-derivation — so it stays honest about what's under test.
 *
 * A trailer is appended for each requested export, run in the same
 * execution right after the sliced code, promoting `window.<name>` to a bare
 * `<name>` global when it's set. This matters for legacy objects/functions
 * whose own methods reference their own exported name as a *bare* identifier
 * (e.g. `Median.mean` calling `Median.sum(array)`, not `this.sum(array)`):
 * legacy source only assigns `window.X = ...`, and this harness's sandbox
 * `window` is a separate object from the vm context's own global scope, so a
 * bare `Median` reference inside a method body would otherwise fail to
 * resolve when that method is later invoked. Plain assignment to a bare
 * identifier at a classic (sloppy-mode) script's top level defines/updates a
 * real property on the context's global object, so this makes the bare name
 * resolve exactly like it does in a real browser (where `window` IS
 * `globalThis`, so `window.X = ...` already defines the bare global too).
 * Guarded on `window.<name>` being set so it's a no-op for exports that are
 * plain top-level `function X() {}` declarations rather than `window.X = ...`
 * assignments — those already create their own real global, and this trailer
 * would otherwise clobber it with `undefined`.
 */
export function loadLegacyModuleSlice<T extends Record<string, unknown>>(
  relativePath: string,
  lineRanges: [number, number][],
  exportNames: (keyof T & string)[],
  globals: LegacySandbox = {}
): T {
  const absolutePath = resolve(LEGACY_SOURCE_ROOT, relativePath);
  const lines = readFileSync(absolutePath, 'utf-8').split('\n');
  const sliced = lineRanges.map(([start, end]) => lines.slice(start - 1, end).join('\n')).join('\n');
  const selfReferenceTrailer = exportNames
    .map((name) => `if (typeof window.${name} !== 'undefined') { ${name} = window.${name}; }`)
    .join('\n');
  const code = `${sliced}\n${selfReferenceTrailer}`;

  const { context, sandbox, windowShim } = createLegacyContext(globals);
  vm.runInContext(code, context, { filename: `${absolutePath}#slice` });

  const result = {} as T;
  for (const name of exportNames) {
    const value = sandbox[name] ?? windowShim[name];
    if (value === undefined) {
      throw new Error(`Legacy module slice "${relativePath}" did not expose "${name}"`);
    }
    (result as Record<string, unknown>)[name] = value;
  }
  return result;
}
