// Input: keyboard (desktop) + virtual joystick & two buttons (mobile).
// One stick, two buttons. Nothing more (PRD §5).

export interface InputState {
  dir: { x: number; y: number };
  push: boolean;
  reflect: boolean;
}

export class InputController {
  private keys = new Set<string>();
  private joyDir = { x: 0, y: 0 };
  private joyActive = false;
  private touchPush = false;
  private touchReflect = false;

  private joyBase: HTMLElement;
  private joyStick: HTMLElement;
  private pushBtn: HTMLElement;
  private reflectBtn: HTMLElement;
  private joyPointerId: number | null = null;
  private joyCenter = { x: 0, y: 0 };

  constructor(root: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    this.joyBase = root.querySelector('#joyBase')!;
    this.joyStick = root.querySelector('#joyStick')!;
    this.pushBtn = root.querySelector('#pushBtn')!;
    this.reflectBtn = root.querySelector('#reflectBtn')!;

    this.setupJoystick();
    this.setupButton(this.pushBtn, (v) => (this.touchPush = v));
    this.setupButton(this.reflectBtn, (v) => (this.touchReflect = v));
  }

  private setupJoystick(): void {
    const zone = this.joyBase.parentElement!; // the whole left half acts as the joystick zone
    const maxR = 52;
    const onDown = (e: PointerEvent) => {
      if (this.joyPointerId !== null) return;
      this.joyPointerId = e.pointerId;
      this.joyActive = true;
      this.joyCenter = { x: e.clientX, y: e.clientY };
      this.joyBase.style.left = `${e.clientX}px`;
      this.joyBase.style.top = `${e.clientY}px`;
      this.joyBase.style.opacity = '1';
      this.joyStick.style.transform = 'translate(-50%, -50%)';
      zone.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== this.joyPointerId) return;
      let dx = e.clientX - this.joyCenter.x;
      let dy = e.clientY - this.joyCenter.y;
      const len = Math.hypot(dx, dy);
      const clamped = Math.min(len, maxR);
      const nx = len > 0 ? dx / len : 0;
      const ny = len > 0 ? dy / len : 0;
      this.joyStick.style.transform = `translate(calc(-50% + ${nx * clamped}px), calc(-50% + ${ny * clamped}px))`;
      const dead = 0.18;
      const mag = Math.min(1, len / maxR);
      this.joyDir = mag < dead ? { x: 0, y: 0 } : { x: nx, y: ny };
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== this.joyPointerId) return;
      this.joyPointerId = null;
      this.joyActive = false;
      this.joyDir = { x: 0, y: 0 };
      this.joyBase.style.opacity = '0';
      this.joyStick.style.transform = 'translate(-50%, -50%)';
    };
    zone.addEventListener('pointerdown', onDown);
    zone.addEventListener('pointermove', onMove);
    zone.addEventListener('pointerup', onUp);
    zone.addEventListener('pointercancel', onUp);
  }

  private setupButton(el: HTMLElement, set: (v: boolean) => void): void {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      set(true);
      el.classList.add('pressed');
    });
    const release = () => {
      set(false);
      el.classList.remove('pressed');
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('pointerleave', release);
  }

  sample(): InputState {
    let x = 0;
    let y = 0;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) y -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) y += 1;

    let dir = { x, y };
    if (x === 0 && y === 0 && this.joyActive) dir = { ...this.joyDir };

    const push = this.keys.has('Space') || this.touchPush;
    const reflect = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.touchReflect;
    return { dir, push, reflect };
  }
}
