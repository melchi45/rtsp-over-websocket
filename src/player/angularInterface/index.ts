/**
 * angularInterface — TypeScript port of the legacy AngularJS interface layer
 * (stream interface factory + stream canvas directive).
 *
 * Deliberately NOT re-exported from src/player/index.ts: this layer is
 * AngularJS-specific glue for a host app outside this repository (see
 * types.ts), not part of the neutral ESM API that app-react and other
 * modern consumers use. Import from this subpath directly:
 *
 *   import { createKindStreamInterface } from '.../src/player/angularInterface';
 *   import { registerKindStreamModule } from '.../src/player/angularInterface/register';
 */
export { createKindStreamInterface, type KindStreamInterface, type KindStreamInterfaceDeps } from './streamInterface';
export {
  createKindStreamDirective,
  type ElementLike,
  type KindStreamDirective,
  type KindStreamDirectiveDeps,
  type KindStreamScope
} from './streamCanvas';
export * from './types';
