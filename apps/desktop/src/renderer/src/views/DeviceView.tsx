import { useState } from 'react';
import { Loader2, MonitorSmartphone, Plug, Trash2 } from 'lucide-react';
import { shortFingerprint } from '@rc/crypto-proto';
import type { StoredPeer } from '../../../shared/api';
import { rc } from '../rc';
import { dateTime } from '../lib/format';
import { endReasonText, useRemoteSession } from '../rtc/useRemoteSession';
import { SessionStage } from '../components/SessionStage';

export function DeviceView({ peer, online, onRemoved }: { peer: StoredPeer; online: boolean; onRemoved(): void }) {
  const session = useRemoteSession(peer.fingerprint);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const { state } = session;

  if (state.phase === 'connecting' || state.phase === 'live' || state.phase === 'reconnecting') {
    return <SessionStage peer={peer} session={session} />;
  }

  const busy = state.phase === 'waiting-peer' || state.phase === 'requested';

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between border-b border-line px-8 py-6">
        <div className="flex items-center gap-4">
          <div className="grid size-11 place-items-center rounded-xl border border-line bg-elevated">
            <MonitorSmartphone size={20} className="text-accent" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">{peer.name}</h1>
            <div className="font-mono text-[11px] text-muted">{shortFingerprint(peer.fingerprint)}</div>
          </div>
        </div>
        {confirmRemove ? (
          <div className="flex items-center gap-2">
            <span className="text-muted">Remover este dispositivo?</span>
            <button
              onClick={async () => {
                await rc.peers.remove(peer.fingerprint);
                onRemoved();
              }}
              className="rounded-md bg-danger/90 px-2.5 py-1 font-medium text-white hover:bg-danger"
            >
              Remover
            </button>
            <button onClick={() => setConfirmRemove(false)} className="rounded-md px-2.5 py-1 text-muted hover:text-fg">
              Cancelar
            </button>
          </div>
        ) : (
          <button onClick={() => setConfirmRemove(true)} className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-muted hover:bg-elevated hover:text-danger">
            <Trash2 size={13} /> Remover
          </button>
        )}
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-5 p-8 text-center">
        {busy ? (
          <>
            <Loader2 size={28} className="animate-spin text-accent" />
            <div>
              <div className="font-medium">{state.phase === 'waiting-peer' ? 'Aguardando o celular ficar disponível…' : 'Aguardando aceite no celular…'}</div>
              <p className="mt-1 max-w-sm text-muted">
                {state.phase === 'waiting-peer'
                  ? 'Abra o Remote Controller no celular e toque em “Ficar disponível”.'
                  : 'Toque em “Aceitar” no celular e confirme o compartilhamento de tela.'}
              </p>
            </div>
            <button onClick={() => void session.end()} className="rounded-md border border-line px-3 py-1.5 text-muted hover:text-fg">
              Cancelar
            </button>
          </>
        ) : (
          <>
            {state.phase === 'ended' && <p className="text-muted">{endReasonText(state.reason)}</p>}
            <button
              disabled={!online}
              onClick={() => void session.connect()}
              className="flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 font-medium text-white shadow-lg shadow-accent/20 transition hover:bg-accent-strong disabled:opacity-40"
            >
              <Plug size={15} /> Conectar
            </button>
            <p className="text-[12px] text-muted">
              Pareado em {dateTime(peer.pairedAt)}
              {peer.lastSeenAt ? ` · última sessão ${dateTime(peer.lastSeenAt)}` : ''}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
