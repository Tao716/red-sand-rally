import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoxVolume, intersectVolumes, racerVolume, type StaticCollider } from '../src/collision';
import { RaceSimulation } from '../src/simulation';
import { sampleTrack, TRACK_LENGTH } from '../src/track';
import { EMPTY_INPUT, type InputState, type Racer } from '../src/types';

const controls = (changes: Partial<InputState> = {}): InputState => ({ ...EMPTY_INPUT, ...changes });
const near = (actual: number, expected: number, tolerance = 1e-7) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should equal ${expected}`);

function isolate(sim: RaceSimulation) {
  for (const racer of sim.state.racers.slice(1)) {
    racer.finished = true;
    racer.distance = 400 + racer.id * 80;
    racer.speed = 0;
  }
  for (const pickup of sim.state.pickups) pickup.cooldown = 1000;
  Object.assign(sim.state.racers[0], { distance: 25, lateral: 0, heading: 0, speed: 0 });
  return sim;
}

function running() {
  const sim = new RaceSimulation(42);
  sim.start(); sim.update(3);
  return isolate(sim);
}

function opponent(sim: RaceSimulation, id: number, changes: Partial<Racer>) {
  const racer = sim.state.racers[id];
  Object.assign(racer, { finished: false, distance: 30, lateral: 0, heading: 0, speed: 0 }, changes);
  return racer;
}

function trackSolid(id: string, distance: number, lateral = 0, halfWidth = 20, halfLength = 0.08,
  minHeight = 0, maxHeight = 3): StaticCollider {
  const p = sampleTrack(distance);
  return { id, kind: 'barrier', ...createBoxVolume(p.x + p.nx * lateral,
    p.y + (minHeight + maxHeight) / 2, p.z + p.nz * lateral,
    halfWidth, (maxHeight - minHeight) / 2, halfLength, p.heading) };
}

function noCarPenetration(a: Racer, b: Racer) {
  const depth = intersectVolumes(racerVolume(a), racerVolume(b))?.depth ?? 0;
  assert.ok(depth <= 0.04, `cars ${a.id}/${b.id} still overlap by ${depth} m`);
}

function noSolidPenetration(racer: Racer, solid: StaticCollider) {
  const depth = intersectVolumes(racerVolume(racer), solid)?.depth ?? 0;
  assert.ok(depth <= 0.04, `car ${racer.id} penetrates ${solid.id} by ${depth} m`);
}

function furthestAhead(racer: Racer, distance: number) {
  const p = sampleTrack(distance);
  return Math.max(...racerVolume(racer).points.map(point => (point.x - p.x) * p.tx + (point.z - p.z) * p.tz));
}

test('rear impacts separate actual car bodies, slow the striking car and transfer momentum', () => {
  const sim = running(), player = sim.state.racers[0];
  player.speed = 60;
  const front = opponent(sim, 1, { distance: 30, speed: 10 });
  assert.equal(intersectVolumes(racerVolume(player), racerVolume(front)), null);
  sim.update(0.12);
  assert.ok(player.speed < 45, 'the striking car must lose substantial forward speed');
  assert.ok(front.speed > 25, 'the front car should receive momentum');
  assert.ok(front.distance > player.distance);
  noCarPenetration(player, front);
  assert.ok(player.collisionTime > 0 && front.collisionTime > 0);
  for (const id of [0, 1]) {
    const event = sim.state.events.find(event => event.type === 'collision' && event.racer === id);
    assert.ok(event?.collisionKind === 'car' && event.contact && Number.isFinite(event.contact.x));
    assert.ok(event.strength && event.strength > 0);
  }
  assert.equal(sim.state.hits, 0, 'solid contacts are not weapon damage');
});

test('angled side scrapes use the rotated footprint and generate sideways separation and speed loss', () => {
  const sim = running(), baseline = running(), player = sim.state.racers[0];
  Object.assign(player, { speed: 50, heading: -0.4 });
  Object.assign(baseline.state.racers[0], { speed: 50, heading: -0.4 });
  const side = opponent(sim, 1, { distance: 25, lateral: 3.5, speed: 30 });
  // Axis-aligned widths would miss this pair: 3.5 m exceeds their 2.76 m combined width.
  assert.ok(intersectVolumes(racerVolume(player), racerVolume(side)));
  sim.update(0.1); baseline.update(0.1);
  noCarPenetration(player, side);
  assert.ok(player.lateral < baseline.state.racers[0].lateral - 0.2);
  assert.ok(side.lateral > 3.7, 'the struck car must be pushed away laterally');
  assert.ok(player.speed < baseline.state.racers[0].speed - 2);
  assert.ok(sim.state.events.some(event => event.type === 'collision' && event.collisionKind === 'car'));
});

test('84 m/s boost cannot cross a 16 cm static wall during a half-second update', () => {
  const sim = running(), player = sim.state.racers[0], wall = trackSolid('thin-wall', 45);
  sim.setStaticColliders([wall]);
  Object.assign(player, { speed: 84, boostTime: 2 });
  sim.update(0.5, controls({ throttle: true, boost: true }));
  noSolidPenetration(player, wall);
  assert.ok(furthestAhead(player, 45) <= -0.08 + 0.04, 'the whole car must remain on the entry side');
  assert.ok(player.distance > 25 && player.distance < 43);
  assert.ok(player.speed < 15);
  assert.ok(sim.state.events.some(event => event.type === 'collision' && event.collisionKind === 'barrier'));
});

test('a low solid obstacle stops the body while an overhead crossbeam remains passable', () => {
  const low = running(), high = running();
  const obstacle = trackSolid('low-obstacle', 38, 0, 20, 0.15, 0, 0.45);
  const beam = trackSolid('high-crossbeam', 38, 0, 20, 0.15, 3.6, 4.6);
  low.setStaticColliders([obstacle]); high.setStaticColliders([beam]);
  low.state.racers[0].speed = high.state.racers[0].speed = 60;
  low.update(0.5, controls({ throttle: true })); high.update(0.5, controls({ throttle: true }));
  noSolidPenetration(low.state.racers[0], obstacle);
  assert.ok(furthestAhead(low.state.racers[0], 38) <= -0.15 + 0.04);
  assert.ok(high.state.racers[0].distance > 48, 'the beam must not become a wall below its visible height');
  assert.ok(high.state.racers[0].speed > 45);
  assert.ok(!high.state.events.some(event => event.type === 'collision'));
});

test('an open gap between roadside rail segments does not introduce an invisible edge wall', () => {
  const sim = running(), player = sim.state.racers[0];
  sim.setStaticColliders([
    trackSolid('rail-before-gap', 5, 11, 0.25, 5),
    trackSolid('rail-after-gap', 55, 11, 0.25, 5),
    trackSolid('other-side-rail', 25, -11, 0.25, 12),
  ]);
  Object.assign(player, { lateral: 9, heading: -0.7, speed: 40 });
  sim.update(0.2, controls({ throttle: true }));
  assert.ok(player.lateral > 11.5, 'the car should be able to drive off the open road edge');
  assert.ok(player.distance > 30 && player.speed > 20);
  assert.equal(player.collisionTime, 0);
  assert.ok(!sim.state.events.some(event => event.type === 'collision' || event.type === 'reset'));
});

test('braking into reverse lets the player retreat from a contacted wall without sticking', () => {
  const sim = running(), player = sim.state.racers[0], wall = trackSolid('reverse-wall', 45);
  sim.setStaticColliders([wall]);
  player.speed = 84;
  sim.update(0.5, controls({ throttle: true }));
  assert.ok(sim.state.events.some(event => event.type === 'collision'));
  const afterImpact = player.distance;
  sim.update(1, controls({ brake: true }));
  assert.ok(player.speed < -4 && player.distance < afterImpact - 2);
  noSolidPenetration(player, wall);
  assert.ok(furthestAhead(player, 45) < -2);
});

test('shield and weapon-invulnerability do not remove body collisions or get consumed by impacts', () => {
  for (const kind of ['car', 'wall'] as const) {
    const sim = running(), player = sim.state.racers[0];
    Object.assign(player, { speed: 60, shield: 5, invulnerable: 4 });
    let other: Racer | undefined;
    if (kind === 'car') other = opponent(sim, 1, { distance: 30, speed: 0, shield: 4, invulnerable: 3 });
    else sim.setStaticColliders([trackSolid('protected-wall', 30)]);
    sim.update(0.1);
    assert.ok(player.speed < 40 && player.collisionTime > 0, `${kind} must remain physically solid`);
    near(player.shield, 4.9); near(player.invulnerable, 3.9);
    assert.equal(player.hitTime, 0);
    if (other) {
      noCarPenetration(player, other);
      near(other.shield, 3.9); near(other.invulnerable, 2.9);
      assert.equal(other.hitTime, 0);
    }
    assert.ok(!sim.state.events.some(event => event.type === 'shield' || event.type === 'hit'));
  }
});

test('pause freezes collision timers, positions and the rest of the race state', () => {
  const sim = running(), player = sim.state.racers[0];
  player.speed = 60; opponent(sim, 1, { distance: 30, speed: 0 });
  sim.update(0.1);
  assert.ok(player.collisionTime > 0);
  sim.pause();
  const before = JSON.stringify({ ...sim.state, events: [] });
  sim.update(2, controls({ throttle: true, boost: true, steer: 1 }));
  assert.equal(JSON.stringify(sim.state), before);
  sim.resume();
  const timer = player.collisionTime;
  sim.update(1 / 90);
  assert.ok(player.collisionTime < timer);
});

test('restarting or returning through the menu clears impact motion but preserves world solids', () => {
  for (const throughMenu of [false, true]) {
    const sim = running(), wall = trackSolid('persistent-wall', 45);
    sim.setStaticColliders([wall]);
    sim.state.racers[0].speed = 84;
    sim.update(0.5, controls({ throttle: true }));
    assert.ok(sim.state.racers[0].collisionTime > 0);
    if (throughMenu) sim.returnToMenu();
    sim.start(); sim.update(3); isolate(sim);
    const player = sim.state.racers[0];
    assert.ok(sim.state.racers.every(racer => racer.collisionTime === 0));
    sim.update(0.1);
    near(player.distance, 25); near(player.lateral, 0); near(player.heading, 0); near(player.speed, 0);
    player.speed = 84;
    sim.update(0.5, controls({ throttle: true }));
    assert.ok(sim.state.events.some(event => event.type === 'collision' && event.collisionKind === 'barrier'));
    assert.ok(furthestAhead(player, 45) <= -0.08 + 0.04);
  }
});

test('three-car pileups against a wall remain finite, separated and on the same lap', () => {
  const sim = running(), wall = trackSolid('pileup-wall', 35.7, 0, 20, 0.15);
  sim.setStaticColliders([wall]);
  Object.assign(sim.state.racers[0], { distance: 22.9, speed: 84 });
  opponent(sim, 1, { distance: 27.6, speed: 40 });
  opponent(sim, 2, { distance: 32.3, speed: 15 });
  const cars = sim.state.racers.slice(0, 3);
  for (let frame = 0; frame < 180; frame++) {
    const previous = cars.map(racer => racer.distance);
    sim.update(1 / 60, controls({ throttle: true }));
    for (let i = 0; i < cars.length; i++) {
      const racer = cars[i];
      assert.ok([racer.distance, racer.lateral, racer.heading, racer.speed].every(Number.isFinite));
      assert.ok(Math.abs(racer.distance - previous[i]) < 6, 'local corrections must not teleport along the circuit');
      assert.equal(racer.lap, 1);
      assert.ok(furthestAhead(racer, 35.7) <= -0.15 + 0.04);
      noSolidPenetration(racer, wall);
      for (let j = i + 1; j < cars.length; j++) noCarPenetration(racer, cars[j]);
    }
  }
});

test('collisions across the circuit seam and negative starting distances cannot jump laps', () => {
  for (const start of [-1.5, TRACK_LENGTH - 1.5]) {
    const sim = running(), player = sim.state.racers[0];
    Object.assign(player, { distance: start, speed: 20 });
    const front = opponent(sim, 1, { distance: 1.5, speed: 0 });
    sim.update(0.02);
    noCarPenetration(player, front);
    for (const racer of [player, front]) {
      assert.ok([racer.distance, racer.lateral, racer.heading, racer.speed].every(Number.isFinite));
      assert.equal(racer.lap, 1);
      assert.equal(racer.finished, false);
    }
    assert.ok(Math.abs(player.distance - start) < 6);
    assert.ok(Math.abs(front.distance - 1.5) < 6);
    assert.ok(player.distance < start, 'the approaching car should be corrected backward, not into the next lap');
    assert.ok(sim.state.events.some(event => event.type === 'collision'));
    assert.ok(!sim.state.events.some(event => event.type === 'lap' || event.type === 'finish'));
  }
});

test('a solid wall intercepts a homing rocket before it reaches a racer behind it', () => {
  const sim = running(), player = sim.state.racers[0];
  const target = opponent(sim, 1, { distance: 60, speed: 0 });
  sim.setStaticColliders([trackSolid('rocket-wall', 48)]);
  player.item = 'rocket';
  sim.update(0.4, controls({ useItem: true }));
  assert.equal(sim.state.projectiles.length, 0);
  assert.equal(sim.state.hits, 0);
  assert.equal(target.hitTime, 0);
  const blocked = sim.state.events.find(event => event.type === 'collision' && event.text === 'PROJECTILE_BLOCKED');
  assert.ok(blocked?.item === 'rocket' && blocked.contact && Number.isFinite(blocked.contact.z));
});

test('rockets near a car miss outside its real footprint and hit when their volumes overlap', () => {
  const miss = running(), hit = running();
  for (const [sim, lateral] of [[miss, 2.3], [hit, 0]] as const) {
    opponent(sim, 1, { distance: 50, lateral, speed: 0 });
    sim.state.projectiles.push({ id: 77, type: 'rocket', owner: 0, distance: 48.5,
      lateral: 0, lifetime: 3, powered: false, target: 1 });
    sim.update(1 / 90);
  }
  assert.equal(miss.state.hits, 0);
  assert.equal(miss.state.racers[1].hitTime, 0);
  assert.equal(miss.state.projectiles.length, 1, 'proximity alone must not destroy a near-missing rocket');
  assert.equal(hit.state.hits, 1);
  assert.ok(hit.state.racers[1].hitTime > 0);
  assert.equal(hit.state.projectiles.length, 0);
});
