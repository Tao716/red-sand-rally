import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import type { GameAudio } from '../src/audio';
import { RaceFeedbackHUD, threatProtection } from '../src/feedback-hud';
import { RaceSimulation } from '../src/simulation';
import { EMPTY_INPUT } from '../src/types';

class ClassList {
  values = new Set<string>();
  toggle(name: string, force: boolean) { if (force) this.values.add(name); else this.values.delete(name); }
  remove(name: string) { this.values.delete(name); }
  contains(name: string) { return this.values.has(name); }
}
class ElementStub {
  hidden = true;
  textContent = '';
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  classList = new ClassList();
  attributes = new Map<string, string>();
  children = new Map<string, ElementStub>();
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  querySelector(selector: string): ElementStub {
    let child = this.children.get(selector);
    if (!child) { child = new ElementStub(); this.children.set(selector, child); }
    return child;
  }
}
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
let body: ElementStub;
beforeEach(() => {
  body = new ElementStub();
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { body } });
});
afterEach(() => {
  if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
  else Reflect.deleteProperty(globalThis, 'document');
});

function fixture() {
  const simulation = new RaceSimulation();
  simulation.start(); simulation.update(3, EMPTY_INPUT);
  const state = simulation.state, player = state.racers[0];
  Object.assign(player, { distance: 300, speed: 50, lateral: 0, heading: 0 });
  state.racers.slice(1).forEach(racer => { racer.finished = true; });
  const root = new ElementStub(), sounds: string[] = [];
  let touch = false, onScreen = true;
  const audio = { play: (sound: string) => sounds.push(sound) } as unknown as GameAudio;
  const hud = new RaceFeedbackHUD(root as unknown as HTMLElement, audio, () => touch,
    () => onScreen ? { x: 320, y: 200 } : null);
  const node = (id: string) => root.querySelector(`#${id}`);
  const incoming = () => state.projectiles.push({ id: 99, type: 'rocket', owner: 1, target: 0,
    distance: 200, lateral: 0, lifetime: 3, powered: false });
  return { hud, state, player, sounds, node, incoming,
    setTouch: () => { touch = true; }, offScreen: () => { onScreen = false; } };
}

test('empty inventory shows mini-boost progress and readiness once, never item charge zero', () => {
  const f = fixture();
  f.player.driftTime = 0.2; f.hud.update(f.state);
  assert.equal(f.node('drift-label').textContent, '漂移积累');
  assert.equal(f.node('drift-fill').style.width, '40%');
  assert.equal(f.node('drift-charge').hidden, true);
  f.player.driftTime = 0.6;
  f.hud.update(f.state); f.hud.update(f.state);
  assert.equal(f.node('drift-label').textContent, '小喷就绪');
  assert.equal(f.node('drift-hint').textContent, '松开空格释放');
  assert.deepEqual(f.sounds, ['driftReady']);
  f.setTouch(); f.hud.update(f.state);
  assert.equal(f.node('drift-hint').textContent, '松开漂移释放');
  assert.equal(f.sounds.length, 1);
});

test('item charge is independent from release progress and has a separate one-shot cue', () => {
  const f = fixture();
  f.player.item = 'nitro'; f.player.charge = 0.4; f.player.driftTime = 0.7;
  f.hud.update(f.state);
  assert.equal(f.node('drift-label').textContent, '小喷就绪');
  assert.match(f.node('drift-charge').textContent, /道具强化 40%/);
  f.player.charge = 0.995; f.hud.update(f.state); f.hud.update(f.state);
  assert.deepEqual(f.sounds, ['driftReady', 'charged']);
  assert.match(f.node('drift-charge').textContent, /道具已强化/);
  f.player.driftTime = 0;
  f.hud.event({ type: 'reset', racer: 0 }, f.state); f.hud.update(f.state);
  assert.equal(f.sounds.filter(sound => sound === 'charged').length, 1, 'reset preserves the same charged item');
  f.player.item = null; f.player.charge = 0; f.hud.update(f.state);
  assert.equal(f.node('drift-charge').hidden, true);
});

test('pause hides cues without rearming readiness or consuming release confirmation time', () => {
  const f = fixture();
  f.player.driftTime = 0.7; f.hud.update(f.state);
  f.state.phase = 'paused'; f.hud.update(f.state);
  assert.equal(f.node('drift-indicator').hidden, true);
  f.state.phase = 'racing'; f.hud.update(f.state);
  assert.deepEqual(f.sounds, ['driftReady']);
  f.player.driftTime = 0;
  f.hud.event({ type: 'drift', racer: 0 }, f.state); f.hud.update(f.state);
  assert.equal(f.node('drift-label').textContent, '出弯小喷');
  f.state.phase = 'paused'; f.hud.update(f.state);
  f.state.phase = 'racing'; f.hud.update(f.state);
  assert.equal(f.node('drift-indicator').hidden, false);
  f.state.time += 1.1; f.hud.update(f.state);
  assert.equal(f.node('drift-indicator').hidden, true);
});

