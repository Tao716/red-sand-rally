import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_DIFFICULTY, DIFFICULTY_ORDER } from '../src/difficulty';
import {
  readBestTime, readSelectedDifficulty, saveBestTime, saveSelectedDifficulty, type ProgressStorage,
} from '../src/progress';
import type { Difficulty } from '../src/types';

const preferenceKey = 'sand-rally-difficulty-v1';
const legacyKey = 'sand-rally-best-v1';
const bestKey = (difficulty: string) => `sand-rally-best-v2-${difficulty}`;

class MemoryStorage implements ProgressStorage {
  readonly data: Map<string, string>;
  readonly reads: string[] = [];
  readonly writes: { key: string; value: string }[] = [];

  constructor(initial: Record<string, string> = {}) {
    this.data = new Map(Object.entries(initial));
  }

  getItem(key: string) {
    this.reads.push(key);
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.writes.push({ key, value });
    this.data.set(key, value);
  }
}

test('missing or invalid difficulty preferences fall back without writing user data', () => {
  assert.equal(readSelectedDifficulty(new MemoryStorage()), DEFAULT_DIFFICULTY);
  for (const value of ['', ' ', 'normal', 'HARD', ' hard ', '"hell"', 'undefined', '__proto__']) {
    const storage = new MemoryStorage({ [preferenceKey]: value });
    assert.equal(readSelectedDifficulty(storage), DEFAULT_DIFFICULTY);
    assert.equal(storage.data.get(preferenceKey), value);
    assert.equal(storage.writes.length, 0);
  }
});

test('all three valid difficulty preferences are saved and read using the versioned key', () => {
  const storage = new MemoryStorage({ unrelated: 'untouched', [legacyKey]: '123' });
  for (const difficulty of DIFFICULTY_ORDER) {
    assert.equal(saveSelectedDifficulty(storage, difficulty), true);
    assert.equal(readSelectedDifficulty(storage), difficulty);
    assert.deepEqual(storage.writes.at(-1), { key: preferenceKey, value: difficulty });
  }
  assert.equal(storage.data.get('unrelated'), 'untouched');
  assert.equal(storage.data.get(legacyKey), '123');
});

test('invalid runtime difficulties cannot create keys or overwrite preferences or records', () => {
  const storage = new MemoryStorage({ [preferenceKey]: 'hard', [bestKey('easy')]: '91' });
  for (const invalid of ['normal', '', '__proto__', 'easy/../../hard', null, 0]) {
    const difficulty = invalid as unknown as Difficulty;
    assert.equal(saveSelectedDifficulty(storage, difficulty), false);
    assert.equal(saveBestTime(storage, difficulty, 60), false);
    assert.equal(readBestTime(storage, difficulty), 91);
  }
  assert.equal(storage.data.get(preferenceKey), 'hard');
  assert.equal(storage.data.size, 2);
  assert.equal(storage.writes.length, 0);
});

test('each difficulty reads its own best record independently', () => {
  const storage = new MemoryStorage({
    [bestKey('easy')]: '120.25', [bestKey('hard')]: '134.5', [bestKey('hell')]: '151.125',
  });
  assert.equal(readBestTime(storage, 'easy'), 120.25);
  assert.equal(readBestTime(storage, 'hard'), 134.5);
  assert.equal(readBestTime(storage, 'hell'), 151.125);
  assert.equal(storage.writes.length, 0);
});

test('empty, corrupt, infinite and nonpositive records are treated as absent', () => {
  for (const difficulty of DIFFICULTY_ORDER) {
    assert.equal(readBestTime(new MemoryStorage(), difficulty), Infinity);
    for (const value of ['', ' ', '\n\t', 'garbage', 'NaN', 'Infinity', '-Infinity', '1e999',
      '0', '-0', '-15.5', 'null', '{}', 'true', '[100]']) {
      const storage = new MemoryStorage({ [bestKey(difficulty)]: value });
      assert.equal(readBestTime(storage, difficulty), Infinity, `${difficulty}: ${JSON.stringify(value)}`);
      assert.equal(storage.writes.length, 0);
      assert.equal(storage.data.get(bestKey(difficulty)), value);
    }
  }
});

test('finite positive fractional and scientific-notation times retain their precision', () => {
  for (const [raw, expected] of [['89.123456789', 89.123456789], [' 102.5 ', 102.5], ['1.2e2', 120], ['1e-6', 1e-6]] as const) {
    assert.equal(readBestTime(new MemoryStorage({ [bestKey('hell')]: raw }), 'hell'), expected);
  }
});

test('invalid new times never write over an existing record', () => {
  const storage = new MemoryStorage({ [bestKey('hard')]: '95.5' });
  for (const time of [Infinity, -Infinity, NaN, 0, -0, -1, -100]) {
    assert.equal(saveBestTime(storage, 'hard', time), false);
  }
  assert.equal(storage.data.get(bestKey('hard')), '95.5');
  assert.equal(storage.writes.length, 0);
});

test('a best record is written only for a strict improvement, never a tie or worse result', () => {
  const storage = new MemoryStorage();
  assert.equal(saveBestTime(storage, 'hard', 90.5), true);
  assert.equal(saveBestTime(storage, 'hard', 91), false);
  assert.equal(saveBestTime(storage, 'hard', 90.5), false);
  assert.equal(storage.writes.length, 1);
  assert.equal(saveBestTime(storage, 'hard', 89.125), true);
  assert.equal(storage.data.get(bestKey('hard')), '89.125');
  assert.equal(readBestTime(storage, 'hard'), 89.125);
  assert.equal(storage.writes.length, 2);
});

