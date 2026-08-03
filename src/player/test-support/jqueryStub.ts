/**
 * Minimal, spy-friendly stand-in for jQuery, used only by the Layer 12
 * (legacyHostInterface) contract tests. Deliberately not real jQuery — see
 * legacyHostInterface/types.ts (`JQueryLike`) for why this migration doesn't
 * take on a `jquery`/`@types/jquery` dependency. Every call is a Vitest
 * spy so tests can assert on DOM-manipulation intent without needing an
 * actual DOM to manipulate correctly.
 *
 * All selectors resolve to the same shared chain object (good enough for
 * contract-level assertions — "was `.addClass('vloss')` called" — not
 * pixel-accurate DOM state).
 */
import { vi } from 'vitest';
import type { JQueryLike, JQueryStaticLike } from '../legacyHostInterface/types';

export function createJQueryChainStub(): JQueryLike {
  const chain = {} as Record<string, unknown>;
  const self = chain as unknown as JQueryLike;

  chain.length = 0;
  chain[0] = document.createElement('div');
  chain.css = vi.fn((...args: unknown[]) => (args.length === 1 && typeof args[0] === 'string' ? '' : self));
  chain.attr = vi.fn((...args: unknown[]) => (args.length === 1 && typeof args[0] === 'string' ? undefined : self));
  chain.addClass = vi.fn(() => self);
  chain.removeClass = vi.fn(() => self);
  chain.removeAttr = vi.fn(() => self);
  chain.hasClass = vi.fn(() => false);
  chain.find = vi.fn(() => createJQueryChainStub());
  chain.parent = vi.fn(() => self);
  chain.width = vi.fn(() => 0);
  chain.height = vi.fn(() => 0);
  chain.append = vi.fn(() => self);
  chain.remove = vi.fn(() => self);

  return self;
}

export interface JQueryStub {
  $: JQueryStaticLike;
  root: JQueryLike;
}

export function createJQueryStub(): JQueryStub {
  const root = createJQueryChainStub();
  const $ = vi.fn((_selector?: unknown) => root) as unknown as JQueryStaticLike;
  return { $, root };
}
