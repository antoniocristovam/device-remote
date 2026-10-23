import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowLeft, Bell, Circle, Loader2, PhoneOff, Square, Activity, MessageSquare, Upload, Usb } from 'lucide-react';
import type { GlobalAction } from '@rc/protocol';
import type { StoredPeer } from '../../../shared/api';
import { useStageInput } from '../input/useStageInput';
import type { DeviceSession } from '../rtc/SessionsProvider';
import { duration } from '../lib/format';
import { ChatPanel } from './ChatPanel';
import { QualitySelector } from './QualitySelector';

export function Pill({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'ok' | 'warn' | 'danger' }) {
  const color = { muted: 'text-muted', ok: 'text-ok', warn: 'text-warn', danger: 'text-danger' }[tone];
  return <span className={`rounded-md border border-line bg-bg/60 px-2 py-0.5 font-mono text-[11px] ${color}`}>{children}</span>;
}

export function SessionStage({ peer, session }: { peer: StoredPeer; session: DeviceSession }) {
  const [now, setNow] = useState(Date.now());
  const [showHud, setShowHud] = useState(true);
  const { state, stats, stream, startedAt, chat } = session;
  const [chatOpen, setChatOpen] = useState(true);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const live = state.phase === 'live';
  const { video, stage, videoProps, stageProps, send } = useStageInput((m) => session.peer.current?.send(m));

  useEffect(() => {
    if (chatOpen) chat.clearUnread();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatOpen, chat.unread]);

  const isFileDrag = (e: React.DragEvent) => e.dataTransfer.types.includes('Files');
  const dragProps = {
    onDragEnter: (e: React.DragEvent) => {
      if (!isFileDrag(e)) return;
      dragDepth.current++;
      setDragging(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (isFileDrag(e)) e.preventDefault();
    },
    onDragLeave: () => {
      if (--dragDepth.current <= 0) setDragging(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (live && e.dataTransfer.files.length) {
        chat.sendFiles(e.dataTransfer.files);
        setChatOpen(true);
      }
    },
  };

  useEffect(() => {
    if (video.current && stream) video.current.srcObject = stream;
  }, [stream, video]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    stage.current?.focus();
    return () => clearInterval(t);
  }, [stage]);

  const nav = (action: GlobalAction) => () => send({ t: 'global', action });
  // Toolbar clicks must not steal keyboard focus from the stage, or typing stops reaching the phone.
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();
  const rttTone = stats.rttMs == null ? 'muted' : stats.rttMs < 60 ? 'ok' : stats.rttMs < 150 ? 'warn' : 'danger';

  return (
    <div className="relative flex h-full bg-bg" {...dragProps}>
      {dragging && (
        <div className="pointer-events-none absolute inset-3 z-30 grid place-items-center rounded-2xl border-2 border-dashed border-accent bg-accent/10 backdrop-blur-[2px]">
          <div className="flex items-center gap-2 text-base font-medium text-fg">
            <Upload size={18} /> {live ? `Solte para enviar a ${peer.name}` : 'Aguardando conexão…'}
          </div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
        <span className="relative flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-danger opacity-60" />
          <span className="relative inline-flex size-2 rounded-full bg-danger" />
        </span>
        <span className="truncate font-medium">{peer.name}</span>
        {startedAt && <Pill>{duration(now - startedAt)}</Pill>}
        {session.transport === 'usb' && (
          <Pill tone="ok">
            <span className="inline-flex items-center gap-1">
              <Usb size={11} /> USB
            </span>
          </Pill>
        )}
        {state.phase === 'reconnecting' && (
          <Pill tone="warn">
            reconectando{state.deadline ? ` · ${Math.max(0, Math.ceil((state.deadline - now) / 1000))} s` : '…'}
          </Pill>
        )}
        {session.reconnects > 0 && state.phase === 'live' && (
          <Pill>
            {session.reconnects} {session.reconnects === 1 ? 'reconexão' : 'reconexões'}
          </Pill>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <QualitySelector mode={session.quality.mode} onChange={session.quality.setMode} applied={session.quality.applied} reason={session.quality.reason} />
          <button onMouseDown={keepFocus} onClick={() => setShowHud((v) => !v)} className={`rounded-md p-1.5 hover:bg-elevated ${showHud ? 'text-accent' : 'text-muted'}`} title="Métricas">
            <Activity size={15} />
          </button>
          <button
            onMouseDown={keepFocus}
            onClick={() => setChatOpen((v) => !v)}
            title="Chat e arquivos"
            className={`relative rounded-md p-1.5 hover:bg-elevated ${chatOpen ? 'text-accent' : 'text-muted'}`}
          >
            <MessageSquare size={15} />
            {!chatOpen && chat.unread > 0 && (
              <span className="absolute -right-0.5 -top-0.5 grid size-4 place-items-center rounded-full bg-accent text-[9px] font-bold text-white">
                {Math.min(chat.unread, 9)}
              </span>
            )}
          </button>
          <button onClick={() => void session.end()} title="Encerrar sessão" className="flex items-center gap-1.5 rounded-md bg-danger/90 px-3 py-1.5 font-medium text-white hover:bg-danger">
            <PhoneOff size={14} /> <span className="hidden lg:inline">Encerrar</span>
          </button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center p-6">
        {showHud && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="absolute left-4 top-4 z-10 flex flex-col items-start gap-1">
            <Pill tone={rttTone}>RTT {stats.rttMs != null ? `${stats.rttMs.toFixed(0)} ms` : '—'}</Pill>
            <Pill>{stats.fps != null ? `${stats.fps.toFixed(0)} fps` : '— fps'}</Pill>
            <Pill>{stats.bitrateKbps != null ? `${(stats.bitrateKbps / 1000).toFixed(2)} Mbps` : '— Mbps'}</Pill>
            {stats.width && <Pill>{`${stats.width}×${stats.height}`}</Pill>}
            {session.quality.applied && (
              <Pill>
                alvo {session.quality.applied.fps} fps · {(session.quality.applied.maxBitrate / 1e6).toFixed(1)} Mbps
              </Pill>
            )}
            {stats.senderBitrate != null && <Pill>banda est. {(stats.senderBitrate / 1e6).toFixed(1)} Mbps</Pill>}
            {stats.qualityLimitation && stats.qualityLimitation !== 'none' && <Pill tone="warn">limitado: {stats.qualityLimitation}</Pill>}
            {stats.jitterBufferMs != null && <Pill>buffer {stats.jitterBufferMs.toFixed(0)} ms</Pill>}
            {stats.packetLossPct != null && stats.packetLossPct > 0.5 && <Pill tone="warn">perda {stats.packetLossPct.toFixed(1)}%</Pill>}
            {stats.relayed && session.transport !== 'usb' && <Pill tone="warn">via TURN</Pill>}
          </motion.div>
        )}

        <div
          ref={stage}
          {...stageProps}
          style={{ outline: 'none' }}
          className="relative flex h-full max-h-full items-center justify-center"
        >
          <video
            ref={video}
            autoPlay
            playsInline
            muted
            {...videoProps}
            onPointerCancel={videoProps.onPointerUp}
            className="h-full max-h-full w-auto max-w-full cursor-crosshair rounded-[22px] border border-line bg-black object-contain shadow-2xl shadow-black/60"
          />
          {state.phase !== 'live' && (
            <div className="absolute inset-0 grid place-items-center">
              <div className="flex items-center gap-2 rounded-lg bg-bg/80 px-3 py-2 text-muted backdrop-blur">
                <Loader2 size={14} className="animate-spin" />
                {state.phase === 'reconnecting'
                  ? `Conexão interrompida, reconectando…${state.deadline ? ` (desiste em ${Math.max(0, Math.ceil((state.deadline - now) / 1000))} s)` : ''}`
                  : 'Estabelecendo conexão segura…'}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex h-14 shrink-0 items-center justify-center gap-2 border-t border-line">
        {[
          { a: 'back' as const, icon: <ArrowLeft size={16} />, label: 'Voltar (Esc / botão direito)' },
          { a: 'home' as const, icon: <Circle size={16} />, label: 'Início (botão do meio)' },
          { a: 'recents' as const, icon: <Square size={14} />, label: 'Recentes' },
          { a: 'notifications' as const, icon: <Bell size={15} />, label: 'Notificações' },
        ].map((b) => (
          <button key={b.a} onMouseDown={keepFocus} onClick={nav(b.a)} title={b.label} className="grid size-9 place-items-center rounded-lg text-muted hover:bg-elevated hover:text-fg">
            {b.icon}
          </button>
        ))}
      </div>
      </div>
      {chatOpen && <ChatPanel chat={chat} peerName={peer.name} connected={live} />}
    </div>
  );
}
