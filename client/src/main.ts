// Client entry point: screen flow (home -> lobby/solo -> match -> end), the
// render loop, and the fixed-step pump. Two drivers share the same renderer:
//   - NetClient  : online, server-authoritative (prediction/reconciliation)
//   - LocalGame  : offline single-player vs AI (runs the sim locally)

import '@fontsource/archivo-black';
import '@fontsource-variable/archivo';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
import './style.css';
import { NetClient } from './net';
import { LocalGame } from './local';
import { Tutorial } from './tutorial';
import type { Difficulty } from './ai';
import { InputController } from './input';
import { Effects } from './effects';
import { Renderer } from './render';
import { initNative, isNative } from './native';
import { hapticPushLand, hapticReflectHit, hapticEliminated } from './haptics';
import { settings, setSetting, applyToDocument } from './settings';
import { unlockAudio, sfxPush, sfxClash, sfxEliminated, sfxCountdown } from './sfx';
import { TUNING, MAX_ROUND_TICKS } from '../../shared/tuning';
import type { PlayerInfo, Phase, SimEventKind } from '../../shared/protocol';
import type { SimEvent } from '../../shared/types';

const PUSH_CD_TICKS = Math.round((TUNING.push.cooldown / 1000) * 60);
const REFLECT_CD_TICKS = Math.round((TUNING.reflect.cooldown / 1000) * 60);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Outcome haptics — only for events that involve the local player.
function outcomeHaptic(kind: SimEventKind, playerId: string, selfId: string): void {
  if (playerId !== selfId) return;
  if (kind === 'push') hapticPushLand();
  else if (kind === 'clash' || kind === 'reflect') hapticReflectHit();
  else if (kind === 'eliminated') hapticEliminated();
}

// In Vite dev the client is on :5173 and the server on :8787 (different origin).
// When the server serves the built client, WebSocket shares the page's origin.
const WS_PROTO = location.protocol === 'https:' ? 'wss' : 'ws';
const ENV_WS_URL = (import.meta as any).env?.VITE_WS_URL as string | undefined;
const WS_URL =
  ENV_WS_URL ??
  (location.port === '5173' ? `ws://${location.hostname}:8787` : `${WS_PROTO}://${location.host}`);

// Online is available on the web (same-origin server) and in a native app ONLY
// when a server URL was baked in at build time (VITE_WS_URL). A native build
// without it ships as a clean, offline solo-only app — no dead "Criar sala".
// `?soloonly` forces the solo-only layout in a browser, to preview that build.
const FORCE_SOLO = new URLSearchParams(location.search).has('soloonly');
const ONLINE_ENABLED = !FORCE_SOLO && (!!ENV_WS_URL || !isNative());

// ---- DOM refs --------------------------------------------------------------
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const screens = { home: $('#home'), lobby: $('#lobby'), end: $('#end') };
const hud = $('#hud');
const canvas = $('#game') as HTMLCanvasElement;

const nickInput = $('#nick') as HTMLInputElement;
const codeInput = $('#code') as HTMLInputElement;
const btnCreate = $('#btnCreate');
const btnJoin = $('#btnJoin');
const btnSolo = $('#btnSolo');
const btnHowto = $('#btnHowto');
const segBots = $('#segBots');
const segDiff = $('#segDiff');
const segFmt = $('#segFmt');
const btnShare = $('#btnShare');
const endTally = $('#endTally');
const calloutEl = $('#callout');
const homeError = $('#homeError');

const lobbyCode = $('#lobbyCode');
const lobbyPlayers = $('#lobbyPlayers');
const btnStart = $('#btnStart') as HTMLButtonElement;
const btnCopy = $('#btnCopy');
const lobbyHint = $('#lobbyHint');

const endTitle = $('#endTitle');
const endScores = $('#endScores');
const btnAgain = $('#btnAgain') as HTMLButtonElement;
const btnMenu = $('#btnMenu');

