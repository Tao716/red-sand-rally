import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { GameInput } from '../src/input';

type MockEvent = Record<string, unknown> & {
  target: unknown;
  cancelable: boolean;
  prevented: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
};

/** The input adapter only needs event delivery, not a layout/browser dependency. */
class EventHub {
  private listeners = new Map<string, Set<(event: MockEvent) => void>>();

  addEventListener(type: string, handler: (event: MockEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(handler);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, handler: (event: MockEvent) => void): void {
    this.listeners.get(type)?.delete(handler);
  }

  emit(type: string, values: Record<string, unknown> = {}): MockEvent {
    const event: MockEvent = {
      target: this,
      cancelable: true,
      prevented: false,
      defaultPrevented: false,
      preventDefault() { this.prevented = true; this.defaultPrevented = true; },
      ...values,
    };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }

  get listenerCount(): number {
    return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0);
  }
}

class MockElement extends EventHub {
  readonly style = { touchAction: 'pan-y' };
  readonly dataset: Record<string, string> = {};
  readonly captures = new Set<number>();
  readonly classes = new Set<string>();
  readonly classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
    contains: (name: string) => this.classes.has(name),
  };
  isContentEditable = false;
  parent: MockElement | null = null;

  constructor(readonly tagName = 'BUTTON') { super(); }

  append(element: MockElement): MockElement {
    element.parent = this;
    return element;
  }

  contains(element: MockElement): boolean {
    for (let current: MockElement | null = element; current; current = current.parent) {
      if (current === this) return true;
    }
    return false;
  }

  closest(selector: string): MockElement | null {
    for (let current: MockElement | null = this; current; current = current.parent) {
      if (selector === '[data-control]' && current.dataset.control) return current;
      if (selector === 'input, textarea, select' && ['INPUT', 'TEXTAREA', 'SELECT'].includes(current.tagName)) return current;
    }
    return null;
  }

  setPointerCapture(id: number): void { this.captures.add(id); }
  hasPointerCapture(id: number): boolean { return this.captures.has(id); }
  releasePointerCapture(id: number): void { this.captures.delete(id); }
}

const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
let eventWindow: EventHub;
let instances: GameInput[];

