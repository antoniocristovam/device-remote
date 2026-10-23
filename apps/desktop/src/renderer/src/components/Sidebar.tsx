import { History, LayoutGrid, Plus, Settings, Smartphone, Usb } from 'lucide-react';
import { shortFingerprint } from '@rc/crypto-proto';
import type { StoredPeer, UsbStatus } from '../../../shared/api';
import { relative } from '../lib/format';
import { useSessions } from '../rtc/SessionsProvider';
import { isOnStage } from '../rtc/useRemoteSession';

export type View = { kind: 'pair' } | { kind: 'grid' } | { kind: 'device'; fingerprint: string } | { kind: 'history' } | { kind: 'settings' };

interface Props {
  view: View;
  onNavigate(v: View): void;
  peers: StoredPeer[];
  identity?: { name: string; fingerprint: string };
  usb: UsbStatus;
}

function UsbLine({ usb }: { usb: UsbStatus }) {
  if (usb.adb === 'starting') return null;
  const ready = usb.devices.filter((d) => d.state === 'device');
  const unauthorized = usb.devices.some((d) => d.state === 'unauthorized');
  const text =
    usb.adb === 'missing'
      ? 'USB indisponível (adb não encontrado)'
      : ready.length
        ? `USB: ${ready.map((d) => d.model ?? d.serial).join(', ')}`
        : unauthorized
          ? 'Autorize a depuração USB no celular'
          : 'Nenhum celular no cabo USB';
  return (
    <div className={`flex items-center gap-1.5 truncate ${ready.length ? 'text-ok' : unauthorized ? 'text-warn' : 'text-muted'}`} title={text}>
      <Usb size={11} className="shrink-0" />
      <span className="truncate">{text}</span>
    </div>
  );
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

export function Sidebar({ view, onNavigate, peers, identity, usb }: Props) {
  const sessions = useSessions();
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
        {peers.length > 0 && (
          <NavItem active={view.kind === 'grid'} onClick={() => onNavigate({ kind: 'grid' })} icon={<LayoutGrid size={14} />}>
            Todos os dispositivos
          </NavItem>
        )}
        {peers.length === 0 && <p className="px-2.5 py-2 text-muted">Nenhum dispositivo pareado.</p>}
        {peers.map((p) => {
          const s = sessions.get(p.fingerprint);
          const onStage = !!s && isOnStage(s.state);
          return (
            <NavItem
              key={p.fingerprint}
              active={view.kind === 'device' && view.fingerprint === p.fingerprint}
              onClick={() => onNavigate({ kind: 'device', fingerprint: p.fingerprint })}
              icon={
                <span className="relative">
                  <Smartphone size={14} />
                  {onStage && <span className={`absolute -right-0.5 -top-0.5 size-1.5 rounded-full ${s.state.phase === 'live' ? 'bg-danger' : 'bg-warn'}`} />}
                </span>
              }
            >
              <span className="flex items-center gap-1.5">
                <span className="truncate">{p.name}</span>
                {onStage && s.transport === 'usb' && <Usb size={11} className="shrink-0 text-ok" />}
              </span>
              <span className="block truncate text-[11px] text-muted">
                {onStage ? (s.state.phase === 'live' ? 'Ao vivo' : 'Conectando…') : p.lastSeenAt ? `Visto ${relative(p.lastSeenAt)}` : `Pareado ${relative(p.pairedAt)}`}
              </span>
            </NavItem>
          );
        })}
      </nav>

      <div className="space-y-0.5 border-t border-line p-2">
        <NavItem active={view.kind === 'history'} onClick={() => onNavigate({ kind: 'history' })} icon={<History size={14} />}>
          Histórico de sessões
        </NavItem>
        <NavItem active={view.kind === 'settings'} onClick={() => onNavigate({ kind: 'settings' })} icon={<Settings size={14} />}>
          Configurações
        </NavItem>
      </div>
      <div className="border-t border-line px-4 py-2 text-[11px]">
        <UsbLine usb={usb} />
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
