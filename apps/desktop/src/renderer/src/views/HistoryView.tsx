import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Clock, MonitorSmartphone, RefreshCw, ShieldAlert, Unplug, WifiOff } from 'lucide-react';
import type { SessionLogEntry } from '../../../shared/api';
import { rc } from '../rc';
import { duration } from '../lib/format';

/** How each end reason reads in the audit log, from this computer's point of view. */
const REASONS: Record<string, { label: string; tone: 'muted' | 'warn' | 'danger' }> = {
  user: { label: 'Encerrada neste computador', tone: 'muted' },
  revoked: { label: 'Encerrada no celular', tone: 'warn' },
  lost: { label: 'Conexão perdida', tone: 'danger' },
  expired: { label: 'Sessão expirada', tone: 'muted' },
  error: { label: 'Erro', tone: 'danger' },
  timeout: { label: 'Sem resposta do celular', tone: 'muted' },
  denied: { label: 'Recusada no celular', tone: 'warn' },
  'verification-failed': { label: 'Falha de verificação', tone: 'danger' },
};
const TONE = { muted: 'text-muted', warn: 'text-warn', danger: 'text-danger' };

const dayKey = (ts: number) => new Date(ts).toDateString();
function dayLabel(ts: number) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Hoje';
  if (d.toDateString() === yesterday.toDateString()) return 'Ontem';
  return d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
}
const hm = (ts: number) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line bg-elevated/60 px-4 py-3">
      <div className="text-accent">{icon}</div>
      <div>
        <div className="text-[11px] uppercase tracking-wider text-muted">{label}</div>
        <div className="font-mono text-[15px]">{value}</div>
      </div>
    </div>
  );
}

export function HistoryView() {
  const [rows, setRows] = useState<SessionLogEntry[]>([]);
  const [device, setDevice] = useState<string>('all');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const load = () => void rc.history().then(setRows);
    load();
    // Keep the audit log live: sessions start/end while this view is open.
    const off = rc.session.on((e) => {
      if (e.state === 'accepted' || e.state === 'ended') setTimeout(load, 200);
    });
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      off();
      clearInterval(t);
    };
  }, []);

  const devices = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) m.set(r.peerFingerprint, r.peerName);
    return [...m];
  }, [rows]);

  const visible = device === 'all' ? rows : rows.filter((r) => r.peerFingerprint === device);
  const totalMs = visible.reduce((n, r) => n + ((r.endedAt ?? now) - r.startedAt), 0);
  const groups = useMemo(() => {
    const g = new Map<string, SessionLogEntry[]>();
    for (const r of visible) g.set(dayKey(r.startedAt), [...(g.get(dayKey(r.startedAt)) ?? []), r]);
    return [...g.values()];
  }, [visible]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line px-8 py-6">
        <h1 className="text-lg font-semibold tracking-tight">Histórico de sessões</h1>
        <p className="mt-1 text-muted">Registro de quando e por quanto tempo cada dispositivo foi controlado a partir deste computador.</p>
        <div className="mt-5 grid max-w-2xl grid-cols-3 gap-3">
          <Stat icon={<MonitorSmartphone size={16} />} label="Sessões" value={String(visible.length)} />
          <Stat icon={<Clock size={16} />} label="Tempo total" value={duration(totalMs)} />
          <Stat icon={<RefreshCw size={16} />} label="Reconexões" value={String(visible.reduce((n, r) => n + (r.reconnects ?? 0), 0))} />
        </div>
        {devices.length > 1 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {[['all', 'Todos'] as const, ...devices].map(([fp, name]) => (
              <button
                key={fp}
                onClick={() => setDevice(fp)}
                className={`rounded-full border px-3 py-1 text-[12px] transition-colors ${
                  device === fp ? 'border-accent/60 bg-accent/15 text-fg' : 'border-line text-muted hover:text-fg'
                }`}
              >
                {name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-4">
        {visible.length === 0 && <p className="text-muted">Nenhuma sessão registrada.</p>}
        {groups.map((items) => (
          <section key={dayKey(items[0]!.startedAt)} className="mb-6">
            <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted first-letter:uppercase">{dayLabel(items[0]!.startedAt)}</h2>
            <div className="divide-y divide-line overflow-hidden rounded-lg border border-line">
              {items.map((r) => {
                const live = !r.endedAt;
                const reason = r.endReason ? REASONS[r.endReason] ?? { label: r.endReason, tone: 'muted' as const } : undefined;
                return (
                  <motion.div
                    key={r.sid}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="grid grid-cols-[1fr_8rem_6rem_12rem] items-center gap-4 bg-panel px-4 py-3"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium">{r.peerName}</div>
                      <div className="font-mono text-[11px] text-muted">
                        {hm(r.startedAt)} – {r.endedAt ? hm(r.endedAt) : 'agora'}
                      </div>
                    </div>
                    <div className="font-mono">{duration((r.endedAt ?? now) - r.startedAt)}</div>
                    <div className="text-[12px] text-muted">
                      {(r.reconnects ?? 0) > 0 && (
                        <span className="inline-flex items-center gap-1" title="Quedas de conexão recuperadas">
                          <WifiOff size={11} /> {r.reconnects}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center justify-end gap-1.5 text-[12px]">
                      {live ? (
                        <span className="inline-flex items-center gap-1.5 text-danger">
                          <span className="size-1.5 animate-pulse rounded-full bg-danger" /> em andamento
                        </span>
                      ) : (
                        <span className={`inline-flex items-center gap-1.5 ${TONE[reason!.tone]}`}>
                          {reason!.tone === 'danger' ? <ShieldAlert size={12} /> : reason!.tone === 'warn' ? <Unplug size={12} /> : null}
                          {reason!.label}
                        </span>
                      )}
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
