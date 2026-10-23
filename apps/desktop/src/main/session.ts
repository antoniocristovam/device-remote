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

export type SessionEvent =
  | { state: 'waiting-peer'; peer: string }
  | { state: 'requested'; peer: string }
  | { state: 'accepted'; peer: string; sid: string; iceServers: IceServer[]; expiresAt: number }
  | { state: 'offer'; sdp: string }
  | { state: 'ice'; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
  | { state: 'reconnecting'; since: number; deadline: number }
  | { state: 'reconnected'; reconnects: number }
  | { state: 'denied'; reason: string }
  | { state: 'ended'; reason: string };

const REQUEST_TIMEOUT_MS = 90_000;
/** How long a dropped link may stay down before the session is given up (matches the phone). */
export const RECONNECT_TIMEOUT_MS = 90_000;
/** If the link is still down this long after dropping, nudge the phone with a signed resume. */
const RESUME_NUDGE_MS = 3_000;

/**
 * Desktop side of a remote session. Owns the identity key: SDPs from the phone are verified here
 * against the pinned key before the renderer ever applies them, and the renderer's answer is
 * signed here before it leaves the machine.
 */
export class SessionController {
  private peer?: StoredPeer;
  private pendingNonce?: string;
  private token?: SessionToken;
  private requestTimer?: NodeJS.Timeout;
  private downSince?: number;
  private everConnected = false;
  private reconnects = 0;
  private lostTimer?: NodeJS.Timeout;
  private nudgeTimer?: NodeJS.Timeout;

  constructor(
    private readonly id: Identity,
    private readonly sig: SignalingClient,
    private readonly stores: Stores,
    private readonly emit: (e: SessionEvent) => void,
  ) {
    sig.on('message', (m) => void this.onMessage(m));
  }

  get active() {
    return this.token ? { sid: this.token.sid, peer: this.peer?.fingerprint } : undefined;
  }

  connect(fingerprint: string) {
    const peer = this.stores.peers.get(fingerprint);
    if (!peer) throw new Error('unknown device');
    if (this.peer && this.peer.fingerprint !== fingerprint) this.end('user');
    this.peer = peer;
    this.sig.join(peer.channelId, 'desktop');
    this.emit({ state: 'waiting-peer', peer: peer.fingerprint });
  }

  async sendAnswer(sdp: string) {
    if (!this.peer || !this.token) return;
    this.sig.relay(this.peer.channelId, await signSdp(this.token.sid, 'desktop', 'answer', sdp, this.id.signer));
  }

  sendIce(c: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }) {
    if (!this.peer || !this.token) return;
    this.sig.relay(this.peer.channelId, { k: 'ice', sid: this.token.sid, ...c });
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
    if (!this.peer || !this.token || this.downSince == null) return;
    if (this.sig.status === 'online') {
      this.sig.relay(this.peer.channelId, await buildSessionResume(this.peer.channelId, this.token.sid, this.id.signer));
    }
    this.nudgeTimer = setTimeout(() => void this.nudge(), 6_000);
  }

  end(reason: 'user' | 'error' | 'expired' | 'lost' = 'user') {
    if (!this.peer) return;
    if (this.token) this.sig.relay(this.peer.channelId, { k: 'sess.end', sid: this.token.sid, reason });
    this.finish(reason);
  }

  private finish(reason: string) {
    clearTimeout(this.requestTimer);
    clearTimeout(this.lostTimer);
    clearTimeout(this.nudgeTimer);
    if (this.token) this.stores.sessions.end(this.token.sid, reason, this.reconnects);
    this.downSince = undefined;
    this.everConnected = false;
    this.reconnects = 0;
    if (this.peer) this.sig.leave(this.peer.channelId);
    this.peer = undefined;
    this.token = undefined;
    this.pendingNonce = undefined;
    this.emit({ state: 'ended', reason });
  }

  private async request() {
    if (!this.peer) return;
    if (this.token) {
      // Phone came back on signaling. Only an active outage needs a resume (no new consent asked).
      if (this.downSince == null) return;
      this.sig.relay(this.peer.channelId, await buildSessionResume(this.peer.channelId, this.token.sid, this.id.signer));
      return;
    }
    const req = await buildSessionRequest(this.peer.channelId, this.id.signer);
    this.pendingNonce = req.nonceD;
    this.sig.relay(this.peer.channelId, req);
    this.emit({ state: 'requested', peer: this.peer.fingerprint });
    clearTimeout(this.requestTimer);
    this.requestTimer = setTimeout(() => {
      if (!this.token) this.finish('timeout');
    }, REQUEST_TIMEOUT_MS);
  }

  private async onMessage(m: ServerMessage) {
    const peer = this.peer;
    if (!peer) return;
    if ('room' in m && m.room !== peer.channelId) return;

    switch (m.t) {
      case 'joined':
        if (m.peers.includes('android')) await this.request();
        return;
      case 'peer-joined':
        if (m.role === 'android') await this.request();
        return;
      case 'peer-left':
        // Signaling dropping does not mean the P2P link did: the renderer reports real link state.
        return;
      case 'relay':
        break;
      default:
        return;
    }
    if (m.from !== 'android') return;
    const parsed = E2EMessage.safeParse(m.data);
    if (!parsed.success) return;
    const msg = parsed.data;

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
        const iceServers = await this.sig.iceServers();
        this.emit({ state: 'accepted', peer: peer.fingerprint, sid: msg.token.sid, iceServers, expiresAt: msg.token.exp });
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
