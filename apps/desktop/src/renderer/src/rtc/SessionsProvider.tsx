import { memo, useLayoutEffect, useSyncExternalStore } from 'react';
import type { StoredPeer } from '../../../shared/api';
import { useChat } from './useChat';
import { useRemoteSession } from './useRemoteSession';

export type DeviceSession = ReturnType<typeof useRemoteSession> & { chat: ReturnType<typeof useChat> };

/** Latest session snapshot per device, published by the runners and read by any view. */
const snapshots = new Map<string, DeviceSession>();
const listeners = new Set<() => void>();
let version = 0;

function publish(fp: string, s: DeviceSession | null) {
  if (s) snapshots.set(fp, s);
  else snapshots.delete(fp);
  version++;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function useSession(fingerprint: string): DeviceSession | undefined {
  return useSyncExternalStore(subscribe, () => snapshots.get(fingerprint));
}

/** All published sessions; re-renders on any change (sidebar badges, grid). */
export function useSessions(): ReadonlyMap<string, DeviceSession> {
  useSyncExternalStore(subscribe, () => version);
  return snapshots;
}

const SessionRunner = memo(function SessionRunner({ fingerprint }: { fingerprint: string }) {
  const session = useRemoteSession(fingerprint);
  const chat = useChat(fingerprint, session.peer, session.state.phase === 'live');
  useLayoutEffect(() => publish(fingerprint, { ...session, chat }));
  useLayoutEffect(() => () => publish(fingerprint, null), [fingerprint]);
  return null;
});

/**
 * Hosts one headless runner per paired device at the app root, so sessions (and their chat and
 * transfers) keep running whatever view is on screen, several at once.
 */
export function SessionsProvider({ peers, children }: { peers: StoredPeer[]; children: React.ReactNode }) {
  return (
    <>
      {peers.map((p) => (
        <SessionRunner key={p.fingerprint} fingerprint={p.fingerprint} />
      ))}
      {children}
    </>
  );
}
