import * as THREE from 'three';
import { FisheyeMeshGenerator } from './fishEyeMesh';

/** Constructs a ReferenceError with the same message V8 uses for a genuinely undeclared identifier, for the two confirmed dead-global references below (TypeScript cannot reference a truly-undeclared bare identifier at all, so this reproduces the same error type/message without one). */
function undefinedGlobalError(name: string): ReferenceError {
  return new ReferenceError(`${name} is not defined`);
}

/**
 * Ported from the legacy player’s Util/fishEye3D.js — sets up a THREE.js scene
 * that dewarps a fisheye camera feed (video element or canvas) onto a
 * hemispherical mesh, with mouse/wheel pan-tilt-zoom and a render loop.
 *
 * `console.*` calls are not reproduced. Pinned to `three@0.84.0` (exact
 * version, see package.json) because this code targets the pre-BufferGeometry
 * THREE API (`THREE.Geometry`/`Face3`/`AxisHelper`/`RGBFormat`/
 * `BufferGeometry.fromGeometry`), all removed in modern three.js — using a
 * caret range here would risk a "compatible" minor bump silently deleting
 * APIs this file depends on.
 *
 * Two confirmed real bugs are preserved as-is rather than fixed:
 *  - `update()`'s canvas-texture-refresh branch reads a global `livecanvas`
 *    that is never declared anywhere in the codebase (confirmed via grep) —
 *    it would throw a ReferenceError on every frame once a canvas (non-video)
 *    texture is in use. Reproduced with an explicit `throw new ReferenceError`.
 *  - The `mount` setter's invalid-mode branch throws `new FisheyeError(...)`,
 *    a class that (like `livecanvas`) is never defined anywhere in the
 *    codebase — also reproduced as a ReferenceError rather than fabricating
 *    a working FisheyeError class legacy doesn't actually have.
 */

const RESOL = 2992.0;
const INIT_FOV = 75;
const MIN_DISTANCE = 0.0000000001;
const DEFAULT_DISTANCE = 250;
const DISTANCE_NEAR = 500;

export interface FisheyeStoredView {
  longitude: number;
  latitude: number;
  phi: number;
  theta: number;
  distance: number;
}

export type FisheyeMountMode = 'wall' | 'celling';

/** Minimal DOM-like surface this class needs from its `videoElement` param — a real `HTMLVideoElement` or `HTMLCanvasElement` satisfies it. */
export type FisheyeTextureSource = (HTMLVideoElement | HTMLCanvasElement) & { videoWidth?: number; videoHeight?: number };

export class Fisheye3D {
  private camera: THREE.PerspectiveCamera | null = null;
  private scene: THREE.Scene | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private _geometry: THREE.Geometry | null = null;
  private isUserInteracting = false;
  private onPointerDownPointerX = 0;
  private onPointerDownPointerY = 0;
  private onPointerDownLon = 0;
  private onPointerDownLat = 0;
  private lon = 0;
  private lat = 0;
  private phi = 0;
  private theta = 0;
  private distance = DEFAULT_DISTANCE;
  private fov = INIT_FOV;
  private storedValue: FisheyeStoredView | null = null;
  private tex: THREE.Texture | null = null;
  private _isWallMode = false;
  private animateId?: number;
  private _container: HTMLElement | null = null;
  private _background: number | string | null = null;
  private _mesh: unknown;
  private _fisheyeviewMode = false;

  constructor(private readonly rendererFactory: () => THREE.WebGLRenderer = () => new THREE.WebGLRenderer()) {
    this.fisheyeview = false;
  }

