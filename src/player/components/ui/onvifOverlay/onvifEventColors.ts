/**
 * Class/event-type -> color palette for `OnvifOverlay` (REQ-PLY-114). A
 * built-in, this-repository-defined palette -- not derived from any
 * standard's own color conventions. Kept separate from `OnvifOverlay.ts` so
 * it's independently testable/extendable without touching rendering code.
 * See `docs/player/10-onvif-metadata-overlay.md`.
 */

/** Fallback color for a class/event type not present in the palette below. */
export const DEFAULT_ONVIF_EVENT_COLOR = '#94A3B8';

// Keys are lowercased; getOnvifEventColor() lowercases its input to match,
// so lookups are case-insensitive regardless of how a given device
// capitalizes its own tt:Type text (ONVIF's own ClassType values are
// PascalCase, e.g. "Human"/"Vehicle"/"LicensePlate"; vendor extensions seen
// live, e.g. "Fire", don't reliably follow that convention).
const ONVIF_EVENT_COLORS: Record<string, string> = {
  human: '#EF4444',
  face: '#EF4444',
  vehicle: '#3B82F6',
  bicycle: '#F59E0B',
  motorcycle: '#F59E0B',
  licenseplate: '#8B5CF6',
  animal: '#10B981',
  fire: '#F97316',
  smoke: '#6B7280',
  other: '#94A3B8'
};

/** Case-insensitive lookup; returns `DEFAULT_ONVIF_EVENT_COLOR` for any type
 *  not in the built-in palette. */
export function getOnvifEventColor(type: string): string {
  return ONVIF_EVENT_COLORS[type.toLowerCase()] ?? DEFAULT_ONVIF_EVENT_COLOR;
}
