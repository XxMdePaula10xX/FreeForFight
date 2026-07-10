// A single game room: players, the authoritative simulation, and the phase
// machine that drives rounds and scoring. The room is the only source of truth.

import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import {
  TUNING,
  PLAYER_COLORS,
  msToTicks,
  MAX_ROUND_TICKS,
} from '../../shared/tuning';
import { step, evaluateRound } from '../../shared/physics';
import type { InputMap } from '../../shared/physics';
import { makeDisc } from '../../shared/types';
import type { Disc, InputCmd, Phase, SimState } from '../../shared/types';
import type {
  DiscSnapshot,
  PlayerInfo,
  ServerMessage,
} from '../../shared/protocol';
import { encode } from '../../shared/protocol';
import { sanitizeNickname, uniqueNickname } from '../../shared/nickname';

const COUNTDOWN_TICKS = msToTicks(TUNING.round.countdown);
const END_FREEZE_TICKS = msToTicks(TUNING.round.endFreeze);

interface Player {
  id: string;
  nickname: string;
  color: string;
  connected: boolean;
  score: number;
  socket: WebSocket | null;
  lastInput: InputCmd;
  lastAppliedSeq: number;
  disconnectedAtTick: number | null;
}

// Random, unguessable id. It doubles as the reconnect bearer token, so it must
// NOT be sequential — otherwise anyone could hijack "p3" by guessing (PRD §6.6).
const genId = () => randomUUID();

export class Room {
  code: string;
  hostId: string | null = null;
  players = new Map<string, Player>();
  phase: Phase = 'lobby';
  tick = 0;
  sim: SimState;
  roundIndex = 0;
  phaseUntilTick = 0; // tick at which the current timed phase transitions
  createdAt: number;
  lastActivity: number;
  private pendingEvents: ServerMessage[] = [];

  constructor(code: string, now: number) {
    this.code = code;
    this.createdAt = now;
    this.lastActivity = now;
    this.sim = { tick: 0, roundStartTick: 0, arenaRadius: TUNING.arena.startRadius, discs: [] };
  }

  // ---- membership --------------------------------------------------------
  addPlayer(rawNick: string, socket: WebSocket): Player | null {
    if (this.players.size >= TUNING.match.maxPlayers) return null;
    const clean = sanitizeNickname(rawNick);
    const unique = uniqueNickname(
      clean,
      Array.from(this.players.values(), (p) => p.nickname),
    );
    const usedColors = new Set(Array.from(this.players.values(), (p) => p.color));
    const color = PLAYER_COLORS.find((c) => !usedColors.has(c)) ?? PLAYER_COLORS[0];
    const player: Player = {
      id: genId(),
      nickname: unique,
      color,
      connected: true,
      score: 0,
      socket,
      lastInput: { seq: 0, dir: { x: 0, y: 0 }, push: false, reflect: false },
      lastAppliedSeq: 0,
      disconnectedAtTick: null,
    };
    this.players.set(player.id, player);
    if (!this.hostId) this.hostId = player.id;
    this.touch();
    return player;
  }

  reconnect(playerId: string, socket: WebSocket): Player | null {
    const p = this.players.get(playerId);
    if (!p) return null;
    p.connected = true;
    p.socket = socket;
    p.disconnectedAtTick = null;
    // The reconnecting client restarts its input sequence at 1, so clear the
    // stored seq — otherwise setInput would reject every new input as stale.
    p.lastInput = { seq: 0, dir: { x: 0, y: 0 }, push: false, reflect: false };
    p.lastAppliedSeq = 0;
    this.touch();
    return p;
  }

  // Is this socket the player's current one? Guards against a late close event
  // from a replaced (already-reconnected) socket flipping them offline.
  isCurrentSocket(playerId: string, socket: WebSocket): boolean {
    return this.players.get(playerId)?.socket === socket;
  }

  markDisconnected(playerId: string): void {
    const p = this.players.get(playerId);
    if (!p) return;
    p.connected = false;
    p.socket = null;
    p.disconnectedAtTick = this.tick;
    // Its disc keeps living under physics but stops receiving input — it will
    // drift and likely fall. Fair and simple (PRD §6.6).
    p.lastInput = { seq: p.lastInput.seq, dir: { x: 0, y: 0 }, push: false, reflect: false };
    if (this.hostId === playerId) this.reassignHost();
    this.touch();
  }

  private reassignHost(): void {
    // oldest still-connected player becomes host
    const candidate = Array.from(this.players.values()).find((p) => p.connected);
    this.hostId = candidate ? candidate.id : null;
  }

  removePlayer(playerId: string): void {
    this.players.delete(playerId);
    if (this.hostId === playerId) this.reassignHost();
    this.touch();
  }

  anyoneConnected(): boolean {
    for (const p of this.players.values()) if (p.connected) return true;
    return false;
  }

  connectedCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }

  // ---- input -------------------------------------------------------------
  setInput(playerId: string, input: InputCmd): void {
    const p = this.players.get(playerId);
    if (!p || !p.connected) return;
    // ignore out-of-order / stale packets
    if (input.seq < p.lastInput.seq) return;
    p.lastInput = input;
    this.touch();
  }

  // ---- match / round flow ------------------------------------------------
  startMatch(requesterId: string): boolean {
    if (requesterId !== this.hostId) return false;
    if (this.players.size < TUNING.match.minPlayers) return false;
    if (this.phase !== 'lobby' && this.phase !== 'match_end') return false;
    for (const p of this.players.values()) p.score = 0;
    this.roundIndex = 0;
    this.beginRound();
    this.broadcast({ t: 'match_started', roundIndex: this.roundIndex });
    return true;
  }

  playAgain(requesterId: string): boolean {
    if (requesterId !== this.hostId) return false;
    if (this.phase !== 'match_end') return false;
    return this.startMatch(requesterId);
  }

  private beginRound(): void {
    const ids = Array.from(this.players.keys());
    const n = ids.length;
    const spawnR = TUNING.arena.startRadius * 0.55;
    const discs: Disc[] = ids.map((id, i) => {
      const a = (Math.PI * 2 * i) / n - Math.PI / 2;
      return makeDisc(id, { x: Math.cos(a) * spawnR, y: Math.sin(a) * spawnR });
    });
    this.sim = {
      tick: this.tick,
      roundStartTick: this.tick + COUNTDOWN_TICKS,
      arenaRadius: TUNING.arena.startRadius,
      discs,
    };
    this.phase = 'countdown';
    this.phaseUntilTick = this.tick + COUNTDOWN_TICKS;
    this.broadcast({ t: 'countdown', roundIndex: this.roundIndex, startsInMs: TUNING.round.countdown });
  }

  // Advance one simulation tick. Called by the global loop at 60Hz.
  advance(): void {
    this.tick++;
    this.sim.tick = this.tick;

    switch (this.phase) {
      case 'countdown':
        if (this.tick >= this.phaseUntilTick) {
          this.phase = 'playing';
          this.sim.roundStartTick = this.tick;
        }
        break;

      case 'playing': {
        const inputs: InputMap = new Map();
        for (const p of this.players.values()) {
          inputs.set(p.id, p.lastInput);
          p.lastAppliedSeq = p.lastInput.seq;
        }
        const events = step(this.sim, inputs, 1 / 60);
        for (const e of events) {
          this.pendingEvents.push({ t: 'event', kind: e.kind, playerId: e.playerId, pos: e.pos });
        }
        const timedOut = this.tick - this.sim.roundStartTick >= MAX_ROUND_TICKS;
        const outcome = evaluateRound(this.sim, timedOut);
        if (outcome.over) this.endRound(outcome.winnerId);
        break;
      }

      case 'round_end':
        if (this.tick >= this.phaseUntilTick) {
          this.roundIndex++;
          this.beginRound();
        }
        break;
    }

    // If too few players are still connected mid-match, fall back to lobby
    // (PRD §9: "sala vai a 1 jogador durante a partida → partida encerra").
    // Count CONNECTED players so an idle disconnected disc can't keep a match
    // alive or win a round by sitting still.
    if (
      (this.phase === 'playing' || this.phase === 'countdown') &&
      this.connectedCount() < TUNING.match.minPlayers
    ) {
      this.phase = 'lobby';
      this.broadcastRoomState();
    }
  }

  private endRound(winnerId: string | null): void {
    if (winnerId) {
      const w = this.players.get(winnerId);
      if (w) w.score++;
    }
    const scores = this.scoreMap();
    const champ = winnerId ? this.players.get(winnerId) : null;

    if (champ && champ.score >= TUNING.match.scoreToWin) {
      this.phase = 'match_end';
      this.broadcast({ t: 'match_ended', winnerId, scores });
    } else {
      this.phase = 'round_end';
      this.phaseUntilTick = this.tick + END_FREEZE_TICKS;
      this.broadcast({ t: 'round_ended', winnerId, scores });
    }
  }

  private scoreMap(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const p of this.players.values()) out[p.id] = p.score;
    return out;
  }

  // ---- snapshots & broadcast --------------------------------------------
  // Called at 20Hz. Personalises lastSeq per recipient for reconciliation.
  sendSnapshots(): void {
    if (this.phase !== 'playing' && this.phase !== 'countdown' && this.phase !== 'round_end') return;
    const discs: DiscSnapshot[] = this.sim.discs.map((d) => ({
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
    }));
    for (const p of this.players.values()) {
      if (!p.connected || !p.socket) continue;
      const msg: ServerMessage = {
        t: 'snapshot',
        tick: this.tick,
        lastSeq: p.lastAppliedSeq,
        phase: this.phase,
        arenaRadius: this.sim.arenaRadius,
        roundStartTick: this.sim.roundStartTick,
        discs,
      };
      this.sendTo(p, msg);
    }
  }

  flushEvents(): void {
    if (this.pendingEvents.length === 0) return;
    for (const e of this.pendingEvents) this.broadcast(e);
    this.pendingEvents.length = 0;
  }

  playerInfos(): PlayerInfo[] {
    return Array.from(this.players.values(), (p) => ({
      id: p.id,
      nickname: p.nickname,
      color: p.color,
      connected: p.connected,
      score: p.score,
      isHost: p.id === this.hostId,
    }));
  }

  broadcastRoomState(): void {
    this.broadcast({
      t: 'room_state',
      code: this.code,
      phase: this.phase,
      players: this.playerInfos(),
      hostId: this.hostId ?? '',
    });
  }

  broadcast(msg: ServerMessage): void {
    const raw = encode(msg);
    for (const p of this.players.values()) {
      if (p.connected && p.socket && p.socket.readyState === WebSocket.OPEN) {
        p.socket.send(raw);
      }
    }
  }

  sendTo(p: Player, msg: ServerMessage): void {
    if (p.socket && p.socket.readyState === WebSocket.OPEN) p.socket.send(encode(msg));
  }

  private touch(): void {
    // updated by the loop's clock; kept as a tick reference is enough here
  }

  setActivity(now: number): void {
    this.lastActivity = now;
  }
}
