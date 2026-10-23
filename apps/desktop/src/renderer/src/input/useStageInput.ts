import { useEffect, useRef } from 'react';
import type { ControlMessage } from '@rc/protocol';
import { rc } from '../rc';
import { addStageEditHandler, type EditCommand } from './editBridge';
import { contentRect, mapKey, normalise } from './inputMapper';

/**
 * Mouse, wheel and keyboard on a phone's video, turned into control messages. Shared by the full
 * device stage and the grid tiles. `send` may change identity between renders; the latest is used.
 * While `enabled` is false (an unfocused grid tile) nothing is sent.
 */
export function useStageInput(send: (m: ControlMessage) => void, enabled = true) {
  const video = useRef<HTMLVideoElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const pointerDown = useRef(false);
  const pendingMove = useRef<ControlMessage | null>(null);
  const textBuf = useRef('');
  const textTimer = useRef<number | undefined>(undefined);
  const wheel = useRef({ dx: 0, dy: 0, x: 0.5, y: 0.5, timer: 0 });
  const sendRef = useRef(send);
  sendRef.current = send;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const out = (m: ControlMessage) => {
    if (enabledRef.current) sendRef.current(m);
  };

  /** Paste goes from this computer's clipboard to the phone; falls back to the phone's own clipboard. */
  const pasteLocal = async () => {
    const text = await rc.app.clipboardText();
    out(text ? { t: 'text', text } : { t: 'edit', key: 'Paste' });
  };

  // macOS menu edit commands arrive here while this phone's stage has focus.
  useEffect(() => {
    const map: Partial<Record<EditCommand, () => void>> = {
      copy: () => out({ t: 'edit', key: 'Copy' }),
      cut: () => out({ t: 'edit', key: 'Cut' }),
      selectAll: () => out({ t: 'edit', key: 'SelectAll' }),
      paste: () => void pasteLocal(),
    };
    return addStageEditHandler((cmd) => {
      if (!stage.current || document.activeElement !== stage.current) return false;
      map[cmd]?.();
      return true;
    });
    // `out` only reads refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Coalesce pointer moves to one per animation frame.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      if (pendingMove.current) {
        out(pendingMove.current);
        pendingMove.current = null;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rect = () => {
    const v = video.current!;
    return contentRect(v.getBoundingClientRect(), v.videoWidth, v.videoHeight);
  };

  const videoProps = {
    onPointerDown: (e: React.PointerEvent) => {
      stage.current?.focus();
      if (!enabledRef.current) return;
      if (e.button === 2) return out({ t: 'global', action: 'back' });
      if (e.button === 1) return out({ t: 'global', action: 'home' });
      if (e.button !== 0) return;
      const p = normalise(rect(), e.clientX, e.clientY);
      if (!p) return;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      pointerDown.current = true;
      out({ t: 'pd', id: 0, ...p, ts: e.timeStamp });
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!pointerDown.current) return;
      const p = normalise(rect(), e.clientX, e.clientY, true)!;
      pendingMove.current = { t: 'pm', id: 0, ...p, ts: e.timeStamp };
    },
    onPointerUp: (e: React.PointerEvent) => {
      if (!pointerDown.current) return;
      pointerDown.current = false;
      pendingMove.current = null;
      const p = normalise(rect(), e.clientX, e.clientY, true)!;
      out({ t: 'pu', id: 0, ...p, ts: e.timeStamp });
    },
    onWheel: (e: React.WheelEvent) => {
      if (!enabledRef.current) return;
      const r = rect();
      const p = normalise(r, e.clientX, e.clientY);
      if (!p) return;
      const w = wheel.current;
      w.dx += e.deltaX / r.width;
      w.dy += e.deltaY / r.height;
      w.x = p.x;
      w.y = p.y;
      if (w.timer) return;
      w.timer = window.setTimeout(() => {
        out({ t: 'scroll', x: w.x, y: w.y, dx: Math.max(-0.8, Math.min(0.8, w.dx)), dy: Math.max(-0.8, Math.min(0.8, w.dy)) });
        w.dx = w.dy = 0;
        w.timer = 0;
      }, 60);
    },
  };
  const stageProps = {
    tabIndex: 0,
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (!enabledRef.current) return;
      const m = mapKey(e.nativeEvent);
      if (!m) return;
      e.preventDefault();
      if (m.t === 'edit' && m.key === 'Paste') {
        void pasteLocal();
        return;
      }
      if (m.t === 'text') {
        // Batch fast typing into one text injection.
        textBuf.current += m.text;
        window.clearTimeout(textTimer.current);
        textTimer.current = window.setTimeout(() => {
          out({ t: 'text', text: textBuf.current });
          textBuf.current = '';
        }, 40);
        return;
      }
      out(m);
    },
  };

  return { video, stage, videoProps, stageProps, send: out };
}
