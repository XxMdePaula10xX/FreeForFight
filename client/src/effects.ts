// Transient visual feedback: push/clash rings, elimination bursts, parry flash,
// dust, sparks, ambient embers, screen shake, and the hitstop that makes a good
// reflect *feel* good (PRD §8).
//
// This layer is pure decoration — Math.random() is fine here (it never touches
// the simulation). prefers-reduced-motion keeps it legible without theatrics.

import type { SimEventLike } from '../../shared/protocol';
import { TUNING } from '../../shared/tuning';
import { settings } from './settings';

const reduced = () => settings.reducedMotion;

interface Ring {
  pos: { x: number; y: number };
  t0: number;
  dur: number;
  color: string;
  maxR: number;
  width: number;
}
interface Fall {
  pos: { x: number; y: number };
  vel: { x: number; y: number };
  t0: number;
  color: string;
}
export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  drag: number;
}

// World-space coords for rings/falls (physics units); particles too.
export class Effects {
  rings: Ring[] = [];
  falls: Fall[] = [];
  particles: Particle[] = [];
  embers: Particle[] = [];
  flash = 0;
  shake = 0;
  private hitstopUntil = 0;

  handle(e: SimEventLike, colorOf: (id: string) => string, now: number): void {
    const mag = e.mag ?? 0.4;
    switch (e.kind) {
      case 'push':
        this.rings.push({ pos: { ...e.pos }, t0: now, dur: 240, color: '#f5f2e8', maxR: TUNING.push.range, width: 4 });
        // shove cone biased along the push direction, brighter with force
        this.burst(e.pos, '#f5f2e8', 8 + Math.round(mag * 8), 140 + mag * 160, e.dir);
        this.shake = Math.max(this.shake, 2 + mag * 4);
        break;
      case 'ghostPush':
        this.rings.push({ pos: { ...e.pos }, t0: now, dur: 220, color: '#c7c2d2', maxR: TUNING.ghost.range, width: 3 });
        break;
      case 'clash':
        this.rings.push({ pos: { ...e.pos }, t0: now, dur: 300, color: '#4dd8ff', maxR: 90, width: 6 });
        this.burst(e.pos, '#4dd8ff', 18, 260, e.dir);
        this.burst(e.pos, '#ffffff', 8, 200, e.dir);
        this.flash = 1;
        this.shake = Math.max(this.shake, 6 + mag * 6);
        if (!reduced()) this.hitstopUntil = now + 70;
        break;
      case 'reflect':
        this.rings.push({ pos: { ...e.pos }, t0: now, dur: 220, color: '#4dd8ff', maxR: 48, width: 3 });
        break;
      case 'core':
        this.rings.push({ pos: { ...e.pos }, t0: now, dur: 340, color: '#ffdf6b', maxR: 90, width: 5 });
        this.burst(e.pos, '#ffdf6b', 22, 280);
        this.burst(e.pos, '#fffbe6', 8, 200);
        break;
      case 'eliminated':
        this.shake = Math.max(this.shake, 8);
        this.burst(e.pos, colorOf(e.playerId), 24, 320);
        if (!reduced()) this.falls.push({ pos: { ...e.pos }, vel: { x: 0, y: 0 }, t0: now, color: colorOf(e.playerId) });
        break;
    }
  }

  // A spray of sparks in world space. With `dir`, biases into a forward cone.
  burst(pos: { x: number; y: number }, color: string, n: number, speed: number, dir?: { x: number; y: number }): void {
    if (reduced()) return;
    const base = dir ? Math.atan2(dir.y, dir.x) : 0;
    const hasDir = !!dir && (dir.x !== 0 || dir.y !== 0);
    for (let i = 0; i < n; i++) {
      const a = hasDir ? base + (Math.random() - 0.5) * 1.1 : Math.random() * Math.PI * 2;
      const sp = speed * (0.4 + Math.random() * 0.6);
      this.particles.push({
        x: pos.x,
        y: pos.y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0,
        maxLife: 0.3 + Math.random() * 0.4,
        size: 1.5 + Math.random() * 2.5,
        color,
        drag: 3.5,
      });
    }
  }

  // Dust kicked up behind a moving fighter (world space).
  dust(pos: { x: number; y: number }, dir: { x: number; y: number }, color: string): void {
    if (reduced() || Math.random() > 0.4) return;
    this.particles.push({
      x: pos.x - dir.x * 20,
      y: pos.y - dir.y * 20,
      vx: -dir.x * 30 + (Math.random() - 0.5) * 40,
      vy: -dir.y * 30 + (Math.random() - 0.5) * 40,
      life: 0,
      maxLife: 0.4 + Math.random() * 0.3,
      size: 2 + Math.random() * 3,
      color,
      drag: 4,
    });
  }

  // Ambient embers that rise near the shrinking danger border.
  spawnEmber(pos: { x: number; y: number }): void {
    if (reduced()) return;
    this.embers.push({
      x: pos.x,
      y: pos.y,
      vx: (Math.random() - 0.5) * 20,
      vy: -20 - Math.random() * 30,
      life: 0,
      maxLife: 1.0 + Math.random() * 1.2,
      size: 1 + Math.random() * 2,
      color: '#ff6a3d',
      drag: 0.6,
    });
  }

  isFrozen(now: number): boolean {
    return now < this.hitstopUntil;
  }

  // Advance particles & decay flash/shake by real dt seconds.
  update(dt: number): void {
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 5);
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 45);
    this.step(this.particles, dt);
    this.step(this.embers, dt);
  }

  private step(arr: Particle[], dt: number): void {
    for (let i = arr.length - 1; i >= 0; i--) {
      const p = arr[i];
      p.life += dt;
      if (p.life >= p.maxLife) {
        arr.splice(i, 1);
        continue;
      }
      const d = Math.exp(-p.drag * dt);
      p.vx *= d;
      p.vy *= d;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
  }
}
