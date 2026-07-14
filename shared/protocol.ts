// The message contract between client and server (PRD §6.5).
//
// Snapshots are the source of truth and must never be dropped silently.
// Events are pure feedback: losing one costs a visual, never correctness.

import type { Vec2 } from './math';
import type { Phase, ReflectState, SimEventKind } from './types';

// Re-export so the client can pull wire + domain types from one module.
export type { Phase, ReflectState, SimEventKind } from './types';

// ---- shared shapes ---------------------------------------------------------

export interface PlayerInfo {
  id: string;
  nickname: string;
  color: string;
  connected: boolean;
  score: number;
  isHost: boolean;
}

// A disc as it travels on the wire — compact but complete enough to render
// and to reconcile against.
export interface DiscSnapshot {
  playerId: string;
  pos: Vec2;
  vel: Vec2;
  alive: boolean;
  ghost: boolean;
  reflectState: ReflectState;
  pushCooldownUntil: number;
  reflectCooldownUntil: number;
  reflectUntil: number;
  pushAnimUntil: number;
}

// ---- client -> server ------------------------------------------------------

export type ClientMessage =
  | { t: 'create_room'; nickname: string }
  | { t: 'join_room'; nickname: string; code: string }
  | { t: 'reconnect'; playerId: string; code: string }
  | { t: 'start_match' }
  | { t: 'input'; seq: number; dir: Vec2; push: boolean; reflect: boolean }
  | { t: 'play_again' };

// ---- server -> client ------------------------------------------------------

export type ServerMessage =
  | { t: 'joined'; playerId: string; code: string; you: PlayerInfo }
  | { t: 'error'; message: string }
  | { t: 'room_state'; code: string; phase: Phase; players: PlayerInfo[]; hostId: string }
  | { t: 'match_started'; roundIndex: number }
  | { t: 'countdown'; roundIndex: number; startsInMs: number }
  | {
      t: 'snapshot';
      tick: number;
      lastSeq: number;
      phase: Phase;
      arenaRadius: number;
      roundStartTick: number;
      discs: DiscSnapshot[];
    }
  | { t: 'event'; kind: SimEventKind; playerId: string; pos: Vec2; dir?: Vec2; mag?: number }
  | { t: 'round_ended'; winnerId: string | null; scores: Record<string, number> }
  | { t: 'match_ended'; winnerId: string | null; scores: Record<string, number> };

// A feedback event as consumed by the client's effect layer.
export interface SimEventLike {
  kind: SimEventKind;
  playerId: string;
  pos: Vec2;
  dir?: Vec2;
  mag?: number;
}

export const encode = (m: ClientMessage | ServerMessage): string => JSON.stringify(m);
export const decode = <T>(raw: string): T => JSON.parse(raw) as T;
