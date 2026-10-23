import { describe, expect, it } from 'vitest';
import { contentRect, mapKey, normalise } from '../src/renderer/src/input/inputMapper';

describe('inputMapper', () => {
  it('accounts for letterboxing of a portrait stream in a wide box', () => {
    const r = contentRect({ left: 0, top: 0, width: 1000, height: 500 }, 1080, 2400);
    expect(r.height).toBe(500);
    expect(r.width).toBeCloseTo(225);
    expect(r.left).toBeCloseTo(387.5);
    expect(normalise(r, r.left + r.width / 2, 250)).toEqual({ x: 0.5, y: 0.5 });
    expect(normalise(r, 10, 250)).toBeNull();
    expect(normalise(r, 10, 250, true)).toEqual({ x: 0, y: 0.5 });
  });

  it('maps keys to control messages', () => {
    const k = (key: string, mods: Partial<KeyboardEvent> = {}) => mapKey({ key, ctrlKey: false, metaKey: false, altKey: false, ...mods });
    expect(k('a')).toEqual({ t: 'text', text: 'a' });
    expect(k('Escape')).toEqual({ t: 'global', action: 'back' });
    expect(k('Backspace')).toEqual({ t: 'edit', key: 'Backspace' });
    expect(k('v', { ctrlKey: true })).toEqual({ t: 'edit', key: 'Paste' });
    expect(k('F5')).toBeNull();
    expect(k('v', { metaKey: true })).toEqual({ t: 'edit', key: 'Paste' }); // Cmd+V on macOS
  });

  it('keeps characters composed with Option (macOS) or AltGr (Windows)', () => {
    const k = (key: string, mods: Partial<KeyboardEvent> = {}) => mapKey({ key, ctrlKey: false, metaKey: false, altKey: false, ...mods });
    expect(k('ç', { altKey: true })).toEqual({ t: 'text', text: 'ç' });
    expect(k('@', { ctrlKey: true, altKey: true })).toEqual({ t: 'text', text: '@' });
    expect(k('😀')).toEqual({ t: 'text', text: '😀' });
    expect(k('Dead')).toBeNull();
  });
});
