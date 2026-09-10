import assert from 'node:assert/strict';
import test from 'node:test';
import { RaceSimulation } from '../src/simulation';
import { sampleTrack, TRACK_LENGTH } from '../src/track';
import { EMPTY_INPUT, type InputState } from '../src/types';

const input = (changes: Partial<InputState> = {}): InputState => ({ ...EMPTY_INPUT, ...changes });
const running = (seed = 42) => { const sim = new RaceSimulation(seed); sim.start(); sim.update(3, input()); return sim; };
const advance = (sim: RaceSimulation, seconds: number, changes: Partial<InputState> = {}) => {
  for (let frame = 0; frame < Math.round(seconds * 60); frame++) sim.update(1 / 60, input(changes));
};
const clearTraffic = (sim: RaceSimulation) => {
  sim.state.racers.slice(1).forEach((racer, i) => { racer.distance = 400 + i * 100; racer.lateral = -5; });
  sim.state.pickups.forEach(pickup => { pickup.cooldown = 100; });
};

test('start resets a seeded six-car, three-lap race and countdown does not advance cars', () => {
  const sim = new RaceSimulation(11);
  assert.equal(sim.state.phase, 'menu');
  sim.start();
  assert.equal(sim.state.phase, 'countdown');
  assert.equal(sim.state.racers.length, 6);
  assert.equal(sim.state.totalLaps, 3);
  assert.equal(sim.state.racers[0].distance, 0);
  assert.equal(sim.state.racers[0].name, '沙暴');
  assert.equal(sim.state.racers[0].color, 0xf16235);
  assert.ok(sim.state.racers.every(racer => racer.lap === 1));
  sim.update(2, input({ throttle: true }));
  assert.equal(sim.state.countdown, 1);
  assert.equal(sim.state.time, 0);
  assert.equal(sim.state.racers[0].speed, 0);
  sim.update(1, input({ throttle: true }));
  assert.equal(sim.state.phase, 'racing');
  assert.ok(sim.state.events.some(event => event.type === 'countdown' && event.text === 'GO!'));
  advance(sim, 1, { throttle: true });
  assert.ok(sim.state.racers[0].distance > 8);
  sim.start();
  assert.equal(sim.state.racers[0].distance, 0);
  assert.equal(sim.state.time, 0);
});

test('throttle accelerates, releasing coasts, brake stops then allows limited reverse', () => {
  const sim = running();
  clearTraffic(sim);
  advance(sim, 2, { throttle: true });
  const car = sim.state.racers[0];
  assert.ok(car.speed > 40);
  const beforeCoast = car.speed;
  advance(sim, 0.2);
  assert.ok(car.speed < beforeCoast && car.speed > beforeCoast - 3);
  advance(sim, 2, { brake: true });
  assert.ok(car.speed < 0 && car.speed >= -8);
  advance(sim, 1, { throttle: true });
  assert.ok(car.speed > 5);
});

test('right steering increases road lateral; left decreases it', () => {
  const right = running(), left = running();
  clearTraffic(right); clearTraffic(left);
  right.state.racers[0].speed = 35;
  left.state.racers[0].speed = 35;
  advance(right, 0.3, { steer: 1, throttle: true });
  advance(left, 0.3, { steer: -1, throttle: true });
  assert.ok(right.state.racers[0].lateral > left.state.racers[0].lateral + 0.7);
  assert.ok(right.state.racers[0].heading < left.state.racers[0].heading);
});

test('pause freezes race time, countdown, racers, pickups, and projectile lifetimes', () => {
  const sim = running();
  advance(sim, 1, { throttle: true });
  sim.state.projectiles.push({ id: 99, type: 'mine', owner: 0, distance: 500, lateral: 4, lifetime: 10, powered: false, target: null });
  sim.pause();
  const snapshot = JSON.stringify({ ...sim.state, events: [] });
  sim.update(4, input({ throttle: true, useItem: true }));
  assert.equal(JSON.stringify(sim.state), snapshot);
  sim.resume();
  assert.equal(sim.state.phase, 'racing');
  sim.update(0.1, input());
  assert.ok(sim.state.time > 1);
  sim.start(); sim.update(0.4, input()); sim.pause(); sim.update(2, input());
  assert.equal(sim.state.countdown, 2.6);
  sim.resume();
  assert.equal(sim.state.phase, 'countdown');
});

test('pickups are collected by proximity, respect inventory, and respawn after cooldown', () => {
  const sim = running(); clearTraffic(sim);
  const player = sim.state.racers[0], pickup = sim.state.pickups[1];
  assert.equal(sim.state.pickups.length, 18);
  player.distance = pickup.distance;
  player.lateral = pickup.lateral;
  pickup.cooldown = 0;
  sim.update(1 / 60, input());
  assert.equal(player.item, pickup.type);
  assert.ok(pickup.cooldown > 7);
  assert.ok(sim.state.events.some(event => event.type === 'pickup' && event.racer === 0));
  pickup.cooldown = 0.1;
  advance(sim, 0.3);
  assert.equal(pickup.cooldown, 0);
  assert.equal(player.item, pickup.type);
});

