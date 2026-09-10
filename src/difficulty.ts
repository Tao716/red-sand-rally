import type { Difficulty } from './types';

export interface DifficultyConfig {
  readonly label: string;
  readonly subtitle: string;
  readonly description: string;
  readonly color: string;
  readonly aiBaseSpeed: number;
  readonly aiCurvePenalty: number;
  readonly aiMaxCurvePenalty: number;
  readonly aiDecisionScale: number;
  readonly aiItemDelayScale: number;
  readonly aiPickupLookahead: number;
  readonly aiRocketRange: number;
  readonly aiBoostThreshold: number;
  readonly aiBoostChance: number;
  readonly aiBoostDuration: number;
  readonly aiBoostMaxCurvature: number;
  readonly playerMovingEnergyRegen: number;
  readonly playerIdleEnergyRegen: number;
  readonly playerHitProtection: number;
  readonly playerOffRoadSpeed: number;
}

export const DEFAULT_DIFFICULTY: Difficulty = 'easy';
export const DIFFICULTY_ORDER: readonly Difficulty[] = Object.freeze(['easy', 'hard', 'hell'] as const);

export function isDifficulty(value: unknown): value is Difficulty {
  return value === 'easy' || value === 'hard' || value === 'hell';
}

/** Player steering, acceleration, boost cost, weapons, and collision volumes never change by tier. */
export const DIFFICULTIES: Readonly<Record<Difficulty, DifficultyConfig>> = Object.freeze({
  easy: Object.freeze({
    label: '简单', subtitle: '熟悉赛道',
    description: '对手节奏温和，氮气恢复更快，适合熟悉漂移与道具。', color: '#758866',
    aiBaseSpeed: 46, aiCurvePenalty: 470, aiMaxCurvePenalty: 13,
    aiDecisionScale: 1, aiItemDelayScale: 1, aiPickupLookahead: 100, aiRocketRange: 165,
    aiBoostThreshold: 73, aiBoostChance: 0.3, aiBoostDuration: 1.35, aiBoostMaxCurvature: 0.007,
    playerMovingEnergyRegen: 3.5, playerIdleEnergyRegen: 1.5,
    playerHitProtection: 1.65, playerOffRoadSpeed: 24,
  }),
  hard: Object.freeze({
    label: '困难', subtitle: '认真跑线',
    description: '对手更快、出手更积极，跑线与氮气管理同样重要。', color: '#bd853c',
    aiBaseSpeed: 51, aiCurvePenalty: 365, aiMaxCurvePenalty: 10.5,
    aiDecisionScale: 0.75, aiItemDelayScale: 0.72, aiPickupLookahead: 125, aiRocketRange: 185,
    aiBoostThreshold: 58, aiBoostChance: 0.48, aiBoostDuration: 1.55, aiBoostMaxCurvature: 0.0085,
    playerMovingEnergyRegen: 3, playerIdleEnergyRegen: 1.25,
    playerHitProtection: 1.45, playerOffRoadSpeed: 22,
  }),
  hell: Object.freeze({
    label: '地狱', subtitle: '寸步不让',
    description: '对手高速抢线、积极进攻，氮气回复与受击保护更少。', color: '#b95745',
    aiBaseSpeed: 55, aiCurvePenalty: 285, aiMaxCurvePenalty: 8.5,
    aiDecisionScale: 0.55, aiItemDelayScale: 0.5, aiPickupLookahead: 150, aiRocketRange: 205,
    aiBoostThreshold: 43, aiBoostChance: 0.64, aiBoostDuration: 1.7, aiBoostMaxCurvature: 0.01,
    playerMovingEnergyRegen: 2.5, playerIdleEnergyRegen: 1,
    playerHitProtection: 1.25, playerOffRoadSpeed: 20,
  }),
});
