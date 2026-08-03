/**
 * TypeScript port of the legacy host-framework `streamCanvas` directive.
 *
 * The legacy file does two things: declares a shared host-framework module
 * object, and registers a `rtspOverWebSocketStream` directive onto it. Both
 * are side-effecting global registrations, so — same as streamInterface.ts —
 * the directive definition object is built by a plain, dependency-injected
 * factory function here; the actual module/directive registration wiring is
 * left to the external host app that consumes this factory — this repo
 * never calls into that host framework itself.
 *
 * Discovered pre-existing issue (recorded here, not fixed — this port
 * preserves legacy behavior rather than correcting it): the legacy
 * directive's DI array injects `$compile`
 * (`['rtspOverWebSocketStreamInterface', 'UniversialManagerService', 'SunapiClient', '$compile', function (...) {...}]`)
 * but the function body never references it — a dead dependency. Omitted
 * from this factory's own dependency list since it does nothing here.
 */
import type { JQueryLike, RTSPOverWebSocketPlayerData, SunapiClientHandle, UniversialManagerServiceType } from './types';
import type { RTSPOverWebSocketStreamInterface } from './streamInterface';

/** Minimal structural shape of the legacy host framework's `element.find(...)` API used here. */
export interface ElementLike {
  find(selector: string): JQueryLike;
}

/** Minimal structural shape of the isolate scope + `$parent`/`$on`/`$emit` used here. */
export interface RTSPOverWebSocketStreamScope {
  $parent: {
    child?: unknown;
    updatePlayer?: (newValue: RTSPOverWebSocketPlayerData | null) => void;
  };
  $on(eventName: '$destroy', listener: (event: unknown) => void): void;
  $emit(eventName: string, ...args: unknown[]): void;
  rtspOverWebSocketPlayer?: RTSPOverWebSocketPlayerData;
}

export interface RTSPOverWebSocketStreamDirective {
  restrict: 'E';
  scope: { control: '='; objectDetectionEnable: '=' };
  template: string;
  link(scope: RTSPOverWebSocketStreamScope, elem: ElementLike): void;
}

export interface RTSPOverWebSocketStreamDirectiveDeps {
  rtspOverWebSocketStreamInterface: RTSPOverWebSocketStreamInterface;
  UniversialManagerService: UniversialManagerServiceType;
  SunapiClient: SunapiClientHandle;
  /**
   * Host-app global, not present anywhere in this repository (see types.ts).
   * Legacy guards the `$destroy` teardown call with `if (isPhone) return;` —
   * preserved as-is; behavior/purpose of that guard is not otherwise documented.
   */
  isPhone: boolean;
}

export function createRTSPOverWebSocketStreamDirective(deps: RTSPOverWebSocketStreamDirectiveDeps): RTSPOverWebSocketStreamDirective {
  const { rtspOverWebSocketStreamInterface, UniversialManagerService, SunapiClient, isPhone } = deps;

  return {
    restrict: 'E',
    scope: {
      control: '=',
      objectDetectionEnable: '='
    },
    template:
      '<div id="container" style="cursor:default;">' +
      '<div id="stream-canvas" class="rtsp-stream-canvas">' +
      '<canvas id="object-detection-canvas" style="left: 0px; top: 0px;" ng-show="objectDetectionEnable"></canvas>' +
      '<video id="livevideo" style="left: 0px; top: 0px;" class="video-display-none"></video>' +
      '<canvas id="livecanvas" style="left: 0px; top: 0px;"></canvas>' +
      '</div>' +
      '</div>',
    link(scope: RTSPOverWebSocketStreamScope, elem: ElementLike): void {
      rtspOverWebSocketStreamInterface.setStreamCanvas(elem.find('#stream-canvas'));
      rtspOverWebSocketStreamInterface.setResizeEvent();
      UniversialManagerService.setVideoMode('canvas');
      rtspOverWebSocketStreamInterface.setTagType('canvas');

      const parentScope = scope.$parent;
      parentScope.child = scope;

      scope.$on('$destroy', () => {
        if (isPhone) {
          return;
        }

        const tmpRTSPOverWebSocketPlayer = scope.rtspOverWebSocketPlayer;
        if (tmpRTSPOverWebSocketPlayer !== undefined) {
          tmpRTSPOverWebSocketPlayer.media.requestInfo.cmd = 'close';
        }

        rtspOverWebSocketStreamInterface.setIspreview(false);
        rtspOverWebSocketStreamInterface.changeStreamInfo(tmpRTSPOverWebSocketPlayer);
      });

      parentScope.updatePlayer = (newValue: RTSPOverWebSocketPlayerData | null): void => {
        let channelId = 0;
        if (newValue === null) {
          return;
        }
        if (newValue.device.channelId !== null) {
          channelId = newValue.device.channelId ?? 0;
        }
        elem.find('#livecanvas').attr('rtsp-channel-id', channelId);
        elem.find('#livevideo').attr('rtsp-channel-id', channelId);
        if (newValue.media.element) {
          elem.find('#livecanvas').attr('rtsp-channel-mapped-id', newValue.media.element);
          elem.find('#livevideo').attr('rtsp-channel-mapped-id', newValue.media.element);
        }
        rtspOverWebSocketStreamInterface.init(newValue, SunapiClient);

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
        // `JSON.parse(JSON.stringify(...))` substitutes for the legacy host
        // framework's deep-clone helper (no host-framework runtime dependency
        // here). Ported 1:1 including
        // an apparent pre-existing bug: `delete` runs on `newValue.device.zipPassword`,
        // not on the `value` copy that's actually passed to changeStreamInfo() below —
        // since `value` is an independent deep copy, its `zipPassword` field survives.
        // Flagged as a discovered issue (Design doc §6), not fixed here to preserve parity.
        const value: RTSPOverWebSocketPlayerData = JSON.parse(JSON.stringify(newValue));
        delete (newValue.device as { zipPassword?: string }).zipPassword;
        rtspOverWebSocketStreamInterface.changeStreamInfo(value);
        if (!UniversialManagerService.getLiveStreamStatus() && !rtspOverWebSocketStreamInterface.getIspreview()) {
          rtspOverWebSocketStreamInterface.setCanvasStyle('originalratio');
          UniversialManagerService.setLiveStreamStatus(true);
        }

        if (value.media.requestInfo.cmd === 'forward' || value.media.requestInfo.cmd === 'backward') {
          value.media.requestInfo.cmd = 'init';
        }
        scope.rtspOverWebSocketPlayer = value;
      };
    }
  };
}
