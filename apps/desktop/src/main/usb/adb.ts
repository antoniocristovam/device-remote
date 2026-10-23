import { app } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';

export interface AdbDevice {
  serial: string;
  /** adb state: "device" (ready), "unauthorized" (USB debugging prompt not accepted), "offline"… */
  state: string;
  model?: string;
}

function run(bin: string, args: string[], timeout = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/**
 * Finds an adb binary. A system adb comes first (PATH, then the Android SDK): starting a different
 * version would kill the adb server Android Studio or the user is already running. The copy bundled
 * with the app is the fallback.
 */
export async function findAdb(): Promise<string | undefined> {
  const candidates = ['adb'];
  for (const root of [process.env['ANDROID_HOME'], process.env['ANDROID_SDK_ROOT']]) {
    if (root) candidates.push(join(root, 'platform-tools', exe));
  }
  if (process.platform === 'win32' && process.env['LOCALAPPDATA']) candidates.push(join(process.env['LOCALAPPDATA'], 'Android', 'Sdk', 'platform-tools', exe));
  if (process.platform === 'darwin' && process.env['HOME']) candidates.push(join(process.env['HOME'], 'Library', 'Android', 'sdk', 'platform-tools', exe));
  candidates.push(
    app.isPackaged
      ? join(process.resourcesPath, 'adb', exe)
      : join(app.getAppPath(), 'resources', 'adb', process.platform === 'win32' ? 'win' : 'mac', exe),
  );
  for (const c of candidates) {
    if (c !== 'adb' && !existsSync(c)) continue;
    try {
      await run(c, ['version'], 5_000);
      return c;
    } catch {
      /* try the next one */
    }
  }
  return undefined;
}

export class Adb {
  constructor(readonly bin: string) {}

  async devices(): Promise<AdbDevice[]> {
    const out = await run(this.bin, ['devices', '-l']);
    return out
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [serial = '', state = '', ...rest] = l.split(/\s+/);
        const model = rest.find((r) => r.startsWith('model:'))?.slice(6).replace(/_/g, ' ');
        return { serial, state, model };
      })
      .filter((d) => d.serial && !d.serial.startsWith('*'));
  }

  /** Makes `localhost:<remote>` on the phone reach `127.0.0.1:<local>` on this computer. */
  reverse(serial: string, remote: number, local: number) {
    return run(this.bin, ['-s', serial, 'reverse', `tcp:${remote}`, `tcp:${local}`]);
  }
}
