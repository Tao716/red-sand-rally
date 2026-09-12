import assert from 'node:assert/strict';
import test from 'node:test';
import { DIFFICULTY_ORDER } from '../src/difficulty';
import { playerSteeringScale, smoothPlayerSteer } from '../src/driving';
import { RaceSimulation } from '../src/simulation';
import { angleDifference, sampleTrack } from '../src/track';
import { EMPTY_INPUT, type Difficulty, type InputState } from '../src/types';

const controls = (changes: Partial<InputState> = {}): InputState => ({ ...EMPTY_INPUT, ...changes });
const near = (actual: number, expected: number, epsilon = 1e-10) =>
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);

function isolated(speed: number, difficulty: Difficulty = 'easy') {
  const simulation = new RaceSimulation(42, difficulty);
  simulation.start(); simulation.update(3, EMPTY_INPUT);
  for (const racer of simulation.state.racers.slice(1)) {
    racer.finished = true;
    racer.distance = 500 + racer.id * 50;
  }
  for (const pickup of simulation.state.pickups) pickup.cooldown = 1000;
  Object.assign(simulation.state.racers[0], { distance: 25, lateral: 0, heading: 0, speed });
  return simulation;
}

test('steering retains low and medium speed authority, including reverse and drift', () => {
  for (const speed of [-84, -8, 0, 5, 15, 30, 44, 45]) {
    assert.equal(playerSteeringScale(speed, false), 1);
  }
  for (const speed of [24, 45, 52, 64, 72, 84, 100]) {
    assert.equal(playerSteeringScale(speed, true), 1);
  }
  // The press itself still uses the existing 10/s exponential response.
  for (const target of [-1, -0.2, 0.2, 1]) {
    near(smoothPlayerSteer(0, target, 1 / 90), target * (1 - Math.exp(-10 / 90)));
  }
});

test('high-speed steering tapers smoothly to 80 percent without a speed threshold jump', () => {
  assert.equal(playerSteeringScale(45, false), 1);
  near(playerSteeringScale(64.5, false), 0.9);
  near(playerSteeringScale(84, false), 0.8);
  near(playerSteeringScale(100, false), 0.8);
  assert.ok(playerSteeringScale(45.01, false) > 0.99999);
  let previous = 1;
  for (let speed = 45; speed <= 110; speed += 0.1) {
    const scale = playerSteeringScale(speed, false);
    assert.ok(scale <= previous && scale >= 0.8 && scale <= 1);
    previous = scale;
  }
});

test('release and countersteer clear steering memory promptly without overshoot', () => {
  for (const direction of [-1, 1]) {
    const held = smoothPlayerSteer(0, direction, 0.1);
    const released = smoothPlayerSteer(held, 0, 0.15);
    assert.ok(Math.abs(released) < Math.abs(held) * 0.07);
    assert.equal(Math.sign(released), direction);
    const reversed = smoothPlayerSteer(held, -direction, 0.08);
    assert.equal(Math.sign(reversed), -direction);
    assert.ok(Math.abs(reversed) < 1);
  }
  // Exponential smoothing produces the same result across render-frame splits.
  near(smoothPlayerSteer(smoothPlayerSteer(0, 1, 0.04), 1, 0.06), smoothPlayerSteer(0, 1, 0.1));
  near(smoothPlayerSteer(smoothPlayerSteer(0.8, 0, 0.04), 0, 0.06), smoothPlayerSteer(0.8, 0, 0.1));
});

test('short high-speed keyboard corrections reduce yaw and release travel in both directions', () => {
  function tap(direction: number, legacy: boolean) {
    const dt = 1 / 90;
    let steer = 0, heading = 0, lateral = 0, releaseTravel = 0;
    for (let step = 0; step < 45; step++) {
      const input = step < 9 ? direction : 0;
      steer = legacy ? steer + (input - steer) * (1 - Math.exp(-10 * dt))
        : smoothPlayerSteer(steer, input, dt);
      const scale = legacy ? 1 : playerSteeringScale(84, false);
      heading += (-steer * 1.45 * scale - heading * 3.7) * dt;
      const travel = -Math.sin(heading) * 84 * dt;
      lateral += travel;
      if (step >= 9) releaseTravel += travel;
    }
    return { heading, lateral, releaseTravel };
  }
  const right = tap(1, false), left = tap(-1, false);
  near(right.lateral, -left.lateral);
  for (const direction of [-1, 1]) {
    const assisted = tap(direction, false), legacy = tap(direction, true);
    assert.ok(Math.abs(assisted.lateral) < Math.abs(legacy.lateral) * 0.75);
    assert.ok(Math.abs(assisted.releaseTravel) < Math.abs(legacy.releaseTravel) * 0.75);
    assert.ok(Math.abs(assisted.heading) < Math.abs(legacy.heading));
    assert.equal(Math.sign(assisted.lateral), direction);
  }
});

