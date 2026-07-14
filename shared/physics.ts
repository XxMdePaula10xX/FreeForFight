// The whole game, in one deterministic function.
//
// step(state, inputs, dt) advances the simulation exactly one tick and returns
// the feedback events it produced. The SAME function runs on the server (the
// single source of truth) and on the client (prediction + reconciliation), so
// it must be pure with respect to its inputs: no Math.random(), no Date.now(),
// no wall-clock — only `state` and `inputs`.
//
// Order of a tick (PRD §6.2, extended with push/reflect resolution):
//   A. advance reflect/push timers from input
//   B. apply input acceleration (self-propulsion) to velocities
//   C. resolve pushes -> impulses (attacker recoil, targets, reflect returns)
//   D. integrate positions
//   E. disc-disc collisions (overlap separation + elastic impulse)
//   F. eliminate anyone whose centre left the octagon

import {
  TUNING,
  PUSH_COOLDOWN_TICKS,
  REFLECT_ACTIVE_TICKS,
  REFLECT_RECOVERY_TICKS,
  REFLECT_COOLDOWN_TICKS,
  GHOST_COOLDOWN_TICKS,
  SHRINK_START_TICKS,
  SHRINK_DURATION_TICKS,
} from './tuning';
import type { Vec2 } from './math';
import { clamp, lerp, normalize } from './math';
import { outsideDepth, boundaryDistanceAlong } from './octagon';
import type { Disc, InputCmd, SimState, SimEvent } from './types';
import { EMPTY_INPUT } from './types';

const D = TUNING.disc;
const P = TUNING.push;
const R = TUNING.reflect;
const G = TUNING.ghost;

export type InputMap = Map<string, InputCmd>;

// The arena's circumradius as a function of how long the round has been live.
export function arenaRadiusAt(tick: number, roundStartTick: number): number {
  const elapsed = tick - roundStartTick;
  if (elapsed <= SHRINK_START_TICKS) return TUNING.arena.startRadius;
  const t = (elapsed - SHRINK_START_TICKS) / SHRINK_DURATION_TICKS;
  if (t >= 1) return TUNING.arena.endRadius;
  return lerp(TUNING.arena.startRadius, TUNING.arena.endRadius, t);
}

function countAlive(state: SimState): number {
  let n = 0;
  for (const d of state.discs) if (d.alive && !d.ghost) n++;
  return n;
}

