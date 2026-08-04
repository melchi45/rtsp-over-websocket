/**
 * Ported from the legacy player's custom-element source — its
 * module-level enum-like objects, each built there via
 * `Object.prototype.Enum(...)` (sequential 0-based index per name, in call
 * order) — reproduced here as plain `as const` objects with the exact same
 * member order/values.
 */
export const RTSPOverWebSocketPlayType = {
  LIVE: 0,
  PLAYBACK: 1,
  BACKUP: 2,
  INSTANTPLAYBACK: 3
} as const;
export type RTSPOverWebSocketPlayType = (typeof RTSPOverWebSocketPlayType)[keyof typeof RTSPOverWebSocketPlayType];

export const RTSPOverWebSocketPlayState = {
  STOPPED: 0,
  PLAYING: 1,
  PAUSED: 2,
  STEP: 3
} as const;
export type RTSPOverWebSocketPlayState = (typeof RTSPOverWebSocketPlayState)[keyof typeof RTSPOverWebSocketPlayState];

export const RTSPOverWebSocketBestshotFilter = {
  Person: 0,
  Face: 1,
  FaceRecognition: 2,
  Vehicle: 3,
  LicensePlate: 4
} as const;
export type RTSPOverWebSocketBestshotFilter = (typeof RTSPOverWebSocketBestshotFilter)[keyof typeof RTSPOverWebSocketBestshotFilter];

export interface RTSPOverWebSocketPlaySpeedEntry {
  value: number;
  name: string;
}

/**
 * NOT built via `.Enum()` in legacy — a plain object literal of named
 * `{value, name}` pairs. Order preserved from source (not that order matters
 * here, since lookups are always by key or by `.value`, never by index).
 */
export const RTSPOverWebSocketPlaySpeed = {
  speed_0_125x: { value: 0.125, name: '0.125x' },
  speed_0_25x: { value: 0.25, name: '0.25x' },
  speed_0_50x: { value: 0.5, name: '0.50x' },
  speed_0_75x: { value: 0.75, name: '0.75x' },
  speed_0_0x: { value: +0.0, name: '+0.0x' },
  speed_1x: { value: 1, name: '1x' },
  speed_2x: { value: 2, name: '2x' },
  speed_4x: { value: 4, name: '4x' },
  speed_8x: { value: 8, name: '8x' },
  speed_16x: { value: 16, name: '16x' },
  speed_32x: { value: 32, name: '32x' },
  speed_64x: { value: 64, name: '64x' },
  speed_128x: { value: 128, name: '128x' },
  speed_256x: { value: 256, name: '256x' },
  seek_0_125x: { value: -0.125, name: '-0.125x' },
  seek_0_25x: { value: -0.25, name: '-0.25x' },
  seek_0_50x: { value: -0.5, name: '-0.50x' },
  seek_0_75x: { value: -0.75, name: '-0.75x' },
  seek_0_0x: { value: -0.0, name: '-0.0x' },
  seek_1x: { value: -1, name: '-1x' },
  seek_2x: { value: -2, name: '-2x' },
  seek_4x: { value: -4, name: '-4x' },
  seek_8x: { value: -8, name: '-8x' },
  seek_16x: { value: -16, name: '-16x' },
  seek_32x: { value: -32, name: '-32x' },
  seek_64x: { value: -64, name: '-64x' },
  seek_128x: { value: -128, name: '-128x' },
  seek_256x: { value: -256, name: '-256x' }
} as const satisfies Record<string, RTSPOverWebSocketPlaySpeedEntry>;
