import { angleDifference, sampleTrack, TRACK_LENGTH, TRACK_WIDTH, wrapDistance } from './track';
import { EMPTY_INPUT, type Difficulty, type InputState, type ItemType, type Racer, type RaceState } from './types';
import { DEFAULT_DIFFICULTY, DIFFICULTIES, isDifficulty } from './difficulty';
import { createBoxVolume, intersectVolumes, racerVolume, StaticCollisionIndex,
  type CollisionContact, type StaticCollider } from './collision';

const STEP = 1 / 90;
const LANES = [-5.4, 0, 5.4];
const ITEMS: ItemType[] = ['rocket', 'nitro', 'shield', 'mine'];
const FINISH_DISTANCE = TRACK_LENGTH * 3;
const PLAYER_BASE_SPEED = 52;
const BOOST_SPEED_GAIN = 20;
const MAX_SPEED = 84;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const approach = (current: number, target: number, rate: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-rate * dt));
/** Signed physical separation on the circuit, independent of race lap. */
const trackGap = (a: number, b: number) => wrapDistance(a - b + TRACK_LENGTH / 2) - TRACK_LENGTH / 2;

interface AiDriver {
  lane: number;
  decision: number;
  itemWait: number;
  boost: number;
  personality: number;
}

/** Rendering-free, seeded arcade racing simulation. Distances and speeds are metres and m/s. */
export class RaceSimulation {
  state: RaceState;
  private readonly seed: number;
  private selectedDifficulty: Difficulty;
  private randomState: number;
  private ai: AiDriver[] = [];
  private offRoad: number[] = [];
  private lapStarted: number[] = [];
  private energyBoosting: boolean[] = [];
  private energyLocked: boolean[] = [];
  private playerSteer = 0;
  private previousUse = false;
  private previousReset = false;
  private nextProjectile = 1;
  private pausedFrom: 'countdown' | 'racing' = 'racing';
  private collisionWorld = new StaticCollisionIndex([]);
  private impactVelocity: { x: number; z: number }[] = [];
  private impactYaw: number[] = [];
  private contactCooldown: number[] = [];

  constructor(seed = 7431, difficulty: Difficulty = DEFAULT_DIFFICULTY) {
    this.seed = seed >>> 0;
    this.selectedDifficulty = isDifficulty(difficulty) ? difficulty : DEFAULT_DIFFICULTY;
    this.randomState = this.seed;
    this.state = this.makeState();
  }

