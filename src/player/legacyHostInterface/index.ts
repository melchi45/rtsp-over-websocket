/**
 * legacyHostInterface — TypeScript port of the legacy host-framework interface layer
 * (stream interface factory + stream canvas directive).
 *
 * Deliberately NOT re-exported from src/player/index.ts: this layer is
 * legacy-host-framework-specific glue for a host app outside this repository (see
 * types.ts), not part of the neutral ESM API that app-react and other
 * modern consumers use. Import from this subpath directly:
 *
 *   import { createRTSPOverWebSocketStreamInterface } from '.../src/player/legacyHostInterface';
 */
export { createRTSPOverWebSocketStreamInterface, type RTSPOverWebSocketStreamInterface, type RTSPOverWebSocketStreamInterfaceDeps } from './streamInterface';
export {
  createRTSPOverWebSocketStreamDirective,
  type ElementLike,
  type RTSPOverWebSocketStreamDirective,
  type RTSPOverWebSocketStreamDirectiveDeps,
  type RTSPOverWebSocketStreamScope
} from './streamCanvas';
export * from './types';
