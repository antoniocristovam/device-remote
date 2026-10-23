import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { RcApi } from '../shared/api';

const subscribe =
  <T>(channel: string) =>
  (cb: (e: T) => void) => {
    const fn = (_: IpcRendererEvent, e: T) => cb(e);
    ipcRenderer.on(channel, fn);
    return () => void ipcRenderer.off(channel, fn);
  };

const api: RcApi = {
  identity: () => ipcRenderer.invoke('rc:identity'),
  settings: {
    get: () => ipcRenderer.invoke('rc:settings:get'),
    set: (s) => ipcRenderer.invoke('rc:settings:set', s),
  },
  signaling: {
    status: () => ipcRenderer.invoke('rc:signaling:status'),
    onStatus: subscribe('rc:signaling-status'),
  },
  usb: {
    status: () => ipcRenderer.invoke('rc:usb:status'),
    onStatus: subscribe('rc:usb'),
  },
  peers: {
    list: () => ipcRenderer.invoke('rc:peers:list'),
    remove: (fp) => ipcRenderer.invoke('rc:peers:remove', fp),
  },
  history: () => ipcRenderer.invoke('rc:history'),
  app: {
    platform: () => ipcRenderer.invoke('rc:app:platform'),
    clipboardText: () => ipcRenderer.invoke('rc:app:clipboard'),
    nativeEdit: (cmd) => ipcRenderer.invoke('rc:app:native-edit', cmd),
    onEditCommand: subscribe('rc:edit-command'),
    onNavigate: subscribe('rc:navigate'),
  },
  chat: {
    list: (fp) => ipcRenderer.invoke('rc:chat:list', fp),
    put: (fp, entry) => ipcRenderer.invoke('rc:chat:put', fp, entry),
    delivered: (fp, id) => ipcRenderer.invoke('rc:chat:delivered', fp, id),
  },
  files: {
    pathFor: (file) => webUtils.getPathForFile(file),
    hash: (path) => ipcRenderer.invoke('rc:files:hash', path),
    begin: (id, name, size) => ipcRenderer.invoke('rc:files:begin', id, name, size),
    chunk: (id, data) => ipcRenderer.send('rc:files:chunk', id, data),
    finish: (id, sha256) => ipcRenderer.invoke('rc:files:finish', id, sha256),
    abort: (id) => ipcRenderer.invoke('rc:files:abort', id),
    reveal: (path) => ipcRenderer.invoke('rc:files:reveal', path),
    openDir: () => ipcRenderer.invoke('rc:files:openDir'),
  },
  pairing: {
    start: () => ipcRenderer.invoke('rc:pairing:start'),
    cancel: () => ipcRenderer.invoke('rc:pairing:cancel'),
    on: subscribe('rc:pairing'),
  },
  session: {
    connect: (fp) => ipcRenderer.invoke('rc:session:connect', fp),
    end: (fp) => ipcRenderer.invoke('rc:session:end', fp),
    sendAnswer: (fp, sdp) => ipcRenderer.invoke('rc:session:answer', fp, sdp),
    sendIce: (fp, c) => ipcRenderer.invoke('rc:session:ice', fp, c),
    reportConnection: (fp, state) => ipcRenderer.invoke('rc:session:connection', fp, state),
    on: subscribe('rc:session'),
  },
};

contextBridge.exposeInMainWorld('rc', api);
