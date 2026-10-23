import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { rc } from './rc';
import type { SignalingStatus, StoredPeer, UsbStatus } from '../../shared/api';
import { Sidebar, type View } from './components/Sidebar';
import { TitleBar } from './components/TitleBar';
import { PairingView } from './views/PairingView';
import { DeviceView } from './views/DeviceView';
import { HistoryView } from './views/HistoryView';
import { SettingsView } from './views/SettingsView';
import { installEditRouting } from './input/editBridge';
import { GridView } from './views/GridView';
import { SessionsProvider } from './rtc/SessionsProvider';

export function App() {
  const [view, setView] = useState<View>({ kind: 'pair' });
  const [peers, setPeers] = useState<StoredPeer[]>([]);
  const [status, setStatus] = useState<SignalingStatus>('connecting');
  const [identity, setIdentity] = useState<{ name: string; fingerprint: string }>();
  const [usb, setUsb] = useState<UsbStatus>({ adb: 'starting', devices: [] });

  const refreshPeers = useCallback(async () => {
    const list = await rc.peers.list();
    setPeers(list);
    return list;
  }, []);

  useEffect(() => {
    void rc.identity().then(setIdentity);
    void rc.signaling.status().then(setStatus);
    void rc.usb.status().then(setUsb);
    const offUsb = rc.usb.onStatus(setUsb);
    void refreshPeers().then((list) => {
      // Several phones: open on the grid so all of them are in view.
      if (list.length > 1) setView({ kind: 'grid' });
      else if (list[0]) setView({ kind: 'device', fingerprint: list[0].fingerprint });
    });
    const offStatus = rc.signaling.onStatus(setStatus);
    const offEdit = installEditRouting();
    // macOS menu shortcuts (Cmd+, / Cmd+Y / Cmd+N).
    const offNav = rc.app.onNavigate((v) => setView({ kind: v }));
    return () => {
      offStatus();
      offUsb();
      offEdit();
      offNav();
    };
  }, [refreshPeers]);

  // A phone on the USB cable can be reached without the signaling server.
  const canConnect = status === 'online' || usb.devices.some((d) => d.state === 'device');
  const selected = view.kind === 'device' ? peers.find((p) => p.fingerprint === view.fingerprint) : undefined;

  return (
    <SessionsProvider peers={peers}>
      <div className="flex h-full flex-col">
        <TitleBar status={status} />
        <div className="flex min-h-0 flex-1">
          <Sidebar view={view} onNavigate={setView} peers={peers} identity={identity} usb={usb} />
          <main className="relative min-w-0 flex-1 overflow-hidden border-l border-line bg-panel">
            <AnimatePresence mode="wait">
              <motion.div
                key={view.kind === 'device' ? `device-${view.fingerprint}` : view.kind}
                className="h-full"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.16, ease: 'easeOut' }}
              >
                {view.kind === 'pair' && (
                  <PairingView
                    online={status === 'online'}
                    onPaired={async (fp) => {
                      await refreshPeers();
                      setView({ kind: 'device', fingerprint: fp });
                    }}
                  />
                )}
                {view.kind === 'device' && selected && (
                  <DeviceView
                    peer={selected}
                    online={canConnect}
                    onRemoved={async () => {
                      const list = await refreshPeers();
                      setView(list[0] ? { kind: 'device', fingerprint: list[0].fingerprint } : { kind: 'pair' });
                    }}
                  />
                )}
                {view.kind === 'grid' && (
                  <GridView peers={peers} online={canConnect} onExpand={(fp) => setView({ kind: 'device', fingerprint: fp })} />
                )}
                {view.kind === 'history' && <HistoryView />}
                {view.kind === 'settings' && <SettingsView onSaved={() => rc.identity().then(setIdentity)} />}
              </motion.div>
            </AnimatePresence>
          </main>
        </div>
      </div>
    </SessionsProvider>
  );
}
