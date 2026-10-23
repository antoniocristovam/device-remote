import { E2EMessage, type IceServer, type ServerMessage } from '@rc/protocol';
import {
  buildSessionRequest,
  buildSessionResume,
  signSdp,
  verifySdp,
  verifySessionAccept,
  type SessionToken,
} from '@rc/crypto-proto';
import type { Identity } from './identity.js';
import type { SignalingClient } from './signalingClient.js';
import type { StoredPeer, Stores } from './store.js';

/** How a session reaches the phone: the signaling server on the network, or the local one over the USB cable (adb). */
export type Transport = 'network' | 'usb';

type SessionEventBody =
  | { state: 'waiting-peer' }
  | { state: 'requested' }
  | { state: 'accepted'; sid: string; iceServers: IceServer[]; expiresAt: number; transport: Transport }
  | { state: 'offer'; sdp: string }
  | { state: 'ice'; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
  | { state: 'reconnecting'; since: number; deadline: number }
  | { state: 'reconnected'; reconnects: number }
  | { state: 'denied'; reason: string }
  | { state: 'ended'; reason: string };

/** Every event names the paired device it belongs to: several sessions can run at once. */
export type SessionEvent = SessionEventBody & { peer: string };

export interface Links {
  network: SignalingClient;
  /** Local signaling reached by the phone through `adb reverse`; absent when USB is unavailable. */
  usb?: { sig: SignalingClient; turnUrl: () => string | undefined };
}

const REQUEST_TIMEOUT_MS = 90_000;
/** How long a dropped link may stay down before the session is given up (matches the phone). */
export const RECONNECT_TIMEOUT_MS = 90_000;
/** If the link is still down this long after dropping, nudge the phone with a signed resume. */
const RESUME_NUDGE_MS = 3_000;
/** The phone showed up on the network first: give the cable this long to win. */
const USB_GRACE_MS = 400;

/**
 * Desktop side of one remote session with one paired phone. Owns the identity key: SDPs from the
 * phone are verified here against the pinned key before the renderer ever applies them, and the
 * renderer's answer is signed here before it leaves the machine.
 */
export class SessionController {
  private pendingNonce?: string;
  private token?: SessionToken;
  /** Transport chosen when the request went out; fixed for the rest of the session. */
  private via?: Transport;
  private present: Record<Transport, boolean> = { network: false, usb: false };
  private requestTimer?: NodeJS.Timeout;
  private graceTimer?: NodeJS.Timeout;
  private downSince?: number;
  private everConnected = false;
  private reconnects = 0;
  private lostTimer?: NodeJS.Timeout;
  private nudgeTimer?: NodeJS.Timeout;
  private done = false;

  constructor(
    readonly peer: StoredPeer,
    private readonly id: Identity,
    private readonly links: Links,
    private readonly stores: Stores,
    private readonly emitRaw: (e: SessionEvent) => void,
    private readonly onFinished: () => void,
  ) {}

  get room() {
    return this.peer.channelId;
  }

  get active() {
    return this.token ? { sid: this.token.sid, peer: this.peer.fingerprint, transport: this.via } : undefined;
  }

  private emit(e: SessionEventBody) {
    this.emitRaw({ ...e, peer: this.peer.fingerprint } as SessionEvent);
  }

  private sigFor(t: Transport) {
    return t === 'usb' ? this.links.usb?.sig : this.links.network;
  }

  private get sig() {
    return this.via ? this.sigFor(this.via) : undefined;
  }

  start() {
    this.links.network.join(this.room, 'desktop');
    this.links.usb?.sig.join(this.room, 'desktop');
    this.emit({ state: 'waiting-peer' });
  }

  async sendAnswer(sdp: string) {
    if (!this.token || !this.sig) return;
    this.sig.relay(this.room, await signSdp(this.token.sid, 'desktop', 'answer', sdp, this.id.signer));
  }

  sendIce(c: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }) {
    if (!this.token || !this.sig) return;
    this.sig.relay(this.room, { k: 'ice', sid: this.token.sid, ...c });
  }

  /**
   * Peer-connection state reported by the renderer. The phone (offerer) restarts ICE by itself;
   * the desktop adds a signed resume as a nudge and gives up after RECONNECT_TIMEOUT_MS.
   */
  reportConnection(state: string) {
    if (!this.token) return;
    if (state === 'connected') {
      if (this.downSince != null && this.everConnected) {
        this.reconnects++;
        this.emit({ state: 'reconnected', reconnects: this.reconnects });
      }
      this.everConnected = true;
      this.downSince = undefined;
      clearTimeout(this.lostTimer);
      clearTimeout(this.nudgeTimer);
      return;
    }
    if ((state === 'disconnected' || state === 'failed') && this.everConnected) this.linkDown();
  }

  private linkDown() {
    if (this.downSince == null) {
      this.downSince = Date.now();
      clearTimeout(this.lostTimer);
      this.lostTimer = setTimeout(() => this.end('lost'), RECONNECT_TIMEOUT_MS);
    }
    this.emit({ state: 'reconnecting', since: this.downSince, deadline: this.downSince + RECONNECT_TIMEOUT_MS });
    clearTimeout(this.nudgeTimer);
    this.nudgeTimer = setTimeout(() => void this.nudge(), RESUME_NUDGE_MS);
  }

  private async nudge() {
    const sig = this.sig;
    if (!sig || !this.token || this.downSince == null) return;
    if (sig.status === 'online') {
      sig.relay(this.room, await buildSessionResume(this.room, this.token.sid, this.id.signer));
    }
    this.nudgeTimer = setTimeout(() => void this.nudge(), 6_000);
  }

  end(reason: 'user' | 'error' | 'expired' | 'lost' = 'user') {
    if (this.done) return;
    if (this.token) this.sig?.relay(this.room, { k: 'sess.end', sid: this.token.sid, reason });
    this.finish(reason);
  }

  private finish(reason: string) {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.requestTimer);
    clearTimeout(this.graceTimer);
    clearTimeout(this.lostTimer);
    clearTimeout(this.nudgeTimer);
    if (this.token) this.stores.sessions.end(this.token.sid, reason, this.reconnects);
    this.links.network.leave(this.room);
    this.links.usb?.sig.leave(this.room);
    this.emit({ state: 'ended', reason });
    this.onFinished();
  }

  /** The phone is reachable on some transport: ask it, preferring the cable. */
  private maybeRequest(from: Transport) {
    if (this.token) return;
    // Phone re-joined while a request was pending (e.g. its app restarted): ask again on the same link.
    if (this.pendingNonce) {
      if (from === this.via && this.present[from]) void this.request(from);
      return;
    }
    if (this.present.usb) {
      clearTimeout(this.graceTimer);
      void this.request('usb');
    } else if (this.present.network && !this.graceTimer) {
      const wait = this.links.usb?.sig.status === 'online' ? USB_GRACE_MS : 0;
      this.graceTimer = setTimeout(() => {
        this.graceTimer = undefined;
        if (!this.pendingNonce && !this.token && !this.done) void this.request(this.present.usb ? 'usb' : 'network');
      }, wait);
    }
  }

  private async request(via: Transport) {
    const sig = this.sigFor(via);
    if (!sig) return;
    this.via = via;
    const req = await buildSessionRequest(this.room, this.id.signer);
    if (this.done) return;
    this.pendingNonce = req.nonceD;
    sig.relay(this.room, req);
    this.emit({ state: 'requested' });
    clearTimeout(this.requestTimer);
    this.requestTimer = setTimeout(() => {
      if (!this.token) this.finish('timeout');
    }, REQUEST_TIMEOUT_MS);
  }

  /** Phone came back on the session's signaling. Only an active outage needs a resume (no new consent asked). */
  private async resume() {
    const sig = this.sig;
    if (!sig || !this.token || this.downSince == null) return;
    sig.relay(this.room, await buildSessionResume(this.room, this.token.sid, this.id.signer));
  }

  private async iceServers(): Promise<IceServer[]> {
    const sig = this.sig!;
    const servers = await sig.iceServers();
    if (this.via !== 'usb') return servers;
    // The phone reaches the relay through its adb-reversed port; this side uses the real local one.
    const url = this.links.usb?.turnUrl();
    return servers.filter((s) => s.username).map((s) => (url ? { ...s, urls: url } : s));
  }

  async onMessage(m: ServerMessage, from: Transport) {
    if (this.done) return;
    switch (m.t) {
      case 'joined':
        this.present[from] = m.peers.includes('android');
        if (this.token && from === this.via && this.present[from]) return this.resume();
        return this.maybeRequest(from);
      case 'peer-joined':
        if (m.role !== 'android') return;
        this.present[from] = true;
        if (this.token && from === this.via) return this.resume();
        return this.maybeRequest(from);
      case 'peer-left':
        // Signaling dropping does not mean the P2P link did: the renderer reports real link state.
        if (m.role === 'android') this.present[from] = false;
        return;
      case 'relay':
        break;
      default:
        return;
    }
    if (m.from !== 'android' || from !== this.via) return;
    const parsed = E2EMessage.safeParse(m.data);
    if (!parsed.success) return;
    const msg = parsed.data;
    const peer = this.peer;

    switch (msg.k) {
      case 'sess.accept': {
        if (!this.pendingNonce || this.token) return;
        const ok = await verifySessionAccept(
          peer.channelId,
          this.pendingNonce,
          peer.publicKey,
          { desktopFp: this.id.fingerprint, androidFp: peer.fingerprint },
          msg,
        );
        if (!ok) return this.finish('verification-failed');
        clearTimeout(this.requestTimer);
        this.token = msg.token;
        this.pendingNonce = undefined;
        this.stores.peers.touch(peer.fingerprint);
        this.stores.sessions.start({ sid: msg.token.sid, peerFingerprint: peer.fingerprint, peerName: peer.name, startedAt: Date.now() });
        // The session is pinned to one transport: stop listening on the other.
        if (this.via === 'usb') this.links.network.leave(this.room);
        else this.links.usb?.sig.leave(this.room);
        const iceServers = await this.iceServers();
        this.emit({ state: 'accepted', sid: msg.token.sid, iceServers, expiresAt: msg.token.exp, transport: this.via! });
        return;
      }
      case 'sess.deny':
        this.emit({ state: 'denied', reason: msg.reason });
        this.finish('denied');
        return;
      case 'sdp':
        if (!this.token || msg.sid !== this.token.sid || msg.type !== 'offer') return;
        if (!(await verifySdp(peer.publicKey, 'android', msg))) {
          console.warn('[session] rejected SDP offer with an invalid identity signature');
          return this.end('error');
        }
        this.emit({ state: 'offer', sdp: msg.sdp });
        return;
      case 'ice':
        if (!this.token || msg.sid !== this.token.sid) return;
        this.emit({ state: 'ice', candidate: msg.candidate, sdpMid: msg.sdpMid, sdpMLineIndex: msg.sdpMLineIndex });
        return;
      case 'sess.end':
        if (this.token && msg.sid === this.token.sid) this.finish(msg.reason);
        return;
    }
  }
}