  init(videoElement: FisheyeTextureSource, container: HTMLElement, background?: number | string | null): void {
    this._container = container;
    this._background = background ?? null;

    const videoWidth = videoElement.videoWidth ?? videoElement.width;
    const videoHeight = videoElement.videoHeight ?? videoElement.height;
    if (videoWidth === videoHeight) {
      this.camera = new THREE.PerspectiveCamera(INIT_FOV, window.innerWidth / window.innerHeight, 1, 4000);
    } else {
      this.camera = new THREE.PerspectiveCamera(INIT_FOV, videoWidth / videoHeight, 1, 4000);
    }
    (this.camera as unknown as { target: THREE.Vector3 }).target = new THREE.Vector3(0, 0, 0);
    this.camera.setViewOffset(window.innerWidth / 2, window.innerHeight / 2, window.innerWidth * 0, window.innerHeight * 0, window.innerWidth / 2, window.innerHeight / 2);

    this.scene = new THREE.Scene();

    const g = new FisheyeMeshGenerator();
    g.generateVertices(RESOL);

    const geometry = new THREE.Geometry();
    geometry.verticesNeedUpdate = true;
    geometry.elementsNeedUpdate = true;
    geometry.uvsNeedUpdate = true;

    for (let i = 0; i < g.mNumTriangles; i++) {
      geometry.vertices.push(
        new THREE.Vector3(g.position[i * 9 + 0] * 200, g.position[i * 9 + 1] * 200, g.position[i * 9 + 2] * 200),
        new THREE.Vector3(g.position[i * 9 + 3] * 200, g.position[i * 9 + 4] * 200, g.position[i * 9 + 5] * 200),
        new THREE.Vector3(g.position[i * 9 + 6] * 200, g.position[i * 9 + 7] * 200, g.position[i * 9 + 8] * 200)
      );
      geometry.faces.push(new THREE.Face3(i * 3 + 0, i * 3 + 1, i * 3 + 2));
      geometry.faceVertexUvs[0].push([
        new THREE.Vector2(g.textureCoords[i * 6 + 0], g.textureCoords[i * 6 + 1]),
        new THREE.Vector2(g.textureCoords[i * 6 + 2], g.textureCoords[i * 6 + 3]),
        new THREE.Vector2(g.textureCoords[i * 6 + 4], g.textureCoords[i * 6 + 5])
      ]);
    }
    this._geometry = geometry;

    const axes = new THREE.AxisHelper(10);
    this.scene.add(axes);

    const geo = new THREE.BufferGeometry();
    geo.fromGeometry(geometry);

    let texture: THREE.Texture;
    if (videoElement instanceof HTMLVideoElement) {
      void videoElement.play();
      videoElement.setAttribute('webkit-playsinline', 'webkit-playsinline');
      texture = new THREE.VideoTexture(videoElement);
      this.tex = null;
    } else {
      texture = new THREE.CanvasTexture(videoElement);
      this.tex = texture;
    }
    texture.minFilter = THREE.LinearFilter;
    texture.format = THREE.RGBFormat;

    const material = new THREE.MeshBasicMaterial({ map: texture });
    const mesh = new THREE.Mesh(geo, material);
    this.scene.add(mesh);

    this.renderer = this.rendererFactory();
    if (this._background !== null) {
      this.renderer.setClearColor(this._background as number & string);
    } else {
      this.renderer.setClearColor(0xffffff);
    }
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.autoClear = false;
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);

    const addRawListener = this.renderer.domElement.addEventListener.bind(this.renderer.domElement) as (
      type: string,
      listener: EventListener,
      useCapture?: boolean
    ) => void;
    addRawListener('mousedown', this.onDocumentMouseDown as EventListener, false);
    addRawListener('mousemove', this.onDocumentMouseMove as EventListener, false);
    addRawListener('mouseup', this.onDocumentMouseUp as EventListener, false);
    addRawListener('dblclick', this.onDocumentMouseDbClick as EventListener, false);
    addRawListener('mousewheel', this.onDocumentMouseWheel as EventListener, false);
    // NOTE: `MozMousePixelScroll` is a long-removed legacy Firefox event
    // (pre-`wheel`-event-spec DOM_DELTA scrolling) — preserved verbatim,
    // harmless no-op registration in any currently-supported browser.
    addRawListener('MozMousePixelScroll', this.onDocumentMouseWheel as EventListener, false);

