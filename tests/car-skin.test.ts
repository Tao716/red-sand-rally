import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';
import * as THREE from 'three';
import { createCar } from '../src/world';
import { disposeCarVisual, paintCarLivery } from '../src/car-skin';
import { RaceRenderer } from '../src/renderer';
import { DEFAULT_SKIN, SKINS, SKIN_ORDER, type SkinId } from '../src/skins';

type RecordedContext = CanvasRenderingContext2D & { commands: unknown[][] };
function recordingContext(): RecordedContext {
  const commands: unknown[][] = [];
  const values = new Map<PropertyKey, unknown>();
  return new Proxy({ commands }, {
    get(target, key) {
      if (key === 'commands') return target.commands;
      if (values.has(key)) return values.get(key);
      return (...args: unknown[]) => { commands.push([key, ...args]); };
    },
    set(_target, key, value) { values.set(key, value); commands.push(['set', key, value]); return true; },
  }) as RecordedContext;
}

let documentDescriptor: PropertyDescriptor | undefined;
let fixtures: THREE.Group[];
beforeEach(() => {
  fixtures = [];
  documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement(tag: string) {
      assert.equal(tag, 'canvas');
      const context = recordingContext();
      return { width: 0, height: 0, getContext: () => context };
    },
  } });
});
afterEach(() => {
  fixtures.forEach(disposeCarVisual);
  if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
  else Reflect.deleteProperty(globalThis, 'document');
});

function carFor(id: SkinId = DEFAULT_SKIN, isPlayer = true): THREE.Group {
  const car = createCar(isPlayer ? 0xf16235 : 0xab89ed, isPlayer, SKINS[id]);
  fixtures.push(car);
  return car;
}

function resources(car: THREE.Group) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  car.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  return { geometries, materials, textures };
}

function watchDisposals(car: THREE.Group): Map<THREE.BufferGeometry | THREE.Material | THREE.Texture, number> {
  const assets = resources(car);
  const counts = new Map<THREE.BufferGeometry | THREE.Material | THREE.Texture, number>();
  for (const resource of [...assets.geometries, ...assets.materials, ...assets.textures]) {
    counts.set(resource, 0);
    resource.addEventListener('dispose', () => { counts.set(resource, counts.get(resource)! + 1); });
  }
  return counts;
}

function solidBounds(car: THREE.Group): number[] {
  car.updateMatrixWorld(true);
  const bounds = new THREE.Box3();
  const effects = new Set<THREE.Object3D>([car.userData.shield, ...car.userData.flames]);
  car.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    for (let ancestor: THREE.Object3D | null = object; ancestor; ancestor = ancestor.parent) {
      if (effects.has(ancestor)) return;
    }
    object.geometry.computeBoundingBox();
    bounds.union(object.geometry.boundingBox!.clone().applyMatrix4(object.matrixWorld));
  });
  return [...bounds.min.toArray(), ...bounds.max.toArray()].map(value => Number(value.toFixed(7)));
}

function materialNamed(car: THREE.Group, name: string): THREE.MeshStandardMaterial {
  const found = [...resources(car).materials].find(material => material.name === name);
  assert.ok(found instanceof THREE.MeshStandardMaterial, `${name} is rendered`);
  return found;
}

function containsVertexColor(geometry: THREE.BufferGeometry, color: number): boolean {
  const expected = new THREE.Color(color);
  const attribute = geometry.getAttribute('color');
  if (!attribute) return false;
  for (let i = 0; i < attribute.count; i++) {
    if (Math.abs(attribute.getX(i) - expected.r) < 1e-6
      && Math.abs(attribute.getY(i) - expected.g) < 1e-6
      && Math.abs(attribute.getZ(i) - expected.b) < 1e-6) return true;
  }
  return false;
}

function visualSignature(car: THREE.Group): string {
  const hash = createHash('sha256');
  car.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const attribute of Object.values(object.geometry.attributes)) {
      hash.update(Buffer.from(attribute.array.buffer, attribute.array.byteOffset, attribute.array.byteLength));
    }
    if (object.geometry.index) {
      const indices = object.geometry.index.array;
      hash.update(Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength));
    }
    const mat = object.material as THREE.MeshStandardMaterial;
    const texture = mat.map?.image as { getContext: () => RecordedContext } | undefined;
    hash.update(JSON.stringify({
      position: object.position.toArray(), rotation: object.quaternion.toArray(), scale: object.scale.toArray(),
      color: mat.color?.getHex(), emissive: mat.emissive?.getHex(), emissiveIntensity: mat.emissiveIntensity,
      roughness: mat.roughness, metalness: mat.metalness, opacity: mat.opacity, texture: texture?.getContext().commands,
    }));
  });
  return hash.digest('hex');
}

