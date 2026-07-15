// WebSocket entry point. Routes client messages to rooms; owns room creation,
// codes, rate limiting, and the connection lifecycle.

import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { join, extname, normalize } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { GameLoop } from './loop';
import { Room } from './room';
import type { ClientMessage } from '../../shared/protocol';
import { encode, decode } from '../../shared/protocol';
import { TUNING } from '../../shared/tuning';

const PORT = Number(process.env.PORT ?? 8787);
const MAX_ROOMS = 100;
const MAX_INPUTS_PER_SEC = 70;

const loop = new GameLoop();
loop.start();

// 4 unambiguous letters (no vowels/confusables to keep it speakable).
const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
function makeCode(): string {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}
function freshCode(): string {
  let code = makeCode();
  let guard = 0;
  while (loop.rooms.has(code) && guard++ < 50) code = makeCode();
  return code;
}

interface Conn {
  socket: WebSocket;
  playerId: string | null;
  roomCode: string | null;
  inputTimes: number[]; // sliding window for input rate limiting
  controlTimes: number[]; // sliding window for control-message rate limiting
}

const MAX_CONTROL_PER_SEC = 20; // create/join/start/etc — generous but bounded
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

// Validate a decoded client message at the trust boundary. Never trust the wire.
function validClientMessage(m: unknown): m is ClientMessage {
  if (!m || typeof m !== 'object') return false;
  const msg = m as Record<string, unknown>;
  switch (msg.t) {
    case 'create_room':
      return isStr(msg.nickname);
    case 'join_room':
      return isStr(msg.nickname) && isStr(msg.code);
    case 'reconnect':
      return isStr(msg.playerId) && isStr(msg.code);
    case 'start_match':
    case 'play_again':
      return true;
    case 'input':
      return (
        isNum(msg.seq) &&
        typeof msg.push === 'boolean' &&
        typeof msg.reflect === 'boolean' &&
        !!msg.dir &&
        typeof msg.dir === 'object'
      );
    default:
      return false;
  }
}

// Serve the built client (client/dist) so this is a single deployable service.
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = process.env.CLIENT_DIST ?? join(__dirname, '../../client/dist');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function serveStatic(urlPath: string, res: import('http').ServerResponse): Promise<void> {
  // strip query, prevent path traversal, default to index.html (SPA)
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    // malformed percent-encoding (e.g. `/%`) — reject instead of crashing
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('Bad request');
    return;
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const full = join(CLIENT_DIST, safe);
  try {
    const body = await readFile(full);
    res.writeHead(200, { 'content-type': MIME[extname(full)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    // SPA fallback
    try {
      const body = await readFile(join(CLIENT_DIST, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'] });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Octógono server. Client build not found — connect via WebSocket.');
    }
  }
}

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: loop.roomCount }));
    return;
  }
  void serveStatic(req.url ?? '/', res);
});

const wss = new WebSocketServer({ server });

wss.on('connection', (socket) => {
  const conn: Conn = { socket, playerId: null, roomCode: null, inputTimes: [], controlTimes: [] };

  socket.on('message', (data) => {
    let msg: unknown;
    try {
      msg = decode<unknown>(data.toString());
    } catch {
      return; // not JSON — drop
    }
    if (!validClientMessage(msg)) return; // malformed — drop, never crash
    // Never let one bad message take down the process (and every live room).
    try {
      handleMessage(conn, msg);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('handleMessage error:', err);
    }
  });

  socket.on('close', () => {
    if (conn.roomCode && conn.playerId) {
      const room = loop.rooms.get(conn.roomCode);
      // Only mark offline if THIS socket is still the player's current one —
      // a reconnect may already have swapped in a newer socket.
      if (room && room.isCurrentSocket(conn.playerId, socket)) {
        room.markDisconnected(conn.playerId);
        room.broadcastRoomState();
      }
    }
  });

  socket.on('error', () => {
    /* swallow — close will follow */
  });
});

function sendError(conn: Conn, message: string): void {
  if (conn.socket.readyState === WebSocket.OPEN) conn.socket.send(encode({ t: 'error', message }));
}

