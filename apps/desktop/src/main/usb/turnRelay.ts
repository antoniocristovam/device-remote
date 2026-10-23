import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Socket } from 'node:net';

/**
 * Minimal TURN relay (RFC 8656 subset) for sessions over the USB cable. It speaks TURN over TCP
 * only, because `adb reverse` forwards TCP only, and its relayed addresses are virtual: data is only
 * ever passed between allocations held by this same relay (the phone's and this computer's), so no
 * UDP socket is opened. Authentication is the TURN REST API scheme coturn uses (see
 * apps/signaling/src/turnCredentials.ts): username "<expiry>:<label>", password
 * base64(HMAC-SHA1(secret, username)).
 */

export const MAGIC = 0x2112a442;

export const Method = { Binding: 0x001, Allocate: 0x003, Refresh: 0x004, Send: 0x006, Data: 0x007, CreatePermission: 0x008, ChannelBind: 0x009 } as const;
export const Class = { Request: 0, Indication: 1, Success: 2, Error: 3 } as const;
export const Attr = {
  Username: 0x0006,
  MessageIntegrity: 0x0008,
  ErrorCode: 0x0009,
  ChannelNumber: 0x000c,
  Lifetime: 0x000d,
  XorPeerAddress: 0x0012,
  Data: 0x0013,
  Realm: 0x0014,
  Nonce: 0x0015,
  XorRelayedAddress: 0x0016,
  RequestedTransport: 0x0019,
  XorMappedAddress: 0x0020,
  Software: 0x8022,
  Fingerprint: 0x8028,
} as const;

/** Relayed addresses live in TEST-NET-1: never routable, plainly virtual. */
const RELAY_IP = '192.0.2.1';
const DEFAULT_LIFETIME = 600;
const MAX_LIFETIME = 3600;
const PERMISSION_MS = 300_000;

export interface StunMessage {
  method: number;
  cls: number;
  tid: Buffer;
  attrs: { type: number; value: Buffer; offset: number }[];
  raw: Buffer;
}

export interface Address {
  ip: string;
  port: number;
}

const msgType = (method: number, cls: number) => (method & 0xf) | ((method & 0x70) << 1) | ((method & 0xf80) << 2) | ((cls & 1) << 4) | ((cls & 2) << 7);

