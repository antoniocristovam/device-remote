import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { ClientMessage, SignalingErrorCode, type PeerRole, type ServerMessage } from '@rc/protocol';
import { issueIceServers, type TurnConfig } from './turnCredentials.js';

export interface SignalingOptions {
  port: number;
  host?: string;
  turn: TurnConfig;
  maxMessageBytes?: number;
  /** Token bucket: sustained messages/second and burst per connection. */
  rate?: { perSecond: number; burst: number };
  heartbeatMs?: number;
  log?: (msg: string) => void;
}

interface Conn {
  id: string;
  ws: WebSocket;
  rooms: Map<string, PeerRole>;
  tokens: number;
  lastRefill: number;
  alive: boolean;
}

export interface SignalingServer {
  http: Server;
  port: () => number;
  close: () => Promise<void>;
}

/**
 * Minimal relay: a room holds at most one desktop and one android. The server cannot read or
 * forge the end-to-end handshake (signed/MAC'd by the peers), it only forwards it.
 */
export function startSignalingServer(opts: SignalingOptions): Promise<SignalingServer> {
  const log = opts.log ?? (() => {});
  const rate = opts.rate ?? { perSecond: 50, burst: 200 };
  const rooms = new Map<string, Map<PeerRole, Conn>>();
  const conns = new Set<Conn>();

  const http = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server: http, maxPayload: opts.maxMessageBytes ?? 64 * 1024 });

  const send = (c: Conn, m: ServerMessage) => {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(m));
  };
  const fail = (c: Conn, code: string, message: string) => send(c, { t: 'error', code, message });

  const leave = (c: Conn, room: string) => {
    const role = c.rooms.get(room);
    if (!role) return;
    c.rooms.delete(room);
    const members = rooms.get(room);
    if (!members || members.get(role) !== c) return;
    members.delete(role);
    if (members.size === 0) rooms.delete(room);
    for (const other of members.values()) send(other, { t: 'peer-left', room, role });
  };

  const allow = (c: Conn) => {
    const now = Date.now();
    c.tokens = Math.min(rate.burst, c.tokens + ((now - c.lastRefill) / 1000) * rate.perSecond);
    c.lastRefill = now;
    if (c.tokens < 1) return false;
    c.tokens -= 1;
    return true;
  };

  wss.on('connection', (ws) => {
    const c: Conn = { id: randomUUID(), ws, rooms: new Map(), tokens: rate.burst, lastRefill: Date.now(), alive: true };
    conns.add(c);
    ws.on('pong', () => (c.alive = true));

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return fail(c, SignalingErrorCode.BadMessage, 'binary not supported');
      if (!allow(c)) return fail(c, SignalingErrorCode.RateLimited, 'slow down');
      let parsed: ClientMessage;
      try {
        const r = ClientMessage.safeParse(JSON.parse(raw.toString()));
        if (!r.success) return fail(c, SignalingErrorCode.BadMessage, r.error.issues[0]?.message ?? 'invalid');
        parsed = r.data;
      } catch {
        return fail(c, SignalingErrorCode.BadMessage, 'invalid json');
      }

      switch (parsed.t) {
        case 'join': {
          const { room, role } = parsed;
          let members = rooms.get(room);
          if (!members) rooms.set(room, (members = new Map()));
          const existing = members.get(role);
          // Same role reconnecting (e.g. after a network change) replaces its stale socket.
          if (existing && existing !== c) {
            existing.rooms.delete(room);
            fail(existing, SignalingErrorCode.RoomFull, `replaced in ${room}`);
          }
          members.set(role, c);
          c.rooms.set(room, role);
          const peers = [...members.keys()].filter((r) => r !== role);
          send(c, { t: 'joined', room, peers });
          for (const [r, other] of members) if (r !== role) send(other, { t: 'peer-joined', room, role });
          log(`join ${room.slice(0, 6)} ${role}`);
          break;
        }
        case 'leave':
          leave(c, parsed.room);
          break;
        case 'relay': {
          const role = c.rooms.get(parsed.room);
          if (!role) return fail(c, SignalingErrorCode.NotInRoom, 'join first');
          for (const [r, other] of rooms.get(parsed.room) ?? []) {
            if (r !== role) send(other, { t: 'relay', room: parsed.room, from: role, data: parsed.data });
          }
          break;
        }
        case 'turn':
          send(c, { t: 'turn-credentials', ...issueIceServers(opts.turn, c.id) });
          break;
        case 'ping':
          send(c, { t: 'pong', ts: parsed.ts });
          break;
      }
    });

    ws.on('close', () => {
      conns.delete(c);
      for (const room of [...c.rooms.keys()]) leave(c, room);
    });
  });

  const hb = setInterval(() => {
    for (const c of conns) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }, opts.heartbeatMs ?? 30_000);

  return new Promise((resolve) => {
    http.listen(opts.port, opts.host ?? '0.0.0.0', () => {
      resolve({
        http,
        port: () => {
          const a = http.address();
          return typeof a === 'object' && a ? a.port : opts.port;
        },
        close: () =>
          new Promise<void>((done) => {
            clearInterval(hb);
            for (const ws of wss.clients) ws.terminate();
            wss.close(() => http.close(() => done()));
          }),
      });
    });
  });
}
