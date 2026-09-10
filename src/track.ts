import * as THREE from 'three';

export const TRACK_WIDTH = 19;
export const TRACK_POINTS = [
  [0, 1.1, 180],
  [0, 1.1, 55],
  [-42, 2.2, -54],
  [-28, 5.5, -165],
  [74, 8.0, -245],
  [192, 7.0, -213],
  [229, 3.2, -105],
  [151, 1.1, -20],
  [179, 1.1, 100],
  [249, 3.2, 200],
  [201, 5.6, 280],
  [80, 2.8, 294],
] as const;
export const TRACK_CURVE = new THREE.CatmullRomCurve3(
  TRACK_POINTS.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
  true, 'catmullrom', 0.42,
);
TRACK_CURVE.arcLengthDivisions = 3000;
TRACK_CURVE.updateArcLengths();
export const TRACK_LENGTH = TRACK_CURVE.getLength();

export interface TrackSample {
  x: number; y: number; z: number;
  tx: number; tz: number;
  nx: number; nz: number;
  heading: number; curvature: number;
}
const SAMPLES = 3000;
const cached: Omit<TrackSample, 'curvature'>[] = [];
for (let i = 0; i <= SAMPLES; i++) {
  const t = (i % SAMPLES) / SAMPLES;
  const p = TRACK_CURVE.getPointAt(t);
  const v = TRACK_CURVE.getTangentAt(t);
  const mag = Math.hypot(v.x, v.z);
  const tx = v.x / mag;
  const tz = v.z / mag;
  cached.push({ x: p.x, y: p.y, z: p.z, tx, tz, nx: -tz, nz: tx, heading: Math.atan2(tx, tz) });
}
export const wrapDistance = (distance: number) => ((distance % TRACK_LENGTH) + TRACK_LENGTH) % TRACK_LENGTH;
export const angleDifference = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

export function sampleTrack(distance: number): TrackSample {
  const u = wrapDistance(distance) / TRACK_LENGTH * SAMPLES;
  const index = Math.floor(u);
  const f = u - index;
  const a = cached[index];
  const b = cached[index + 1];
  const heading = a.heading + angleDifference(b.heading, a.heading) * f;
  const tx = Math.sin(heading);
  const tz = Math.cos(heading);
  return {
    x: a.x + (b.x - a.x) * f,
    y: a.y + (b.y - a.y) * f,
    z: a.z + (b.z - a.z) * f,
    tx, tz, nx: -tz, nz: tx, heading,
    curvature: angleDifference(b.heading, a.heading) / (TRACK_LENGTH / SAMPLES),
  };
}

export function trackPosition(distance: number, lateral = 0, height = 0): THREE.Vector3 {
  const p = sampleTrack(distance);
  return new THREE.Vector3(p.x + p.nx * lateral, p.y + height, p.z + p.nz * lateral);
}

export function distanceToTrack(x: number, z: number): number {
  let result = Infinity;
  for (let i = 0; i < SAMPLES; i += 12) {
    const p = cached[i];
    result = Math.min(result, Math.hypot(p.x - x, p.z - z));
  }
  return result;
}

export function minimapPath(width: number, height: number, padding = 12): string {
  const minX = -68, maxX = 273, minZ = -268, maxZ = 321;
  const scale = Math.min((width - padding * 2) / (maxX - minX), (height - padding * 2) / (maxZ - minZ));
  const dx = (width - (maxX - minX) * scale) / 2;
  const dz = (height - (maxZ - minZ) * scale) / 2;
  const parts: string[] = [];
  for (let i = 0; i < 180; i++) {
    const p = sampleTrack(i / 180 * TRACK_LENGTH);
    parts.push(`${i ? 'L' : 'M'}${(dx + (p.x - minX) * scale).toFixed(1)},${(dz + (p.z - minZ) * scale).toFixed(1)}`);
  }
  return parts.join(' ') + 'Z';
}

export function minimapPoint(distance: number, width: number, height: number, padding = 12) {
  const p = sampleTrack(distance);
  const minX = -68, maxX = 273, minZ = -268, maxZ = 321;
  const scale = Math.min((width - padding * 2) / (maxX - minX), (height - padding * 2) / (maxZ - minZ));
  return {
    x: (width - (maxX - minX) * scale) / 2 + (p.x - minX) * scale,
    y: (height - (maxZ - minZ) * scale) / 2 + (p.z - minZ) * scale,
  };
}
