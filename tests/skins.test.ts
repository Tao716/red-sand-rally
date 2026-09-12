import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProgressStorage } from '../src/progress';
import { DEFAULT_SKIN, isSkinId, readSelectedSkin, saveSelectedSkin, SKIN_ORDER, SKINS,
  type CarSkin, type SkinId } from '../src/skins';
import { RaceSimulation } from '../src/simulation';
import { EMPTY_INPUT } from '../src/types';

const preferenceKey = 'sand-rally-skin-v1';

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

test('the catalog has six complete original skins with stable ids, names and patterns', () => {
  assert.equal(DEFAULT_SKIN, 'sandstorm');
  assert.deepEqual(SKIN_ORDER, ['sandstorm', 'midnight', 'glacier', 'neon', 'venom', 'ember']);
  assert.deepEqual(Object.keys(SKINS), SKIN_ORDER);
  assert.deepEqual(SKIN_ORDER.map(id => SKINS[id].name), [
    '赤沙经典', '午夜电光', '极地冰川', '霓虹脉冲', '毒液竞速', '熔岩余烬',
  ]);
  assert.deepEqual(SKIN_ORDER.map(id => SKINS[id].pattern), [
    'twin', 'offset', 'chevron', 'split', 'circuit', 'slash',
  ]);
  for (const id of SKIN_ORDER) {
    const skin = SKINS[id];
    assert.equal(skin.id, id);
    assert.ok(isSkinId(id));
    assert.ok(skin.tagline.length > 6);
    assert.ok(skin.description.length > 12);
  }
});

test('the order, catalog and every entry are frozen at runtime', () => {
  assert.ok(Object.isFrozen(SKIN_ORDER));
  assert.ok(Object.isFrozen(SKINS));
  assert.throws(() => (SKIN_ORDER as SkinId[]).push('sandstorm'), TypeError);
  assert.throws(() => { (SKINS as Record<SkinId, Readonly<CarSkin>>).neon = SKINS.ember; }, TypeError);
  for (const id of SKIN_ORDER) {
    assert.ok(Object.isFrozen(SKINS[id]));
    assert.throws(() => { (SKINS[id] as { body: number }).body = 0; }, TypeError);
    assert.ok(Object.values(SKINS[id]).every(value =>
      value !== null && (typeof value === 'string' || typeof value === 'number')));
  }
});

test('all paint colors are legal RGB integers and body/accent pairs remain distinct', () => {
  for (const id of SKIN_ORDER) {
    const skin = SKINS[id];
    for (const channel of ['body', 'accent', 'trim', 'glow'] as const) {
      assert.ok(Number.isInteger(skin[channel]), `${id}.${channel} must be an integer`);
      assert.ok(skin[channel] >= 0 && skin[channel] <= 0xffffff, `${id}.${channel} must fit RGB`);
    }
    const distance = Math.hypot(...[16, 8, 0].map(shift =>
      ((skin.body >> shift) & 255) - ((skin.accent >> shift) & 255)));
    assert.ok(distance > 150, `${id} needs a strongly differentiated decal color`);
  }
  assert.equal(new Set(SKIN_ORDER.map(id => SKINS[id].body)).size, 6);
});

test('finishes stay in the supported range and the default reproduces the original paint', () => {
  for (const id of SKIN_ORDER) {
    assert.ok(SKINS[id].roughness >= 0.24 && SKINS[id].roughness <= 0.6);
    assert.ok(SKINS[id].metalness >= 0.15 && SKINS[id].metalness <= 0.5);
  }
  assert.equal(SKINS.sandstorm.body, 0xf16235);
  assert.equal(SKINS.sandstorm.accent, 0xffebc1);
  assert.equal(SKINS.sandstorm.trim, 0x303638);
  assert.equal(SKINS.sandstorm.glow, 0x21c9ff);
  assert.equal(SKINS.sandstorm.roughness, 0.39);
  assert.equal(SKINS.sandstorm.metalness, 0.24);
});

test('skins contain appearance metadata only, with no price, unlock or performance fields', () => {
  const appearanceKeys = ['id', 'name', 'tagline', 'description', 'body', 'accent', 'trim',
    'glow', 'roughness', 'metalness', 'pattern'].sort();
  for (const id of SKIN_ORDER) assert.deepEqual(Object.keys(SKINS[id]).sort(), appearanceKeys);
});

test('validation rejects prototype names, malformed strings and all non-string values', () => {
  for (const value of [undefined, null, '', ' ', 'Sandstorm', 'NEON', ' neon ', '"neon"',
    '__proto__', 'constructor', 'toString', 'neon/../../ember', 'sand-rally-best-v1',
    0, 1, false, true, {}, [], ['neon'], new String('neon')]) {
    assert.equal(isSkinId(value), false, String(value));
  }
});

test('missing and malformed preferences fall back without repairing or clearing stored data', () => {
  const missing = new MemoryStorage();
  assert.equal(readSelectedSkin(missing), DEFAULT_SKIN);
  assert.deepEqual(missing.reads, [preferenceKey]);
  assert.equal(missing.data.size, 0);
  assert.equal(missing.writes.length, 0);
  for (const raw of ['', ' ', '\n\t', 'blue', 'NEON', ' neon ', '"neon"', 'null', 'undefined',
    '{}', '{"id":"neon"}', '["neon"]', '__proto__', 'constructor']) {
    const storage = new MemoryStorage({ [preferenceKey]: raw });
    assert.equal(readSelectedSkin(storage), DEFAULT_SKIN, JSON.stringify(raw));
    assert.equal(storage.data.get(preferenceKey), raw);
    assert.equal(storage.writes.length, 0);
  }
});

