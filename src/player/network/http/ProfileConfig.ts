/**
 * Ported from the legacy player's sunapi/ProfileConfig — the fixed index
 * assigned to each of the four well-known video-profile "roles" a Wisenet
 * device exposes (disarmed/PTZ-disabled, digital-PTZ, default, and
 * multi-streaming). Kept as a plain data table, same as legacy.
 */
export interface ProfileConfigEntry {
  index: number;
}

export interface ProfileConfigTable {
  DIS: ProfileConfigEntry;
  DPTZ: ProfileConfigEntry;
  DEFAULT: ProfileConfigEntry;
  MULTI: ProfileConfigEntry;
}

export const ProfileConfig: ProfileConfigTable = {
  DIS: {
    index: 0
    // NUM: 33,
    // NAME: 'profile33'
  },
  DPTZ: {
    index: 1
    // NUM: 34,
    // NAME: 'profile34'
  },
  DEFAULT: {
    index: 2
    // NUM: 35,
    // NAME: 'profile35'
  },
  MULTI: {
    index: 3
    // NUM: 36,
    // NAME: 'profile36'
  }
};
