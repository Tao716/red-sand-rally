import { sampleTrack } from './track';
import type { Racer } from './types';

export interface PointXZ { x: number; z: number }

/** A convex footprint with a vertical extent, in world coordinates. */
export interface CollisionVolume {
  points: readonly PointXZ[];
  minY: number;
  maxY: number;
}

export interface StaticCollider extends CollisionVolume {
  id: string;
  kind: 'barrier' | 'rock' | 'structure';
}

export interface CollisionContact {
  /** Unit normal from B toward A: translating A by normal * depth separates it. */
  nx: number;
  nz: number;
  depth: number;
  point: { x: number; y: number; z: number };
}

export const CAR_HALF_WIDTH = 1.38;
export const CAR_HALF_LENGTH = 2.4;
export const CAR_HALF_HEIGHT = 1.08;

const EPSILON = 1e-7;
const GRID_SIZE = 24;

interface Bounds { minX: number; maxX: number; minZ: number; maxZ: number }

function boundsFor(volume: CollisionVolume): Bounds | null {
  if (volume.points.length < 3 || !Number.isFinite(volume.minY) || !Number.isFinite(volume.maxY)
    || volume.maxY - volume.minY <= EPSILON) return null;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of volume.points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) return null;
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  if (maxX - minX <= EPSILON || maxZ - minZ <= EPSILON) return null;
  return { minX, maxX, minZ, maxZ };
}

function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return a.maxX >= b.minX && b.maxX >= a.minX && a.maxZ >= b.minZ && b.maxZ >= a.minZ;
}

function project(points: readonly PointXZ[], nx: number, nz: number): [number, number] {
  let min = Infinity, max = -Infinity;
  for (const p of points) {
    const dot = p.x * nx + p.z * nz;
    min = Math.min(min, dot); max = Math.max(max, dot);
  }
  return [min, max];
}

function signedArea(points: readonly PointXZ[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    area += a.x * b.z - b.x * a.z;
  }
  return area;
}

/** Locate sparks inside the actual overlap, including corner/edge contacts. */
function overlapCenter(a: readonly PointXZ[], b: readonly PointXZ[]): PointXZ {
  let clipped = a.map(p => ({ ...p }));
  const winding = signedArea(b) >= 0 ? 1 : -1;
  for (let i = 0; i < b.length && clipped.length; i++) {
    const start = b[i], end = b[(i + 1) % b.length];
    const distance = (p: PointXZ) => winding * ((end.x - start.x) * (p.z - start.z)
      - (end.z - start.z) * (p.x - start.x));
    const input = clipped;
    clipped = [];
    let previous = input[input.length - 1], previousDistance = distance(previous);
    for (const current of input) {
      const currentDistance = distance(current);
      if ((previousDistance >= -EPSILON) !== (currentDistance >= -EPSILON)) {
        const t = Math.max(0, Math.min(1, previousDistance / (previousDistance - currentDistance)));
        clipped.push({ x: previous.x + (current.x - previous.x) * t,
          z: previous.z + (current.z - previous.z) * t });
      }
      if (currentDistance >= -EPSILON) clipped.push(current);
      previous = current; previousDistance = currentDistance;
    }
  }
  const area = signedArea(clipped);
  if (Math.abs(area) > EPSILON) {
    let x = 0, z = 0;
    for (let i = 0; i < clipped.length; i++) {
      const p = clipped[i], q = clipped[(i + 1) % clipped.length];
      const cross = p.x * q.z - q.x * p.z;
      x += (p.x + q.x) * cross; z += (p.z + q.z) * cross;
    }
    return { x: x / (3 * area), z: z / (3 * area) };
  }
  // Near-zero contact patches can lose their area to floating-point precision.
  const points = clipped.length ? clipped : a;
  return { x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    z: points.reduce((sum, p) => sum + p.z, 0) / points.length };
}

/** +Z is forward; yaw follows THREE.Object3D.rotation.y. y is the box center. */
export function createBoxVolume(x: number, y: number, z: number, halfWidth: number,
  halfHeight: number, halfLength: number, yaw = 0): CollisionVolume {
  const w = Math.abs(halfWidth), h = Math.abs(halfHeight), l = Math.abs(halfLength);
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  return {
    points: [[-w, -l], [w, -l], [w, l], [-w, l]].map(([px, pz]) => ({
      x: x + px * cos + pz * sin,
      z: z - px * sin + pz * cos,
    })),
    minY: y - h,
    maxY: y + h,
  };
}

