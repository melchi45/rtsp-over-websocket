import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Player } from './Player';
import type { IDevice, PlayerHandle, RTSPOverWebSocketEventListeners } from './Constant';

export { Player } from './Player';
export type { PlayerProps, IDevice, PlayerHandle, RTSPOverWebSocketEventListeners } from './Constant';
export { SUNAPI_CREDENTIALS_REQUIRED_ERROR_CODE, WRONG_CREDENTIALS_ERROR_CODE } from './Constant';

/**
 * Mounts `<Player>` into `container` without the caller needing its own
 * React/ReactDOM APIs — for a plain-script consumer (e.g. src/index.html's
 * no-bundler demo page) that just wants "give it a div and a device, get a
 * player" without importing React itself.
 *
 * `listeners` is forwarded straight through to `<Player>`'s own `listeners`
 * prop (see `Constant.ts`'s `RTSPOverWebSocketEventListeners` for the full
 * event list this plain-script caller can observe without touching the
 * underlying custom element directly).
 *
 * Returns `unmount` plus `retryAuthentication` — the same method
 * `<Player ref>`'s imperative handle exposes to a real React consumer (see
 * `PlayerHandle`), reached here via an internal `React.createRef` since a
 * plain-script caller has no ref of its own to pass in. Call it after an
 * `onError` listener call reports a `0x0403`/`0x0206` credential error.
 */
export function mountReactPlayer(
  container: HTMLElement,
  device: IDevice,
  listeners?: RTSPOverWebSocketEventListeners
): { unmount: () => void; retryAuthentication: (username: string, password: string) => void } {
  const root: Root = createRoot(container);
  const handleRef = React.createRef<PlayerHandle>();
  root.render(React.createElement(Player, { device, listeners, ref: handleRef }));
  return {
    unmount: () => root.unmount(),
    retryAuthentication: (username: string, password: string) => {
      handleRef.current?.retryAuthentication(username, password);
    }
  };
}
