import { useCallback, useEffect, useRef, useState } from 'react';
import { FILE_FRAME_BYTES, FILE_ID_BYTES, MAX_FILE_BYTES, type ChatFrame, type FileFrame } from '@rc/protocol';
import type { ChatEntry } from '../../../shared/api';
import { rc } from '../rc';
import type { PeerSession } from './PeerSession';

export interface Transfer {
  id: string;
  from: 'me' | 'peer';
  name: string;
  size: number;
  bytes: number;
  state: 'waiting' | 'sending' | 'receiving' | 'verifying';
}

const PAYLOAD = FILE_FRAME_BYTES - FILE_ID_BYTES;
const randomHex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');
const idBytes = (id: string) => Uint8Array.from(id.match(/.{2}/g)!, (h) => parseInt(h, 16));

/**
 * Chat timeline and file transfers over the "chat" and "file" data channels. History is kept by
 * the main process per paired device; in-flight transfers live here.
 */
export function useChat(fingerprint: string, peer: React.RefObject<PeerSession | undefined>, live: boolean) {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [transfers, setTransfers] = useState<Record<string, Transfer>>({});
  const [unread, setUnread] = useState(0);
  const waiters = useRef(new Map<string, (f: FileFrame) => void>());
  const incoming = useRef(new Map<string, { name: string; size: number; bytes: number }>());
  const cancelled = useRef(new Set<string>());

  const put = useCallback(
    (e: ChatEntry) => {
      setEntries((list) => [...list.filter((x) => x.id !== e.id), e]);
      void rc.chat.put(fingerprint, e);
    },
    [fingerprint],
  );
  const patchTransfer = (id: string, patch: Partial<Transfer> | null) =>
    setTransfers((t) => {
      if (patch === null) {
        const { [id]: _, ...rest } = t;
        return rest;
      }
      return { ...t, [id]: { ...t[id]!, ...patch } };
    });

  useEffect(() => {
    void rc.chat.list(fingerprint).then(setEntries);
  }, [fingerprint]);

  // Wire channel handlers whenever a (new) peer connection exists.
  useEffect(() => {
    const p = peer.current;
    if (!p || !live) return;

    const onChat = (f: ChatFrame) => {
      if (f.t === 'ack') {
        setEntries((list) => list.map((e) => (e.id === f.id && e.kind === 'msg' ? { ...e, delivered: true } : e)));
        void rc.chat.delivered(fingerprint, f.id);
        return;
      }
      put({ kind: 'msg', id: f.id, from: 'peer', text: f.text, ts: f.ts });
      setUnread((n) => n + 1);
      p.sendChat({ t: 'ack', id: f.id });
    };

    const onFile = async (f: FileFrame) => {
      switch (f.t) {
        case 'offer': {
          if (f.size > MAX_FILE_BYTES || incoming.current.has(f.id)) {
            p.sendFileFrame({ t: 'reject', id: f.id, reason: 'too large' });
            return;
          }
          await rc.files.begin(f.id, f.name, f.size);
          incoming.current.set(f.id, { name: f.name, size: f.size, bytes: 0 });
          setTransfers((t) => ({ ...t, [f.id]: { id: f.id, from: 'peer', name: f.name, size: f.size, bytes: 0, state: 'receiving' } }));
          p.sendFileFrame({ t: 'accept', id: f.id });
          return;
        }
        case 'done': {
          const inc = incoming.current.get(f.id);
          if (!inc) return;
          incoming.current.delete(f.id);
          patchTransfer(f.id, { state: 'verifying' });
          const r = await rc.files.finish(f.id, f.sha256);
          p.sendFileFrame({ t: 'ack', id: f.id, ok: r.ok });
          patchTransfer(f.id, null);
          put({ kind: 'file', id: f.id, from: 'peer', name: inc.name, size: inc.size, ts: Date.now(), ok: r.ok, path: r.path });
          setUnread((n) => n + 1);
          return;
        }
        case 'cancel': {
          const inc = incoming.current.get(f.id);
          if (inc) {
            incoming.current.delete(f.id);
            void rc.files.abort(f.id);
            patchTransfer(f.id, null);
            put({ kind: 'file', id: f.id, from: 'peer', name: inc.name, size: inc.size, ts: Date.now(), ok: false });
          }
          waiters.current.get(f.id)?.(f);
          return;
        }
        default:
          // accept / reject / ack answer one of our own outgoing transfers.
          waiters.current.get(f.id)?.(f);
      }
    };

    const onChunk = (id: string, data: Uint8Array) => {
      const inc = incoming.current.get(id);
      if (!inc) return;
      inc.bytes += data.byteLength;
      if (inc.bytes > inc.size) {
        incoming.current.delete(id);
        void rc.files.abort(id);
        p.sendFileFrame({ t: 'cancel', id, reason: 'size exceeded' });
        patchTransfer(id, null);
        return;
      }
      rc.files.chunk(id, data.slice());
      // Throttle React updates to ~every 256 KB.
      if (inc.bytes % (256 * 1024) < data.byteLength || inc.bytes === inc.size) patchTransfer(id, { bytes: inc.bytes });
    };

    p.handlers = { chat: onChat, file: (f) => void onFile(f), fileChunk: onChunk };
    return () => {
      p.handlers = {};
      for (const id of incoming.current.keys()) void rc.files.abort(id);
      incoming.current.clear();
      setTransfers({});
    };
  }, [peer, live, fingerprint, put]);

  const sendText = (text: string) => {
    const p = peer.current;
    const t = text.trim();
    if (!p || !t) return false;
    const f: ChatFrame = { t: 'msg', id: randomHex(12), text: t.slice(0, 8000), ts: Date.now() };
    if (!p.sendChat(f)) return false;
    put({ kind: 'msg', id: f.id, from: 'me', text: f.text, ts: f.ts });
    return true;
  };

  const waitFor = (id: string, kinds: FileFrame['t'][], timeoutMs: number) =>
    new Promise<FileFrame | null>((resolve) => {
      const timer = setTimeout(() => done(null), timeoutMs);
      const done = (f: FileFrame | null) => {
        clearTimeout(timer);
        waiters.current.delete(id);
        resolve(f);
      };
      waiters.current.set(id, (f) => {
        if (kinds.includes(f.t) || f.t === 'cancel' || f.t === 'reject') done(f);
      });
    });

  const sendFile = async (file: File) => {
    const p = peer.current;
    if (!p || file.size > MAX_FILE_BYTES) return;
    const id = randomHex(16);
    const record = (ok: boolean) => {
      patchTransfer(id, null);
      put({ kind: 'file', id, from: 'me', name: file.name, size: file.size, ts: Date.now(), ok });
    };
    setTransfers((t) => ({ ...t, [id]: { id, from: 'me', name: file.name, size: file.size, bytes: 0, state: 'waiting' } }));
    const path = rc.files.pathFor(file);
    const hash = rc.files.hash(path);
    if (!p.sendFileFrame({ t: 'offer', id, name: file.name, size: file.size, mime: file.type || 'application/octet-stream' })) return record(false);
    const answer = await waitFor(id, ['accept'], 30_000);
    if (answer?.t !== 'accept') return record(false);

    patchTransfer(id, { state: 'sending' });
    const header = idBytes(id);
    const reader = file.stream().getReader();
    let sent = 0;
    let pending = new Uint8Array(0);
    try {
      for (;;) {
        if (cancelled.current.has(id)) throw new Error('cancelled');
        const { value, done } = await reader.read();
        if (value) {
          if (pending.length) {
            const merged = new Uint8Array(pending.length + value.length);
            merged.set(pending);
            merged.set(value, pending.length);
            pending = merged;
          } else {
            pending = value;
          }
        }
        while (pending.length >= PAYLOAD || (done && pending.length > 0)) {
          const part = pending.subarray(0, PAYLOAD);
          const frame = new Uint8Array(FILE_ID_BYTES + part.length);
          frame.set(header);
          frame.set(part, FILE_ID_BYTES);
          await p.sendFileChunk(frame);
          sent += part.length;
          pending = pending.subarray(part.length);
          if (sent % (256 * 1024) < part.length || sent === file.size) patchTransfer(id, { bytes: sent });
        }
        if (done) break;
      }
    } catch {
      cancelled.current.delete(id);
      p.sendFileFrame({ t: 'cancel', id, reason: 'sender stopped' });
      return record(false);
    }
    patchTransfer(id, { state: 'verifying' });
    p.sendFileFrame({ t: 'done', id, sha256: await hash });
    const ack = await waitFor(id, ['ack'], 120_000);
    record(ack?.t === 'ack' && ack.ok);
  };

  const cancel = (id: string) => {
    const p = peer.current;
    if (incoming.current.has(id)) {
      const inc = incoming.current.get(id)!;
      incoming.current.delete(id);
      void rc.files.abort(id);
      p?.sendFileFrame({ t: 'cancel', id, reason: 'receiver cancelled' });
      patchTransfer(id, null);
      put({ kind: 'file', id, from: 'peer', name: inc.name, size: inc.size, ts: Date.now(), ok: false });
    } else {
      cancelled.current.add(id);
    }
  };

  return {
    entries,
    transfers: Object.values(transfers),
    unread,
    clearUnread: () => setUnread(0),
    sendText,
    sendFiles: (files: FileList | File[]) => {
      for (const f of Array.from(files)) void sendFile(f);
    },
    cancel,
  };
}
