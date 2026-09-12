import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { GameAudio } from '../src/audio';

class MockParam {
  value = 0;
  readonly events: { method: string; value: number; time: number }[] = [];
  setValueAtTime(value: number, time: number): void { this.record('set', value, time); }
  setTargetAtTime(value: number, time: number, constant: number): void {
    assert.ok(Number.isFinite(constant) && constant > 0);
    this.record('target', value, time);
  }
  exponentialRampToValueAtTime(value: number, time: number): void {
    assert.ok(value > 0, 'exponential envelopes always remain positive');
    this.record('exponential', value, time);
  }
  cancelAndHoldAtTime(time: number): void { this.record('hold', this.value, time); }
  cancelScheduledValues(time: number): void { this.record('cancel', this.value, time); }
  private record(method: string, value: number, time: number): void {
    assert.ok(Number.isFinite(value));
    assert.ok(Number.isFinite(time) && time >= 0);
    this.value = value;
    this.events.push({ method, value, time });
  }
}

class MockNode {
  readonly gain = new MockParam();
  readonly frequency = new MockParam();
  readonly detune = new MockParam();
  readonly Q = new MockParam();
  readonly pan = new MockParam();
  readonly delayTime = new MockParam();
  readonly threshold = new MockParam();
  readonly knee = new MockParam();
  readonly ratio = new MockParam();
  readonly attack = new MockParam();
  readonly release = new MockParam();
  readonly connections = new Set<unknown>();
  type = '';
  buffer: unknown = null;
  loop = false;
  disconnected = false;
  constructor(readonly context: MockContext, readonly kind: string) { context.nodes.push(this); }
  connect(destination: unknown): unknown { this.connections.add(destination); return destination; }
  disconnect(): void { this.disconnected = true; this.connections.clear(); }
}

class MockSource extends MockNode {
  onended: (() => void) | null = null;
  startTime = Infinity;
  stopTime = Infinity;
  ended = false;
  start(time = this.context.currentTime): void {
    assert.ok(Number.isFinite(time) && time >= this.context.currentTime, 'no stale scheduling');
    this.startTime = time;
    this.context.sources.add(this);
    this.context.started.push(this);
  }
  stop(time = this.context.currentTime): void {
    assert.ok(Number.isFinite(time) && time >= 0);
    if (!this.ended) this.stopTime = time;
  }
  flush(): void {
    if (this.ended || this.stopTime > this.context.currentTime) return;
    this.ended = true;
    this.context.sources.delete(this);
    this.onended?.();
  }
}

class MockContext {
  currentTime = 0;
  sampleRate = 12000;
  state: AudioContextState = 'running';
  readonly nodes: MockNode[] = [];
  readonly destination = new MockNode(this, 'destination');
  readonly sources = new Set<MockSource>();
  readonly started: MockSource[] = [];
  readonly listeners = new Set<() => void>();
  closeCount = 0;
  constructor() { contexts.push(this); }
  createGain(): MockNode { return new MockNode(this, 'gain'); }
  createDynamicsCompressor(): MockNode { return new MockNode(this, 'compressor'); }
  createDelay(): MockNode { return new MockNode(this, 'delay'); }
  createBiquadFilter(): MockNode { return new MockNode(this, 'filter'); }
  createStereoPanner(): MockNode { return new MockNode(this, 'pan'); }
  createConvolver(): MockNode { return new MockNode(this, 'convolver'); }
  createOscillator(): MockSource { return new MockSource(this, 'oscillator'); }
  createBufferSource(): MockSource { return new MockSource(this, 'buffer'); }
  createBuffer(channels: number, length: number): { getChannelData(channel: number): Float32Array } {
    assert.ok(Number.isInteger(length) && length > 0);
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { getChannelData: (channel: number) => data[channel] };
  }
  addEventListener(type: string, callback: () => void): void { assert.equal(type, 'statechange'); this.listeners.add(callback); }
  removeEventListener(type: string, callback: () => void): void { assert.equal(type, 'statechange'); this.listeners.delete(callback); }
  setState(state: AudioContextState): void {
    this.state = state;
    for (const callback of this.listeners) callback();
  }
  async resume(): Promise<void> { this.setState('running'); }
  async close(): Promise<void> { this.closeCount++; this.setState('closed'); }
  advance(seconds: number): void {
    this.currentTime += seconds;
    for (const source of [...this.sources]) source.flush();
  }
}