/** One SessionController per paired phone with a pending or live session. */
export class SessionManager {
  private sessions = new Map<string, SessionController>();

  constructor(
    private readonly id: Identity,
    private readonly links: Links,
    private readonly stores: Stores,
    private readonly emit: (e: SessionEvent) => void,
  ) {
    const route = (from: Transport) => (m: ServerMessage) => {
      if (!('room' in m)) return;
      for (const s of this.sessions.values()) if (s.room === m.room) void s.onMessage(m, from);
    };
    links.network.on('message', route('network'));
    links.usb?.sig.on('message', route('usb'));
  }

  get(fingerprint: string) {
    return this.sessions.get(fingerprint);
  }

  connect(fingerprint: string) {
    if (this.sessions.has(fingerprint)) return;
    const peer = this.stores.peers.get(fingerprint);
    if (!peer) throw new Error('unknown device');
    const s = new SessionController(peer, this.id, this.links, this.stores, this.emit, () => {
      if (this.sessions.get(fingerprint) === s) this.sessions.delete(fingerprint);
    });
    this.sessions.set(fingerprint, s);
    s.start();
  }

  end(fingerprint: string, reason: 'user' | 'error' | 'expired' | 'lost' = 'user') {
    this.sessions.get(fingerprint)?.end(reason);
  }

  endAll(reason: 'user' = 'user') {
    for (const s of [...this.sessions.values()]) s.end(reason);
  }
}