test('rocket hits an opponent and gives temporary protection against chain hits', () => {
  const sim = running(); clearTraffic(sim);
  const player = sim.state.racers[0], opponent = sim.state.racers[1];
  player.distance = 40; player.lateral = 0; player.item = 'rocket';
  opponent.distance = 63; opponent.lateral = 0; opponent.speed = 30;
  sim.update(0.2, input({ useItem: true }));
  assert.equal(player.item, null);
  assert.equal(sim.state.hits, 1);
  assert.ok(opponent.hitTime > 0 && opponent.invulnerable > 0);
  assert.ok(sim.state.events.some(event => event.type === 'hit' && event.racer === 1));
  sim.state.projectiles.push({ id: 99, type: 'mine', owner: 0, distance: opponent.distance,
    lateral: opponent.lateral, lifetime: 10, powered: true, target: null });
  sim.update(1 / 90, input());
  assert.equal(sim.state.hits, 1);
});

test('shield consumes an incoming rocket without damage, and item activation is edge-triggered', () => {
  const sim = running(); clearTraffic(sim);
  const player = sim.state.racers[0];
  player.distance = 200; player.speed = 35; player.item = 'shield';
  sim.update(1 / 90, input({ useItem: true }));
  assert.ok(player.shield > 5);
  const beforeHit = player.speed;
  sim.state.projectiles.push({ id: 77, type: 'rocket', owner: 1, distance: player.distance - 1.5,
    lateral: player.lateral, lifetime: 10, powered: false, target: 0 });
  sim.update(1 / 90, input({ useItem: true }));
  assert.equal(player.shield, 0);
  assert.equal(player.hitTime, 0);
  assert.ok(player.speed > beforeHit - 1);
  assert.ok(sim.state.events.some(event => event.type === 'shield' && event.text === 'BLOCKED!'));
  player.item = 'nitro';
  sim.update(1 / 90, input({ useItem: true }));
  assert.equal(player.item, 'nitro');
  sim.update(1 / 90, input());
  sim.update(1 / 90, input({ useItem: true }));
  assert.equal(player.item, null);
  assert.ok(player.boostTime > 1.7);
});

test('drift builds item charge and energy, powered nitro lasts longer', () => {
  const sim = running(); clearTraffic(sim);
  const player = sim.state.racers[0];
  player.item = 'nitro'; player.speed = 35; player.energy = 20;
  advance(sim, 0.8, { throttle: true, steer: 0.2, drift: true });
  assert.ok(player.charge > 0.3);
  assert.ok(player.energy > 25);
  sim.update(1 / 60, input({ throttle: true }));
  assert.equal(sim.state.drifts, 1);
  player.charge = 1;
  sim.update(1 / 90, input({ useItem: true }));
  assert.ok(player.boostTime > 3.1);
  assert.equal(player.charge, 0);
});

test('energy boost consumes a finite resource and cannot permanently accelerate', () => {
  const sim = running(); clearTraffic(sim);
  const player = sim.state.racers[0]; player.speed = 40; player.energy = 30;
  advance(sim, 0.3, { throttle: true, boost: true });
  assert.ok(player.energy < 22);
  assert.ok(player.speed > 49);
  player.energy = 0;
  advance(sim, 0.2, { throttle: true, boost: true });
  assert.ok(player.energy >= 0 && player.energy <= 1);
});

test('the slower tune cruises near 207 km/h, preserves a useful boost, and enforces its hard cap', () => {
  const sim = running(); clearTraffic(sim);
  const player = sim.state.racers[0];
  // A fixed, empty piece of road isolates motor tuning from curvature and weapons.
  for (let frame = 0; frame < 240; frame++) {
    player.distance = 25; player.lateral = 0; player.heading = 0;
    sim.update(1 / 60, input({ throttle: true }));
  }
  assert.ok(player.speed > 57 && player.speed < 58);
  player.energy = 100;
  for (let frame = 0; frame < 120; frame++) {
    player.distance = 25; player.lateral = 0; player.heading = 0;
    sim.update(1 / 60, input({ throttle: true, boost: true }));
    assert.ok(player.speed <= 84);
  }
  assert.ok(player.speed > 78);
  assert.ok(player.energy < 41);
  player.speed = 100;
  sim.update(1 / 90, input({ throttle: true }));
  assert.equal(player.speed, 84);
});

test('the charge threshold consistently activates powered items at 99 percent', () => {
  for (const charge of [0.989, 0.99, 0.995, 1]) {
    const sim = running(); clearTraffic(sim);
    const player = sim.state.racers[0];
    player.item = 'shield'; player.charge = charge;
    sim.update(1 / 90, input({ useItem: true }));
    assert.ok(Math.abs(player.shield - ((charge >= 0.99 ? 8.5 : 5.3) - 1 / 90)) < 1e-8);
  }
});

