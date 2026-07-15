// Canvas 2D renderer. The subject is impact; the signature is the shrinking
// border (chalk erased, a red line advancing over the tatame, the floor falling
// into the void). Now with: an atmospheric lit dojo floor, wood planks, a centre
// emblem, top-down sumô fighters, dust/sparks/embers, and screen shake.

import { TUNING, PLAYER_COLORS } from '../../shared/tuning';
import { vertices } from '../../shared/octagon';
import type { RenderDisc } from './net';
import type { Effects } from './effects';
import { drawFighter, drawGhostFighter, shade } from './sprites';
import { settings } from './settings';
import type { PlayerInfo, Phase } from '../../shared/protocol';

const C = {
  void: '#0d0b0f',
  tatame: '#1c1a24',
  marca: '#f5f2e8',
  perigo: '#ff4d2e',
  reflexo: '#4dd8ff',
};

const PUSH_CD_TICKS = Math.round((TUNING.push.cooldown / 1000) * 60);
const REFLECT_CD_TICKS = Math.round((TUNING.reflect.cooldown / 1000) * 60);
const PUSH_ANIM_TICKS = Math.round((TUNING.push.duration / 1000) * 60);
const REFLECT_ACTIVE_TICKS = Math.round((TUNING.reflect.active / 1000) * 60);

// A distinct shape per player index — identity that survives colour blindness.
function drawGlyph(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, idx: number, color: string): void {
  ctx.save();
  ctx.beginPath();
  const k = ((idx % 4) + 4) % 4;
  if (k === 0) {
    ctx.arc(x, y, r * 0.7, 0, Math.PI * 2);
  } else if (k === 1) {
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y + r * 0.8);
    ctx.lineTo(x - r, y + r * 0.8);
    ctx.closePath();
  } else if (k === 2) {
    ctx.rect(x - r * 0.75, y - r * 0.75, r * 1.5, r * 1.5);
  } else {
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
  }
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

export interface RenderInput {
  discs: RenderDisc[];
  arenaRadius: number;
  clientTick: number;
  phase: Phase;
  players: PlayerInfo[];
  selfId: string;
  scores: Record<string, number>;
  countdownLeft: number;
  roundTimeLeft: number;
  roundWinnerId: string | null;
  matchWinnerId: string | null;
  scoreToWin: number;
  corePresent: boolean;
}

