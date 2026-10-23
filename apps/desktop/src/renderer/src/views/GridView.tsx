import { useState } from 'react';
import { LayoutGrid, Plug } from 'lucide-react';
import type { StoredPeer } from '../../../shared/api';
import { GridTile } from '../components/GridTile';
import { useSessions } from '../rtc/SessionsProvider';
import { isOnStage } from '../rtc/useRemoteSession';

/** Every paired phone side by side, live; click a tile to control it, expand it for the full stage. */
export function GridView({ peers, online, onExpand }: { peers: StoredPeer[]; online: boolean; onExpand(fp: string): void }) {
  const sessions = useSessions();
  const [focused, setFocused] = useState<string>();
  const idle = peers.filter((p) => {
    const s = sessions.get(p.fingerprint);
    return s && (s.state.phase === 'idle' || s.state.phase === 'ended');
  });
  const liveCount = peers.filter((p) => {
    const s = sessions.get(p.fingerprint);
    return s && isOnStage(s.state);
  }).length;
  // Fewer, larger tiles when only a couple of phones are around.
  const minTile = peers.length <= 2 ? 360 : peers.length <= 4 ? 280 : 220;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
        <LayoutGrid size={15} className="text-accent" />
        <span className="font-medium">Todos os dispositivos</span>
        <span className="text-[12px] text-muted">
          {liveCount} de {peers.length} conectado{peers.length === 1 ? '' : 's'}
        </span>
        <button
          disabled={!online || idle.length === 0}
          onClick={() => idle.forEach((p) => void sessions.get(p.fingerprint)?.connect())}
          className="ml-auto flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-muted hover:border-accent/50 hover:text-fg disabled:opacity-40"
        >
          <Plug size={13} /> Conectar todos
        </button>
      </div>
      {peers.length === 0 ? (
        <p className="p-8 text-muted">Nenhum dispositivo pareado.</p>
      ) : (
        <div
          className="grid min-h-0 flex-1 gap-3 overflow-y-auto p-4"
          style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${minTile}px, 1fr))`, gridAutoRows: 'minmax(320px, 1fr)' }}
        >
          {peers.map((p) => {
            const s = sessions.get(p.fingerprint);
            if (!s) return null;
            return (
              <GridTile
                key={p.fingerprint}
                peer={p}
                session={s}
                focused={focused === p.fingerprint}
                online={online}
                onFocus={() => setFocused(p.fingerprint)}
                onExpand={() => onExpand(p.fingerprint)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
