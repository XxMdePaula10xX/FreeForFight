// Single-player: a full match run entirely on the client, no server, no
// network. Reuses the exact shared physics and round rules; fills the empty
// seats with AI. This is what makes the packaged app playable offline.
//
// It exposes the same surface the render loop already reads off NetClient
// (phase, players, getRenderDiscs, arenaRadius, clientTick, roundStartTick,
// colorOf/nicknameOf) so the renderer doesn't care which one is driving.

import { step, arenaRadiusAt, evaluateRound } from '../../shared/physics';
import type { InputMap } from '../../shared/physics';
import { makeDisc } from '../../shared/types';
import type { Disc, InputCmd, Phase, SimState, SimEvent } from '../../shared/types';
import { TUNING, PLAYER_COLORS, msToTicks, MAX_ROUND_TICKS } from '../../shared/tuning';
import type { PlayerInfo } from '../../shared/protocol';
import { botInput, BOT_NAMES, type Difficulty } from './ai';
import type { RenderDisc } from './net';

const COUNTDOWN_TICKS = msToTicks(TUNING.round.countdown);
const END_FREEZE_TICKS = msToTicks(TUNING.round.endFreeze);

const YOU = 'you';

export interface HumanInput {
  dir: { x: number; y: number };
  push: boolean;
  reflect: boolean;
}

export class LocalGame {
  phase: Phase = 'lobby';
  players: PlayerInfo[] = [];
  scores: Record<string, number> = {};
  roundWinnerId: string | null = null;
  matchWinnerId: string | null = null;
  scoreToWin: number = TUNING.match.scoreToWin;
  readonly playerId = YOU;
  readonly isHost = true;

  private sim: SimState;
  private ids: string[] = [];
  private difficulty: Difficulty = 'normal';
  private phaseUntilTick = 0;
  private roundIndex = 0;

  // training (tutorial) mode: a lone dummy, no AI, no shrink, can't lose.
  training = false;
  private noShrink = false;
  private dummyInput: HumanInput = { dir: { x: 0, y: 0 }, push: false, reflect: false };

  constructor() {
    this.sim = { tick: 0, roundStartTick: 0, arenaRadius: TUNING.arena.startRadius, discs: [] };
  }

  get arenaRadius(): number {
    return this.sim.arenaRadius;
  }
  get clientTick(): number {
    return this.sim.tick;
  }
  get roundStartTick(): number {
    return this.sim.roundStartTick;
  }
  get isMatchOver(): boolean {
    return this.phase === 'match_end';
  }

  // botCount 1..3 → 2..4 total fighters. fast = best-of-1 quick match.
  start(botCount: number, difficulty: Difficulty, fast = false): void {
    this.difficulty = difficulty;
    this.training = false;
    this.noShrink = false;
    this.scoreToWin = fast ? 1 : TUNING.match.scoreToWin;
    const n = Math.min(4, Math.max(2, botCount + 1));
    this.ids = [YOU, ...BOT_NAMES.slice(0, n - 1).map((_, i) => `b${i + 1}`)];
    this.players = this.ids.map((id, i) => ({
      id,
      nickname: id === YOU ? 'Você' : BOT_NAMES[i - 1],
      color: PLAYER_COLORS[i],
      connected: true,
      score: 0,
      isHost: id === YOU,
    }));
    this.scores = Object.fromEntries(this.ids.map((id) => [id, 0]));
    this.roundIndex = 0;
    this.matchWinnerId = null;
    this.beginRound();
  }

  // ---- training / tutorial -------------------------------------------------
  startTraining(): void {
    this.training = true;
    this.noShrink = true;
    this.ids = [YOU, 'dummy'];
    this.players = [
      { id: YOU, nickname: 'Você', color: PLAYER_COLORS[0], connected: true, score: 0, isHost: true },
      { id: 'dummy', nickname: 'Boneco', color: PLAYER_COLORS[1], connected: true, score: 0, isHost: false },
    ];
    this.scores = { you: 0, dummy: 0 };
    this.sim.discs = [makeDisc(YOU, { x: -90, y: 0 }), makeDisc('dummy', { x: 90, y: 0 })];
    this.sim.roundStartTick = this.sim.tick;
    this.sim.arenaRadius = TUNING.arena.startRadius;
    this.phase = 'playing';
  }

  setDummyInput(inp: HumanInput): void {
    this.dummyInput = inp;
  }

  // Reposition both fighters for a fresh drill step.
  placeTraining(you: { x: number; y: number }, dummy: { x: number; y: number }): void {
    const y = this.discById(YOU);
    const d = this.discById('dummy');
    if (y) {
      y.pos = { ...you };
      y.vel = { x: 0, y: 0 };
      y.reflectState = 'idle';
      y.pushCooldownUntil = 0;
      y.reflectCooldownUntil = 0;
    }
    if (d) {
      d.pos = { ...dummy };
      d.vel = { x: 0, y: 0 };
      d.reflectState = 'idle';
      d.pushCooldownUntil = 0;
    }
  }

