import { app } from 'electron';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PairedPeer } from '@rc/crypto-proto';

/** Small JSON-backed stores. Nothing secret lives here: peers hold public keys only. */
class JsonFile<T> {
  private value: T;
  constructor(private readonly name: string, fallback: T) {
    const p = this.path();
    this.value = existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : fallback;
  }
  private path() {
    return join(app.getPath('userData'), this.name);
  }
  get(): T {
    return this.value;
  }
  set(v: T) {
    this.value = v;
    const tmp = this.path() + '.tmp';
    writeFileSync(tmp, JSON.stringify(v, null, 2));
    renameSync(tmp, this.path());
  }
}

export interface StoredPeer extends PairedPeer {
  pairedAt: number;
  lastSeenAt?: number;
}

export interface SessionLogEntry {
  sid: string;
  peerFingerprint: string;
  peerName: string;
  startedAt: number;
  endedAt?: number;
  endReason?: string;
  /** Times the link dropped and came back during the session. */
  reconnects?: number;
}

/** Chat timeline entry, kept per paired device. Files are recorded once finished. */
export type ChatEntry =
  | { kind: 'msg'; id: string; from: 'me' | 'peer'; text: string; ts: number; delivered?: boolean }
  | { kind: 'file'; id: string; from: 'me' | 'peer'; name: string; size: number; ts: number; ok: boolean; path?: string };

const MAX_CHAT_ENTRIES = 500;

export interface Settings {
  signalingUrl: string;
  deviceName?: string;
  /** Last quality chosen in a session: 'auto' | 'high' | 'medium' | 'low'. */
  quality?: 'auto' | 'high' | 'medium' | 'low';
}

export function createStores() {
  const peers = new JsonFile<StoredPeer[]>('peers.json', []);
  const sessions = new JsonFile<SessionLogEntry[]>('sessions.json', []);
  const settings = new JsonFile<Settings>('settings.json', { signalingUrl: 'ws://localhost:8787' });
  const chats = new JsonFile<Record<string, ChatEntry[]>>('chats.json', {});
  const putChat = (fp: string, e: ChatEntry) => {
    const all = chats.get();
    const list = (all[fp] ?? []).filter((x) => x.id !== e.id);
    chats.set({ ...all, [fp]: [...list, e].slice(-MAX_CHAT_ENTRIES) });
  };

  return {
    settings,
    peers: {
      list: () => peers.get(),
      get: (fp: string) => peers.get().find((p) => p.fingerprint === fp),
      upsert: (p: StoredPeer) => peers.set([...peers.get().filter((x) => x.fingerprint !== p.fingerprint), p]),
      touch: (fp: string) => peers.set(peers.get().map((p) => (p.fingerprint === fp ? { ...p, lastSeenAt: Date.now() } : p))),
      remove: (fp: string) => peers.set(peers.get().filter((p) => p.fingerprint !== fp)),
    },
    chats: {
      list: (fp: string) => chats.get()[fp] ?? [],
      put: putChat,
      markDelivered: (fp: string, id: string) => {
        const e = (chats.get()[fp] ?? []).find((x) => x.id === id);
        if (e?.kind === 'msg') putChat(fp, { ...e, delivered: true });
      },
      clear: (fp: string) => {
        const { [fp]: _, ...rest } = chats.get();
        chats.set(rest);
      },
    },
    sessions: {
      list: () => [...sessions.get()].sort((a, b) => b.startedAt - a.startedAt),
      start: (e: SessionLogEntry) => sessions.set([...sessions.get(), e].slice(-500)),
      end: (sid: string, reason: string, reconnects = 0) =>
        sessions.set(
          sessions.get().map((s) => (s.sid === sid && !s.endedAt ? { ...s, endedAt: Date.now(), endReason: reason, reconnects } : s)),
        ),
    },
  };
}

export type Stores = ReturnType<typeof createStores>;