/** Horizontal convex SAT, with a vertical rejection for bridges/raised scenery. */
export function intersectVolumes(a: CollisionVolume, b: CollisionVolume): CollisionContact | null {
  if (Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) <= EPSILON) return null;
  const boundsA = boundsFor(a), boundsB = boundsFor(b);
  if (!boundsA || !boundsB || !boundsOverlap(boundsA, boundsB)) return null;
  if (Math.abs(signedArea(a.points)) <= EPSILON || Math.abs(signedArea(b.points)) <= EPSILON) return null;
  let depth = Infinity, normalX = 0, normalZ = 0;
  for (const points of [a.points, b.points]) {
    for (let i = 0; i < points.length; i++) {
      const p = points[i], q = points[(i + 1) % points.length];
      const dx = q.x - p.x, dz = q.z - p.z, length = Math.hypot(dx, dz);
      if (length <= EPSILON) continue;
      let nx = -dz / length, nz = dx / length;
      const [minA, maxA] = project(a.points, nx, nz);
      const [minB, maxB] = project(b.points, nx, nz);
      const positive = maxB - minA, negative = maxA - minB;
      if (positive <= EPSILON || negative <= EPSILON) return null;
      // Intersection width is insufficient when one volume contains the other.
      // Compare the complete translation needed to leave B in either direction.
      const axisDepth = Math.min(positive, negative);
      if (negative < positive - EPSILON
        || (Math.abs(positive - negative) <= EPSILON && (nx < -EPSILON || (Math.abs(nx) <= EPSILON && nz < 0)))) {
        nx = -nx; nz = -nz;
      }
      if (axisDepth < depth - EPSILON) { depth = axisDepth; normalX = nx; normalZ = nz; }
    }
  }
  if (!Number.isFinite(depth)) return null;
  const center = overlapCenter(a.points, b.points);
  return { nx: normalX, nz: normalZ, depth,
    point: { x: center.x, y: (Math.max(a.minY, b.minY) + Math.min(a.maxY, b.maxY)) / 2, z: center.z } };
}

/** Immutable scenery broadphase. A collider crossing multiple cells is returned once. */
export class StaticCollisionIndex {
  private readonly cells = new Map<string, { collider: StaticCollider; bounds: Bounds }[]>();

  constructor(colliders: readonly StaticCollider[]) {
    for (const collider of colliders) {
      const bounds = boundsFor(collider);
      if (!bounds) continue;
      const entry = { collider, bounds };
      for (let x = Math.floor(bounds.minX / GRID_SIZE); x <= Math.floor(bounds.maxX / GRID_SIZE); x++) {
        for (let z = Math.floor(bounds.minZ / GRID_SIZE); z <= Math.floor(bounds.maxZ / GRID_SIZE); z++) {
          const key = `${x},${z}`;
          const entries = this.cells.get(key);
          if (entries) entries.push(entry); else this.cells.set(key, [entry]);
        }
      }
    }
  }

  query(volume: CollisionVolume): StaticCollider[] {
    const bounds = boundsFor(volume);
    if (!bounds) return [];
    const result: StaticCollider[] = [], seen = new Set<StaticCollider>();
    for (let x = Math.floor(bounds.minX / GRID_SIZE); x <= Math.floor(bounds.maxX / GRID_SIZE); x++) {
      for (let z = Math.floor(bounds.minZ / GRID_SIZE); z <= Math.floor(bounds.maxZ / GRID_SIZE); z++) {
        for (const entry of this.cells.get(`${x},${z}`) ?? []) {
          if (seen.has(entry.collider)) continue;
          seen.add(entry.collider);
          if (boundsOverlap(bounds, entry.bounds) && Math.min(volume.maxY, entry.collider.maxY)
            - Math.max(volume.minY, entry.collider.minY) > EPSILON) result.push(entry.collider);
        }
      }
    }
    return result;
  }
}

export function racerVolume(racer: Pick<Racer, 'distance' | 'lateral' | 'heading'>): CollisionVolume {
  const p = sampleTrack(racer.distance);
  return createBoxVolume(p.x + p.nx * racer.lateral, p.y + CAR_HALF_HEIGHT + 0.04,
    p.z + p.nz * racer.lateral, CAR_HALF_WIDTH, CAR_HALF_HEIGHT, CAR_HALF_LENGTH,
    p.heading + racer.heading);
}
