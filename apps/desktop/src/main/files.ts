import { app } from 'electron';
import { createHash, type Hash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync, type WriteStream } from 'node:fs';
import { extname, basename, join } from 'node:path';
import { safeFileName } from '@rc/protocol';

interface Incoming {
  part: string;
  name: string;
  size: number;
  received: number;
  out: WriteStream;
  hash: Hash;
}

/**
 * Disk side of file transfers. Incoming files are written to Downloads/Remote Controller as
 * "<name>.part", hashed while streaming, and only renamed into place once the SHA-256 the sender
 * announced matches. Nothing received is ever opened or executed automatically.
 */
export class FileStore {
  private incoming = new Map<string, Incoming>();

  dir() {
    const d = join(app.getPath('downloads'), 'Remote Controller');
    mkdirSync(d, { recursive: true });
    return d;
  }

  private uniquePath(name: string) {
    const dir = this.dir();
    const ext = extname(name);
    const stem = basename(name, ext);
    let candidate = join(dir, name);
    for (let i = 1; existsSync(candidate) || existsSync(candidate + '.part'); i++) candidate = join(dir, `${stem} (${i})${ext}`);
    return candidate;
  }

  begin(id: string, name: string, size: number) {
    this.abort(id);
    const target = this.uniquePath(safeFileName(name));
    const part = target + '.part';
    this.incoming.set(id, { part, name: target, size, received: 0, out: createWriteStream(part), hash: createHash('sha256') });
  }

  chunk(id: string, data: Uint8Array): boolean {
    const f = this.incoming.get(id);
    if (!f) return false;
    f.received += data.byteLength;
    if (f.received > f.size) {
      this.abort(id);
      return false;
    }
    f.hash.update(data);
    f.out.write(data);
    return true;
  }

  async finish(id: string, sha256: string): Promise<{ ok: boolean; path?: string }> {
    const f = this.incoming.get(id);
    if (!f) return { ok: false };
    this.incoming.delete(id);
    await new Promise<void>((r) => f.out.end(() => r()));
    const ok = f.received === f.size && f.hash.digest('hex') === sha256;
    if (!ok) {
      unlinkSync(f.part);
      return { ok: false };
    }
    renameSync(f.part, f.name);
    return { ok: true, path: f.name };
  }

  abort(id: string) {
    const f = this.incoming.get(id);
    if (!f) return;
    this.incoming.delete(id);
    f.out.destroy();
    try {
      unlinkSync(f.part);
    } catch {
      /* already gone */
    }
  }

  /** SHA-256 of a local file the user chose to send (WebCrypto cannot hash incrementally). */
  hash(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const h = createHash('sha256');
      createReadStream(path)
        .on('data', (d) => h.update(d))
        .on('end', () => resolve(h.digest('hex')))
        .on('error', reject);
    });
  }
}
