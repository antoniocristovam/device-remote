import { useCallback, useEffect, useRef, useState } from 'react';
import type { Transport } from '../../../shared/api';
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

/** A session that has a stage to show (video may still be arriving). */
export const isOnStage = (s: SessionPhase) => s.phase === 'connecting' || s.phase === 'live' || s.phase === 'reconnecting';

/**
 * One device's session. Lives in a SessionRunner at the app root (see SessionsProvider), not in a
 * view, so navigating between devices or to the grid never drops a session.
 */
export function useRemoteSession(fingerprint: string) {
  const [state, setState] = useState<SessionPhase>({ phase: 'idle' });
  const [stream, setStream] = useState<MediaStream>();
  const [stats, setStats] = useState<LinkStats>({});
  const [startedAt, setStartedAt] = useState<number>();
  const [reconnects, setReconnects] = useState(0);
  const [transport, setTransport] = useState<Transport>();
  const peer = useRef<PeerSession | undefined>(undefined);
  const sidRef = useRef<string | undefined>(undefined);
  const transportRef = useRef<Transport | undefined>(undefined);
  const quality = useQuality(peer, transportRef);
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
    setTransport(undefined);
    quality.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const off = rc.session.on((e) => {
      if (e.peer !== fingerprint) return;
      switch (e.state) {
        case 'waiting-peer':
          setState({ phase: 'waiting-peer' });
          break;
        case 'requested':
          setState({ phase: 'requested' });
          break;
        case 'accepted': {
          teardown();
          sidRef.current = e.sid;
          setStartedAt(Date.now());
          setTransport(e.transport);
          transportRef.current = e.transport;
          peer.current = new PeerSession(fingerprint, e.iceServers, e.transport, {
            onStream: setStream,
            onStats: (st) => {
              setStats(st);
              qh.current.onStats(st);
            },
            onSessionOpen: () => qh.current.onSessionOpen(),
            onConnection: (s) => {
              const sid = sidRef.current;
              if (!sid) return;
              void rc.session.reportConnection(fingerprint, s);
              if (s === 'connected') setState({ phase: 'live', sid });
              else if (s === 'disconnected' || s === 'failed') setState((prev) => (prev.phase === 'reconnecting' ? prev : { phase: 'reconnecting', sid }));
            },
            onSessionMessage: (m) => {
              if (m.t === 'end') void rc.session.end(fingerprint);
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
      // The runner only unmounts when the device is removed or the window closes.
      void rc.session.end(fingerprint);
      teardown();
    };
  }, [fingerprint, teardown]);

  return {
    fingerprint,
    state,
    stream,
    stats,
    startedAt,
    reconnects,
    transport,
    peer,
    quality,
    connect: () => rc.session.connect(fingerprint),
    end: () => rc.session.end(fingerprint),
  };
}
