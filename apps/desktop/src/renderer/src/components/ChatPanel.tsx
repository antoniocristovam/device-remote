import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Check, CheckCheck, FileDown, FileUp, FolderOpen, Paperclip, SendHorizontal, X, AlertCircle } from 'lucide-react';
import type { ChatEntry } from '../../../shared/api';
import type { Transfer, useChat } from '../rtc/useChat';
import { rc } from '../rc';

type Chat = ReturnType<typeof useChat>;

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

const time = (ts: number) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

function FileCard({ e }: { e: Extract<ChatEntry, { kind: 'file' }> }) {
  const Icon = e.from === 'me' ? FileUp : FileDown;
  return (
    <div className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 ${e.ok ? 'border-line bg-elevated' : 'border-danger/40 bg-danger/5'}`}>
      <Icon size={16} className={e.ok ? 'text-accent' : 'text-danger'} />
      <div className="min-w-0 flex-1">
        <div className="truncate">{e.name}</div>
        <div className="text-[11px] text-muted">
          {formatBytes(e.size)} · {e.ok ? (e.from === 'me' ? 'enviado' : 'recebido') : 'falhou'}
        </div>
      </div>
      {e.ok && e.path && (
        <button onClick={() => void rc.files.reveal(e.path!)} title="Mostrar na pasta" className="rounded p-1 text-muted hover:bg-bg hover:text-fg">
          <FolderOpen size={14} />
        </button>
      )}
    </div>
  );
}

function TransferCard({ t, onCancel }: { t: Transfer; onCancel(): void }) {
  const pct = t.size ? Math.round((t.bytes / t.size) * 100) : 100;
  const label = { waiting: 'aguardando aceite…', sending: 'enviando', receiving: 'recebendo', verifying: 'verificando…' }[t.state];
  return (
    <div className="rounded-lg border border-accent/40 bg-accent/5 px-3 py-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 truncate">{t.name}</div>
        {t.state !== 'verifying' && (
          <button onClick={onCancel} title="Cancelar" className="rounded p-0.5 text-muted hover:text-danger">
            <X size={13} />
          </button>
        )}
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded bg-line">
        <motion.div className="h-full bg-accent" animate={{ width: `${pct}%` }} transition={{ ease: 'linear', duration: 0.2 }} />
      </div>
      <div className="mt-1 text-[11px] text-muted">
        {label} · {formatBytes(t.bytes)} de {formatBytes(t.size)}
      </div>
    </div>
  );
}

/** Side panel: chat timeline (messages + files) and composer. Keys typed here never reach the phone. */
export function ChatPanel({ chat, peerName, connected }: { chat: Chat; peerName: string; connected: boolean }) {
  const [draft, setDraft] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' });
  }, [chat.entries.length, chat.transfers.length]);

  const submit = () => {
    if (chat.sendText(draft)) setDraft('');
  };

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-line bg-panel">
      <div className="flex h-10 items-center justify-between border-b border-line px-4">
        <span className="font-medium">Chat com {peerName}</span>
        <button onClick={() => void rc.files.openDir()} title="Abrir pasta de recebidos" className="rounded p-1 text-muted hover:bg-elevated hover:text-fg">
          <FolderOpen size={14} />
        </button>
      </div>

      <div ref={list} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {chat.entries.length === 0 && chat.transfers.length === 0 && (
          <p className="px-1 pt-8 text-center text-muted">
            Envie uma mensagem ou arraste arquivos para cá ou para a tela do celular.
          </p>
        )}
        {chat.entries.map((e) => (
          <div key={e.id} className={`flex flex-col ${e.from === 'me' ? 'items-end' : 'items-start'}`}>
            {e.kind === 'msg' ? (
              <div
                className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-1.5 select-text ${
                  e.from === 'me' ? 'rounded-br-md bg-accent text-white' : 'rounded-bl-md bg-elevated'
                }`}
              >
                {e.text}
              </div>
            ) : (
              <div className="w-[85%]">
                <FileCard e={e} />
              </div>
            )}
            <div className="mt-0.5 flex items-center gap-1 px-1 text-[10px] text-muted">
              {time(e.ts)}
              {e.kind === 'msg' && e.from === 'me' && (e.delivered ? <CheckCheck size={11} className="text-accent" /> : <Check size={11} />)}
            </div>
          </div>
        ))}
        {chat.transfers.map((t) => (
          <div key={t.id} className={`flex ${t.from === 'me' ? 'justify-end' : 'justify-start'}`}>
            <div className="w-[85%]">
              <TransferCard t={t} onCancel={() => chat.cancel(t.id)} />
            </div>
          </div>
        ))}
      </div>

      {!connected && (
        <div className="flex items-center gap-1.5 border-t border-line px-4 py-2 text-[12px] text-warn">
          <AlertCircle size={12} /> Sem conexão com o celular
        </div>
      )}
      <div className="flex items-end gap-2 border-t border-line p-3">
        <input ref={picker} type="file" multiple hidden onChange={(e) => e.target.files && chat.sendFiles(e.target.files)} />
        <button
          disabled={!connected}
          onClick={() => picker.current?.click()}
          title="Enviar arquivo"
          className="grid size-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-elevated hover:text-fg disabled:opacity-40"
        >
          <Paperclip size={16} />
        </button>
        <textarea
          value={draft}
          rows={1}
          placeholder="Mensagem"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          className="max-h-32 min-h-9 flex-1 resize-none rounded-lg border border-line bg-bg px-3 py-2 outline-none select-text focus:border-accent"
        />
        <button
          disabled={!connected || !draft.trim()}
          onClick={submit}
          title="Enviar"
          className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent text-white hover:bg-accent-strong disabled:opacity-40"
        >
          <SendHorizontal size={15} />
        </button>
      </div>
    </aside>
  );
}
