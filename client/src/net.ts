// Networking + client-side prediction/reconciliation/interpolation.
//
// - The local disc is PREDICTED: inputs apply immediately, then we reconcile
//   against the server's authoritative snapshot and replay pending inputs.
// - Every OTHER disc is INTERPOLATED ~100ms in the past between snapshots.
//   We never extrapolate — extrapolation in a collision game teleports.
//
// Prediction reuses the exact same shared step() as the server, run on a
// single-disc SimState (self only). Collisions against others are resolved
// server-side and folded in on reconciliation.

import { step } from '../../shared/physics';
import type { InputMap } from '../../shared/physics';
import { makeDisc } from '../../shared/types';
import type { Disc, InputCmd, Phase, SimState } from '../../shared/types';
import type {
  ClientMessage,
  DiscSnapshot,
  PlayerInfo,
  ServerMessage,
  SimEventLike,
} from '../../shared/protocol';
import { encode, decode } from '../../shared/protocol';
import { TUNING } from '../../shared/tuning';

const INTERP_DELAY_MS = 100;
const MAX_SMOOTH = 120; // px — bigger corrections snap instead of easing

interface TimedSnapshot {
  recvTime: number;
  tick: number;
  roundStartTick: number;
  arenaRadius: number;
  discs: Map<string, DiscSnapshot>;
}

export interface RenderDisc {
  playerId: string;
  pos: { x: number; y: number };
  vel: { x: number; y: number };
  alive: boolean;
  ghost: boolean;
  reflectState: Disc['reflectState'];
  pushCooldownUntil: number;
  reflectCooldownUntil: number;
  reflectUntil: number;
  pushAnimUntil: number;
  coreChargeUntil: number;
  isSelf: boolean;
}

export interface NetCallbacks {
  onRoomState?: (code: string, phase: Phase, players: PlayerInfo[], hostId: string) => void;
  onJoined?: (playerId: string, code: string) => void;
  onError?: (message: string) => void;
  onMatchStarted?: (roundIndex: number) => void;
  onCountdown?: (roundIndex: number, startsInMs: number) => void;
  onRoundEnded?: (winnerId: string | null, scores: Record<string, number>) => void;
  onMatchEnded?: (winnerId: string | null, scores: Record<string, number>) => void;
  onEvent?: (e: SimEventLike) => void;
  onPhase?: (phase: Phase) => void;
}

export class NetClient {
  private ws: WebSocket | null = null;
  private url: string;
  private cb: NetCallbacks;

  playerId = '';
  code = '';
  phase: Phase = 'lobby';
  players: PlayerInfo[] = [];
  hostId = '';

  // prediction
  private selfSim: SimState | null = null;
  private pending: InputCmd[] = [];
  private seq = 1;
  clientTick = 0;
  arenaRadius: number = TUNING.arena.startRadius;
  roundStartTick = 0;
  corePresent = false;
  private smooth = { x: 0, y: 0 };
  private lastSelfRender = { x: 0, y: 0 };

  // interpolation
  private buffer: TimedSnapshot[] = [];

  // Artificial one-way latency for local testing (PRD §12 step 5). 0 = off.
  private lagMs: number;

