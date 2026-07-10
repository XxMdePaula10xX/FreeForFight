// Bot brains for single-player. Each bot produces an InputCmd per tick from the
// current simulation state. Priorities, in order:
//   1. Don't fall out. If the shrinking edge is close, steer for the centre.
//   2. Hunt. Close on the nearest opponent to shove them.
//   3. Shove — but only when the recoil pushes YOU inward (never off your own
//      edge) and the target is nearer the edge than you are.
//   4. Parry, rarely, when someone fast is right on top of you. Kept low on
//      purpose: a bot that spams Reflect would stall the match (PRD §10.7).
//
// Non-deterministic (Math.random) is fine here — solo play never syncs.

import { TUNING } from '../../shared/tuning';
import type { InputCmd, SimState, Disc } from '../../shared/types';
import { boundaryDistanceAlong } from '../../shared/octagon';

export type Difficulty = 'easy' | 'normal' | 'hard';

interface Profile {
  safeGap: number; // px from the wall before self-preservation kicks in
  pushChance: number; // prob. of committing a valid shove on a given tick
  pushReach: number; // multiplier on push range for the decision
  reflectChance: number; // prob. of parrying a close, fast threat
  jitter: number; // aim noise in radians
  hesitate: number; // prob. of standing still a tick (makes easy bots beatable)
}

const PROFILES: Record<Difficulty, Profile> = {
  easy: { safeGap: 52, pushChance: 0.5, pushReach: 0.85, reflectChance: 0.015, jitter: 0.55, hesitate: 0.16 },
  normal: { safeGap: 74, pushChance: 0.78, pushReach: 1.0, reflectChance: 0.04, jitter: 0.26, hesitate: 0.04 },
  hard: { safeGap: 96, pushChance: 0.93, pushReach: 1.08, reflectChance: 0.075, jitter: 0.1, hesitate: 0 },
};

const IDLE: InputCmd = { seq: 0, dir: { x: 0, y: 0 }, push: false, reflect: false };

function rot(x: number, y: number, a: number): { x: number; y: number } {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: x * c - y * s, y: x * s + y * c };
}

export function botInput(sim: SimState, bot: Disc, difficulty: Difficulty): InputCmd {
  if (!bot.alive || bot.ghost) return IDLE;
  const pr = PROFILES[difficulty];

  const opponents = sim.discs.filter((d) => d !== bot && d.alive && !d.ghost);
  if (opponents.length === 0) return IDLE;

  // nearest opponent
  let target = opponents[0];
  let bestD = Infinity;
  for (const o of opponents) {
    const d = (o.pos.x - bot.pos.x) ** 2 + (o.pos.y - bot.pos.y) ** 2;
    if (d < bestD) {
      bestD = d;
      target = o;
    }
  }

  const centerDist = Math.hypot(bot.pos.x, bot.pos.y);
  // outward direction from centre (fallback to velocity when dead-centre)
  let ux = bot.pos.x;
  let uy = bot.pos.y;
  if (centerDist < 1) {
    ux = bot.vel.x;
    uy = bot.vel.y;
  }
  const ul = Math.hypot(ux, uy) || 1;
  ux /= ul;
  uy /= ul;
  const boundaryDist = boundaryDistanceAlong({ x: ux, y: uy }, sim.arenaRadius);
  const edgeGap = boundaryDist - centerDist; // px of floor left outward
  const nearEdge = edgeGap < pr.safeGap;

  // ---- movement direction ----
  let dx: number;
  let dy: number;
  if (nearEdge) {
    // head inward, with a tangential lean so we still crowd the target
    dx = -ux;
    dy = -uy;
    const tx = -uy;
    const ty = ux;
    const toT = target.pos.x * -uy + target.pos.y * ux; // sign of tangential toward target
    const lean = toT >= 0 ? 1 : -1;
    dx += tx * lean * 0.5;
    dy += ty * lean * 0.5;
  } else {
    dx = target.pos.x - bot.pos.x;
    dy = target.pos.y - bot.pos.y;
  }
  const dl = Math.hypot(dx, dy) || 1;
  let dir = rot(dx / dl, dy / dl, (Math.random() - 0.5) * 2 * pr.jitter);
  if (Math.random() < pr.hesitate) dir = { x: 0, y: 0 };

  // ---- push decision ----
  let push = false;
  const canPush = bot.reflectState === 'idle' && sim.tick >= bot.pushCooldownUntil;
  if (canPush && !nearEdge) {
    const reach = TUNING.push.range * pr.pushReach + TUNING.disc.radius;
    const dist = Math.sqrt(bestD);
    const targetCenter = Math.hypot(target.pos.x, target.pos.y);
    // shove only if target is at least as close to the edge as we are: the
    // recoil then carries us toward the centre, not off our own edge.
    if (dist < reach && targetCenter >= centerDist - 10 && Math.random() < pr.pushChance) {
      push = true;
    }
  }

  // ---- reflect decision ----
  let reflect = false;
  const canReflect = bot.reflectState === 'idle' && sim.tick >= bot.reflectCooldownUntil;
  if (canReflect && !push) {
    for (const o of opponents) {
      const ox = o.pos.x - bot.pos.x;
      const oy = o.pos.y - bot.pos.y;
      const od = Math.hypot(ox, oy);
      if (od > TUNING.push.range + TUNING.disc.radius) continue;
      // approaching fast? (their velocity points at us)
      const closing = -(o.vel.x * ox + o.vel.y * oy) / (od || 1);
      if (closing > 120 && Math.random() < pr.reflectChance) {
        reflect = true;
        break;
      }
    }
  }

  return { seq: 0, dir, push, reflect };
}

export const BOT_NAMES = ['Oni', 'Kuma', 'Tora', 'Ryu'];
