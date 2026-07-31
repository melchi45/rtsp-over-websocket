/**
 * Global AngularJS wiring for the angularInterface layer — reproduces the
 * legacy side-effecting registration
 * (`angular.module('kindStreamModule', [])`, `.factory('kindStreamInterface', ...)`,
 * `.directive('kindStream', [...])`) so this compiled module can still be
 * loaded into the outer AngularJS host app exactly like the original two
 * files did — a currently-unverified consumption path (see types.ts header).
 *
 * Not re-exported from src/player/index.ts: AngularJS glue is not part of
 * the neutral ESM API the rest of src/player exposes to app-react and other
 * modern consumers (see angularInterface/index.ts).
 *
 * Discovered pre-existing ordering issue (recorded, not "fixed" beyond what
 * consolidating naturally resolves): in the legacy pair, `streamCanvas.js`
 * declares `var kindStreamModule = angular.module('kindStreamModule', [])`
 * as an implicit global, and `streamInterface.js` calls
 * `kindStreamModule.factory(...)` on that same global — meaning
 * `streamCanvas.js` MUST execute first (MRD §2 load-order pain point).
 * Consolidating both registrations into this single file removes that
 * implicit cross-file ordering dependency.
 *
 * This file is the vendor/host boundary for this layer: the real
 * `angular`/`StreamManager`/`EventDataParser`/`$`/`isPhone` globals are
 * defined by code outside this repository (see types.ts), so their types
 * cannot be verified here beyond a structural cast at the boundary.
 */
import { createKindStreamInterface, type KindStreamInterfaceDeps } from './streamInterface';
import { createKindStreamDirective, type KindStreamDirectiveDeps } from './streamCanvas';

interface AngularModuleLike {
  factory(name: string, fn: (...args: unknown[]) => unknown): AngularModuleLike;
  directive(name: string, fn: unknown[]): AngularModuleLike;
}

interface AngularGlobalLike {
  module(name: string, requires: string[]): AngularModuleLike;
}

declare global {
  // eslint-disable-next-line no-var
  var angular: AngularGlobalLike | undefined;
  // eslint-disable-next-line no-var
  var StreamManager: KindStreamInterfaceDeps['StreamManager'] | undefined;
  // eslint-disable-next-line no-var
  var EventDataParser: KindStreamInterfaceDeps['EventDataParser'] | undefined;
  // eslint-disable-next-line no-var
  var isPhone: boolean | undefined;
  // eslint-disable-next-line no-var
  var $: KindStreamInterfaceDeps['$'] | undefined;
}

/**
 * Registers `kindStreamInterface` and `kindStream` onto a fresh
 * `kindStreamModule` AngularJS module, same as the legacy pair. No-ops if
 * `angular` isn't present on the page (e.g. modern ESM consumers that never
 * load AngularJS at all).
 */
export function registerKindStreamModule(): void {
  if (typeof angular === 'undefined') {
    return;
  }

  const kindStreamModule = angular.module('kindStreamModule', []);

  kindStreamModule.factory('kindStreamInterface', function (
    Attributes: unknown,
    UniversialManagerService: unknown,
    EventNotificationService: unknown,
    DigitalZoomService: unknown,
    CAMERA_STATUS: unknown,
    $rootScope: unknown,
    $interval: unknown
  ) {
    return createKindStreamInterface({
      Attributes: Attributes as KindStreamInterfaceDeps['Attributes'],
      UniversialManagerService: UniversialManagerService as KindStreamInterfaceDeps['UniversialManagerService'],
      EventNotificationService: EventNotificationService as KindStreamInterfaceDeps['EventNotificationService'],
      DigitalZoomService: DigitalZoomService as KindStreamInterfaceDeps['DigitalZoomService'],
      CAMERA_STATUS: CAMERA_STATUS as KindStreamInterfaceDeps['CAMERA_STATUS'],
      $rootScope: $rootScope as KindStreamInterfaceDeps['$rootScope'],
      $interval: $interval as KindStreamInterfaceDeps['$interval'],
      StreamManager: globalThis.StreamManager as KindStreamInterfaceDeps['StreamManager'],
      EventDataParser: globalThis.EventDataParser as KindStreamInterfaceDeps['EventDataParser'],
      $: globalThis.$ as KindStreamInterfaceDeps['$']
    });
  });

  kindStreamModule.directive('kindStream', [
    'kindStreamInterface',
    'UniversialManagerService',
    'SunapiClient',
    '$compile',
    function (kindStreamInterface: unknown, UniversialManagerService: unknown, SunapiClient: unknown, _$compile: unknown) {
      // _$compile: injected for legacy DI-array parity but unused, same as the
      // original (see streamCanvas.ts header comment) — kept only so the
      // injectable-name array still matches the function's arity.
      return createKindStreamDirective({
        kindStreamInterface: kindStreamInterface as KindStreamDirectiveDeps['kindStreamInterface'],
        UniversialManagerService: UniversialManagerService as KindStreamDirectiveDeps['UniversialManagerService'],
        SunapiClient: SunapiClient as KindStreamDirectiveDeps['SunapiClient'],
        isPhone: Boolean(globalThis.isPhone)
      });
    }
  ]);
}
