import { app, Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';

export const EDIT_COMMANDS = ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'] as const;
export type EditCommand = (typeof EDIT_COMMANDS)[number];

/**
 * Application menu. macOS needs one: without an Edit menu, Cmd+C/V/X/A/Z do nothing anywhere.
 *
 * Edit items do not use Electron's built-in roles. A menu accelerator consumes the keystroke before
 * the page sees it, so Cmd+V over the phone screen would never reach the phone. Instead the
 * renderer decides: the remote stage forwards the command to the phone, anything else (chat
 * composer, settings fields) gets the native edit action back through rc:native-edit.
 *
 * Windows has no visible menu (custom title bar); Chromium handles Ctrl+C/V in fields and the
 * stage receives the keydown itself.
 */
export function installMenu(getWindow: () => BrowserWindow | null) {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  const send = (channel: string, payload: unknown) => getWindow()?.webContents.send(channel, payload);
  const edit = (label: string, accelerator: string, cmd: EditCommand): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => send('rc:edit-command', cmd),
  });
  const dev = !app.isPackaged;

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: `Sobre o ${app.name}` },
        { type: 'separator' },
        { label: 'Ajustes…', accelerator: 'Cmd+,', click: () => send('rc:navigate', 'settings') },
        { type: 'separator' },
        { role: 'services', label: 'Serviços' },
        { type: 'separator' },
        { role: 'hide', label: `Ocultar ${app.name}` },
        { role: 'hideOthers', label: 'Ocultar outros' },
        { role: 'unhide', label: 'Mostrar tudo' },
        { type: 'separator' },
        { role: 'quit', label: `Sair do ${app.name}` },
      ],
    },
    {
      label: 'Editar',
      submenu: [
        edit('Desfazer', 'Cmd+Z', 'undo'),
        edit('Refazer', 'Shift+Cmd+Z', 'redo'),
        { type: 'separator' },
        edit('Recortar', 'Cmd+X', 'cut'),
        edit('Copiar', 'Cmd+C', 'copy'),
        edit('Colar', 'Cmd+V', 'paste'),
        edit('Selecionar tudo', 'Cmd+A', 'selectAll'),
      ],
    },
    {
      label: 'Visualizar',
      submenu: [
        { label: 'Histórico de sessões', accelerator: 'Cmd+Y', click: () => send('rc:navigate', 'history') },
        { label: 'Parear dispositivo', accelerator: 'Cmd+N', click: () => send('rc:navigate', 'pair') },
        { type: 'separator' },
        ...(dev ? ([{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }] as MenuItemConstructorOptions[]) : []),
        { role: 'togglefullscreen', label: 'Tela cheia' },
      ],
    },
    {
      role: 'window',
      label: 'Janela',
      submenu: [{ role: 'minimize', label: 'Minimizar' }, { role: 'zoom', label: 'Zoom' }, { type: 'separator' }, { role: 'front', label: 'Trazer tudo para a frente' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