function showScreen(name: 'home' | 'lobby' | 'match' | 'end'): void {
  screens.home.classList.toggle('hidden', name !== 'home');
  screens.lobby.classList.toggle('hidden', name !== 'lobby');
  screens.end.classList.toggle('hidden', name !== 'end');
  hud.classList.toggle('hidden', name !== 'match');
  canvas.classList.toggle('dim', name !== 'match');
}

// ---- state -----------------------------------------------------------------
type Mode = 'online' | 'local' | null;
let mode: Mode = null;
let net: NetClient | null = null;
let local: LocalGame | null = null;
let tutorial: Tutorial | null = null;
let scores: Record<string, number> = {}; // online scores (from server messages)
let countdownEnd = 0; // online countdown (ms)
let roundWinnerId: string | null = null; // online
let matchWinnerId: string | null = null; // online
let endShown = false;
let paused = false; // settings modal open (pauses solo)
const tally = { you: 0, cpu: 0 }; // in-memory session tally (solo)
let calloutShrink = false;
let calloutGhost = false;
let calloutHideT = 0;
let slowmoUntil = 0;
let lastBeepSec = -1;

const effects = new Effects();
const renderer = new Renderer(canvas);
const inputCtl = new InputController(document.body);

// safe-area top inset (iOS notch) so the scoreboard clears the status bar
const probe = document.createElement('div');
probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top,0px);';
document.body.appendChild(probe);
renderer.safeTop = probe.offsetHeight || 0;

// ---- boot ------------------------------------------------------------------
const params = new URLSearchParams(location.search);
const preCode = params.get('sala');
if (preCode) codeInput.value = preCode.toUpperCase();
nickInput.value = sessionStorage.getItem('octogono_nick') ?? '';
const lagMs = Number(params.get('lat')) || 0; // ?lat=120 simulates 120ms latency
if (params.has('touch')) document.body.classList.add('force-touch'); // preview mobile HUD on desktop

// ---- online (NetClient) ----------------------------------------------------
function makeNet(): NetClient {
  const n = new NetClient(
    WS_URL,
    {
      onJoined: () => sessionStorage.setItem('octogono_nick', nickInput.value),
      onError: (m) => showHomeError(m),
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
        resetMatchExtras();
        showScreen('match');
      },
      onMatchStarted: () => showScreen('match'),
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
        effects.handle(e, (id) => net!.colorOf(id), performance.now());
        outcomeHaptic(e.kind, e.playerId, net!.playerId);
        eventSfx(e, net!.playerId);
      },
      onPhase: () => {},
    },
    lagMs,
  );
  (window as any).__net = n;
  return n;
}

async function ensureConnected(): Promise<boolean> {
  homeError.classList.add('hidden');
  if (!net) net = makeNet();
  try {
    await net.connect();
    return true;
  } catch {
    showHomeError('Não foi possível conectar ao servidor.');
    return false;
  }
}
function showHomeError(m: string): void {
  homeError.textContent = m;
  homeError.classList.remove('hidden');
}

btnCreate.addEventListener('click', async () => {
  if (!nickInput.value.trim()) return flagNick();
  if (await ensureConnected()) {
    mode = 'online';
    net!.createRoom(nickInput.value);
  }
});
btnJoin.addEventListener('click', async () => {
  if (!nickInput.value.trim()) return flagNick();
  const code = codeInput.value.trim().toUpperCase();
  if (code.length !== 4) return showHomeError('O código tem 4 letras.');
  if (await ensureConnected()) {
    mode = 'online';
    net!.joinRoom(nickInput.value, code);
  }
});
function flagNick(): void {
  nickInput.focus();
  nickInput.classList.add('shake');
  setTimeout(() => nickInput.classList.remove('shake'), 400);
}

// ---- solo (LocalGame) ------------------------------------------------------
let selBots = 2;
let selDiff: Difficulty = 'normal';
let selFast = false;
segChoose(segBots, (b) => (selBots = Number(b)));
segChoose(segDiff, (d) => (selDiff = d as Difficulty));
segChoose(segFmt, (f) => (selFast = f === 'fast'));

