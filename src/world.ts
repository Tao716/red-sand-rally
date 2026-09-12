import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { TRACK_LENGTH, TRACK_WIDTH, distanceToTrack, sampleTrack, trackPosition } from './track';
import { createBoxVolume, type CollisionVolume, type StaticCollider } from './collision';
import type { CarSkin } from './skins';
import { paintCarLivery } from './car-skin';

const UP = new THREE.Vector3(0, 1, 0);
const TAU = Math.PI * 2;

function randomSource(seed: number) {
  return () => {
    seed |= 0;
    seed = seed + 0x6d2b79f5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function material(color: number, roughness = 0.85, metalness = 0) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function canvasTexture(width: number, height: number, paint: (ctx: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context) paint(context);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/** A strip follows the same arc-length samples as the driving simulation. */
function roadBand(left: number, right: number, lift: number, start = 0, end = TRACK_LENGTH, step = 2.4) {
  const count = Math.max(1, Math.ceil((end - start) / step));
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= count; i++) {
    const distance = start + (end - start) * i / count;
    const p = sampleTrack(distance);
    for (const offset of [left, right]) {
      positions.push(p.x + p.nx * offset, p.y + lift, p.z + p.nz * offset);
      uvs.push(offset / TRACK_WIDTH * 3, distance / 24);
    }
    if (i < count) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Broad, irregular sandstone shelves; each layer shares a geological silhouette. */
function mesaGeometry(radius: number, height: number, seed: number, stretch = 1) {
  const rng = randomSource(seed);
  const corners = 11;
  const outline = Array.from({ length: corners }, () => 0.86 + rng() * 0.25);
  const ys = [0, 0.1, 0.15, 0.32, 0.36, 0.57, 0.61, 0.8, 0.84, 1];
  const radii = [1.12, 1.03, 0.97, 0.91, 0.96, 0.78, 0.82, 0.67, 0.71, 0.64];
  const palette = [0xad563b, 0xd38357, 0xc36a47, 0xe29a67, 0xc27550, 0xb76849, 0xdf966a, 0xc17b54, 0xe3a77b];
  const positions: number[] = [];
  const colors: number[] = [];
  const ring = (layer: number, corner: number) => {
    const angle = corner % corners / corners * TAU;
    const radial = outline[corner % corners] * radii[layer] * radius;
    return new THREE.Vector3(
      Math.cos(angle) * radial + Math.sin(layer * 1.8) * radius * 0.045,
      ys[layer] * height,
      Math.sin(angle) * radial * stretch + Math.cos(layer) * radius * 0.035,
    );
  };
  const triangle = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, tint: THREE.Color) => {
    positions.push(...a.toArray(), ...b.toArray(), ...c.toArray());
    for (let k = 0; k < 3; k++) colors.push(tint.r, tint.g, tint.b);
  };
  for (let layer = 0; layer < ys.length - 1; layer++) {
    for (let j = 0; j < corners; j++) {
      const tint = new THREE.Color(palette[layer]).multiplyScalar(0.94 + rng() * 0.11);
      const a = ring(layer, j), b = ring(layer, j + 1);
      const c = ring(layer + 1, j), d = ring(layer + 1, j + 1);
      triangle(a, c, b, tint);
      triangle(b, c, d, tint);
    }
  }
  const cap = new THREE.Color(0xe7aa7b);
  for (let j = 0; j < corners; j++) {
    triangle(new THREE.Vector3(0, height, 0), ring(ys.length - 1, j + 1), ring(ys.length - 1, j), cap);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** Project each individual solid, never an entire scenery batch or its empty AABB. */
function extractCollisionVolume(geometry: THREE.BufferGeometry, matrix?: THREE.Matrix4): CollisionVolume {
  const positions = geometry.getAttribute('position');
  const vertex = new THREE.Vector3();
  const points: { x: number; z: number }[] = [];
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < positions.count; i++) {
    vertex.fromBufferAttribute(positions, i);
    if (matrix) vertex.applyMatrix4(matrix);
    points.push({ x: vertex.x, z: vertex.z });
    minY = Math.min(minY, vertex.y);
    maxY = Math.max(maxY, vertex.y);
  }
  points.sort((a, b) => a.x - b.x || a.z - b.z);
  const unique = points.filter((p, i) => i === 0
    || Math.abs(p.x - points[i - 1].x) > 1e-7 || Math.abs(p.z - points[i - 1].z) > 1e-7);
  const cross = (a: typeof points[number], b: typeof points[number], c: typeof points[number]) =>
    (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
  const halfHull = (vertices: typeof points) => {
    const result: typeof points = [];
    for (const p of vertices) {
      while (result.length > 1 && cross(result[result.length - 2], result[result.length - 1], p) <= 1e-8) result.pop();
      result.push(p);
    }
    result.pop();
    return result;
  };
  return { points: [...halfHull(unique), ...halfHull([...unique].reverse())], minY, maxY };
}

export function createWorld(scene: THREE.Scene): { colliders: StaticCollider[]; update(time: number): void; dispose(): void } {
  const root = new THREE.Group();
  root.name = 'Red Sand / canyon environment';
  scene.add(root);
  const rng = randomSource(7107);
  const batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const colliders: StaticCollider[] = [];
  const recordSolid = (kind: StaticCollider['kind'], id: string, geometry: THREE.BufferGeometry, matrix?: THREE.Matrix4) => {
    colliders.push({ id, kind, ...extractCollisionVolume(geometry, matrix) });
  };
  const rotating: THREE.Object3D[] = [];
  const flags: THREE.Mesh[] = [];
  const temporaryGeometries = new Set<THREE.BufferGeometry>();
  const dummy = new THREE.Object3D();
  const box = new THREE.BoxGeometry(1, 1, 1);
  const cylinder = new THREE.CylinderGeometry(1, 1, 1, 7);
  temporaryGeometries.add(box);
  temporaryGeometries.add(cylinder);
  const add = (geometry: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number,
    sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0) => {
    dummy.position.set(x, y, z);
    dummy.rotation.set(rx, ry, rz);
    dummy.scale.set(sx, sy, sz);
    dummy.updateMatrix();
    const transformed = geometry.clone().applyMatrix4(dummy.matrix);
    const pieces = batches.get(mat) ?? [];
    pieces.push(transformed);
    batches.set(mat, pieces);
    return transformed;
  };
  const solid = (geometry: THREE.BufferGeometry, mat: THREE.Material, castShadow = false) => {
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.receiveShadow = true;
    mesh.castShadow = castShadow;
    root.add(mesh);
    return mesh;
  };
  const beam = (a: THREE.Vector3, b: THREE.Vector3, thickness: number, mat: THREE.Material) => {
    const direction = b.clone().sub(a);
    dummy.position.copy(a).add(b).multiplyScalar(0.5);
    dummy.quaternion.setFromUnitVectors(UP, direction.clone().normalize());
    dummy.scale.set(thickness, direction.length(), thickness);
    dummy.updateMatrix();
    const geometry = box.clone().applyMatrix4(dummy.matrix);
    const pieces = batches.get(mat) ?? [];
    pieces.push(geometry);
    batches.set(mat, pieces);
  };

  const cream = material(0xffe6b6);
  const coral = material(0xc95136);
  const edgeMat = material(0xc68761);
  const steel = material(0x8c8072, 0.58, 0.38);
  const darkSteel = material(0x383f42, 0.62, 0.5);
  const lightSteel = material(0xe0c9a4, 0.7, 0.23);
  const teal = material(0x368d87, 0.68, 0.18);
  const green = material(0x6b8861);
  const grass = material(0xc6a070);
  const rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true });

  // Tiny procedural aggregate gives the road a little texture without external assets.
  const asphaltTexture = canvasTexture(256, 256, ctx => {
    ctx.fillStyle = '#62696b';
    ctx.fillRect(0, 0, 256, 256);
    const noise = randomSource(106);
    for (let i = 0; i < 10500; i++) {
      const value = 64 + Math.floor(noise() * 66);
      ctx.fillStyle = `rgba(${value},${value + 3},${value + 4},0.2)`;
      ctx.fillRect(noise() * 256, noise() * 256, noise() * 2 + 0.5, 1);
    }
  });
  asphaltTexture.wrapS = asphaltTexture.wrapT = THREE.RepeatWrapping;
  const asphalt = new THREE.MeshStandardMaterial({ color: 0xb9b5ac, map: asphaltTexture, roughness: 0.96 });

  const terrain = new THREE.PlaneGeometry(2250, 2250, 76, 76);
  terrain.rotateX(-Math.PI / 2);
  terrain.translate(100, -0.38, 10);
  const position = terrain.getAttribute('position');
  const groundColors: number[] = [];
  const sandA = new THREE.Color(0xd59164);
  const sandB = new THREE.Color(0xe8b183);
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), z = position.getZ(i);
    const proximity = Math.min(1, Math.max(0, (distanceToTrack(x, z) - 25) / 100));
    const wave = Math.sin(x * 0.013 + Math.sin(z * 0.025)) * Math.cos(z * 0.009) * 0.5 + 0.5;
    position.setY(i, -0.4 + wave * proximity * 4);
    const color = sandA.clone().lerp(sandB, wave * 0.7 + rng() * 0.16);
    groundColors.push(color.r, color.g, color.b);
  }
  terrain.setAttribute('color', new THREE.Float32BufferAttribute(groundColors, 3));
  terrain.computeVertexNormals();
  solid(terrain, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));

  solid(roadBand(-TRACK_WIDTH / 2, TRACK_WIDTH / 2, 0), asphalt);
  solid(roadBand(-TRACK_WIDTH / 2 - 1.1, TRACK_WIDTH / 2 + 1.1, -0.11), edgeMat);

  // A connected embankment closes the underside all the way to the desert floor.
  const bankPositions: number[] = [];
  const bankIndices: number[] = [];
  const bankSegments = 640;
  for (const side of [-1, 1]) {
    const initial = bankPositions.length / 3;
    for (let i = 0; i <= bankSegments; i++) {
      const p = sampleTrack(i / bankSegments * TRACK_LENGTH);
      const top = side * (TRACK_WIDTH / 2 + 1.06);
      const bottom = side * (TRACK_WIDTH / 2 + 2.5 + p.y * 0.28);
      bankPositions.push(p.x + p.nx * top, p.y - 0.12, p.z + p.nz * top);
      bankPositions.push(p.x + p.nx * bottom, -0.55, p.z + p.nz * bottom);
      if (i < bankSegments) {
        const a = initial + i * 2;
        if (side === -1) bankIndices.push(a, a + 2, a + 1, a + 2, a + 3, a + 1);
        else bankIndices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
      }
    }
  }
  const embankment = new THREE.BufferGeometry();
  embankment.setAttribute('position', new THREE.Float32BufferAttribute(bankPositions, 3));
  embankment.setIndex(bankIndices);
  embankment.computeVertexNormals();
  solid(embankment, material(0xad755c));

  for (let d = 0; d < TRACK_LENGTH; d += 4.4) {
    const curbMat = Math.floor(d / 4.4) % 2 ? cream : coral;
    for (const side of [-1, 1]) {
      const left = side === 1 ? TRACK_WIDTH / 2 - 0.15 : -TRACK_WIDTH / 2 - 0.75;
      const band = roadBand(left, left + 0.9, 0.036, d, Math.min(d + 4.4, TRACK_LENGTH));
      const pieces = batches.get(curbMat) ?? [];
      pieces.push(band);
      batches.set(curbMat, pieces);
    }
  }
  // Narrow continuous boundary lines are readable at speed; the middle line is dashed.
  for (const side of [-1, 1]) solid(roadBand(side * 8.65 - 0.06, side * 8.65 + 0.06, 0.025), cream);
  for (let d = 10; d < TRACK_LENGTH; d += 17) {
    const band = roadBand(-0.085, 0.085, 0.028, d, Math.min(d + 6, TRACK_LENGTH));
    const pieces = batches.get(cream) ?? [];
    pieces.push(band);
    batches.set(cream, pieces);
  }

  // Safety rails are placed around the elevated outer turns, leaving open canyon views.
  for (let d = 0; d < TRACK_LENGTH; d += 7) {
    const p = sampleTrack(d);
    const railSection = p.y > 3.7 || Math.abs(p.curvature) > 0.012;
    if (!railSection) continue;
    for (const side of [-1, 1]) {
      const lateral = side * (TRACK_WIDTH / 2 + 1.25);
      const here = trackPosition(d, lateral, 0.74);
      const next = trackPosition(d + 7.1, lateral, 0.74);
      beam(here, next, 0.2, lightSteel);
      const railLength = Math.hypot(next.x - here.x, next.z - here.z);
      const rail = createBoxVolume((here.x + next.x) / 2, (here.y + next.y) / 2 + 0.06,
        (here.z + next.z) / 2, 0.1, 0.5, railLength / 2, Math.atan2(next.x - here.x, next.z - here.z));
      // Cover both visible rail bars, following only the rendered segments.
      rail.minY = Math.min(here.y, next.y) - 0.44;
      rail.maxY = Math.max(here.y, next.y) + 0.56;
      colliders.push({ id: `rail-${d}-${side}`, kind: 'barrier', ...rail });
      const upperA = here.clone(); upperA.y += 0.39;
      const upperB = next.clone(); upperB.y += 0.39;
      beam(upperA, upperB, 0.12, steel);
      const foot = trackPosition(d, lateral, 0.53);
      recordSolid('barrier', `rail-post-${d}-${side}`,
        add(box, steel, foot.x, foot.y, foot.z, 0.15, 1.12, 0.17, 0, p.heading));
      if (Math.floor(d / 7) % 3 === 0) {
        const reflector = trackPosition(d, lateral, 1.15);
        add(box, coral, reflector.x, reflector.y, reflector.z, 0.27, 0.2, 0.14, 0, p.heading);
      }
    }
  }

  // Finishing stripe follows the exact road height, so it never flickers or floats.
  const startP = sampleTrack(0);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 18; col++) {
      const lateral = -9 + (col + 0.5);
      const p = trackPosition(row * 0.85 + 0.3, lateral, 0.032);
      add(box, (row + col) % 2 === 0 ? cream : darkSteel, p.x, p.y, p.z,
        0.99, 0.016, 0.84, 0, startP.heading);
    }
  }

  const gate = new THREE.Group();
  gate.position.copy(trackPosition(1.2));
  gate.rotation.y = sampleTrack(1.2).heading;
  root.add(gate);
  const gatePart = (w: number, h: number, depth: number, mat: THREE.Material, x: number, y: number, z = 0) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, depth), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    gate.add(mesh);
    return mesh;
  };
  for (const x of [-11.7, 11.7]) {
    const pillar = gatePart(1.5, 10.8, 1.7, coral, x, 5.4);
    const base = gatePart(2.35, 1.3, 2.6, darkSteel, x, 0.65);
    for (const [name, mesh] of [['pillar', pillar], ['base', base]] as const) {
      mesh.updateWorldMatrix(true, false);
      recordSolid('structure', `start-gate-${name}-${x}`, mesh.geometry, mesh.matrixWorld);
    }
    gatePart(0.15, 8.8, 0.18, cream, x + Math.sign(x) * 0.63, 5.3, -0.88);
    gatePart(1.7, 0.6, 1.9, cream, x, 8.3);
  }
  gatePart(25, 3, 1.65, coral, 0, 10.65);
  gatePart(25.6, 0.22, 1.9, cream, 0, 12.2);
  gatePart(21.4, 0.23, 0.15, darkSteel, 0, 8.72, -0.96);
  const gateTexture = canvasTexture(2048, 256, ctx => {
    ctx.fillStyle = '#c95033'; ctx.fillRect(0, 0, 2048, 256);
    ctx.strokeStyle = '#f4ddb0'; ctx.lineWidth = 3; ctx.strokeRect(22, 19, 2004, 218);
    ctx.fillStyle = '#ffe9be';
    ctx.font = '900 132px "Arial Black", Arial, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('RED SAND', 1024, 115);
    ctx.font = '700 26px Arial, sans-serif';
    ctx.fillText('C A N Y O N  R U N  /  S T A R T', 1024, 210);
    ctx.font = '900 92px Arial, sans-serif';
    ctx.fillText('01', 195, 127); ctx.fillText('01', 1850, 127);
    for (const side of [68, 1830]) for (let j = 0; j < 3; j++) {
      ctx.fillRect(side + j * 18, 202, 10, 9);
    }
  });
  const gateSignMat = new THREE.MeshStandardMaterial({ map: gateTexture, roughness: 0.85 });
  for (const side of [-1, 1]) {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(24.6, 2.76), gateSignMat);
    plane.position.set(0, 10.67, side * 0.84);
    if (side === -1) plane.rotation.y = Math.PI;
    gate.add(plane);
  }
  const signalMat = new THREE.MeshStandardMaterial({ color: 0xa7ecba, emissive: 0x62b17a, emissiveIntensity: 0.8 });
  for (let i = 0; i < 5; i++) gatePart(0.42, 0.36, 0.22, signalMat, (i - 2) * 0.95, 8.58, -1.04);

  const flagTexture = canvasTexture(128, 512, ctx => {
    ctx.fillStyle = '#e95f39'; ctx.fillRect(0, 0, 128, 512);
    ctx.fillStyle = '#ffebc8'; ctx.fillRect(0, 0, 128, 11); ctx.fillRect(0, 500, 128, 12);
    ctx.save(); ctx.translate(63, 249); ctx.rotate(-Math.PI / 2);
    ctx.font = '900 49px Arial, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('RED SAND', 0, 17); ctx.restore();
    ctx.font = '700 24px Arial, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('R / S', 64, 462);
  });
  const flagMat = new THREE.MeshStandardMaterial({ map: flagTexture, side: THREE.DoubleSide, roughness: 0.9 });
  for (let d = 35; d < TRACK_LENGTH; d += 108) {
    for (const side of [-1, 1]) {
      const p = sampleTrack(d);
      const loc = trackPosition(d, side * 13, 0);
      recordSolid('structure', `flag-post-${d}-${side}`,
        add(cylinder, lightSteel, loc.x, loc.y + 3.7, loc.z, 0.075, 7.4, 0.075));
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.45, 5.2, 4, 12), flagMat);
      flag.position.set(loc.x, loc.y + 4.45, loc.z);
      flag.rotation.y = p.heading + 0.13;
      flag.userData.baseRotation = flag.rotation.y;
      flag.userData.phase = rng() * TAU;
      root.add(flag);
      flags.push(flag);
    }
  }

  // Small directional chevrons mark corner entries.
  const chevronTexture = canvasTexture(512, 128, ctx => {
    ctx.fillStyle = '#384645'; ctx.fillRect(0, 0, 512, 128);
    ctx.strokeStyle = '#f3d7a6'; ctx.lineWidth = 4; ctx.strokeRect(3, 3, 506, 122);
    ctx.fillStyle = '#f6dcaf';
    for (let i = 0; i < 4; i++) {
      const x = 28 + i * 124;
      ctx.beginPath(); ctx.moveTo(x, 20); ctx.lineTo(x + 40, 20); ctx.lineTo(x + 79, 64);
      ctx.lineTo(x + 40, 108); ctx.lineTo(x, 108); ctx.lineTo(x + 39, 64); ctx.closePath(); ctx.fill();
    }
  });
  const chevronMat = new THREE.MeshStandardMaterial({ map: chevronTexture, side: THREE.DoubleSide, roughness: 0.85 });
  for (const frac of [0.19, 0.3, 0.48, 0.65, 0.79, 0.9]) {
    const d = frac * TRACK_LENGTH, p = sampleTrack(d);
    const side = p.curvature > 0 ? -1 : 1;
    const location = trackPosition(d, side * 13, 1.8);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(6, 1.5), chevronMat);
    sign.position.copy(location);
    sign.rotation.y = p.heading + Math.PI;
    root.add(sign);
    for (const dx of [-2.4, 2.4]) {
      recordSolid('structure', `chevron-post-${frac}-${dx}`,
        add(box, steel, location.x + Math.cos(p.heading) * dx, location.y - 0.95,
          location.z - Math.sin(p.heading) * dx, 0.11, 2.2, 0.11));
    }
  }

  const addMesa = (x: number, z: number, radius: number, height: number, seed: number, stretch = 1) => {
    if (distanceToTrack(x, z) < radius * 1.25 * Math.max(1, stretch) + 18) return;
    const rock = mesaGeometry(radius, height, seed, stretch);
    recordSolid('rock', `mesa-${seed}`, add(rock, rockMat, x, -0.5, z, 1, 1, 1, 0, seed * 0.53));
    rock.dispose();
  };
  // Composed landmarks, not a field of cones: low broad mesas and a few tall spires.
  addMesa(82, -97, 40, 72, 91, 1.04);
  addMesa(74, 90, 36, 48, 10, 1.2);
  addMesa(103, 192, 23, 32, 122, 1.1);
  addMesa(-102, 53, 34, 60, 11, 1.08);
  addMesa(-121, -133, 42, 93, 31, 1.0);
  addMesa(294, -125, 27, 67, 93, 1.0);
  addMesa(267, -293, 49, 95, 28, 1.2);
  addMesa(368, 82, 52, 109, 80, 1.15);
  addMesa(-113, 269, 48, 81, 52, 1.1);
  addMesa(161, 399, 52, 68, 200, 1.2);
  // Rock towers create a memorable skyline without encroaching on racing space.
  addMesa(-91, -57, 11, 45, 8);
  addMesa(283, 91, 12, 41, 29);
  addMesa(45, -302, 16, 78, 164);
  addMesa(315, 267, 17, 62, 108);
  for (let i = 0; i < 19; i++) {
    const angle = i / 19 * TAU;
    const radius = 590 + rng() * 130;
    addMesa(80 + Math.cos(angle) * radius, 30 + Math.sin(angle) * radius,
      63 + rng() * 53, 90 + rng() * 96, 230 + i, 0.9 + rng() * 0.5);
  }

  // Smaller rounded sandstone fragments, batched into a single mesh.
  const boulder = new THREE.DodecahedronGeometry(1, 0);
  const boulderMat = material(0xcc8259);
  temporaryGeometries.add(boulder);
  for (let i = 0; i < 400; i++) {
    const x = -195 + rng() * 650, z = -365 + rng() * 815;
    const size = 0.4 + rng() * 2.2;
    if (distanceToTrack(x, z) < 18 + size) continue;
    const rock = add(boulder, boulderMat, x, size * 0.34 - 0.2, z, size, size * 0.7, size * 0.8,
      rng(), rng() * TAU, rng() * 0.5);
    const volume = extractCollisionVolume(rock);
    // Pebbles remain traversable; visibly substantial fragments are solid.
    if (volume.maxY >= 0.65) colliders.push({ id: `boulder-${i}`, kind: 'rock', ...volume });
  }

  // Saguaro silhouettes are intentionally sparse along the open straights.
  for (let i = 0; i < 165; i++) {
    const x = -120 + rng() * 485, z = -320 + rng() * 715;
    const distance = distanceToTrack(x, z);
    if (distance < 20 || distance > 78) continue;
    const height = 2.4 + rng() * 3.8;
    const trunk = 0.23 + height * 0.02;
    recordSolid('structure', `cactus-${i}`,
      add(cylinder, green, x, height * 0.5 - 0.2, z, trunk, height, trunk));
    add(boulder, green, x, height - 0.2, z, trunk, trunk * 1.2, trunk);
    const angle = rng() * TAU;
    for (const side of [-1, 1]) {
      const armY = height * (side === 1 ? 0.53 : 0.37);
      const length = 0.65 + height * 0.07;
      const ax = x + Math.cos(angle) * length * side;
      const az = z + Math.sin(angle) * length * side;
      beam(new THREE.Vector3(x, armY, z), new THREE.Vector3(ax, armY, az), trunk * 1.45, green);
      add(cylinder, green, ax, armY + height * 0.14, az, trunk * 0.76, height * 0.32, trunk * 0.76);
      add(boulder, green, ax, armY + height * 0.3, az, trunk * 0.77, trunk, trunk * 0.77);
    }
  }
  const grassBlade = new THREE.PlaneGeometry(0.15, 1);
  temporaryGeometries.add(grassBlade);
  grass.side = THREE.DoubleSide;
  for (let i = 0; i < 520; i++) {
    const x = -110 + rng() * 470, z = -320 + rng() * 680;
    const distance = distanceToTrack(x, z);
    if (distance < 15 || distance > 48) continue;
    const height = 0.35 + rng() * 0.8;
    for (let j = 0; j < 4; j++) {
      add(grassBlade, grass, x, height * 0.4, z, 1, height, 1,
        (rng() - 0.5) * 0.9, j * 1.27, (rng() - 0.5) * 0.65);
    }
  }

  // Abandoned solar farm: cerulean glass and repeating grid lines against orange sand.
  const solarTexture = canvasTexture(256, 256, ctx => {
    ctx.fillStyle = '#254f5c'; ctx.fillRect(0, 0, 256, 256);
    const gradient = ctx.createLinearGradient(0, 0, 256, 256);
    gradient.addColorStop(0, '#537a82'); gradient.addColorStop(1, '#254651');
    ctx.fillStyle = gradient; ctx.fillRect(3, 3, 250, 250);
    ctx.strokeStyle = '#7c9994'; ctx.lineWidth = 2;
    for (let i = 0; i <= 6; i++) {
      ctx.beginPath(); ctx.moveTo(i * 256 / 6, 0); ctx.lineTo(i * 256 / 6, 256); ctx.stroke();
    }
    for (let i = 0; i <= 4; i++) {
      ctx.beginPath(); ctx.moveTo(0, i * 64); ctx.lineTo(256, i * 64); ctx.stroke();
    }
  });
  const solarMat = new THREE.MeshStandardMaterial({ map: solarTexture, roughness: 0.37, metalness: 0.36 });
  const solarGeometry = new THREE.PlaneGeometry(7.8, 4.8);
  temporaryGeometries.add(solarGeometry);
  for (let row = 0; row < 3; row++) for (let col = 0; col < 5; col++) {
    const x = 278 + col * 11, z = -5 + row * 12;
    if (distanceToTrack(x, z) < 23) continue;
    add(box, steel, x, 1.7, z, 0.25, 3.6, 0.25);
    add(box, lightSteel, x, 3.4, z, 8.1, 0.19, 5.1, -0.35);
    add(solarGeometry, solarMat, x, 3.51, z, 1, 1, 1, -Math.PI / 2 - 0.35);
  }
  for (const location of [[-73, 114], [261, -44], [341, 92]]) {
    const [x, z] = location;
    const height = 22;
    const base = 3.5;
    for (const dx of [-1, 1]) for (const dz of [-1, 1]) {
      beam(new THREE.Vector3(x + dx * base, 0, z + dz * base),
        new THREE.Vector3(x + dx * 0.85, height, z + dz * 0.85), 0.27, steel);
    }
    for (let y = 3; y < height; y += 4) {
      const width = base * (1 - y / height) + 0.85 * y / height;
      for (const dz of [-1, 1]) {
        beam(new THREE.Vector3(x - width, y, z + dz * width),
          new THREE.Vector3(x + width, y + 3.6, z + dz * Math.max(0.85, width - 0.5)), 0.12, steel);
        beam(new THREE.Vector3(x + width, y, z + dz * width),
          new THREE.Vector3(x - width, y + 3.6, z + dz * Math.max(0.85, width - 0.5)), 0.12, steel);
      }
    }
    add(box, lightSteel, x, height - 1, z, 11, 0.45, 0.65);
    for (const offset of [-4.5, 4.5]) {
      add(cylinder, teal, x + offset, height - 1.9, z, 0.24, 1.6, 0.24);
    }
  }

  // A far-off communication dish gives the industrial canyon a focal point.
  const towerX = 122, towerZ = -345;
  add(cylinder, lightSteel, towerX, 11, towerZ, 1.35, 22, 1.35);
  add(cylinder, coral, towerX, 16.6, towerZ, 1.38, 2, 1.38);
  const dish = new THREE.Mesh(new THREE.SphereGeometry(9, 14, 8, 0, TAU, Math.PI * 0.64, Math.PI * 0.35), cream);
  dish.material = cream.clone();
  (dish.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
  dish.position.set(towerX, 26, towerZ);
  dish.rotation.z = -0.48;
  root.add(dish);
  rotating.push(dish);

  // Merge repeated static elements by material: the scenery stays inexpensive to draw.
  for (const [mat, geometries] of batches) {
    // Some procedural surfaces are indexed while primitives differ; standardize before merging.
    const prepared = geometries.map(geometry => {
      const g = geometry.index ? geometry.toNonIndexed() : geometry;
      if (!g.getAttribute('uv')) {
        g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
      }
      return g;
    });
    const merged = mergeGeometries(prepared, false);
    if (merged) solid(merged, mat, mat !== grass && mat !== cream && mat !== coral);
    for (const geometry of new Set([...geometries, ...prepared])) geometry.dispose();
  }
  temporaryGeometries.forEach(geometry => geometry.dispose());

  return {
    colliders,
    update(time: number) {
      for (const flag of flags) {
        flag.rotation.y = flag.userData.baseRotation + Math.sin(time * 1.9 + flag.userData.phase) * 0.1;
        const positions = flag.geometry.getAttribute('position');
        for (let i = 0; i < positions.count; i++) {
          const x = positions.getX(i), y = positions.getY(i);
          positions.setZ(i, Math.sin(y * 1.9 + time * 3.7 + flag.userData.phase) * 0.09 * (x + 0.73));
        }
        positions.needsUpdate = true;
      }
      for (const object of rotating) object.rotation.y = Math.sin(time * 0.035) * 0.23;
    },
    dispose() {
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      const textures = new Set<THREE.Texture>();
      root.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        geometries.add(object.geometry);
        for (const mat of Array.isArray(object.material) ? object.material : [object.material]) {
          materials.add(mat);
          for (const value of Object.values(mat)) if (value instanceof THREE.Texture) textures.add(value);
        }
      });
      geometries.forEach(geometry => geometry.dispose());
      materials.forEach(mat => mat.dispose());
      textures.forEach(texture => texture.dispose());
      scene.remove(root);
    },
  };
}

