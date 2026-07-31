/**
 * TypeScript port of the legacy AngularJS `streamCanvas` directive.
 *
 * The legacy file does two things: `angular.module('kindStreamModule', [])`
 * (module declaration) and `kindStreamModule.directive('kindStream', [...])`
 * (directive registration). Both are side-effecting global registrations, so
 * — same as streamInterface.ts — the directive definition object is built by
 * a plain, dependency-injected factory function here; `register.ts` performs
 * the actual `angular.module(...)`/`.directive(...)` wiring.
 *
 * Discovered pre-existing issue (recorded here, not fixed — this port
 * preserves legacy behavior rather than correcting it): the legacy
 * directive's DI array injects `$compile`
 * (`['kindStreamInterface', 'UniversialManagerService', 'SunapiClient', '$compile', function (...) {...}]`)
 * but the function body never references it — a dead dependency. Preserved
 * in `register.ts`'s DI array for exact AngularJS wiring parity; omitted
 * from this factory's own dependency list since it does nothing here.
 */
import type { JQueryLike, KindPlayerData, SunapiClientHandle, UniversialManagerServiceType } from './types';
import type { KindStreamInterface } from './streamInterface';

/** Minimal structural shape of the AngularJS `element.find(...)` API used here. */
export interface ElementLike {
  find(selector: string): JQueryLike;
}

/** Minimal structural shape of the isolate scope + `$parent`/`$on`/`$emit` used here. */
export interface KindStreamScope {
  $parent: {
    child?: unknown;
    updatePlayer?: (newValue: KindPlayerData | null) => void;
  };
  $on(eventName: '$destroy', listener: (event: unknown) => void): void;
  $emit(eventName: string, ...args: unknown[]): void;
  kindplayer?: KindPlayerData;
}

export interface KindStreamDirective {
  restrict: 'E';
  scope: { control: '='; objectDetectionEnable: '=' };
  template: string;
  link(scope: KindStreamScope, elem: ElementLike): void;
}

export interface KindStreamDirectiveDeps {
  kindStreamInterface: KindStreamInterface;
  UniversialManagerService: UniversialManagerServiceType;
  SunapiClient: SunapiClientHandle;
  /**
   * Host-app global, not present anywhere in this repository (see types.ts).
   * Legacy guards the `$destroy` teardown call with `if (isPhone) return;` —
   * preserved as-is; behavior/purpose of that guard is not otherwise documented.
   */
  isPhone: boolean;
}

export function createKindStreamDirective(deps: KindStreamDirectiveDeps): KindStreamDirective {
  const { kindStreamInterface, UniversialManagerService, SunapiClient, isPhone } = deps;

  return {
    restrict: 'E',
    scope: {
      control: '=',
      objectDetectionEnable: '='
    },
    template:
      '<div id="container" style="cursor:default;">' +
      '<div id="stream-canvas" class="kind-stream-canvas">' +
      '<canvas id="object-detection-canvas" style="left: 0px; top: 0px;" ng-show="objectDetectionEnable"></canvas>' +
      '<video id="livevideo" style="left: 0px; top: 0px;" class="video-display-none"></video>' +
      '<canvas id="livecanvas" style="left: 0px; top: 0px;"></canvas>' +
      '</div>' +
      '</div>',
    link(scope: KindStreamScope, elem: ElementLike): void {
      kindStreamInterface.setStreamCanvas(elem.find('#stream-canvas'));
      kindStreamInterface.setResizeEvent();
      UniversialManagerService.setVideoMode('canvas');
      kindStreamInterface.setTagType('canvas');

      const parentScope = scope.$parent;
      parentScope.child = scope;

      scope.$on('$destroy', () => {
        if (isPhone) {
          return;
        }

        const tmpKindPlayer = scope.kindplayer;
        if (tmpKindPlayer !== undefined) {
          tmpKindPlayer.media.requestInfo.cmd = 'close';
        }

        kindStreamInterface.setIspreview(false);
        kindStreamInterface.changeStreamInfo(tmpKindPlayer);
      });

      parentScope.updatePlayer = (newValue: KindPlayerData | null): void => {
        let channelId = 0;
        if (newValue === null) {
          return;
        }
        if (newValue.device.channelId !== null) {
          channelId = newValue.device.channelId ?? 0;
        }
        elem.find('#livecanvas').attr('kind-channel-id', channelId);
        elem.find('#livevideo').attr('kind-channel-id', channelId);
        if (newValue.media.element) {
          elem.find('#livecanvas').attr('kind-channel-mapped-id', newValue.media.element);
          elem.find('#livevideo').attr('kind-channel-mapped-id', newValue.media.element);
        }
        kindStreamInterface.init(newValue, SunapiClient);

        if (newValue.media.requestInfo.cmd === 'init' || typeof newValue.media.requestInfo.cmd === 'undefined') {
          return;
        }

        const chId = newValue.device.channelId ?? 0;
        const pbData: { on: string; channelId: number; control: string; scale: number } = {
          on: 'off',
          channelId: chId,
          control: 'init',
          scale: 1
        };
        if (newValue.media.type === 'live') {
          scope.$emit('playback_directive_switch[' + chId + ']', pbData);
        } else {
          pbData.on = 'on';
          scope.$emit('playback_directive_switch[' + chId + ']', pbData);
        }
        // `JSON.parse(JSON.stringify(...))` substitutes for legacy `angular.copy()`
        // (deep clone, no Angular runtime dependency here). Ported 1:1 including
        // an apparent pre-existing bug: `delete` runs on `newValue.device.zipPassword`,
        // not on the `value` copy that's actually passed to changeStreamInfo() below —
        // since `value` is an independent deep copy, its `zipPassword` field survives.
        // Flagged as a discovered issue (Design doc §6), not fixed here to preserve parity.
        const value: KindPlayerData = JSON.parse(JSON.stringify(newValue));
        delete (newValue.device as { zipPassword?: string }).zipPassword;
        kindStreamInterface.changeStreamInfo(value);
        if (!UniversialManagerService.getLiveStreamStatus() && !kindStreamInterface.getIspreview()) {
          kindStreamInterface.setCanvasStyle('originalratio');
          UniversialManagerService.setLiveStreamStatus(true);
        }

        if (value.media.requestInfo.cmd === 'forward' || value.media.requestInfo.cmd === 'backward') {
          value.media.requestInfo.cmd = 'init';
        }
        scope.kindplayer = value;
      };
    }
  };
}
