import type { Vec2 } from './math';

export type ReflectState = 'idle' | 'active' | 'recovery';

export type Phase = 'lobby' | 'countdown' | 'playing' | 'round_end' | 'match_end';

// The per-frame command a player produces. `dir` is a unit-ish vector.
export interface InputCmd {
  seq: number;
  dir: Vec2;
  push: boolean;
  reflect: boolean;
}

export const EMPTY_INPUT: InputCmd = { seq: 0, dir: { x: 0, y: 0 }, push: false, reflect: false };

// The simulated body. Everything the physics touches lives here.
export interface Disc {
  playerId: string;
  pos: Vec2;
  vel: Vec2;
  alive: boolean;
  ghost: boolean;
  ghostAngle: number; // position on the perimeter when a ghost
  pushCooldownUntil: number; // in ticks
  pushAnimUntil: number; // in ticks — drives the push ring animation
  reflectState: ReflectState;
  reflectUntil: number; // tick the current reflect sub-state ends
  reflectCooldownUntil: number; // tick reflect becomes available again
  coreChargeUntil: number; // tick until which a Super Empurrão is armed (0 = none)
}

// The central power-up ("Núcleo"). Deterministic: spawn/pickup driven by the
// arena radius and tick, never by randomness.
export interface CoreState {
  present: boolean;
  respawnAtTick: number; // earliest tick it may (re)appear
}

// The full simulation state that step() advances. Deterministic: same input
// map + same state -> same next state, on client and server alike.
export interface SimState {
  tick: number;
  roundStartTick: number; // tick at which the `playing` phase began
  arenaRadius: number;
  discs: Disc[];
  core?: CoreState; // the Núcleo (created lazily by step())
}

export type SimEventKind = 'push' | 'reflect' | 'clash' | 'eliminated' | 'ghostPush' | 'core';

// Fire-and-forget feedback. Losing one costs a visual, never correctness.
export interface SimEvent {
  kind: SimEventKind;
  playerId: string;
  pos: Vec2;
  dir?: Vec2; // direction of the shove/knockback, for directional juice
  mag?: number; // 0..1 strength, for magnitude-scaled shake/particles
}

export function makeDisc(playerId: string, pos: Vec2): Disc {
  return {
    playerId,
    pos: { x: pos.x, y: pos.y },
    vel: { x: 0, y: 0 },
    alive: true,
    ghost: false,
    ghostAngle: Math.atan2(pos.y, pos.x),
    pushCooldownUntil: 0,
    pushAnimUntil: 0,
    reflectState: 'idle',
    reflectUntil: 0,
    reflectCooldownUntil: 0,
    coreChargeUntil: 0,
  };
}