    this.distance = this.fisheyeview ? DEFAULT_DISTANCE : MIN_DISTANCE;

    window.addEventListener('resize', this.onWindowResize, false);
  }

  onWindowResize = (): void => {
    if (!this.camera || !this._container || !this.renderer) return;
    this.camera.aspect = this._container.clientWidth / this._container.clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this._container.clientWidth, this._container.clientHeight);
  };

  onDocumentMouseDown = (event: MouseEvent): void => {
    event.preventDefault();
    this.isUserInteracting = true;
    this.onPointerDownPointerX = event.clientX;
    this.onPointerDownPointerY = event.clientY;
    this.onPointerDownLon = this.lon;
    this.onPointerDownLat = this.lat;
  };

  onDocumentMouseMove = (event: MouseEvent): void => {
    if (!this.fisheyeview) {
      if (this.isUserInteracting) {
        if (this._isWallMode === true) {
          const candidateLat = (this.onPointerDownPointerY - event.clientY) * 0.1 + this.onPointerDownLat;
          if (candidateLat < 44 && candidateLat > -44) {
            this.lat = candidateLat;
          }
          const candidateLon = (this.onPointerDownPointerX - event.clientX) * 0.1 + this.onPointerDownLon;
          if (candidateLon < 25 && candidateLon > -25) {
            this.lon = candidateLon;
          }
        } else {
          this.lon = (this.onPointerDownPointerX - event.clientX) * 0.1 + this.onPointerDownLon;
          const candidateLat = (event.clientY - this.onPointerDownPointerY) * 0.1 + this.onPointerDownLat;
          if (candidateLat < 43) {
            this.lat = candidateLat;
          }
        }
      }
    } else if (this.isUserInteracting) {
      this.lon = (this.onPointerDownPointerX - event.clientX) * 1.0 + this.onPointerDownLon;
    }
  };

  onDocumentMouseUp = (): void => {
    this.isUserInteracting = false;
  };

  onDocumentMouseDbClick = (): void => {
    if (this.fisheyeview) {
      this.distance = DEFAULT_DISTANCE;
      return;
    }
    if (this.distance > MIN_DISTANCE) {
      this.distance = MIN_DISTANCE;
    }
  };

  onDocumentMouseWheel = (event: WheelEvent & { wheelDeltaY?: number; wheelDelta?: number }): void => {
    if (!this.fisheyeview) {
      if (event.wheelDeltaY) {
        this.distance += event.wheelDeltaY * 0.05;
      } else if (event.wheelDelta) {
        this.distance -= event.wheelDelta * 1.5;
      } else if (event.detail) {
        this.distance += event.detail * 0.5;
      }

      if (this.distance < MIN_DISTANCE) {
        this.distance = MIN_DISTANCE;
        if (this.fov > 1) {
          this.fov -= 1;
        }
      } else if (this.fov < INIT_FOV) {
        this.distance = MIN_DISTANCE;
        this.fov += 1;
      }
    }
  };

  animate = (): void => {
    this.animateId = window.requestAnimationFrame(this.animate);
    this.update();
  };

  start(): void {
    if (!this.animateId) {
      this.animate();
    }
  }

  stop(): void {
    if (this.animateId) {
      window.cancelAnimationFrame(this.animateId);
      this.animateId = undefined;
    }
    if (this._container && this.renderer) {
      this._container.removeChild(this.renderer.domElement);
    }
    window.removeEventListener('resize', this.onWindowResize, false);
  }

  update(): void {
    if (this.tex) {
      // NOTE: confirmed real bug preserved — see class-level doc comment.
      throw undefinedGlobalError('livecanvas');
    }

    const camera = this.camera!;
    if (this._isWallMode === true) {
      camera.up.set(0, 1, 0);
    } else {
      camera.up.set(0, 0, -1);
    }

    let limit = 0.0;
    if (this.distance < DISTANCE_NEAR) {
      if (this._isWallMode === true) {
        limit = (Math.atan(Math.tan((this.fov * Math.PI) / 180 / 2) * camera.aspect) * 180) / Math.PI;
      } else {
        limit = this.fov / 2 + 5;
      }
      if (this.distance > MIN_DISTANCE) {
        limit *= 1.0 - (1.0 * this.distance) / DISTANCE_NEAR;
      }
    }

    if (this._isWallMode === true) {
      this.lat = Math.max(-75, Math.min(75, this.lat));
      this.phi = THREE.Math.degToRad(this.lat - 90);
      this.lon = limit > 90 ? 0 : Math.max(limit - 90, Math.min(90 - limit, this.lon));
      this.theta = THREE.Math.degToRad(this.lon + 90);
      camera.position.x = this.distance * Math.sin(this.phi) * Math.cos(this.theta);
      camera.position.y = this.distance * Math.cos(this.phi);
      camera.position.z = this.distance * Math.sin(this.phi) * Math.sin(this.theta);
    } else {
      this.lat = Math.max(0, Math.min(90 - limit, this.lat));
      this.phi = THREE.Math.degToRad(this.lat - 180);
      this.theta = THREE.Math.degToRad(this.lon - 90);
      camera.position.x = this.distance * Math.sin(this.phi) * Math.cos(this.theta);
      camera.position.z = this.distance * Math.cos(this.phi);
      camera.position.y = this.distance * Math.sin(this.phi) * Math.sin(this.theta);
    }

    if (camera.fov !== this.fov) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }

    camera.lookAt((camera as unknown as { target: THREE.Vector3 }).target);
    this.renderer!.clear();
    this.renderer!.render(this.scene!, camera);
  }

  get mesh(): unknown {
    return this._mesh;
  }
  set mesh(v: unknown) {
    this._mesh = v;
    if (v) {
      const material = new THREE.LineBasicMaterial({ color: 0x0000ff });
      const meshLine = new THREE.Line(this._geometry!, material);
      meshLine.name = 'mesh';
      this.scene!.add(meshLine);
    } else {
      const selectedObject = this.scene!.getObjectByName('mesh');
      if (typeof selectedObject !== 'undefined' && selectedObject !== null) {
        selectedObject.parent!.remove(selectedObject);
      }
    }
  }

  set mount(v: FisheyeMountMode) {
    if (typeof v === 'string' && v.toLowerCase() === 'wall') {
      this._isWallMode = true;
    } else if (typeof v === 'string' && v.toLowerCase() === 'celling') {
      this._isWallMode = false;
    } else {
      // NOTE: confirmed real bug preserved — legacy references a
      // `FisheyeError` class that is never defined anywhere in the codebase
      // (see class-level doc comment); this reproduces that ReferenceError
      // rather than fabricating a working exception class legacy lacks.
      throw undefinedGlobalError('FisheyeError');
    }
  }
  get mount(): unknown {
    return this._mesh;
  }

  get fisheyeview(): boolean {
    return this._fisheyeviewMode;
  }
  set fisheyeview(v: boolean) {
    this._fisheyeviewMode = v;
    if (this.distance > MIN_DISTANCE && !v) {
      if (this.storedValue !== null) {
        this.lon = this.storedValue.longitude;
        this.lat = this.storedValue.latitude;
        this.phi = this.storedValue.phi;
        this.theta = this.storedValue.theta;
        this.distance = this.storedValue.distance;
        this.storedValue = null;
      } else {
        this.distance = MIN_DISTANCE;
      }
    } else {
      this.storedValue = { longitude: this.lon, latitude: this.lat, phi: this.phi, theta: this.theta, distance: this.distance };
      this.distance = DEFAULT_DISTANCE;
      if (this.camera) {
        this.lon = 0;
        this.lat = 0;
      }
    }
  }
}
