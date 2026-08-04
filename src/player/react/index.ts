import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Player } from './Player';
import type { IDevice } from './Constant';

export { Player } from './Player';
export type { PlayerProps, IDevice } from './Constant';

/**
 * Mounts `<Player>` into `container` without the caller needing its own
 * React/ReactDOM APIs — for a plain-script consumer (e.g. src/index.html's
 * no-bundler demo page) that just wants "give it a div and a device, get a
 * player" without importing React itself. Returns an unmount function.
 */
export function mountReactPlayer(container: HTMLElement, device: IDevice): () => void {
  const root: Root = createRoot(container);
  root.render(React.createElement(Player, { device }));
  return () => root.unmount();
}