interface AnimState {
  facing: number;
  walkPhase: number;
  push: number;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  W = 0;
  H = 0;
  private dpr = 1;
  scale = 1;
  cx = 0;
  cy = 0;
  safeTop = 0; // iOS status-bar / notch inset so the scoreboard clears it
  private vignette: CanvasGradient | null = null; // cached; rebuilt only on resize
  private anim = new Map<string, AnimState>();
  private lastNow = performance.now();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = window.innerWidth;
    this.H = window.innerHeight;
    this.canvas.width = this.W * this.dpr;
    this.canvas.height = this.H * this.dpr;
    this.canvas.style.width = this.W + 'px';
    this.canvas.style.height = this.H + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const margin = 70;
    this.scale = Math.min(this.W, this.H - margin) / (TUNING.arena.startRadius * 2.15);
    this.cx = this.W / 2;
    this.cy = (this.H + margin * 0.3) / 2;
    // rebuild the cached vignette (only changes with viewport size)
    const vg = this.ctx.createRadialGradient(
      this.cx, this.cy, Math.min(this.W, this.H) * 0.35,
      this.cx, this.cy, Math.max(this.W, this.H) * 0.75,
    );
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.55)');
    this.vignette = vg;
  }

  private toScreen(p: { x: number; y: number }): { x: number; y: number } {
    return { x: this.cx + p.x * this.scale, y: this.cy + p.y * this.scale };
  }

  private octPath(r: number): void {
    const vs = vertices(r);
    this.ctx.beginPath();
    for (let i = 0; i < vs.length; i++) {
      const s = this.toScreen(vs[i]);
      if (i === 0) this.ctx.moveTo(s.x, s.y);
      else this.ctx.lineTo(s.x, s.y);
    }
    this.ctx.closePath();
  }

  draw(input: RenderInput, effects: Effects, now: number): void {
    const ctx = this.ctx;
    const dt = Math.min(0.05, (now - this.lastNow) / 1000);
    this.lastNow = now;

    // full-screen void (never shakes, so edges stay black)
    ctx.fillStyle = C.void;
    ctx.fillRect(0, 0, this.W, this.H);

    // screen shake offset for the arena layer
    const sh = effects.shake;
    const shx = sh > 0 ? (Math.random() - 0.5) * sh : 0;
    const shy = sh > 0 ? (Math.random() - 0.5) * sh : 0;

    ctx.save();
    ctx.translate(shx, shy);

    const r = input.arenaRadius;
    this.drawFloor(r, now);
    this.drawBorder(r, now, effects);
    if (input.corePresent) this.drawCore(now);
    this.drawFalls(effects, now);
    this.drawParticles(effects, effects.particles, 1);
    this.drawFighters(input, effects, dt, now);
    this.drawRings(effects, now);
    this.drawParticles(effects, effects.embers, 0.9);

    ctx.restore();

    // full-screen flash (parry) — above the shake layer
    if (effects.flash > 0) {
      ctx.fillStyle = `rgba(77,216,255,${effects.flash * 0.16})`;
      ctx.fillRect(0, 0, this.W, this.H);
    }
    // dark vignette for depth
    this.drawVignette();

    this.drawHud(input);
  }

  // ---- arena floor: warm light, wood planks, centre emblem ----------------
  private drawFloor(r: number, now: number): void {
    const ctx = this.ctx;
    this.octPath(r);
    ctx.save();
    ctx.clip();

    // base + warm overhead light pooling near the centre
    const g = ctx.createRadialGradient(this.cx, this.cy - r * this.scale * 0.15, r * this.scale * 0.1, this.cx, this.cy, r * this.scale * 1.2);
    g.addColorStop(0, '#2a2532');
    g.addColorStop(0.6, C.tatame);
    g.addColorStop(1, '#141119');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.W, this.H);

    // wood planks
    const plankW = 46 * this.scale * (TUNING.arena.startRadius / 340);
    ctx.lineWidth = 1;
    for (let px = this.cx - r * this.scale; px < this.cx + r * this.scale; px += plankW) {
      ctx.strokeStyle = 'rgba(0,0,0,0.16)';
      ctx.beginPath();
      ctx.moveTo(px, this.cy - r * this.scale);
      ctx.lineTo(px, this.cy + r * this.scale);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(245,242,232,0.02)';
      ctx.beginPath();
      ctx.moveTo(px + 1, this.cy - r * this.scale);
      ctx.lineTo(px + 1, this.cy + r * this.scale);
      ctx.stroke();
    }

    // guide rings + centre dojo emblem
    ctx.strokeStyle = 'rgba(245,242,232,0.05)';
    ctx.lineWidth = 1;
    this.octPath(r * 0.62);
    ctx.stroke();

    const er = r * 0.24 * this.scale;
    ctx.save();
    ctx.translate(this.cx, this.cy);
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = 'rgba(245,242,232,0.08)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, er, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, er * 0.66, 0, Math.PI * 2);
    ctx.stroke();
    // subtle rotating diamond mark
    const rot = now / 6000;
    ctx.rotate(rot);
    ctx.strokeStyle = 'rgba(245,242,232,0.06)';
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = (Math.PI / 2) * i;
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a) * er * 0.5, Math.sin(a) * er * 0.5);
    }
    ctx.stroke();
    ctx.restore();

    ctx.restore();
  }

  // ---- shrinking border: chalk memory + advancing danger line + embers ----
  private drawBorder(r: number, now: number, effects: Effects): void {
    const ctx = this.ctx;
    const startR = TUNING.arena.startRadius;

    if (r < startR - 1) {
      this.octPath(startR);
      ctx.strokeStyle = 'rgba(245,242,232,0.05)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    const danger = 1 - clamp((r - TUNING.arena.endRadius) / (startR - TUNING.arena.endRadius), 0, 1);

    // spawn embers rising off the hot border, more as it closes in (probability
    // clamped < 1 so it stays stochastic; effects caps the total count)
    if (Math.random() < Math.min(0.85, danger * 1.1)) {
      const vs = vertices(r);
      const e = Math.floor(Math.random() * 8);
      const a = vs[e];
      const b = vs[(e + 1) % 8];
      const t = Math.random();
      effects.spawnEmber({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }

    // outer glow
    this.octPath(r);
    ctx.strokeStyle = C.perigo;
    ctx.lineWidth = 2.5 + danger * 4;
    ctx.shadowColor = C.perigo;
    ctx.shadowBlur = 10 + danger * 28 + (0.5 + 0.5 * Math.sin(now / 130)) * danger * 14;
    ctx.stroke();
    ctx.shadowBlur = 0;
    // crisp chalk inner edge
    this.octPath(r);
    ctx.strokeStyle = 'rgba(245,242,232,0.5)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  private drawParticles(_effects: Effects, arr: import('./effects').Particle[], glow: number): void {
    const ctx = this.ctx;
    // NOTE: never set ctx.shadowBlur inside this loop — a per-particle gaussian
    // blur is the #1 Canvas2D mobile cost. For "glow" particles (embers) we fake
    // bloom with a single larger, translucent arc instead.
    for (const p of arr) {
      const k = 1 - p.life / p.maxLife;
      const s = this.toScreen(p);
      const rr = p.size * this.scale * (0.5 + k * 0.5);
      ctx.fillStyle = p.color;
      if (glow < 1) {
        ctx.globalAlpha = k * 0.22;
        ctx.beginPath();
        ctx.arc(s.x, s.y, rr * 2.3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = k * glow;
      ctx.beginPath();
      ctx.arc(s.x, s.y, rr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  private drawFalls(effects: Effects, now: number): void {
    const ctx = this.ctx;
    for (let i = effects.falls.length - 1; i >= 0; i--) {
      const f = effects.falls[i];
      const t = (now - f.t0) / 320;
      if (t >= 1) {
        effects.falls.splice(i, 1);
        continue;
      }
      const s = this.toScreen(f.pos);
      ctx.globalAlpha = 1 - t;
      ctx.beginPath();
      ctx.arc(s.x, s.y + t * 40, TUNING.disc.radius * this.scale * (1 - t * 0.7), 0, Math.PI * 2);
      ctx.fillStyle = shade(f.color, -0.2 - t * 0.5);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  private drawFighters(input: RenderInput, effects: Effects, dt: number, now: number): void {
    for (const d of input.discs) {
      if (!d.alive) continue;
      const st = this.animFor(d, input, dt);
      const s = this.toScreen(d.pos);
      const rad = TUNING.disc.radius * this.scale;
      const color = this.colorOf(d.playerId, input);

      if (d.ghost) {
        drawGhostFighter(this.ctx, s.x, s.y, rad, color, now / 500);
        continue;
      }

      // a soft ground spotlight in your colour makes "you" unmistakable in a scrum
      if (d.isSelf) this.selfSpotlight(s.x, s.y, rad, color, now);

      // reflect states drawn under the fighter for a clear read
      this.reflectAura(d, s.x, s.y, rad, input.clientTick);

      const speed = Math.hypot(d.vel.x, d.vel.y);
      const moving = clamp(speed / TUNING.disc.maxSpeed, 0, 1);
      if (moving > 0.35) effects.dust(d.pos, { x: d.vel.x / (speed || 1), y: d.vel.y / (speed || 1) }, shade(color, -0.3));

      drawFighter(this.ctx, s.x, s.y, rad, {
        color,
        facing: st.facing,
        moving,
        walkPhase: st.walkPhase,
        pushing: st.push,
        squash: st.push * 0.4,
      });

      // armed with a Super Empurrão (picked up the Núcleo). A white ring under
      // the gold keeps it readable even on the yellow player (colours collide).
      if (input.clientTick < d.coreChargeUntil) {
        const pulse = 0.5 + 0.5 * Math.sin(now / 90);
        const rr = rad + 6 + pulse * 4;
        this.ctx.beginPath();
        this.ctx.arc(s.x, s.y, rr + 2, 0, Math.PI * 2);
        this.ctx.strokeStyle = C.marca;
        this.ctx.lineWidth = 2;
        this.ctx.stroke();
        this.ctx.beginPath();
        this.ctx.arc(s.x, s.y, rr, 0, Math.PI * 2);
        this.ctx.strokeStyle = '#ffdf6b';
        this.ctx.lineWidth = 3;
        this.ctx.shadowColor = '#ffdf6b';
        this.ctx.shadowBlur = 14;
        this.ctx.stroke();
        this.ctx.shadowBlur = 0;
      }

      if (d.isSelf) this.selfMarker(s.x, s.y, rad, now);
      // colour-blind aid: a distinct shape badge on every fighter
      drawGlyph(this.ctx, s.x, s.y + rad * 0.16, rad * 0.34, this.idxOf(color), 'rgba(13,11,15,0.85)');
      this.cooldownArcs(d, input, s.x, s.y, rad);
    }
  }

  private idxOf(color: string): number {
    const i = (PLAYER_COLORS as readonly string[]).indexOf(color);
    return i < 0 ? 0 : i;
  }

  private animFor(d: RenderDisc, input: RenderInput, dt: number): AnimState {
    let st = this.anim.get(d.playerId);
    if (!st) {
      st = { facing: Math.atan2(d.pos.y, d.pos.x) + Math.PI, walkPhase: 0, push: 0 };
      this.anim.set(d.playerId, st);
    }
    const speed = Math.hypot(d.vel.x, d.vel.y);
    if (speed > 12) {
      const target = Math.atan2(d.vel.y, d.vel.x);
      st.facing = lerpAngle(st.facing, target, 1 - Math.exp(-14 * dt));
    }
    st.walkPhase += dt * (6 + (speed / TUNING.disc.maxSpeed) * 14);
    const pushing = input.clientTick < d.pushAnimUntil && input.clientTick >= d.pushAnimUntil - PUSH_ANIM_TICKS;
    const targetPush = pushing ? 1 : 0;
    st.push += (targetPush - st.push) * (1 - Math.exp(-18 * dt));
    return st;
  }

  private reflectAura(d: RenderDisc, x: number, y: number, rad: number, clientTick: number): void {
    const ctx = this.ctx;
    if (d.reflectState === 'active') {
      // A crisp SNAP that eases out over exactly the 180ms window — reads as a
      // timed event, not a slow pulse. `snap` is 1 at the instant you parry.
      const snap = clamp((d.reflectUntil - clientTick) / REFLECT_ACTIVE_TICKS, 0, 1);
      // shield ring
      ctx.beginPath();
      ctx.arc(x, y, rad + 7, 0, Math.PI * 2);
      ctx.strokeStyle = C.reflexo;
      ctx.lineWidth = 3 + snap * 3;
      ctx.shadowColor = C.reflexo;
      ctx.shadowBlur = 8 + snap * 22;
      ctx.stroke();
      ctx.shadowBlur = 0;
      // fill
      ctx.beginPath();
      ctx.arc(x, y, rad + 7, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(77,216,255,${0.06 + snap * 0.12})`;
      ctx.fill();
      // collapsing timing ring — visualises the window closing
      const tr = rad + 4 + snap * rad * 1.9;
      ctx.beginPath();
      ctx.arc(x, y, tr, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(125,230,255,${0.25 + snap * 0.55})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    } else if (d.reflectState === 'recovery') {
      ctx.beginPath();
      ctx.arc(x, y, rad + 6, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,77,46,0.75)';
      ctx.lineWidth = 3;
      ctx.setLineDash([5, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // The Núcleo: a pulsing power orb at the centre. Touch it for a Super Empurrão.
  private drawCore(now: number): void {
    const ctx = this.ctx;
    const s = this.toScreen({ x: 0, y: 0 });
    const R = TUNING.core.radius * this.scale;
    const pulse = 0.72 + 0.28 * Math.sin(now / 180);
    const spin = now / 700;
    ctx.save();
    ctx.shadowColor = '#ffdf6b';
    ctx.shadowBlur = 18 + pulse * 22;
    const g = ctx.createRadialGradient(s.x, s.y, R * 0.1, s.x, s.y, R * pulse);
    g.addColorStop(0, '#fffbe6');
    g.addColorStop(0.5, '#ffdf6b');
    g.addColorStop(1, 'rgba(255,160,40,0.2)');
    ctx.beginPath();
    ctx.arc(s.x, s.y, R * pulse, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.shadowBlur = 0;
    // rotating ring of sparks
    ctx.strokeStyle = 'rgba(255,223,107,0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(s.x, s.y, R * (1.5 + 0.1 * pulse), spin, spin + Math.PI * 1.4);
    ctx.stroke();
    ctx.restore();
  }

  private selfSpotlight(x: number, y: number, rad: number, color: string, now: number): void {
    const ctx = this.ctx;
    const pulse = 0.85 + 0.15 * Math.sin(now / 500);
    const R = rad * 2.4 * pulse;
    const g = ctx.createRadialGradient(x, y, rad * 0.3, x, y, R);
    g.addColorStop(0, color);
    g.addColorStop(1, 'transparent');
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private selfMarker(x: number, y: number, rad: number, now: number): void {
    const ctx = this.ctx;
    // little bouncing chevron above your own fighter
    const bob = Math.sin(now / 260) * 3;
    ctx.fillStyle = C.marca;
    ctx.beginPath();
    ctx.moveTo(x, y - rad - 14 + bob);
    ctx.lineTo(x - 6, y - rad - 22 + bob);
    ctx.lineTo(x + 6, y - rad - 22 + bob);
    ctx.closePath();
    ctx.fill();
  }

  private cooldownArcs(d: RenderDisc, input: RenderInput, x: number, y: number, rad: number): void {
    if (input.clientTick < d.pushCooldownUntil) {
      const frac = clamp((d.pushCooldownUntil - input.clientTick) / PUSH_CD_TICKS, 0, 1);
      this.arc(x, y, rad + 4, -Math.PI / 2, -Math.PI / 2 + (1 - frac) * Math.PI * 2, C.marca, 3);
    }
    if (d.isSelf && input.clientTick < d.reflectCooldownUntil) {
      const frac = clamp((d.reflectCooldownUntil - input.clientTick) / REFLECT_CD_TICKS, 0, 1);
      this.arc(x, y, rad + 11, -Math.PI / 2, -Math.PI / 2 + (1 - frac) * Math.PI * 2, C.reflexo, 2.5);
    }
  }

  private drawRings(effects: Effects, now: number): void {
    const ctx = this.ctx;
    for (let i = effects.rings.length - 1; i >= 0; i--) {
      const ring = effects.rings[i];
      const t = (now - ring.t0) / ring.dur;
      if (t >= 1) {
        effects.rings.splice(i, 1);
        continue;
      }
      const s = this.toScreen(ring.pos);
      const ease = 1 - (1 - t) * (1 - t);
      ctx.beginPath();
      ctx.arc(s.x, s.y, (TUNING.disc.radius + ease * ring.maxR) * this.scale, 0, Math.PI * 2);
      ctx.strokeStyle = ring.color;
      ctx.globalAlpha = (1 - t) * 0.9;
      ctx.lineWidth = ring.width * (1 - t) + 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  private drawVignette(): void {
    const ctx = this.ctx;
    ctx.fillStyle = this.vignette ?? 'rgba(0,0,0,0)';
    ctx.fillRect(0, 0, this.W, this.H);
  }

  private arc(x: number, y: number, r: number, a0: number, a1: number, color: string, w: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, r, a0, a1);
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  private drawHud(input: RenderInput): void {
    const ctx = this.ctx;
    ctx.textBaseline = 'middle';

    // top scoreboard strip on a subtle panel
    const players = input.players;
    const n = Math.max(players.length, 1);
    const gap = Math.min(180, (this.W - 40) / n);
    const total = (n - 1) * gap;
    let x = this.W / 2 - total / 2;
    const top = this.safeTop;
    const lt = settings.largeText ? 1.22 : 1;
    const nameFont = `700 ${Math.round(14 * lt)}px 'Archivo Variable', 'Archivo Black', system-ui, sans-serif`;
    for (const p of players) {
      const disc = input.discs.find((d) => d.playerId === p.id);
      const alive = disc ? disc.alive && !disc.ghost : false;
      ctx.globalAlpha = alive || input.phase !== 'playing' ? 1 : 0.4;
      // shaped + coloured token (shape = colour-blind safe identity)
      ctx.shadowColor = p.color;
      ctx.shadowBlur = alive && input.phase === 'playing' ? 10 : 0;
      drawGlyph(ctx, x - 52, top + 26, 8, this.idxOf(p.color), p.color);
      ctx.shadowBlur = 0;
      ctx.font = nameFont;
      ctx.fillStyle = p.id === input.selfId ? C.marca : '#c7c2d2';
      ctx.textAlign = 'left';
      const score = input.scores[p.id] ?? p.score ?? 0;
      ctx.fillText(p.nickname, x - 40, top + 20);
      // score pips
      ctx.font = `800 ${Math.round(13 * lt)}px 'JetBrains Mono', monospace`;
      ctx.fillStyle = p.color;
      ctx.fillText('◆'.repeat(score) + '◇'.repeat(Math.max(0, input.scoreToWin - score)), x - 40, top + 34);
      ctx.globalAlpha = 1;
      x += gap;
    }

    // Archivo Black only ships a 400 face — request 400 (never 900) to avoid
    // synthetic faux-bold on an already ultra-heavy display face.
    ctx.textAlign = 'center';
    if (input.phase === 'countdown') {
      const left = Math.ceil(input.countdownLeft);
      ctx.font = `400 ${Math.round(96 * lt)}px 'Archivo Black', system-ui, sans-serif`;
      ctx.fillStyle = C.marca;
      ctx.shadowColor = C.perigo;
      ctx.shadowBlur = 24;
      ctx.fillText(left > 0 ? String(left) : 'VAI!', this.W / 2, this.cy);
      ctx.shadowBlur = 0;
    } else if (input.phase === 'playing') {
      ctx.font = `700 ${Math.round(15 * lt)}px 'JetBrains Mono', monospace`;
      const urgent = input.roundTimeLeft < 10;
      ctx.fillStyle = urgent ? C.perigo : '#8d8898';
      if (urgent) {
        ctx.shadowColor = C.perigo;
        ctx.shadowBlur = 12;
      }
      ctx.fillText(input.roundTimeLeft.toFixed(1) + 's', this.W / 2, top + 52);
      ctx.shadowBlur = 0;
    } else if (input.phase === 'round_end') {
      const w = input.roundWinnerId;
      ctx.font = `400 ${Math.round(44 * lt)}px 'Archivo Black', system-ui, sans-serif`;
      ctx.fillStyle = w ? this.colorOf(w, input) : '#8d8898';
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 12;
      ctx.fillText(w ? `${this.nameOf(w, input)} venceu a rodada` : 'Empate', this.W / 2, this.cy);
      ctx.shadowBlur = 0;
    }
  }

  private colorOf(id: string, input: RenderInput): string {
    return input.players.find((p) => p.id === id)?.color ?? PLAYER_COLORS[0];
  }
  private nameOf(id: string, input: RenderInput): string {
    return input.players.find((p) => p.id === id)?.nickname ?? '???';
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function lerpAngle(a: number, b: number, t: number): number {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
