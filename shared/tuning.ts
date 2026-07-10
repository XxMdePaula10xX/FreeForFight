// The single source of truth for every gameplay number.
// Tweak here; the whole game reacts. Nothing else should hard-code a constant.
// See PRD §4.5 — these are starting points, not truths. Playtest, then adjust.

export const TICK_RATE = 60; // simulation runs at a fixed 60Hz
export const DT = 1 / TICK_RATE; // seconds per tick

export const TUNING = {
  disc: {
    radius: 24,
    mass: 1,
    maxSpeed: 260, // px/s
    accel: 1400, // px/s^2
    friction: 0.9, // velocity retained per frame @60Hz
  },
  collision: {
    restitution: 0.85,
  },
  push: {
    range: 90, // px from disc centre
    force: 620, // impulse applied to the target
    duration: 120, // ms of animation
    cooldown: 900, // ms
    selfKnockback: 140, // you recoil when you push
    falloffMin: 0.4, // force at the edge of range (100% at centre)
  },
  reflect: {
    active: 180, // ms the parry window is open
    recovery: 320, // ms frozen & vulnerable after the window
    cooldown: 1600, // ms, measured from the end of recovery
    returnMult: 1.3, // reflected impulse dealt back to the attacker
    punishMult: 1.5, // bonus force taken while in recovery
  },
  ghost: {
    force: 220,
    range: 70,
    cooldown: 2500, // ms
    slideSpeed: 2.6, // radians/s along the perimeter
  },
  arena: {
    startRadius: 340, // circumradius (centre -> vertex)
    endRadius: 130,
    shrinkStartAt: 8000, // ms into the round before it starts closing in
    shrinkDuration: 35000, // ms to go from start to end radius
  },
  round: {
    countdown: 3000, // ms
    maxDuration: 60000, // ms — nobody scores if this elapses with 2+ alive
    endFreeze: 2000, // ms the round-end screen holds before advancing
  },
  match: {
    scoreToWin: 3, // first to 3 points takes the match (best of 5)
    maxPlayers: 4,
    minPlayers: 2,
  },
} as const;

// ms -> whole ticks, used everywhere timers live in tick-space for determinism.
export const msToTicks = (ms: number): number => Math.round((ms / 1000) * TICK_RATE);

export const PUSH_COOLDOWN_TICKS = msToTicks(TUNING.push.cooldown);
export const REFLECT_ACTIVE_TICKS = msToTicks(TUNING.reflect.active);
export const REFLECT_RECOVERY_TICKS = msToTicks(TUNING.reflect.recovery);
export const REFLECT_COOLDOWN_TICKS = msToTicks(TUNING.reflect.cooldown);
export const GHOST_COOLDOWN_TICKS = msToTicks(TUNING.ghost.cooldown);
export const SHRINK_START_TICKS = msToTicks(TUNING.arena.shrinkStartAt);
export const SHRINK_DURATION_TICKS = msToTicks(TUNING.arena.shrinkDuration);
export const MAX_ROUND_TICKS = msToTicks(TUNING.round.maxDuration);

export const PLAYER_COLORS = ['#ffd23f', '#3ddc84', '#ff6bd6', '#7c5cff'] as const;
