import * as THREE from 'three';

/**
 * Ported from the legacy player’s Util/fishEye3D_multi.js — a cylindrical-panorama
 * variant of Fisheye3D.ts for a multi-camera stitched view, rendered into a
 * fixed `#mi-full-camera` DOM element.
 *
 * `meshVertex`/`GridMesh`/`FisheyeConfig`/`GEN` are defined verbatim in the
 * legacy file (byte-for-byte duplicated from fishEye3D.js) but are confirmed
 * dead code here: `init()` builds its mesh with its own inline
 * cylindrical-panorama generator instead (`var g = new GEN();` is commented
 * out) — so unlike Fisheye3D.ts, this port does not use `fishEyeMesh.ts` at
 * all; the inline generator is ported as `buildCylindricalMesh()` below.
 *
 * `console.*` calls and the commented-out minimap render pass
 * (`cameraHelper`/`renderer.setViewport(...)`/`renderer.render(scene,
 * minimapCamera)`) are dropped — `minimapCamera` is constructed and added to
 * the scene, but never actually rendered to (confirmed dead — no reachable
 * code exercises `renderer.setViewport`, `cameraHelper` isn't referenced
 * anywhere), so it's kept only as an inert scene member (as legacy does) and
 * not exposed as anything usable.
 *
 * Pinned to `three@0.84.0` — see FishEye3D.ts's doc comment for why.
 *
 * NOTE — confirmed real bug preserved: `onWindowResize` reads a bare
 * `container` identifier that is never declared in its own scope or in the
 * enclosing `Fisheye3DMulti()` factory scope — only inside `init()`'s own
 * function-local `var container`, which `onWindowResize` (a sibling method)
 * cannot see. Reproduced as the same ReferenceError legacy throws (see
 * FishEye3D.ts's `undefinedGlobalError` helper, reused here).
 */

function undefinedGlobalError(name: string): ReferenceError {
  return new ReferenceError(`${name} is not defined`);
}

const INIT_FOV = 45;
const MIN_DIST = 0.0000000001;
const DISTANCE_NEAR = 500;
const NUM_RECT = 32;

export type FisheyeMultiTextureSource = (HTMLVideoElement | HTMLCanvasElement) & { width: number; height: number };

interface CylindricalMesh {
  mNumTriangles: number;
  position: number[];
  textureCoords: number[];
}

/** Ported from fishEye3D_multi.js's inline `var g = function () {...}` mesh generator inside `init()`. */
function buildCylindricalMesh(videoElement: FisheyeMultiTextureSource): CylindricalMesh {
  const position: number[] = [];
  const textureCoords: number[] = [];
  const mNumTriangles = NUM_RECT * 2;

  const radGap = Math.PI / NUM_RECT;
  const ratio = ((videoElement.height / videoElement.width) * Math.PI) / 2;
  const texWidth = 1.0 / NUM_RECT;

  for (let i = 0; i < NUM_RECT; i++) {
    let pos = i * 18;
    let tex = i * 12;

    const radFrom = radGap * (NUM_RECT - i);
    const radTo = radGap * (NUM_RECT - 1 - i);
    const x1 = Math.cos(radFrom);
    const x2 = Math.cos(radTo);
    const z1 = Math.sin(radFrom);
    const z2 = Math.sin(radTo);

    position[pos++] = x1;
    position[pos++] = ratio;
    position[pos++] = -z1;
    position[pos++] = x1;
    position[pos++] = -ratio;
    position[pos++] = -z1;
    position[pos++] = x2;
    position[pos++] = ratio;
    position[pos++] = -z2;

    position[pos++] = x2;
    position[pos++] = ratio;
    position[pos++] = -z2;
    position[pos++] = x1;
    position[pos++] = -ratio;
    position[pos++] = -z1;
    position[pos++] = x2;
    position[pos++] = -ratio;
    position[pos++] = -z2;

    textureCoords[tex++] = texWidth * i;
    textureCoords[tex++] = 1.0;
    textureCoords[tex++] = texWidth * i;
    textureCoords[tex++] = 0.0;
    textureCoords[tex++] = texWidth * i + texWidth;
    textureCoords[tex++] = 1.0;
    textureCoords[tex++] = texWidth * i + texWidth;
    textureCoords[tex++] = 1.0;
    textureCoords[tex++] = texWidth * i;
    textureCoords[tex++] = 0.0;
    textureCoords[tex++] = texWidth * i + texWidth;
    textureCoords[tex++] = 0.0;
  }

  return { mNumTriangles, position, textureCoords };
}

export class Fisheye3DMulti {
  private camera: THREE.PerspectiveCamera | null = null;
  private scene: THREE.Scene | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private isUserInteracting = false;
  private onPointerDownPointerX = 0;
  private onPointerDownPointerY = 0;
  private onPointerDownLon = 0;
  private onPointerDownLat = 0;
  private lon = 0;
  private lat = 0;
  private phi = 0;
  private theta = 0;
  private distance = 230;
  private fov = INIT_FOV;
  private tex: THREE.Texture | null = null;

  constructor(private readonly rendererFactory: () => THREE.WebGLRenderer = () => new THREE.WebGLRenderer()) {}

