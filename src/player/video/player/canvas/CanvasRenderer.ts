import { saveAs } from 'file-saver';
import { Size } from '../../../util/Size';
import { fromHex } from '../../../util/hex';
import { RTSPOverWebSocketError } from '../../../exceptions/RTSPOverWebSocketError';
import { YUVWebGLCanvas } from './webgl/YUVWebGLCanvas';

type CanvasWithUpdatedFlag = HTMLCanvasElement & { updatedCanvas?: boolean };

interface VideoInfoLike {
  width?: number;
  height?: number;
}

interface CaptureEventData {
  channelId: number | undefined;
  blob: Blob | null;
}

/**
 * Ported from the legacy player’s Video/Player/Canvas/canvasRenderer's private
 * `Image2DCanvas` — a plain 2D-context drawer used for the MJPEG codec path
 * (YUVWebGLCanvas handles H264/H265).
 */
class Image2DCanvas {
  private readonly canvas: CanvasWithUpdatedFlag;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(canvas: CanvasWithUpdatedFlag, ctx: CanvasRenderingContext2D, size?: Size) {
    this.canvas = canvas;
    this.ctx = ctx;
    if (size) {
      this.canvas.width = size.w;
      this.canvas.height = size.h;
    }
  }

  drawCanvas(image: HTMLImageElement): void {
    this.canvas.width = image.width;
    this.canvas.height = image.height;
    this.ctx.drawImage(image, 0, 0);
  }

  initCanvas(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  destroy(): void {}
}

type Drawer = YUVWebGLCanvas | Image2DCanvas;

/**
 * Ported from the legacy player’s Video/Player/Canvas/canvasRenderer.
 *
 * `channelId`/`userPaused` are defined in legacy via `Object.defineProperty`
 * calls made on the *outer* `CanvasRenderer()` factory function's own `this`
 * — but that function explicitly `return new Constructor();` at the end,
 * which (per JS `new` semantics) discards the implicit `this` entirely in
 * favor of the returned object. So neither accessor is ever actually
 * installed on the real, returned instance — both behave as plain data
 * properties with no getter/setter side effects. `userPaused` is initialized
 * to `false` by `Constructor()`'s own `this.userPaused = false` line;
 * `channelId` is never assigned internally by CanvasRenderer itself, but
 * callers *can* still set it via ordinary property assignment (no accessor
 * blocks it) — canvasTagPlayer's `init()` does exactly that
 * (`renderer.channelId = this.channelId`) — so it must stay mutable, not
 * `readonly`, to match that real call site.
 */
export class CanvasRenderer {
  userPaused = false;
  channelId: number | undefined = undefined;
  eventCaptureCallback: ((data: CaptureEventData) => void) | null = null;

  private canvasElement: CanvasWithUpdatedFlag | null = null;
  private drawer: Drawer | null = null;
  private mapDrawer: Drawer | null = null;
  private codecType: string | null = null;
  private captureFlag = false;
  private captureframeData: HTMLImageElement | Uint8Array | undefined;
  private fileName: string | null = null;
  private size: Size | null = null;
  private minimapInfo: { isUpdate: boolean; element: CanvasWithUpdatedFlag | null } = { isUpdate: false, element: null };

  // Injectable, matching this codebase's established pattern for
  // browser-dependent APIs (audioContextFactory, XhrFactory, etc.) — defaults
  // to the real file-saver `saveAs`, letting tests substitute a fake.
  constructor(private readonly saveAsFn: typeof saveAs = saveAs) {}

  private download(): void {
    const canvasElement = this.canvasElement as CanvasWithUpdatedFlag;
    if (canvasElement.updatedCanvas === true) {
      this.captureFlag = false;

      canvasElement.toBlob((blob) => {
        if (this.fileName !== null && this.fileName !== undefined) {
          this.saveAsFn(blob as Blob, this.fileName + '.png');
        } else {
          if (this.eventCaptureCallback !== null && this.eventCaptureCallback !== undefined) {
            this.eventCaptureCallback({ channelId: this.channelId, blob });
          } else {
            throw new RTSPOverWebSocketError({
              channelId: this.channelId,
              errorCode: fromHex('0x0909'),
              place: 'CanvasRenderer.ts:53',
              message: 'can not return capture blob, because of capture callback is not exist.'
            });
          }
        }
      });
    }
  }

  private drawCanvas(data: unknown): void {
    if (this.drawer === null) {
      return;
    }

    // drawer.drawCanvas(data) is called generically here for both possible
    // drawer types (Uint8Array frame data for YUVWebGLCanvas, an
    // HTMLImageElement for Image2DCanvas via draw()'s MJPEG branch below) —
    // legacy relies on plain JS duck-typing since Image2DCanvas isn't
    // actually related to YUVWebGLCanvas by inheritance; the cast just gives
    // TypeScript a concrete method signature to call through.
    (this.drawer as YUVWebGLCanvas).drawCanvas(data as Uint8Array);
    (this.canvasElement as CanvasWithUpdatedFlag).updatedCanvas = true;

    if (this.captureFlag) {
      this.download();
    }

    if (this.mapDrawer !== null && this.minimapInfo.isUpdate) {
      (this.mapDrawer as YUVWebGLCanvas).drawCanvas(data as Uint8Array);
      this.minimapInfo.isUpdate = false;
    }
  }