function handleMessage(conn: Conn, msg: ClientMessage): void {
  // Rate-limit control messages (create/join/etc) so one socket can't spam-create
  // rooms and exhaust the cap. Inputs have their own limiter.
  if (msg.t !== 'input' && !allowControl(conn)) return;

  switch (msg.t) {
    case 'create_room': {
      if (loop.roomCount >= MAX_ROOMS) return sendError(conn, 'Servidor lotado. Tente mais tarde.');
      leaveCurrentRoom(conn); // abandon any prior room so it doesn't leak
      const code = freshCode();
      const room = new Room(code, Date.now());
      loop.rooms.set(code, room);
      joinRoom(conn, room, msg.nickname);
      break;
    }
    case 'join_room': {
      const room = loop.rooms.get(msg.code.toUpperCase());
      if (!room) return sendError(conn, 'Sala não encontrada.');
      if (room.players.size >= TUNING.match.maxPlayers) return sendError(conn, 'Sala cheia.');
      if (room.phase !== 'lobby' && room.phase !== 'match_end') {
        return sendError(conn, 'A partida já começou.');
      }
      leaveCurrentRoom(conn); // abandon any prior room so it doesn't leak
      joinRoom(conn, room, msg.nickname);
      break;
    }
    case 'reconnect': {
      const room = loop.rooms.get(msg.code.toUpperCase());
      if (!room) return sendError(conn, 'Sala não encontrada.');
      const player = room.reconnect(msg.playerId, conn.socket);
      if (!player) return sendError(conn, 'Sessão expirada.');
      conn.playerId = player.id;
      conn.roomCode = room.code;
      room.setActivity(Date.now());
      conn.socket.send(encode({ t: 'joined', playerId: player.id, code: room.code, you: infoOf(room, player.id) }));
      room.broadcastRoomState();
      break;
    }
    case 'start_match': {
      const room = requireRoom(conn);
      if (!room || !conn.playerId) return;
      if (room.startMatch(conn.playerId)) room.setActivity(Date.now());
      else sendError(conn, 'Não foi possível começar (mínimo 2 jogadores).');
      break;
    }
    case 'play_again': {
      const room = requireRoom(conn);
      if (!room || !conn.playerId) return;
      room.playAgain(conn.playerId);
      room.setActivity(Date.now());
      break;
    }
    case 'input': {
      const room = requireRoom(conn);
      if (!room || !conn.playerId) return;
      if (!allowInput(conn)) return; // rate limit
      // Sanitize dir at the trust boundary: a non-finite component would seed
      // NaN into the deterministic sim and create an un-eliminable disc.
      room.setInput(conn.playerId, {
        seq: msg.seq,
        dir: { x: isNum(msg.dir.x) ? msg.dir.x : 0, y: isNum(msg.dir.y) ? msg.dir.y : 0 },
        push: msg.push,
        reflect: msg.reflect,
      });
      room.setActivity(Date.now());
      break;
    }
  }
}

function joinRoom(conn: Conn, room: Room, nickname: string): void {
  const player = room.addPlayer(nickname, conn.socket);
  if (!player) return sendError(conn, 'Sala cheia.');
  conn.playerId = player.id;
  conn.roomCode = room.code;
  room.setActivity(Date.now());
  conn.socket.send(encode({ t: 'joined', playerId: player.id, code: room.code, you: infoOf(room, player.id) }));
  room.broadcastRoomState();
}

function infoOf(room: Room, playerId: string) {
  return room.playerInfos().find((p) => p.id === playerId)!;
}

function requireRoom(conn: Conn): Room | null {
  if (!conn.roomCode) return null;
  return loop.rooms.get(conn.roomCode) ?? null;
}

function allowInput(conn: Conn): boolean {
  const now = Date.now();
  const win = conn.inputTimes;
  win.push(now);
  while (win.length && now - win[0] > 1000) win.shift();
  return win.length <= MAX_INPUTS_PER_SEC;
}

function allowControl(conn: Conn): boolean {
  const now = Date.now();
  const win = conn.controlTimes;
  win.push(now);
  while (win.length && now - win[0] > 1000) win.shift();
  return win.length <= MAX_CONTROL_PER_SEC;
}

// Remove this connection from whatever room it was in, so abandoned rooms can
// be reaped instead of pinning the 100-room cap forever.
function leaveCurrentRoom(conn: Conn): void {
  if (conn.roomCode && conn.playerId) {
    const room = loop.rooms.get(conn.roomCode);
    if (room && room.isCurrentSocket(conn.playerId, conn.socket)) {
      room.removePlayer(conn.playerId);
      room.broadcastRoomState();
    }
  }
  conn.roomCode = null;
  conn.playerId = null;
}

// Defense in depth: never let an unexpected throw/rejection kill the process
// and drop every live match. (The message and tick paths are already guarded.)
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('unhandledRejection:', reason);
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Octógono server ouvindo em :${PORT}`);
});
