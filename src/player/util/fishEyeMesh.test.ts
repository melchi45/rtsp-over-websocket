import { describe, it, expect } from 'vitest';
import { loadLegacyModuleSlice } from '../test-support/loadLegacyModule';
import { MeshVertex, FisheyeConfig, GridMesh, FisheyeMeshGenerator } from './fishEyeMesh';

interface LegacyMeshVertexCtor {
  new (vertex?: unknown): { u: number; v: number; x: number; y: number; z: number };
}
interface LegacyFisheyeConfigCtor {
  new (centerX: number, centerY: number, circleMaxFOV: number, circleFOV: number, circleRadius: number): {
    GetCenterX(): number;
    GetCenterY(): number;
    GetCircleFOV(): number;
    GetCircleRadius(): number;
    GetFOV(radius: number): number;
    GetHeight(): number;
    GetMaxFOV(): number;
    GetMaxRadius(): number;
    GetRadius(fov: number): number;
    GetWidth(): number;
  };
}
interface LegacyGridMeshCtor {
  new (): {
    m_FisheyeConfig: unknown;
    m_FisheyeWidth: number;
    m_FisheyeHeight: number;
    m_TextureWidth: number;
    m_TextureHeight: number;
    m_InvertX: boolean;
    m_InvertY: boolean;
    ClipToCircle(vertex: { u: number; v: number }): boolean;
    Normalize(vertex: { u: number; v: number }): boolean;
    GenerateMesh(
      step: number,
      fisheyeConfig: unknown,
      fisheyeWidth: number,
      fisheyeHeight: number,
      textureWidth: number,
      textureHeight: number,
      invertX: boolean,
      invertY: boolean
    ): void;
    GetTriangleCount(): number;
    GetTriangles(): number[];
  };
}
interface LegacyGenCtor {
  new (): { mNumTriangles: number; position: Float32Array; textureCoords: Float32Array; generateVertices(): void };
}

const legacy = loadLegacyModuleSlice<{
  meshVertex: LegacyMeshVertexCtor;
  FisheyeConfig: LegacyFisheyeConfigCtor;
  GridMesh: LegacyGridMeshCtor;
  GEN: LegacyGenCtor;
}>(
  'Util/fishEye3D.js',
  [
    [4, 33],
    [35, 329]
  ],
  ['meshVertex', 'FisheyeConfig', 'GridMesh', 'GEN']
);

const RESOL = 2992.0;

