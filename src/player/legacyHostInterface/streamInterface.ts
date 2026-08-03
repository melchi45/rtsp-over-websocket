/**
 * TypeScript port of the legacy host-framework `rtspOverWebSocketStreamInterface` factory.
 *
 * The legacy file registers `rtspOverWebSocketStreamInterface` directly as a
 * host-framework factory (`rtspOverWebSocketStreamModule.factory('rtspOverWebSocketStreamInterface', function (Attributes, ...) {...})`).
 * Here the factory body is extracted into a plain, dependency-injected
 * function so it can be unit-tested without a real legacy-host-framework/host-app
 * runtime (see legacyHostInterface/types.ts for why the real service
 * implementations aren't available in this repository). The actual
 * module/factory registration wiring is left to the (currently
 * unverified) external host app that consumes this factory — this repo
 * never calls into that host framework itself.
 *
 * Ported close to 1:1 with the legacy control flow — this is a syntax/type
 * migration, not a logic rewrite. Behavioral quirks are preserved unless
 * called out below.
 *
 * Discovered dead code (recorded here, not silently dropped without a
 * trace): the legacy `setCanvasStyle` defines a nested
 * `_debounce(fn, wait)` helper (and its backing `timer` variable) that is
 * never called anywhere in the file — the real debounce below `setCanvasStyle:`
 * (the returned method) uses its own separate `debounce`/`setTimeout` logic.
 * Both `_debounce` and `timer` are omitted here since removing genuinely
 * unreachable code has no behavioral effect (unlike the preserved quirks
 * below, which *are* reachable).
 */
import type {
  AttributesService,
  CameraStatusConstant,
  ControlPlayerInfo,
  ControlWorkerData,
  DigitalZoomServiceType,
  EventDataParserType,
  EventNotificationServiceType,
  IntervalPromise,
  IntervalServiceLike,
  JQueryLike,
  JQueryStaticLike,
  RTSPOverWebSocketPlayerData,
  MinimapChangeData,
  RootScopeLike,
  StreamManagerCtor,
  StreamManagerHandle,
  UniversialManagerServiceType
} from './types';

export interface RTSPOverWebSocketStreamInterfaceDeps {
  Attributes: AttributesService;
  UniversialManagerService: UniversialManagerServiceType;
  EventNotificationService: EventNotificationServiceType;
  DigitalZoomService: DigitalZoomServiceType;
  CAMERA_STATUS: CameraStatusConstant;
  $rootScope: RootScopeLike;
  $interval: IntervalServiceLike;
  /** Not injected in the legacy factory (consumed as a bare global there); made explicit here for testability. */
  StreamManager: StreamManagerCtor;
  /** Not injected in the legacy factory (consumed as a bare global there); made explicit here for testability. */
  EventDataParser: EventDataParserType;
  /** Not injected in the legacy factory (consumed as a bare global there); made explicit here for testability. */
  $: JQueryStaticLike;
}

export interface RTSPOverWebSocketStreamInterface {
  init(info: RTSPOverWebSocketPlayerData, sunapiClient: unknown): void;
  destroyPlayer(data: RTSPOverWebSocketPlayerData): void;
  changeStreamInfo(rtspOverWebSocketPlayerData: RTSPOverWebSocketPlayerData | undefined): boolean | void;
  changeDrawInfo(data: { channelId: number; elementId: string; zoomArray: unknown }): void;
  changeMinimapInfo(data: MinimapChangeData): boolean | void;
  controlWorker(controlData: ControlWorkerData): void;
  controlAudioIn(data: unknown): boolean | void;
  controlAudioOut(data: unknown): boolean | void;
  controlAudioShift(data: unknown): boolean | void;
  getVideoPlayer(): unknown;
  managerCheck(): boolean;
  setStreamCanvas(element: JQueryLike): void;
  setTagType(type: string): void;
  setResizeEvent(): void;
  getStreamCanvas(): JQueryLike | null;
  openMinimap(): void;
  closeMinimap(): void;
  setCanvasStyle(mode: string, controlShow?: boolean): void;
  loadingBar(flag: boolean): void;
  setIspreview(value: boolean, pageName?: string): void;
  getIspreview(): boolean | null;
  locationChangeViewmode(): void;
  changeVlossStatus(vlossInfo: { type: 'single' | 'multi' | 'preview'; mode?: string; channelId?: number }): void;
  getBorderElement(): JQueryLike;
}