// Advance one tick. Mutates `state`, returns events for feedback.
export function step(state: SimState, inputs: InputMap, dt: number): SimEvent[] {
  const events: SimEvent[] = [];
  const tick = state.tick;
  state.arenaRadius = arenaRadiusAt(tick, state.roundStartTick);

  // ---- A. reflect / push timer transitions -------------------------------
  for (const disc of state.discs) {
    if (!disc.alive) continue;
    const input = inputs.get(disc.playerId) ?? EMPTY_INPUT;

    if (disc.ghost) continue; // ghosts have their own, simpler rules below

    // Reflect state machine.
    if (disc.reflectState === 'active' && tick >= disc.reflectUntil) {
      disc.reflectState = 'recovery';
      disc.reflectUntil = tick + REFLECT_RECOVERY_TICKS;
    } else if (disc.reflectState === 'recovery' && tick >= disc.reflectUntil) {
      disc.reflectState = 'idle';
      disc.reflectCooldownUntil = tick + REFLECT_COOLDOWN_TICKS;
    }

    // Enter a reflect window (a bet, not a stance).
    if (
      input.reflect &&
      disc.reflectState === 'idle' &&
      tick >= disc.reflectCooldownUntil
    ) {
      disc.reflectState = 'active';
      disc.reflectUntil = tick + REFLECT_ACTIVE_TICKS;
      events.push({ kind: 'reflect', playerId: disc.playerId, pos: { ...disc.pos } });
    }
  }

  // ---- B. self-propulsion -------------------------------------------------
  for (const disc of state.discs) {
    if (!disc.alive || disc.ghost) continue;
    const input = inputs.get(disc.playerId) ?? EMPTY_INPUT;

    if (disc.reflectState === 'active') {
      // Parry stance: fully planted, no residual motion.
      disc.vel.x = 0;
      disc.vel.y = 0;
      continue;
    }
    if (disc.reflectState === 'recovery') {
      // Can't self-propel, but a knockback taken here (push ×1.5, applied in
      // phase C) must persist and launch you — so only decay by friction, never
      // hard-zero. This is what makes a whiffed parry actually punishing.
      disc.vel.x *= D.friction;
      disc.vel.y *= D.friction;
      continue;
    }

    const dir = normalize(input.dir);
    disc.vel.x += dir.x * D.accel * dt;
    disc.vel.y += dir.y * D.accel * dt;

    // clamp magnitude, then friction
    const sp = Math.hypot(disc.vel.x, disc.vel.y);
    if (sp > D.maxSpeed) {
      const s = D.maxSpeed / sp;
      disc.vel.x *= s;
      disc.vel.y *= s;
    }
    disc.vel.x *= D.friction;
    disc.vel.y *= D.friction;
  }

  // ---- C. resolve pushes --------------------------------------------------
  for (const disc of state.discs) {
    if (!disc.alive) continue;
    const input = inputs.get(disc.playerId) ?? EMPTY_INPUT;

    if (disc.ghost) {
      // Ghost's single weak push, only ever affects living discs.
      if (input.push && tick >= disc.pushCooldownUntil) {
        disc.pushCooldownUntil = tick + GHOST_COOLDOWN_TICKS;
        disc.pushAnimUntil = tick + Math.round((P.duration / 1000) * 60);
        let hitAny = false;
        for (const target of state.discs) {
          if (target === disc || !target.alive || target.ghost) continue;
          hitAny = applyPushTo(disc, target, G.force, G.range, events) || hitAny;
        }
        if (hitAny) events.push({ kind: 'ghostPush', playerId: disc.playerId, pos: { ...disc.pos } });
      }
      continue;
    }

    if (!input.push) continue;
    if (tick < disc.pushCooldownUntil) continue;
    if (disc.reflectState !== 'idle') continue; // can't act while reflecting

    disc.pushCooldownUntil = tick + PUSH_COOLDOWN_TICKS;
    disc.pushAnimUntil = tick + Math.round((P.duration / 1000) * 60);

    const recoil: Vec2 = { x: 0, y: 0 };
    for (const target of state.discs) {
      if (target === disc || !target.alive || target.ghost) continue;
      const r = resolvePushInteraction(disc, target, P.force, P.range, events);
      recoil.x -= r.x;
      recoil.y -= r.y;
    }
    // The shove went opposite your recoil; hand its direction to the effects.
    const smag = Math.hypot(recoil.x, recoil.y);
    events.push({
      kind: 'push',
      playerId: disc.playerId,
      pos: { ...disc.pos },
      dir: smag > 0.01 ? { x: -recoil.x / smag, y: -recoil.y / smag } : undefined,
      mag: clamp(smag, 0, 1),
    });
    // Recoil: you get shoved away from whoever you shoved. Near your own
    // border, that makes pushing dangerous — symmetric risk, no special rule.
    disc.vel.x += recoil.x * P.selfKnockback;
    disc.vel.y += recoil.y * P.selfKnockback;
  }

  // ---- D. integrate -------------------------------------------------------
  for (const disc of state.discs) {
    if (!disc.alive) continue;
    if (disc.ghost) {
      moveGhost(disc, inputs.get(disc.playerId) ?? EMPTY_INPUT, state.arenaRadius, dt);
      continue;
    }
    disc.pos.x += disc.vel.x * dt;
    disc.pos.y += disc.vel.y * dt;
  }

  // ---- E. disc-disc collisions -------------------------------------------
  const live = state.discs.filter((d) => d.alive && !d.ghost);
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      collide(live[i], live[j], events);
    }
  }

  // ---- F. eliminations ----------------------------------------------------
  for (const disc of state.discs) {
    if (!disc.alive || disc.ghost) continue;
    if (outsideDepth(disc.pos, state.arenaRadius) >= 0) {
      disc.alive = true; // stays present, but as a ghost
      disc.ghost = true;
      disc.vel.x = 0;
      disc.vel.y = 0;
      disc.reflectState = 'idle';
      disc.ghostAngle = Math.atan2(disc.pos.y, disc.pos.x);
      disc.pushCooldownUntil = tick + GHOST_COOLDOWN_TICKS; // no instant ghost push
      events.push({ kind: 'eliminated', playerId: disc.playerId, pos: { ...disc.pos } });
    }
  }

  state.tick++;
  return events;
}

// Push interaction respecting the target's reflect state. Returns the unit
// direction (attacker -> target) weighted by falloff, so the caller can
// accumulate recoil. Reflected pushes flip onto the attacker instead.
function resolvePushInteraction(
  attacker: Disc,
  target: Disc,
  baseForce: number,
  range: number,
  events: SimEvent[],
): Vec2 {
  const dx = target.pos.x - attacker.pos.x;
  const dy = target.pos.y - attacker.pos.y;
  const d = Math.hypot(dx, dy);
  const reach = range + D.radius;
  if (d > reach || d < 1e-6) return { x: 0, y: 0 };

  const nx = dx / d;
  const ny = dy / d;
  const t = clamp(d / reach, 0, 1);
  const falloff = lerp(1, P.falloffMin, t); // 100% at centre -> falloffMin at edge

  if (target.reflectState === 'active') {
    // Parried: attacker eats the impulse it would have dealt, with interest.
    const mag = baseForce * falloff * R.returnMult;
    attacker.vel.x -= nx * mag;
    attacker.vel.y -= ny * mag;
    // parry: the attacker is flung away from the reflector (-n direction)
    events.push({ kind: 'clash', playerId: target.playerId, pos: { ...target.pos }, dir: { x: -nx, y: -ny }, mag: falloff });
    return { x: 0, y: 0 }; // no recoil from a target that vanished the hit
  }

  const mult = target.reflectState === 'recovery' ? R.punishMult : 1;
  const mag = baseForce * falloff * mult;
  target.vel.x += nx * mag;
  target.vel.y += ny * mag;
  return { x: nx * falloff, y: ny * falloff };
}

