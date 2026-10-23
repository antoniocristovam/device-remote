import { networkInterfaces } from 'node:os';
import { E2EMessage, type ServerMessage } from '@rc/protocol';
import {
  PAIRING_TTL_MS,
  buildPairOffer,
  encodeQr,
  formatPairingCode,
  generatePairingCode,
  pairingRoom,
  pairingSas,
  verifyPairAccept,
} from '@rc/crypto-proto';
import type { Identity } from './identity.js';
import type { SignalingClient } from './signalingClient.js';
import type { StoredPeer, Stores } from './store.js';

export type PairingEvent =
  | { state: 'waiting'; code: string; qr: string; expiresAt: number }
  | { state: 'confirm'; sas: string }
  | { state: 'paired'; peer: StoredPeer }
  | { state: 'failed'; reason: string }
  | { state: 'expired' };

const VIRTUAL_ADAPTER = /tailscale|zerotier|vethernet|wsl|docker|virtualbox|vmware|hyper-v|vpn|tap|tun|utun|loopback/i;

/**
 * The address a phone on the same Wi-Fi can most likely reach: a private LAN address on a physical
 * adapter. Link-local (169.254.x, e.g. Tailscale or an unconfigured adapter) never qualifies, and
 * VPN/VM adapters only as a last resort.
 */
export function pickLanAddress(ifaces: NodeJS.Dict<{ address: string; family: string | number; internal: boolean }[]>): string | undefined {
  const score = (name: string, ip: string) => {
    if (ip.startsWith('169.254.')) return -1;
    let s = ip.startsWith('192.168.') ? 30 : ip.startsWith('10.') ? 20 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 10 : 5;
    if (!VIRTUAL_ADAPTER.test(name)) s += 100;
    return s;
  };
  let best: { ip: string; s: number } | undefined;
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list ?? []) {
      if (i.internal || (i.family !== 'IPv4' && i.family !== 4)) continue;
      const s = score(name, i.address);
      if (s >= 0 && (!best || s > best.s)) best = { ip: i.address, s };
    }
  }
  return best?.ip;
}

/** The phone must reach the signaling server too: never advertise "localhost" in the QR. */
export function advertisedUrl(url: string): string {
  try {
    const u = new URL(url);
    if (!['localhost', '127.0.0.1', '::1'].includes(u.hostname)) return url;
    const lan = pickLanAddress(networkInterfaces());
    if (lan) u.hostname = lan;
    return u.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

export class PairingController {
  private current?: {
    code: string;
    room: string;
    timer: NodeJS.Timeout;
    offer?: Awaited<ReturnType<typeof buildPairOffer>>;
  };

  constructor(
    private readonly id: Identity,
    private readonly sig: SignalingClient,
    private readonly stores: Stores,
    private readonly emit: (e: PairingEvent) => void,
  ) {
    sig.on('message', (m) => void this.onMessage(m));
  }

  async start(): Promise<void> {
    this.cancel();
    const code = generatePairingCode();
    const room = await pairingRoom(code);
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    const timer = setTimeout(() => {
      this.cancel();
      this.emit({ state: 'expired' });
    }, PAIRING_TTL_MS);
    this.current = { code, room, timer };
    this.sig.join(room, 'desktop');
    const qr = encodeQr({ s: advertisedUrl(this.stores.settings.get().signalingUrl), c: code, f: this.id.fingerprint, n: this.name() });
    this.emit({ state: 'waiting', code: formatPairingCode(code), qr, expiresAt });
  }

  cancel() {
    if (!this.current) return;
    clearTimeout(this.current.timer);
    this.sig.leave(this.current.room);
    this.current = undefined;
  }

  private name() {
    return this.stores.settings.get().deviceName || this.id.name;
  }

  private async onMessage(m: ServerMessage) {
    const cur = this.current;
    if (!cur || m.t !== 'relay' || m.room !== cur.room || m.from !== 'android') return;
    const parsed = E2EMessage.safeParse(m.data);
    if (!parsed.success) return;
    const msg = parsed.data;

    switch (msg.k) {
      case 'pair.req': {
        // One phone per code: ignore further requests once an offer is out.
        if (cur.offer) return;
        cur.offer = await buildPairOffer(cur.code, msg.nonceA, this.id.signer, this.name());
        this.sig.relay(cur.room, cur.offer.msg);
        this.emit({ state: 'confirm', sas: await pairingSas(cur.offer.fields) });
        break;
      }
      case 'pair.accept': {
        if (!cur.offer) return;
        const result = await verifyPairAccept(cur.code, cur.offer.fields, msg, this.id.signer);
        if (!result) {
          this.sig.relay(cur.room, { k: 'pair.reject', reason: 'verification failed' });
          this.cancel();
          this.emit({ state: 'failed', reason: 'Falha na verificação criptográfica do celular.' });
          return;
        }
        const peer: StoredPeer = { ...result.peer, pairedAt: Date.now() };
        this.stores.peers.upsert(peer);
        this.sig.relay(cur.room, result.done);
        this.cancel();
        this.emit({ state: 'paired', peer });
        break;
      }
      case 'pair.reject':
        this.cancel();
        this.emit({ state: 'failed', reason: 'O pareamento foi recusado no celular.' });
        break;
    }
  }
}
