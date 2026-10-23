import { History, Plus, Settings, Smartphone } from 'lucide-react';
import { shortFingerprint } from '@rc/crypto-proto';
import type { StoredPeer } from '../../../shared/api';
import { relative } from '../lib/format';

export type View = { kind: 'pair' } | { kind: 'device'; fingerprint: string } | { kind: 'history' } | { kind: 'settings' };

interface Props {
  view: View;
  onNavigate(v: View): void;
  peers: StoredPeer[];
  identity?: { name: string; fingerprint: string };
}

function NavItem({ active, onClick, icon, children }: { active: boolean; onClick(): void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors ${
        active ? 'bg-elevated text-fg' : 'text-muted hover:bg-elevated/60 hover:text-fg'
      }`}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

export function Sidebar({ view, onNavigate, peers, identity }: Props) {
  return (
    <aside className="flex w-64 shrink-0 flex-col bg-bg">
      <div className="p-3">
        <button
          onClick={() => onNavigate({ kind: 'pair' })}
          className={`flex w-full items-center justify-center gap-2 rounded-md border px-3 py-2 font-medium transition-colors ${
            view.kind === 'pair' ? 'border-accent/60 bg-accent/15 text-fg' : 'border-line text-fg hover:border-accent/50 hover:bg-accent/10'
          }`}
        >
          <Plus size={14} /> Parear dispositivo
        </button>
      </div>

      <div className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-muted">Dispositivos</div>
      <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2">
        {peers.length === 0 && <p className="px-2.5 py-2 text-muted">Nenhum dispositivo pareado.</p>}
        {peers.map((p) => (
          <NavItem
            key={p.fingerprint}
            active={view.kind === 'device' && view.fingerprint === p.fingerprint}
            onClick={() => onNavigate({ kind: 'device', fingerprint: p.fingerprint })}
            icon={<Smartphone size={14} />}
          >
            <span className="block truncate">{p.name}</span>
            <span className="block truncate text-[11px] text-muted">
              {p.lastSeenAt ? `Visto ${relative(p.lastSeenAt)}` : `Pareado ${relative(p.pairedAt)}`}
            </span>
          </NavItem>
        ))}
      </nav>

      <div className="space-y-0.5 border-t border-line p-2">
        <NavItem active={view.kind === 'history'} onClick={() => onNavigate({ kind: 'history' })} icon={<History size={14} />}>
          Histórico de sessões
        </NavItem>
        <NavItem active={view.kind === 'settings'} onClick={() => onNavigate({ kind: 'settings' })} icon={<Settings size={14} />}>
          Configurações
        </NavItem>
      </div>
      {identity && (
        <div className="border-t border-line px-4 py-3 text-[11px] text-muted">
          <div className="truncate text-fg">{identity.name}</div>
          <div className="font-mono">{shortFingerprint(identity.fingerprint)}</div>
        </div>
      )}
    </aside>
  );
}
