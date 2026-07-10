// Client entry point: screen flow (home -> lobby -> match -> end), the render
// loop, and the fixed-step input pump that feeds prediction.

import './style.css';
import { NetClient } from './net';
import { InputController } from './input';
import { Effects } from './effects';
import { Renderer } from './render';
import { TUNING, MAX_ROUND_TICKS } from '../../shared/tuning';
import type { PlayerInfo, Phase } from '../../shared/protocol';

// In Vite dev the client is on :5173 and the server on :8787 (different origin).
// When the server serves the built client, WebSocket shares the page's origin.
const WS_PROTO = location.protocol === 'https:' ? 'wss' : 'ws';
const WS_URL =
  (import.meta as any).env?.VITE_WS_URL ??
  (location.port === '5173' ? `ws://${location.hostname}:8787` : `${WS_PROTO}://${location.host}`);

// ---- DOM refs --------------------------------------------------------------
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const screens = {
  home: $('#home'),
  lobby: $('#lobby'),
  end: $('#end'),
};
const hud = $('#hud');
const canvas = $('#game') as HTMLCanvasElement;

const nickInput = $('#nick') as HTMLInputElement;
const codeInput = $('#code') as HTMLInputElement;
const btnCreate = $('#btnCreate');
const btnJoin = $('#btnJoin');
const homeError = $('#homeError');

const lobbyCode = $('#lobbyCode');
const lobbyPlayers = $('#lobbyPlayers');
const btnStart = $('#btnStart') as HTMLButtonElement;
const btnCopy = $('#btnCopy');
const lobbyHint = $('#lobbyHint');

const endTitle = $('#endTitle');
const endScores = $('#endScores');
const btnAgain = $('#btnAgain') as HTMLButtonElement;

function showScreen(name: 'home' | 'lobby' | 'match' | 'end'): void {
  screens.home.classList.toggle('hidden', name !== 'home');
  screens.lobby.classList.toggle('hidden', name !== 'lobby');
  screens.end.classList.toggle('hidden', name !== 'end');
  hud.classList.toggle('hidden', name !== 'match');
  canvas.classList.toggle('dim', name !== 'match');
}

// ---- state -----------------------------------------------------------------
let net: NetClient;
let scores: Record<string, number> = {};
let countdownEnd = 0;
let roundWinnerId: string | null = null;
let matchWinnerId: string | null = null;

const effects = new Effects();
const renderer = new Renderer(canvas);
const inputCtl = new InputController(document.body);

// ---- boot ------------------------------------------------------------------
const params = new URLSearchParams(location.search);
const preCode = params.get('sala');
if (preCode) codeInput.value = preCode.toUpperCase();
nickInput.value = sessionStorage.getItem('octogono_nick') ?? '';

const lagMs = Number(params.get('lat')) || 0; // ?lat=120 simulates 120ms one-way latency

function makeNet(): NetClient {
  const n = new NetClient(WS_URL, {
    onJoined: () => {
      sessionStorage.setItem('octogono_nick', nickInput.value);
    },
    onError: (m) => {
      homeError.textContent = m;
      homeError.classList.remove('hidden');
    },
    onRoomState: (code, phase, players, hostId) => {
      renderLobby(code, players, hostId);
      if (phase === 'lobby' || phase === 'match_end') {
        if (!screens.end.classList.contains('hidden') && phase === 'match_end') return;
        showScreen('lobby');
      }
    },
    onCountdown: (_idx, startsInMs) => {
      countdownEnd = performance.now() + startsInMs;
      roundWinnerId = null;
      showScreen('match');
    },
    onMatchStarted: () => {
      showScreen('match');
    },
    onRoundEnded: (winnerId, sc) => {
      roundWinnerId = winnerId;
      scores = sc;
    },
    onMatchEnded: (winnerId, sc) => {
      matchWinnerId = winnerId;
      scores = sc;
      showEnd();
    },
    onEvent: (e) => {
      effects.handle(e, (id) => net.colorOf(id), performance.now());
    },
    onPhase: () => {},
  }, lagMs);
  (window as any).__net = n; // debug hook for smoke tests / manual inspection
  return n;
}

// ---- home actions ----------------------------------------------------------
async function ensureConnected(): Promise<boolean> {
  homeError.classList.add('hidden');
  if (!net) net = makeNet();
  try {
    await net.connect();
    return true;
  } catch {
    homeError.textContent = 'Não foi possível conectar ao servidor.';
    homeError.classList.remove('hidden');
    return false;
  }
}

