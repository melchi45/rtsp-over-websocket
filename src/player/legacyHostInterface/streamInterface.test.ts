// @vitest-environment jsdom
/**
 * Contract tests for the legacyHostInterface layer — see types.ts header for
 * why this layer uses contract tests (verify the public method surface +
 * key wiring behavior against mocked dependencies) rather than the
 * vm-sandboxed behavioral-parity tests used elsewhere: the real legacy
 * host-framework services this file depends on (Attributes, UniversialManagerService,
 * EventNotificationService, etc.) don't exist anywhere in this repository
 * to run for comparison.
 */
import { describe, expect, it, vi } from 'vitest';
import { createJQueryStub } from '../test-support/jqueryStub';
import { createRTSPOverWebSocketStreamInterface, type RTSPOverWebSocketStreamInterface, type RTSPOverWebSocketStreamInterfaceDeps } from './streamInterface';
import type { StreamManagerHandle } from './types';

function createDeps(): { deps: RTSPOverWebSocketStreamInterfaceDeps; streamManagerCtor: ReturnType<typeof vi.fn> } {
  const streamManagerCtor = vi.fn(
    () =>
      ({
        initStreamPlayer: vi.fn(),
        controlPlayer: vi.fn(),
        destroyPlayer: vi.fn(),
        controlWorker: vi.fn(),
        getVideoPlayer: vi.fn(() => 'video-player-handle')
      }) satisfies StreamManagerHandle
  );

  const deps: RTSPOverWebSocketStreamInterfaceDeps = {
    Attributes: { get: () => ({}) },
    UniversialManagerService: {
      calcRatioPositionFromOverlay: vi.fn(() => ({ x: 0, y: 0 })),
      getVideoMode: vi.fn(() => 'canvas'),
      setViewModeType: vi.fn(),
      getStreamingMode: vi.fn(() => 'plugin'),
      getViewMode: vi.fn(() => 0),
      getIsCapturedScreen: vi.fn(() => false),
      setIsCapturedScreen: vi.fn(),
      getRotate: vi.fn(() => 0),
      getProfileInfo: vi.fn(() => null),
      getPlayMode: vi.fn(() => 'live'),
      getFisheyeLens: vi.fn(() => false),
      getLiveStreamStatus: vi.fn(() => false),
      setLiveStreamStatus: vi.fn(),
      getChannelId: vi.fn(() => 0),
      setVideoMode: vi.fn()
    },
    EventNotificationService: {
      getBorderSize: vi.fn(() => 2),
      setBorderElement: vi.fn(),
      setViewMode: vi.fn(),
      clearObjectDetectionMetaData: vi.fn(),
      initEventStatusList: vi.fn(),
      updateEventStatus: vi.fn()
    },
    DigitalZoomService: { init: vi.fn() },
    CAMERA_STATUS: {
      STREAMING_MODE: { PLUGIN_MODE: 'plugin' },
      PLAY_MODE: { LIVE: 'live' }
    },
    $rootScope: { $emit: vi.fn() },
    $interval: Object.assign(vi.fn(() => ({})), { cancel: vi.fn() }),
    StreamManager: streamManagerCtor as unknown as RTSPOverWebSocketStreamInterfaceDeps['StreamManager'],
    EventDataParser: { parse: vi.fn() },
    $: createJQueryStub().$
  };

  return { deps, streamManagerCtor };
}

const PUBLIC_METHODS: (keyof RTSPOverWebSocketStreamInterface)[] = [
  'init',
  'destroyPlayer',
  'changeStreamInfo',
  'changeDrawInfo',
  'changeMinimapInfo',
  'controlWorker',
  'controlAudioIn',
  'controlAudioOut',
  'controlAudioShift',
  'getVideoPlayer',
  'managerCheck',
  'setStreamCanvas',
  'setTagType',
  'setResizeEvent',
  'getStreamCanvas',
  'openMinimap',
  'closeMinimap',
  'setCanvasStyle',
  'loadingBar',
  'setIspreview',
  'getIspreview',
  'locationChangeViewmode',
  'changeVlossStatus',
  'getBorderElement'
];

