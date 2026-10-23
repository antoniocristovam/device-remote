import { createHmac, randomBytes } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Attr,
  checkIntegrity,
  Class,
  decodeStun,
  encodeStun,
  longTermKey,
  Method,
  readXorAddress,
  startTurnRelay,
  xorAddress,
  type Address,
  type StunMessage,
  type TurnRelay,
} from '../src/main/usb/turnRelay';

const SECRET = 'test-secret';
const REALM = 'test-realm';

function credentials(expiresInS = 600) {
  const username = `${Math.floor(Date.now() / 1000) + expiresInS}:t`;
  return { username, password: createHmac('sha1', SECRET).update(username).digest('base64') };
}

const transport = () => Buffer.from([17, 0, 0, 0]);
const channel = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt16BE(n, 0);
  return b;
};

/** A raw TURN-over-TCP client: frames STUN and ChannelData exactly like libwebrtc does. */
class Client {
  private buf = Buffer.alloc(0);
  private waiters: ((f: { stun?: StunMessage; channel?: { ch: number; data: Buffer } }) => void)[] = [];
  private queue: { stun?: StunMessage; channel?: { ch: number; data: Buffer } }[] = [];
  key?: Buffer;
  nonce?: Buffer;
  relayed?: Address;

  private constructor(private readonly s: Socket, private readonly cred = credentials()) {
    s.on('data', (d) => this.onData(d));
  }

  static open(port: number, cred = credentials()) {
    return new Promise<Client>((resolve) => {
      const s = connect(port, '127.0.0.1', () => resolve(new Client(s, cred)));
    });
  }

  private onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 4) return;
      let frame: (typeof this.queue)[number];
      if (this.buf[0]! >= 0x40) {
        const len = this.buf.readUInt16BE(2);
        const total = 4 + len + ((4 - (len % 4)) % 4);
        if (this.buf.length < total) return;
        frame = { channel: { ch: this.buf.readUInt16BE(0), data: Buffer.from(this.buf.subarray(4, 4 + len)) } };
        this.buf = this.buf.subarray(total);
      } else {
        const total = 20 + this.buf.readUInt16BE(2);
        if (this.buf.length < total) return;
        frame = { stun: decodeStun(Buffer.from(this.buf.subarray(0, total)))! };
        this.buf = this.buf.subarray(total);
      }
      const w = this.waiters.shift();
      if (w) w(frame);
      else this.queue.push(frame);
    }
  }

  next() {
    const f = this.queue.shift();
    if (f) return Promise.resolve(f);
    return new Promise<(typeof this.queue)[number]>((r) => this.waiters.push(r));
  }

  async request(method: number, attrs: [number, Buffer][], signed = true) {
    const all: [number, Buffer][] = signed && this.nonce
      ? [...attrs, [Attr.Username, Buffer.from(this.cred.username)], [Attr.Realm, Buffer.from(REALM)], [Attr.Nonce, this.nonce]]
      : attrs;
    this.s.write(encodeStun(method, Class.Request, randomBytes(12), all, signed && this.nonce ? this.key : undefined));
    return (await this.next()).stun!;
  }

  async allocate() {
    const challenge = await this.request(Method.Allocate, [[Attr.RequestedTransport, transport()]], false);
    expect(challenge.cls).toBe(Class.Error);
    this.nonce = challenge.attrs.find((a) => a.type === Attr.Nonce)!.value;
    this.key = longTermKey(this.cred.username, REALM, this.cred.password);
    const ok = await this.request(Method.Allocate, [[Attr.RequestedTransport, transport()]]);
    if (ok.cls === Class.Success) this.relayed = readXorAddress(ok.attrs.find((a) => a.type === Attr.XorRelayedAddress)!.value)!;
    return ok;
  }

  send(peer: Address, data: Buffer) {
    this.s.write(encodeStun(Method.Send, Class.Indication, randomBytes(12), [[Attr.XorPeerAddress, xorAddress(peer)], [Attr.Data, data]]));
  }

  sendChannel(ch: number, data: Buffer) {
    const h = Buffer.alloc(4);
    h.writeUInt16BE(ch, 0);
    h.writeUInt16BE(data.length, 2);
    this.s.write(Buffer.concat([h, data, Buffer.alloc((4 - (data.length % 4)) % 4)]));
  }

  close() {
    this.s.destroy();
  }
}

