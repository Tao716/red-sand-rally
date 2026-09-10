export type ItemType = 'rocket' | 'mine' | 'shield' | 'nitro';
export type GamePhase = 'menu' | 'countdown' | 'racing' | 'paused' | 'finished';
export type Difficulty = 'easy' | 'hard' | 'hell';

export interface InputState {
  throttle: boolean;
  brake: boolean;
  steer: number;
  drift: boolean;
  boost: boolean;
  useItem: boolean;
  reset: boolean;
}

export interface Racer {
  id: number;
  name: string;
  color: number;
  isPlayer: boolean;
  distance: number;
  lateral: number;
  heading: number;
  speed: number;
  lap: number;
  rank: number;
  item: ItemType | null;
  charge: number;
  energy: number;
  shield: number;
  boostTime: number;
  hitTime: number;
  collisionTime: number;
  invulnerable: number;
  driftTime: number;
  finished: boolean;
  finishTime: number;
}

export interface Pickup {
  id: number;
  distance: number;
  lateral: number;
  type: ItemType;
  cooldown: number;
}

export interface Projectile {
  id: number;
  type: 'rocket' | 'mine';
  owner: number;
  distance: number;
  lateral: number;
  lifetime: number;
  powered: boolean;
  target: number | null;
}

export interface GameEvent {
  type: 'pickup' | 'fire' | 'hit' | 'collision' | 'shield' | 'boost' | 'drift' | 'lap' | 'finish' | 'reset' | 'countdown';
  racer: number;
  item?: ItemType;
  text?: string;
  collisionKind?: 'car' | 'barrier' | 'rock' | 'structure';
  strength?: number;
  contact?: { x: number; y: number; z: number };
  other?: number;
}

export interface RaceState {
  phase: GamePhase;
  difficulty: Difficulty;
  racers: Racer[];
  pickups: Pickup[];
  projectiles: Projectile[];
  events: GameEvent[];
  time: number;
  countdown: number;
  totalLaps: number;
  bestLap: number;
  lastLapTime: number;
  hits: number;
  drifts: number;
}

export const EMPTY_INPUT: InputState = {
  throttle: false, brake: false, steer: 0, drift: false,
  boost: false, useItem: false, reset: false,
};
