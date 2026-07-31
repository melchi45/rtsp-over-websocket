// @vitest-environment jsdom
/**
 * Contract tests for Layer 12 (angularInterface) — see streamInterface.test.ts
 * header for why this layer uses contract tests instead of Phase 1's
 * vm-sandboxed behavioral-parity tests.
 */
import { describe, expect, it, vi } from 'vitest';
import { createJQueryStub } from '../test-support/jqueryStub';
import { createKindStreamDirective, type KindStreamDirectiveDeps, type KindStreamScope } from './streamCanvas';
import type { KindStreamInterface } from './streamInterface';
import type { KindPlayerData } from './types';

function createDeps(): { deps: KindStreamDirectiveDeps; kindStreamInterface: KindStreamInterface } {
  const kindStreamInterface: KindStreamInterface = {
    init: vi.fn(),
    destroyPlayer: vi.fn(),
    changeStreamInfo: vi.fn(),
    changeDrawInfo: vi.fn(),
    changeMinimapInfo: vi.fn(),
    controlWorker: vi.fn(),
    controlAudioIn: vi.fn(),
    controlAudioOut: vi.fn(),
    controlAudioShift: vi.fn(),
    getVideoPlayer: vi.fn(),
    managerCheck: vi.fn(() => false),
    setStreamCanvas: vi.fn(),
    setTagType: vi.fn(),
    setResizeEvent: vi.fn(),
    getStreamCanvas: vi.fn(),
    openMinimap: vi.fn(),
    closeMinimap: vi.fn(),
    setCanvasStyle: vi.fn(),
    loadingBar: vi.fn(),
    setIspreview: vi.fn(),
    getIspreview: vi.fn(() => false),
    locationChangeViewmode: vi.fn(),
    changeVlossStatus: vi.fn(),
    getBorderElement: vi.fn()
  };

  const deps: KindStreamDirectiveDeps = {
    kindStreamInterface,
    UniversialManagerService: {
      calcRatioPositionFromOverlay: vi.fn(),
      getVideoMode: vi.fn(),
      setViewModeType: vi.fn(),
      getStreamingMode: vi.fn(),
      getViewMode: vi.fn(),
      getIsCapturedScreen: vi.fn(),
      setIsCapturedScreen: vi.fn(),
      getRotate: vi.fn(),
      getProfileInfo: vi.fn(),
      getPlayMode: vi.fn(),
      getFisheyeLens: vi.fn(),
      getLiveStreamStatus: vi.fn(() => false),
      setLiveStreamStatus: vi.fn(),
      getChannelId: vi.fn(),
      setVideoMode: vi.fn()
    },
    SunapiClient: {},
    isPhone: false
  };

  return { deps, kindStreamInterface };
}

function createScope(): KindStreamScope & { $parent: { child?: unknown; updatePlayer?: (v: KindPlayerData | null) => void } } {
  return {
    $parent: {},
    $on: vi.fn(),
    $emit: vi.fn()
  };
}

const kindPlayerData: KindPlayerData = {
  device: { channelId: 1 },
  media: { element: 'el-1', type: 'live', requestInfo: {} }
};