  init(element?: CanvasWithUpdatedFlag): void {
    if (element === undefined) {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: fromHex('0x0901'),
        place: 'CanvasRenderer.ts:47',
        message: 'canvas tag element is undefined'
      });
    }

    this.canvasElement = element;
  }

  setCanvas(codec: string, videoInfo: VideoInfoLike): void {
    if (this.drawer === null) {
      this.size = new Size(videoInfo.width as number, videoInfo.height as number);
      this.codecType = codec;
      switch (this.codecType) {
        case 'H264':
        case 'H265':
        case 'VP8':
        case 'VP9':
        case 'AV1':
          this.drawer = new YUVWebGLCanvas(
            this.canvasElement as HTMLCanvasElement,
            (this.canvasElement as HTMLCanvasElement).getContext('webgl') as WebGLRenderingContext,
            this.size
          );
          break;
        case 'MJPEG':
          this.drawer = new Image2DCanvas(
            this.canvasElement as CanvasWithUpdatedFlag,
            (this.canvasElement as HTMLCanvasElement).getContext('2d') as CanvasRenderingContext2D,
            this.size
          );
          break;
        default:
          break;
      }
    }
  }

  capture(name: string): void {
    this.captureFlag = true;
    this.fileName = name;

    if (this.userPaused === true && typeof this.captureframeData !== 'undefined' && this.captureframeData !== null) {
      this.drawCanvas(this.captureframeData);
    }
  }

  draw(frameData: Uint8Array, videoInfo: VideoInfoLike, callback?: () => void): void {
    if (this.codecType === 'MJPEG') {
      const image = new Image(videoInfo.width, videoInfo.height);
      image.onload = () => {
        this.drawCanvas(image);
        window.URL.revokeObjectURL(image.src);
        if (callback) {
          callback();
        }
      };
      image.src = window.URL.createObjectURL(new Blob([frameData.buffer as ArrayBuffer]));
      this.captureframeData = image;
    } else {
      this.drawCanvas(frameData);
      this.captureframeData = frameData;
    }
  }

  renewCanvas(): void {
    if (this.drawer !== null) {
      this.drawer.initCanvas();
    }
  }

  // legacy's `updateVertexArray` is commented out on both WebGLCanvas and
  // YUVWebGLCanvas's prototypes (see webgl/WebGLCanvas.ts's zoomScene note),
  // and Image2DCanvas never defined it either — so this always throws
  // `TypeError: drawer.updateVertexArray is not a function` when a drawer
  // exists, a genuinely broken/dead digital-zoom feature preserved as-is.
  digitalZoom(bufferData: unknown): void {
    if (this.drawer !== null) {
      (this.drawer as unknown as { updateVertexArray: (data: unknown) => void }).updateVertexArray(bufferData);
    }
  }

  destroy(): void {
    this.canvasElement = null;
    if (this.drawer !== null) {
      this.drawer.initCanvas();
      this.drawer.destroy();
      this.drawer = null;
    }
    if (this.mapDrawer !== null) {
      this.mapDrawer.initCanvas();
      this.mapDrawer.destroy();
      this.mapDrawer = null;
    }
  }

  updateMinimapInfo(info: { mode: string; target?: CanvasWithUpdatedFlag | null }): void {
    const command = info.mode;
    if (this.minimapInfo.element === null && typeof info.target !== 'undefined' && info.target !== null) {
      this.minimapInfo.element = info.target;
      // legacy passes getAttribute()'s raw string (or null) straight into
      // `new Size(..., mapWidth, mapHeight)` without a Number() conversion —
      // Size.viewWidth/viewHeight end up holding a string, not a number, in
      // that case. Preserved via cast rather than "fixing" it with Number().
      const mapWidth = this.minimapInfo.element.getAttribute('width') as unknown as number;
      const mapHeight = this.minimapInfo.element.getAttribute('height') as unknown as number;
      if (this.mapDrawer === null) {
        const mapSize = new Size((this.size as Size).w, (this.size as Size).h, mapWidth, mapHeight);
        switch (this.codecType) {
          case 'H264':
          case 'H265':
          case 'VP8':
          case 'VP9':
          case 'AV1':
            this.mapDrawer = new YUVWebGLCanvas(this.minimapInfo.element, this.minimapInfo.element.getContext('webgl') as WebGLRenderingContext, mapSize);
            break;
          case 'MJPEG':
            this.mapDrawer = new Image2DCanvas(this.minimapInfo.element, this.minimapInfo.element.getContext('2d') as CanvasRenderingContext2D, mapSize);
            break;
        }
      }
    }
    if (command === 'draw') {
      this.minimapInfo.isUpdate = true;
    } else if (command === 'off') {
      this.mapDrawer = null;
      this.minimapInfo = { isUpdate: false, element: null };
    }
  }

  addEventListener(event: string, callback: (data: CaptureEventData) => void): void {
    switch (event) {
      case 'capture':
        this.eventCaptureCallback = callback;
        break;
    }
  }
}