/** Local +Z is forward. Wheel groups rotate around X; all contact patches sit at Y=0. */
export function createCar(color: number, isPlayer = false, skin?: CarSkin): THREE.Group {
  // Livery is cosmetic and belongs only to the player, never a rival or race state.
  const paint = isPlayer ? skin : undefined;
  const bodyColor = paint?.body ?? color;
  const car = new THREE.Group();
  car.rotation.order = 'YXZ';
  car.name = isPlayer ? '07 / DUNE RUNNER' : 'Canyon rival';
  car.userData.isPlayer = isPlayer;
  car.userData.baseColor = color;
  if (paint) car.userData.skinId = paint.id;
  const body = material(bodyColor, paint?.roughness ?? 0.39, paint?.metalness ?? 0.24);
  body.name = 'car/body';
  const darkBody = material(new THREE.Color(bodyColor).multiplyScalar(0.55).getHex(), 0.5, 0.22);
  const ivory = material(paint?.accent ?? 0xffebc1, 0.48, 0.17);
  ivory.name = 'car/accent';
  const chassis = material(0x303638, 0.65, 0.42);
  const metal = material(0x9aa29e, 0.35, 0.65);
  const darkMetal = material(paint?.id === 'sandstorm' ? 0x484c49 : paint?.trim ?? 0x484c49, 0.47, 0.66);
  const rubber = material(0x242727, 0.95);
  const glass = new THREE.MeshStandardMaterial({ color: 0x16393f, roughness: 0.2, metalness: 0.57 });
  const headlight = new THREE.MeshStandardMaterial({ color: 0xfff2c5, emissive: 0xffdb94, emissiveIntensity: 1.5, roughness: 0.2 });
  const taillight = new THREE.MeshStandardMaterial({ color: 0xfc6146, emissive: 0xf23a22, emissiveIntensity: 1.1 });
  const glowColor = paint?.glow;
  const glowCore = glowColor === undefined ? 0xa4ffff : new THREE.Color(glowColor).lerp(new THREE.Color(0xffffff), 0.52);
  const cyan = new THREE.MeshStandardMaterial({ color: glowCore, emissive: glowColor ?? 0x21c9ff, emissiveIntensity: 1.5 });
  const mesh = (geometry: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = car) => {
    const part = new THREE.Mesh(geometry, mat);
    part.position.set(x, y, z);
    part.castShadow = true;
    part.receiveShadow = true;
    parent.add(part);
    return part;
  };
  const block = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, bevel = 0) =>
    mesh(bevel > 0 ? new RoundedBoxGeometry(w, h, d, 2, bevel) : new THREE.BoxGeometry(w, h, d), mat, x, y, z);

  block(2.03, 0.32, 4.35, chassis, 0, 0.66, 0, 0.09);
  block(2.06, 0.48, 4.05, body, 0, 0.96, 0.1, 0.13);
  block(1.92, 0.2, 1.65, body, 0, 1.19, 1.13, 0.05).rotation.x = 0.1;
  if (!paint || paint.pattern === 'twin') {
    block(0.27, 0.016, 1.72, ivory, -0.22, 1.3, 1.12).rotation.x = 0.1;
    block(0.1, 0.017, 1.72, ivory, 0.06, 1.3, 1.12).rotation.x = 0.1;
  }
  block(1.69, 0.65, 1.48, glass, 0, 1.43, -0.18, 0.12);
  block(1.88, 0.17, 1.16, body, 0, 1.83, -0.33, 0.065);
  if (!paint || paint.pattern === 'twin') {
    block(0.27, 0.016, 1.08, ivory, -0.22, 1.923, -0.31);
    block(0.1, 0.016, 1.08, ivory, 0.06, 1.923, -0.31);
  }
  let liveryMat: THREE.MeshStandardMaterial | undefined;
  if (paint && paint.pattern !== 'twin') {
    const liveryTexture = canvasTexture(512, 512, ctx => paintCarLivery(ctx, paint));
    liveryTexture.name = `skin/${paint.id}/pattern`;
    liveryMat = new THREE.MeshStandardMaterial({
      map: liveryTexture, roughness: paint.roughness, metalness: paint.metalness,
      transparent: true, alphaTest: 0.1, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    liveryMat.name = `skin/${paint.id}/livery`;
    // Flat films stay inside the existing bevels; they do not change the vehicle silhouette.
    const hoodLivery = mesh(new THREE.PlaneGeometry(1.62, 1.42), liveryMat, 0, 1.30, 1.12);
    hoodLivery.rotation.x = -Math.PI / 2 + 0.1;
    const roofLivery = mesh(new THREE.PlaneGeometry(1.60, 0.92), liveryMat, 0, 1.923, -0.31);
    roofLivery.rotation.x = -Math.PI / 2;
    for (const livery of [hoodLivery, roofLivery]) {
      livery.castShadow = false;
      livery.renderOrder = 1;
    }
  }
  // Windshield frame and A pillars keep the vehicle readable from the chase camera.
  for (const side of [-1, 1]) {
    block(0.12, 0.72, 0.12, body, side * 0.77, 1.5, 0.45).rotation.x = -0.23;
    block(0.12, 0.68, 0.12, body, side * 0.77, 1.5, -0.87).rotation.x = 0.15;
    block(0.1, 0.58, 0.11, chassis, side * 0.867, 1.46, -0.29);
    block(0.35, 0.17, 0.32, body, side * 1.03, 1.37, 0.34, 0.04);
    block(0.14, 0.22, 2.35, darkMetal, side * 1.11, 0.68, -0.14, 0.025);
    // Armored wheel arches have substantial visible shoulders.
    for (const z of [-1.53, 1.5]) block(0.43, 0.2, 1.2, body, side * 1.06, 1.13, z, 0.06);
  }
  block(1.58, 0.2, 0.74, darkMetal, 0, 1.23, -1.32, 0.04);
  for (let i = 0; i < 6; i++) block(1.36, 0.085, 0.038, metal, 0, 1.38, -1.62 + i * 0.11);
  // Heavy-duty rear wing and vertical stabilizers.
  for (const side of [-1, 1]) {
    block(0.12, 0.65, 0.19, darkMetal, side * 0.76, 1.52, -1.86).rotation.x = 0.16;
    block(0.13, 0.4, 0.75, darkBody, side * 1.22, 1.91, -1.95, 0.015);
  }
  block(2.49, 0.12, 0.75, body, 0, 1.92, -1.95, 0.035).rotation.x = -0.06;
  block(0.31, 0.012, 0.67, ivory, -0.2, 1.99, -1.95).rotation.x = -0.06;

  const wheels: THREE.Object3D[] = [];
  const tireGeometry = new THREE.CylinderGeometry(0.61, 0.61, 0.42, 16, 1);
  tireGeometry.rotateZ(Math.PI / 2);
  const hubGeometry = new THREE.CylinderGeometry(0.3, 0.3, 0.447, 10);
  hubGeometry.rotateZ(Math.PI / 2);
  const rimGeometry = new THREE.TorusGeometry(0.405, 0.023, 4, 16);
  rimGeometry.rotateY(Math.PI / 2);
  const tireTreadGeometry = new THREE.BoxGeometry(0.435, 0.035, 0.18);
  const boltGeometry = new THREE.CylinderGeometry(0.033, 0.033, 0.035, 5);
  boltGeometry.rotateZ(Math.PI / 2);
  for (const x of [-1.15, 1.15]) for (const z of [-1.49, 1.51]) {
    const wheel = new THREE.Group();
    wheel.position.set(x, 0.61, z);
    car.add(wheel);
    mesh(tireGeometry, rubber, 0, 0, 0, wheel);
    mesh(hubGeometry, darkMetal, 0, 0, 0, wheel);
    mesh(rimGeometry, ivory, Math.sign(x) * 0.217, 0, 0, wheel);
    const axle = mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.46, 8), body, 0, 0, 0, wheel);
    axle.rotation.z = Math.PI / 2;
    // Merge tread blocks and hub bolts per wheel instead of drawing every groove.
    const treadPieces: THREE.BufferGeometry[] = [];
    const boltPieces: THREE.BufferGeometry[] = [];
    const transform = new THREE.Matrix4();
    for (let i = 0; i < 16; i++) {
      const angle = i / 16 * TAU;
      transform.makeRotationX(angle);
      transform.setPosition(0, Math.cos(angle) * 0.611, Math.sin(angle) * 0.611);
      treadPieces.push(tireTreadGeometry.clone().applyMatrix4(transform));
    }
    for (let i = 0; i < 5; i++) {
      const angle = i / 5 * TAU;
      transform.makeTranslation(Math.sign(x) * 0.242, Math.cos(angle) * 0.212, Math.sin(angle) * 0.212);
      boltPieces.push(boltGeometry.clone().applyMatrix4(transform));
    }
    const tread = mergeGeometries(treadPieces);
    const bolts = mergeGeometries(boltPieces);
    if (tread) mesh(tread, rubber, 0, 0, 0, wheel);
    if (bolts) mesh(bolts, metal, 0, 0, 0, wheel);
    treadPieces.forEach(g => g.dispose());
    boltPieces.forEach(g => g.dispose());
    wheels.push(wheel);
  }
  tireTreadGeometry.dispose(); boltGeometry.dispose();

  // Keep rubber and metal separate, but bake all five wheel-detail colors into one mesh.
  // This makes a fully detailed wheel two draw calls instead of six.
  const wheelMetal = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.47, metalness: 0.55 });
  const oldWheelGeometries = new Set<THREE.BufferGeometry>();
  for (const wheel of wheels) {
    const rubberParts: THREE.BufferGeometry[] = [];
    const metalParts: THREE.BufferGeometry[] = [];
    for (const child of [...wheel.children]) {
      if (!(child instanceof THREE.Mesh)) continue;
      child.updateMatrix();
      oldWheelGeometries.add(child.geometry);
      let g = child.geometry.clone().applyMatrix4(child.matrix);
      if (g.index) {
        const indexed = g;
        g = indexed.toNonIndexed();
        indexed.dispose();
      }
      if (child.material === rubber) rubberParts.push(g);
      else {
        const tint = (child.material as THREE.MeshStandardMaterial).color;
        const values = new Float32Array(g.getAttribute('position').count * 3);
        for (let i = 0; i < values.length; i += 3) {
          values[i] = tint.r; values[i + 1] = tint.g; values[i + 2] = tint.b;
        }
        g.setAttribute('color', new THREE.BufferAttribute(values, 3));
        metalParts.push(g);
      }
      wheel.remove(child);
    }
    const rubberGeometry = mergeGeometries(rubberParts, false);
    const metalGeometry = mergeGeometries(metalParts, false);
    if (rubberGeometry) mesh(rubberGeometry, rubber, 0, 0, 0, wheel);
    if (metalGeometry) mesh(metalGeometry, wheelMetal, 0, 0, 0, wheel);
    [...rubberParts, ...metalParts].forEach(g => g.dispose());
  }
  oldWheelGeometries.forEach(g => g.dispose());

  block(2.18, 0.22, 0.25, darkMetal, 0, 0.72, 2.28, 0.035);
  block(2.1, 0.22, 0.22, darkMetal, 0, 0.72, -2.24, 0.035);
  block(0.89, 0.19, 0.08, chassis, 0, 0.99, 2.147);
  for (let i = 0; i < 5; i++) block(0.06, 0.17, 0.024, metal, (i - 2) * 0.16, 0.99, 2.2);
  for (const side of [-1, 1]) {
    block(0.54, 0.2, 0.12, headlight, side * 0.7, 1.07, 2.14, 0.025);
    block(0.48, 0.13, 0.09, taillight, side * 0.73, 1.01, -2.11, 0.02);
    block(0.39, 0.055, 0.035, ivory, side * 0.73, 0.94, -2.17);
  }
  const flames: THREE.Object3D[] = [];
  const flameMat = new THREE.MeshBasicMaterial({ color: glowColor ?? 0x54e5ff, transparent: true, opacity: 0.8, depthWrite: false });
  const flameCoreMat = new THREE.MeshBasicMaterial({
    color: glowColor === undefined ? 0xdbffff : new THREE.Color(glowColor).lerp(new THREE.Color(0xffffff), 0.82),
    transparent: true, opacity: 0.9, depthWrite: false,
  });
  for (const side of [-1, 1]) {
    const nozzle = mesh(new THREE.CylinderGeometry(0.21, 0.24, 0.38, 10, 1, true), metal, side * 0.59, 0.62, -2.25);
    nozzle.rotation.x = Math.PI / 2;
    const core = mesh(new THREE.CircleGeometry(0.15, 10), cyan, side * 0.59, 0.62, -2.455);
    core.rotation.y = Math.PI;
    const flame = new THREE.Group();
    flame.position.set(side * 0.59, 0.62, -2.39);
    const outer = new THREE.Mesh(new THREE.ConeGeometry(0.22, 1.45, 7, 1, true), flameMat);
    outer.rotation.x = -Math.PI / 2;
    outer.position.z = -0.68;
    const inner = new THREE.Mesh(new THREE.ConeGeometry(0.12, 1, 7, 1, true), flameCoreMat);
    inner.rotation.x = -Math.PI / 2;
    inner.position.z = -0.45;
    flame.add(outer, inner);
    flame.visible = false;
    car.add(flame);
    flames.push(flame);
  }

  const decalTexture = canvasTexture(256, 256, ctx => {
    ctx.fillStyle = '#ffedc6';
    ctx.beginPath(); ctx.roundRect(7, 7, 242, 242, 34); ctx.fill();
    ctx.strokeStyle = '#343e3f'; ctx.lineWidth = 8; ctx.strokeRect(21, 21, 214, 214);
    ctx.fillStyle = '#334042'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '900 137px "Arial Black", Arial, sans-serif';
    ctx.fillText(isPlayer ? '07' : String((color % 83) + 10), 128, 119);
    ctx.font = '800 22px Arial, sans-serif'; ctx.fillText('DUNE RUNNER', 128, 214);
  });
  decalTexture.name = 'car/race-number';
  const decalMat = new THREE.MeshStandardMaterial({ map: decalTexture, roughness: 0.66, transparent: true });
  decalMat.name = 'car/race-number';
  for (const side of [-1, 1]) {
    const number = new THREE.Mesh(new THREE.PlaneGeometry(0.68, 0.62), decalMat);
    number.position.set(side * 1.044, 0.995, -0.14);
    number.rotation.y = side * Math.PI / 2;
    car.add(number);
  }
  const shield = new THREE.Mesh(
    new THREE.SphereGeometry(1, 24, 16),
    new THREE.MeshBasicMaterial({ color: 0x72eddf, transparent: true, opacity: 0.16,
      wireframe: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  shield.position.y = 1;
  shield.scale.set(1.72, 1.48, 2.85);
  shield.visible = false;
  car.add(shield);

  // Static car pieces share a handful of draw calls; wheels and effects remain articulated.
  const bodyBatches = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const mergedChildren: THREE.Object3D[] = [];
  car.updateMatrixWorld(true);
  for (const child of car.children) {
    if (!(child instanceof THREE.Mesh) || child === shield || child.material === decalMat || child.material === liveryMat) continue;
    if (Array.isArray(child.material)) continue;
    const g = child.geometry.clone().applyMatrix4(child.matrix);
    const pieces = bodyBatches.get(child.material) ?? [];
    pieces.push(g.index ? g.toNonIndexed() : g);
    if (g.index) g.dispose();
    bodyBatches.set(child.material, pieces);
    mergedChildren.push(child);
  }
  for (const child of mergedChildren) {
    car.remove(child);
    (child as THREE.Mesh).geometry.dispose();
  }
  for (const [mat, pieces] of bodyBatches) {
    const geometry = mergeGeometries(pieces, false);
    if (geometry) mesh(geometry, mat, 0, 0, 0);
    pieces.forEach(g => g.dispose());
  }
  car.userData.wheels = wheels;
  car.userData.flames = flames;
  car.userData.shield = shield;
  return car;
}