test('all six player skins retain the exact solid silhouette and articulated contact points', () => {
  const original = createCar(0xf16235, true);
  fixtures.push(original);
  const originalBounds = solidBounds(original);
  for (const id of SKIN_ORDER) {
    const car = carFor(id);
    assert.equal(car.userData.skinId, id);
    assert.equal(car.userData.baseColor, 0xf16235, 'visual paint never overwrites the race color');
    assert.deepEqual(solidBounds(car), originalBounds, `${id} cannot change the car silhouette`);
    const wheels = car.userData.wheels as THREE.Object3D[];
    assert.equal(wheels.length, 4);
    assert.deepEqual(wheels.map(wheel => wheel.position.toArray()), [
      [-1.15, 0.61, -1.49], [-1.15, 0.61, 1.51], [1.15, 0.61, -1.49], [1.15, 0.61, 1.51],
    ]);
    assert.ok(wheels.every(wheel => wheel.parent === car && wheel.children.length === 2));
    assert.equal(car.userData.flames.length, 2);
    assert.ok(car.userData.flames.every((flame: THREE.Object3D) => flame.parent === car && flame.children.length === 2));
    assert.equal(car.userData.shield.parent, car);
    assert.deepEqual(car.userData.shield.scale.toArray(), [1.72, 1.48, 2.85]);
  }
});

