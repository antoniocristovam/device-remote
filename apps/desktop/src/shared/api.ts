import type { PairingEvent } from '../main/pairing';
import type { SessionEvent, Transport } from '../main/session';
import type { ChatEntry, SessionLogEntry, Settings, StoredPeer } from '../main/store';
import type { SignalingStatus } from '../main/signalingClient';
import type { UsbStatus } from '../main/usb/usbBridge';

export type { ChatEntry, PairingEvent, SessionEvent, Transport, SessionLogEntry, Settings, StoredPeer, SignalingStatus, UsbStatus };

export interface IceCandidateInit {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

/** Surface exposed to the renderer through contextBridge (window.rc). Purpose-specific: no raw signing. */
export interface RcApi {
  identity(): Promise<{ name: string; fingerprint: string }>;
  settings: {
    get(): Promise<Settings>;
    set(s: Partial<Settings>): Promise<Settings>;
  };
  signaling: {
    status(): Promise<SignalingStatus>;
    onStatus(cb: (s: SignalingStatus) => void): () => void;
  };
  usb: {
    status(): Promise<UsbStatus>;
    onStatus(cb: (s: UsbStatus) => void): () => void;
  };
  peers: {
    list(): Promise<StoredPeer[]>;
    remove(fingerprint: string): Promise<void>;
  };
  history(): Promise<SessionLogEntry[]>;
  app: {
    platform(): Promise<string>;
    clipboardText(): Promise<string>;
    /** Performs a native edit action (copy, paste…) in the focused field. */
    nativeEdit(cmd: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'): Promise<void>;
    /** macOS menu: edit command, routed by the renderer (phone stage or local field). */
    onEditCommand(cb: (cmd: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll') => void): () => void;
    onNavigate(cb: (view: 'settings' | 'history' | 'pair') => void): () => void;
  };
  chat: {
    list(fingerprint: string): Promise<ChatEntry[]>;
    put(fingerprint: string, entry: ChatEntry): Promise<void>;
    delivered(fingerprint: string, id: string): Promise<void>;
  };
  files: {
    /** Local path of a dropped/picked File (Electron webUtils). */
    pathFor(file: File): string;
    hash(path: string): Promise<string>;
    begin(id: string, name: string, size: number): Promise<void>;
    chunk(id: string, data: Uint8Array): void;
    finish(id: string, sha256: string): Promise<{ ok: boolean; path?: string }>;
    abort(id: string): Promise<void>;
    reveal(path: string): Promise<void>;
    openDir(): Promise<void>;
  };
  pairing: {
    start(): Promise<void>;
    cancel(): Promise<void>;
    on(cb: (e: PairingEvent) => void): () => void;
  };
  session: {
    connect(fingerprint: string): Promise<void>;
    /** Sessions are per paired device: every call names the device's fingerprint. */
    end(fingerprint: string): Promise<void>;
    sendAnswer(fingerprint: string, sdp: string): Promise<void>;
    sendIce(fingerprint: string, c: IceCandidateInit): Promise<void>;
    /** Reports RTCPeerConnection.connectionState so main can track drops and reconnections. */
    reportConnection(fingerprint: string, state: RTCPeerConnectionState): Promise<void>;
    on(cb: (e: SessionEvent) => void): () => void;
  };
}
