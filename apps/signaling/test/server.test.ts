import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startSignalingServer, type SignalingServer } from '../src/server.js';
import { issueIceServers } from '../src/turnCredentials.js';
import { createHmac } from 'node:crypto';

const ROOM = 'a'.repeat(32);
let server: SignalingServer;

class Client {
  ws: WebSocket;
  inbox: any[] = [];
  waiters: ((m: any) => void)[] = [];
  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      const w = this.waiters.shift();
      w ? w(m) : this.inbox.push(m);
    });
  }
  open() {
    return new Promise<void>((r) => this.ws.once('open', () => r()));
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  next(): Promise<any> {
    const m = this.inbox.shift();
    if (m) return Promise.resolve(m);
    return new Promise((r) => this.waiters.push(r));
  }
}

async function client() {
  const c = new Client(server.port());
  await c.open();
  return c;
}

beforeEach(async () => {
  server = await startSignalingServer({
    port: 0,
    host: '127.0.0.1',
    turn: { secret: 's3cret', urls: ['turn:turn.test:3478'], stunUrls: ['stun:stun.test'], ttlSeconds: 600 },
    rate: { perSecond: 1, burst: 5 },
  });
});
afterEach(() => server.close());

describe('signaling', () => {
  it('joins, notifies and relays only to the other peer', async () => {
    const d = await client();
    d.send({ t: 'join', room: ROOM, role: 'desktop' });
    expect(await d.next()).toEqual({ t: 'joined', room: ROOM, peers: [] });

    const a = await client();
    a.send({ t: 'join', room: ROOM, role: 'android' });
    expect(await a.next()).toEqual({ t: 'joined', room: ROOM, peers: ['desktop'] });
    expect(await d.next()).toEqual({ t: 'peer-joined', room: ROOM, role: 'android' });

    a.send({ t: 'relay', room: ROOM, data: { k: 'pair.req', nonceA: 'x' } });
    expect(await d.next()).toEqual({ t: 'relay', room: ROOM, from: 'android', data: { k: 'pair.req', nonceA: 'x' } });

    a.ws.close();
    expect(await d.next()).toEqual({ t: 'peer-left', room: ROOM, role: 'android' });
  });

  it('rejects malformed messages and relays before join', async () => {
    const c = await client();
    c.send({ t: 'join', room: 'not-hex', role: 'desktop' });
    expect((await c.next()).code).toBe('bad_message');
    c.send({ t: 'relay', room: ROOM, data: 1 });
    expect((await c.next()).code).toBe('not_in_room');
  });

  it('a reconnecting peer replaces its stale socket', async () => {
    const old = await client();
    old.send({ t: 'join', room: ROOM, role: 'android' });
    await old.next();
    const fresh = await client();
    fresh.send({ t: 'join', room: ROOM, role: 'android' });
    expect((await old.next()).code).toBe('room_full');
    expect((await fresh.next()).t).toBe('joined');
  });

  it('rate limits floods', async () => {
    const c = await client();
    for (let i = 0; i < 8; i++) c.send({ t: 'ping', ts: i });
    const msgs = await Promise.all(Array.from({ length: 8 }, () => c.next()));
    expect(msgs.filter((m) => m.code === 'rate_limited').length).toBeGreaterThan(0);
  });

  it('issues ephemeral TURN credentials verifiable by coturn', async () => {
    const c = await client();
    c.send({ t: 'turn' });
    const m = await c.next();
    expect(m.t).toBe('turn-credentials');
    const turn = m.iceServers.find((s: any) => s.username);
    expect(turn.credential).toBe(createHmac('sha1', 's3cret').update(turn.username).digest('base64'));
    expect(Number(turn.username.split(':')[0])).toBeGreaterThan(Date.now() / 1000);
  });

  it('omits TURN when no secret is configured', () => {
    const r = issueIceServers({ urls: ['turn:x'], stunUrls: [], ttlSeconds: 60 }, 'id');
    expect(r.iceServers).toEqual([]);
  });
});
