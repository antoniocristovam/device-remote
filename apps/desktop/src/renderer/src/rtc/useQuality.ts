import { useCallback, useEffect, useRef, useState } from 'react';
import type { QualityMode, QualityPreset, SessionChannelMessage } from '@rc/protocol';
import { rc } from '../rc';
import type { LinkStats, PeerSession } from './PeerSession';
import { QualityController } from './qualityController';

export type AppliedQuality = Extract<SessionChannelMessage, { t: 'quality-applied' }>;

const AUTO_START: QualityPreset = 'medium';

/**
 * Quality selection for a session: a fixed preset, or "auto" driven by QualityController from
 * the per-second link stats. The phone applies presets and confirms with quality-applied.
 */
export function useQuality(peer: React.RefObject<PeerSession | undefined>) {
  const [mode, setModeState] = useState<QualityMode>('auto');
  const [applied, setApplied] = useState<AppliedQuality>();
  const [reason, setReason] = useState<string>();
  const modeRef = useRef<QualityMode>('auto');
  const controller = useRef<QualityController>(undefined);

  useEffect(() => {
    void rc.settings.get().then((s) => {
      if (s.quality) {
        modeRef.current = s.quality;
        setModeState(s.quality);
      }
    });
  }, []);

  const send = useCallback((preset: QualityPreset) => peer.current?.sendSession({ t: 'quality', preset }), [peer]);

  /** (Re)starts from the current mode: called when the session channel opens and on mode change. */
  const apply = useCallback(() => {
    const m = modeRef.current;
    if (m === 'auto') {
      controller.current = new QualityController(AUTO_START);
      setReason('início');
      send(AUTO_START);
    } else {
      controller.current = undefined;
      setReason(undefined);
      send(m);
    }
  }, [send]);

  const setMode = useCallback(
    (m: QualityMode) => {
      modeRef.current = m;
      setModeState(m);
      void rc.settings.set({ quality: m });
      apply();
    },
    [apply],
  );

  const onStats = useCallback(
    (s: LinkStats) => {
      const c = controller.current;
      if (!c) return;
      const d = c.tick({
        lossPct: s.packetLossPct,
        rttMs: s.rttMs,
        jitterBufferMs: s.jitterBufferMs,
        availableBitrate: s.senderBitrate,
        qualityLimitation: s.qualityLimitation,
      });
      if (d) {
        setReason(d.reason);
        send(d.preset);
      }
    },
    [send],
  );

  const onMessage = useCallback((m: SessionChannelMessage) => {
    if (m.t === 'quality-applied') setApplied(m);
  }, []);

  const reset = useCallback(() => {
    controller.current = undefined;
    setApplied(undefined);
    setReason(undefined);
  }, []);

  return { mode, setMode, applied, reason, handlers: { onSessionOpen: apply, onStats, onMessage }, reset };
}