describe('fishEyeMesh parity with the meshVertex/GridMesh/FisheyeConfig/GEN classes in the legacy player’s Util/fishEye3D.js', () => {
  describe('FisheyeConfig', () => {
    it('computes the same derived FOV/radius conversion getters identically', () => {
      const legacyConfig = new legacy.FisheyeConfig(RESOL / 2, RESOL / 2, 170.0, 170.0, RESOL / 2);
      const portedConfig = new FisheyeConfig(RESOL / 2, RESOL / 2, 170.0, 170.0, RESOL / 2);

      expect(portedConfig.GetCenterX()).toBe(legacyConfig.GetCenterX());
      expect(portedConfig.GetCenterY()).toBe(legacyConfig.GetCenterY());
      expect(portedConfig.GetCircleFOV()).toBe(legacyConfig.GetCircleFOV());
      expect(portedConfig.GetCircleRadius()).toBe(legacyConfig.GetCircleRadius());
      expect(portedConfig.GetMaxFOV()).toBe(legacyConfig.GetMaxFOV());
      expect(portedConfig.GetMaxRadius()).toBe(legacyConfig.GetMaxRadius());
      expect(portedConfig.GetHeight()).toBe(legacyConfig.GetHeight());
      expect(portedConfig.GetWidth()).toBe(legacyConfig.GetWidth());
      for (const radius of [0, 100, 500, 823.12506, 1000, 2000]) {
        expect(portedConfig.GetFOV(radius)).toBe(legacyConfig.GetFOV(radius));
      }
      for (const fov of [0, 45, 90, 170, 200]) {
        expect(portedConfig.GetRadius(fov)).toBe(legacyConfig.GetRadius(fov));
      }
    });

    it('clamps m_MaxFOV to circleMaxFOV when circleFOV exceeds it, identically', () => {
      const legacyConfig = new legacy.FisheyeConfig(0, 0, 90.0, 170.0, 500);
      const portedConfig = new FisheyeConfig(0, 0, 90.0, 170.0, 500);
      expect(portedConfig.GetMaxFOV()).toBe(legacyConfig.GetMaxFOV());
      expect(portedConfig.GetMaxFOV()).toBe(90.0);
    });
  });

  describe('GridMesh', () => {
    it('ClipToCircle clamps an out-of-circle vertex onto the circle boundary identically', () => {
      const config = new FisheyeConfig(RESOL / 2, RESOL / 2, 170.0, 170.0, RESOL / 2);
      const legacyConfig = new legacy.FisheyeConfig(RESOL / 2, RESOL / 2, 170.0, 170.0, RESOL / 2);

      const legacyMesh = new legacy.GridMesh();
      legacyMesh.m_FisheyeConfig = legacyConfig;
      const portedMesh = new GridMesh();
      portedMesh.m_FisheyeConfig = config;

      const legacyVertex = { u: RESOL, v: RESOL };
      const portedVertex = { u: RESOL, v: RESOL };
      const legacyResult = legacyMesh.ClipToCircle(legacyVertex);
      const portedResult = portedMesh.ClipToCircle(portedVertex);

      expect(portedResult).toBe(legacyResult);
      expect(portedResult).toBe(false);
      expect(portedVertex.u).toBeCloseTo(legacyVertex.u, 10);
      expect(portedVertex.v).toBeCloseTo(legacyVertex.v, 10);
    });

    it('Normalize clamps to [0,1] and rescales identically', () => {
      const legacyMesh = new legacy.GridMesh();
      legacyMesh.m_FisheyeWidth = RESOL;
      legacyMesh.m_FisheyeHeight = RESOL;
      legacyMesh.m_TextureWidth = RESOL;
      legacyMesh.m_TextureHeight = RESOL;

      const portedMesh = new GridMesh();
      portedMesh.m_FisheyeWidth = RESOL;
      portedMesh.m_FisheyeHeight = RESOL;
      portedMesh.m_TextureWidth = RESOL;
      portedMesh.m_TextureHeight = RESOL;

      for (const [u, v] of [
        [-100, -100],
        [RESOL / 2, RESOL / 2],
        [RESOL * 2, RESOL * 2]
      ]) {
        const legacyVertex = { u, v };
        const portedVertex = { u, v };
        const legacyResult = legacyMesh.Normalize(legacyVertex);
        const portedResult = portedMesh.Normalize(portedVertex);
        expect(portedResult).toBe(legacyResult);
        expect(portedVertex.u).toBeCloseTo(legacyVertex.u, 10);
        expect(portedVertex.v).toBeCloseTo(legacyVertex.v, 10);
      }
    });

    it('GenerateMesh produces the same triangle count and triangle data identically', () => {
      const legacyConfig = new legacy.FisheyeConfig(RESOL / 2, RESOL / 2, 170.0, 170.0, RESOL / 2);
      const portedConfig = new FisheyeConfig(RESOL / 2, RESOL / 2, 170.0, 170.0, RESOL / 2);
      const legacyMesh = new legacy.GridMesh();
      const portedMesh = new GridMesh();

      legacyMesh.GenerateMesh(124.0, legacyConfig, RESOL, RESOL, RESOL, RESOL, false, true);
      portedMesh.GenerateMesh(124.0, portedConfig, RESOL, RESOL, RESOL, RESOL, false, true);

      expect(portedMesh.GetTriangleCount()).toBe(legacyMesh.GetTriangleCount());
      const legacyTriangles = legacyMesh.GetTriangles();
      const portedTriangles = portedMesh.GetTriangles();
      expect(portedTriangles.length).toBe(legacyTriangles.length);
      for (let i = 0; i < legacyMesh.GetTriangleCount() * 15; i++) {
        expect(portedTriangles[i]).toBeCloseTo(legacyTriangles[i] as number, 8);
      }
    });
  });

  describe('MeshVertex', () => {
    it('copies from an existing vertex identically', () => {
      // `instanceof meshVertex` is checked in legacy's constructor, so the
      // source must be a real instance from the *same* class — a plain
      // object literal would (correctly) hit the "invalid overload" branch.
      const legacySource = new legacy.meshVertex();
      Object.assign(legacySource, { u: 1, v: 2, x: 3, y: 4, z: 5 });
      const portedSource = new MeshVertex();
      Object.assign(portedSource, { u: 1, v: 2, x: 3, y: 4, z: 5 });

      const legacyVertex = new legacy.meshVertex(legacySource);
      const portedVertex = new MeshVertex(portedSource);
      expect(portedVertex).toEqual(legacyVertex);
    });

    it('defaults every field to 0 when called with no arguments, identically', () => {
      const legacyVertex = new legacy.meshVertex();
      const portedVertex = new MeshVertex();
      expect(portedVertex).toEqual(legacyVertex);
    });

    it('throws "invalid overload" identically for a non-vertex, non-undefined argument', () => {
      let legacyMessage = '';
      let portedMessage = '';
      try {
        new legacy.meshVertex('not-a-vertex' as never);
      } catch (e) {
        legacyMessage = (e as Error).message;
      }
      try {
        new MeshVertex('not-a-vertex' as never);
      } catch (e) {
        portedMessage = (e as Error).message;
      }
      expect(portedMessage).toBe(legacyMessage);
      expect(portedMessage).toBe('invalid overload');
    });
  });

  describe('FisheyeMeshGenerator (GEN)', () => {
    it('generates the same triangle count, position, and textureCoords arrays as legacy GEN.generateVertices(), identically', () => {
      const legacyGen = new legacy.GEN();
      legacyGen.generateVertices();

      const portedGen = new FisheyeMeshGenerator();
      portedGen.generateVertices(RESOL);

      expect(portedGen.mNumTriangles).toBe(legacyGen.mNumTriangles);
      expect(portedGen.position.length).toBe(legacyGen.position.length);
      expect(portedGen.textureCoords.length).toBe(legacyGen.textureCoords.length);
      for (let i = 0; i < legacyGen.position.length; i++) {
        expect(portedGen.position[i]).toBeCloseTo(legacyGen.position[i], 4);
      }
      for (let i = 0; i < legacyGen.textureCoords.length; i++) {
        expect(portedGen.textureCoords[i]).toBeCloseTo(legacyGen.textureCoords[i], 4);
      }
    });
  });
});
