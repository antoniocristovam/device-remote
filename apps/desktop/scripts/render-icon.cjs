// Rasterises build/icon.svg to build/icon.png (1024x1024) using Electron itself, so no image
// tooling is needed. electron-builder derives .icns (macOS) and .ico (Windows) from the PNG.
// Usage (from apps/desktop): npx electron scripts/render-icon.cjs
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const dir = join(__dirname, '..', 'build');
const svg = readFileSync(join(dir, 'icon.svg'), 'utf8');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  win.webContents.setZoomFactor(1);
  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const png = image.resize({ width: 1024, height: 1024, quality: 'best' }).toPNG();
  writeFileSync(join(dir, 'icon.png'), png);
  console.log(`wrote build/icon.png (${png.length} bytes, ${image.getSize().width}x${image.getSize().height} captured)`);
  app.quit();
});
