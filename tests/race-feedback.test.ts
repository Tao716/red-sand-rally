import assert from 'node:assert/strict';
import test from 'node:test';
import { getDriftFeedback, getIncomingThreat, getRocketTarget } from '../src/race-feedback';
import { RaceSimulation } from '../src/simulation';
import { TRACK_LENGTH } from '../src/track';
import { EMPTY_INPUT, type Projectile, type Racer, type RaceState } from '../src/types';

const running = () => {
  const sim = new RaceSimulation(42);
  sim.start(); sim.update(3);
  sim.state.racers.slice(1).forEach((racer, index) => {
    racer.distance = 700 + index * 100;
    racer.lateral = -5;
  });
  sim.state.pickups.forEach(pickup => { pickup.cooldown = 100; });
  Object.assign(sim.state.racers[0], { distance: 300, speed: 50, lateral: 0, heading: 0 });
  return sim;
};
const rocket = (changes: Partial<Projectile> = {}): Projectile => ({
  id: 77, type: 'rocket', owner: 1, distance: 225, lateral: 0,
  lifetime: 3.8, powered: false, target: 0, ...changes,
});
const closeTo = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8,
  `expected ${actual} to equal ${expected}`);

test('empty inventory drift progress uses drift time and still announces a release boost', () => {
  const player = running().state.racers[0];
  player.driftTime = 0.25;
  assert.deepEqual(getDriftFeedback(player), { active: true, ready: false, progress: 0.5, charge: null, charged: false });
  player.driftTime = 0.7;
  assert.deepEqual(getDriftFeedback(player), { active: true, ready: true, progress: 1, charge: null, charged: false });
});

test('drift thresholds exactly match the simulation and progress stays normalized', () => {
  const player = running().state.racers[0];
  for (const [time, active, ready, progress] of [
    [-1, false, false, 0], [0, false, false, 0], [0.099, false, false, 0.198],
    [0.1, true, false, 0.2], [0.5, true, false, 1], [0.501, true, true, 1], [6, true, true, 1],
  ] as const) {
    player.driftTime = time;
    const feedback = getDriftFeedback(player);
    assert.equal(feedback.active, active); assert.equal(feedback.ready, ready); closeTo(feedback.progress, progress);
  }
});

test('item upgrade charge never replaces mini-boost progress and persists outside a drift', () => {
  const player = running().state.racers[0];
  player.item = 'rocket'; player.charge = 0.99; player.driftTime = 0.2;
  assert.deepEqual(getDriftFeedback(player), { active: true, ready: false, progress: 0.4, charge: 0.99, charged: true });
  player.driftTime = 0;
  assert.deepEqual(getDriftFeedback(player), { active: false, ready: false, progress: 0, charge: 0.99, charged: true });
  for (const charge of [-1, 0.989, 0.99, 2]) {
    player.charge = charge;
    assert.equal(getDriftFeedback(player).charge, Math.max(0, Math.min(1, charge)));
    assert.equal(getDriftFeedback(player).charged, charge >= 0.99);
  }
  player.item = null;
  assert.equal(getDriftFeedback(player).charge, null);
  assert.equal(getDriftFeedback(player).charged, false);
});

test('drift feedback resets after release, a hit, and starting another race', () => {
  const sim = running(), player = sim.state.racers[0];
  player.driftTime = 0.7;
  sim.update(1 / 90, { ...EMPTY_INPUT, throttle: true });
  assert.equal(getDriftFeedback(player).active, false);
  assert.equal(getDriftFeedback(player).progress, 0);
  assert.ok(sim.state.events.some(event => event.type === 'drift'));
  player.driftTime = 0.7;
  sim.state.projectiles = [rocket({ distance: player.distance - 1 })];
  sim.update(1 / 90, { ...EMPTY_INPUT, throttle: true, steer: 0.1, drift: true });
  assert.equal(getDriftFeedback(player).progress, 0);
  assert.ok(player.hitTime > 0);
  sim.start();
  assert.equal(getDriftFeedback(sim.state.racers[0]).progress, 0);
});

test('rocket target mirrors nearest forward selection rather than race rank or lane', () => {
  const state = running().state, player = state.racers[0];
  player.item = 'rocket';
  Object.assign(state.racers[1], { distance: 460, lateral: 0, rank: 1 });
  Object.assign(state.racers[2], { distance: 340, lateral: 15, rank: 4 });
  state.racers[3].distance = 350;
  assert.deepEqual(getRocketTarget(state), { racerId: 2, name: 'KIRA', distance: 40 });
  state.racers[2].finished = true;
  assert.deepEqual(getRocketTarget(state), { racerId: 3, name: 'GHOST', distance: 50 });
});