  private random() {
    this.randomState += 0x6d2b79f5;
    let value = this.randomState;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  private makeState(): RaceState {
    this.randomState = this.seed;
    const tuning = DIFFICULTIES[this.selectedDifficulty];
    const names = ['沙暴', 'VEX', 'KIRA', 'GHOST', 'NOVA', 'RIFT'];
    const colors = [0xf16235, 0x9cb473, 0x54d6d0, 0xab89ed, 0xf4cb6b, 0xe8e6df];
    const distances = [0, 7, 15, 23, -7, -15];
    this.ai = names.map((_, id) => ({
      lane: LANES[id % 3], decision: (0.25 + this.random() * 0.5) * tuning.aiDecisionScale,
      itemWait: (1 + this.random() * 2) * tuning.aiItemDelayScale, boost: 0, personality: this.random() * Math.PI * 2,
    }));
    this.offRoad = names.map(() => 0);
    this.lapStarted = names.map(() => 0);
    this.energyBoosting = names.map(() => false);
    this.energyLocked = names.map(() => false);
    this.impactVelocity = names.map(() => ({ x: 0, z: 0 }));
    this.impactYaw = names.map(() => 0);
    this.contactCooldown = names.map(() => 0);
    this.playerSteer = 0;
    this.previousUse = false;
    this.previousReset = false;
    this.nextProjectile = 1;
    const racers = names.map((name, id): Racer => ({
      id, name, color: colors[id], isPlayer: id === 0,
      distance: distances[id], lateral: id === 0 ? 0 : id % 2 ? -3.7 : 3.7,
      heading: 0, speed: 0, lap: 1, rank: id + 1, item: null,
      charge: 0, energy: 65, shield: 0, boostTime: 0, hitTime: 0, collisionTime: 0,
      invulnerable: 0, driftTime: 0, finished: false, finishTime: 0,
    }));
    const groupPositions = [90, TRACK_LENGTH * 0.21, TRACK_LENGTH * 0.38,
      TRACK_LENGTH * 0.54, TRACK_LENGTH * 0.7, TRACK_LENGTH * 0.87];
    const pickups = groupPositions.flatMap((distance, group) => LANES.map((lateral, lane) => ({
      id: group * 3 + lane, distance, lateral,
      type: ITEMS[(group * 3 + lane) % ITEMS.length], cooldown: 0,
    })));
    const state: RaceState = {
      phase: 'menu', difficulty: this.selectedDifficulty, racers, pickups, projectiles: [], events: [], time: 0,
      countdown: 3, totalLaps: 3, bestLap: 0, lastLapTime: 0, hits: 0, drifts: 0,
    };
    [...racers].sort((a, b) => b.distance - a.distance).forEach((racer, index) => { racer.rank = index + 1; });
    return state;
  }

  /** The menu is the only place a selected tier may change without starting a new race. */
  setDifficulty(difficulty: Difficulty): boolean {
    if (this.state.phase !== 'menu' || !isDifficulty(difficulty)) return false;
    this.selectedDifficulty = difficulty;
    this.state = this.makeState();
    return true;
  }

  start(difficulty?: Difficulty) {
    // Invalid runtime values retain the last validated selection; omitted values do too.
    if (isDifficulty(difficulty)) this.selectedDifficulty = difficulty;
    this.state = this.makeState();
    this.state.phase = 'countdown';
    this.state.events.push({ type: 'countdown', racer: 0, text: '3' });
  }

  /** The visible world's immutable collision shapes survive race/menu resets. */
  setStaticColliders(colliders: readonly StaticCollider[]) {
    this.collisionWorld = new StaticCollisionIndex(colliders);
  }

  pause() {
    if (this.state.phase !== 'racing' && this.state.phase !== 'countdown') return;
    this.pausedFrom = this.state.phase;
    this.state.phase = 'paused';
  }

  resume() {
    if (this.state.phase === 'paused') this.state.phase = this.pausedFrom;
  }

  returnToMenu() {
    this.state = this.makeState();
  }

  resetPlayer() {
    const player = this.state.racers[0];
    if (player.finished) return;
    // Keep exact race progress: resetting cannot cut a corner or gain a lap.
    player.lateral = 0;
    player.heading = 0;
    player.speed = Math.min(16, Math.max(0, player.speed));
    player.hitTime = 0;
    player.collisionTime = 0;
    this.impactVelocity[0] = { x: 0, z: 0 };
    this.impactYaw[0] = 0;
    this.contactCooldown[0] = 0;
    player.invulnerable = Math.max(player.invulnerable, 1.3);
    player.driftTime = 0;
    this.offRoad[0] = 0;
    this.playerSteer = 0;
    this.state.events.push({ type: 'reset', racer: 0, text: 'BACK ON TRACK' });
  }

  update(dt: number, input: InputState = EMPTY_INPUT) {
    this.state.events = [];
    if (!Number.isFinite(dt) || dt <= 0) return;
    if (this.state.phase === 'menu' || this.state.phase === 'paused' || this.state.phase === 'finished') return;

    const useItem = input.useItem && !this.previousUse;
    const reset = input.reset && !this.previousReset;
    this.previousUse = input.useItem;
    this.previousReset = input.reset;
    // A suspended browser must not simulate several minutes on its first visible frame.
    let remaining = Math.min(dt, 5);
    if (this.state.phase === 'countdown') {
      const before = this.state.countdown;
      const elapsed = Math.min(before, remaining);
      this.state.countdown = Math.max(0, before - elapsed);
      remaining -= elapsed;
      for (let count = Math.ceil(before) - 1; count >= Math.ceil(this.state.countdown); count--) {
        if (count > 0) this.state.events.push({ type: 'countdown', racer: 0, text: String(count) });
      }
      if (this.state.countdown > 1e-8) return;
      this.state.countdown = 0;
      this.state.phase = 'racing';
      this.state.events.push({ type: 'countdown', racer: 0, text: 'GO!' });
    }
    if (reset) this.resetPlayer();
    if (useItem) this.useItem(this.state.racers[0]);
    while (remaining > 1e-8 && this.state.phase === 'racing') {
      const step = Math.min(STEP, remaining);
      this.step(step, input);
      remaining -= step;
    }
    this.updateRanks();
  }

  private step(dt: number, input: InputState) {
    this.state.time += dt;
    for (const pickup of this.state.pickups) pickup.cooldown = Math.max(0, pickup.cooldown - dt);
    for (const racer of this.state.racers) {
      if (racer.finished) continue;
      const control = racer.isPlayer ? input : this.aiInput(racer, dt);
      if (!racer.isPlayer && control.useItem) this.useItem(racer);
      this.moveRacer(racer, control, dt);
    }
    this.resolveSolidContacts();
    // Only corrected, non-penetrating positions can collect supplies or cross a lap line.
    for (const racer of this.state.racers) {
      if (racer.finished) continue;
      this.collectPickups(racer);
      this.checkLap(racer);
    }
    this.moveProjectiles(dt);
    this.updateRanks();
    if (this.state.racers[0].finished) {
      this.state.phase = 'finished';
      this.state.events.push({ type: 'finish', racer: 0, text: 'FINISH' });
    }
  }

  private aiInput(racer: Racer, dt: number): InputState {
    const tuning = DIFFICULTIES[this.selectedDifficulty];
    const driver = this.ai[racer.id];
    driver.decision -= dt;
    driver.itemWait -= dt;
    driver.boost = Math.max(0, driver.boost - dt);
    const curve = Math.abs(sampleTrack(racer.distance + 30).curvature);
    if (driver.decision <= 0) {
      driver.decision = (0.45 + this.random() * 0.45) * tuning.aiDecisionScale;
      let desired = Math.sin(this.state.time * 0.16 + driver.personality) * 3.8;
      if (!racer.item) {
        const pickup = this.state.pickups.filter(p => p.cooldown <= 0 &&
          wrapDistance(p.distance - racer.distance) < tuning.aiPickupLookahead)
          .sort((a, b) => wrapDistance(a.distance - racer.distance) - wrapDistance(b.distance - racer.distance)
            + Math.abs(a.lateral - racer.lateral) * 1.7 - Math.abs(b.lateral - racer.lateral) * 1.7)[0];
        if (pickup) desired = pickup.lateral;
      }
      const obstruction = this.state.racers.find(other => other.id !== racer.id && !other.finished &&
        trackGap(other.distance, racer.distance) > 0 && trackGap(other.distance, racer.distance) < 22 &&
        Math.abs(other.lateral - racer.lateral) < 3.3);
      if (obstruction) desired = obstruction.lateral >= 0 ? -5.7 : 5.7;
      driver.lane = clamp(desired, -6.2, 6.2);
      if (racer.energy > tuning.aiBoostThreshold && curve < tuning.aiBoostMaxCurvature &&
        this.random() < tuning.aiBoostChance) driver.boost = tuning.aiBoostDuration;
    }
    let fire = false;
    if (racer.item && driver.itemWait <= 0 && racer.speed > 18) {
      if (racer.item === 'rocket') fire = this.findTarget(racer.distance, racer.id, tuning.aiRocketRange) !== null || driver.itemWait < -4;
      if (racer.item === 'mine') fire = this.state.racers.some(other => other.id !== racer.id &&
        trackGap(racer.distance, other.distance) > 0 && trackGap(racer.distance, other.distance) < 65) || driver.itemWait < -3;
      if (racer.item === 'shield') fire = this.state.projectiles.some(p => p.owner !== racer.id &&
        Math.abs(trackGap(p.distance, racer.distance)) < 70) || driver.itemWait < -2;
      if (racer.item === 'nitro') fire = curve < 0.016;
      if (fire) driver.itemWait = (1.5 + this.random() * 2) * tuning.aiItemDelayScale;
    }
    const drift = curve > 0.006 && curve < 0.025 && racer.speed > 32 &&
      Math.sin(this.state.time * 0.75 + driver.personality) > 0.1;
    return { throttle: true, brake: false, steer: drift ? 0.5 : 0,
      drift, boost: driver.boost > 0, useItem: fire, reset: false };
  }

  private moveRacer(racer: Racer, input: InputState, dt: number) {
    const tuning = DIFFICULTIES[this.selectedDifficulty];
    racer.shield = Math.max(0, racer.shield - dt);
    racer.boostTime = Math.max(0, racer.boostTime - dt);
    racer.hitTime = Math.max(0, racer.hitTime - dt);
    racer.collisionTime = Math.max(0, racer.collisionTime - dt);
    this.contactCooldown[racer.id] = Math.max(0, this.contactCooldown[racer.id] - dt);
    racer.invulnerable = Math.max(0, racer.invulnerable - dt);
    const onRoad = Math.abs(racer.lateral) <= TRACK_WIDTH / 2 + 0.7;
    const drifting = input.drift && Math.abs(input.steer) > 0.08 && racer.speed > 24 && onRoad && racer.hitTime <= 0;
    if (drifting) {
      racer.driftTime += dt;
      if (racer.item) racer.charge = Math.min(1, racer.charge + dt * 0.43);
      racer.energy = Math.min(100, racer.energy + dt * 11);
    } else if (racer.driftTime > 0) {
      if (racer.driftTime > 0.5 && onRoad) {
        racer.boostTime = Math.max(racer.boostTime, Math.min(1.1, 0.42 + racer.driftTime * 0.18));
        racer.energy = Math.min(100, racer.energy + 7);
        if (racer.isPlayer) this.state.drifts++;
        this.state.events.push({ type: 'drift', racer: racer.id, text: 'DRIFT BOOST' });
      }
      racer.driftTime = 0;
    }
    if (!input.boost) this.energyLocked[racer.id] = false;
    const energyBoost = input.boost && racer.energy > 0.5 && !this.energyLocked[racer.id] &&
      racer.speed > 6 && racer.hitTime <= 0;
    if (energyBoost) {
      racer.energy = Math.max(0, racer.energy - 30 * dt);
      // The held-energy boost lasts only through this physics step. A longer grace
      // period would let rapid tapping produce almost free, continuous nitro.
      racer.boostTime = Math.max(racer.boostTime, dt);
      if (!this.energyBoosting[racer.id]) this.state.events.push({ type: 'boost', racer: racer.id, text: 'NITRO' });
      if (racer.energy <= 0.5) this.energyLocked[racer.id] = true;
    } else {
      const movingRegen = racer.isPlayer ? tuning.playerMovingEnergyRegen : 3.5;
      const idleRegen = racer.isPlayer ? tuning.playerIdleEnergyRegen : 1.5;
      racer.energy = Math.min(100, racer.energy + dt * (onRoad && racer.speed > 5 ? movingRegen : idleRegen));
    }
    this.energyBoosting[racer.id] = energyBoost;

    let topSpeed = PLAYER_BASE_SPEED;
    if (!racer.isPlayer) {
      const driver = this.ai[racer.id];
      const curvature = Math.max(Math.abs(sampleTrack(racer.distance + 12).curvature),
        Math.abs(sampleTrack(racer.distance + 45).curvature));
      // AI obeys the same speed/acceleration limits. Catch-up adds at most 3 m/s, never teleports.
      const catchUp = clamp((this.state.racers[0].distance - racer.distance) / 105, -2.8, 3);
      topSpeed = tuning.aiBaseSpeed + Math.sin(this.state.time * 0.32 + driver.personality) * 2.5 + catchUp
        - clamp(curvature * tuning.aiCurvePenalty, 0, tuning.aiMaxCurvePenalty);
    }
    if (drifting) topSpeed -= 3;
    if (racer.boostTime > 0) topSpeed += BOOST_SPEED_GAIN;
    if (!onRoad) topSpeed = Math.min(topSpeed, racer.isPlayer ? tuning.playerOffRoadSpeed : 24);
    if (racer.hitTime > 0) topSpeed = Math.min(topSpeed, 26);
    if (input.brake) {
      if (racer.speed > 0) racer.speed = Math.max(0, racer.speed - 39 * dt);
      else if (!input.throttle) racer.speed = Math.max(-8, racer.speed - 8 * dt);
    } else if (input.throttle) racer.speed += (racer.boostTime > 0 ? 38 : 22) * dt;
    else if (racer.speed > 0) racer.speed = Math.max(0, racer.speed - 5.4 * dt);
    else racer.speed = Math.min(0, racer.speed + 3.5 * dt);
    if (racer.speed > topSpeed) racer.speed = approach(racer.speed, topSpeed, onRoad ? 4 : 5.8, dt);
    racer.speed = clamp(racer.speed, -8, MAX_SPEED);

    if (racer.isPlayer) {
      this.playerSteer = approach(this.playerSteer, clamp(input.steer, -1, 1), 10, dt);
      const grip = drifting ? 1.9 : 3.7;
      const steering = (drifting ? 1.35 : 1.45) * clamp(Math.abs(racer.speed) / 15, 0.15, 1);
      // n=(-tz,tx) is the driver's RIGHT; positive steer lowers yaw, increasing lateral.
      racer.heading += (-this.playerSteer * steering * (racer.speed < 0 ? -1 : 1) - racer.heading * grip) * dt;
      const advance = racer.speed * Math.cos(racer.heading) * dt;
      const roadTurn = angleDifference(sampleTrack(racer.distance + advance).heading, sampleTrack(racer.distance).heading);
      racer.heading = clamp(racer.heading - roadTurn * 0.88, -0.9, 0.9);
    } else {
      const desiredHeading = -clamp((this.ai[racer.id].lane - racer.lateral) * 0.057, -0.26, 0.26);
      racer.heading = approach(racer.heading, desiredHeading, drifting ? 2.3 : 3.2, dt);
    }
    racer.heading = clamp(racer.heading + this.impactYaw[racer.id] * dt, -0.9, 0.9);
    this.impactYaw[racer.id] *= Math.exp(-dt * 8);
    racer.distance = Math.max(-35, racer.distance + racer.speed * Math.cos(racer.heading) * dt);
    racer.lateral -= Math.sin(racer.heading) * racer.speed * dt;
    const impact = this.impactVelocity[racer.id];
    if (Math.abs(impact.x) + Math.abs(impact.z) > 0.001) {
      this.translateRacer(racer, impact.x * dt, impact.z * dt);
      const damping = Math.exp(-dt * (onRoad ? 5.5 : 3));
      impact.x *= damping;
      impact.z *= damping;
    }
    if (!onRoad) this.offRoad[racer.id] += dt;
    else this.offRoad[racer.id] = Math.max(0, this.offRoad[racer.id] - dt * 2);
    if (racer.isPlayer && (Math.abs(racer.lateral) > 25 || this.offRoad[0] > 4.2)) this.resetPlayer();
    racer.lateral = clamp(racer.lateral, -27, 27);
  }

  private collectPickups(racer: Racer) {
    if (racer.item || racer.finished) return;
    for (const pickup of this.state.pickups) {
      if (pickup.cooldown > 0 || Math.abs(trackGap(pickup.distance, racer.distance)) > 4.4 ||
        Math.abs(pickup.lateral - racer.lateral) > 2.7) continue;
      racer.item = pickup.type;
      racer.charge = 0;
      pickup.cooldown = 7.5;
      this.ai[racer.id].itemWait = Math.max(0.8 * DIFFICULTIES[this.selectedDifficulty].aiItemDelayScale,
        this.ai[racer.id].itemWait);
      this.state.events.push({ type: 'pickup', racer: racer.id, item: pickup.type });
      break;
    }
  }

  private useItem(racer: Racer) {
    const item = racer.item;
    if (!item || racer.finished) return;
    const powered = racer.charge >= 0.99;
    racer.item = null;
    racer.charge = 0;
    if (item === 'shield') {
      racer.shield = powered ? 8.5 : 5.3;
      this.state.events.push({ type: 'shield', racer: racer.id, item, text: powered ? 'OVERCHARGED SHIELD' : 'SHIELD ON' });
    } else if (item === 'nitro') {
      racer.boostTime = Math.max(racer.boostTime, powered ? 3.2 : 1.8);
      racer.energy = Math.min(100, racer.energy + (powered ? 28 : 14));
      this.state.events.push({ type: 'boost', racer: racer.id, item, text: powered ? 'OVERDRIVE' : 'NITRO' });
    } else {
      this.state.projectiles.push({
        id: this.nextProjectile++, type: item, owner: racer.id,
        distance: racer.distance + (item === 'rocket' ? 5 : -5), lateral: racer.lateral,
        lifetime: item === 'rocket' ? powered ? 5 : 3.8 : powered ? 18 : 13,
        powered, target: item === 'rocket' ? this.findTarget(racer.distance, racer.id, 220) : null,
      });
      this.state.events.push({ type: 'fire', racer: racer.id, item, text: powered ? 'OVERCHARGED' : undefined });
    }
  }

  private findTarget(distance: number, owner: number, range: number): number | null {
    let nearest = range;
    let target: number | null = null;
    for (const racer of this.state.racers) {
      if (racer.id === owner || racer.finished) continue;
      const gap = wrapDistance(racer.distance - distance);
      if (gap < nearest) { nearest = gap; target = racer.id; }
    }
    return target;
  }

  private moveProjectiles(dt: number) {
    for (const projectile of this.state.projectiles) {
      projectile.lifetime -= dt;
      if (projectile.lifetime <= 0) continue;
      if (projectile.type === 'rocket') {
        if (projectile.target === null || this.state.racers[projectile.target]?.finished) {
          projectile.target = this.findTarget(projectile.distance, projectile.owner, 210);
        }
        const target = projectile.target === null ? null : this.state.racers[projectile.target];
        if (target) {
          const change = clamp(target.lateral - projectile.lateral, -(projectile.powered ? 20 : 13) * dt,
            (projectile.powered ? 20 : 13) * dt);
          projectile.lateral += change;
        }
        projectile.distance += (projectile.powered ? 148 : 125) * dt;
      }
      const projectileTrack = sampleTrack(projectile.distance);
      const projectileVolume = createBoxVolume(
        projectileTrack.x + projectileTrack.nx * projectile.lateral,
        projectileTrack.y + (projectile.type === 'rocket' ? 1.2 : 0.24),
        projectileTrack.z + projectileTrack.nz * projectile.lateral,
        projectile.type === 'rocket' ? (projectile.powered ? 0.42 : 0.24) : 0.7,
        projectile.type === 'rocket' ? 0.22 : 0.18,
        projectile.type === 'rocket' ? 0.95 : 0.7, projectileTrack.heading,
      );
      if (projectile.type === 'rocket') {
        const contact = this.collisionWorld.query(projectileVolume)
          .map(collider => intersectVolumes(projectileVolume, collider)).find(Boolean);
        if (contact) {
          projectile.lifetime = 0;
          this.state.events.push({ type: 'collision', racer: projectile.owner, item: 'rocket',
            collisionKind: 'structure', strength: 0.35, contact: contact.point, text: 'PROJECTILE_BLOCKED' });
          continue;
        }
      }
      for (const racer of this.state.racers) {
        if (racer.id === projectile.owner || racer.finished) continue;
        if (projectile.type === 'rocket') {
          if (!intersectVolumes(projectileVolume, racerVolume(racer))) continue;
        } else if (Math.abs(trackGap(projectile.distance, racer.distance)) > 3.5 ||
          Math.abs(projectile.lateral - racer.lateral) > (projectile.powered ? 3.6 : 2.7)) continue;
        projectile.lifetime = 0;
        if (racer.invulnerable > 0) break;
        if (racer.shield > 0) {
          racer.shield = 0;
          racer.invulnerable = 0.9;
          this.state.events.push({ type: 'shield', racer: racer.id, item: 'shield', text: 'BLOCKED!' });
        } else {
          racer.speed *= projectile.powered ? 0.5 : 0.6;
          racer.hitTime = projectile.powered ? 0.95 : 0.65;
          racer.invulnerable = racer.isPlayer ? DIFFICULTIES[this.selectedDifficulty].playerHitProtection : 1.65;
          racer.heading += (this.random() > 0.5 ? 1 : -1) * 0.14;
          racer.driftTime = 0;
          if (projectile.owner === 0) this.state.hits++;
          this.state.events.push({ type: 'hit', racer: racer.id, item: projectile.type,
            text: projectile.owner === 0 ? 'DIRECT HIT!' : 'HIT!' });
        }
        break;
      }
    }
    this.state.projectiles = this.state.projectiles.filter(projectile => projectile.lifetime > 0).slice(-80);
  }

  /** Reproject small world-space corrections locally, never onto another part/lap of the circuit. */
  private translateRacer(racer: Racer, dx: number, dz: number) {
    const original = sampleTrack(racer.distance);
    const targetX = original.x + original.nx * racer.lateral + dx;
    const targetZ = original.z + original.nz * racer.lateral + dz;
    let distance = racer.distance;
    for (let i = 0; i < 4; i++) {
      const track = sampleTrack(distance);
      const x = targetX - track.x, z = targetZ - track.z;
      const lateral = x * track.nx + z * track.nz;
      const jacobian = Math.max(0.35, 1 + track.curvature * lateral);
      const change = clamp((x * track.tx + z * track.tz) / jacobian, -6, 6);
      distance += change;
      if (Math.abs(change) < 0.00005) break;
    }
    const next = sampleTrack(distance);
    racer.distance = distance;
    racer.lateral = (targetX - next.x) * next.nx + (targetZ - next.z) * next.nz;
    // A sideways impact changes position, not the car's absolute yaw.
    racer.heading = clamp(racer.heading + angleDifference(original.heading, next.heading), -0.9, 0.9);
  }

  private velocity(racer: Racer) {
    const yaw = sampleTrack(racer.distance).heading + racer.heading;
    const impact = this.impactVelocity[racer.id];
    return { x: Math.sin(yaw) * racer.speed + impact.x, z: Math.cos(yaw) * racer.speed + impact.z };
  }

  private setVelocity(racer: Racer, x: number, z: number) {
    const yaw = sampleTrack(racer.distance).heading + racer.heading;
    const tx = Math.sin(yaw), tz = Math.cos(yaw);
    racer.speed = clamp(x * tx + z * tz, -8, MAX_SPEED);
    const sideSpeed = clamp(-tz * x + tx * z, -24, 24);
    this.impactVelocity[racer.id].x = -tz * sideSpeed;
    this.impactVelocity[racer.id].z = tx * sideSpeed;
  }

  private collisionFeedback(racer: Racer, contact: CollisionContact, speed: number,
    kind: 'car' | StaticCollider['kind'], other?: number) {
    if (speed < 2) return;
    racer.collisionTime = Math.max(racer.collisionTime, 0.22 + Math.min(speed / 90, 0.35));
    if (speed > 7) { racer.boostTime = 0; racer.driftTime = 0; }
    if (this.contactCooldown[racer.id] > 0) return;
    this.contactCooldown[racer.id] = 0.32;
    this.state.events.push({ type: 'collision', racer: racer.id, other, collisionKind: kind,
      contact: contact.point, strength: clamp(speed / 32, 0.12, 1) });
  }

  private contactTorque(racer: Racer, contact: CollisionContact, impulse: number) {
    const track = sampleTrack(racer.distance);
    const leverX = contact.point.x - track.x - track.nx * racer.lateral;
    const leverZ = contact.point.z - track.z - track.nz * racer.lateral;
    const yaw = (leverZ * contact.nx - leverX * contact.nz) * impulse * 0.013;
    this.impactYaw[racer.id] = clamp(this.impactYaw[racer.id] + yaw, -0.8, 0.8);
  }

  private resolveStaticContacts(racer: Racer) {
    let body = racerVolume(racer);
    for (const collider of this.collisionWorld.query(body)) {
      const contact = intersectVolumes(body, collider);
      if (!contact) continue;
      const velocity = this.velocity(racer);
      const closing = velocity.x * contact.nx + velocity.z * contact.nz;
      // Full positional correction makes even stationary overlaps solid.
      this.translateRacer(racer, contact.nx * (contact.depth + 0.002), contact.nz * (contact.depth + 0.002));
      if (closing < 0) {
        const impulse = -closing * (closing < -5 ? 1.1 : 1);
        const tangentX = -contact.nz, tangentZ = contact.nx;
        const tangentSpeed = velocity.x * tangentX + velocity.z * tangentZ;
        const friction = clamp(-tangentSpeed, -impulse * 0.13, impulse * 0.13);
        this.setVelocity(racer, velocity.x + contact.nx * impulse + tangentX * friction,
          velocity.z + contact.nz * impulse + tangentZ * friction);
        this.contactTorque(racer, contact, impulse);
        this.collisionFeedback(racer, contact, -closing, collider.kind);
      }
      body = racerVolume(racer);
    }
  }

  private resolveSolidContacts() {
    const racers = this.state.racers.filter(racer => !racer.finished);
    // Substeps cap relative travel below one car width; iterations untangle pile-ups.
    for (let iteration = 0; iteration < 6; iteration++) {
      let touched = false;
      for (const racer of racers) this.resolveStaticContacts(racer);
      for (let a = 0; a < racers.length; a++) for (let b = a + 1; b < racers.length; b++) {
        const first = racers[a], second = racers[b];
        const contact = intersectVolumes(racerVolume(first), racerVolume(second));
        if (!contact) continue;
        touched = true;
        const v1 = this.velocity(first), v2 = this.velocity(second);
        const correction = (contact.depth + 0.004) * 0.5;
        this.translateRacer(first, contact.nx * correction, contact.nz * correction);
        this.translateRacer(second, -contact.nx * correction, -contact.nz * correction);
        const closing = (v1.x - v2.x) * contact.nx + (v1.z - v2.z) * contact.nz;
        if (closing >= 0) continue;
        const impulse = -closing * (closing < -4 ? 1.12 : 1) * 0.5;
        const tangentX = -contact.nz, tangentZ = contact.nx;
        const slip = (v1.x - v2.x) * tangentX + (v1.z - v2.z) * tangentZ;
        const friction = clamp(-slip * 0.5, -impulse * 0.08, impulse * 0.08);
        const impulseX = contact.nx * impulse + tangentX * friction;
        const impulseZ = contact.nz * impulse + tangentZ * friction;
        this.setVelocity(first, v1.x + impulseX, v1.z + impulseZ);
        this.setVelocity(second, v2.x - impulseX, v2.z - impulseZ);
        this.contactTorque(first, contact, impulse);
        this.contactTorque(second, contact, -impulse);
        this.collisionFeedback(first, contact, -closing, 'car', second.id);
        this.collisionFeedback(second, contact, -closing, 'car', first.id);
      }
      if (!touched) break;
    }
    // The last car separation must not push another car through a static rail.
    for (const racer of racers) this.resolveStaticContacts(racer);
  }

  private checkLap(racer: Racer) {
    const expected = Math.floor(racer.distance / TRACK_LENGTH) + 1;
    if (expected <= racer.lap) return;
    const lapTime = this.state.time - this.lapStarted[racer.id];
    this.lapStarted[racer.id] = this.state.time;
    if (racer.isPlayer) {
      this.state.lastLapTime = lapTime;
      this.state.bestLap = this.state.bestLap > 0 ? Math.min(this.state.bestLap, lapTime) : lapTime;
      this.state.events.push({ type: 'lap', racer: racer.id, text: expected > 3 ? 'FINAL LAP COMPLETE' : `LAP ${expected} / 3` });
    }
    racer.lap = Math.min(this.state.totalLaps, expected);
    if (racer.distance >= FINISH_DISTANCE) {
      racer.distance = FINISH_DISTANCE;
      racer.finished = true;
      racer.finishTime = this.state.time;
      racer.speed = 0;
      racer.driftTime = 0;
      racer.boostTime = 0;
    }
  }

  private updateRanks() {
    [...this.state.racers].sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime || a.id - b.id;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.distance - a.distance || a.id - b.id;
    }).forEach((racer, index) => { racer.rank = index + 1; });
  }
}
