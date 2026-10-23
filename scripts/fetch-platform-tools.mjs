#!/usr/bin/env node
// Downloads Google's official Android platform-tools and keeps only what the desktop app ships:
// adb (plus its two DLLs on Windows) and the license notice, in apps/desktop/resources/adb/<win|mac>/.
// electron-builder copies that folder into the app as resources/adb (see electron-builder.yml).
//
//   node scripts/fetch-platform-tools.mjs [win|mac]     (default: this computer's platform)
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const target = process.argv[2] ?? (process.platform === 'win32' ? 'win' : 'mac');
const spec = {
  win: { zip: 'windows', files: ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll', 'NOTICE.txt'] },
  mac: { zip: 'darwin', files: ['adb', 'NOTICE.txt'] },
}[target];
if (!spec) {
  console.error(`unknown target "${target}" (use win or mac)`);
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'apps', 'desktop', 'resources', 'adb', target);
if (spec.files.every((f) => existsSync(join(out, f)))) {
  console.log(`platform-tools already in ${out}`);
  process.exit(0);
}

const url = `https://dl.google.com/android/repository/platform-tools-latest-${spec.zip}.zip`;
const work = mkdtempSync(join(tmpdir(), 'rc-platform-tools-'));
try {
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const zip = join(work, 'platform-tools.zip');
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  // bsdtar reads zip files on both Windows 10+ and macOS. On Windows, call the system one by path:
  // a GNU tar from Git Bash may come first on PATH and takes "C:" for a remote host.
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xf', zip, '-C', work], { stdio: 'inherit' });
  mkdirSync(out, { recursive: true });
  for (const f of spec.files) copyFileSync(join(work, 'platform-tools', f), join(out, f));
  if (target === 'mac' && process.platform !== 'win32') execFileSync('chmod', ['+x', join(out, 'adb')]);
  console.log(`platform-tools (${spec.files.join(', ')}) -> ${out}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