  discById(id: string) {
    return this.sim.discs.find((x) => x.playerId === id);
  }

  playAgain(): void {
    if (this.phase !== 'match_end') return;
    for (const id of this.ids) this.scores[id] = 0;
    for (const p of this.players) p.score = 0;
    this.roundIndex = 0;
    this.matchWinnerId = null;
    this.beginRound();
  }

  private beginRound(): void {
    const n = this.ids.length;
    const spawnR = TUNING.arena.startRadius * 0.55;
    const discs: Disc[] = this.ids.map((id, i) => {
      const a = (Math.PI * 2 * i) / n - Math.PI / 2;
      return makeDisc(id, { x: Math.cos(a) * spawnR, y: Math.sin(a) * spawnR });
    });
    this.sim.discs = discs;
    this.sim.roundStartTick = this.sim.tick + COUNTDOWN_TICKS;
    this.sim.arenaRadius = TUNING.arena.startRadius;
    this.roundWinnerId = null;
    this.phase = 'countdown';
    this.phaseUntilTick = this.sim.tick + COUNTDOWN_TICKS;
  }

  // Advance one tick at 60Hz. Returns feedback events for the effects layer.
  step(human: HumanInput): SimEvent[] {
    this.sim.tick++;
    this.sim.arenaRadius = this.noShrink
      ? TUNING.arena.startRadius
      : arenaRadiusAt(this.sim.tick, this.sim.roundStartTick);

    if (this.training) {
      const inputs: InputMap = new Map([
        [YOU, { seq: 0, dir: human.dir, push: human.push, reflect: human.reflect }],
        ['dummy', { seq: 0, dir: this.dummyInput.dir, push: this.dummyInput.push, reflect: this.dummyInput.reflect }],
      ]);
      const events = step(this.sim, inputs, 1 / 60);
      // you can't lose the tutorial: revive anyone shoved out
      for (const d of this.sim.discs) {
        if (d.ghost) {
          d.ghost = false;
          d.alive = true;
          d.vel = { x: 0, y: 0 };
          d.reflectState = 'idle';
          d.pos = d.playerId === YOU ? { x: -90, y: 0 } : { x: 90, y: 0 };
        }
      }
      return events;
    }

    switch (this.phase) {
      case 'countdown':
        if (this.sim.tick >= this.phaseUntilTick) {
          this.phase = 'playing';
          this.sim.roundStartTick = this.sim.tick;
        }
        return [];

      case 'playing': {
        const inputs: InputMap = new Map();
        for (const d of this.sim.discs) {
          if (d.playerId === YOU) {
            const cmd: InputCmd = { seq: 0, dir: human.dir, push: human.push, reflect: human.reflect };
            inputs.set(YOU, cmd);
          } else {
            inputs.set(d.playerId, botInput(this.sim, d, this.difficulty));
          }
        }
        const events = step(this.sim, inputs, 1 / 60);
        const timedOut = this.sim.tick - this.sim.roundStartTick >= MAX_ROUND_TICKS;
        const outcome = evaluateRound(this.sim, timedOut);
        if (outcome.over) this.endRound(outcome.winnerId);
        return events;
      }

      case 'round_end':
        if (this.sim.tick >= this.phaseUntilTick) {
          this.roundIndex++;
          this.beginRound();
        }
        return [];

      default:
        return [];
    }
  }

  private endRound(winnerId: string | null): void {
    this.roundWinnerId = winnerId;
    if (winnerId) {
      this.scores[winnerId] = (this.scores[winnerId] ?? 0) + 1;
      const p = this.players.find((pl) => pl.id === winnerId);
      if (p) p.score = this.scores[winnerId];
    }
    if (winnerId && this.scores[winnerId] >= this.scoreToWin) {
      this.matchWinnerId = winnerId;
      this.phase = 'match_end';
    } else {
      this.phase = 'round_end';
      this.phaseUntilTick = this.sim.tick + END_FREEZE_TICKS;
    }
  }

  getRenderDiscs(_now: number): RenderDisc[] {
    return this.sim.discs.map((d) => ({
      playerId: d.playerId,
      pos: d.pos,
      vel: d.vel,
      alive: d.alive,
      ghost: d.ghost,
      reflectState: d.reflectState,
      pushCooldownUntil: d.pushCooldownUntil,
      reflectCooldownUntil: d.reflectCooldownUntil,
      reflectUntil: d.reflectUntil,
      pushAnimUntil: d.pushAnimUntil,
      isSelf: d.playerId === YOU,
    }));
  }

  colorOf(id: string): string {
    return this.players.find((p) => p.id === id)?.color ?? PLAYER_COLORS[0];
  }
  nicknameOf(id: string): string {
    return this.players.find((p) => p.id === id)?.nickname ?? '???';
  }
}