export function decodeStun(raw: Buffer): StunMessage | null {
  if (raw.length < 20 || raw.readUInt32BE(4) !== MAGIC) return null;
  const t = raw.readUInt16BE(0);
  const len = raw.readUInt16BE(2);
  if (raw.length < 20 + len) return null;
  const attrs: StunMessage['attrs'] = [];
  for (let o = 20; o + 4 <= 20 + len; ) {
    const type = raw.readUInt16BE(o);
    const l = raw.readUInt16BE(o + 2);
    if (o + 4 + l > 20 + len) return null;
    attrs.push({ type, value: raw.subarray(o + 4, o + 4 + l), offset: o });
    o += 4 + l + ((4 - (l % 4)) % 4);
  }
  return {
    method: (t & 0xf) | ((t >> 1) & 0x70) | ((t >> 2) & 0xf80),
    cls: ((t >> 4) & 1) | ((t >> 7) & 2),
    tid: raw.subarray(8, 20),
    attrs,
    raw: raw.subarray(0, 20 + len),
  };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(b: Buffer) {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Builds a STUN message; with `key`, appends MESSAGE-INTEGRITY. FINGERPRINT is always appended. */
export function encodeStun(method: number, cls: number, tid: Buffer, attrs: [number, Buffer][], key?: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (const [type, value] of attrs) {
    const h = Buffer.alloc(4);
    h.writeUInt16BE(type, 0);
    h.writeUInt16BE(value.length, 2);
    parts.push(h, value, Buffer.alloc((4 - (value.length % 4)) % 4));
  }
  let body = Buffer.concat(parts);
  const header = (extra: number) => {
    const h = Buffer.alloc(20);
    h.writeUInt16BE(msgType(method, cls), 0);
    h.writeUInt16BE(body.length + extra, 2);
    h.writeUInt32BE(MAGIC, 4);
    tid.copy(h, 8);
    return h;
  };
  if (key) {
    const mac = createHmac('sha1', key).update(Buffer.concat([header(24), body])).digest();
    const a = Buffer.alloc(4);
    a.writeUInt16BE(Attr.MessageIntegrity, 0);
    a.writeUInt16BE(20, 2);
    body = Buffer.concat([body, a, mac]);
  }
  const fp = Buffer.alloc(8);
  fp.writeUInt16BE(Attr.Fingerprint, 0);
  fp.writeUInt16BE(4, 2);
  fp.writeUInt32BE((crc32(Buffer.concat([header(8), body])) ^ 0x5354554e) >>> 0, 4);
  return Buffer.concat([header(8), body, fp]);
}

export function xorAddress(a: Address): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt8(0x01, 1);
  b.writeUInt16BE(a.port ^ (MAGIC >>> 16), 2);
  const ip = a.ip.split('.').reduce((n, x) => (n << 8) + Number(x), 0) >>> 0;
  b.writeUInt32BE((ip ^ MAGIC) >>> 0, 4);
  return b;
}

export function readXorAddress(b: Buffer): Address | null {
  if (b.length < 8 || b.readUInt8(1) !== 0x01) return null;
  const ip = (b.readUInt32BE(4) ^ MAGIC) >>> 0;
  return { ip: [ip >>> 24, (ip >>> 16) & 0xff, (ip >>> 8) & 0xff, ip & 0xff].join('.'), port: b.readUInt16BE(2) ^ (MAGIC >>> 16) };
}

/** Key for MESSAGE-INTEGRITY under the long-term credential mechanism. */
export const longTermKey = (username: string, realm: string, password: string) => createHash('md5').update(`${username}:${realm}:${password}`).digest();

/** Checks MESSAGE-INTEGRITY: HMAC over the message up to that attribute, length adjusted to end there. */
export function checkIntegrity(m: StunMessage, key: Buffer): boolean {
  const mi = m.attrs.find((a) => a.type === Attr.MessageIntegrity);
  if (!mi || mi.value.length !== 20) return false;
  const signed = Buffer.from(m.raw.subarray(0, mi.offset));
  signed.writeUInt16BE(mi.offset + 24 - 20, 2);
  const mac = createHmac('sha1', key).update(signed).digest();
  return timingSafeEqual(mac, mi.value);
}

const errorCode = (code: number, reason: string) => {
  const r = Buffer.from(reason, 'utf8');
  const b = Buffer.alloc(4 + r.length);
  b.writeUInt8(Math.floor(code / 100), 2);
  b.writeUInt8(code % 100, 3);
  r.copy(b, 4);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};

interface Allocation {
  conn: Conn;
  relayed: Address;
  expiresAt: number;
  /** Peer IP -> permission expiry. */
  permissions: Map<string, number>;
  channels: Map<number, Address>;
  peerChannels: Map<string, number>;
  tid: Buffer;
}

interface Conn {
  socket: Socket;
  buf: Buffer;
  nonce: string;
  key?: Buffer;
  username?: string;
  alloc?: Allocation;
}

export interface TurnRelayOptions {
  host: string;
  port: number;
  secret: string;
  realm: string;
}

export interface TurnRelay {
  port(): number;
  close(): Promise<void>;
}

const addrKey = (a: Address) => `${a.ip}:${a.port}`;

export function startTurnRelay(opts: TurnRelayOptions): Promise<TurnRelay> {
  const allocations = new Map<number, Allocation>();
  const conns = new Set<Conn>();
  let nextPort = 49152;
  const realm = Buffer.from(opts.realm);

  const passwordFor = (username: string) => createHmac('sha1', opts.secret).update(username).digest('base64');

  const free = (a: Allocation) => {
    allocations.delete(a.relayed.port);
    if (a.conn.alloc === a) a.conn.alloc = undefined;
  };

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const a of allocations.values()) if (a.expiresAt <= now) free(a);
  }, 30_000);

  /** Hands `data` from allocation `from` to whichever allocation owns `to`, if it lets `from` in. */
  const deliver = (from: Allocation, to: Address, data: Buffer) => {
    if (to.ip !== RELAY_IP) return;
    const dst = allocations.get(to.port);
    if (!dst || dst.expiresAt <= Date.now()) return;
    if ((dst.permissions.get(from.relayed.ip) ?? 0) <= Date.now()) return;
    const ch = dst.peerChannels.get(addrKey(from.relayed));
    if (ch != null) {
      const pad = (4 - (data.length % 4)) % 4;
      const h = Buffer.alloc(4);
      h.writeUInt16BE(ch, 0);
      h.writeUInt16BE(data.length, 2);
      dst.conn.socket.write(Buffer.concat([h, data, Buffer.alloc(pad)]));
    } else {
      dst.conn.socket.write(
        encodeStun(Method.Data, Class.Indication, randomBytes(12), [
          [Attr.XorPeerAddress, xorAddress(from.relayed)],
          [Attr.Data, data],
        ]),
      );
    }
  };

  const handleStun = (c: Conn, m: StunMessage) => {
    const attr = (t: number) => m.attrs.find((a) => a.type === t)?.value;
    const reply = (cls: number, attrs: [number, Buffer][], key = c.key) => c.socket.write(encodeStun(m.method, cls, m.tid, attrs, key));
    const fail = (code: number, reason: string, extra: [number, Buffer][] = [], key = c.key) => reply(Class.Error, [[Attr.ErrorCode, errorCode(code, reason)], ...extra], key);
    const mapped = (): Address => ({ ip: (c.socket.remoteAddress ?? '127.0.0.1').replace(/^::ffff:/, ''), port: c.socket.remotePort ?? 0 });

    if (m.cls === Class.Indication) {
      if (m.method !== Method.Send || !c.alloc) return;
      const peer = attr(Attr.XorPeerAddress);
      const data = attr(Attr.Data);
      const to = peer && readXorAddress(peer);
      if (to && data && (c.alloc.permissions.get(to.ip) ?? 0) > Date.now()) deliver(c.alloc, to, data);
      return;
    }
    if (m.cls !== Class.Request) return;

    if (m.method === Method.Binding) return reply(Class.Success, [[Attr.XorMappedAddress, xorAddress(mapped())]], undefined);

    // Long-term credentials: everything else must be signed by a valid, unexpired REST username.
    const challenge = (code: number, reason: string) =>
      fail(code, reason, [
        [Attr.Realm, realm],
        [Attr.Nonce, Buffer.from(c.nonce)],
      ], undefined);
    const username = attr(Attr.Username)?.toString('utf8');
    if (!username || !attr(Attr.MessageIntegrity)) return challenge(401, 'Unauthorized');
    if (attr(Attr.Nonce)?.toString('utf8') !== c.nonce) return challenge(438, 'Stale Nonce');
    const expiry = Number(username.split(':')[0]);
    if (!Number.isFinite(expiry) || expiry * 1000 < Date.now()) return challenge(401, 'Unauthorized');
    const key = longTermKey(username, opts.realm, passwordFor(username));
    if (!checkIntegrity(m, key)) return challenge(401, 'Unauthorized');
    if (c.username && c.username !== username) return fail(441, 'Wrong Credentials', [], key);
    c.username = username;
    c.key = key;

    const lifetimeOf = () => {
      const l = attr(Attr.Lifetime);
      return l ? Math.min(MAX_LIFETIME, l.readUInt32BE(0)) : DEFAULT_LIFETIME;
    };

    switch (m.method) {
      case Method.Allocate: {
        if (c.alloc) {
          if (c.alloc.tid.equals(m.tid)) {
            return reply(Class.Success, [
              [Attr.XorRelayedAddress, xorAddress(c.alloc.relayed)],
              [Attr.Lifetime, u32(Math.round((c.alloc.expiresAt - Date.now()) / 1000))],
              [Attr.XorMappedAddress, xorAddress(mapped())],
            ]);
          }
          return fail(437, 'Allocation Mismatch');
        }
        const rt = attr(Attr.RequestedTransport);
        if (!rt) return fail(400, 'Bad Request');
        if (rt.readUInt8(0) !== 17) return fail(442, 'Unsupported Transport Protocol');
        while (allocations.has(nextPort)) nextPort = nextPort >= 65535 ? 49152 : nextPort + 1;
        const lifetime = Math.max(DEFAULT_LIFETIME, lifetimeOf());
        const a: Allocation = {
          conn: c,
          relayed: { ip: RELAY_IP, port: nextPort },
          expiresAt: Date.now() + lifetime * 1000,
          permissions: new Map(),
          channels: new Map(),
          peerChannels: new Map(),
          tid: Buffer.from(m.tid),
        };
        nextPort = nextPort >= 65535 ? 49152 : nextPort + 1;
        allocations.set(a.relayed.port, a);
        c.alloc = a;
        return reply(Class.Success, [
          [Attr.XorRelayedAddress, xorAddress(a.relayed)],
          [Attr.Lifetime, u32(lifetime)],
          [Attr.XorMappedAddress, xorAddress(mapped())],
        ]);
      }
      case Method.Refresh: {
        if (!c.alloc) return fail(437, 'Allocation Mismatch');
        const lifetime = lifetimeOf();
        if (lifetime === 0) {
          free(c.alloc);
          return reply(Class.Success, [[Attr.Lifetime, u32(0)]]);
        }
        c.alloc.expiresAt = Date.now() + lifetime * 1000;
        return reply(Class.Success, [[Attr.Lifetime, u32(lifetime)]]);
      }
      case Method.CreatePermission: {
        if (!c.alloc) return fail(437, 'Allocation Mismatch');
        const peers = m.attrs.filter((a) => a.type === Attr.XorPeerAddress).map((a) => readXorAddress(a.value));
        if (!peers.length || peers.some((p) => !p)) return fail(400, 'Bad Request');
        for (const p of peers) c.alloc.permissions.set(p!.ip, Date.now() + PERMISSION_MS);
        return reply(Class.Success, []);
      }
      case Method.ChannelBind: {
        if (!c.alloc) return fail(437, 'Allocation Mismatch');
        const chAttr = attr(Attr.ChannelNumber);
        const peerAttr = attr(Attr.XorPeerAddress);
        const peer = peerAttr && readXorAddress(peerAttr);
        if (!chAttr || !peer) return fail(400, 'Bad Request');
        const ch = chAttr.readUInt16BE(0);
        if (ch < 0x4000 || ch > 0x7ffe) return fail(400, 'Bad Request');
        const bound = c.alloc.channels.get(ch);
        const existing = c.alloc.peerChannels.get(addrKey(peer));
        if ((bound && addrKey(bound) !== addrKey(peer)) || (existing != null && existing !== ch)) return fail(400, 'Bad Request');
        c.alloc.channels.set(ch, peer);
        c.alloc.peerChannels.set(addrKey(peer), ch);
        c.alloc.permissions.set(peer.ip, Date.now() + PERMISSION_MS);
        return reply(Class.Success, []);
      }
      default:
        return fail(400, 'Bad Request');
    }
  };

  /** TCP carries back-to-back STUN messages and ChannelData frames (padded to 4 bytes). */
  const onData = (c: Conn, chunk: Buffer) => {
    c.buf = c.buf.length ? Buffer.concat([c.buf, chunk]) : chunk;
    for (;;) {
      if (c.buf.length < 4) return;
      const first = c.buf.readUInt8(0);
      if (first >= 0x40 && first <= 0x7f) {
        const len = c.buf.readUInt16BE(2);
        const total = 4 + len + ((4 - (len % 4)) % 4);
        if (c.buf.length < total) return;
        const ch = c.buf.readUInt16BE(0);
        const data = Buffer.from(c.buf.subarray(4, 4 + len));
        c.buf = c.buf.subarray(total);
        const peer = c.alloc?.channels.get(ch);
        if (c.alloc && peer) deliver(c.alloc, peer, data);
      } else if (first < 0x40) {
        const total = 20 + c.buf.readUInt16BE(2);
        if (c.buf.length < total) return;
        const raw = Buffer.from(c.buf.subarray(0, total));
        c.buf = c.buf.subarray(total);
        const m = decodeStun(raw);
        if (m) handleStun(c, m);
      } else {
        c.socket.destroy();
        return;
      }
    }
  };

  const server = createServer((socket) => {
    socket.setNoDelay(true);
    const c: Conn = { socket, buf: Buffer.alloc(0), nonce: randomBytes(12).toString('hex') };
    conns.add(c);
    socket.on('data', (d) => onData(c, d));
    socket.on('error', () => {
      /* close follows */
    });
    socket.on('close', () => {
      conns.delete(c);
      if (c.alloc) free(c.alloc);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      resolve({
        port: () => {
          const a = server.address();
          return typeof a === 'object' && a ? a.port : opts.port;
        },
        close: () =>
          new Promise<void>((done) => {
            clearInterval(sweep);
            for (const c of conns) c.socket.destroy();
            allocations.clear();
            server.close(() => done());
          }),
      });
    });
  });
}
