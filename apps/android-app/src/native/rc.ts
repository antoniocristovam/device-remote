import { useEffect, useState } from 'react';
import { DeviceEventEmitter } from 'react-native';
import Native from './NativeRcModule';

export interface Peer {
  fingerprint: string;
  publicKey: string;
  name: string;
  channelId: string;
  pairedAt: number;
  lastSeenAt: number | null;
}

export type SessionState =
  | { phase: 'idle' }
  | { phase: 'request'; peer: Peer }
  | {
      phase: 'connecting' | 'live' | 'reconnecting';
      peer: Peer;
      sid: string;
      startedAt: number;
      reconnects: number;
      /** "usb": over the cable, through the desktop's adb tunnel. */
      transport: 'network' | 'usb';
      /** While reconnecting: when the link dropped and when the phone gives up. */
      downSince: number | null;
      deadline: number | null;
    };

export interface RcState {
  identity: { fingerprint: string; name: string };
  settings: { signalingUrl: string; deviceName: string };
  signaling: 'offline' | 'connecting' | 'online';
  /** Link to a desktop over the USB cable (adb reverse); "online" only while plugged into a computer running the app. */
  usb: 'offline' | 'connecting' | 'online';
  available: boolean;
  accessibility: boolean;
  peers: Peer[];
  session: SessionState;
}

export type PairingEvent =
  | { state: 'connecting' | 'waiting' | 'completing' | 'cancelled' }
  | { state: 'confirm'; desktopName: string; fingerprint: string; sas: string }
  | { state: 'paired'; peer: Peer }
  | { state: 'failed'; reason: string };

export interface SessionLogEntry {
  sid: string;
  peerFingerprint: string;
  peerName: string;
  startedAt: number;
  endedAt: number | null;
  endReason: string | null;
  reconnects?: number;
}

export type ChatEntry =
  | { kind: 'msg'; id: string; from: 'me' | 'peer'; text: string; ts: number; delivered?: boolean }
  | { kind: 'file'; id: string; from: 'me' | 'peer'; name: string; size: number; ts: number; ok: boolean; uri?: string };

export interface Transfer {
  id: string;
  from: 'me' | 'peer';
  name: string;
  size: number;
  bytes: number;
  state: 'waiting' | 'sending' | 'receiving' | 'verifying';
}

type RcEvent =
  | { type: 'state'; payload: RcState }
  | { type: 'pairing'; payload: PairingEvent }
  | { type: 'sessionRequest'; payload: { peer: Peer } }
  | { type: 'sessionEnded'; payload: { reason: string; peerName: string } }
  | { type: 'chatEntry'; payload: { peer: string; entry: ChatEntry } }
  | { type: 'transfers'; payload: { peer: string; list: Transfer[] } };

export function onRcEvent(cb: (e: RcEvent) => void) {
  const sub = DeviceEventEmitter.addListener('rc', (raw: string) => {
    try {
      cb(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  });
  return () => sub.remove();
}

export const rc = {
  getState: async (): Promise<RcState> => JSON.parse(await Native.getState()),
  getHistory: async (): Promise<SessionLogEntry[]> => JSON.parse(await Native.getHistory()),
  scanQr: () => Native.scanQr(),
  startPairing: (input: string) => Native.startPairing(input),
  confirmPairing: (accept: boolean) => Native.confirmPairing(accept),
  cancelPairing: () => Native.cancelPairing(),
  setAvailable: (on: boolean) => Native.setAvailable(on),
  respondSession: (accept: boolean) => Native.respondSession(accept),
  endSession: () => Native.endSession(),
  removePeer: (fp: string) => Native.removePeer(fp),
  openAccessibilitySettings: () => Native.openAccessibilitySettings(),
  saveSettings: (s: Partial<RcState['settings']>) => Native.saveSettings(JSON.stringify(s)),
  getChat: async (fp: string): Promise<ChatEntry[]> => JSON.parse(await Native.getChat(fp)),
  getTransfers: async (): Promise<Transfer[]> => JSON.parse(await Native.getTransfers()),
  sendChat: (text: string) => Native.sendChat(text),
  pickFiles: () => Native.pickFiles(),
  cancelTransfer: (id: string) => Native.cancelTransfer(id),
  openFile: (uri: string) => Native.openFile(uri),
};

/** Live core state, refreshed on every native "state" event. */
export function useRcState() {
  const [state, setState] = useState<RcState>();
  useEffect(() => {
    let alive = true;
    rc.getState().then((s) => alive && setState(s));
    const off = onRcEvent((e) => {
      if (e.type === 'state') setState(e.payload);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);
  return state;
}

export function shortFingerprint(fp: string) {
  return (fp.slice(0, 16).toUpperCase().match(/.{4}/g) ?? []).join(' ');
}