// Ghost push: no reflect interplay, no recoil bookkeeping needed.
function applyPushTo(
  attacker: Disc,
  target: Disc,
  baseForce: number,
  range: number,
  _events: SimEvent[],
): boolean {
  const dx = target.pos.x - attacker.pos.x;
  const dy = target.pos.y - attacker.pos.y;
  const d = Math.hypot(dx, dy);
  const reach = range + D.radius;
  if (d > reach || d < 1e-6) return false;
  const nx = dx / d;
  const ny = dy / d;
  const falloff = lerp(1, P.falloffMin, clamp(d / reach, 0, 1));
  const mult = target.reflectState === 'recovery' ? R.punishMult : 1;
  const mag = baseForce * falloff * mult;
  target.vel.x += nx * mag;
  target.vel.y += ny * mag;
  return true;
}

// Elastic disc-disc collision (PRD §6.2). Always active — even mid-reflect,
// passive collision is normal (edge-case table).
function collide(a: Disc, b: Disc, events: SimEvent[]): void {
  const dx = b.pos.x - a.pos.x;
  const dy = b.pos.y - a.pos.y;
  const d = Math.hypot(dx, dy);
  const minDist = D.radius * 2;
  if (d >= minDist || d < 1e-6) return;

  const nx = dx / d;
  const ny = dy / d;

  // Separate: push each out by half the overlap.
  const overlap = (minDist - d) / 2;
  a.pos.x -= nx * overlap;
  a.pos.y -= ny * overlap;
  b.pos.x += nx * overlap;
  b.pos.y += ny * overlap;

  const relVel = (b.vel.x - a.vel.x) * nx + (b.vel.y - a.vel.y) * ny;
  if (relVel > 0) return; // already separating

  const invMassA = 1 / D.mass;
  const invMassB = 1 / D.mass;
  const j = (-(1 + TUNING.collision.restitution) * relVel) / (invMassA + invMassB);
  a.vel.x -= nx * (j * invMassA);
  a.vel.y -= ny * (j * invMassA);
  b.vel.x += nx * (j * invMassB);
  b.vel.y += ny * (j * invMassB);

  if (j > 220) {
    // Only the meaty collisions deserve a thud.
    events.push({
      kind: 'clash',
      playerId: a.playerId,
      pos: { x: a.pos.x + nx * D.radius, y: a.pos.y + ny * D.radius },
      dir: { x: nx, y: ny },
      mag: clamp(j / 700, 0, 1),
    });
  }
}

// Ghosts slide tangentially along the perimeter, driven by the component of
// their input that runs along the boundary.
function moveGhost(disc: Disc, input: InputCmd, radius: number, dt: number): void {
  const angle = disc.ghostAngle;
  const tangent = { x: -Math.sin(angle), y: Math.cos(angle) };
  const drive = input.dir.x * tangent.x + input.dir.y * tangent.y;
  disc.ghostAngle += drive * G.slideSpeed * dt;

  const u = { x: Math.cos(disc.ghostAngle), y: Math.sin(disc.ghostAngle) };
  const r = boundaryDistanceAlong(u, radius);
  disc.pos.x = u.x * r;
  disc.pos.y = u.y * r;
  disc.vel.x = 0;
  disc.vel.y = 0;
}

// Round outcome given the current state. null winner = draw / nobody scored.
export interface RoundOutcome {
  over: boolean;
  winnerId: string | null;
}

export function evaluateRound(state: SimState, timedOut: boolean): RoundOutcome {
  const aliveDiscs = state.discs.filter((d) => d.alive && !d.ghost);
  if (timedOut) {
    // Only a clean 1-survivor finish scores on a timeout.
    return { over: true, winnerId: aliveDiscs.length === 1 ? aliveDiscs[0].playerId : null };
  }
  if (aliveDiscs.length <= 1) {
    return { over: true, winnerId: aliveDiscs.length === 1 ? aliveDiscs[0].playerId : null };
  }
  return { over: false, winnerId: null };
}

export { countAlive };
