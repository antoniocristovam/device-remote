import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { loadIdentity } from './identity';
import { PairingController } from './pairing';
import { SessionManager } from './session';
import { SignalingClient } from './signalingClient';
import { createStores, type ChatEntry, type Settings } from './store';
import { FileStore } from './files';
import { EDIT_COMMANDS, installMenu, type EditCommand } from './menu';
import { PHONE_SIGNALING_PORT, PHONE_TURN_PORT, startLocalLink } from './usb/localLink';
import { UsbBridge } from './usb/usbBridge';

// Remote control favours latency over smoothness: show each frame as soon as it is decoded instead
// of holding ~200 ms in the jitter buffer (Chromium's zero playout delay mode, used for cloud gaming).
app.commandLine.appendSwitch('force-fieldtrials', 'WebRTC-ForcePlayoutDelay/min_ms:0,max_ms:0/');

let win: BrowserWindow | null = null;
/** Called when the window goes away: a session must never outlive the UI that shows it. */
let onWindowClosed: () => void = () => {};

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#09090b',
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 14, y: 14 } }
      : { titleBarOverlay: { color: '#09090b', symbolColor: '#a1a1aa', height: 40 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win?.show());
  // On macOS closing the window keeps the app running (dock); end any session it was showing.
  win.on('closed', () => {
    win = null;
    onWindowClosed();
  });

  // The renderer is a local app: no navigation, no popups (external links open in the browser).
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env['ELECTRON_RENDERER_URL']) void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
}

const send = (channel: string, payload: unknown) => win?.webContents.send(channel, payload);

app.whenReady().then(async () => {
  // Nothing in this app needs camera/mic/geolocation/etc.
  app.on('web-contents-created', (_e, wc) => wc.session.setPermissionRequestHandler((_wc, _p, cb) => cb(false)));

  const stores = createStores();
  const files = new FileStore();
  let identity;
  try {
    identity = await loadIdentity();
  } catch (e) {
    dialog.showErrorBox('Remote Controller', String(e instanceof Error ? e.message : e));
    app.quit();
    return;
  }

  installMenu(() => win);
  const signaling = new SignalingClient(stores.settings.get().signalingUrl);
  const pairing = new PairingController(identity, signaling, stores, (e) => send('rc:pairing', e));
  // USB: phones plugged in reach a loopback signaling server and TURN relay through adb reverse.
  const local = await startLocalLink().catch((e: unknown) => {
    console.warn('[usb] local link unavailable:', e);
    return undefined;
  });
  const signalingUsb = local ? new SignalingClient(`ws://127.0.0.1:${local.signalingPort}`) : undefined;
  const usb = new UsbBridge(local ? { [PHONE_SIGNALING_PORT]: local.signalingPort, [PHONE_TURN_PORT]: local.turnPort } : {});
  const sessions = new SessionManager(
    identity,
    { network: signaling, usb: signalingUsb && local ? { sig: signalingUsb, turnUrl: () => local.desktopTurnUrl } : undefined },
    stores,
    (e) => send('rc:session', e),
  );
  signaling.on('status', (s) => send('rc:signaling-status', s));
  signaling.start();
  signalingUsb?.start();
  usb.on('status', (s) => send('rc:usb', s));
  if (local) void usb.start();
  else usb.status = { adb: 'missing', devices: [] };

  ipcMain.handle('rc:identity', () => ({
    name: stores.settings.get().deviceName || identity.name,
    fingerprint: identity.fingerprint,
  }));
  ipcMain.handle('rc:settings:get', () => stores.settings.get());
  ipcMain.handle('rc:settings:set', (_e, patch: Record<string, unknown>) => {
    const prev = stores.settings.get();
    const next = {
      ...prev,
      ...(typeof patch['signalingUrl'] === 'string' ? { signalingUrl: patch['signalingUrl'] } : {}),
      ...(typeof patch['deviceName'] === 'string' ? { deviceName: patch['deviceName'].slice(0, 64) } : {}),
      ...(['auto', 'high', 'medium', 'low'].includes(patch['quality'] as string) ? { quality: patch['quality'] as Settings['quality'] } : {}),
    };
    stores.settings.set(next);
    if (next.signalingUrl !== prev.signalingUrl) signaling.setUrl(next.signalingUrl);
    return next;
  });
  ipcMain.handle('rc:signaling:status', () => signaling.status);
  ipcMain.handle('rc:usb:status', () => usb.status);
  ipcMain.handle('rc:peers:list', () => stores.peers.list());
  ipcMain.handle('rc:peers:remove', (_e, fp: string) => {
    sessions.end(String(fp), 'user');
    stores.peers.remove(fp);
    stores.chats.clear(fp);
  });
  ipcMain.handle('rc:chat:list', (_e, fp: string) => stores.chats.list(String(fp)));
  ipcMain.handle('rc:chat:put', (_e, fp: string, entry: ChatEntry) => stores.chats.put(String(fp), entry));
  ipcMain.handle('rc:chat:delivered', (_e, fp: string, id: string) => stores.chats.markDelivered(String(fp), String(id)));
  ipcMain.handle('rc:files:begin', (_e, id: string, name: string, size: number) => files.begin(String(id), String(name), Number(size)));
  // Chunks are fire-and-forget (ordered with the invoke that finishes the transfer).
  ipcMain.on('rc:files:chunk', (_e, id: string, data: Uint8Array) => files.chunk(String(id), data));
  ipcMain.handle('rc:files:finish', (_e, id: string, sha256: string) => files.finish(String(id), String(sha256)));
  ipcMain.handle('rc:files:abort', (_e, id: string) => files.abort(String(id)));
  ipcMain.handle('rc:files:hash', (_e, path: string) => files.hash(String(path)));
  ipcMain.handle('rc:files:reveal', (_e, path: string) => {
    // Only reveal files inside our own download folder.
    if (String(path).startsWith(files.dir())) shell.showItemInFolder(String(path));
  });
  ipcMain.handle('rc:files:openDir', () => shell.openPath(files.dir()));
  ipcMain.handle('rc:app:platform', () => process.platform);
  // Local clipboard text, so Cmd/Ctrl+V on the stage pastes from this computer into the phone.
  ipcMain.handle('rc:app:clipboard', async () => (await clipboard.readText()).slice(0, 4096));
  ipcMain.handle('rc:app:native-edit', (e, cmd: string) => {
    if ((EDIT_COMMANDS as readonly string[]).includes(cmd)) e.sender[cmd as EditCommand]();
  });
  onWindowClosed = () => {
    sessions.endAll();
    pairing.cancel();
  };
  ipcMain.handle('rc:history', () => stores.sessions.list());
  ipcMain.handle('rc:pairing:start', () => pairing.start());
  ipcMain.handle('rc:pairing:cancel', () => pairing.cancel());
  ipcMain.handle('rc:session:connect', (_e, fp: string) => sessions.connect(String(fp)));
  ipcMain.handle('rc:session:end', (_e, fp: string) => sessions.end(String(fp), 'user'));
  ipcMain.handle('rc:session:answer', (_e, fp: string, sdp: string) => sessions.get(String(fp))?.sendAnswer(String(sdp)));
  ipcMain.handle('rc:session:ice', (_e, fp: string, c) => sessions.get(String(fp))?.sendIce(c));
  ipcMain.handle('rc:session:connection', (_e, fp: string, state: string) => sessions.get(String(fp))?.reportConnection(String(state)));

  app.on('before-quit', () => {
    sessions.endAll();
    signaling.stop();
    signalingUsb?.stop();
    usb.stop();
    void local?.close();
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