describe('createRTSPOverWebSocketStreamInterface (Layer 12 contract)', () => {
  it('exposes the full legacy rtspOverWebSocketStreamInterface public method surface', () => {
    const { deps } = createDeps();
    const iface = createRTSPOverWebSocketStreamInterface(deps);
    for (const method of PUBLIC_METHODS) {
      expect(typeof iface[method]).toBe('function');
    }
  });

  it('managerCheck() is false before init() and true after (lazy StreamManager construction)', () => {
    const { deps, streamManagerCtor } = createDeps();
    const iface = createRTSPOverWebSocketStreamInterface(deps);

    expect(iface.managerCheck()).toBe(false);
    iface.init({ device: { channelId: 1 }, media: { element: 'el-1', requestInfo: {} } }, {});
    expect(iface.managerCheck()).toBe(true);
    expect(streamManagerCtor).toHaveBeenCalledTimes(1);
  });

  it('init() is idempotent about StreamManager construction (only ever constructed once)', () => {
    const { deps, streamManagerCtor } = createDeps();
    const iface = createRTSPOverWebSocketStreamInterface(deps);

    iface.init({ device: { channelId: 1 }, media: { element: 'el-1', requestInfo: {} } }, {});
    iface.init({ device: { channelId: 2 }, media: { element: 'el-2', requestInfo: {} } }, {});
    expect(streamManagerCtor).toHaveBeenCalledTimes(1);
  });

  it('controlWorker() queues setCallback requests made before init() and flushes them into the manager on init()', () => {
    const { deps, streamManagerCtor } = createDeps();
    const iface = createRTSPOverWebSocketStreamInterface(deps);
    const resizeCallback = vi.fn();

    iface.controlWorker({ cmd: 'setCallback', data: ['resize', resizeCallback] });
    iface.init({ device: { channelId: 1 }, media: { element: 'el-1', requestInfo: {} } }, {});

    const managerInstance = streamManagerCtor.mock.results[0]?.value as StreamManagerHandle;
    expect(managerInstance.controlWorker).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: 'setCallback', data: ['resize', resizeCallback] })
    );
  });

  it('controlWorker() drops non-setCallback requests made before init() (matches legacy early-return)', () => {
    const { deps, streamManagerCtor } = createDeps();
    const iface = createRTSPOverWebSocketStreamInterface(deps);

    iface.controlWorker({ cmd: 'audioIn', data: true });
    iface.init({ device: { channelId: 1 }, media: { element: 'el-1', requestInfo: {} } }, {});

    const managerInstance = streamManagerCtor.mock.results[0]?.value as StreamManagerHandle;
    expect(managerInstance.controlWorker).not.toHaveBeenCalledWith(expect.objectContaining({ cmd: 'audioIn' }));
  });

  it('changeStreamInfo(undefined) returns false without throwing', () => {
    const { deps } = createDeps();
    const iface = createRTSPOverWebSocketStreamInterface(deps);
    expect(iface.changeStreamInfo(undefined)).toBe(false);
  });

  it('getVideoPlayer()/controlAudioIn()/controlAudioOut()/controlAudioShift() return false before init()', () => {
    const { deps } = createDeps();
    const iface = createRTSPOverWebSocketStreamInterface(deps);
    expect(iface.getVideoPlayer()).toBe(false);
    expect(iface.controlAudioIn({})).toBe(false);
    expect(iface.controlAudioOut({})).toBe(false);
    expect(iface.controlAudioShift({})).toBe(false);
  });

  it('getVideoPlayer() delegates to manager.getVideoPlayer() after init()', () => {
    const { deps } = createDeps();
    const iface = createRTSPOverWebSocketStreamInterface(deps);
    iface.init({ device: { channelId: 1 }, media: { element: 'el-1', requestInfo: {} } }, {});
    expect(iface.getVideoPlayer()).toBe('video-player-handle');
  });

  it('setIspreview()/getIspreview() round-trip, and setting false forces currentPage to "live"', () => {
    const { deps } = createDeps();
    const iface = createRTSPOverWebSocketStreamInterface(deps);

    iface.setIspreview(true, 'search');
    expect(iface.getIspreview()).toBe(true);
    expect(deps.EventNotificationService.setBorderElement).toHaveBeenLastCalledWith(expect.anything(), 'search');

    iface.setIspreview(false);
    expect(iface.getIspreview()).toBe(false);
    expect(deps.EventNotificationService.setBorderElement).toHaveBeenLastCalledWith(expect.anything(), 'live');
  });

  it('setStreamCanvas()/getStreamCanvas() round-trip', () => {
    const { deps } = createDeps();
    const iface = createRTSPOverWebSocketStreamInterface(deps);
    const element = createJQueryStub().root;
    iface.setStreamCanvas(element);
    expect(iface.getStreamCanvas()).toBe(element);
  });

  it('changeVlossStatus("single") adds the vloss class on #container', () => {
    const { deps } = createDeps();
    const stub = createJQueryStub();
    const iface = createRTSPOverWebSocketStreamInterface({ ...deps, $: stub.$ });
    iface.changeVlossStatus({ type: 'single' });
    expect(stub.root.addClass).toHaveBeenCalledWith('vloss');
  });
});
