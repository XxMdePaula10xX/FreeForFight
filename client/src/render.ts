// Canvas 2D renderer. No engine — ~6 shapes on screen. The subject is impact;
// the signature is the shrinking border (a chalk line erased, a red line
// advancing over the tatame, the floor falling into the void). See PRD §8.

import { TUNING, PLAYER_COLORS } from '../../shared/tuning';
import { vertices } from '../../shared/octagon';
import type { RenderDisc } from './net';
import type { Effects } from './effects';
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

export interface RenderInput {
  discs: RenderDisc[];
  arenaRadius: number;
  clientTick: number;
  phase: Phase;
  players: PlayerInfo[];
  selfId: string;
  scores: Record<string, number>;
  countdownLeft: number; // seconds, only in countdown
  roundTimeLeft: number; // seconds, only while playing
  roundWinnerId: string | null;
  matchWinnerId: string | null;
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
    ctx.fillStyle = C.void;
    ctx.fillRect(0, 0, this.W, this.H);

    const r = input.arenaRadius;
    const startR = TUNING.arena.startRadius;

    // faded chalk of where the border used to be
    if (r < startR - 1) {
      this.octPath(startR);
      ctx.strokeStyle = 'rgba(245,242,232,0.05)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // living floor + void beyond
    this.octPath(r);
    ctx.save();
    ctx.clip();
    ctx.fillStyle = C.tatame;
    ctx.fillRect(0, 0, this.W, this.H);
    ctx.strokeStyle = 'rgba(245,242,232,0.045)';
    ctx.lineWidth = 1;
    this.octPath(r * 0.5);
    ctx.stroke();
    ctx.restore();

    // advancing danger line — brighter/redder as the arena closes
    const danger = 1 - clamp((r - TUNING.arena.endRadius) / (startR - TUNING.arena.endRadius), 0, 1);
    this.octPath(r);
    ctx.strokeStyle = C.perigo;
    ctx.lineWidth = 2.5 + danger * 3.5;
    ctx.shadowColor = C.perigo;
    ctx.shadowBlur = 8 + danger * 26 + (0.5 + 0.5 * Math.sin(now / 140)) * danger * 10;
    ctx.stroke();
    ctx.shadowBlur = 0;
    this.octPath(r);
    ctx.strokeStyle = 'rgba(245,242,232,0.5)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // falling eliminated discs
    for (let i = effects.falls.length - 1; i >= 0; i--) {
      const f = effects.falls[i];
      const t = (now - f.t0) / 300;
      if (t >= 1) {
        effects.falls.splice(i, 1);
        continue;
      }
      const s = this.toScreen(f.pos);
      ctx.globalAlpha = 1 - t;
      ctx.beginPath();
      ctx.arc(s.x, s.y, TUNING.disc.radius * this.scale * (1 - t * 0.7), 0, Math.PI * 2);
      ctx.fillStyle = f.color;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // discs
    for (const d of input.discs) this.drawDisc(d, input);

    // rings
    for (let i = effects.rings.length - 1; i >= 0; i--) {
      const ring = effects.rings[i];
      const t = (now - ring.t0) / ring.dur;
      if (t >= 1) {
        effects.rings.splice(i, 1);
        continue;
      }
      const s = this.toScreen(ring.pos);
      ctx.beginPath();
      ctx.arc(s.x, s.y, (TUNING.disc.radius + t * ring.maxR) * this.scale, 0, Math.PI * 2);
      ctx.strokeStyle = ring.color;
      ctx.globalAlpha = (1 - t) * 0.9;
      ctx.lineWidth = 3 * (1 - t) + 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // parry flash
    if (effects.flash > 0) {
      ctx.fillStyle = `rgba(77,216,255,${effects.flash * 0.14})`;
      ctx.fillRect(0, 0, this.W, this.H);
    }

    this.drawHud(input);
  }

  private drawDisc(d: RenderDisc, input: RenderInput): void {
    if (!d.alive) return;
    const ctx = this.ctx;
    const s = this.toScreen(d.pos);
    const rad = TUNING.disc.radius * this.scale;
    const color = this.colorOf(d.playerId, input);

    if (d.ghost) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, rad * 0.8, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.28;
      ctx.fill();
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.globalAlpha = 1;
      return;
    }

    if (d.reflectState === 'active') {
      ctx.beginPath();
      ctx.arc(s.x, s.y, rad + 7, 0, Math.PI * 2);
      ctx.strokeStyle = C.reflexo;
      ctx.lineWidth = 4;
      ctx.shadowColor = C.reflexo;
      ctx.shadowBlur = 16;
      ctx.stroke();
      ctx.shadowBlur = 0;
    } else if (d.reflectState === 'recovery') {
      ctx.beginPath();
      ctx.arc(s.x, s.y, rad + 5, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,77,46,0.7)';
      ctx.lineWidth = 3;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // body: flat circle, thick dark border, self gets a marca ring
    ctx.beginPath();
    ctx.arc(s.x, s.y, rad, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = C.void;
    ctx.stroke();
    if (d.isSelf) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, rad - 6, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(245,242,232,0.9)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // cooldown arcs (peripheral-legible: colour & shape, no numbers)
    if (input.clientTick < d.pushCooldownUntil) {
      const frac = clamp((d.pushCooldownUntil - input.clientTick) / PUSH_CD_TICKS, 0, 1);
      this.arc(s.x, s.y, rad + 3, -Math.PI / 2, -Math.PI / 2 + (1 - frac) * Math.PI * 2, C.marca, 2.5);
    }
    if (d.isSelf && input.clientTick < d.reflectCooldownUntil) {
      const frac = clamp((d.reflectCooldownUntil - input.clientTick) / REFLECT_CD_TICKS, 0, 1);
      this.arc(s.x, s.y, rad + 9, -Math.PI / 2, -Math.PI / 2 + (1 - frac) * Math.PI * 2, C.reflexo, 2);
    }
  }

  private arc(x: number, y: number, r: number, a0: number, a1: number, color: string, w: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, r, a0, a1);
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.stroke();
  }

  private drawHud(input: RenderInput): void {
    const ctx = this.ctx;
    ctx.textBaseline = 'middle';

    // top scoreboard strip
    const players = input.players;
    const n = Math.max(players.length, 1);
    const gap = Math.min(170, (this.W - 40) / n);
    const total = (n - 1) * gap;
    let x = this.W / 2 - total / 2;
    ctx.font = "700 14px 'Archivo Black', system-ui, sans-serif";
    for (const p of players) {
      const disc = input.discs.find((d) => d.playerId === p.id);
      const alive = disc ? disc.alive && !disc.ghost : false;
      ctx.globalAlpha = alive || input.phase !== 'playing' ? 1 : 0.4;
      ctx.beginPath();
      ctx.arc(x - 46, 24, 6, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();
      ctx.fillStyle = p.id === input.selfId ? C.marca : '#c7c2d2';
      ctx.textAlign = 'left';
      const score = input.scores[p.id] ?? p.score ?? 0;
      ctx.fillText(`${p.nickname} ${score}`, x - 36, 24);
      ctx.globalAlpha = 1;
      x += gap;
    }

    ctx.textAlign = 'center';
    if (input.phase === 'countdown') {
      const left = Math.ceil(input.countdownLeft);
      ctx.font = "900 84px 'Archivo Black', system-ui, sans-serif";
      ctx.fillStyle = C.marca;
      ctx.fillText(left > 0 ? String(left) : 'VAI!', this.W / 2, this.cy);
    } else if (input.phase === 'playing') {
      ctx.font = "600 13px 'JetBrains Mono', monospace";
      ctx.fillStyle = input.roundTimeLeft < 10 ? C.perigo : '#6d6880';
      ctx.fillText(input.roundTimeLeft.toFixed(1) + 's', this.W / 2, 48);
    } else if (input.phase === 'round_end') {
      const w = input.roundWinnerId;
      ctx.font = "900 40px 'Archivo Black', system-ui, sans-serif";
      ctx.fillStyle = w ? this.colorOf(w, input) : '#6d6880';
      ctx.fillText(w ? `${this.nameOf(w, input)} venceu a rodada` : 'Empate', this.W / 2, this.cy);
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