function segChoose(group: HTMLElement, set: (v: string) => void): void {
  group.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      group.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      set((b.dataset.b ?? b.dataset.d ?? b.dataset.f)!);
    }),
  );
}

function startSolo(): void {
  mode = 'local';
  if (!local) local = new LocalGame();
  endShown = false;
  resetMatchExtras();
  local.start(selBots, selDiff, selFast);
  (window as any).__local = local; // debug hook for smoke tests
  showScreen('match');
}

function startTutorial(): void {
  mode = 'local';
  if (!local) local = new LocalGame();
  endShown = false;
  resetMatchExtras();
  tutorial = new Tutorial(local, () => {
    tutorial = null;
    startSolo(); // drop straight into a real match when the drill ends
  });
  (window as any).__local = local;
  (window as any).__tut = tutorial;
  tutorial.start();
  showScreen('match');
}

const tutorialDone = () => {
  try {
    return localStorage.getItem('octogono_tutorial_done') === '1';
  } catch {
    return false;
  }
};

btnSolo.addEventListener('click', () => {
  if (tutorialDone()) startSolo();
  else startTutorial(); // teach the controls on the very first play
});
btnHowto.addEventListener('click', startTutorial); // replay any time

// ---- settings --------------------------------------------------------------
applyToDocument();
const gear = $('#gear');
const settingsModal = $('#settings');
const setSound = $('#setSound') as HTMLInputElement;
const setHaptics = $('#setHaptics') as HTMLInputElement;
const setReduce = $('#setReduce') as HTMLInputElement;
const setText = $('#setText') as HTMLInputElement;
const segHand = $('#setHand');

function syncSettingsUI(): void {
  setSound.checked = settings.sound;
  setHaptics.checked = settings.haptics;
  setReduce.checked = settings.reducedMotion;
  setText.checked = settings.largeText;
  segHand.querySelectorAll('button').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.h === settings.hand));
}
gear.addEventListener('click', () => {
  syncSettingsUI();
  settingsModal.classList.remove('hidden');
  paused = true;
});
$('#setClose').addEventListener('click', () => {
  settingsModal.classList.add('hidden');
  paused = false;
});
setSound.addEventListener('change', () => setSetting('sound', setSound.checked));
setHaptics.addEventListener('change', () => setSetting('haptics', setHaptics.checked));
setReduce.addEventListener('change', () => setSetting('reducedMotion', setReduce.checked));
setText.addEventListener('change', () => setSetting('largeText', setText.checked));
segHand.querySelectorAll('button').forEach((b) =>
  b.addEventListener('click', () => {
    segHand.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    setSetting('hand', (b as HTMLElement).dataset.h as 'R' | 'L');
  }),
);
window.addEventListener('pointerdown', () => unlockAudio(), { once: true });

// ---- SFX + callouts --------------------------------------------------------
function eventSfx(e: SimEvent, selfId: string): void {
  if (e.kind === 'push' && e.playerId === selfId) sfxPush();
  else if (e.kind === 'clash' && (e.mag ?? 0) > 0.25) sfxClash();
  else if (e.kind === 'eliminated') sfxEliminated();
}
function showCallout(text: string): void {
  calloutEl.textContent = text;
  calloutEl.classList.remove('hidden');
  calloutHideT = performance.now() + 2200;
}
function resetMatchExtras(): void {
  calloutShrink = false;
  calloutGhost = false;
  slowmoUntil = 0;
  lastBeepSec = -1;
}
btnShare.addEventListener('click', async () => {
  const isLocal = mode === 'local';
  const w = isLocal ? local!.matchWinnerId : matchWinnerId;
  const src = isLocal ? local! : net!;
  const txt = w ? `${src.nicknameOf(w)} venceu no Octógono — sumô eletrônico! 🥋` : 'Empate no Octógono! 🥋';
  try {
    if ((navigator as any).share) await (navigator as any).share({ text: txt });
    else {
      await navigator.clipboard.writeText(txt);
      btnShare.textContent = 'Copiado!';
      setTimeout(() => (btnShare.textContent = 'Compartilhar'), 1500);
    }
  } catch {
    /* user cancelled share — ignore */
  }
});

