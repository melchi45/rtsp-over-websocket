import { describe, expect, it } from 'vitest';
import { DEFAULT_ONVIF_EVENT_COLOR, getOnvifEventColor } from './onvifEventColors';

describe('getOnvifEventColor', () => {
  it('returns a specific color for a known type', () => {
    expect(getOnvifEventColor('Human')).toBe('#EF4444');
    expect(getOnvifEventColor('Vehicle')).toBe('#3B82F6');
  });

  it('is case-insensitive', () => {
    expect(getOnvifEventColor('human')).toBe(getOnvifEventColor('HUMAN'));
    expect(getOnvifEventColor('Fire')).toBe(getOnvifEventColor('fire'));
  });

  it('falls back to the default color for an unrecognized type', () => {
    expect(getOnvifEventColor('SomeUnknownVendorType')).toBe(DEFAULT_ONVIF_EVENT_COLOR);
  });
});
