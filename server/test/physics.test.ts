// Determinism & correctness checks for the shared physics. No test framework —
// just assertions, runnable with `tsx`. This module is imported verbatim by the
// client and server, so if it drifts, netcode desyncs.

import { step, arenaRadiusAt, evaluateRound } from '../../shared/physics';
import type { InputMap } from '../../shared/physics';
import { makeDisc } from '../../shared/types';
import type { InputCmd, SimState } from '../../shared/types';
import { TUNING, REFLECT_ACTIVE_TICKS } from '../../shared/tuning';
import { isInside } from '../../shared/octagon';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    // eslint-disable-next-line no-console
    console.error(`  ✗ ${name}`);
  }
}
function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

const input = (over: Partial<InputCmd> = {}): InputCmd => ({
  seq: 0,
  dir: { x: 0, y: 0 },
  push: false,
  reflect: false,
  ...over,
});

function fresh(discs = 2): SimState {
  const arr = [];
  arr.push(makeDisc('a', { x: -60, y: 0 }));
  if (discs >= 2) arr.push(makeDisc('b', { x: 60, y: 0 }));
  if (discs >= 3) arr.push(makeDisc('c', { x: 0, y: 60 }));
  return { tick: 0, roundStartTick: 0, arenaRadius: TUNING.arena.startRadius, discs: arr };
}

// Deep-ish clone for determinism comparison.
function snapshot(s: SimState): string {
  return JSON.stringify(s.discs.map((d) => [d.pos.x, d.pos.y, d.vel.x, d.vel.y, d.alive, d.ghost]));
}

// ---- 1. determinism: identical inputs -> identical states ------------------
{
  const runOnce = () => {
    const s = fresh(3);
    const seq: InputMap = new Map([
      ['a', input({ dir: { x: 1, y: 0 } })],
      ['b', input({ dir: { x: -1, y: 0.2 } })],
      ['c', input({ dir: { x: 0, y: -1 }, push: true })],
    ]);
    for (let i = 0; i < 300; i++) step(s, seq, 1 / 60);
    return snapshot(s);
  };
  assert(runOnce() === runOnce(), 'determinism: same inputs produce same state');
}

// ---- 2. friction steady state ~ accel*dt/(1-friction) ----------------------
{
  const s = fresh(1);
  s.discs[0].pos = { x: -280, y: 0 }; // start near the wall so it converges before crossing
  const seq: InputMap = new Map([['a', input({ dir: { x: 1, y: 0 } })]]);
  for (let i = 0; i < 90; i++) step(s, seq, 1 / 60); // v converges (~0.9^90) well before elimination
  const v = Math.hypot(s.discs[0].vel.x, s.discs[0].vel.y);
  const expected = ((TUNING.disc.accel * (1 / 60)) / (1 - TUNING.disc.friction)) * TUNING.disc.friction;
  assert(!s.discs[0].ghost, 'friction test disc stays in the arena');
  assert(Math.abs(v - expected) < 1.0, 'friction reaches expected steady-state speed');
}

// ---- 3. push knocks the target away and recoils the pusher -----------------
{
  const s = fresh(2); // a at -60, b at 60 -> gap 120, within range+radius (90+24=114)? no.
  s.discs[1].pos.x = 40; // bring b within push reach of a (dist 100 <= 114)
  const seq: InputMap = new Map([
    ['a', input({ push: true })],
    ['b', input()],
  ]);
  step(s, seq, 1 / 60);
  assert(s.discs[1].vel.x > 0, 'push sends target outward (+x)');
  assert(s.discs[0].vel.x < 0, 'pusher recoils inward (-x)');
}

// ---- 4. reflect returns the push to the attacker ---------------------------
{
  const s = fresh(2);
  s.discs[1].pos.x = 40;
  // b reflects, a pushes on the same tick
  const seq: InputMap = new Map([
    ['a', input({ push: true })],
    ['b', input({ reflect: true })],
  ]);
  step(s, seq, 1 / 60);
  assert(s.discs[1].reflectState === 'active', 'reflect window opens');
  assert(approx(s.discs[1].vel.x, 0) && approx(s.discs[1].vel.y, 0), 'reflected target does not move');
  assert(s.discs[0].vel.x < 0, 'attacker is knocked back by the parry');
}

// ---- 5. reflect state machine timing ---------------------------------------
{
  const s = fresh(1);
  const on: InputMap = new Map([['a', input({ reflect: true })]]);
  const off: InputMap = new Map([['a', input()]]);
  step(s, on, 1 / 60);
  assert(s.discs[0].reflectState === 'active', 'enters active on press');
  for (let i = 0; i < REFLECT_ACTIVE_TICKS; i++) step(s, off, 1 / 60);
  assert(s.discs[0].reflectState === 'recovery', 'active -> recovery after window');
}

// ---- 5b. a whiffed parry (recovery) actually gets punished -----------------
{
  const s = fresh(2);
  s.discs[1].pos.x = 40; // b within push reach of a
  // put b into recovery
  s.discs[1].reflectState = 'recovery';
  s.discs[1].reflectUntil = 999;
  const seq: InputMap = new Map([
    ['a', input({ push: true })],
    ['b', input()],
  ]);
  step(s, seq, 1 / 60);
  const v1 = Math.hypot(s.discs[1].vel.x, s.discs[1].vel.y);
  assert(s.discs[1].vel.x > 0 && v1 > 5, 'recovery disc is launched by the counter-push');
  // and the knockback persists (decays, not hard-zeroed) on the next tick
  const before = s.discs[1].pos.x;
  step(s, new Map([['a', input()], ['b', input()]]), 1 / 60);
  assert(s.discs[1].pos.x > before, 'knockback carries the recovery disc further next tick');
}

// ---- 6. arena shrink & elimination -----------------------------------------
{
  assert(arenaRadiusAt(0, 0) === TUNING.arena.startRadius, 'arena starts at startRadius');
  const late = arenaRadiusAt(100000, 0);
  assert(late === TUNING.arena.endRadius, 'arena bottoms out at endRadius');

  const s = fresh(1);
  s.discs[0].pos = { x: TUNING.arena.startRadius + 50, y: 0 }; // already outside
  step(s, new Map([['a', input()]]), 1 / 60);
  assert(s.discs[0].ghost === true, 'disc outside octagon becomes a ghost');
}

// ---- 7. octagon inside test ------------------------------------------------
{
  assert(isInside({ x: 0, y: 0 }, 340), 'centre is inside');
  assert(!isInside({ x: 400, y: 0 }, 340), 'far point is outside');
}

// ---- 8. evaluateRound --------------------------------------------------------
{
  const s = fresh(2);
  s.discs[1].ghost = true; // only 'a' alive
  const out = evaluateRound(s, false);
  assert(out.over && out.winnerId === 'a', 'last one standing wins');
  const s2 = fresh(2);
  const tie = evaluateRound(s2, true); // timeout with 2 alive
  assert(tie.over && tie.winnerId === null, 'timeout with 2+ alive scores nobody');
}

// ---- report ----------------------------------------------------------------
// eslint-disable-next-line no-console
console.log(`\nphysics: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
