import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAR_HALF_HEIGHT, CAR_HALF_LENGTH, CAR_HALF_WIDTH, createBoxVolume, intersectVolumes,
  racerVolume, StaticCollisionIndex, type CollisionVolume, type StaticCollider,
} from '../src/collision';
import { sampleTrack, TRACK_LENGTH } from '../src/track';

const near = (actual: number, expected: number, epsilon = 1e-7) =>
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} should equal ${expected}`);
const box = (x = 0, z = 0, yaw = 0) => createBoxVolume(x, 1, z, 1, 1, 1, yaw);
const moved = (volume: CollisionVolume, dx: number, dz: number): CollisionVolume => ({
  ...volume, points: volume.points.map(p => ({ x: p.x + dx, z: p.z + dz })),
});
const collider = (id: string, volume: CollisionVolume): StaticCollider => ({ ...volume, id, kind: 'barrier' });

test('box volumes use center height and the same positive Y rotation as Three.js', () => {
  const volume = createBoxVolume(5, 4, -2, 1, 2, 3, Math.PI / 2);
  near(volume.minY, 2); near(volume.maxY, 6);
  near(volume.points[0].x, 2); near(volume.points[0].z, -1);
  near(volume.points[2].x, 8); near(volume.points[2].z, -3);
});

test('SAT returns outward unit normals and exact depths on both sides of each axis', () => {
  for (const [x, z, nx, nz] of [[1.5, 0, 1, 0], [-1.5, 0, -1, 0], [0, 1.5, 0, 1], [0, -1.5, 0, -1]]) {
    const a = box(x, z), b = box();
    const contact = intersectVolumes(a, b);
    assert.ok(contact);
    near(contact.nx, nx); near(contact.nz, nz); near(contact.depth, 0.5);
    near(contact.point.x, x / 2); near(contact.point.z, z / 2); near(contact.point.y, 1);
    assert.equal(intersectVolumes(moved(a, contact.nx * contact.depth, contact.nz * contact.depth), b), null);
  }
});

test('separate boxes, edge touching and corner touching do not collide', () => {
  assert.equal(intersectVolumes(box(20), box()), null);
  assert.equal(intersectVolumes(box(2), box()), null);
  assert.equal(intersectVolumes(box(2, 2), box()), null);
  assert.ok(intersectVolumes(box(2 - 1e-5), box()));
});

test('SAT rejects rotated boxes whose AABBs overlap but bodies do not', () => {
  const yaw = Math.PI / 4;
  const a = createBoxVolume(0, 1, 0, 0.3, 1, 4, yaw);
  const b = createBoxVolume(Math.cos(yaw) * 0.8, 1, -Math.sin(yaw) * 0.8, 0.3, 1, 4, yaw);
  assert.equal(intersectVolumes(a, b), null);
});

test('rotated side contact resolves along the actual body face, not world axes', () => {
  const yaw = Math.PI / 4, nx = Math.cos(yaw), nz = -Math.sin(yaw);
  const a = createBoxVolume(nx * 0.45, 1, nz * 0.45, 0.3, 1, 4, yaw);
  const b = createBoxVolume(0, 1, 0, 0.3, 1, 4, yaw);
  const contact = intersectVolumes(a, b);
  assert.ok(contact);
  near(contact.depth, 0.15); near(contact.nx, nx); near(contact.nz, nz);
  assert.equal(intersectVolumes(moved(a, nx * contact.depth, nz * contact.depth), b), null);
});

test('vertical separation permits driving below structures, including exact height contact', () => {
  assert.equal(intersectVolumes(box(), createBoxVolume(0, 3, 0, 1, 1, 1)), null);
  assert.equal(intersectVolumes(box(), createBoxVolume(0, 8, 0, 1, 1, 1)), null);
  const contact = intersectVolumes(box(), createBoxVolume(0, 2.5, 0, 1, 1, 1));
  assert.ok(contact);
  near(contact.point.y, 1.75);
});

test('containment uses the distance to exit, not merely the interval intersection width', () => {
  const inner = box(0.5), outer = createBoxVolume(0, 1, 0, 3, 1, 3);
  const contact = intersectVolumes(inner, outer);
  assert.ok(contact);
  near(contact.nx, 1); near(contact.nz, 0); near(contact.depth, 3.5);
  assert.equal(intersectVolumes(moved(inner, contact.nx * contact.depth, 0), outer), null);
  const reverse = intersectVolumes(outer, inner);
  assert.ok(reverse);
  near(reverse.nx, -1); near(reverse.depth, contact.depth);
  assert.equal(intersectVolumes(moved(outer, reverse.nx * reverse.depth, 0), inner), null);
});

test('coincident centers still produce a finite deterministic escape vector', () => {
  const contact = intersectVolumes(box(), box());
  assert.ok(contact);
  near(Math.hypot(contact.nx, contact.nz), 1); near(contact.depth, 2);
  assert.ok(Object.values(contact.point).every(Number.isFinite));
  assert.deepEqual(intersectVolumes(box(), box()), contact);
  assert.equal(intersectVolumes(moved(box(), contact.nx * contact.depth, contact.nz * contact.depth), box()), null);
});

test('convex rock footprints work in either winding order and provide an actual overlap point', () => {
  const rock: CollisionVolume = { points: [{ x: -3, z: -2 }, { x: 3, z: -2 }, { x: 0, z: 3 }], minY: 0, maxY: 4 };
  const a = box(1.5, 1.5);
  const contact = intersectVolumes(a, rock);
  const reversed = intersectVolumes(a, { ...rock, points: [...rock.points].reverse() });
  assert.ok(contact && reversed);
  near(contact.depth, reversed.depth); near(contact.nx, reversed.nx); near(contact.nz, reversed.nz);
  assert.equal(intersectVolumes(moved(a, contact.nx * contact.depth, contact.nz * contact.depth), rock), null);
  assert.ok(contact.point.x >= 0.5 && contact.point.x <= 2.5 && contact.point.z >= 0.5 && contact.point.z <= 2.5);
  assert.ok(contact.point.z <= 3 - contact.point.x * 5 / 3 + 1e-7);
});

test('invalid and zero-area volumes never yield NaN collision corrections', () => {
  assert.equal(intersectVolumes({ ...box(), points: [] }, box()), null);
  assert.equal(intersectVolumes(createBoxVolume(0, 1, 0, 0, 1, 1, Math.PI / 4), box()), null);
  assert.equal(intersectVolumes({ ...box(), minY: NaN }, box()), null);
});

test('spatial index deduplicates long multi-cell scenery and filters remote or overhead objects', () => {
  const long = collider('long', createBoxVolume(0, 1, 0, 60, 1, 60));
  const far = collider('far', box(300, 300));
  const overhead = collider('overhead', createBoxVolume(0, 10, 0, 60, 1, 60));
  const index = new StaticCollisionIndex([long, far, overhead, long]);
  assert.deepEqual(index.query(createBoxVolume(0, 1, 0, 40, 1, 40)), [long]);
  assert.deepEqual(index.query(box(300, 300)), [far]);
  assert.deepEqual(index.query(box(600, 600)), []);
});

test('spatial indexing covers negative coordinates and rotated boxes across cell boundaries', () => {
  const left = collider('left', createBoxVolume(-24, 1, -48, 1, 1, 4, Math.PI / 4));
  const index = new StaticCollisionIndex([left]);
  assert.deepEqual(index.query(box(-25.5, -49.5)), [left]);
  assert.deepEqual(index.query(box(-21.8, -45.8)), [left]);
  assert.deepEqual(index.query({ ...box(), points: [] }), []);
});

test('racer bodies follow track height, lateral offset, and heading through curves and lap wrapping', () => {
  for (const distance of [-TRACK_LENGTH * 3 - 0.1, -2, 0, 170, 420, 720, TRACK_LENGTH - 0.01, TRACK_LENGTH + 0.01]) {
    const lateral = 4.5, heading = 0.31, p = sampleTrack(distance);
    const body = racerVolume({ distance, lateral, heading });
    const center = body.points.reduce((sum, point) => ({ x: sum.x + point.x / 4, z: sum.z + point.z / 4 }), { x: 0, z: 0 });
    near(center.x, p.x + p.nx * lateral); near(center.z, p.z + p.nz * lateral);
    near(body.minY, p.y + 0.04); near(body.maxY - body.minY, 2 * CAR_HALF_HEIGHT);
    near(Math.hypot(body.points[1].x - body.points[0].x, body.points[1].z - body.points[0].z), 2 * CAR_HALF_WIDTH);
    near(Math.hypot(body.points[2].x - body.points[1].x, body.points[2].z - body.points[1].z), 2 * CAR_HALF_LENGTH);
    near((body.points[2].x - body.points[1].x) / (2 * CAR_HALF_LENGTH), Math.sin(p.heading + heading));
    near((body.points[2].z - body.points[1].z) / (2 * CAR_HALF_LENGTH), Math.cos(p.heading + heading));
  }
});

test('world-space volumes collide continuously across the start/finish seam and negative race distance', () => {
  const before = racerVolume({ distance: -1.5, lateral: 0, heading: 0 });
  const after = racerVolume({ distance: 1.5, lateral: 0, heading: 0 });
  const wrapped = racerVolume({ distance: TRACK_LENGTH - 1.5, lateral: 0, heading: 0 });
  assert.ok(intersectVolumes(before, after));
  for (let i = 0; i < 4; i++) {
    near(before.points[i].x, wrapped.points[i].x); near(before.points[i].z, wrapped.points[i].z);
  }
  assert.ok(intersectVolumes(before, wrapped));
});

test('deterministic randomized OBB contacts are symmetric and their correction always separates', () => {
  let seed = 1947;
  const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 4294967296);
  for (let i = 0; i < 300; i++) {
    const a = createBoxVolume(random() * 4 - 2, 1, random() * 4 - 2, 0.4 + random() * 2, 1, 0.4 + random() * 3, random() * Math.PI * 2);
    const b = createBoxVolume(random() * 4 - 2, 1, random() * 4 - 2, 0.4 + random() * 2, 1, 0.4 + random() * 3, random() * Math.PI * 2);
    const contact = intersectVolumes(a, b), reverse = intersectVolumes(b, a);
    assert.equal(!!contact, !!reverse);
    if (!contact || !reverse) continue;
    near(contact.depth, reverse.depth); near(contact.nx, -reverse.nx); near(contact.nz, -reverse.nz);
    near(Math.hypot(contact.nx, contact.nz), 1);
    assert.ok(Object.values(contact.point).every(Number.isFinite));
    assert.equal(intersectVolumes(moved(a, contact.nx * (contact.depth + 1e-6), contact.nz * (contact.depth + 1e-6)), b), null);
  }
});