test('each valid skin round-trips using only the dedicated versioned preference key', () => {
  const storage = new MemoryStorage();
  for (const id of SKIN_ORDER) {
    assert.equal(saveSelectedSkin(storage, id), true);
    assert.equal(readSelectedSkin(storage), id);
    assert.deepEqual(storage.writes.at(-1), { key: preferenceKey, value: id });
  }
  assert.equal(storage.data.size, 1);
  assert.equal(storage.writes.length, 6);
  assert.ok(storage.reads.every(key => key === preferenceKey));
});

test('a fresh storage wrapper restores the last chosen skin', () => {
  const original = new MemoryStorage();
  assert.equal(saveSelectedSkin(original, 'glacier'), true);
  const restored = new MemoryStorage(Object.fromEntries(original.data));
  assert.equal(readSelectedSkin(restored), 'glacier');
  assert.equal(restored.writes.length, 0);
});

test('invalid runtime skin ids cannot overwrite preferences or create new keys', () => {
  const storage = new MemoryStorage({ [preferenceKey]: 'midnight', 'sand-rally-best-v1': '91' });
  const before = [...storage.data.entries()];
  for (const value of ['', 'orange', 'NEON', '__proto__', 'constructor', 'ember/../../best',
    null, undefined, 7, {}, ['ember']]) {
    assert.equal(saveSelectedSkin(storage, value as SkinId), false);
  }
  assert.deepEqual([...storage.data.entries()], before);
  assert.equal(storage.reads.length, 0);
  assert.equal(storage.writes.length, 0);
});

test('obsolete or unrelated keys cannot select a skin and are never migrated or erased', () => {
  const storage = new MemoryStorage({
    'sand-rally-skin': 'neon', 'sand-rally-skin-v0': 'glacier', 'sand-rally-skin-v2': 'venom',
    'sand-rally-difficulty-v1': 'ember', 'sand-rally-best-v1': 'midnight', unrelated: 'neon',
  });
  const before = [...storage.data.entries()];
  assert.equal(readSelectedSkin(storage), DEFAULT_SKIN);
  assert.deepEqual(storage.reads, [preferenceKey]);
  assert.deepEqual([...storage.data.entries()], before);
  assert.equal(storage.writes.length, 0);
});

test('selecting any skin preserves difficulty preferences, every record and unrelated data', () => {
  const initial = {
    'sand-rally-difficulty-v1': 'hell', 'sand-rally-best-v1': '110',
    'sand-rally-best-v2-easy': '92', 'sand-rally-best-v2-hard': '115',
    'sand-rally-best-v2-hell': '127.5', unrelated: 'keep',
  };
  const storage = new MemoryStorage(initial);
  for (const id of SKIN_ORDER) {
    assert.equal(saveSelectedSkin(storage, id), true);
    assert.equal(readSelectedSkin(storage), id);
    for (const [key, value] of Object.entries(initial)) assert.equal(storage.data.get(key), value);
  }
  assert.equal(storage.data.size, Object.keys(initial).length + 1);
  assert.ok(storage.writes.every(write => write.key === preferenceKey));
});

test('denied storage reads and writes return safe results without escaping exceptions', () => {
  const storage: ProgressStorage = {
    getItem() { throw new Error('storage access denied'); },
    setItem() { throw new Error('quota exceeded'); },
  };
  assert.equal(readSelectedSkin(storage), DEFAULT_SKIN);
  for (const id of SKIN_ORDER) assert.equal(saveSelectedSkin(storage, id), false);
});

test('write failure preserves the previous preference and reads remain side-effect-free', () => {
  const saved = new MemoryStorage({ [preferenceKey]: 'ember', 'sand-rally-best-v1': '104.25' });
  const storage: ProgressStorage = {
    getItem(key) { return saved.getItem(key); },
    setItem() { throw new Error('quota exceeded'); },
  };
  for (const id of SKIN_ORDER) {
    assert.equal(saveSelectedSkin(storage, id), false);
    assert.equal(readSelectedSkin(storage), 'ember');
  }
  assert.equal(saved.data.get('sand-rally-best-v1'), '104.25');
  assert.equal(saved.writes.length, 0);
});

test('saving a valid preference does not require a readable store', () => {
  const saved = new MemoryStorage();
  const storage: ProgressStorage = {
    getItem() { throw new Error('reads temporarily unavailable'); },
    setItem(key, value) { saved.setItem(key, value); },
  };
  assert.equal(saveSelectedSkin(storage, 'venom'), true);
  assert.equal(readSelectedSkin(saved), 'venom');
  assert.deepEqual(saved.writes, [{ key: preferenceKey, value: 'venom' }]);
});

test('reading and selecting skins has no effect on the same seeded race simulation', () => {
  const baseline = new RaceSimulation(73, 'hard');
  const withSelections = new RaceSimulation(73, 'hard');
  const storage = new MemoryStorage();
  baseline.start();
  withSelections.start();
  for (let frame = 0; frame < 360; frame++) {
    const id = SKIN_ORDER[frame % SKIN_ORDER.length];
    assert.equal(saveSelectedSkin(storage, id), true);
    assert.equal(readSelectedSkin(storage), id);
    const input = { ...EMPTY_INPUT, throttle: true, steer: Math.sin(frame / 30) * 0.15,
      boost: frame % 120 < 20, drift: frame % 90 > 50 };
    baseline.update(1 / 60, input);
    withSelections.update(1 / 60, input);
  }
  assert.deepEqual(withSelections.state, baseline.state);
});
