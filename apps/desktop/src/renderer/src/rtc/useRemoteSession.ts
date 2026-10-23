import { useCallback, useEffect, useRef, useState } from 'react';
import { rc } from '../rc';
import { PeerSession, type LinkStats } from './PeerSession';
import { useQuality } from './useQuality';

export type SessionPhase =
  | { phase: 'idle' }
  | { phase: 'waiting-peer' }
  | { phase: 'requested' }
  | { phase: 'connecting'; sid: string }
  | { phase: 'live'; sid: string }
  | { phase: 'reconnecting'; sid: string; deadline?: number }
  | { phase: 'ended'; reason: string };

const END_REASONS: Record<string, string> = {
  user: 'Sessão encerrada.',
  revoked: 'O acesso foi revogado no celular.',
  denied: 'A solicitação foi recusada no celular.',
  timeout: 'O celular não respondeu à solicitação.',
  expired: 'A sessão expirou ou o app foi reiniciado no celular.',
  error: 'A sessão foi encerrada por um erro.',
  lost: 'A conexão caiu e não pôde ser restabelecida a tempo.',
  'verification-failed': 'Falha na verificação de identidade do celular.',
};
export const endReasonText = (r: string) => END_REASONS[r] ?? `Sessão encerrada (${r}).`;

export function useRemoteSession(fingerprint: string) {
  const [state, setState] = useState<SessionPhase>({ phase: 'idle' });
  const [stream, setStream] = useState<MediaStream>();
  const [stats, setStats] = useState<LinkStats>({});
  const [startedAt, setStartedAt] = useState<number>();
  const [reconnects, setReconnects] = useState(0);
  const peer = useRef<PeerSession | undefined>(undefined);
  const sidRef = useRef<string | undefined>(undefined);
  const quality = useQuality(peer);
  // PeerSession callbacks are fixed at construction; reach the latest handlers through a ref.
  const qh = useRef(quality.handlers);
  qh.current = quality.handlers;

  const teardown = useCallback(() => {
    peer.current?.close();
    peer.current = undefined;
    sidRef.current = undefined;
    setStream(undefined);
    setStats({});
    setStartedAt(undefined);
    setReconnects(0);
    quality.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const off = rc.session.on((e) => {
      switch (e.state) {
        case 'waiting-peer':
          if (e.peer === fingerprint) setState({ phase: 'waiting-peer' });
          break;
        case 'requested':
          if (e.peer === fingerprint) setState({ phase: 'requested' });
          break;
        case 'accepted': {
          if (e.peer !== fingerprint) break;
          teardown();
          sidRef.current = e.sid;
          setStartedAt(Date.now());
          peer.current = new PeerSession(e.iceServers, {
            onStream: setStream,
            onStats: (st) => {
              setStats(st);
              qh.current.onStats(st);
            },
            onSessionOpen: () => qh.current.onSessionOpen(),
            onConnection: (s) => {
              const sid = sidRef.current;
              if (!sid) return;
              void rc.session.reportConnection(s);
              if (s === 'connected') setState({ phase: 'live', sid });
              else if (s === 'disconnected' || s === 'failed') setState((prev) => (prev.phase === 'reconnecting' ? prev : { phase: 'reconnecting', sid }));
            },
            onSessionMessage: (m) => {
              if (m.t === 'end') void rc.session.end();
              qh.current.onMessage(m);
            },
          });
          setState({ phase: 'connecting', sid: e.sid });
          break;
        }
        case 'offer':
          void peer.current?.handleOffer(e.sdp);
          break;
        case 'ice':
          void peer.current?.addIce(e);
          break;
        case 'reconnecting':
          if (sidRef.current) setState({ phase: 'reconnecting', sid: sidRef.current, deadline: e.deadline });
          break;
        case 'reconnected':
          setReconnects(e.reconnects);
          break;
        case 'denied':
          break;
        case 'ended':
          teardown();
          setState({ phase: 'ended', reason: e.reason });
          break;
      }
    });
    return () => {
      off();
      // Leaving the device view ends any pending or live session (no-op when idle).
      void rc.session.end();
      teardown();
    };
  }, [fingerprint, teardown]);

  return {
    state,
    stream,
    stats,
    startedAt,
    reconnects,
    peer,
    quality,
    connect: () => rc.session.connect(fingerprint),
    end: () => rc.session.end(),
  };
}
