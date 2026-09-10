import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoxVolume, intersectVolumes, racerVolume, type StaticCollider } from '../src/collision';
import { DEFAULT_DIFFICULTY, DIFFICULTIES, DIFFICULTY_ORDER, isDifficulty } from '../src/difficulty';
import { RaceSimulation } from '../src/simulation';
import { sampleTrack, TRACK_LENGTH, wrapDistance } from '../src/track';
import { EMPTY_INPUT, type Difficulty, type InputState } from '../src/types';

const controls = (changes: Partial<InputState> = {}): InputState => ({ ...EMPTY_INPUT, ...changes });
const near = (actual: number, expected: number, epsilon = 1e-7) =>
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);

function running(difficulty: Difficulty, seed = 42) {
  const simulation = new RaceSimulation(seed, difficulty);
  simulation.start();
  simulation.update(3, EMPTY_INPUT);
  return simulation;
}

function isolatePlayer(simulation: RaceSimulation) {
  for (const racer of simulation.state.racers.slice(1)) {
    racer.finished = true;
    racer.distance = 400 + racer.id * 80;
    racer.speed = 0;
  }
  for (const pickup of simulation.state.pickups) pickup.cooldown = 1000;
  Object.assign(simulation.state.racers[0], { distance: 25, lateral: 0, heading: 0, speed: 0 });
}

function assertFinite(simulation: RaceSimulation) {
  for (const racer of simulation.state.racers) {
    assert.ok([racer.distance, racer.lateral, racer.heading, racer.speed, racer.energy,
      racer.charge, racer.invulnerable, racer.shield, racer.boostTime].every(Number.isFinite));
    assert.ok(racer.speed >= -8 && racer.speed <= 84);
    assert.ok(racer.energy >= 0 && racer.energy <= 100);
    assert.ok(racer.charge >= 0 && racer.charge <= 1);
    assert.ok(racer.shield >= 0 && racer.shield <= 8.5);
    assert.ok(racer.invulnerable >= 0 && racer.invulnerable <= 1.65);
    assert.ok(racer.lap >= 1 && racer.lap <= 3);
  }
  assert.equal(new Set(simulation.state.racers.map(racer => racer.rank)).size, 6);
  assert.ok(simulation.state.projectiles.length <= 80);
  assert.ok(simulation.state.projectiles.every(projectile =>
    [projectile.distance, projectile.lateral, projectile.lifetime].every(Number.isFinite)));
}

/** A road-following controller, optionally adding real pickups, drift and resource-limited boost. */
function driveRace(seed: number, difficulty: Difficulty, advanced = false) {
  const simulation = running(difficulty, seed);
  const pickups = Array<number>(6).fill(0);
  const consumed = Array<number>(6).fill(0);
  let resets = 0, boostedSeconds = 0;
  for (let frame = 0; frame < 60 * 150 && simulation.state.phase === 'racing'; frame++) {
    const player = simulation.state.racers[0];
    const curve = sampleTrack(player.distance + 3).curvature;
    let lane = 0;
    if (advanced) {
      const next = simulation.state.pickups
        .filter(pickup => pickup.cooldown <= 0 && wrapDistance(pickup.distance - player.distance) < 110)
        .sort((a, b) => (a.type === 'nitro' ? -80 : 0) - (b.type === 'nitro' ? -80 : 0)
          + wrapDistance(a.distance - player.distance) - wrapDistance(b.distance - player.distance))[0];
      if (next) lane = next.lateral;
    }
    const drift = advanced && Math.abs(curve) > 0.004 && Math.abs(curve) < 0.022 && player.speed > 30;
    const steer = Math.max(-1, Math.min(1,
      -curve * player.speed * 0.88 / (drift ? 1.35 : 1.45)
      - (player.lateral - lane) * 0.075 + player.heading * (drift ? 0.7 : 1.3)));
    const boost = advanced && Math.abs(curve) < 0.017 && player.energy > 4 && player.boostTime < 0.03;
    const useItem = advanced && frame % 12 === 0 && !!player.item &&
      (player.item !== 'nitro' || (player.boostTime < 0.15 && Math.abs(curve) < 0.017));
    simulation.update(1 / 60, controls({ throttle: true, steer, drift, boost, useItem }));
    if (player.boostTime > 0) boostedSeconds += 1 / 60;
    for (const event of simulation.state.events) {
      if (event.type === 'pickup') pickups[event.racer]++;
      if (event.item && (event.type === 'fire' || event.type === 'boost' ||
        (event.type === 'shield' && event.text !== 'BLOCKED!'))) consumed[event.racer]++;
      if (event.type === 'reset' && event.racer === 0) resets++;
    }
    for (let id = 0; id < 6; id++) {
      assert.ok(consumed[id] <= pickups[id], `racer ${id} must collect every consumable it uses`);
    }
    assertFinite(simulation);
  }
  return { simulation, pickups, consumed, resets, boostedSeconds };
}