  constructor(url: string, cb: NetCallbacks, lagMs = 0) {
    this.url = url;
    this.cb = cb;
    this.lagMs = Math.max(0, lagMs);
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('Falha ao conectar ao servidor.'));
      this.ws.onmessage = (ev) => {
        const data = ev.data as string;
        if (this.lagMs > 0) setTimeout(() => this.onMessage(decode<ServerMessage>(data)), this.lagMs);
        else this.onMessage(decode<ServerMessage>(data));
      };
      this.ws.onclose = () => this.cb.onError?.('Conexão perdida.');
    });
  }

  private sendRaw(msg: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const raw = encode(msg);
    if (this.lagMs > 0) {
      const ws = this.ws;
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(raw);
      }, this.lagMs);
    } else {
      this.ws.send(raw);
    }
  }

  createRoom(nickname: string): void {
    this.sendRaw({ t: 'create_room', nickname });
  }
  joinRoom(nickname: string, code: string): void {
    this.sendRaw({ t: 'join_room', nickname, code });
  }
  reconnectRoom(playerId: string, code: string): void {
    this.sendRaw({ t: 'reconnect', playerId, code });
  }
  startMatch(): void {
    this.sendRaw({ t: 'start_match' });
  }
  playAgain(): void {
    this.sendRaw({ t: 'play_again' });
  }

  get isHost(): boolean {
    return this.playerId === this.hostId;
  }

  // ---- message handling --------------------------------------------------
  private onMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case 'joined':
        this.playerId = msg.playerId;
        this.code = msg.code;
        sessionStorage.setItem('octogono_pid', msg.playerId);
        sessionStorage.setItem('octogono_code', msg.code);
        this.cb.onJoined?.(msg.playerId, msg.code);
        break;
      case 'error':
        this.cb.onError?.(msg.message);
        break;
      case 'room_state':
        this.code = msg.code;
        this.setPhase(msg.phase);
        this.players = msg.players;
        this.hostId = msg.hostId;
        this.cb.onRoomState?.(msg.code, msg.phase, msg.players, msg.hostId);
        break;
      case 'match_started':
        this.resetPrediction();
        this.cb.onMatchStarted?.(msg.roundIndex);
        break;
      case 'countdown':
        this.resetPrediction();
        this.setPhase('countdown');
        this.cb.onCountdown?.(msg.roundIndex, msg.startsInMs);
        break;
      case 'snapshot':
        this.ingestSnapshot(msg);
        this.setPhase(msg.phase); // authoritative phase rides with the snapshot
        break;
      case 'event':
        this.cb.onEvent?.({ kind: msg.kind, playerId: msg.playerId, pos: msg.pos, dir: msg.dir, mag: msg.mag });
        break;
      case 'round_ended':
        this.setPhase('round_end');
        this.cb.onRoundEnded?.(msg.winnerId, msg.scores);
        break;
      case 'match_ended':
        this.setPhase('match_end');
        this.cb.onMatchEnded?.(msg.winnerId, msg.scores);
        break;
    }
  }

  private setPhase(p: Phase): void {
    if (this.phase !== p) {
      this.phase = p;
      this.cb.onPhase?.(p);
    }
  }

  private resetPrediction(): void {
    this.selfSim = null;
    this.pending = [];
    this.buffer = [];
    this.smooth = { x: 0, y: 0 };
  }

  // ---- prediction --------------------------------------------------------
  // Called by the game loop at a fixed 60Hz while playing.
  applyLocalInput(cmd: Omit<InputCmd, 'seq'>): void {
    // Predict only while actually playing — the server holds discs at spawn
    // during the countdown, so predicting movement then would mispredict hard.
    if (this.phase !== 'playing') return;
    const input: InputCmd = { seq: this.seq++, ...cmd };
    this.sendRaw({ t: 'input', seq: input.seq, dir: input.dir, push: input.push, reflect: input.reflect });
    this.pending.push(input);

    if (this.selfSim) {
      const inputs: InputMap = new Map([[this.playerId, input]]);
      step(this.selfSim, inputs, 1 / 60);
      this.clientTick = this.selfSim.tick;
      // decay the smoothing offset toward zero
      this.smooth.x *= 0.8;
      this.smooth.y *= 0.8;
    }
  }

  private ingestSnapshot(msg: Extract<ServerMessage, { t: 'snapshot' }>): void {
    const discMap = new Map<string, DiscSnapshot>();
    for (const d of msg.discs) discMap.set(d.playerId, d);
    this.buffer.push({
      recvTime: performance.now(),
      tick: msg.tick,
      roundStartTick: msg.roundStartTick,
      arenaRadius: msg.arenaRadius,
      discs: discMap,
    });
    if (this.buffer.length > 20) this.buffer.shift();

    this.arenaRadius = msg.arenaRadius;
    this.roundStartTick = msg.roundStartTick;
    this.corePresent = msg.corePresent;

    // Reconcile the local disc.
    const auth = discMap.get(this.playerId);
    if (!auth) return;

    const prevRender = { ...this.lastSelfRender };

    if (!this.selfSim) {
      const disc = this.authToDisc(auth);
      this.selfSim = { tick: msg.tick, roundStartTick: msg.roundStartTick, arenaRadius: msg.arenaRadius, discs: [disc] };
    } else {
      const disc = this.selfSim.discs[0];
      this.copyAuth(disc, auth);
      this.selfSim.tick = msg.tick;
      this.selfSim.roundStartTick = msg.roundStartTick;
    }

    // drop acknowledged inputs, replay the rest
    this.pending = this.pending.filter((i) => i.seq > msg.lastSeq);
    for (const input of this.pending) {
      step(this.selfSim, new Map([[this.playerId, input]]), 1 / 60);
    }
    this.clientTick = this.selfSim.tick;

    // smoothing: keep drawing where we were, then ease to the corrected spot
    const corrected = this.selfSim.discs[0].pos;
    const ex = prevRender.x - corrected.x;
    const ey = prevRender.y - corrected.y;
    if (Math.hypot(ex, ey) < MAX_SMOOTH) {
      this.smooth = { x: ex, y: ey };
    } else {
      this.smooth = { x: 0, y: 0 }; // too far off — snap
    }
  }

  private authToDisc(a: DiscSnapshot): Disc {
    const d = makeDisc(a.playerId, a.pos);
    this.copyAuth(d, a);
    return d;
  }
  private copyAuth(d: Disc, a: DiscSnapshot): void {
    d.pos = { x: a.pos.x, y: a.pos.y };
    d.vel = { x: a.vel.x, y: a.vel.y };
    d.alive = a.alive;
    d.ghost = a.ghost;
    d.reflectState = a.reflectState;
    d.reflectUntil = a.reflectUntil;
    d.pushCooldownUntil = a.pushCooldownUntil;
    d.reflectCooldownUntil = a.reflectCooldownUntil;
    d.pushAnimUntil = a.pushAnimUntil;
    d.coreChargeUntil = a.coreChargeUntil;
  }

  // ---- world for rendering -----------------------------------------------
  // Self = predicted (+smoothing); others = interpolated ~100ms in the past.
  getRenderDiscs(now: number): RenderDisc[] {
    const out: RenderDisc[] = [];
    const renderTime = now - INTERP_DELAY_MS;

    // interpolation bracket
    let older: TimedSnapshot | null = null;
    let newer: TimedSnapshot | null = null;
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      if (this.buffer[i].recvTime <= renderTime) {
        older = this.buffer[i];
        newer = this.buffer[i + 1] ?? this.buffer[i];
        break;
      }
    }
    if (!older) {
      older = this.buffer[0] ?? null;
      newer = this.buffer[0] ?? null;
    }

    const ids = new Set<string>();
    if (older) for (const id of older.discs.keys()) ids.add(id);

    for (const id of ids) {
      if (id === this.playerId && this.selfSim) {
        const d = this.selfSim.discs[0];
        const rp = { x: d.pos.x + this.smooth.x, y: d.pos.y + this.smooth.y };
        this.lastSelfRender = { x: rp.x, y: rp.y };
        // decay smoothing every render too, so it fades even without input
        this.smooth.x *= 0.85;
        this.smooth.y *= 0.85;
        out.push({
          playerId: id,
          pos: rp,
          vel: d.vel,
          alive: d.alive,
          ghost: d.ghost,
          reflectState: d.reflectState,
          pushCooldownUntil: d.pushCooldownUntil,
          reflectCooldownUntil: d.reflectCooldownUntil,
          reflectUntil: d.reflectUntil,
          pushAnimUntil: d.pushAnimUntil,
          coreChargeUntil: d.coreChargeUntil,
          isSelf: true,
        });
        continue;
      }
      const a = older!.discs.get(id);
      if (!a) continue;
      const b = newer!.discs.get(id) ?? a;
      let t = 0;
      if (newer && older && newer.recvTime > older.recvTime) {
        t = (renderTime - older.recvTime) / (newer.recvTime - older.recvTime);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
      }
      out.push({
        playerId: id,
        pos: { x: a.pos.x + (b.pos.x - a.pos.x) * t, y: a.pos.y + (b.pos.y - a.pos.y) * t },
        vel: b.vel,
        alive: b.alive,
        ghost: b.ghost,
        reflectState: b.reflectState,
        pushCooldownUntil: b.pushCooldownUntil,
        reflectCooldownUntil: b.reflectCooldownUntil,
        reflectUntil: b.reflectUntil,
        pushAnimUntil: b.pushAnimUntil,
        coreChargeUntil: b.coreChargeUntil,
        isSelf: false,
      });
    }
    return out;
  }

  colorOf(playerId: string): string {
    return this.players.find((p) => p.id === playerId)?.color ?? '#ffffff';
  }
  nicknameOf(playerId: string): string {
    return this.players.find((p) => p.id === playerId)?.nickname ?? '???';
  }
}