test('multiple seeded races remain controllable at the slower pace with nearby AI competitors', () => {
  for (const seed of [11, 42, 7431]) {
    const sim = running(seed);
    let resets = 0;
    for (let frame = 0; frame < 60 * 110 && sim.state.phase === 'racing'; frame++) {
      const player = sim.state.racers[0];
      const curve = sampleTrack(player.distance + 3).curvature;
      const steer = Math.max(-1, Math.min(1,
        -curve * player.speed * 0.88 / 1.45 - player.lateral * 0.075 + player.heading * 1.3));
      sim.update(1 / 60, input({ throttle: true, steer }));
      resets += sim.state.events.filter(event => event.type === 'reset').length;
    }
    assert.equal(sim.state.phase, 'finished');
    assert.ok(sim.state.time > 76 && sim.state.time < 100);
    assert.equal(resets, 0);
    assert.ok(sim.state.racers[0].rank <= 3);
    const closestOpponent = Math.max(...sim.state.racers.slice(1).map(racer => racer.distance));
    assert.ok(TRACK_LENGTH * 3 - closestOpponent < 400);
  }
});

test('laps, timing, finish order, and the completed result remain stable', () => {
  const sim = running(); clearTraffic(sim);
  const player = sim.state.racers[0];
  player.distance = TRACK_LENGTH - 0.1; player.speed = 40;
  sim.state.time = 25;
  sim.update(1 / 60, input({ throttle: true }));
  assert.equal(player.lap, 2);
  assert.ok(sim.state.bestLap > 25);
  assert.ok(sim.state.lastLapTime > 25);
  player.distance = TRACK_LENGTH * 2 - 0.1; player.speed = 40;
  sim.state.time = 50;
  sim.update(1 / 60, input({ throttle: true }));
  assert.equal(player.lap, 3);
  player.distance = TRACK_LENGTH * 3 - 0.1; player.speed = 40;
  sim.state.time = 75;
  sim.update(1 / 60, input({ throttle: true }));
  assert.equal(sim.state.phase, 'finished');
  assert.ok(player.finished);
  assert.equal(player.rank, 1);
  assert.equal(player.lap, 3);
  assert.equal(player.distance, TRACK_LENGTH * 3);
  assert.ok(sim.state.events.some(event => event.type === 'finish'));
  const finishTime = player.finishTime;
  const ranks = sim.state.racers.map(racer => racer.rank);
  sim.update(2, input({ throttle: true }));
  assert.equal(player.finishTime, finishTime);
  assert.deepEqual(sim.state.racers.map(racer => racer.rank), ranks);
});

test('manual and automatic resets preserve progress; menu resets all race statistics', () => {
  const sim = running(); clearTraffic(sim);
  const player = sim.state.racers[0];
  player.distance = 340; player.lateral = 21; player.heading = 0.7; player.speed = 60;
  sim.resetPlayer();
  assert.equal(player.distance, 340);
  assert.equal(player.lateral, 0);
  assert.equal(player.heading, 0);
  assert.equal(player.speed, 16);
  assert.ok(player.invulnerable > 0);
  player.lateral = 26;
  sim.update(1 / 90, input());
  assert.equal(player.lateral, 0);
  assert.ok(sim.state.events.some(event => event.type === 'reset'));
  sim.returnToMenu();
  assert.equal(sim.state.phase, 'menu');
  assert.equal(sim.state.racers[0].distance, 0);
  assert.equal(sim.state.time, 0);
});

test('AI advances, uses the track lanes, and seeded long runs retain finite bounds', () => {
  const sim = running(123);
  advance(sim, 8);
  assert.ok(sim.state.racers.slice(1).every(racer => racer.distance > 200));
  assert.ok(sim.state.racers.slice(1).some(racer => racer.item !== null || racer.boostTime > 0));
  let usedWeapons = false;
  for (let frame = 0; frame < 60 * 160; frame++) {
    sim.update(1 / 60, input({ throttle: true, steer: Math.sin(frame * 0.003) * 0.25,
      drift: frame % 180 < 60, boost: frame % 400 < 60, useItem: frame % 90 === 0 }));
    usedWeapons ||= sim.state.events.some(event => ![0].includes(event.racer) && ['fire', 'shield', 'boost'].includes(event.type));
    for (const racer of sim.state.racers) {
      assert.ok([racer.distance, racer.lateral, racer.heading, racer.speed, racer.energy, racer.charge].every(Number.isFinite));
      assert.ok(racer.speed >= -8 && racer.speed <= 84);
      assert.ok(Math.abs(racer.lateral) <= 27);
      assert.ok(racer.energy >= 0 && racer.energy <= 100);
      assert.ok(racer.charge >= 0 && racer.charge <= 1);
      assert.ok(racer.lap >= 1 && racer.lap <= 3);
    }
    assert.equal(new Set(sim.state.racers.map(racer => racer.rank)).size, 6);
  }
  assert.ok(usedWeapons);
  assert.ok(sim.state.racers.slice(1).every(racer => racer.finished));
});

test('invalid time does not poison state and separate simulations reproduce the same race', () => {
  const first = running(99), second = running(99);
  advance(first, 5, { throttle: true }); advance(second, 5, { throttle: true });
  assert.deepEqual(first.state, second.state);
  const distance = first.state.racers[0].distance;
  first.update(Number.NaN, input({ throttle: true }));
  first.update(Number.POSITIVE_INFINITY, input({ throttle: true }));
  assert.equal(first.state.racers[0].distance, distance);
});