test('difficulty metadata exposes three validated, immutable and genuinely different tiers', () => {
  assert.equal(DEFAULT_DIFFICULTY, 'easy');
  assert.deepEqual(DIFFICULTY_ORDER, ['easy', 'hard', 'hell']);
  assert.deepEqual(DIFFICULTY_ORDER.map(tier => DIFFICULTIES[tier].label), ['简单', '困难', '地狱']);
  assert.deepEqual(DIFFICULTY_ORDER.map(tier => DIFFICULTIES[tier].subtitle), ['熟悉赛道', '认真跑线', '寸步不让']);
  assert.ok(Object.isFrozen(DIFFICULTIES));
  for (const tier of DIFFICULTY_ORDER) {
    assert.ok(isDifficulty(tier));
    const config = DIFFICULTIES[tier];
    assert.ok(Object.isFrozen(config));
    assert.ok(config.description.length > 8);
    assert.match(config.color, /^#[0-9a-f]{6}$/i);
    assert.ok(config.playerHitProtection >= 1.2, 'even hell retains a meaningful anti-chain-hit window');
  }
  for (const invalid of [undefined, null, '', 'normal', 'HELL', '__proto__', 1, {}, [], true]) {
    assert.equal(isDifficulty(invalid), false);
  }
  assert.ok(DIFFICULTIES.easy.aiBaseSpeed < DIFFICULTIES.hard.aiBaseSpeed);
  assert.ok(DIFFICULTIES.hard.aiBaseSpeed < DIFFICULTIES.hell.aiBaseSpeed);
});

test('constructor and start handle invalid runtime values without installing an invalid tier', () => {
  assert.equal(new RaceSimulation().state.difficulty, 'easy');
  for (const invalid of [undefined, null, 'invalid', '__proto__', 4, {}]) {
    const simulation = new RaceSimulation(42, invalid as Difficulty);
    assert.equal(simulation.state.difficulty, 'easy');
  }
  const simulation = new RaceSimulation(42, 'hard');
  const before = simulation.state;
  assert.equal(simulation.setDifficulty('invalid' as Difficulty), false);
  assert.equal(simulation.state, before);
  simulation.start('invalid' as Difficulty);
  assert.equal(simulation.state.difficulty, 'hard', 'invalid optional overrides retain the last valid selection');
  assert.equal(simulation.state.phase, 'countdown');
});

test('difficulty changes only in the menu and remains locked during every race phase', () => {
  const simulation = new RaceSimulation(42);
  const menu = simulation.state;
  assert.equal(simulation.setDifficulty('hell'), true);
  assert.notEqual(simulation.state, menu);
  assert.equal(simulation.state.phase, 'menu');
  assert.equal(simulation.state.difficulty, 'hell');
  simulation.start();
  for (const phase of ['countdown', 'racing', 'paused', 'finished'] as const) {
    if (phase === 'racing') simulation.update(3, EMPTY_INPUT);
    if (phase === 'paused') simulation.pause();
    if (phase === 'finished') {
      simulation.resume();
      const player = simulation.state.racers[0];
      player.distance = TRACK_LENGTH * 3 - 0.1;
      player.speed = 40;
      simulation.update(1 / 60, EMPTY_INPUT);
    }
    assert.equal(simulation.state.phase, phase);
    const state = simulation.state;
    assert.equal(simulation.setDifficulty('easy'), false, `${phase} must not permit mid-race difficulty changes`);
    assert.equal(simulation.state, state);
    assert.equal(simulation.state.difficulty, 'hell');
  }
});

test('restart, pause/restart and returning through the menu preserve the selection and reset the race', () => {
  const simulation = running('hard');
  simulation.update(1, controls({ throttle: true }));
  simulation.pause();
  simulation.start();
  assert.equal(simulation.state.difficulty, 'hard');
  assert.equal(simulation.state.phase, 'countdown');
  assert.equal(simulation.state.time, 0);
  assert.equal(simulation.state.racers[0].distance, 0);
  simulation.returnToMenu();
  assert.equal(simulation.state.difficulty, 'hard');
  assert.equal(simulation.setDifficulty('hell'), true);
  simulation.start();
  assert.equal(simulation.state.difficulty, 'hell');
  simulation.start('easy');
  assert.equal(simulation.state.difficulty, 'easy', 'an explicit new race may select a different valid tier');
  simulation.returnToMenu();
  assert.equal(simulation.state.difficulty, 'easy');
});

test('menu difficulty changes and new races preserve the existing solid collision world', () => {
  const track = sampleTrack(45);
  const wall: StaticCollider = { id: 'difficulty-wall', kind: 'barrier',
    ...createBoxVolume(track.x, track.y + 1.5, track.z, 20, 1.5, 0.08, track.heading) };
  const simulation = new RaceSimulation(42);
  simulation.setStaticColliders([wall]);
  for (const tier of DIFFICULTY_ORDER) {
    simulation.returnToMenu();
    assert.equal(simulation.setDifficulty(tier), true);
    simulation.start(); simulation.update(3, EMPTY_INPUT);
    isolatePlayer(simulation);
    const player = simulation.state.racers[0];
    player.speed = 84;
    simulation.update(0.5, controls({ throttle: true, boost: true }));
    assert.ok(player.distance > 25 && player.distance < 43);
    assert.ok((intersectVolumes(racerVolume(player), wall)?.depth ?? 0) < 0.04);
    assert.ok(simulation.state.events.some(event => event.type === 'collision' && event.collisionKind === 'barrier'));
  }
});

test('player steering, motor performance and boost consumption are identical on every tier', () => {
  const snapshots = DIFFICULTY_ORDER.map(tier => {
    const simulation = running(tier); isolatePlayer(simulation);
    const player = simulation.state.racers[0];
    for (let frame = 0; frame < 90; frame++) {
      simulation.update(1 / 60, controls({ throttle: true, steer: 0.06 }));
    }
    return [player.distance, player.lateral, player.heading, player.speed];
  });
  assert.deepEqual(snapshots[1], snapshots[0]);
  assert.deepEqual(snapshots[2], snapshots[0]);
  for (const tier of DIFFICULTY_ORDER) {
    const simulation = running(tier); isolatePlayer(simulation);
    const player = simulation.state.racers[0];
    player.speed = 30; player.energy = 70;
    simulation.update(0.5, controls({ throttle: true, boost: true }));
    near(player.energy, 55);
    near(player.speed, 49);
  }
});

test('harder tiers actually reduce player passive fuel regeneration and off-road speed', () => {
  const offRoadSpeeds: number[] = [];
  for (const tier of DIFFICULTY_ORDER) {
    const simulation = running(tier); isolatePlayer(simulation);
    const player = simulation.state.racers[0];
    player.energy = 10;
    simulation.update(1, EMPTY_INPUT);
    near(player.energy, 10 + DIFFICULTIES[tier].playerIdleEnergyRegen);
    player.speed = 20; player.energy = 10;
    simulation.update(0.5, EMPTY_INPUT);
    near(player.energy, 10 + DIFFICULTIES[tier].playerMovingEnergyRegen * 0.5);
    Object.assign(player, { distance: 25, lateral: 12, heading: 0, speed: 50 });
    simulation.update(0.5, controls({ throttle: true }));
    offRoadSpeeds.push(player.speed);
  }
  assert.ok(offRoadSpeeds[0] > offRoadSpeeds[1] + 1);
  assert.ok(offRoadSpeeds[1] > offRoadSpeeds[2] + 1);
});

test('difficulty changes hit recovery without removing shield, reset, or anti-chain-hit protection', () => {
  for (const tier of DIFFICULTY_ORDER) {
    const simulation = running(tier); isolatePlayer(simulation);
    const player = simulation.state.racers[0]; player.speed = 35;
    const addMine = (id: number) => simulation.state.projectiles.push({ id, type: 'mine', owner: 1,
      distance: player.distance, lateral: player.lateral, lifetime: 10, powered: false, target: null });
    addMine(1);
    simulation.update(1 / 90, EMPTY_INPUT);
    near(player.invulnerable, DIFFICULTIES[tier].playerHitProtection);
    assert.ok(simulation.state.events.some(event => event.type === 'hit' && event.racer === 0));
    addMine(2);
    simulation.update(1 / 90, EMPTY_INPUT);
    assert.ok(!simulation.state.events.some(event => event.type === 'hit'));
    simulation.resetPlayer();
    assert.ok(player.invulnerable >= 1.3);
    assert.equal(player.lateral, 0);

    player.invulnerable = 0; player.item = 'shield';
    simulation.update(1 / 90, controls({ useItem: true }));
    assert.ok(player.shield > 5);
    addMine(3);
    simulation.update(1 / 90, EMPTY_INPUT);
    assert.equal(player.shield, 0);
    assert.equal(player.hitTime, 0);
    assert.ok(player.invulnerable >= 0.89);
    assert.ok(simulation.state.events.some(event => event.type === 'shield' && event.text === 'BLOCKED!'));
  }
});

test('AI strength separates across seeds through actual pace and earlier finite-resource boost use', () => {
  for (const seed of [11, 42, 7431]) {
    const results = DIFFICULTY_ORDER.map(tier => {
      const simulation = running(tier, seed);
      let progressAtThirty = 0, earlyBoostSeconds = 0;
      for (let frame = 0; frame < 60 * 130 && !simulation.state.racers.slice(1).every(racer => racer.finished); frame++) {
        simulation.update(1 / 60, EMPTY_INPUT);
        if (frame < 180) earlyBoostSeconds += simulation.state.racers.slice(1).filter(racer => racer.boostTime > 0).length / 60;
        if (frame === 1799) progressAtThirty = simulation.state.racers.slice(1).reduce((sum, racer) => sum + racer.distance, 0) / 5;
        assertFinite(simulation);
      }
      assert.ok(simulation.state.racers.slice(1).every(racer => racer.finished));
      const times = simulation.state.racers.slice(1).map(racer => racer.finishTime).sort((a, b) => a - b);
      return { progressAtThirty, earlyBoostSeconds, median: times[2] };
    });
    assert.ok(results[1].progressAtThirty > results[0].progressAtThirty + 100);
    assert.ok(results[2].progressAtThirty > results[1].progressAtThirty + 60);
    assert.ok(results[0].median > results[1].median + 3);
    assert.ok(results[1].median > results[2].median + 2);
    assert.ok(results[1].earlyBoostSeconds > results[0].earlyBoostSeconds + 3);
    assert.ok(results[2].earlyBoostSeconds > results[1].earlyBoostSeconds + 1);
  }
});

test('the same clean-driving baseline completes every tier but no longer wins hard or hell', () => {
  for (const seed of [11, 42, 7431]) {
    const ranks = DIFFICULTY_ORDER.map(tier => {
      const { simulation, resets } = driveRace(seed, tier);
      assert.equal(simulation.state.phase, 'finished');
      assert.equal(simulation.state.difficulty, tier);
      assert.ok(simulation.state.time > 70 && simulation.state.time < 105);
      assert.equal(resets, 0);
      assert.ok(simulation.state.bestLap > 0);
      assert.equal(simulation.state.racers[0].lap, 3);
      const ranks = simulation.state.racers.map(racer => racer.rank);
      const time = simulation.state.time;
      simulation.update(2, controls({ throttle: true, boost: true }));
      assert.equal(simulation.state.time, time);
      assert.deepEqual(simulation.state.racers.map(racer => racer.rank), ranks);
      return simulation.state.racers[0].rank;
    });
    assert.ok(ranks[0] <= 2);
    assert.ok(ranks[1] >= 3);
    assert.ok(ranks[2] >= 5);
  }
});

test('hell is winnable with genuine pickups, drift and managed boost, including the default seed', () => {
  for (const seed of [123, 7431]) {
    const { simulation, pickups, consumed, resets, boostedSeconds } = driveRace(seed, 'hell', true);
    assert.equal(simulation.state.phase, 'finished');
    assert.equal(simulation.state.racers[0].rank, 1);
    assert.equal(resets, 0);
    assert.ok(simulation.state.drifts > 10);
    assert.ok(pickups[0] > 8 && consumed[0] > 8);
    assert.ok(boostedSeconds > 20);
    assert.ok(simulation.state.time < 75);
  }
});
