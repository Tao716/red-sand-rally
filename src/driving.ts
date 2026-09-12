const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** High-speed stability assist; speed is in m/s, and drifting keeps full steering authority. */
export function playerSteeringScale(speed: number, drifting: boolean): number {
  if (drifting || !Number.isFinite(speed) || speed <= 45) return 1;
  const progress = clamp((speed - 45) / (84 - 45), 0, 1);
  // A smooth ramp leaves ordinary corners familiar without a step at boost speed.
  const blend = progress * progress * (3 - 2 * progress);
  return 1 - 0.2 * blend;
}

/** Keep the familiar press response, but let a released key recenter promptly. */
export function smoothPlayerSteer(current: number, input: number, dt: number): number {
  const previous = Number.isFinite(current) ? clamp(current, -1, 1) : 0;
  const target = Number.isFinite(input) ? clamp(input, -1, 1) : 0;
  if (!Number.isFinite(dt) || dt <= 0) return previous;
  const rate = target === 0 ? 18 : previous * target < 0 ? 14 : 10;
  return previous + (target - previous) * (1 - Math.exp(-rate * dt));
}
