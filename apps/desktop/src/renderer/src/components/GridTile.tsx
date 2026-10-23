import { useEffect } from 'react';
import { Loader2, Maximize2, MessageSquare, PhoneOff, Plug, Smartphone, Usb } from 'lucide-react';
import type { StoredPeer } from '../../../shared/api';
import { useStageInput } from '../input/useStageInput';
import type { DeviceSession } from '../rtc/SessionsProvider';
import { endReasonText, isOnStage } from '../rtc/useRemoteSession';
import { Pill } from './SessionStage';

interface Props {
  peer: StoredPeer;
  session: DeviceSession;
  /** Only the focused tile takes mouse and keyboard; a first click on another tile just focuses it. */
  focused: boolean;
  online: boolean;
  onFocus(): void;
  onExpand(): void;
}

export function GridTile({ peer, session, focused, online, onFocus, onExpand }: Props) {
  const { state, stream, stats, chat } = session;
  const { video, stage, videoProps, stageProps } = useStageInput((m) => session.peer.current?.send(m), focused);
  const onStage = isOnStage(state);
  const busy = state.phase === 'waiting-peer' || state.phase === 'requested';

  useEffect(() => {
    if (video.current) video.current.srcObject = stream ?? null;
  }, [stream, video, onStage]);

  useEffect(() => {
    if (focused) stage.current?.focus();
  }, [focused, stage, onStage]);

  const rttTone = stats.rttMs == null ? 'muted' : stats.rttMs < 60 ? 'ok' : stats.rttMs < 150 ? 'warn' : 'danger';

  return (
    <div
      className={`flex min-h-0 flex-col overflow-hidden rounded-xl border bg-bg transition-colors ${
        focused && onStage ? 'border-accent shadow-lg shadow-accent/15' : 'border-line'
      }`}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        {onStage ? (
          <span className={`size-2 shrink-0 rounded-full ${state.phase === 'live' ? 'bg-danger' : 'bg-warn'}`} />
        ) : (
          <Smartphone size={13} className="shrink-0 text-muted" />
        )}
        <span className="min-w-0 flex-1 truncate font-medium">{peer.name}</span>
        {session.transport === 'usb' && (
          <Pill tone="ok">
            <span className="inline-flex items-center gap-1">
              <Usb size={11} /> USB
            </span>
          </Pill>
        )}
        {state.phase === 'live' && stats.rttMs != null && <Pill tone={rttTone}>{stats.rttMs.toFixed(0)} ms</Pill>}
        {onStage && chat.unread > 0 && (
          <span className="flex items-center gap-1 text-[11px] text-accent">
            <MessageSquare size={12} /> {chat.unread}
          </span>
        )}
        {onStage && (
          <>
            <button onMouseDown={(e) => e.preventDefault()} onClick={onExpand} title="Abrir em tela única" className="rounded-md p-1 text-muted hover:bg-elevated hover:text-fg">
              <Maximize2 size={13} />
            </button>
            <button onClick={() => void session.end()} title="Encerrar sessão" className="rounded-md p-1 text-muted hover:bg-elevated hover:text-danger">
              <PhoneOff size={13} />
            </button>
          </>
        )}
      </div>

      {onStage ? (
        <div
          ref={stage}
          {...stageProps}
          onFocus={onFocus}
          style={{ outline: 'none' }}
          className="relative flex min-h-0 flex-1 items-center justify-center p-3"
        >
          <video
            ref={video}
            autoPlay
            playsInline
            muted
            {...videoProps}
            onPointerCancel={videoProps.onPointerUp}
            className={`h-full max-h-full w-auto max-w-full rounded-[14px] border border-line bg-black object-contain ${focused ? 'cursor-crosshair' : 'cursor-pointer'}`}
          />
          {state.phase !== 'live' && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <div className="flex items-center gap-2 rounded-lg bg-bg/80 px-3 py-2 text-muted backdrop-blur">
                <Loader2 size={14} className="animate-spin" />
                {state.phase === 'reconnecting' ? 'Reconectando…' : 'Conectando…'}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
          {busy ? (
            <>
              <Loader2 size={20} className="animate-spin text-accent" />
              <p className="max-w-[16rem] text-[12px] text-muted">
                {state.phase === 'waiting-peer' ? 'Aguardando o celular ficar disponível…' : 'Aguardando aceite no celular…'}
              </p>
              <button onClick={() => void session.end()} className="rounded-md border border-line px-2.5 py-1 text-[12px] text-muted hover:text-fg">
                Cancelar
              </button>
            </>
          ) : (
            <>
              {state.phase === 'ended' && <p className="max-w-[16rem] text-[12px] text-muted">{endReasonText(state.reason)}</p>}
              <button
                disabled={!online}
                onClick={() => void session.connect()}
                className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 font-medium text-white transition hover:bg-accent-strong disabled:opacity-40"
              >
                <Plug size={14} /> Conectar
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