const errorOf = (m: StunMessage) => {
  const e = m.attrs.find((a) => a.type === Attr.ErrorCode)?.value;
  return e ? e.readUInt8(2) * 100 + e.readUInt8(3) : undefined;
};

describe('turnRelay', () => {
  let relay: TurnRelay;
  const clients: Client[] = [];
  const open = async (cred?: ReturnType<typeof credentials>) => {
    const c = await Client.open(relay.port(), cred);
    clients.push(c);
    return c;
  };

  beforeEach(async () => {
    relay = await startTurnRelay({ host: '127.0.0.1', port: 0, secret: SECRET, realm: REALM });
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await relay.close();
  });

  it('challenges, then allocates with a signed response', async () => {
    const c = await open();
    const ok = await c.allocate();
    expect(ok.cls).toBe(Class.Success);
    expect(checkIntegrity(ok, c.key!)).toBe(true);
    expect(c.relayed?.ip).toBe('192.0.2.1');
  });

  it('rejects a wrong password and an expired username', async () => {
    const wrong = await open({ ...credentials(), password: 'nope' });
    expect(errorOf(await wrong.allocate())).toBe(401);
    const expired = await open(credentials(-10));
    expect(errorOf(await expired.allocate())).toBe(401);
  });

  it('relays Send/Data between allocations, only with a permission', async () => {
    const a = await open();
    const b = await open();
    await a.allocate();
    await b.allocate();

    // b has no permission for a yet: dropped.
    expect((await a.request(Method.CreatePermission, [[Attr.XorPeerAddress, xorAddress(b.relayed!)]])).cls).toBe(Class.Success);
    a.send(b.relayed!, Buffer.from('dropped'));
    expect((await b.request(Method.CreatePermission, [[Attr.XorPeerAddress, xorAddress(a.relayed!)]])).cls).toBe(Class.Success);

    a.send(b.relayed!, Buffer.from('hello'));
    const got = (await b.next()).stun!;
    expect(got.method).toBe(Method.Data);
    expect(got.attrs.find((x) => x.type === Attr.Data)!.value.toString()).toBe('hello');
    expect(readXorAddress(got.attrs.find((x) => x.type === Attr.XorPeerAddress)!.value)).toEqual(a.relayed);
  });

  it('relays ChannelData once both sides bound channels', async () => {
    const a = await open();
    const b = await open();
    await a.allocate();
    await b.allocate();
    expect((await a.request(Method.ChannelBind, [[Attr.ChannelNumber, channel(0x4001)], [Attr.XorPeerAddress, xorAddress(b.relayed!)]])).cls).toBe(Class.Success);
    expect((await b.request(Method.ChannelBind, [[Attr.ChannelNumber, channel(0x4002)], [Attr.XorPeerAddress, xorAddress(a.relayed!)]])).cls).toBe(Class.Success);

    const payload = randomBytes(1001); // not a multiple of 4: exercises padding
    a.sendChannel(0x4001, payload);
    const got = (await b.next()).channel!;
    expect(got.ch).toBe(0x4002);
    expect(got.data.equals(payload)).toBe(true);

    b.sendChannel(0x4002, Buffer.from('back'));
    expect((await a.next()).channel!.data.toString()).toBe('back');
  });

  it('answers plain Binding requests', async () => {
    const c = await open();
    const r = await c.request(Method.Binding, [], false);
    expect(r.cls).toBe(Class.Success);
    expect(readXorAddress(r.attrs.find((x) => x.type === Attr.XorMappedAddress)!.value)?.ip).toBe('127.0.0.1');
  });
});