// ---- lobby -----------------------------------------------------------------
function renderLobby(code: string, players: PlayerInfo[], _hostId: string): void {
  lobbyCode.textContent = code;
  lobbyPlayers.innerHTML = '';
  for (const p of players) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot" style="background:${p.color};color:${p.color}"></span>
      <span class="pname">${escapeHtml(p.nickname)}</span>
      ${p.isHost ? '<span class="host">host</span>' : ''}
      ${p.connected ? '' : '<span class="off">offline</span>'}`;
    lobbyPlayers.appendChild(li);
  }
  const canStart = net!.isHost && players.length >= TUNING.match.minPlayers;
  btnStart.classList.toggle('hidden', !net!.isHost);
  btnStart.disabled = !canStart;
  lobbyHint.textContent = net!.isHost
    ? players.length < 2
      ? 'Aguardando pelo menos 2 jogadores…'
      : 'Tudo pronto. Empurre-os pra fora.'
    : 'Aguardando o host começar…';
}

btnStart.addEventListener('click', () => net?.startMatch());
btnCopy.addEventListener('click', async () => {
  const link = `${location.origin}${location.pathname}?sala=${net?.code ?? ''}`;
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
  endShown = true;
  const isLocal = mode === 'local';
  const src = isLocal ? local! : net!;
  const w = isLocal ? local!.matchWinnerId : matchWinnerId;
  const sc = isLocal ? local!.scores : scores;
  endTitle.innerHTML = w
    ? `<span style="color:${src.colorOf(w)}">${escapeHtml(src.nicknameOf(w))}</span> venceu`
    : 'Fim de partida';
  endScores.innerHTML = src.players
    .map(
      (p) =>
        `<div><span class="dot" style="background:${p.color};color:${p.color}"></span> ${escapeHtml(p.nickname)} — <b>${sc[p.id] ?? 0}</b></div>`,
    )
    .join('');
  // session tally (solo): Você vs CPU across the session
  if (isLocal) {
    if (w === local!.playerId) tally.you++;
    else if (w) tally.cpu++;
    endTally.textContent = `Sessão — Você ${tally.you} · CPU ${tally.cpu}`;
    endTally.classList.remove('hidden');
  } else {
    endTally.classList.add('hidden');
  }
  const canAgain = isLocal ? true : net!.isHost;
  btnAgain.classList.toggle('hidden', !canAgain);
  showScreen('end');
}
btnAgain.addEventListener('click', () => {
  if (mode === 'local' && local) {
    endShown = false;
    local.playAgain();
    showScreen('match');
  } else {
    net?.playAgain();
  }
});
btnMenu.addEventListener('click', () => {
  if (mode === 'online') {
    location.reload(); // cleanly leave the room
  } else {
    mode = null;
    local = null;
    showScreen('home');
  }
});

// ---- game loop -------------------------------------------------------------
let acc = 0;
let last = performance.now();
const STEP = 1000 / 60;

function loop(now: number): void {
  requestAnimationFrame(loop);
  let dt = now - last;
  last = now;
  if (dt > 250) dt = 250;

  // Fixed-step pump, capped so a post-stall catch-up can't burst past the
  // server's input rate limit (or over-run the local sim).
  const MAX_STEPS = 4;
  if (mode === 'online' && net && net.phase === 'playing') {
    acc += dt;
    let n = 0;
    while (acc >= STEP && n < MAX_STEPS) {
      const s = inputCtl.sample();
      net.applyLocalInput({ dir: s.dir, push: s.push, reflect: s.reflect });
      acc -= STEP;
      n++;
    }
    if (acc > STEP * MAX_STEPS) acc = 0;
  } else if (mode === 'local' && local && local.phase !== 'match_end') {
    if (paused || effects.isFrozen(now)) {
      acc = 0; // paused (settings open) or hitstop: freeze the local sim
    } else {
      // brief slow-mo makes a ring-out land harder
      acc += now < slowmoUntil ? dt * 0.45 : dt;
      let n = 0;
      const frameEvents: SimEvent[] = [];
      while (acc >= STEP && n < MAX_STEPS) {
        const s = inputCtl.sample();
        const events = local.step({ dir: s.dir, push: s.push, reflect: s.reflect });
        for (const e of events) {
          effects.handle(e, (id) => local!.colorOf(id), now);
          outcomeHaptic(e.kind, e.playerId, local!.playerId);
          eventSfx(e, local!.playerId);
          if (e.kind === 'eliminated' && !tutorial) slowmoUntil = now + 240;
          frameEvents.push(e);
        }
        acc -= STEP;
        n++;
        if (local.isMatchOver) break;
      }
      if (acc > STEP * MAX_STEPS) acc = 0;
      // drive the tutorial step machine (sets the dummy's next input + advances)
      if (tutorial) tutorial.update(inputCtl.sample(), frameEvents, dt);
    }
    if (!tutorial && local.isMatchOver && !endShown) showEnd();
  } else {
    acc = 0;
  }

  const drawing =
    (mode === 'online' && net && net.phase !== 'lobby' && net.phase !== 'match_end') ||
    (mode === 'local' && local);
  if (drawing) render(now);
  effects.update(dt / 1000);
}

function render(now: number): void {
  const isLocal = mode === 'local';
  const src = isLocal ? local! : net!;
  const discs = src.getRenderDiscs(now);
  // feed the on-button cooldown radials from the self disc
  const me = discs.find((d) => d.isSelf);
  inputCtl.setCooldowns(
    me ? clamp01((me.pushCooldownUntil - src.clientTick) / PUSH_CD_TICKS) : 0,
    me ? clamp01((me.reflectCooldownUntil - src.clientTick) / REFLECT_CD_TICKS) : 0,
  );
  const roundTimeLeft = Math.max(0, (MAX_ROUND_TICKS - (src.clientTick - src.roundStartTick)) / 60);
  const countdownLeft = isLocal
    ? Math.max(0, (src.roundStartTick - src.clientTick) / 60)
    : Math.max(0, (countdownEnd - now) / 1000);

  // countdown beeps (3-2-1-VAI!)
  if (src.phase === 'countdown') {
    const sec = Math.ceil(countdownLeft);
    if (sec !== lastBeepSec) {
      if (sec >= 1 && sec <= 3) sfxCountdown(false);
      lastBeepSec = sec;
    }
  } else if (src.phase === 'playing' && lastBeepSec !== 0) {
    sfxCountdown(true); // "VAI!"
    lastBeepSec = 0;
  }

  // just-in-time callouts (first shrink, first ghost of the match)
  if (src.phase === 'playing' && !tutorial) {
    if (!calloutShrink && src.arenaRadius < TUNING.arena.startRadius - 3) {
      calloutShrink = true;
      showCallout('A arena está encolhendo!');
    }
    if (!calloutGhost && discs.some((d) => d.ghost)) {
      calloutGhost = true;
      showCallout('Fantasma! Ataque da borda');
    }
  }
  if (calloutHideT && now > calloutHideT) {
    calloutEl.classList.add('hidden');
    calloutHideT = 0;
  }

  renderer.draw(
    {
      discs,
      arenaRadius: src.arenaRadius,
      clientTick: src.clientTick,
      phase: src.phase as Phase,
      players: src.players,
      selfId: src.playerId,
      scores: isLocal ? local!.scores : scores,
      countdownLeft,
      roundTimeLeft,
      roundWinnerId: isLocal ? local!.roundWinnerId : roundWinnerId,
      matchWinnerId: isLocal ? local!.matchWinnerId : matchWinnerId,
      scoreToWin: isLocal ? local!.scoreToWin : TUNING.match.scoreToWin,
    },
    effects,
    now,
  );
}

// Solo-only build: hide the online UI entirely so there are no dead buttons.
if (!ONLINE_ENABLED) {
  document.getElementById('onlineSection')?.classList.add('hidden');
}

requestAnimationFrame(loop);
showScreen('home');
void initNative();

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
