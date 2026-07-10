// Transient visual feedback: push/clash rings, elimination falls, parry flash,
// and the hitstop that makes a good reflect *feel* good (PRD §8).
//
// prefers-reduced-motion disables the hitstop and the fall drama, keeping the
// game legible without the theatrics.

import type { SimEventLike } from '../../shared/protocol';
import { TUNING } from '../../shared/tuning';

const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

interface Ring {
  pos: { x: number; y: number };
  t0: number;
  dur: number;
  color: string;
  maxR: number;
}
interface Fall {
  pos: { x: number; y: number };
  vel: { x: number; y: number };
  t0: number;
  color: string;
}

export class Effects {
  rings: Ring[] = [];
  falls: Fall[] = [];
  flash = 0;
  private hitstopUntil = 0;

  handle(e: SimEventLike, colorOf: (id: string) => string, now: number): void {
    switch (e.kind) {
      case 'push':
        this.rings.push({ pos: { ...e.pos }, t0: now, dur: 220, color: '#f5f2e8', maxR: TUNING.push.range });
        break;
      case 'ghostPush':
        this.rings.push({ pos: { ...e.pos }, t0: now, dur: 220, color: '#f5f2e8', maxR: TUNING.ghost.range });
        break;
      case 'clash':
        this.rings.push({ pos: { ...e.pos }, t0: now, dur: 260, color: '#4dd8ff', maxR: 70 });
        this.flash = 1;
        if (!reduced) this.hitstopUntil = now + 60;
        break;
      case 'reflect':
        this.rings.push({ pos: { ...e.pos }, t0: now, dur: 200, color: '#4dd8ff', maxR: 44 });
        break;
      case 'eliminated':
        if (!reduced) {
          this.falls.push({ pos: { ...e.pos }, vel: { x: 0, y: 0 }, t0: now, color: colorOf(e.playerId) });
        }
        break;
    }
  }

  isFrozen(now: number): boolean {
    return now < this.hitstopUntil;
  }

  decay(): void {
    if (this.flash > 0) this.flash = Math.max(0, this.flash - 0.08);
  }
}
