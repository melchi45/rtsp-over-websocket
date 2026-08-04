import { expect } from 'vitest';

export interface LegacyErrorInstance extends Error {
  channel?: number;
  element?: string;
  errorCode?: number;
  place?: string;
  uri?: string;
}

export type LegacyErrorCtor = new (options: Record<string, unknown>) => LegacyErrorInstance;

/** Asserts the ported class produces the same observable shape as the legacy constructor for a given options object. */
export function expectErrorParity(legacy: LegacyErrorInstance, ported: LegacyErrorInstance): void {
  expect(ported.name).toBe(legacy.name);
  expect(ported.message).toBe(legacy.message);
  expect(ported.channel).toBe(legacy.channel);
  expect(ported.element).toBe(legacy.element);
  expect(ported.errorCode).toBe(legacy.errorCode);
  expect(ported.place).toBe(legacy.place);
  expect(ported.uri).toBe(legacy.uri);
  expect(ported instanceof Error).toBe(true);
  expect(legacy instanceof Error).toBe(true);
}
