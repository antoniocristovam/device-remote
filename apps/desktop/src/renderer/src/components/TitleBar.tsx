import type { SignalingStatus } from '../../../shared/api';

const LABEL: Record<SignalingStatus, string> = { online: 'Online', connecting: 'Conectando…', offline: 'Offline' };
const DOT: Record<SignalingStatus, string> = { online: 'bg-ok', connecting: 'bg-warn animate-pulse', offline: 'bg-danger' };

export function TitleBar({ status }: { status: SignalingStatus }) {
  const mac = navigator.userAgent.includes('Mac');
  return (
    <header className={`drag flex h-10 shrink-0 items-center gap-3 border-b border-line bg-bg ${mac ? 'pl-20' : 'pl-4'} pr-40`}>
      <div className="flex items-center gap-2 font-medium tracking-tight">
        <div className="grid size-5 place-items-center rounded-md bg-accent/90 text-[10px] font-bold text-white">RC</div>
        Remote Controller
      </div>
      <div className="no-drag ml-2 flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">
        <span className={`size-1.5 rounded-full ${DOT[status]}`} />
        Sinalização {LABEL[status]}
      </div>
    </header>
  );
}
