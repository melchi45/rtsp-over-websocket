/**
 * Ported from the `meshVertex`/`GridMesh`/`FisheyeConfig`/`GEN` classes
 * shared (byte-for-byte duplicated) between the legacy player’s Util/fishEye3D.js
 * and fishEye3D_multi.js — pure numeric mesh-triangulation math for fisheye
 * lens dewarping, with zero THREE.js/DOM dependency, extracted into one
 * shared module (DRY) rather than kept duplicated.
 *
 * Only `Fisheye3D` (fishEye3D.js) actually uses this — confirmed via
 * `Fisheye3DMulti`'s own `init()` (fishEye3D_multi.js), which builds its mesh
 * with its own inline cylindrical-panorama generator instead (the `var g =
 * new GEN()` call is commented out there) — so in that file this entire
 * class hierarchy is dead code, and is not ported as part of Fisheye3DMulti.
 *
 * Method names (`GetCenterX`, `ClipToCircle`, ...) keep their original
 * PascalCase/Java-SDK-style naming rather than being renamed to camelCase:
 * this is a direct port of a specific dewarping algorithm (most likely
 * itself ported from a vendor fisheye SDK), and preserving the exact names
 * keeps it traceable against that source rather than just app glue code.
 */

export class MeshVertex {
  u = 0;
  v = 0;
  x = 0;
  y = 0;
  z = 0;

  constructor(vertex?: MeshVertex | null) {
    if ((vertex !== null && vertex !== undefined && vertex instanceof MeshVertex) || vertex === null) {
      // NOTE: legacy bug preserved — if `vertex` is literally `null`, this
      // branch is still entered (per the original `|| vertex === null`
      // condition) and then immediately dereferences `vertex.x`, throwing a
      // TypeError. Never actually exercised anywhere in the legacy call
      // sites (`new meshVertex(someRealVertex)` or `new meshVertex()` only).
      this.x = vertex!.x;
      this.y = vertex!.y;
      this.z = vertex!.z;
      this.u = vertex!.u;
      this.v = vertex!.v;
    } else if (typeof vertex === 'undefined') {
      this.u = 0;
      this.v = 0;
      this.x = 0;
      this.y = 0;
      this.z = 0;
    } else {
      throw new Error('invalid overload');
    }
  }
}

export class FisheyeConfig {
  static readonly DEFAULT_MAX_FOV = 170.0;
  static readonly DEFAULT_MAX_RADIUS = 823.12506;

  private readonly m_CenterX: number;
  private readonly m_CenterY: number;
  private readonly m_CircleFOV: number;
  private readonly m_CircleRadius: number;
  private readonly m_FOVToRadius: number;
  private readonly m_MaxFOV: number;
  private readonly m_MaxRadius: number;
  private readonly m_RadiusToFOV: number;

  constructor(centerX: number, centerY: number, circleMaxFOV: number, circleFOV: number, circleRadius: number) {
    this.m_CircleFOV = circleFOV;
    this.m_CircleRadius = circleRadius;
    this.m_CenterX = centerX;
    this.m_CenterY = centerY;
    this.m_MaxFOV = this.m_CircleFOV > circleMaxFOV ? circleMaxFOV : this.m_CircleFOV;
    this.m_MaxRadius = this.m_CircleRadius;
    this.m_RadiusToFOV = this.m_MaxFOV / this.m_MaxRadius;
    this.m_FOVToRadius = this.m_MaxRadius / this.m_MaxFOV;
  }

  GetCenterX(): number {
    return this.m_CenterX;
  }
  GetCenterY(): number {
    return this.m_CenterY;
  }
  GetCircleFOV(): number {
    return this.m_CircleFOV;
  }
  GetCircleRadius(): number {
    return this.m_CircleRadius;
  }
  GetFOV(radius: number): number {
    return radius <= this.m_MaxRadius ? this.m_RadiusToFOV * radius : -1.0;
  }
  GetHeight(): number {
    return this.GetMaxRadius() * 2.0;
  }
  GetMaxFOV(): number {
    return this.m_MaxFOV;
  }
  GetMaxRadius(): number {
    return this.m_MaxRadius;
  }
  GetRadius(fov: number): number {
    return fov <= this.m_MaxFOV ? this.m_FOVToRadius * fov : -1.0;
  }
  GetWidth(): number {
    return this.GetMaxRadius() * 2.0;
  }
}

export class GridMesh {
  static readonly DEGREETORAD = 0.017453293;