  init(videoElement: FisheyeMultiTextureSource): void {
    const container = document.getElementById('mi-full-camera');
    if (!container) {
      return;
    }

    this.camera = new THREE.PerspectiveCamera(INIT_FOV, window.innerWidth / window.innerHeight, 1, 4400);
    (this.camera as unknown as { target: THREE.Vector3 }).target = new THREE.Vector3(0, 0, 0);

    this.scene = new THREE.Scene();

    const g = buildCylindricalMesh(videoElement);

    const geo = new THREE.Geometry();
    geo.verticesNeedUpdate = true;
    geo.elementsNeedUpdate = true;
    geo.uvsNeedUpdate = true;

    for (let i = 0; i < g.mNumTriangles; i++) {
      geo.vertices.push(
        new THREE.Vector3(g.position[i * 9 + 0] * 200, g.position[i * 9 + 1] * 200, g.position[i * 9 + 2] * 200),
        new THREE.Vector3(g.position[i * 9 + 3] * 200, g.position[i * 9 + 4] * 200, g.position[i * 9 + 5] * 200),
        new THREE.Vector3(g.position[i * 9 + 6] * 200, g.position[i * 9 + 7] * 200, g.position[i * 9 + 8] * 200)
      );
      geo.faces.push(new THREE.Face3(i * 3 + 0, i * 3 + 1, i * 3 + 2));
      geo.faceVertexUvs[0].push([
        new THREE.Vector2(g.textureCoords[i * 6 + 0], g.textureCoords[i * 6 + 1]),
        new THREE.Vector2(g.textureCoords[i * 6 + 2], g.textureCoords[i * 6 + 3]),
        new THREE.Vector2(g.textureCoords[i * 6 + 4], g.textureCoords[i * 6 + 5])
      ]);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.fromGeometry(geo);

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
    const mesh = new THREE.Mesh(geometry, material);
    this.scene.add(mesh);

    const helper = new THREE.GridHelper(1000, 50, 0xff0000, 0x000000);
    helper.position.y = -199;
    (helper.material as THREE.Material).opacity = 0.25;
    (helper.material as THREE.Material).transparent = true;
    this.scene.add(helper);

    this.renderer = this.rendererFactory();
    this.renderer.setClearColor(0xf0f0f0);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    const minimapCamera = new THREE.PerspectiveCamera(20, 1, 1, 10000);
    minimapCamera.position.y = 50;
    minimapCamera.position.z = 1800;
    this.scene.add(minimapCamera);

    this.renderer.autoClear = false;
    container.appendChild(this.renderer.domElement);

    document.addEventListener('mousedown', this.onDocumentMouseDown as EventListener, false);
    document.addEventListener('mousemove', this.onDocumentMouseMove as EventListener, false);
    document.addEventListener('mouseup', this.onDocumentMouseUp as EventListener, false);
    document.addEventListener('dblclick', this.onDocumentMouseDbClick as EventListener, false);
    document.addEventListener('mousewheel', this.onDocumentMouseWheel as EventListener, false);
    document.addEventListener('MozMousePixelScroll', this.onDocumentMouseWheel as EventListener, false);

    window.addEventListener('resize', this.onWindowResize, false);
  }

  onWindowResize = (): void => {
    // NOTE: confirmed real bug preserved — see class-level doc comment.
    throw undefinedGlobalError('container');
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
    if (this.isUserInteracting === true) {
      this.lon = (this.onPointerDownPointerX - event.clientX) * 0.1 + this.onPointerDownLon;
      this.lat = (this.onPointerDownPointerY - event.clientY) * 0.1 + this.onPointerDownLat;
    }
  };

  onDocumentMouseUp = (): void => {
    this.isUserInteracting = false;
  };

  onDocumentMouseDbClick = (): void => {
    if (this.distance > MIN_DIST) {
      this.distance = MIN_DIST;
    } else {
      this.distance = 500;
    }
  };

  onDocumentMouseWheel = (event: WheelEvent & { wheelDeltaY?: number; wheelDelta?: number }): void => {
    if (event.wheelDeltaY) {
      this.distance -= event.wheelDeltaY * 0.005;
    } else if (event.wheelDelta) {
      this.distance -= event.wheelDelta * 0.005;
    } else if (event.detail) {
      this.distance += event.detail * 0.5;
    }

    if (this.distance < MIN_DIST) {
      this.distance = MIN_DIST;
      if (this.fov > 1) {
        this.fov -= 1;
      }
    } else if (this.fov < INIT_FOV) {
      this.distance = MIN_DIST;
      this.fov += 1;
    }
  };

  animate = (): void => {
    // NOTE: legacy never stores the requestAnimationFrame handle here (no
    // `animateId`, unlike Fisheye3D.js's `animate`/`start`/`stop`) — this
    // class has no way to stop its render loop once started, preserved as-is.
    window.requestAnimationFrame(this.animate);
    this.update();
  };

  update(): void {
    if (this.tex) {
      this.tex.needsUpdate = true;
    }

    const camera = this.camera!;
    camera.up.set(0, 1, 0);

    let limit = 0.0;
    if (this.distance < DISTANCE_NEAR) {
      limit = (Math.atan(Math.tan((this.fov * Math.PI) / 180 / 2) * camera.aspect) * 180) / Math.PI;
      if (this.distance > MIN_DIST) {
        limit *= 1.0 - (1.0 * this.distance) / DISTANCE_NEAR;
      }
    }

    this.lat = Math.max(-75, Math.min(75, this.lat));
    this.phi = THREE.Math.degToRad(this.lat - 90);
    this.lon = limit > 90 ? 0 : Math.max(limit - 90, Math.min(90 - limit, this.lon));
    this.theta = THREE.Math.degToRad(this.lon - 90);

    camera.position.x = this.distance * Math.sin(this.phi) * Math.cos(this.theta);
    camera.position.y = this.distance * Math.cos(this.phi);
    camera.position.z = this.distance * Math.sin(this.phi) * Math.sin(this.theta);
    if (camera.fov !== this.fov) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }

    camera.lookAt((camera as unknown as { target: THREE.Vector3 }).target);
    this.renderer!.clear();
    this.renderer!.render(this.scene!, camera);
  }
}