const feedbackCues = ['warning', 'hitConfirm', 'driftReady', 'charged'] as const;
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
let timers: Map<number, () => void>;
let contexts: MockContext[];
let fixtures: GameAudio[];
let documentState: { hidden: boolean };

function replaceGlobal(key: string, value: unknown): void {
  originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
}

beforeEach(() => {
  contexts = [];
  fixtures = [];
  timers = new Map();
  documentState = { hidden: false };
  const storage = new Map<string, string>();
  replaceGlobal('window', { AudioContext: MockContext });
  replaceGlobal('document', documentState);
  replaceGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  });
  let timerId = 0;
  replaceGlobal('setInterval', (callback: () => void, delay: number) => {
    assert.equal(delay, 32);
    timers.set(++timerId, callback);
    return timerId;
  });
  replaceGlobal('clearInterval', (id: number) => { timers.delete(id); });
});

afterEach(() => {
  try {
    for (const audio of fixtures) audio.dispose();
    for (const context of contexts) {
      context.advance(1);
      assert.equal(context.listeners.size, 0, 'audio and music state listeners are removed');
      assert.equal(context.sources.size, 0, 'continuous and transient sources are stopped');
    }
    assert.equal(timers.size, 0, 'music schedulers do not survive disposal');
  } finally {
    for (const [key, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    originalGlobals.clear();
  }
});

async function setup() {
  const audio = new GameAudio();
  fixtures.push(audio);
  audio.setMusicEnabled(false);
  audio.setPhase('racing');
  await audio.unlock();
  assert.equal(contexts.length, fixtures.length, 'unlock builds a usable audio graph');
  const context = contexts.at(-1)!;
  assert.equal(context.started.length, 5, 'three engine oscillators and two noise beds exist');
  return { audio, context };
}

function playSources(audio: GameAudio, context: MockContext, type: Parameters<GameAudio['play']>[0]) {
  const offset = context.started.length;
  audio.play(type);
  return context.started.slice(offset);
}

test('feedback cues use distinct short scores, separate from the damage thud and drift release', async () => {
  const { audio, context } = await setup();
  const signatures: string[] = [];
  for (const cue of [...feedbackCues, 'hit', 'drift'] as const) {
    const now = context.currentTime;
    const sources = playSources(audio, context, cue);
    assert.ok(sources.length >= 2, `${cue} produces a layered cue`);
    assert.ok(sources.every(source => source.stopTime - now < 0.4), `${cue} stays concise`);
    signatures.push(JSON.stringify(sources.map(source => ({
      kind: source.kind, wave: source.type,
      start: Number((source.startTime - now).toFixed(3)),
      duration: Number((source.stopTime - source.startTime).toFixed(3)),
      frequencies: source.frequency.events.map(event => event.value),
    }))));
    context.advance(1);
    assert.ok(sources.every(source => source.disconnected && source.onended === null), 'finished effects clean up');
  }
  assert.equal(new Set(signatures).size, signatures.length);

  const ownHit = playSources(audio, context, 'hitConfirm');
  assert.ok(ownHit.every(source => source.kind === 'oscillator' && source.frequency.events[0].value > 1000));
  const damage = playSources(audio, context, 'hit');
  assert.equal(damage[0].frequency.events[0].value, 80);
  assert.equal(damage[1].kind, 'buffer');
});

test('incoming warning is two separated pulses and is limited to one cue every 650ms', async () => {
  const { audio, context } = await setup();
  const first = playSources(audio, context, 'warning');
  assert.equal(first.length, 2);
  assert.equal(first[0].type, 'triangle');
  assert.equal(first[1].type, 'triangle');
  assert.ok(first[1].startTime > first[0].stopTime, 'the two pulses have a quiet gap');
  for (let frame = 0; frame < 64; frame++) {
    context.advance(0.01);
    assert.equal(playSources(audio, context, 'warning').length, 0, 'frame-by-frame threats do not create a siren');
  }
  context.advance(0.011);
  assert.equal(playSources(audio, context, 'warning').length, 2);
});

test('each feedback cue has an independent cooldown and readiness never repeats every frame', async () => {
  const { audio, context } = await setup();
  for (const cue of feedbackCues) {
    assert.ok(playSources(audio, context, cue).length > 0);
    assert.equal(playSources(audio, context, cue).length, 0);
  }
  context.advance(0.1);
  assert.equal(playSources(audio, context, 'driftReady').length, 0);
  assert.equal(playSources(audio, context, 'charged').length, 0);
  context.advance(0.6);
  for (const cue of feedbackCues) assert.ok(playSources(audio, context, cue).length > 0);
});

test('warning, hit-confirmation and charged cues briefly duck music without changing user volume', async () => {
  const { audio, context } = await setup();
  for (const cue of ['warning', 'hitConfirm', 'charged'] as const) {
    const now = context.currentTime;
    const eventCounts = context.nodes.map(node => node.gain.events.length);
    audio.play(cue);
    const duckEvents = context.nodes.flatMap((node, index) => node.gain.events.slice(eventCounts[index] ?? 0))
      .filter(event => event.method === 'target');
    assert.ok(duckEvents.some(event => event.time === now && event.value > 0 && event.value < 0.7));
    assert.ok(duckEvents.some(event => event.time > now && event.value === 1), 'music returns smoothly');
    assert.equal(audio.musicVolume, 0.4);
    assert.equal(audio.effectsVolume, 0.8);
    context.advance(1);
  }
});

for (const mode of ['paused', 'menu', 'countdown', 'finished', 'unfocused', 'hidden', 'muted', 'zero-effects', 'suspended'] as const) {
  test(`${mode} suppresses feedback without consuming its cooldown or queuing sounds`, async () => {
    const { audio, context } = await setup();
    switch (mode) {
      case 'unfocused': audio.setFocused(false); break;
      case 'hidden': documentState.hidden = true; break;
      case 'muted': audio.setMuted(true); break;
      case 'zero-effects': audio.setEffectsVolume(0); break;
      case 'suspended': context.setState('suspended'); break;
      default: audio.setPhase(mode);
    }
    const nodeCount = context.nodes.length;
    for (const cue of feedbackCues) assert.equal(playSources(audio, context, cue).length, 0);
    assert.equal(context.nodes.length, nodeCount, 'suppressed effects allocate no nodes');
    documentState.hidden = false;
    audio.setMuted(false);
    audio.setEffectsVolume(0.8);
    audio.setFocused(true);
    context.setState('running');
    audio.setPhase('racing');
    assert.equal(context.nodes.length, nodeCount, 'returning does not replay blocked sounds');
    assert.equal(playSources(audio, context, 'warning').length, 2, 'a current threat can alert immediately');
  });
}

test('pausing, hiding, muting, zero effects and suspension cancel pending warning pulses', async () => {
  const { audio, context } = await setup();
  const interruptions = [
    () => audio.setPhase('paused'),
    () => audio.setFocused(false),
    () => { documentState.hidden = true; audio.setFocused(true); },
    () => audio.setMuted(true),
    () => audio.setEffectsVolume(0),
    () => context.setState('suspended'),
  ];
  for (const interrupt of interruptions) {
    const sources = playSources(audio, context, 'warning');
    assert.equal(sources.length, 2);
    interrupt();
    assert.ok(sources.every(source => source.disconnected && source.onended === null));
    assert.ok(sources.every(source => source.stopTime === context.currentTime), 'including the not-yet-started pulse');
    documentState.hidden = false;
    audio.setMuted(false);
    audio.setEffectsVolume(0.8);
    audio.setFocused(true);
    context.setState('running');
    audio.setPhase('racing');
    context.advance(1);
  }
});

test('paused menu clicks remain available while gameplay sounds are blocked', async () => {
  const { audio, context } = await setup();
  audio.setPhase('paused');
  assert.equal(playSources(audio, context, 'hit').length, 0);
  assert.equal(playSources(audio, context, 'click').length, 1);
});

test('dispose stops feedback and music, removes listeners and cannot unlock or schedule again', async () => {
  const { audio, context } = await setup();
  audio.setMusicEnabled(true);
  assert.equal(timers.size, 1);
  const sources = playSources(audio, context, 'charged');
  const gainNodes = sources.flatMap(source => [...source.connections]) as MockNode[];
  audio.dispose();
  audio.dispose();
  await audio.unlock();
  const nodeCount = context.nodes.length;
  for (const cue of feedbackCues) audio.play(cue);
  assert.equal(context.nodes.length, nodeCount);
  assert.equal(context.closeCount, 1);
  assert.equal(context.listeners.size, 0);
  assert.equal(timers.size, 0);
  assert.ok(sources.every(source => source.disconnected && source.onended === null));
  assert.ok(gainNodes.every(node => node.disconnected), 'pending one-shot gains also release without waiting for onended');
  assert.equal(audio.snapshot.contextState, 'locked');
});
