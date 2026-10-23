import { describe, expect, it } from 'vitest';
import { ChatFrame, FileFrame, safeFileName } from '../src/index.js';

describe('safeFileName', () => {
  it('strips directories, reserved characters and device names', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('C:\\Windows\\evil.exe')).toBe('evil.exe');
    expect(safeFileName('a<b>c:d"e|f?g*h.txt')).toBe('a_b_c_d_e_f_g_h.txt');
    expect(safeFileName('CON.txt')).toBe('_CON.txt');
    expect(safeFileName('...hidden')).toBe('hidden');
    expect(safeFileName('foto ção.jpg')).toBe('foto ção.jpg');
    expect(safeFileName('')).toBe('arquivo');
  });
});

describe('frames', () => {
  it('validates chat and file frames', () => {
    expect(ChatFrame.safeParse({ t: 'msg', id: 'x', text: 'oi', ts: 1 }).success).toBe(true);
    expect(ChatFrame.safeParse({ t: 'msg', id: 'x', text: '', ts: 1 }).success).toBe(false);
    const id = 'a'.repeat(32);
    expect(FileFrame.safeParse({ t: 'offer', id, name: 'a.txt', size: 3, mime: 'text/plain' }).success).toBe(true);
    expect(FileFrame.safeParse({ t: 'offer', id, name: 'a.txt', size: 3 * 1024 ** 3, mime: '' }).success).toBe(false);
    expect(FileFrame.safeParse({ t: 'done', id, sha256: 'zz' }).success).toBe(false);
  });
});