export function createRTSPOverWebSocketStreamInterface(deps: RTSPOverWebSocketStreamInterfaceDeps): RTSPOverWebSocketStreamInterface {
  const {
    Attributes,
    UniversialManagerService,
    EventNotificationService,
    DigitalZoomService,
    CAMERA_STATUS,
    $rootScope,
    $interval,
    StreamManager,
    EventDataParser,
    $
  } = deps;

  let manager: StreamManagerHandle | null = null;
  let container: JQueryLike | null = null;
  let streamCanvas: JQueryLike | null = null;
  let videoElement: HTMLVideoElement | undefined;
  let canvasElement: HTMLCanvasElement | undefined;
  let overlayCanvasWrapper: JQueryLike = $();
  let overlayCanvas: JQueryLike = $();
  let objectDetectionCanvas: JQueryLike = $();
  const minimap: {
    container: HTMLElement | null;
    overlay: HTMLCanvasElement | null;
    originalSize?: { width: number; height: number };
  } = {
    container: null,
    overlay: null
  };
  let ispreview: boolean | null = null;
  let curViewMode: string | null = null;
  let bottomMenuHeight = 50;
  let currentPage: string | null = null;
  let tagType: string | null = null;
  const callbackArray: ControlWorkerData[] = [];
  const borderSize = EventNotificationService.getBorderSize();
  const mAttr = Attributes.get();
  let debounce: ReturnType<typeof setTimeout> | false = false;
  let _channelData: { channelId: number; elementId: string } = {
    channelId: 0,
    elementId: ''
  };
  let scrollSizeInfo: { width: number | null; height: number | null } = {
    width: null,
    height: null
  };
  let stopUpdateMinimap: IntervalPromise | null = null;
  const minimapStyle = {
    containerWidth: 240,
    containerBorder: 1,
    strokeStyle: '#ff0000',
    lineWidth: 1
  };

  const loadingBar = (flag: boolean): void => {
    $rootScope.$emit('changeLoadingBar', flag);
  };

  const getBorderElement = (): JQueryLike => {
    let element: JQueryLike;
    if ($('.wn5-setup-wrapper').length === 0) {
      element = streamCanvas ?? $();
    } else {
      element = $('#setup-border-box');
    }

    return element;
  };

  function detectScrollbarSize(): { width: number; height: number } {
    const div = $('<div></div>').css({
      overflow: 'scroll',
      visibility: 'hidden',
      position: 'absolute',
      width: '100px',
      height: '100px'
    });
    $('body').append(div);

    const elemDiv = div[0];
    const width = elemDiv.offsetWidth - elemDiv.clientWidth;
    const height = elemDiv.offsetHeight - elemDiv.clientHeight;

    div.remove();

    return { width, height };
  }

  function updateMinimapBox(): void {
    if (scrollSizeInfo.width === null) {
      scrollSizeInfo = detectScrollbarSize();
    }

    const leftTop = UniversialManagerService.calcRatioPositionFromOverlay({
      offsetX: 0,
      offsetY: 0
    });
    const rightBottom = UniversialManagerService.calcRatioPositionFromOverlay({
      offsetX: overlayCanvasWrapper.width() ?? 0,
      offsetY: overlayCanvasWrapper.height() ?? 0
    });
    if (!leftTop || !rightBottom || !minimap.container || !minimap.overlay) {
      return;
    }
    const x = Math.round(minimap.container.clientWidth * leftTop.x);
    const y = Math.round(minimap.container.clientHeight * leftTop.y);
    const width = Math.round(minimap.container.clientWidth * rightBottom.x) - x;
    const height = Math.round(minimap.container.clientHeight * rightBottom.y) - y;

    const ctx = minimap.overlay.getContext('2d');
    if (!ctx) {
      return;
    }
    ctx.clearRect(0, 0, minimap.overlay.width, minimap.overlay.height);
    ctx.strokeStyle = minimapStyle.strokeStyle;
    ctx.lineWidth = minimapStyle.lineWidth;
    ctx.strokeRect(x, y, width, height);
  }

  const setCanvasStyle = (mode: string, controlShowArg?: boolean): void => {
    let controlShow = controlShowArg;
    if (controlShow === undefined) {
      const bottomMenu = $('#cm-bottom-menu');
      controlShow = bottomMenu.hasClass('cm-show-menu');
    }

    const colorPalette = $('#color-palette');

    setContainerSize(controlShow);

    if (streamCanvas === null || streamCanvas === undefined) {
      return;
    }

    overlayCanvasWrapper = $('overlay-canvas');
    overlayCanvas = $('#overlay-canvas');

    objectDetectionCanvas = $('#object-detection-canvas');

    if (tagType !== UniversialManagerService.getVideoMode()) {
      tagType = UniversialManagerService.getVideoMode();
      EventNotificationService.setBorderElement(getBorderElement(), currentPage);
    }
    UniversialManagerService.setViewModeType(mode);

    container = $('#container, .channel-container');

    overlayCanvas.parent().removeClass('overlay-canvas-originalsize');

    let changeViewMode = mode;
    if (mode === curViewMode) {
      changeViewMode = curViewMode;
    } else if (mode === 'originalsize' || mode === 'fit' || mode === 'originalratio') {
      changeViewMode = mode;
      curViewMode = changeViewMode;
      $rootScope.curViewMode = changeViewMode;
    } else {
      changeViewMode = curViewMode ?? mode;
    }
    EventNotificationService.setBorderElement(getBorderElement(), currentPage);
    if (changeViewMode === 'originalsize') {
      setOriginalsize();
    } else if (changeViewMode === 'fit') {
      setFit();
    } else if (changeViewMode === 'originalratio') {
      setOriginalRatio();
    }

    function setOriginalsize(): void {
      if (!streamCanvas) {
        return;
      }
      container?.css('overflow', 'auto');

      const streamContainerJq = $('#container');
      const containerSize = {
        width: parseInt(String(streamContainerJq.css('width')), 10),
        height: parseInt(String(streamContainerJq.css('height')), 10)
      };

      const newSize = getSize();
      if (typeof newSize !== 'undefined' && newSize !== null) {
        overlayCanvasWrapper.css({
          width: newSize.width,
          height: newSize.height
        });
        overlayCanvas
          .attr({
            width: newSize.width,
            height: newSize.height
          })
          .parent()
          .addClass('overlay-canvas-originalsize');

        objectDetectionCanvas.attr({
          width: newSize.width,
          height: newSize.height
        });

        if (
          containerSize.width < newSize.width + 2 * borderSize &&
          containerSize.height < newSize.height + 2 * borderSize
        ) {
          EventNotificationService.setBorderElement(streamContainerJq, currentPage);
          streamCanvas.css({
            width: newSize.width + 'px',
            height: newSize.height + 'px'
          });
          const streamContainerEl = document.getElementById('container');
          if (streamContainerEl) {
            overlayCanvasWrapper.css({
              width: streamContainerEl.clientWidth,
              height: streamContainerEl.clientHeight
            });
            overlayCanvas.attr({
              width: streamContainerEl.clientWidth,
              height: streamContainerEl.clientHeight
            });
          }
        } else {
          EventNotificationService.setBorderElement(streamCanvas, currentPage);
          streamCanvas.css({
            width: borderSize + newSize.width + borderSize + 'px',
            height: borderSize + newSize.height + borderSize + 'px'
          });
        }

        colorPalette.css({
          height: newSize.height + 'px'
        });

        setPosition(newSize.width, newSize.height);
      }
    }

    function setFit(): void {
      if (!streamCanvas) {
        return;
      }
      container?.css('overflow', 'hidden');

      streamCanvas.css({
        width: '100%',
        height: '100%',
        top: 0,
        left: 0
      });
      let thermalPositonSize = 0;
      if (typeof mAttr.thermalColorPaletteOptions !== 'undefined' && $('#color-palette').css('display') !== 'none') {
        thermalPositonSize = 70;

        colorPalette
          .css({
            height: '100%',
            left: 20,
            top: borderSize
          })
          .css('height', '-=10px');

        streamCanvas.css({
          width: '-=' + thermalPositonSize + 'px',
          left: thermalPositonSize
        });
      }

      overlayCanvas.attr({
        width: streamCanvas.width() ?? 0,
        height: streamCanvas.height() ?? 0
      });
      overlayCanvasWrapper.css({
        width: streamCanvas.width() ?? 0,
        height: streamCanvas.height() ?? 0,
        top: borderSize + 'px',
        left: borderSize + thermalPositonSize + 'px'
      });

      objectDetectionCanvas
        .attr({
          width: streamCanvas.width() ?? 0,
          height: streamCanvas.height() ?? 0
        })
        .css({
          top: borderSize + 'px',
          left: borderSize + 'px'
        });

      const plugin = UniversialManagerService.getStreamingMode() === CAMERA_STATUS.STREAMING_MODE.PLUGIN_MODE;
      if (plugin && !(UniversialManagerService.getViewMode() === 0 || UniversialManagerService.getIsCapturedScreen())) {
        streamCanvas.css({
          height: window.innerHeight - bottomMenuHeight + 'px'
        });
        overlayCanvasWrapper.css({
          height: window.innerHeight - bottomMenuHeight - borderSize * 2
        });
        overlayCanvas.attr({
          height: window.innerHeight - bottomMenuHeight - borderSize * 2
        });
        objectDetectionCanvas.attr({
          height: window.innerHeight - bottomMenuHeight - borderSize * 2
        });
      }
    }

    function setOriginalRatio(): void {
      container?.css('overflow', 'hidden');

      setCanvasBytestRatio();
    }

    $rootScope.$emit('update-dot-dptz', true);

    function setContainerSize(controlShowValue: boolean | undefined): void {
      const checkType = $('.cm-live-icon-list').length;
      const checkSize = window.innerWidth;
      const checkHeight = window.innerHeight;
      const nowfull = $('#cm-video').hasClass('cm-fullscreen');

      $('#cm-bottom-menu #cm-menu-content').css({ top: 50 + 'px' });

      if (checkHeight < 0) {
        if ($('.rtsp-responsive-live').length) $('.rtsp-responsive-live').addClass('land-scape');
        if ($('.rtsp-responsive-playback').length) $('.rtsp-responsive-playback').addClass('land-scape');

        const bottomMenuWidth = controlShowValue ? 470 : 70;

        bottomMenuHeight = 55;

        $('#cm-video, #event-sidebar').removeAttr('style');
        $('#cm-video, #event-sidebar').css({
          width: 'calc(100% - ' + bottomMenuWidth + 'px)'
        });
        if (nowfull) {
          $('#cm-video').css({
            width: 'calc(100% - ' + bottomMenuWidth + 'px)',
            height: 'calc(100% - 50px)'
          });
          $('.full-screen').css({
            height: 'calc(100% - 50px)'
          });
          $('.full-screen rtsp-stream').css({
            width: 'calc(100% - ' + bottomMenuWidth + 'px)',
            height: '100%'
          });
        }

        if (UniversialManagerService.getViewMode() !== 0) {
          $('#cm-video, #event-sidebar').css({
            width: 'calc(100% - ' + bottomMenuWidth + 'px)'
          });
        }
      } else {
        $('.land-scape').removeClass('land-scape');

        if (checkSize > 2300 && checkHeight > 1294) {
          bottomMenuHeight = controlShowValue ? 400 : 115;
        } else {
          bottomMenuHeight = controlShowValue ? 250 : 50;
        }

        if (checkSize > 3000 && checkHeight > 1688) {
          bottomMenuHeight = controlShowValue ? 500 : 145;
        }

        if (checkSize < 800 || (checkSize < 1190 && checkType)) bottomMenuHeight += 50;

        if (checkType && checkSize < 1190) {
          $('#cm-bottom-menu #cm-menu-content').css({ top: 160 + 'px' });
          bottomMenuHeight += 50;
        }

        if (
          (typeof mAttr.LensModelOptions !== 'undefined' ||
            typeof mAttr.thermalColorPaletteOptions !== 'undefined' ||
            (mAttr.MaxChannel ?? 0) > 1 ||
            typeof mAttr.AudioClipsGain !== 'undefined') &&
          UniversialManagerService.getPlayMode() === CAMERA_STATUS.PLAY_MODE.LIVE
        ) {
          if (checkSize < 1190) {
            if (!mAttr.SupportChannelExpansionFeature) {
              $('#cm-bottom-menu #cm-menu-content').css({ top: 210 + 'px' });
            }
            bottomMenuHeight += 60;
          }
        }

        const isLive = UniversialManagerService.getPlayMode() === CAMERA_STATUS.PLAY_MODE.LIVE;
        if (
          isLive &&
          checkSize < 1190 &&
          (mAttr.MaxChannel ?? 0) > 1 &&
          typeof mAttr.AudioClipsGain !== 'undefined' &&
          typeof mAttr.SupportChannelExpansionFeature === 'undefined'
        ) {
          $('#cm-bottom-menu #cm-menu-content').css({ top: 260 + 'px' });
          bottomMenuHeight += 50;
        }

        // The QNF-8010 model is recognized as multi-channel, so the 50px reserved for the ChannelSelector must be removed.
        if (isLive && typeof mAttr.SupportChannelExpansionFeature !== 'undefined' && checkSize < 1190) {
          bottomMenuHeight -= 50;
          if ((mAttr.MaxChannel ?? 0) <= 1) {
            $('#cm-bottom-menu #cm-menu-content').css({ top: 110 + 'px' });
          }
        }

        if (
          isLive &&
          checkSize < 1190 &&
          typeof mAttr.AudioClipsGain !== 'undefined' &&
          typeof mAttr.SupportChannelExpansionFeature !== 'undefined' &&
          mAttr.SupportChannelExpansionFeature &&
          typeof mAttr.MaxAlarmOutput !== 'undefined' &&
          mAttr.MaxAlarmOutput > 0
        ) {
          $('#cm-bottom-menu #cm-menu-content').css({ top: 250 + 'px' });
          bottomMenuHeight += 100;
        }

        $('#cm-video, #event-sidebar, .full-screen, rtsp-stream').removeAttr('style');
        $('#event-sidebar').css({
          height: $('#cm-video').height() ?? 0
        });
        if ($('.full-screen img').length || $('.full-screen object').length) {
          $('.full-screen rtsp-stream').css({
            height: '100%'
          });
          $('.full-screen').css({
            height: 'calc(100% - ' + bottomMenuHeight + 'px)'
          });
        } else {
          $('.full-screen').css({
            height: '100%'
          });
          $('.full-screen rtsp-stream').css({
            height: 'calc(100% - ' + bottomMenuHeight + 'px)'
          });
        }

        if (!UniversialManagerService.getFisheyeLens() && UniversialManagerService.getViewMode() !== 0) {
          $('#event-sidebar').css({
            height: $('#cm-video').height() ?? 0
          });
        }
      }
    }

    function getSize(boxWidthArg?: number, boxHeightArg?: number, type?: string): { width: number; height: number } | undefined {
      const boxHeight = boxHeightArg !== undefined ? boxHeightArg - 10 : boxHeightArg;

      let width: number, height: number;
      if (streamCanvas !== undefined && streamCanvas !== null) {
        const isFisheye = Boolean(mAttr.FisheyeLens) && UniversialManagerService.getStreamingMode() === CAMERA_STATUS.STREAMING_MODE.PLUGIN_MODE;
        const profileInfo = UniversialManagerService.getProfileInfo();
        const fisheyeProfileInfo = {
          Profile: 2,
          Name: 'FisheyeView',
          ViewModeIndex: 0
        };
        let isFisheyeProfile = false;
        if (
          isFisheye &&
          profileInfo !== null &&
          typeof profileInfo !== 'undefined' &&
          typeof profileInfo.ViewModeIndex !== 'undefined' &&
          profileInfo.Profile === fisheyeProfileInfo.Profile &&
          profileInfo.Name === fisheyeProfileInfo.Name &&
          profileInfo.ViewModeIndex === fisheyeProfileInfo.ViewModeIndex
        ) {
          isFisheyeProfile = true;
        }

        const modeWrap = $('#cm-fisheye .cm-mode-wrap');
        const isLive = modeWrap.length > 0;
        const modeNum = modeWrap.find('button.active').attr('data-mode-num');
        const changeRatio = type === 'Ratio' && isFisheyeProfile && modeNum !== '1' && isLive;
        if (changeRatio) {
          const mode = modeWrap.attr('data-mode');
          if (modeNum === '2') {
            width = 4;
            height = 1;
          } else if (modeNum === '3' && mode === 'Ceiling') {
            width = 2;
            height = 1;
          } else {
            width = 4;
            height = 3;
          }
        } else if (tagType === 'video') {
          videoElement = streamCanvas.find('#livevideo')[0] as HTMLVideoElement;
          width = videoElement.videoWidth;
          height = videoElement.videoHeight;
        } else {
          canvasElement = streamCanvas.find('#livecanvas')[0] as HTMLCanvasElement;
          width = parseInt(String(canvasElement.width), 10);
          height = parseInt(String(canvasElement.height), 10);
        }

        let newWidth = width;
        let newHeight = height;
        if (boxWidthArg !== undefined && boxHeight !== undefined) {
          newWidth = boxWidthArg / width;
          newHeight = boxHeight / height;

          const min = Math.min(newWidth, newHeight);
          newWidth = Math.floor(width * min);
          newHeight = Math.floor(height * min);

          if (!changeRatio) {
            // Checking rotate 0 with flip/mirror attribute.
            // If device does not support flip/mirror, getRotate() returns Integer 0.
            if (UniversialManagerService.getRotate() === 0) {
              if (newWidth < 320) {
                newWidth = 320;
                newHeight = (320 / width) * height;

                container?.css('overflow', 'auto');
              }
            } else if (newHeight < 320) {
              newHeight = 320;
              newWidth = (320 / height) * width;

              container?.css('overflow', 'auto');
            }
          }
        }

        return { width: newWidth, height: newHeight };
      }
      return undefined;
    }

    function setCanvasBytestRatio(): void {
      if (!streamCanvas) {
        return;
      }
      const boxSize = getBoxSize();

      if (boxSize === null) {
        if (!streamCanvas.hasClass('dptz')) {
          streamCanvas.css({
            width: '100%',
            height: '100%'
          });

          overlayCanvasWrapper.css({
            width: (streamCanvas.width() ?? 0) - borderSize * 2,
            height: (streamCanvas.height() ?? 0) - borderSize * 2
          });
          overlayCanvas.attr({
            width: (streamCanvas.width() ?? 0) - borderSize * 2,
            height: (streamCanvas.height() ?? 0) - borderSize * 2
          });
        }
      } else {
        const wWidth = boxSize.width;
        const wHeight = boxSize.height;
        const newSize = getSize(wWidth, wHeight, 'Ratio');
        if (newSize !== undefined) {
          streamCanvas.css({
            width: newSize.width + 'px',
            height: newSize.height + 'px'
          });
          overlayCanvasWrapper.css({
            width: newSize.width - borderSize * 2,
            height: newSize.height - borderSize * 2
          });
          overlayCanvas.attr({
            width: newSize.width - borderSize * 2,
            height: newSize.height - borderSize * 2
          });
          objectDetectionCanvas.attr({
            width: newSize.width - borderSize * 2,
            height: newSize.height - borderSize * 2
          });

          if (typeof mAttr.thermalColorPaletteOptions !== 'undefined' && $('#color-palette').css('display') !== 'none') {
            $('#color-palette').css({
              width: 40 + 'px',
              height: newSize.height - borderSize * 2 + 'px'
            });
          }

          setPosition(newSize.width, newSize.height);
        }
      }
    }

    $rootScope.$emit('overlayCanvas::setSize', overlayCanvas.width(), overlayCanvas.height());
  };

  function setPosition(width: number, height: number): void {
    if (!streamCanvas) {
      return;
    }
    const boxSize = getBoxSize();

    if (boxSize === null) {
      return;
    }

    let top = (boxSize.height - height) / 2;
    let left = (boxSize.width - width) / 2;

    if (scrollSizeInfo.width === null) {
      scrollSizeInfo = detectScrollbarSize();
    }

    if (curViewMode === 'originalsize') {
      const streamContainer = document.getElementById('container');
      if (streamContainer) {
        if (streamContainer.clientHeight < height) {
          top = 0;
        }
        if (streamContainer.clientWidth < width) {
          left = 0;
        }
      }
    }

    if (top <= 0) {
      top = 0;
    }
    if (left <= 0) {
      left = 0;
    }

    streamCanvas.css({
      top: top + 'px',
      left: left + 'px'
    });
    overlayCanvasWrapper.css({
      top: top + borderSize + 'px',
      left: left + borderSize + 'px'
    });

    if (typeof mAttr.thermalColorPaletteOptions !== 'undefined' && $('#color-palette').css('display') !== 'none') {
      const colorPalette = $('#color-palette');
      const thermalPositonSize = 70;

      colorPalette.css({
        top: top + borderSize + 'px',
        left: left + borderSize + 'px'
      });

      streamCanvas.css({
        left: '+=' + thermalPositonSize + 'px'
      });
      overlayCanvasWrapper.css({
        left: '+=' + thermalPositonSize + 'px'
      });
    }

    if (minimap.container !== null) {
      $('#mini-map-container').css({
        right: window.innerWidth - (left + boxSize.width) + (scrollSizeInfo.width ?? 0) + borderSize + 10
      });
    }
  }

  function getBoxSize(): { width: number; height: number } | null {
    let wWidth: number, wHeight: number;
    if (UniversialManagerService.getViewMode() === 0 || UniversialManagerService.getIsCapturedScreen()) {
      if (!$('.channel-container').length) {
        return null;
      }

      wWidth = $('.channel-container')[0].clientWidth;
      wHeight = $('.channel-container')[0].clientHeight;

      if (wWidth === 0 || wHeight === 0) {
        const channelView = $('.channels-view');

        wWidth = channelView.width() ?? 0;
        wHeight = channelView.height() ?? 0;

        if (UniversialManagerService.getIsCapturedScreen()) {
          UniversialManagerService.setIsCapturedScreen(false);
        }
      }
      EventNotificationService.setViewMode('default');
    } else {
      wWidth = window.innerWidth;
      wHeight = window.innerHeight - bottomMenuHeight;
      EventNotificationService.setViewMode('fullScreen');
    }

    if (typeof mAttr.thermalColorPaletteOptions !== 'undefined' && $('#color-palette').css('display') !== 'none') {
      const thermalPositonSize = 70;
      wWidth = wWidth - thermalPositonSize;
    }

    return { width: wWidth, height: wHeight };
  }

  function videoModeCallback(info: { channelId?: number; mode: string; [key: string]: unknown }): void {
    $rootScope.$emit('StatisticsService:statistics', info, true);
    const channelId = typeof info.channelId !== 'undefined' ? info.channelId : UniversialManagerService.getChannelId();
    const canvasElem = $('canvas[rtsp-channel-id="' + channelId + '"]')[0];
    const videoElem = $('video[rtsp-channel-id="' + channelId + '"]')[0];
    $(canvasElem).removeClass('video-display-none');
    $(videoElem).removeClass('video-display-none');
    if (info.mode === 'video') {
      $(canvasElem).addClass('video-display-none');
    } else if (info.mode === 'canvas') {
      $(videoElem).addClass('video-display-none');
    }
    UniversialManagerService.setVideoMode(info.mode);
  }

  function changeMinimapInfo(data: MinimapChangeData): boolean | void {
    if (typeof manager === 'undefined' || manager === null) {
      return false;
    }
    let info: ControlPlayerInfo | null = null;
    if (data.mode === 'on' && minimap.container === null && data.target && data.originalSize) {
      minimap.container = data.target;
      minimap.originalSize = data.originalSize;
      let viewWidth = minimapStyle.containerWidth;
      let viewHeight = Math.round((viewWidth * data.originalSize.height) / data.originalSize.width);
      if (typeof data.targetInfo !== 'undefined') {
        viewWidth = data.targetInfo.width;
        viewHeight = data.targetInfo.height;
        minimap.container.style.width = viewWidth + 'px';
        minimap.container.style.height = viewHeight + 'px';
      } else {
        minimap.container.style.width = minimapStyle.containerBorder + viewWidth + minimapStyle.containerBorder + 'px';
        minimap.container.style.height = minimapStyle.containerBorder + viewHeight + minimapStyle.containerBorder + 'px';
      }

      minimap.container.innerHTML =
        '<canvas id="mini-map-overlay" width="' + viewWidth + '" height="' + viewHeight + '"></canvas>' +
        '<canvas id="mini-map" width="' + viewWidth + '" height="' + viewHeight + '"></canvas>';
      minimap.overlay = document.getElementById('mini-map-overlay') as HTMLCanvasElement;

      info = {
        device: {
          channelId: data.channelId ?? 0
        },
        media: {
          element: data.elementId ?? '',
          requestInfo: {
            cmd: 'minimap',
            data: {
              mode: data.mode,
              interval: typeof data.interval !== 'undefined' ? data.interval : 3000,
              target: document.getElementById('mini-map')
            }
          }
        }
      };
      stopUpdateMinimap = $interval(() => {
        updateMinimapBox();
      }, 200);
    } else if (data.mode === 'off') {
      if (minimap.container !== null) {
        while (minimap.container.firstChild) {
          minimap.container.removeChild(minimap.container.firstChild);
        }
        info = {
          device: {
            channelId: _channelData.channelId || 0
          },
          media: {
            element: _channelData.elementId,
            requestInfo: {
              cmd: 'minimap',
              data: { mode: 'off' }
            }
          }
        };
        manager.controlPlayer(info);
        minimap.container = null;
      }
      if (stopUpdateMinimap) {
        $interval.cancel(stopUpdateMinimap);
        stopUpdateMinimap = null;
      }
    }
    if (info !== null) {
      manager.controlPlayer(info);
    }
  }

  return {
    init(info: RTSPOverWebSocketPlayerData, sunapiClient: unknown): void {
      if (!manager) {
        manager = new StreamManager();
      }
      manager.initStreamPlayer(info, sunapiClient);
      const channelId = info.device.channelId ?? 0;
      const elementId = info.media.element;
      _channelData = { channelId, elementId };
      for (let i = 0; i < callbackArray.length; i++) {
        this.controlWorker(callbackArray[i]);
      }
      this.controlWorker({
        channelId,
        elementId,
        cmd: 'setCallback',
        data: ['videoMode', videoModeCallback]
      });
      this.controlWorker({
        channelId,
        elementId,
        cmd: 'setCallback',
        data: ['metaEvent', EventDataParser.parse.bind(null, EventNotificationService.updateEventStatus)]
      });
      this.controlWorker({
        channelId,
        elementId,
        cmd: 'setCallback',
        data: ['loadingBar', this.loadingBar]
      });
      DigitalZoomService.init();
      EventNotificationService.clearObjectDetectionMetaData();
    },
    destroyPlayer(data: RTSPOverWebSocketPlayerData): void {
      EventNotificationService.initEventStatusList();
      currentPage = null;
      if (manager === undefined || manager === null) return;

      manager.destroyPlayer(data.device.channelId ?? 0, data.media.element);
      if (minimap.container !== null) {
        this.changeMinimapInfo({
          channelId: data.device.channelId ?? 0,
          elementId: data.media.element,
          mode: 'off'
        });
      }
    },
    changeStreamInfo(rtspOverWebSocketPlayerData: RTSPOverWebSocketPlayerData | undefined): boolean | void {
      if (rtspOverWebSocketPlayerData === undefined) return false;
      if (manager === undefined || manager === null) return false;
      manager.controlPlayer(rtspOverWebSocketPlayerData as unknown as ControlPlayerInfo);
      const cmd = rtspOverWebSocketPlayerData.media.requestInfo.cmd;
      if (cmd === 'capture') rtspOverWebSocketPlayerData.media.requestInfo.cmd = 'init';
      if (cmd === 'close') {
        this.destroyPlayer(rtspOverWebSocketPlayerData);
      }
    },
    changeDrawInfo(data: { channelId: number; elementId: string; zoomArray: unknown }): void {
      if (manager === undefined || manager === null) return;
      const info: ControlPlayerInfo = {
        device: { channelId: data.channelId },
        media: {
          element: data.elementId,
          requestInfo: { cmd: 'dZoom', data: data.zoomArray }
        }
      };
      manager.controlPlayer(info);
    },
    changeMinimapInfo,
    controlWorker(controlData: ControlWorkerData): void {
      if (manager === undefined || manager === null) {
        if (controlData.cmd === 'setCallback') {
          callbackArray.push(controlData);
        }
        return;
      }

      if (!controlData.elementId) {
        controlData.elementId = _channelData.elementId;
      }
      manager.controlWorker(controlData);
    },
    controlAudioIn(data: unknown): boolean | void {
      if (manager === undefined || manager === null) return false;

      manager.controlPlayer({
        device: { channelId: _channelData.channelId },
        media: {
          element: _channelData.elementId,
          requestInfo: { cmd: 'audioIn', data }
        }
      });
    },
    controlAudioOut(data: unknown): boolean | void {
      if (manager === undefined || manager === null) return false;

      manager.controlPlayer({
        device: { channelId: _channelData.channelId },
        media: {
          element: _channelData.elementId,
          requestInfo: { cmd: 'audioOut', data }
        }
      });
    },
    controlAudioShift(data: unknown): boolean | void {
      if (manager === undefined || manager === null) return false;

      manager.controlPlayer({
        device: { channelId: _channelData.channelId },
        media: {
          element: _channelData.elementId,
          requestInfo: { cmd: 'audioSync', data }
        }
      });
    },
    getVideoPlayer(): unknown {
      if (manager === undefined || manager === null) return false;

      return manager.getVideoPlayer();
    },
    managerCheck(): boolean {
      return manager ? true : false;
    },
    setStreamCanvas(element: JQueryLike): void {
      streamCanvas = element;
    },
    setTagType(type: string): void {
      tagType = type;
    },
    setResizeEvent(): void {
      window.onresize = () => setCanvasStyle;
    },
    getStreamCanvas(): JQueryLike | null {
      return streamCanvas;
    },
    openMinimap(): void {
      stopUpdateMinimap = $interval(() => {
        updateMinimapBox();
      }, 200);
    },
    closeMinimap(): void {
      if (stopUpdateMinimap) {
        $interval.cancel(stopUpdateMinimap);
        stopUpdateMinimap = null;
      }
      changeMinimapInfo({
        channelId: _channelData.channelId,
        elementId: _channelData.elementId,
        mode: 'off'
      });
    },
    setCanvasStyle(mode: string, controlShow?: boolean): void {
      let modeChanged = false;
      if (debounce !== false) {
        clearTimeout(debounce);
        if (mode === 'originalsize' || mode === 'fit' || mode === 'originalratio') {
          modeChanged = curViewMode !== mode;
          curViewMode = mode;
          if (mAttr.SupportMinimap) {
            if (mode === 'originalsize') {
              this.openMinimap();
            } else {
              this.closeMinimap();
            }
          }
        }
      }
      debounce = setTimeout(
        (modeArg: string, controlShowArg: boolean | undefined) => {
          if (modeChanged) {
            DigitalZoomService.init(true);
          }
          setCanvasStyle(modeArg, controlShowArg);
          debounce = false;
        },
        500,
        mode,
        controlShow
      );
    },
    loadingBar(flag: boolean): void {
      loadingBar(flag);
    },
    setIspreview(value: boolean, pageName?: string): void {
      ispreview = value;
      currentPage = !ispreview ? 'live' : (pageName ?? null);

      EventNotificationService.setBorderElement(getBorderElement(), currentPage);
    },
    getIspreview(): boolean | null {
      return ispreview;
    },
    locationChangeViewmode(): void {
      // $rootScope.curViewMode is set by the outer legacy host app (outside
      // this repository) — see types.ts. Falls back to '' to satisfy the
      // typed setCanvasStyle signature; legacy passed `undefined` through untyped.
      setCanvasStyle($rootScope.curViewMode ?? '');
    },
    changeVlossStatus(vlossInfo: { type: 'single' | 'multi' | 'preview'; mode?: string; channelId?: number }): void {
      if (vlossInfo.type === 'single') {
        $('#container').addClass('vloss');
      } else if (vlossInfo.type === 'multi') {
        const target = '#' + 'livevideo' + vlossInfo.channelId;
        if (vlossInfo.mode === 'off') {
          $(target).removeClass('vloss');
        } else {
          $(target).addClass('vloss');
        }
      } else if (vlossInfo.type === 'preview') {
        if (vlossInfo.mode === 'off') {
          $('#container').removeClass('vloss');
        } else {
          $('#container').addClass('vloss');
        }
      }
    },
    getBorderElement(): JQueryLike {
      return getBorderElement();
    }
  };
}
