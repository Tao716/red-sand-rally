import type { ProgressStorage } from './progress';

export type SkinId = 'sandstorm' | 'midnight' | 'glacier' | 'neon' | 'venom' | 'ember';

/** Paint, decals and finish only: skins never carry performance or unlock data. */
export interface CarSkin {
  readonly id: SkinId;
  readonly name: string;
  readonly tagline: string;
  readonly description: string;
  readonly body: number;
  readonly accent: number;
  readonly trim: number;
  readonly glow: number;
  readonly roughness: number;
  readonly metalness: number;
  readonly pattern: 'twin' | 'offset' | 'chevron' | 'split' | 'circuit' | 'slash';
}

export const DEFAULT_SKIN = 'sandstorm' as const;
export const SKIN_ORDER: readonly SkinId[] = Object.freeze([
  'sandstorm', 'midnight', 'glacier', 'neon', 'venom', 'ember',
] as const);

/** Every skin is free; freeze both the catalog and its primitive-only entries. */
export const SKINS: Readonly<Record<SkinId, Readonly<CarSkin>>> = Object.freeze({
  sandstorm: Object.freeze({
    id: 'sandstorm', name: '赤沙经典', tagline: '沙暴之中，一眼认出。',
    description: '经典赤橙车身与奶油双线，保留最初的峡谷竞速风格。',
    body: 0xf16235, accent: 0xffebc1, trim: 0x303638, glow: 0x21c9ff,
    roughness: 0.39, metalness: 0.24, pattern: 'twin',
  }),
  midnight: Object.freeze({
    id: 'midnight', name: '午夜电光', tagline: '暗夜车身，电光掠过。',
    description: '深石墨金属漆配青蓝偏置条纹，冷色光泽划破峡谷夜色。',
    body: 0x222b37, accent: 0x3ce7f0, trim: 0x141e2a, glow: 0x36ddff,
    roughness: 0.28, metalness: 0.46, pattern: 'offset',
  }),
  glacier: Object.freeze({
    id: 'glacier', name: '极地冰川', tagline: '冷冽如冰，锋芒向前。',
    description: '冰白珠光车身搭配深蓝箭纹，把清爽的极地气息带入赤沙。',
    body: 0xe5f4f7, accent: 0x125182, trim: 0x375467, glow: 0x80e5ff,
    roughness: 0.32, metalness: 0.3, pattern: 'chevron',
  }),
  neon: Object.freeze({
    id: 'neon', name: '霓虹脉冲', tagline: '每一次出弯，都有色彩。',
    description: '饱和紫色与亮洋红分区撞色，给赛车添上一抹霓虹脉冲。',
    body: 0x5727ad, accent: 0xff65d8, trim: 0x281840, glow: 0xf254ff,
    roughness: 0.25, metalness: 0.38, pattern: 'split',
  }),
  venom: Object.freeze({
    id: 'venom', name: '毒液竞速', tagline: '酸绿上场，锁定目光。',
    description: '酸绿哑光漆与炭黑电路条纹形成鲜明对比，醒目又利落。',
    body: 0xb7e83a, accent: 0x172c22, trim: 0x25322b, glow: 0x9cff42,
    roughness: 0.56, metalness: 0.17, pattern: 'circuit',
  }),
  ember: Object.freeze({
    id: 'ember', name: '熔岩余烬', tagline: '余烬未熄，热烈登场。',
    description: '深红金属车身配暖金斜纹，像熔岩裂隙中仍在燃烧的余烬。',
    body: 0xa8262e, accent: 0xffce69, trim: 0x40262a, glow: 0xff903b,
    roughness: 0.34, metalness: 0.42, pattern: 'slash',
  }),
});

const SKIN_KEY = 'sand-rally-skin-v1';

export function isSkinId(value: unknown): value is SkinId {
  return value === 'sandstorm' || value === 'midnight' || value === 'glacier'
    || value === 'neon' || value === 'venom' || value === 'ember';
}

/** Missing, corrupt or inaccessible preferences fall back without changing storage. */
export function readSelectedSkin(storage: ProgressStorage): SkinId {
  try {
    const selected = storage.getItem(SKIN_KEY);
    return isSkinId(selected) ? selected : DEFAULT_SKIN;
  } catch {
    return DEFAULT_SKIN;
  }
}

/** Report failures to the caller while leaving records and other settings untouched. */
export function saveSelectedSkin(storage: ProgressStorage, id: SkinId): boolean {
  if (!isSkinId(id)) return false;
  try {
    storage.setItem(SKIN_KEY, id);
    return true;
  } catch {
    return false;
  }
}