  m_InvertX = false;
  m_InvertY = false;
  m_FisheyeHeight = 0;
  m_FisheyeWidth = 0;
  m_NumTriangles = 0;
  m_TextureHeight = 0;
  m_TextureWidth = 0;
  m_FisheyeConfig!: FisheyeConfig;
  m_Triangles: number[] = [];

  ClipToCircle(vertex: MeshVertex): boolean {
    const centerX = this.m_FisheyeConfig.GetCenterX();
    const centerY = this.m_FisheyeConfig.GetCenterY();
    let maxRadius = this.m_FisheyeConfig.GetMaxRadius();
    const dist = Math.sqrt((vertex.u - centerX) * (vertex.u - centerX) + (vertex.v - centerY) * (vertex.v - centerY));
    const withinCircle = dist < maxRadius;
    if (!withinCircle) {
      maxRadius /= dist;
      vertex.u = (vertex.u - centerX) * maxRadius + centerX;
      vertex.v = (vertex.v - centerY) * maxRadius + centerY;
    }
    return withinCircle;
  }

  CreateTriangle(vertex1: MeshVertex, vertex2: MeshVertex, vertex3: MeshVertex): void {
    const var1 = new MeshVertex(vertex1);
    const var2 = new MeshVertex(vertex2);
    const var3 = new MeshVertex(vertex3);

    const v1 = this.ClipToCircle(var1);
    const v2 = this.ClipToCircle(var2);
    const v3 = this.ClipToCircle(var3);
    const n1 = this.Normalize(var1);
    const n2 = this.Normalize(var2);
    const n3 = this.Normalize(var3);

    if ((v1 || v2 || v3) && (n1 || n2 || n3)) {
      this.Find3DPos(var1);
      this.Find3DPos(var2);
      this.Find3DPos(var3);
      const base = this.m_NumTriangles * 5 * 3;
      this.m_Triangles[base + 0] = var1.x;
      this.m_Triangles[base + 1] = var1.y;
      this.m_Triangles[base + 2] = var1.z;
      this.m_Triangles[base + 3] = var1.u;
      this.m_Triangles[base + 4] = var1.v;
      this.m_Triangles[base + 5 + 0] = var2.x;
      this.m_Triangles[base + 5 + 1] = var2.y;
      this.m_Triangles[base + 5 + 2] = var2.z;
      this.m_Triangles[base + 5 + 3] = var2.u;
      this.m_Triangles[base + 5 + 4] = var2.v;
      this.m_Triangles[base + 10 + 0] = var3.x;
      this.m_Triangles[base + 10 + 1] = var3.y;
      this.m_Triangles[base + 10 + 2] = var3.z;
      this.m_Triangles[base + 10 + 3] = var3.u;
      this.m_Triangles[base + 10 + 4] = var3.v;
      ++this.m_NumTriangles;
    }
  }

  Find3DPos(vertex: MeshVertex): void {
    const textureWidth = this.m_TextureWidth;
    const textureHeight = this.m_TextureHeight;
    const u = vertex.u * textureWidth - this.m_FisheyeConfig.GetCenterX();
    const vScaled = vertex.v * textureHeight - this.m_FisheyeConfig.GetCenterY();
    const v = this.m_InvertY ? -vScaled : vScaled;
    const uScaled = this.m_InvertX ? -u : u;

    const maxRadius = this.m_FisheyeConfig.GetMaxRadius();
    let radius = Math.sqrt(uScaled * uScaled + v * v);
    if (radius > maxRadius) {
      radius = maxRadius;
    }
    const halfFovRad = (GridMesh.DEGREETORAD * this.m_FisheyeConfig.GetFOV(radius)) / 2.0;
    const angle = Math.atan2(v, uScaled);
    vertex.z = Math.cos(halfFovRad);
    vertex.y = Math.sin(halfFovRad) * Math.sin(angle);
    vertex.x = Math.sin(halfFovRad) * Math.cos(angle);
  }

