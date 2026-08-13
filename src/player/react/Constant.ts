/**
 * React-wrapper-specific types for Player.tsx. Adapted from
 * react-wisenet-player's `components/ump-player/Constant/Constant.tsx` (only
 * the subset Player.tsx actually needs — that file's device-management UI
 * types (ISearchDevice, DeviceTableProps, deviceTypeOptions, etc.) and
 * statistics-event payload types (unused there — every `onStatistics` body
 * was commented out) aren't ported).
 */
export interface IDevice {
  id: string;
  hostname: string;
  port: number;
  username: string;
  profile: string;
  channel: number;
  device: string;
  password: string;
  autoplay: boolean;
  statistics: boolean;
  https: boolean;
  /** Defaults to `true` when omitted. See Player.tsx's useEffect for what
   * each mode does. */
  useSunapi?: boolean;
}

export interface PlayerProps {
  device: IDevice;
}
