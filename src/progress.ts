import { DEFAULT_DIFFICULTY, isDifficulty } from './difficulty';
import type { Difficulty } from './types';

export interface ProgressStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const DIFFICULTY_KEY = 'sand-rally-difficulty-v1';
const BEST_KEY_PREFIX = 'sand-rally-best-v2-';
const LEGACY_BEST_KEY = 'sand-rally-best-v1';

function parseTime(raw: string | null): number {
  if (typeof raw !== 'string' || raw.trim() === '') return Infinity;
  const time = Number(raw);
  return Number.isFinite(time) && time > 0 ? time : Infinity;
}

/** Keep read failure distinct from an absent record: never overwrite an unknown best. */
function storedBest(storage: ProgressStorage, difficulty: Difficulty): { time: number; readable: boolean } {
  try {
    const current = parseTime(storage.getItem(`${BEST_KEY_PREFIX}${difficulty}`));
    if (current !== Infinity || difficulty !== 'easy') return { time: current, readable: true };
    return { time: parseTime(storage.getItem(LEGACY_BEST_KEY)), readable: true };
  } catch {
    return { time: Infinity, readable: false };
  }
}

export function readSelectedDifficulty(storage: ProgressStorage): Difficulty {
  try {
    const selected = storage.getItem(DIFFICULTY_KEY);
    return isDifficulty(selected) ? selected : DEFAULT_DIFFICULTY;
  } catch {
    return DEFAULT_DIFFICULTY;
  }
}

export function saveSelectedDifficulty(storage: ProgressStorage, difficulty: Difficulty): boolean {
  if (!isDifficulty(difficulty)) return false;
  try {
    storage.setItem(DIFFICULTY_KEY, difficulty);
    return true;
  } catch {
    return false;
  }
}

/** Easy alone may read the old record; reading never migrates or removes stored data. */
export function readBestTime(storage: ProgressStorage, difficulty: Difficulty): number {
  return storedBest(storage, isDifficulty(difficulty) ? difficulty : DEFAULT_DIFFICULTY).time;
}

/** Return true only when an actual, strictly better record was successfully saved. */
export function saveBestTime(storage: ProgressStorage, difficulty: Difficulty, time: number): boolean {
  if (!isDifficulty(difficulty) || !Number.isFinite(time) || time <= 0) return false;
  const previous = storedBest(storage, difficulty);
  if (!previous.readable || time >= previous.time) return false;
  try {
    storage.setItem(`${BEST_KEY_PREFIX}${difficulty}`, String(time));
    return true;
  } catch {
    return false;
  }
}