test('projectile obstruction and a light scrape cannot erase an ongoing mini-boost cue', () => {
  const f = fixture(); f.player.boostTime = 0.7;
  f.hud.event({ type: 'drift', racer: 0 }, f.state);
  f.hud.event({ type: 'collision', racer: 0, text: 'PROJECTILE_BLOCKED', item: 'rocket' }, f.state);
  f.hud.update(f.state);
  assert.equal(f.node('drift-label').textContent, '出弯小喷');
  assert.equal(f.node('drift-indicator').hidden, false);
  f.hud.event({ type: 'collision', racer: 0, strength: 0.12 }, f.state); f.hud.update(f.state);
  assert.equal(f.node('drift-indicator').hidden, false);
  f.player.boostTime = 0;
  f.hud.event({ type: 'collision', racer: 0, strength: 0.7 }, f.state); f.hud.update(f.state);
  assert.equal(f.node('drift-indicator').hidden, true);
});

test('protection only suppresses warnings when it covers impact time with a safety margin', () => {
  const { player } = fixture();
  assert.equal(threatProtection(player, 1), 'none');
  player.shield = 0.8;
  assert.equal(threatProtection(player, 1), 'expiring');
  player.invulnerable = 1.5;
  assert.equal(threatProtection(player, 1), 'invulnerable');
  player.shield = 2;
  assert.equal(threatProtection(player, 1), 'shield');
  player.shield = 1.1; player.invulnerable = 0;
  assert.equal(threatProtection(player, 1), 'expiring');
});

test('incoming warning guides shield use, stays independent, and warns before protection expires', () => {
  const f = fixture(); f.incoming(); f.player.item = 'shield';
  f.hud.update(f.state);
  assert.equal(f.node('threat-warning').hidden, false);
  assert.equal(f.node('threat-warning').dataset.direction, 'rear');
  assert.equal(f.node('threat-action').textContent, '按 E 开启护盾');
  assert.equal(body.classList.contains('has-threat'), true);
  assert.deepEqual(f.sounds, ['warning']);
  f.setTouch(); f.hud.update(f.state);
  assert.equal(f.node('threat-action').textContent, '点道具开启护盾');
  f.player.shield = 2; f.state.time += 1.2; f.hud.update(f.state);
  assert.equal(f.node('threat-warning').dataset.protected, 'true');
  assert.deepEqual(f.sounds, ['warning']);
  f.player.shield = 0.5; f.hud.update(f.state);
  assert.equal(f.node('threat-warning').dataset.protected, 'false');
  assert.match(f.node('threat-action').textContent, /保护即将结束/);
  assert.deepEqual(f.sounds, ['warning', 'warning']);
  f.state.projectiles = []; f.hud.update(f.state);
  assert.equal(f.node('threat-warning').hidden, true);
  assert.equal(body.classList.contains('has-threat'), false);
});

test('target text follows the same target as firing and offscreen reticles do not float at edges', () => {
  const f = fixture(); f.player.item = 'rocket';
  Object.assign(f.state.racers[1], { finished: false, distance: 400, name: 'VEX' });
  f.hud.update(f.state);
  assert.equal(f.node('target-label').textContent, '锁定 VEX · 100 m');
  assert.equal(f.node('target-reticle').hidden, false);
  assert.equal(f.node('target-reticle').style.left, '320px');
  f.offScreen(); f.hud.update(f.state);
  assert.equal(f.node('target-reticle').hidden, true);
  assert.equal(f.node('target-lock').hidden, false);
  f.player.item = null; f.hud.update(f.state);
  assert.equal(f.node('target-lock').hidden, true);
});

test('hit confirmation has its own lifetime and is cleared with every new race or menu', () => {
  const f = fixture(); f.incoming();
  f.hud.event({ type: 'hit', racer: 1, text: 'DIRECT HIT!' }, f.state); f.hud.update(f.state);
  assert.equal(f.node('combat-confirmation').hidden, false);
  assert.match(f.node('combat-confirmation-text').textContent, /命中 VEX/);
  assert.equal(f.node('threat-warning').hidden, false);
  f.state.phase = 'paused'; f.hud.update(f.state);
  assert.equal(f.node('combat-confirmation').hidden, true);
  assert.equal(f.node('threat-warning').hidden, true);
  f.state.phase = 'countdown'; f.hud.update(f.state);
  f.state.phase = 'racing'; f.state.projectiles = []; f.state.time = 0; f.hud.update(f.state);
  assert.equal(f.node('combat-confirmation').hidden, true);
  assert.equal(f.node('threat-warning').hidden, true);
  f.hud.event({ type: 'shield', racer: 0, text: 'BLOCKED!' }, f.state); f.hud.update(f.state);
  assert.equal(f.node('combat-confirmation-text').textContent, '护盾拦截成功');
  f.state.time += 1.2; f.hud.update(f.state);
  assert.equal(f.node('combat-confirmation').hidden, true);
  f.state.phase = 'menu'; f.hud.update(f.state);
  assert.equal(body.classList.contains('has-threat'), false);
});
