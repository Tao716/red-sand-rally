import * as THREE from 'three';
import type { CarSkin } from './skins';

const cssColor = (color: number) => `#${color.toString(16).padStart(6, '0')}`;

/** Normalized, opaque ink on transparent paint film; +Z/front is the bottom edge. */
export function paintCarLivery(ctx: CanvasRenderingContext2D, skin: CarSkin, size = 512): void {
  ctx.save();
  ctx.scale(size, size);
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = cssColor(skin.accent);
  ctx.strokeStyle = cssColor(skin.accent);
  ctx.lineJoin = 'miter';
  ctx.lineCap = 'butt';
  const line = (points: readonly (readonly [number, number])[], width: number) => {
    ctx.lineWidth = width;
    ctx.beginPath();
    points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.stroke();
  };
  const polygon = (points: readonly (readonly [number, number])[]) => {
    ctx.beginPath();
    points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.closePath();
    ctx.fill();
  };
  switch (skin.pattern) {
    case 'twin':
      ctx.fillRect(0.29, 0, 0.17, 1);
      ctx.fillRect(0.50, 0, 0.065, 1);
      break;
    case 'offset':
      ctx.fillRect(0.68, 0, 0.20, 1);
      ctx.fillStyle = cssColor(skin.glow);
      ctx.fillRect(0.59, 0, 0.025, 1);
      ctx.fillRect(0.94, 0, 0.018, 1);
      ctx.fillStyle = cssColor(skin.accent);
      for (let i = 0; i < 3; i++) ctx.fillRect(0.09 + i * 0.07, 0.72, 0.034, 0.19);
      break;
    case 'chevron':
      for (const y of [-0.07, 0.28, 0.63]) line([[0.10, y], [0.50, y + 0.26], [0.90, y]], 0.12);
      ctx.strokeStyle = cssColor(skin.glow);
      line([[0.04, 0], [0.04, 1]], 0.025);
      line([[0.96, 0], [0.96, 1]], 0.025);
      break;
    case 'split':
      polygon([[0.52, 0], [1, 0], [1, 1], [0.52, 1], [0.52, 0.66], [0.38, 0.50], [0.52, 0.34]]);
      ctx.strokeStyle = cssColor(skin.glow);
      line([[0.46, 0], [0.46, 0.32], [0.31, 0.50], [0.46, 0.68], [0.46, 1]], 0.035);
      ctx.fillStyle = cssColor(skin.glow);
      ctx.fillRect(0.10, 0.13, 0.15, 0.025);
      ctx.fillRect(0.10, 0.20, 0.10, 0.025);
      break;
    case 'circuit':
      line([[0.18, 0], [0.18, 0.29], [0.38, 0.47], [0.38, 1]], 0.050);
      line([[0.52, 0], [0.52, 0.26], [0.75, 0.49], [0.75, 1]], 0.070);
      line([[0.90, 0], [0.90, 0.27], [0.73, 0.27]], 0.035);
      line([[0.11, 1], [0.11, 0.66], [0.23, 0.55]], 0.035);
      ctx.fillStyle = cssColor(skin.glow);
      for (const [x, y] of [[0.18, 0.29], [0.38, 0.75], [0.75, 0.49], [0.73, 0.27], [0.23, 0.55]]) {
        ctx.beginPath(); ctx.arc(x, y, 0.052, 0, Math.PI * 2); ctx.fill();
      }
      break;
    case 'slash':
      for (const y of [-0.26, 0.16, 0.58]) {
        polygon([[0, y + 0.27], [1, y], [1, y + 0.20], [0, y + 0.47]]);
      }
      ctx.strokeStyle = cssColor(skin.glow);
      for (const y of [-0.02, 0.40, 0.82]) line([[0, y + 0.27], [1, y]], 0.025);
      break;
  }
  ctx.restore();
}

const disposedCars = new WeakSet<THREE.Object3D>();

/** Car assets are locally owned. Shared wheel/decals resources are released only once. */
export function disposeCarVisual(car: THREE.Group): void {
  if (disposedCars.has(car)) return;
  disposedCars.add(car);
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  car.traverse(object => {
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
  car.removeFromParent();
}