test('rocket target has an exclusive 220 metre range and retains first-match ties including zero gap', () => {
  const state = running().state;
  state.racers[0].item = 'rocket';
  state.racers[1].distance = 520;
  assert.equal(getRocketTarget(state), null);
  state.racers[1].distance = 519.99;
  assert.equal(getRocketTarget(state)?.racerId, 1);
  state.racers[1].distance = 300; state.racers[2].distance = 300;
  assert.deepEqual(getRocketTarget(state), { racerId: 1, name: 'VEX', distance: 0 });
});

test('rocket target wraps the lap line and ignores an adjacent opponent behind the player', () => {
  const state = running().state;
  const player = state.racers[0];
  player.item = 'rocket'; player.distance = TRACK_LENGTH - 10;
  state.racers[1].distance = 10;
  state.racers[2].distance = player.distance - 2;
  assert.equal(getRocketTarget(state)?.racerId, 1);
  closeTo(getRocketTarget(state)!.distance, 20);
  player.distance += TRACK_LENGTH;
  closeTo(getRocketTarget(state)!.distance, 20);
});

test('rocket target identifies player and opponents by id, never array index', () => {
  const state = running().state;
  const player = state.racers[0];
  player.id = 90; player.item = 'rocket';
  state.racers[2].id = 41; state.racers[2].distance = 350;
  state.racers.reverse();
  assert.deepEqual(getRocketTarget(state), { racerId: 41, name: 'KIRA', distance: 50 });
});

test('rocket target clears when inventory, phase, player existence, or finish status changes', () => {
  const state = running().state, player = state.racers[0];
  state.racers[1].distance = 350;
  for (const item of [null, 'shield', 'mine', 'nitro'] as const) {
    player.item = item; assert.equal(getRocketTarget(state), null);
  }
  player.item = 'rocket';
  for (const phase of ['menu', 'countdown', 'paused', 'finished'] as const) {
    state.phase = phase; assert.equal(getRocketTarget(state), null);
  }
  state.phase = 'racing'; player.finished = true;
  assert.equal(getRocketTarget(state), null);
  state.racers = state.racers.filter(racer => !racer.isPlayer);
  assert.equal(getRocketTarget(state), null);
});

test('an approaching locked rocket gives speed-adjusted ETA and an urgency threshold', () => {
  const state = running().state;
  state.projectiles = [rocket()];
  assert.deepEqual(getIncomingThreat(state), { projectileId: 77, direction: 'rear', distance: 75, eta: 1, urgent: false });
  state.projectiles[0].distance = 247.5;
  closeTo(getIncomingThreat(state)!.eta, 0.7);
  assert.equal(getIncomingThreat(state)?.urgent, true);
  state.projectiles[0].powered = true;
  closeTo(getIncomingThreat(state)!.eta, 52.5 / 98);
});

test('threat directions follow negative-left and positive-right road lateral offsets', () => {
  const state = running().state;
  for (const [lateral, direction] of [[-9, 'left'], [-3, 'rear'], [3, 'rear'], [9, 'right']] as const) {
    state.projectiles = [rocket({ lateral })];
    assert.equal(getIncomingThreat(state)?.direction, direction);
  }
});

test('incoming rocket separation wraps independently of lap count in both directions', () => {
  const state = running().state;
  state.racers[0].distance = 10;
  state.projectiles = [rocket({ distance: TRACK_LENGTH - 20 })];
  closeTo(getIncomingThreat(state)!.distance, 30);
  closeTo(getIncomingThreat(state)!.eta, 0.4);
  state.racers[0].distance += TRACK_LENGTH * 2;
  closeTo(getIncomingThreat(state)!.distance, 30);
  state.racers[0].distance = TRACK_LENGTH - 10;
  state.projectiles[0].distance = 10;
  assert.equal(getIncomingThreat(state), null);
});

test('own rockets, mines and expired projectiles never warn', () => {
  const state = running().state;
  const excluded: Partial<Projectile>[] = [{ owner: 0 }, { type: 'mine' }, { lifetime: 0 }, { lifetime: -1 }];
  for (const changes of excluded) {
    state.projectiles = [rocket(changes)];
    assert.equal(getIncomingThreat(state), null);
  }
});

test('rockets aimed at another racer warn only if their actual pursuit path crosses the player', () => {
  const state = running().state;
  const opponent = state.racers[2];
  Object.assign(opponent, { lateral: 0, heading: 0, speed: 50 });
  state.projectiles = [rocket({ target: opponent.id })];
  assert.equal(getIncomingThreat(state)?.projectileId, 77, 'same-lane crossfire is a real threat');
  opponent.lateral = -8;
  assert.equal(getIncomingThreat(state), null, 'the missile leaves our lane before catching up');
  state.projectiles[0].lateral = -8;
  assert.equal(getIncomingThreat(state), null, 'a separate-lane pursuit stays irrelevant');
  state.projectiles[0].lateral = 13;
  assert.equal(getIncomingThreat(state)?.direction, 'right', 'the rocket crosses our lane while tracking left');
});