test('actual boosted steering responds correctly left and right and stays on the road after a tap', () => {
  const results = [-1, 0, 1].map(steer => {
    const simulation = isolated(84);
    const player = simulation.state.racers[0];
    simulation.update(0.1, controls({ throttle: true, boost: true, steer }));
    const headingAtRelease = player.heading;
    simulation.update(0.25, controls({ throttle: true, boost: true }));
    assert.ok([player.distance, player.lateral, player.heading, player.speed].every(Number.isFinite));
    assert.ok(Math.abs(player.lateral) < 3);
    assert.ok(!simulation.state.events.some(event => event.type === 'reset'));
    return { lateral: player.lateral, headingAtRelease };
  });
  assert.ok(results[0].lateral < results[1].lateral - 0.3);
  assert.ok(results[2].lateral > results[1].lateral + 0.3);
  assert.ok(results[0].headingAtRelease > results[1].headingAtRelease);
  assert.ok(results[2].headingAtRelease < results[1].headingAtRelease);
});

test('simulation applies the stability assist but keeps the original low-speed and drift turn rates', () => {
  const dt = 1 / 90;
  for (const initialSpeed of [-8, 5, 15, 30, 44, 64, 84]) {
    for (const drift of [false, true]) {
      const simulation = isolated(initialSpeed);
      const player = simulation.state.racers[0];
      simulation.update(dt, controls({ steer: 0.3, drift }));
      const drifting = drift && initialSpeed > 24;
      const baseRate = (drifting ? 1.35 : 1.45) * Math.max(0.15, Math.min(1, Math.abs(player.speed) / 15));
      const assist = drifting || player.speed <= 45 ? 1 : playerSteeringScale(player.speed, false);
      const localHeading = -smoothPlayerSteer(0, 0.3, dt) * baseRate * assist
        * (player.speed < 0 ? -1 : 1) * dt;
      const advance = player.speed * Math.cos(localHeading) * dt;
      const roadTurn = angleDifference(sampleTrack(25 + advance).heading, sampleTrack(25).heading);
      near(player.heading, localHeading - roadTurn * 0.88);
      assert.equal(player.driftTime > 0, drifting);
    }
  }
});

test('all difficulty tiers retain identical high-speed press, release and drift control', () => {
  const snapshots = DIFFICULTY_ORDER.map(difficulty => {
    const simulation = isolated(76, difficulty);
    const player = simulation.state.racers[0];
    const result: number[][] = [];
    for (const changes of [
      { steer: 1, drift: false }, { steer: 0, drift: false },
      { steer: -1, drift: false }, { steer: 0.25, drift: true }, { steer: 0, drift: false },
    ]) {
      simulation.update(0.08, controls({ throttle: true, boost: true, ...changes }));
      result.push([player.distance, player.lateral, player.heading, player.speed]);
    }
    return result;
  });
  assert.deepEqual(snapshots[1], snapshots[0]);
  assert.deepEqual(snapshots[2], snapshots[0]);
});

test('steering helpers stay finite and bounded for invalid controls and long time steps', () => {
  for (const current of [Number.NaN, -Infinity, -5, -1, 0, 1, 5, Infinity]) {
    for (const target of [Number.NaN, -Infinity, -2, -1, 0, 1, 2, Infinity]) {
      for (const dt of [Number.NaN, Infinity, -1, 0, 1 / 120, 1 / 30, 5]) {
        const steer = smoothPlayerSteer(current, target, dt);
        assert.ok(Number.isFinite(steer) && steer >= -1 && steer <= 1);
      }
    }
  }
  for (const speed of [Number.NaN, -Infinity, Infinity]) {
    assert.ok(Number.isFinite(playerSteeringScale(speed, false)));
  }
});
