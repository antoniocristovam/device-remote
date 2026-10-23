import { motion } from 'motion/react';
import type { QualityMode } from '@rc/protocol';
import type { AppliedQuality } from '../rtc/useQuality';

const MODES: { mode: QualityMode; label: string; hint: string }[] = [
  { mode: 'auto', label: 'Auto', hint: 'Adapta em tempo real à qualidade da conexão' },
  { mode: 'high', label: 'Alta', hint: 'Até 1920 px · 60 fps · 8 Mbps' },
  { mode: 'medium', label: 'Média', hint: 'Até 1280 px · 30 fps · 2,5 Mbps' },
  { mode: 'low', label: 'Baixa', hint: 'Até 960 px · 24 fps · 0,8 Mbps: prioriza latência e estabilidade' },
];

const PRESET_LABEL = { high: 'Alta', medium: 'Média', low: 'Baixa' } as const;

/** Segmented control; never takes keyboard focus away from the stage. */
export function QualitySelector({
  mode,
  onChange,
  applied,
  reason,
}: {
  mode: QualityMode;
  onChange(m: QualityMode): void;
  applied?: AppliedQuality;
  reason?: string;
}) {
  const autoDetail = mode === 'auto' && applied ? `${PRESET_LABEL[applied.preset]}${reason ? ` · ${reason}` : ''}` : undefined;
  return (
    <div className="flex items-center gap-2">
      {autoDetail && <span className="hidden max-w-56 truncate text-[11px] text-muted 2xl:inline" title={autoDetail}>{autoDetail}</span>}
      <div className="relative flex rounded-lg border border-line bg-bg p-0.5" role="radiogroup" aria-label="Qualidade">
        {MODES.map((m) => {
          const active = m.mode === mode;
          return (
            <button
              key={m.mode}
              role="radio"
              aria-checked={active}
              title={m.hint}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onChange(m.mode)}
              className={`relative z-10 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${active ? 'text-fg' : 'text-muted hover:text-fg'}`}
            >
              {active && (
                <motion.span
                  layoutId="quality-pill"
                  className="absolute inset-0 -z-10 rounded-md bg-elevated ring-1 ring-line"
                  transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                />
              )}
              {m.label}
              {m.mode === 'auto' && active && applied && (
                <span className="ml-1 text-[10px] text-accent">{PRESET_LABEL[applied.preset][0]}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