test('other-target predictions account for the target moving and its homing turning point', () => {
  const state = running().state;
  const opponent = state.racers[2];
  // The target moves right at 10 m/s. At t=1 the missile meets its lane at
  // lateral 1.5, inside our 1.62 m collision corridor; both window ends miss it.
  Object.assign(opponent, { lateral: -8.5, speed: 50, heading: -Math.asin(0.2) });
  state.projectiles = [rocket({ target: opponent.id, lateral: 14.5 })];
  assert.equal(getIncomingThreat(state)?.projectileId, 77);
  opponent.heading = 0;
  assert.equal(getIncomingThreat(state)?.projectileId, 77, 'stationary pursuit also crosses the corridor');
  opponent.lateral = 8;
  assert.equal(getIncomingThreat(state), null, 'pursuit that remains to our right is not a threat');
});

test('an other-target warning precedes a genuine incidental hit in the simulation', () => {
  const simulation = running();
  const player = simulation.state.racers[0];
  Object.assign(simulation.state.racers[2], { lateral: 0, heading: 0 });
  simulation.state.projectiles = [rocket({ distance: player.distance - 10, target: 2 })];
  assert.equal(getIncomingThreat(simulation.state)?.projectileId, 77);
  let hitPlayer = false;
  for (let step = 0; step < 30 && !hitPlayer; step++) {
    simulation.update(1 / 90, EMPTY_INPUT);
    hitPlayer = simulation.state.events.some(event => event.type === 'hit' && event.racer === player.id);
  }
  assert.ok(hitPlayer, 'the warning must cover the actual collision, not just the declared target');
  assert.ok(player.hitTime > 0);
  assert.equal(getIncomingThreat(simulation.state), null, 'consumed crossfire clears its warning');
});

test('threat horizon, range and lifetime prevent distant or impossible warnings', () => {
  const state = running().state;
  state.projectiles = [rocket({ distance: 149 })]; // 151 m behind, even with enough lifetime.
  assert.equal(getIncomingThreat(state), null);
  state.projectiles = [rocket({ distance: 150 })];
  assert.ok(getIncomingThreat(state));
  state.racers[0].speed = 84;
  assert.equal(getIncomingThreat(state), null); // 150 / 41 exceeds the reaction horizon.
  state.racers[0].speed = 50;
  state.projectiles = [rocket({ lifetime: 0.99 })];
  assert.equal(getIncomingThreat(state), null);
  state.projectiles[0].lifetime = 1;
  assert.equal(getIncomingThreat(state), null); // Lifetime reaches zero before collision processing.
  state.projectiles[0].lifetime = 1.01;
  assert.ok(getIncomingThreat(state));
});

test('rockets already ahead and pulling away do not continue warning even when still locked', () => {
  const state = running().state;
  for (const distance of [300.1, 301, 330]) {
    state.projectiles = [rocket({ distance })];
    assert.equal(getIncomingThreat(state), null);
  }
  state.racers[0].speed = -8;
  assert.equal(getIncomingThreat(state), null);
});

test('relative forward velocity handles braking, reversing and potential front interception', () => {
  const state = running().state;
  state.projectiles = [rocket()];
  state.racers[0].speed = 0;
  closeTo(getIncomingThreat(state)!.eta, 0.6);
  state.racers[0].speed = -8;
  closeTo(getIncomingThreat(state)!.eta, 75 / 133);
  // Supported if a future tuning lets the player catch a forward-moving missile.
  state.racers[0].speed = 145; state.projectiles[0].distance = 310;
  assert.equal(getIncomingThreat(state)?.direction, 'front');
  closeTo(getIncomingThreat(state)!.eta, 0.5);
  state.racers[0].speed = 125;
  assert.equal(getIncomingThreat(state), null);
});

test('unlocked rockets only warn when their flight corridor intersects the player', () => {
  const state = running().state;
  state.projectiles = [rocket({ target: null })];
  assert.ok(getIncomingThreat(state));
  state.projectiles[0].lateral = 5;
  assert.equal(getIncomingThreat(state), null);
  // The car is steering into the projectile lane at interception, not occupying it yet.
  state.racers[0].heading = -0.1;
  const eta = 75 / (125 - 50 * Math.cos(-0.1));
  state.projectiles[0].lateral = 50 * Math.sin(0.1) * eta;
  assert.equal(getIncomingThreat(state)?.direction, 'right');
  closeTo(getIncomingThreat(state)!.eta, eta);
  state.projectiles[0].lateral = 0;
  assert.equal(getIncomingThreat(state), null); // It will cross the vacated lane instead.
});

