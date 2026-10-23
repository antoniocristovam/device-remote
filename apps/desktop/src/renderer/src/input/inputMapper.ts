import type { ControlMessage, EditKey } from '@rc/protocol';

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Rectangle actually covered by the picture of an `object-fit: contain` video inside `box`. */
export function contentRect(box: Rect, videoW: number, videoH: number): Rect {
  if (!videoW || !videoH) return box;
  const scale = Math.min(box.width / videoW, box.height / videoH);
  const width = videoW * scale;
  const height = videoH * scale;
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
}

/** Client coordinates -> normalised [0,1] device coordinates, or null when outside the picture. */
export function normalise(r: Rect, clientX: number, clientY: number, clamp = false): { x: number; y: number } | null {
  let x = (clientX - r.left) / r.width;
  let y = (clientY - r.top) / r.height;
  if (clamp) {
    x = Math.min(1, Math.max(0, x));
    y = Math.min(1, Math.max(0, y));
  } else if (x < 0 || x > 1 || y < 0 || y > 1) {
    return null;
  }
  return { x, y };
}

const EDIT_KEYS: Record<string, EditKey> = { Backspace: 'Backspace', Enter: 'Enter', Delete: 'Delete' };
const CTRL_KEYS: Record<string, EditKey> = { a: 'SelectAll', c: 'Copy', v: 'Paste', x: 'Cut' };

/**
 * Maps a keyboard event to a control message. Printable characters are returned as `text` so the
 * caller can batch them; Esc acts as Android "back".
 */
export function mapKey(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): ControlMessage | null {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey) {
    const k = CTRL_KEYS[e.key.toLowerCase()];
    return k ? { t: 'edit', key: k } : null;
  }
  if (e.key === 'Escape') return { t: 'global', action: 'back' };
  const edit = EDIT_KEYS[e.key];
  if (edit) return { t: 'edit', key: edit };
  // Any single produced character is text, whatever modifiers made it: Option on macOS
  // (Option+C = "ç") and AltGr on Windows (reported as Ctrl+Alt, e.g. "@" or "/") compose characters.
  if ([...e.key].length === 1) return { t: 'text', text: e.key };
  return null;
}
