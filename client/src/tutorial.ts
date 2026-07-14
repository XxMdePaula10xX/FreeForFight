// First-run "Treino": a learn-by-doing tutorial that only advances when the
// player performs the REAL action with the live controls. Skippable at any time,
// replayable from "Como jogar". Teaches move -> A (empurrar) -> B (refletir na
// hora certa) -> a word on the whiff punishment, then drops into a real match.

import type { LocalGame, HumanInput } from './local';
import type { InputState } from './input';
import type { SimEvent } from '../../shared/types';

const IDLE: HumanInput = { dir: { x: 0, y: 0 }, push: false, reflect: false };
const STEP_COUNT = 5;

const TEXT = [
  'Arraste na metade esquerda da tela pra <b>mover</b>.',
  'Toque <b>A</b> pra <b>empurrar</b> o Boneco!',
  'O Boneco vai atacar. Toque <b>B</b> na hora certa pra <b>refletir</b> e devolver o empurrão!',
  'Refletir na hora <b>errada</b> te deixa parado e vulnerável por um instante. Tenha paciência e leia o ataque.',
  'Pronto! A arena vai <b>encolher</b> — o último de pé vence. Boa sorte. 🥋',
];
const CUE = '⚡ <b>AGORA!</b> Toque B!';

export class Tutorial {
  private i = 0;
  private stepT = 0;
  private moveAcc = 0;
  private s3 = { phase: 'wind' as 'wind' | 'cue' | 'lunge' | 'cool', timer: 0 };
  private reflectRecentT = -9999;
  private advanceAt = 0; // stepT at which to auto-advance (0 = none)
  private finished = false;

  private root: HTMLElement;
  private textEl: HTMLElement;
  private dotsEl: HTMLElement;
  private joyHint: HTMLElement;
  private card: HTMLElement;
  private pushBtn: HTMLElement;
  private reflectBtn: HTMLElement;

  constructor(private g: LocalGame, private onDone: () => void) {
    this.root = document.getElementById('tutorial')!;
    this.textEl = document.getElementById('tutText')!;
    this.dotsEl = document.getElementById('tutDots')!;
    this.joyHint = document.getElementById('tutJoyHint')!;
    this.card = this.root.querySelector('.tut-card')!;
    this.pushBtn = document.getElementById('pushBtn')!;
    this.reflectBtn = document.getElementById('reflectBtn')!;
    document.getElementById('tutSkip')!.onclick = () => this.skip();
  }

  start(): void {
    this.g.startTraining();
    this.buildDots();
    this.root.classList.remove('hidden');
    this.enter(0);
  }

  skip(): void {
    this.finish();
  }

  active(): boolean {
    return !this.finished;
  }
  get stepIndex(): number {
    return this.i;
  }

  private enter(i: number): void {
    this.i = i;
    this.stepT = 0;
    this.moveAcc = 0;
    this.advanceAt = 0;
    this.s3 = { phase: 'wind', timer: 0 };
    this.textEl.innerHTML = TEXT[i];
    this.card.classList.remove('cue');
    this.setDots(i);

    // per-step scene setup
    if (i === 0) {
      this.g.placeTraining({ x: 0, y: 110 }, { x: 0, y: -150 });
      this.highlight('joy');
    } else if (i === 1) {
      this.g.placeTraining({ x: -45, y: 0 }, { x: 58, y: 0 });
      this.highlight('A');
    } else if (i === 2) {
      this.g.placeTraining({ x: -35, y: 0 }, { x: 45, y: 0 });
      this.highlight('B');
    } else {
      this.highlight(null);
    }
  }

  private next(): void {
    if (this.i >= STEP_COUNT - 1) this.finish();
    else this.enter(this.i + 1);
  }