test('lateral homing limits reject missiles that cannot reach the player lane in time', () => {
  const state = running().state;
  state.projectiles = [rocket({ distance: 292.5, lateral: 9 })];
  assert.equal(getIncomingThreat(state), null);
  state.projectiles[0].distance = 225;
  assert.equal(getIncomingThreat(state)?.direction, 'right');
  state.projectiles[0].lateral = 16;
  assert.equal(getIncomingThreat(state), null);
  state.projectiles[0].powered = true;
  assert.equal(getIncomingThreat(state)?.direction, 'right');
});

test('lateral pursuit follows moving players and does not claim uncatchable turns', () => {
  const state = running().state;
  state.racers[0].heading = -0.2;
  state.projectiles = [rocket()];
  assert.ok(getIncomingThreat(state)); // About 10 m/s laterally is within normal homing speed.
  state.racers[0].heading = -0.6;
  assert.equal(getIncomingThreat(state), null); // About 28 m/s outruns either tracking tune.
  state.projectiles[0].powered = true;
  assert.equal(getIncomingThreat(state), null);
});

test('multiple projectiles select earliest credible impact rather than array order or raw distance', () => {
  const state = running().state;
  state.projectiles = [
    rocket({ id: 2, distance: 225 }),
    rocket({ id: 3, distance: 211.8, powered: true }), // 0.9 s despite being farther away.
    rocket({ id: 4, distance: 280, target: 2 }),
    rocket({ id: 5, distance: 285, lateral: 10, target: null }),
  ];
  assert.equal(getIncomingThreat(state)?.projectileId, 3);
  state.projectiles.reverse();
  assert.equal(getIncomingThreat(state)?.projectileId, 3);
  state.projectiles = [rocket({ id: 9 }), rocket({ id: 2 })];
  assert.equal(getIncomingThreat(state)?.projectileId, 2);
});

test('threat ownership and homing use player id even when racer order and ids differ', () => {
  const state = running().state;
  state.racers[0].id = 40;
  state.racers.reverse();
  state.projectiles = [rocket({ target: 40 })];
  assert.equal(getIncomingThreat(state)?.projectileId, 77);
  state.projectiles[0].owner = 40;
  assert.equal(getIncomingThreat(state), null);
  state.projectiles[0].owner = 1; state.projectiles[0].target = 2;
  assert.equal(getIncomingThreat(state), null);
});

test('shield and temporary invulnerability preserve trajectory warnings without modifying the state', () => {
  const state = running().state, player = state.racers[0];
  state.projectiles = [rocket()];
  for (const protection of [{ shield: 4, invulnerable: 0 }, { shield: 0, invulnerable: 1.5 }]) {
    Object.assign(player, protection);
    const snapshot = JSON.stringify(state);
    assert.ok(getIncomingThreat(state));
    getDriftFeedback(player); getRocketTarget(state);
    assert.equal(JSON.stringify(state), snapshot);
  }
});

test('warning clears while paused, after finish, without a player, and during restart', () => {
  const sim = running();
  sim.state.projectiles = [rocket()];
  assert.ok(getIncomingThreat(sim.state));
  sim.pause(); assert.equal(getIncomingThreat(sim.state), null);
  sim.resume(); assert.ok(getIncomingThreat(sim.state));
  sim.state.racers[0].finished = true;
  assert.equal(getIncomingThreat(sim.state), null);
  sim.state.racers[0].finished = false;
  for (const phase of ['menu', 'countdown', 'finished'] as const) {
    sim.state.phase = phase; assert.equal(getIncomingThreat(sim.state), null);
  }
  sim.state.phase = 'racing';
  const withoutPlayer: RaceState = { ...sim.state, racers: sim.state.racers.filter(racer => !racer.isPlayer) };
  assert.equal(getIncomingThreat(withoutPlayer), null);
  sim.start();
  assert.equal(getIncomingThreat(sim.state), null);
  sim.update(3);
  assert.equal(getIncomingThreat(sim.state), null);
});

test('warning immediately clears when the simulation consumes a missile on hit, shield or invulnerability', () => {
  const protections: Partial<Racer>[] = [{}, { shield: 4 }, { invulnerable: 1.5 }];
  for (const protection of protections) {
    const sim = running(), player = sim.state.racers[0];
    Object.assign(player, protection);
    sim.state.projectiles = [rocket({ distance: player.distance - 1.5 })];
    assert.ok(getIncomingThreat(sim.state));
    sim.update(1 / 90, EMPTY_INPUT);
    assert.equal(sim.state.projectiles.length, 0);
    assert.equal(getIncomingThreat(sim.state), null);
  }
});
