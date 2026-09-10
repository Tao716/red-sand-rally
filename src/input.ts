import type { InputState } from './types';

type TouchControl = 'throttle' | 'brake' | 'left' | 'right' | 'drift' | 'boost' | 'item';
type ActivePointer = { control: TouchControl; element: HTMLElement };

const TOUCH_CONTROLS = new Set<TouchControl>([
  'throttle', 'brake', 'left', 'right', 'drift', 'boost', 'item',
]);

const HANDLED_CODES = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'ShiftLeft', 'ShiftRight', 'KeyE', 'KeyR', 'Escape', 'KeyP',
]);

const KEY_FALLBACK: Record<string, string> = {
  w: 'KeyW', a: 'KeyA', s: 'KeyS', d: 'KeyD', e: 'KeyE', r: 'KeyR', p: 'KeyP',
  arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight', ' ': 'Space', shift: 'ShiftLeft', escape: 'Escape',
};

/** One input instance is shared by every race; restart only needs clear(). */
export class GameInput {
  private readonly keys = new Set<string>();
  private readonly pointers = new Map<number, ActivePointer>();
  private itemPending = false;
  private resetPending = false;
  private touchContainer: HTMLElement | null = null;
  private previousTouchAction = '';
  private disposed = false;

  constructor(private readonly onPause: (reason?: 'keyboard' | 'blur') => void) {
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
  }

  read(): InputState {
    const touched = (control: TouchControl): boolean => {
      for (const pointer of this.pointers.values()) {
        if (pointer.control === control) return true;
      }
      return false;
    };
    const left = this.keys.has('KeyA') || this.keys.has('ArrowLeft') || touched('left');
    const right = this.keys.has('KeyD') || this.keys.has('ArrowRight') || touched('right');
    const result: InputState = {
      throttle: this.keys.has('KeyW') || this.keys.has('ArrowUp') || touched('throttle'),
      brake: this.keys.has('KeyS') || this.keys.has('ArrowDown') || touched('brake'),
      steer: Number(right) - Number(left),
      drift: this.keys.has('Space') || touched('drift'),
      boost: this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || touched('boost'),
      useItem: this.itemPending,
      reset: this.resetPending,
    };
    this.itemPending = false;
    this.resetPending = false;
    return result;
  }

  clear(): void {
    this.keys.clear();
    this.itemPending = false;
    this.resetPending = false;
    this.releasePointers();
  }

  bindTouch(container: HTMLElement): void {
    if (this.disposed || this.touchContainer === container) return;
    this.unbindTouch();
    this.touchContainer = container;
    this.previousTouchAction = container.style.touchAction;
    container.style.touchAction = 'none';
    container.addEventListener('pointerdown', this.handlePointerDown, { passive: false });
    container.addEventListener('pointerup', this.handlePointerEnd);
    container.addEventListener('pointercancel', this.handlePointerEnd);
    container.addEventListener('lostpointercapture', this.handlePointerEnd);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    this.unbindTouch();
    this.clear();
  }

  private isEditable(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    if (target.closest('input, textarea, select')) return true;
    return target instanceof HTMLElement && target.isContentEditable;
  }

  private getCode(event: KeyboardEvent): string {
    return HANDLED_CODES.has(event.code) ? event.code : (KEY_FALLBACK[event.key.toLowerCase()] ?? '');
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (this.isEditable(event.target)) return;
    const code = this.getCode(event);
    if (!HANDLED_CODES.has(code)) return;
    // Escape must be cancelled before onPause can synchronously show a dialog:
    // otherwise this same key's native cancel action immediately closes it.
    // Driving also works while a HUD button still has keyboard focus.
    if (code === 'Escape' || code === 'Space' || code.startsWith('Arrow')) event.preventDefault();
    const alreadyDown = this.keys.has(code);
    this.keys.add(code);
    if (event.repeat || alreadyDown) return;
    if (code === 'KeyE') this.itemPending = true;
    if (code === 'KeyR') this.resetPending = true;
    if (code === 'Escape' || code === 'KeyP') this.onPause('keyboard');
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    // Always release: focus may have moved to an editable field since keydown.
    this.keys.delete(this.getCode(event));
  };

  private readonly handleBlur = (): void => {
    this.clear();
    this.onPause('blur');
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (!(event.target instanceof Element) || !this.touchContainer || event.button > 0) return;
    const element = event.target.closest<HTMLElement>('[data-control]');
    if (!element || !this.touchContainer.contains(element)) return;
    const control = element.dataset.control as TouchControl;
    if (!TOUCH_CONTROLS.has(control)) return;
    event.preventDefault();
    this.pointers.set(event.pointerId, { control, element });
    element.classList.add('is-pressed');
    if (control === 'item') this.itemPending = true;
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      // A pointer can be cancelled by the browser between dispatch and capture.
      this.removePointer(event.pointerId);
    }
  };

  private readonly handlePointerEnd = (event: PointerEvent): void => {
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer) return;
    if (event.cancelable) event.preventDefault();
    this.removePointer(event.pointerId);
    try {
      if (pointer.element.hasPointerCapture(event.pointerId)) {
        pointer.element.releasePointerCapture(event.pointerId);
      }
    } catch {
      // A detached control or cancelled touch no longer owns its capture.
    }
  };

  private removePointer(pointerId: number): void {
    const pointer = this.pointers.get(pointerId);
    this.pointers.delete(pointerId);
    if (!pointer) return;
    const stillHeld = [...this.pointers.values()].some(({ element }) => element === pointer.element);
    if (!stillHeld) pointer.element.classList.remove('is-pressed');
  }

  private releasePointers(): void {
    const pointers = [...this.pointers.entries()];
    this.pointers.clear();
    for (const [id, pointer] of pointers) {
      pointer.element.classList.remove('is-pressed');
      try {
        if (pointer.element.hasPointerCapture(id)) pointer.element.releasePointerCapture(id);
      } catch {
        // Safe when a touch control has been removed during a screen change.
      }
    }
  }

  private unbindTouch(): void {
    this.releasePointers();
    if (!this.touchContainer) return;
    this.touchContainer.removeEventListener('pointerdown', this.handlePointerDown);
    this.touchContainer.removeEventListener('pointerup', this.handlePointerEnd);
    this.touchContainer.removeEventListener('pointercancel', this.handlePointerEnd);
    this.touchContainer.removeEventListener('lostpointercapture', this.handlePointerEnd);
    this.touchContainer.style.touchAction = this.previousTouchAction;
    this.touchContainer = null;
  }
}