beforeEach(() => {
  eventWindow = new EventHub();
  instances = [];
  for (const [name, value] of [['window', eventWindow], ['Element', MockElement], ['HTMLElement', MockElement]] as const) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

afterEach(() => {
  for (const input of instances) input.dispose();
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originalGlobals.clear();
});

function createInput(onPause: (reason?: 'keyboard' | 'blur') => void = () => {}): GameInput {
  const input = new GameInput(onPause);
  instances.push(input);
  return input;
}

function key(type: 'keydown' | 'keyup', code: string, values: Record<string, unknown> = {}): MockEvent {
  return eventWindow.emit(type, { code, key: code, repeat: false, ...values });
}

function touchControl(container: MockElement, control: string): MockElement {
  const element = container.append(new MockElement());
  element.dataset.control = control;
  return element;
}

function bind(input: GameInput, container: MockElement): void {
  input.bindTouch(container as unknown as HTMLElement);
}

const neutral = {
  throttle: false, brake: false, steer: 0, drift: false,
  boost: false, useItem: false, reset: false,
};

test('WASD, arrows, drift and both Shift keys are held controls', () => {
  const input = createInput();
  assert.deepEqual(input.read(), neutral);
  key('keydown', 'KeyW');
  key('keydown', 'ArrowDown');
  key('keydown', 'KeyA');
  key('keydown', 'Space');
  key('keydown', 'ShiftLeft');
  assert.deepEqual(input.read(), {
    ...neutral, throttle: true, brake: true, steer: -1, drift: true, boost: true,
  });
  key('keydown', 'ArrowRight');
  assert.equal(input.read().steer, 0, 'opposite directions cancel');
  key('keyup', 'KeyA');
  assert.equal(input.read().steer, 1);
  key('keydown', 'ShiftRight');
  key('keyup', 'ShiftLeft');
  assert.equal(input.read().boost, true, 'either Shift can keep boost held');
  key('keyup', 'ShiftRight');
  assert.equal(input.read().boost, false);
  input.clear();
  assert.deepEqual(input.read(), neutral);
});

test('item and reset are consume-on-read edges and ignore keyboard repeats', () => {
  const input = createInput();
  key('keydown', 'KeyE');
  key('keydown', 'KeyR');
  assert.deepEqual(input.read(), { ...neutral, useItem: true, reset: true });
  assert.deepEqual(input.read(), neutral);
  key('keydown', 'KeyE', { repeat: true });
  key('keydown', 'KeyR', { repeat: true });
  key('keydown', 'KeyE');
  assert.deepEqual(input.read(), neutral, 'even duplicate non-repeat keydown is not a new press');
  key('keyup', 'KeyE');
  key('keydown', 'KeyE');
  assert.equal(input.read().useItem, true);
  key('keyup', 'KeyR');
  key('keydown', 'KeyR');
  assert.equal(input.read().reset, true);
});

test('Space and arrows prevent page scroll, text fields do not capture driving keys', () => {
  const input = createInput();
  for (const code of ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
    assert.equal(key('keydown', code).prevented, true);
  }
  input.clear();
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
    const target = new MockElement(tagName);
    key('keydown', 'KeyW', { target });
    assert.equal(key('keydown', 'Space', { target }).prevented, false);
    assert.deepEqual(input.read(), neutral);
  }
  const editor = new MockElement('DIV');
  editor.isContentEditable = true;
  key('keydown', 'KeyW', { target: editor });
  assert.equal(input.read().throttle, false);
});

test('HUD button focus still permits driving and keyup releases after focus changes', () => {
  const input = createInput();
  key('keydown', 'KeyW', { target: new MockElement('BUTTON') });
  assert.equal(input.read().throttle, true);
  key('keyup', 'KeyW', { target: new MockElement('INPUT') });
  assert.equal(input.read().throttle, false);
  key('keydown', '', { key: 'w' });
  assert.equal(input.read().throttle, true, 'logical key fallback works without KeyboardEvent.code');
});

test('Escape/P report keyboard once per press, and blur reports its own reason while clearing input', () => {
  const reasons: ('keyboard' | 'blur' | undefined)[] = [];
  const input = createInput((reason) => { reasons.push(reason); input.clear(); });
  assert.equal(key('keydown', 'Escape').defaultPrevented, true);
  assert.equal(key('keydown', 'Escape', { repeat: true }).defaultPrevented, true);
  assert.deepEqual(reasons, ['keyboard']);
  key('keyup', 'Escape');
  assert.equal(key('keydown', 'KeyP').defaultPrevented, false);
  assert.deepEqual(reasons, ['keyboard', 'keyboard']);
  key('keydown', 'KeyW');
  key('keydown', 'KeyE');
  key('keydown', 'KeyR');
  eventWindow.emit('blur');
  assert.deepEqual(reasons, ['keyboard', 'keyboard', 'blur']);
  assert.deepEqual(input.read(), neutral);
});

test('Escape does not natively cancel a dialog synchronously opened by its pause callback', () => {
  let dialogOpen = false;
  let nativeCancelEvents = 0;
  createInput((reason) => {
    assert.equal(reason, 'keyboard');
    dialogOpen = true;
  });
  const event = key('keydown', 'Escape');
  // Native dialog default handling follows the keydown handler in the browser.
  if (dialogOpen && !event.defaultPrevented) {
    nativeCancelEvents++;
    dialogOpen = false;
  }
  assert.equal(nativeCancelEvents, 0);
  assert.equal(dialogOpen, true);
});

test('touch supports simultaneous controls, captured pointers and one-shot items', () => {
  const input = createInput();
  const container = new MockElement('DIV');
  const throttle = touchControl(container, 'throttle');
  const left = touchControl(container, 'left');
  const item = touchControl(container, 'item');
  const nestedIcon = throttle.append(new MockElement('SPAN'));
  bind(input, container);
  const down = container.emit('pointerdown', { target: nestedIcon, pointerId: 1, button: 0 });
  container.emit('pointerdown', { target: left, pointerId: 2, button: 0 });
  assert.equal(down.prevented, true);
  assert.equal(throttle.hasPointerCapture(1), true);
  assert.equal(throttle.classList.contains('is-pressed'), true);
  assert.deepEqual(input.read(), { ...neutral, throttle: true, steer: -1 });
  container.emit('pointerup', { pointerId: 1 });
  assert.equal(throttle.hasPointerCapture(1), false);
  assert.equal(throttle.classList.contains('is-pressed'), false);
  assert.deepEqual(input.read(), { ...neutral, steer: -1 });
  container.emit('lostpointercapture', { pointerId: 2 });
  assert.deepEqual(input.read(), neutral);
  container.emit('pointerdown', { target: item, pointerId: 3, button: 0 });
  assert.equal(input.read().useItem, true);
  assert.equal(input.read().useItem, false);
  container.emit('pointercancel', { pointerId: 3 });
  assert.equal(item.classList.contains('is-pressed'), false);
});

test('two fingers on the same control retain held state until both release', () => {
  const input = createInput();
  const container = new MockElement('DIV');
  const boost = touchControl(container, 'boost');
  bind(input, container);
  container.emit('pointerdown', { target: boost, pointerId: 1, button: 0 });
  container.emit('pointerdown', { target: boost, pointerId: 2, button: 0 });
  container.emit('pointerup', { pointerId: 1 });
  assert.equal(input.read().boost, true);
  assert.equal(boost.classList.contains('is-pressed'), true);
  container.emit('pointerup', { pointerId: 2 });
  assert.equal(input.read().boost, false);
  assert.equal(boost.classList.contains('is-pressed'), false);
});

test('clear and repeated bind/dispose leave no touches, styles or listeners behind', () => {
  const input = createInput();
  const first = new MockElement('DIV');
  const second = new MockElement('DIV');
  const brake = touchControl(first, 'brake');
  bind(input, first);
  bind(input, first);
  assert.equal(first.listenerCount, 4);
  assert.equal(first.style.touchAction, 'none');
  containerDown(first, brake, 1);
  assert.equal(input.read().brake, true);
  input.clear();
  assert.equal(brake.hasPointerCapture(1), false);
  assert.equal(brake.classList.contains('is-pressed'), false);
  assert.deepEqual(input.read(), neutral);
  bind(input, second);
  assert.equal(first.listenerCount, 0);
  assert.equal(first.style.touchAction, 'pan-y');
  assert.equal(second.listenerCount, 4);
  assert.equal(eventWindow.listenerCount, 3);
  input.dispose();
  input.dispose();
  assert.equal(eventWindow.listenerCount, 0);
  assert.equal(second.listenerCount, 0);
  assert.equal(second.style.touchAction, 'pan-y');
  bind(input, first);
  assert.equal(first.listenerCount, 0, 'disposed input cannot accidentally rebind');
});

function containerDown(container: MockElement, target: MockElement, pointerId: number): void {
  container.emit('pointerdown', { target, pointerId, button: 0 });
}
