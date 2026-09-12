import { CAR_HALF_LENGTH, CAR_HALF_WIDTH } from './collision';
import { TRACK_LENGTH, wrapDistance } from './track';
import type { Racer, RaceState } from './types';

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const ROCKET_RANGE = 220;
const THREAT_RANGE = 150;
const THREAT_HORIZON = 2.5;
const EPSILON = 1e-8;

export interface DriftFeedback {
  active: boolean;
  ready: boolean;
  progress: number;
  charge: number | null;
  charged: boolean;
}

export interface RocketTarget {
  racerId: number;
  name: string;
  /** Forward circuit distance, in metres, as used by the firing simulation. */
  distance: number;
}

export interface IncomingThreat {
  projectileId: number;
  direction: 'left' | 'right' | 'rear' | 'front';
  distance: number;
  /** Estimated seconds until longitudinal interception at current velocities. */
  eta: number;
  urgent: boolean;
}

/** The release boost and inventory upgrade are separate rewards with separate clocks. */
export function getDriftFeedback(player: Racer): DriftFeedback {
  const charge = player.item ? clamp01(player.charge) : null;
  return {
    active: player.driftTime >= 0.1,
    // Keep the strict threshold in RaceSimulation.moveRacer: 0.5 itself cannot boost.
    ready: player.driftTime > 0.5,
    progress: clamp01(player.driftTime / 0.5),
    charge,
    charged: charge !== null && charge >= 0.99,
  };
}

/** Mirror findTarget's forward wrap, exclusive 220 m limit, and first-match tie order. */
export function getRocketTarget(state: RaceState): RocketTarget | null {
  const player = state.racers.find(racer => racer.isPlayer);
  if (state.phase !== 'racing' || !player || player.finished || player.item !== 'rocket') return null;
  let target: RocketTarget | null = null;
  let nearest = ROCKET_RANGE;
  for (const racer of state.racers) {
    if (racer.id === player.id || racer.finished) continue;
    const gap = wrapDistance(racer.distance - player.distance);
    if (gap < nearest) {
      nearest = gap;
      target = { racerId: racer.id, name: racer.name, distance: gap };
    }
  }
  return target;
}

/** Relative lateral position under the simulation's bounded homing movement. */
function homingGap(gap: number, targetLateralSpeed: number, trackingSpeed: number, time: number): number {
  if (gap === 0) {
    return -Math.sign(targetLateralSpeed) * Math.max(0, Math.abs(targetLateralSpeed) - trackingSpeed) * time;
  }
  const approachSpeed = trackingSpeed + Math.sign(gap) * targetLateralSpeed;
  if (approachSpeed <= 0) return gap - (Math.sign(gap) * trackingSpeed + targetLateralSpeed) * time;
  const meetTime = Math.abs(gap) / approachSpeed;
  if (meetTime >= time) return gap - (Math.sign(gap) * trackingSpeed + targetLateralSpeed) * time;
  return -Math.sign(targetLateralSpeed) * Math.max(0, Math.abs(targetLateralSpeed) - trackingSpeed) * (time - meetTime);
}

/** Read-only, short-horizon warning; protection changes the HUD copy, not the trajectory. */
export function getIncomingThreat(state: RaceState): IncomingThreat | null {
  const player = state.racers.find(racer => racer.isPlayer);
  if (state.phase !== 'racing' || !player || player.finished) return null;
  const forwardSpeed = player.speed * Math.cos(player.heading);
  const lateralSpeed = -player.speed * Math.sin(player.heading);
  const cos = Math.abs(Math.cos(player.heading)), sin = Math.abs(Math.sin(player.heading));
  const carLateralRadius = CAR_HALF_WIDTH * cos + CAR_HALF_LENGTH * sin;
  const longitudinalRadius = CAR_HALF_LENGTH * cos + CAR_HALF_WIDTH * sin + 0.95;
  let nearest: IncomingThreat | null = null;

  for (const projectile of state.projectiles) {
    if (projectile.type !== 'rocket' || projectile.owner === player.id || projectile.lifetime <= 0) continue;
    const wrappedGap = (projectile.distance - player.distance) % TRACK_LENGTH;
    const gap = wrappedGap > TRACK_LENGTH / 2 ? wrappedGap - TRACK_LENGTH
      : wrappedGap < -TRACK_LENGTH / 2 ? wrappedGap + TRACK_LENGTH : wrappedGap;
    const distance = Math.abs(gap);
    if (distance > THREAT_RANGE + EPSILON) continue;
    const relativeSpeed = (projectile.powered ? 148 : 125) - forwardSpeed;
    // A missile already ahead and pulling away cannot turn around on this circuit.
    if (gap * relativeSpeed > 0 || Math.abs(relativeSpeed) < 0.001) continue;
    const eta = Math.max(0, -gap / relativeSpeed);
    if (eta > THREAT_HORIZON + EPSILON || eta >= projectile.lifetime - EPSILON) continue;

    const lateralGap = projectile.lateral - player.lateral;
    const contactHalfWindow = longitudinalRadius / Math.abs(relativeSpeed);
    const enter = Math.max(0, eta - contactHalfWindow);
    const leave = Math.min(projectile.lifetime, eta + contactHalfWindow);
    // A rocket aimed at another racer can still strike us on its way there.
    // Follow its actual target, then compare that path with the player's corridor.
    const target = state.racers.find(racer => racer.id === projectile.target && !racer.finished);
    const trackingSpeed = projectile.powered ? 20 : 13;
    const targetLateralSpeed = target ? -target.speed * Math.sin(target.heading) : 0;
    const targetGap = target ? projectile.lateral - target.lateral : 0;
    const projectedGap = (time: number) => target
      ? target.lateral - player.lateral + (targetLateralSpeed - lateralSpeed) * time
        + homingGap(targetGap, targetLateralSpeed, trackingSpeed, time)
      : lateralGap - lateralSpeed * time;
    const entryGap = projectedGap(enter), exitGap = projectedGap(leave);
    let minimumGap = Math.min(entryGap, exitGap), maximumGap = Math.max(entryGap, exitGap);
    if (target) {
      // Once it meets a moving target's lane the missile can reverse sideways;
      // testing only the window endpoints would miss that intervening contact.
      const approachSpeed = trackingSpeed + Math.sign(targetGap) * targetLateralSpeed;
      const turnTime = approachSpeed > 0 ? Math.abs(targetGap) / approachSpeed : Infinity;
      if (turnTime > enter && turnTime < leave) {
        const turnGap = projectedGap(turnTime);
        minimumGap = Math.min(minimumGap, turnGap);
        maximumGap = Math.max(maximumGap, turnGap);
      }
    }
    const closestLateralGap = minimumGap <= 0 && maximumGap >= 0 ? 0
      : Math.min(Math.abs(minimumGap), Math.abs(maximumGap));
    if (closestLateralGap > carLateralRadius + (projectile.powered ? 0.42 : 0.24)) continue;

    const threat: IncomingThreat = {
      projectileId: projectile.id,
      direction: lateralGap < -3 ? 'left' : lateralGap > 3 ? 'right' : gap > 0 ? 'front' : 'rear',
      distance,
      eta,
      urgent: eta <= 0.9 + EPSILON,
    };
    if (!nearest || threat.eta < nearest.eta
      || (threat.eta === nearest.eta && (threat.distance < nearest.distance
        || (threat.distance === nearest.distance && threat.projectileId < nearest.projectileId)))) nearest = threat;
  }
  return nearest;
}