test('body finish, baked wheel rims and boost colors actually use each selected palette', () => {
  for (const id of SKIN_ORDER) {
    const car = carFor(id), skin = SKINS[id];
    const body = materialNamed(car, 'car/body');
    assert.equal(body.color.getHex(), skin.body);
    assert.equal(body.roughness, skin.roughness);
    assert.equal(body.metalness, skin.metalness);
    assert.equal(materialNamed(car, 'car/accent').color.getHex(), skin.accent);
    for (const wheel of car.userData.wheels as THREE.Group[]) {
      const metal = wheel.children.find(child => (child as THREE.Mesh).geometry.getAttribute('color')) as THREE.Mesh;
      for (const color of [skin.body, skin.accent, id === 'sandstorm' ? 0x484c49 : skin.trim]) {
        assert.ok(containsVertexColor(metal.geometry, color), `${id} wheel colors are rebaked`);
      }
    }
    for (const flame of car.userData.flames as THREE.Group[]) {
      assert.equal(((flame.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial).color.getHex(), skin.glow);
    }
    assert.equal((car.userData.shield.material as THREE.MeshBasicMaterial).color.getHex(), 0x72eddf,
      'a gameplay shield keeps its recognizable color');
  }
});

test('five alternate skins have hood and roof films, all six patterns are distinct and number 07 remains', () => {
  const signatures = new Set<string>();
  for (const id of SKIN_ORDER) {
    const context = recordingContext();
    paintCarLivery(context, { ...SKINS[id], accent: 0xffffff, glow: 0xdddddd });
    signatures.add(JSON.stringify(context.commands));
    const car = carFor(id);
    const assets = resources(car);
    const number = [...assets.textures].find(texture => texture.name === 'car/race-number');
    assert.ok(number);
    const commands = (number.image as { getContext: () => RecordedContext }).getContext().commands;
    assert.ok(commands.some(command => command[0] === 'fillText' && command[1] === '07'));
    const films = car.children.filter(object => object instanceof THREE.Mesh
      && (object.material as THREE.Material).name === `skin/${id}/livery`) as THREE.Mesh[];
    if (id === 'sandstorm') {
      assert.equal(films.length, 0, 'the original dimensional twin stripes stay intact');
      assert.equal(assets.textures.size, 1);
    } else {
      assert.equal(films.length, 2, 'hood and roof both show the selected pattern');
      assert.equal(films[0].material, films[1].material, 'two films share one owned texture');
      assert.equal(assets.textures.size, 2);
      for (const film of films) {
        assert.equal(film.castShadow, false);
        assert.equal((film.material as THREE.MeshStandardMaterial).depthWrite, false);
        assert.ok(Math.abs(film.position.x) + (film.geometry as THREE.PlaneGeometry).parameters.width / 2 < 0.87);
      }
    }
  }
  assert.equal(signatures.size, 6, 'patterns differ geometrically even with identical ink colors');
});

test('passing a player skin to a rival cannot alter any rival geometry, palette, texture or effects', () => {
  const original = createCar(0xab89ed, false);
  fixtures.push(original);
  const signature = visualSignature(original);
  for (const id of SKIN_ORDER) {
    const rival = carFor(id, false);
    assert.equal(rival.userData.skinId, undefined);
    assert.equal(visualSignature(rival), signature);
  }
});

test('car disposal releases every retained GPU asset once and does not touch another car', () => {
  const first = carFor('neon'), second = carFor('neon');
  const firstAssets = resources(first), secondAssets = resources(second);
  for (const key of ['geometries', 'materials', 'textures'] as const) {
    for (const asset of firstAssets[key]) assert.ok(!(secondAssets[key] as Set<unknown>).has(asset));
  }
  const firstCounts = watchDisposals(first), secondCounts = watchDisposals(second);
  const scene = new THREE.Scene(); scene.add(first, second);
  disposeCarVisual(first);
  disposeCarVisual(first);
  assert.equal(first.parent, null);
  assert.equal(second.parent, scene);
  assert.ok([...firstCounts.values()].every(count => count === 1));
  assert.ok([...secondCounts.values()].every(count => count === 0));
});

function rendererFixture(player?: THREE.Group, rival?: THREE.Group) {
  const scene = new THREE.Scene();
  const cars = new Map<number, THREE.Group>();
  if (player) { cars.set(0, player); scene.add(player); }
  if (rival) { cars.set(1, rival); scene.add(rival); }
  // Exercise the real public switch path without constructing a browser/WebGL context.
  const renderer = Object.assign(Object.create(RaceRenderer.prototype) as RaceRenderer, {
    scene, cars, selectedSkin: DEFAULT_SKIN,
  });
  return { renderer, scene, cars };
}

test('renderer accepts a saved skin before the first frame and rejects unsupported ids', () => {
  const { renderer, cars } = rendererFixture();
  assert.equal(renderer.playerSkin, 'sandstorm');
  assert.equal(renderer.setPlayerSkin('glacier'), true);
  assert.equal(renderer.playerSkin, 'glacier');
  assert.equal(cars.size, 0, 'selection before the first frame does not create an unbound car');
  for (const value of ['', 'constructor', '__proto__', null, undefined, 'GLACIER']) {
    assert.equal(renderer.setPlayerSkin(value as SkinId), false);
    assert.equal(renderer.playerSkin, 'glacier');
  }
});

test('renderer replaces only the player once per change, preserves motion and frees the old visual', () => {
  let player = carFor();
  const rival = carFor('sandstorm', false);
  player.position.set(12, 4, -30);
  player.rotation.set(0.1, 1.2, 0.03, 'YXZ');
  player.userData.wheels.forEach((wheel: THREE.Object3D, i: number) => { wheel.rotation.x = 7.8 + i; });
  player.userData.flames.forEach((flame: THREE.Object3D) => { flame.visible = true; flame.scale.setScalar(1.13); });
  player.userData.shield.visible = true;
  player.userData.shield.rotation.y = 2.5;
  const { renderer, scene, cars } = rendererFixture(player, rival);
  const rivalCounts = watchDisposals(rival);
  for (const id of [...SKIN_ORDER.slice(1), ...SKIN_ORDER]) {
    const previous = player;
    const counts = watchDisposals(previous);
    assert.equal(renderer.setPlayerSkin(id), true);
    player = cars.get(0)!;
    fixtures.push(player);
    assert.notEqual(player, previous);
    assert.equal(player.userData.skinId, id);
    assert.equal(renderer.playerSkin, id);
    assert.equal(cars.get(1), rival);
    assert.equal(scene.children.length, 2);
    assert.deepEqual(player.position.toArray(), previous.position.toArray());
    assert.deepEqual(player.quaternion.toArray(), previous.quaternion.toArray());
    assert.deepEqual(player.userData.wheels.map((wheel: THREE.Object3D) => wheel.quaternion.toArray()),
      previous.userData.wheels.map((wheel: THREE.Object3D) => wheel.quaternion.toArray()));
    assert.ok(player.userData.flames.every((flame: THREE.Object3D) => flame.visible && flame.scale.x === 1.13));
    assert.equal(player.userData.shield.visible, true);
    assert.equal(player.userData.shield.rotation.y, 2.5);
    assert.ok([...counts.values()].every(count => count === 1), `${id}: previous assets disposed exactly once`);
    assert.ok([...rivalCounts.values()].every(count => count === 0));
    assert.equal(renderer.setPlayerSkin(id), true);
    assert.equal(cars.get(0), player, 'reselecting a skin never rebuilds its car');
    assert.ok([...counts.values()].every(count => count === 1));
  }
});