test('saving one difficulty never alters another difficulty record or unrelated data', () => {
  const storage = new MemoryStorage({ [bestKey('easy')]: '92', [bestKey('hell')]: '135',
    [legacyKey]: '105', unrelated: 'keep' });
  assert.equal(saveBestTime(storage, 'hard', 110), true);
  assert.equal(readBestTime(storage, 'easy'), 92);
  assert.equal(readBestTime(storage, 'hell'), 135);
  assert.equal(storage.data.get(legacyKey), '105');
  assert.equal(storage.data.get('unrelated'), 'keep');
  assert.deepEqual(storage.writes, [{ key: bestKey('hard'), value: '110' }]);
});

test('legacy records are an easy-only read fallback and reading does not migrate them', () => {
  const storage = new MemoryStorage({ [legacyKey]: '121.75' });
  assert.equal(readBestTime(storage, 'easy'), 121.75);
  assert.equal(readBestTime(storage, 'hard'), Infinity);
  assert.equal(readBestTime(storage, 'hell'), Infinity);
  assert.equal(storage.data.size, 1);
  assert.equal(storage.data.get(legacyKey), '121.75');
  assert.equal(storage.writes.length, 0);
  assert.equal(storage.reads.filter(key => key === legacyKey).length, 1);
});

test('valid easy v2 takes priority while corrupt v2 may fall back to the legacy record', () => {
  const valid = new MemoryStorage({ [bestKey('easy')]: '90', [legacyKey]: '100' });
  assert.equal(readBestTime(valid, 'easy'), 90);
  assert.ok(!valid.reads.includes(legacyKey));
  for (const raw of ['', 'bad', 'Infinity', '-10', '0']) {
    const storage = new MemoryStorage({ [bestKey('easy')]: raw, [legacyKey]: '100' });
    assert.equal(readBestTime(storage, 'easy'), 100);
    assert.equal(storage.writes.length, 0);
  }
});

test('legacy best is preserved and copied forward only by a genuinely better easy result', () => {
  const storage = new MemoryStorage({ [legacyKey]: '100' });
  assert.equal(saveBestTime(storage, 'easy', 110), false);
  assert.equal(saveBestTime(storage, 'easy', 100), false);
  assert.equal(storage.data.has(bestKey('easy')), false);
  assert.equal(storage.writes.length, 0);
  assert.equal(saveBestTime(storage, 'easy', 99.75), true);
  assert.equal(storage.data.get(bestKey('easy')), '99.75');
  assert.equal(storage.data.get(legacyKey), '100');
  assert.equal(saveBestTime(storage, 'easy', 99.8), false);
  assert.equal(storage.writes.length, 1);
});

test('a faster legacy time does not block the first hard or hell record', () => {
  const storage = new MemoryStorage({ [legacyKey]: '60' });
  assert.equal(saveBestTime(storage, 'hard', 120), true);
  assert.equal(saveBestTime(storage, 'hell', 150), true);
  assert.ok(!storage.reads.includes(legacyKey));
  assert.equal(storage.data.get(legacyKey), '60');
});

test('throwing storage is contained and all public operations return safe results', () => {
  const storage: ProgressStorage = {
    getItem() { throw new Error('storage access denied'); },
    setItem() { throw new Error('quota exceeded'); },
  };
  assert.equal(readSelectedDifficulty(storage), DEFAULT_DIFFICULTY);
  assert.equal(saveSelectedDifficulty(storage, 'hell'), false);
  for (const difficulty of DIFFICULTY_ORDER) {
    assert.equal(readBestTime(storage, difficulty), Infinity);
    assert.equal(saveBestTime(storage, difficulty, 90), false);
  }
});

test('a failed record read refuses to write because the existing best is unknown', () => {
  const data = new MemoryStorage({ [bestKey('hard')]: '70' });
  const storage: ProgressStorage = {
    getItem() { throw new Error('read unavailable'); },
    setItem(key, value) { data.setItem(key, value); },
  };
  assert.equal(saveBestTime(storage, 'hard', 100), false);
  assert.equal(data.data.get(bestKey('hard')), '70');
  assert.equal(data.writes.length, 0);
  const legacyFailure: ProgressStorage = {
    getItem(key) {
      if (key === legacyKey) throw new Error('legacy record temporarily unavailable');
      return null;
    },
    setItem(key, value) { data.setItem(key, value); },
  };
  assert.equal(saveBestTime(legacyFailure, 'easy', 80), false);
  assert.equal(data.writes.length, 0);
});

test('write failures report false and do not discard a previous preference or record', () => {
  const data = new MemoryStorage({ [preferenceKey]: 'hard', [bestKey('hell')]: '120' });
  const storage: ProgressStorage = {
    getItem(key) { return data.getItem(key); },
    setItem() { throw new Error('quota exceeded'); },
  };
  assert.equal(saveSelectedDifficulty(storage, 'easy'), false);
  assert.equal(saveBestTime(storage, 'hell', 90), false);
  assert.equal(readSelectedDifficulty(storage), 'hard');
  assert.equal(readBestTime(storage, 'hell'), 120);
  assert.equal(data.writes.length, 0);
});

test('reading preferences and any generation of best records has no write side effects', () => {
  const storage = new MemoryStorage({ [preferenceKey]: 'hell', [legacyKey]: '102', [bestKey('hard')]: '110' });
  const before = [...storage.data.entries()];
  for (let i = 0; i < 3; i++) {
    assert.equal(readSelectedDifficulty(storage), 'hell');
    for (const difficulty of DIFFICULTY_ORDER) readBestTime(storage, difficulty);
  }
  assert.deepEqual([...storage.data.entries()], before);
  assert.equal(storage.writes.length, 0);
});
