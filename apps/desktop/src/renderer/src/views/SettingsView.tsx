import { useEffect, useState } from 'react';
import { rc } from '../rc';
import type { Settings } from '../../../shared/api';

export function SettingsView({ onSaved }: { onSaved(): void }) {
  const [s, setS] = useState<Settings>();
  const [saved, setSaved] = useState(false);
  useEffect(() => void rc.settings.get().then(setS), []);
  if (!s) return null;

  const valid = /^wss?:\/\/.+/.test(s.signalingUrl);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line px-8 py-6">
        <h1 className="text-lg font-semibold tracking-tight">Configurações</h1>
      </div>
      <form
        className="max-w-lg space-y-5 px-8 py-6"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!valid) return;
          setS(await rc.settings.set(s));
          setSaved(true);
          onSaved();
          setTimeout(() => setSaved(false), 1500);
        }}
      >
        <label className="block space-y-1.5">
          <span className="text-muted">Nome deste computador</span>
          <input
            value={s.deviceName ?? ''}
            placeholder="Usa o nome do sistema"
            onChange={(e) => setS({ ...s, deviceName: e.target.value })}
            className="w-full rounded-md border border-line bg-bg px-3 py-2 outline-none focus:border-accent select-text"
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-muted">Servidor de sinalização</span>
          <input
            value={s.signalingUrl}
            onChange={(e) => setS({ ...s, signalingUrl: e.target.value })}
            className={`w-full rounded-md border bg-bg px-3 py-2 font-mono outline-none focus:border-accent select-text ${valid ? 'border-line' : 'border-danger'}`}
          />
          <span className="block text-[12px] text-muted">
            Em rede local, “localhost” é substituído pelo IP da máquina no QR code. Em produção use wss://.
          </span>
        </label>
        <button disabled={!valid} className="rounded-md bg-accent px-4 py-2 font-medium text-white hover:bg-accent-strong disabled:opacity-40">
          {saved ? 'Salvo' : 'Salvar'}
        </button>
      </form>
    </div>
  );
}
