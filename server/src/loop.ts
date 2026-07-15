// The global clock. One 60Hz tick drives every room's simulation; snapshots
// go out at 20Hz (every 3rd tick). Rooms with nobody connected are reaped.

import { Room } from './room';

const TICK_MS = 1000 / 60;
const SNAPSHOT_EVERY = 3; // 60Hz / 3 = 20Hz
const EMPTY_ROOM_TTL_MS = 3 * 60 * 1000; // destroyed after 3 min with nobody connected
const IDLE_ROOM_TTL_MS = 20 * 60 * 1000; // destroyed after 20 min of no activity

export class GameLoop {
  rooms = new Map<string, Room>();
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private emptySince = new Map<string, number>();

  start(): void {
    let last = Date.now();
    let acc = 0;
    this.timer = setInterval(() => {
      const now = Date.now();
      acc += now - last;
      last = now;
      // catch up if the event loop stalled, but never spiral
      let steps = 0;
      while (acc >= TICK_MS && steps < 5) {
        this.tickOnce(now);
        acc -= TICK_MS;
        steps++;
      }
      if (acc > TICK_MS * 5) acc = 0;
    }, TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tickOnce(now: number): void {
    this.frame++;
    const sendSnapshots = this.frame % SNAPSHOT_EVERY === 0;
    for (const room of this.rooms.values()) {
      // Isolate rooms: a throw in one room's tick must not stop the loop or
      // take down every other live match.
      try {
        room.advance();
        room.flushEvents();
        if (sendSnapshots) room.sendSnapshots();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`room ${room.code} tick error:`, err);
      }
    }
    if (this.frame % 60 === 0) this.reap(now);
  }

  private reap(now: number): void {
    for (const [code, room] of this.rooms) {
      const connected = room.anyoneConnected();
      if (connected) {
        this.emptySince.delete(code);
      } else if (!this.emptySince.has(code)) {
        this.emptySince.set(code, now);
      }
      const emptyFor = this.emptySince.has(code) ? now - this.emptySince.get(code)! : 0;
      // Destroy a room only once nobody is connected. A room with live players
      // is never reaped, even if idle in the lobby — that would yank it out
      // from under them. (Disconnected-and-empty rooms die after EMPTY_ROOM_TTL;
      // truly abandoned ones can also exceed IDLE_ROOM_TTL while empty.)
      if (!connected && (emptyFor > EMPTY_ROOM_TTL_MS || now - room.lastActivity > IDLE_ROOM_TTL_MS)) {
        this.rooms.delete(code);
        this.emptySince.delete(code);
      }
    }
  }

  get roomCount(): number {
    return this.rooms.size;
  }
}