  // Called once per animation frame with the latest input, this frame's sim
  // events, and dt in ms. Also responsible for driving the dummy.
  update(sample: InputState, events: SimEvent[], dt: number): void {
    if (this.finished) return;
    this.stepT += dt;
    if (sample.reflect) this.reflectRecentT = this.stepT;

    // waiting out a praise/pause before advancing
    if (this.advanceAt > 0) {
      this.g.setDummyInput(IDLE);
      if (this.stepT >= this.advanceAt) {
        this.advanceAt = 0;
        this.next();
      }
      return;
    }

    switch (this.i) {
      case 0: {
        const moving = Math.hypot(sample.dir.x, sample.dir.y) > 0.1;
        this.moveAcc = moving ? this.moveAcc + dt : Math.max(0, this.moveAcc - dt * 0.5);
        this.g.setDummyInput(IDLE);
        if (this.moveAcc >= 450) this.next();
        break;
      }
      case 1: {
        this.g.setDummyInput(IDLE);
        if (events.some((e) => e.kind === 'push' && e.playerId === 'you')) this.next();
        break;
      }
      case 2: {
        this.driveDummyAttack(dt);
        const parried =
          events.some((e) => e.kind === 'clash' && e.playerId === 'you') &&
          this.stepT - this.reflectRecentT < 280;
        if (parried) {
          this.textEl.innerHTML = 'Perfeito! Você <b>devolveu</b> o empurrão. 💥';
          this.card.classList.remove('cue');
          this.highlight(null);
          this.advanceAt = this.stepT + 1100; // savour it, then move on
        }
        break;
      }
      case 3:
        this.g.setDummyInput(IDLE);
        if (this.stepT > 4200) this.next();
        break;
      case 4:
        this.g.setDummyInput(IDLE);
        if (this.stepT > 2800) this.finish();
        break;
      default:
        // parked (-2) between step 2 success and advance
        this.g.setDummyInput(IDLE);
        break;
    }
  }

  // Dummy: walk in, telegraph, lunge (push), recover, repeat until parried.
  private driveDummyAttack(dt: number): void {
    const you = this.g.discById('you');
    const dummy = this.g.discById('dummy');
    if (!you || !dummy) return;
    const dx = you.pos.x - dummy.pos.x;
    const dy = you.pos.y - dummy.pos.y;
    const dist = Math.hypot(dx, dy) || 1;
    const toYou = { x: dx / dist, y: dy / dist };
    const s = this.s3;
    s.timer += dt;
    switch (s.phase) {
      case 'wind':
        this.g.setDummyInput({ dir: toYou, push: false, reflect: false });
        if (dist < 96 && s.timer > 650) {
          s.phase = 'cue';
          s.timer = 0;
          this.card.classList.add('cue');
          this.textEl.innerHTML = CUE;
        }
        break;
      case 'cue':
        // Lead the lunge by ~reaction time so pressing B ON the cue leaves your
        // 180ms reflect window open WHEN the push lands (else it always whiffs).
        this.g.setDummyInput(IDLE);
        if (s.timer > 340) {
          s.phase = 'lunge';
          s.timer = 0;
        }
        break;
      case 'lunge':
        this.g.setDummyInput({ dir: { x: 0, y: 0 }, push: true, reflect: false });
        s.phase = 'cool';
        s.timer = 0;
        break;
      case 'cool':
        this.g.setDummyInput(IDLE);
        if (s.timer > 300) {
          this.card.classList.remove('cue');
          this.textEl.innerHTML = TEXT[2];
        }
        if (s.timer > 1500) {
          s.phase = 'wind';
          s.timer = 0;
        }
        break;
    }
  }

  private highlight(which: 'joy' | 'A' | 'B' | null): void {
    this.pushBtn.classList.toggle('hl', which === 'A');
    this.reflectBtn.classList.toggle('hl', which === 'B');
    this.joyHint.classList.toggle('hidden', which !== 'joy');
  }

  private buildDots(): void {
    this.dotsEl.innerHTML = '';
    for (let k = 0; k < STEP_COUNT; k++) {
      const d = document.createElement('span');
      d.className = 'tut-dot';
      this.dotsEl.appendChild(d);
    }
  }
  private setDots(active: number): void {
    this.dotsEl.querySelectorAll('.tut-dot').forEach((d, k) => {
      d.classList.toggle('on', k <= active);
    });
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.g.training = false;
    this.highlight(null);
    this.root.classList.add('hidden');
    try {
      localStorage.setItem('octogono_tutorial_done', '1');
    } catch {
      /* private mode — fine, they just see it again */
    }
    this.onDone();
  }
}
