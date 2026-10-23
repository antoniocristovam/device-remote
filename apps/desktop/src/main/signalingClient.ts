import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { ServerMessage, type ClientMessage, type IceServer, type PeerRole } from '@rc/protocol';

export type SignalingStatus = 'connecting' | 'online' | 'offline';

/**
 * Reconnecting WebSocket client. Rooms joined through it are re-joined automatically after a
 * drop, so a network change does not lose the pairing channel.
 */
export class SignalingClient extends EventEmitter<{
  status: [SignalingStatus];
  message: [ServerMessage];
}> {
  private ws?: WebSocket;
  private rooms = new Map<string, PeerRole>();
  private backoff = 500;
  private timer?: NodeJS.Timeout;
  private closed = false;
  status: SignalingStatus = 'offline';

  constructor(private url: string) {
    super();
  }

  start() {
    this.closed = false;
    this.connect();
  }

  setUrl(url: string) {
    this.url = url;
    this.ws?.terminate();
  }

  private setStatus(s: SignalingStatus) {
    this.status = s;
    this.emit('status', s);
  }

  private connect() {
    clearTimeout(this.timer);
    this.setStatus('connecting');
    const ws = new WebSocket(this.url, { handshakeTimeout: 8000 });
    this.ws = ws;
    ws.on('open', () => {
      this.backoff = 500;
      this.setStatus('online');
      for (const [room, role] of this.rooms) this.raw({ t: 'join', room, role });
    });
    ws.on('message', (d) => {
      try {
        const r = ServerMessage.safeParse(JSON.parse(d.toString()));
        if (r.success) this.emit('message', r.data);
      } catch {
        /* ignore malformed */
      }
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.setStatus('offline');
      if (!this.closed) {
        this.timer = setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, 5_000);
      }
    });
    ws.on('error', () => {
      /* close follows */
    });
  }

  private raw(m: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  join(room: string, role: PeerRole) {
    this.rooms.set(room, role);
    this.raw({ t: 'join', room, role });
  }

  leave(room: string) {
    if (!this.rooms.delete(room)) return;
    this.raw({ t: 'leave', room });
  }

  relay(room: string, data: unknown) {
    this.raw({ t: 'relay', room, data });
  }

  iceServers(timeoutMs = 4000): Promise<IceServer[]> {
    return new Promise((resolve) => {
      const fallback: IceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
      const t = setTimeout(() => {
        this.off('message', onMsg);
        resolve(fallback);
      }, timeoutMs);
      const onMsg = (m: ServerMessage) => {
        if (m.t !== 'turn-credentials') return;
        clearTimeout(t);
        this.off('message', onMsg);
        resolve(m.iceServers.length ? m.iceServers : fallback);
      };
      this.on('message', onMsg);
      this.raw({ t: 'turn' });
    });
  }

  stop() {
    this.closed = true;
    clearTimeout(this.timer);
    this.ws?.close();
  }
}