btnCreate.addEventListener('click', async () => {
  if (!nickInput.value.trim()) return flagNick();
  if (await ensureConnected()) net.createRoom(nickInput.value);
});
btnJoin.addEventListener('click', async () => {
  if (!nickInput.value.trim()) return flagNick();
  const code = codeInput.value.trim().toUpperCase();
  if (code.length !== 4) {
    homeError.textContent = 'O código tem 4 letras.';
    homeError.classList.remove('hidden');
    return;
  }
  if (await ensureConnected()) net.joinRoom(nickInput.value, code);
});
function flagNick(): void {
  nickInput.focus();
  nickInput.classList.add('shake');
  setTimeout(() => nickInput.classList.remove('shake'), 400);
}

// ---- lobby -----------------------------------------------------------------
function renderLobby(code: string, players: PlayerInfo[], _hostId: string): void {
  lobbyCode.textContent = code;
  lobbyPlayers.innerHTML = '';
  for (const p of players) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot" style="background:${p.color}"></span>
      <span class="pname">${escapeHtml(p.nickname)}</span>
      ${p.isHost ? '<span class="host">host</span>' : ''}
      ${p.connected ? '' : '<span class="off">offline</span>'}`;
    lobbyPlayers.appendChild(li);
  }
  const canStart = net.isHost && players.length >= TUNING.match.minPlayers;
  btnStart.classList.toggle('hidden', !net.isHost);
  btnStart.disabled = !canStart;
  lobbyHint.textContent = net.isHost
    ? players.length < 2
      ? 'Aguardando pelo menos 2 jogadores…'
      : 'Tudo pronto. Empurre-os pra fora.'
    : 'Aguardando o host começar…';
}

btnStart.addEventListener('click', () => net.startMatch());
btnCopy.addEventListener('click', async () => {
  const link = `${location.origin}${location.pathname}?sala=${net.code}`;
  try {
    await navigator.clipboard.writeText(link);
    btnCopy.textContent = 'Copiado!';
    setTimeout(() => (btnCopy.textContent = 'Copiar link'), 1500);
  } catch {
    prompt('Copie o link:', link);
  }
});

// ---- match end -------------------------------------------------------------
function showEnd(): void {
  const w = matchWinnerId;
  endTitle.innerHTML = w
    ? `<span style="color:${net.colorOf(w)}">${escapeHtml(net.nicknameOf(w))}</span> venceu`
    : 'Fim de partida';
  endScores.innerHTML = net.players
    .map((p) => `<div><span class="dot" style="background:${p.color}"></span> ${escapeHtml(p.nickname)} — <b>${scores[p.id] ?? 0}</b></div>`)
    .join('');
  btnAgain.classList.toggle('hidden', !net.isHost);
  showScreen('end');
}
btnAgain.addEventListener('click', () => net.playAgain());

// ---- game loop -------------------------------------------------------------
let acc = 0;
let last = performance.now();
const STEP = 1000 / 60;

function loop(now: number): void {
  requestAnimationFrame(loop);
  let dt = now - last;
  last = now;
  if (dt > 250) dt = 250;

  // fixed-step input pump (prediction runs at 60Hz)
  if (net && net.phase === 'playing') {
    acc += dt;
    while (acc >= STEP) {
      const s = inputCtl.sample();
      net.applyLocalInput({ dir: s.dir, push: s.push, reflect: s.reflect });
      acc -= STEP;
    }
  } else {
    acc = 0;
  }

  if (net && net.phase !== 'lobby' && net.phase !== 'match_end') render(now);
  effects.decay();
}

function render(now: number): void {
  if (effects.isFrozen(now)) {
    // hold the frame during hitstop; still redraw so the flash paints
  }
  const discs = net.getRenderDiscs(now);
  const roundElapsed = net.clientTick - net.roundStartTick;
  const roundTimeLeft = Math.max(0, (MAX_ROUND_TICKS - roundElapsed) / 60);
  const countdownLeft = Math.max(0, (countdownEnd - now) / 1000);
  renderer.draw(
    {
      discs,
      arenaRadius: net.arenaRadius,
      clientTick: net.clientTick,
      phase: net.phase as Phase,
      players: net.players,
      selfId: net.playerId,
      scores,
      countdownLeft,
      roundTimeLeft,
      roundWinnerId,
      matchWinnerId,
    },
    effects,
    now,
  );
}

requestAnimationFrame(loop);
showScreen('home');

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
