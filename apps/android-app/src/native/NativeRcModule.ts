import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/**
 * Bridge to the Kotlin core (RcCore). Complex values cross as JSON strings to keep the codegen
 * surface small; see src/native/rc.ts for the typed wrapper.
 */
export interface Spec extends TurboModule {
  getState(): Promise<string>;
  getHistory(): Promise<string>;
  scanQr(): Promise<string>;
  startPairing(input: string): void;
  confirmPairing(accept: boolean): void;
  cancelPairing(): void;
  setAvailable(on: boolean): void;
  respondSession(accept: boolean): void;
  endSession(): void;
  removePeer(fingerprint: string): void;
  openAccessibilitySettings(): void;
  saveSettings(json: string): void;
  getChat(fingerprint: string): Promise<string>;
  getTransfers(): Promise<string>;
  sendChat(text: string): Promise<boolean>;
  pickFiles(): void;
  cancelTransfer(id: string): void;
  openFile(uri: string): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('RcModule');