  GenerateMesh(
    step: number,
    fisheyeConfig: FisheyeConfig,
    fisheyeWidth: number,
    fisheyeHeight: number,
    textureWidth: number,
    textureHeight: number,
    invertX: boolean,
    invertY: boolean
  ): void {
    this.m_InvertX = invertX;
    this.m_InvertY = invertY;
    this.m_FisheyeConfig = fisheyeConfig;
    this.m_FisheyeWidth = fisheyeWidth;
    this.m_FisheyeHeight = fisheyeHeight;
    this.m_TextureWidth = textureWidth;
    this.m_TextureHeight = textureHeight;
    const stepY = (3.0 * step) / 4.0;
    const maxRadius = this.m_FisheyeConfig.GetMaxRadius();
    const v19 = new MeshVertex();
    const v16 = new MeshVertex();
    const v17 = new MeshVertex();
    const v18 = new MeshVertex();
    this.m_NumTriangles = 0;
    const cols = (Math.ceil(maxRadius / step + 0.5) | 0) * 2;
    const originX = this.m_FisheyeConfig.GetCenterX() - ((cols / 2) | 0) * step;
    const rows = (Math.ceil(maxRadius / stepY) | 0) * 2;
    const originY = this.m_FisheyeConfig.GetCenterY() - ((rows / 2) | 0) * stepY;
    this.m_Triangles = new Array(cols * 30 * rows);

    for (let row = 0; row < rows; ++row) {
      for (let col = 0; col < cols; ++col) {
        v19.v = row * stepY + originY;
        v16.v = row * stepY + originY;
        v17.v = (row + 1) * stepY + originY;
        v18.v = (row + 1) * stepY + originY;
        if (row % 2 === 0) {
          v16.u = (col + 1) * step + originX;
          v19.u = col * step + originX;
          v17.u = step / 2.0 + col * step + originX;
          v18.u = step / 2.0 + (col + 1) * step + originX;
          this.CreateTriangle(v19, v17, v16);
          this.CreateTriangle(v16, v17, v18);
        } else {
          v19.u = step / 2.0 + originX + col * step;
          v16.u = step / 2.0 + originX + (col + 1) * step;
          v17.u = col * step + originX;
          v18.u = (col + 1) * step + originX;
          this.CreateTriangle(v19, v18, v16);
          this.CreateTriangle(v19, v17, v18);
        }
      }
    }
  }

  GetTriangleCount(): number {
    return this.m_NumTriangles;
  }

  GetTriangles(): number[] {
    return this.m_Triangles;
  }

  Normalize(vertex: MeshVertex): boolean {
    let withinBounds = true;
    vertex.u /= this.m_FisheyeWidth;
    vertex.v /= this.m_FisheyeHeight;
    if (vertex.u < 0.0) {
      vertex.u = 0.0;
      withinBounds = false;
    }
    if (vertex.u > 1.0) {
      vertex.u = 1.0;
      withinBounds = false;
    }
    if (vertex.v < 0.0) {
      vertex.v = 0.0;
      withinBounds = false;
    }
    if (vertex.v > 1.0) {
      vertex.v = 1.0;
      withinBounds = false;
    }
    vertex.u *= this.m_FisheyeWidth / this.m_TextureWidth;
    vertex.v *= this.m_FisheyeHeight / this.m_TextureHeight;
    return withinBounds;
  }
}

export class FisheyeMeshGenerator {
  mNumTriangles = 0;
  position: Float32Array = new Float32Array(0);
  textureCoords: Float32Array = new Float32Array(0);

  generateVertices(resol: number): void {
    const fisheyeConfig = new FisheyeConfig(resol / 2, resol / 2, 170.0, 170.0, resol / 2);
    const gridMesh = new GridMesh();
    gridMesh.GenerateMesh(124.0, fisheyeConfig, resol, resol, resol, resol, false, true);
    this.mNumTriangles = gridMesh.GetTriangleCount();
    const triangles = gridMesh.GetTriangles();
    const numPoints = this.mNumTriangles * 3;
    this.position = new Float32Array(numPoints * 3);
    this.textureCoords = new Float32Array(numPoints * 2);
    for (let i = 0; i < this.mNumTriangles; ++i) {
      this.textureCoords[i * 6 + 0] = triangles[i * 15 + 3];
      this.textureCoords[i * 6 + 1] = triangles[i * 15 + 4];
      this.position[i * 9 + 0] = triangles[i * 15];
      this.position[i * 9 + 1] = triangles[i * 15 + 1];
      this.position[i * 9 + 2] = triangles[i * 15 + 2];
      this.textureCoords[i * 6 + 2] = triangles[i * 15 + 10 + 3];
      this.textureCoords[i * 6 + 3] = triangles[i * 15 + 10 + 4];
      this.position[i * 9 + 3] = triangles[i * 15 + 10];
      this.position[i * 9 + 4] = triangles[i * 15 + 10 + 1];
      this.position[i * 9 + 5] = triangles[i * 15 + 10 + 2];
      this.textureCoords[i * 6 + 4] = triangles[i * 15 + 5 + 3];
      this.textureCoords[i * 6 + 5] = triangles[i * 15 + 5 + 4];
      this.position[i * 9 + 6] = triangles[i * 15 + 5];
      this.position[i * 9 + 7] = triangles[i * 15 + 5 + 1];
      this.position[i * 9 + 8] = triangles[i * 15 + 5 + 2];
    }
  }
}