describe('createKindStreamDirective (Layer 12 contract)', () => {
  it('returns an "E"-restricted directive with the legacy isolate scope bindings and template markup', () => {
    const { deps } = createDeps();
    const directive = createKindStreamDirective(deps);

    expect(directive.restrict).toBe('E');
    expect(directive.scope).toEqual({ control: '=', objectDetectionEnable: '=' });
    expect(directive.template).toContain('id="livevideo"');
    expect(directive.template).toContain('id="livecanvas"');
    expect(directive.template).toContain('id="object-detection-canvas"');
  });

  it('link() wires the stream canvas, resize handler, and canvas tag/video-mode on setup', () => {
    const { deps, kindStreamInterface } = createDeps();
    const directive = createKindStreamDirective(deps);
    const stub = createJQueryStub();
    const elem = { find: vi.fn(() => stub.root) };
    const scope = createScope();

    directive.link(scope, elem);

    expect(elem.find).toHaveBeenCalledWith('#stream-canvas');
    expect(kindStreamInterface.setStreamCanvas).toHaveBeenCalledWith(stub.root);
    expect(kindStreamInterface.setResizeEvent).toHaveBeenCalled();
    expect(kindStreamInterface.setTagType).toHaveBeenCalledWith('canvas');
    expect(deps.UniversialManagerService.setVideoMode).toHaveBeenCalledWith('canvas');
    expect(scope.$parent.child).toBe(scope);
  });

  it('$destroy: skips teardown entirely when isPhone is true', () => {
    const { deps, kindStreamInterface } = createDeps();
    const directive = createKindStreamDirective({ ...deps, isPhone: true });
    const elem = { find: vi.fn(() => createJQueryStub().root) };
    const scope = createScope();

    directive.link(scope, elem);
    const destroyHandler = (scope.$on as ReturnType<typeof vi.fn>).mock.calls[0][1] as () => void;
    destroyHandler();

    expect(kindStreamInterface.setIspreview).not.toHaveBeenCalled();
    expect(kindStreamInterface.changeStreamInfo).not.toHaveBeenCalled();
  });

  it('$destroy: sets requestInfo.cmd to "close" and tears down the player when isPhone is false', () => {
    const { deps, kindStreamInterface } = createDeps();
    const directive = createKindStreamDirective(deps);
    const elem = { find: vi.fn(() => createJQueryStub().root) };
    const scope = createScope();
    scope.kindplayer = { device: { channelId: 1 }, media: { element: 'el-1', requestInfo: {} } };

    directive.link(scope, elem);
    const destroyHandler = (scope.$on as ReturnType<typeof vi.fn>).mock.calls[0][1] as () => void;
    destroyHandler();

    expect(scope.kindplayer.media.requestInfo.cmd).toBe('close');
    expect(kindStreamInterface.setIspreview).toHaveBeenCalledWith(false);
    expect(kindStreamInterface.changeStreamInfo).toHaveBeenCalledWith(scope.kindplayer);
  });

  it('updatePlayer(null) returns immediately without touching kindStreamInterface', () => {
    const { deps, kindStreamInterface } = createDeps();
    const directive = createKindStreamDirective(deps);
    const elem = { find: vi.fn(() => createJQueryStub().root) };
    const scope = createScope();

    directive.link(scope, elem);
    scope.$parent.updatePlayer?.(null);

    expect(kindStreamInterface.init).not.toHaveBeenCalled();
  });

  it('updatePlayer() tags the live/canvas elements with the channel id and initializes the player', () => {
    const { deps, kindStreamInterface } = createDeps();
    const directive = createKindStreamDirective(deps);
    const stub = createJQueryStub();
    const elem = { find: vi.fn(() => stub.root) };
    const scope = createScope();

    directive.link(scope, elem);
    scope.$parent.updatePlayer?.(kindPlayerData);

    expect(stub.root.attr).toHaveBeenCalledWith('kind-channel-id', 1);
    expect(stub.root.attr).toHaveBeenCalledWith('kind-channel-mapped-id', 'el-1');
    expect(kindStreamInterface.init).toHaveBeenCalledWith(kindPlayerData, deps.SunapiClient);
  });

  it('updatePlayer() strips zipPassword from the original object while still forwarding a copy that retains it (discovered legacy bug, preserved)', () => {
    const { deps, kindStreamInterface } = createDeps();
    const directive = createKindStreamDirective(deps);
    const elem = { find: vi.fn(() => createJQueryStub().root) };
    const scope = createScope();
    const withPassword: KindPlayerData = {
      device: { channelId: 1, zipPassword: 'secret' },
      media: { element: 'el-1', type: 'live', requestInfo: { cmd: 'open' } }
    };

    directive.link(scope, elem);
    scope.$parent.updatePlayer?.(withPassword);

    expect(withPassword.device.zipPassword).toBeUndefined();
    const forwarded = (kindStreamInterface.changeStreamInfo as ReturnType<typeof vi.fn>).mock.calls[0][0] as KindPlayerData;
    expect(forwarded.device.zipPassword).toBe('secret');
  });

  it('updatePlayer() remaps "forward"/"backward" requestInfo.cmd to "init" before storing scope.kindplayer', () => {
    const { deps } = createDeps();
    const directive = createKindStreamDirective(deps);
    const elem = { find: vi.fn(() => createJQueryStub().root) };
    const scope = createScope();
    const forwardData: KindPlayerData = {
      device: { channelId: 1 },
      media: { element: 'el-1', type: 'live', requestInfo: { cmd: 'forward' } }
    };

    directive.link(scope, elem);
    scope.$parent.updatePlayer?.(forwardData);

    expect(scope.kindplayer?.media.requestInfo.cmd).toBe('init');
  });
});
