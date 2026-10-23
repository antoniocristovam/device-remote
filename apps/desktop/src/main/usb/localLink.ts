import { randomBytes } from 'node:crypto';
import { startSignalingServer } from '@rc/signaling/server';
import { startTurnRelay } from './turnRelay.js';

/** Fixed ports on the phone (see the Android RcCore): `adb reverse` maps them to the local ones below. */
export const PHONE_SIGNALING_PORT = 38787;
export const PHONE_TURN_PORT = 38788;

export interface LocalLink {
  signalingPort: number;
  turnPort: number;
  /** TURN URL as this computer reaches the relay (the phone's credentials name its own adb port). */
  desktopTurnUrl: string;
  close(): Promise<void>;
}

/**
 * Signaling server and TURN relay for sessions over the USB cable, on loopback only. Nothing here
 * is trusted more than the public signaling server: sessions stay authenticated end to end.
 */
export async function startLocalLink(): Promise<LocalLink> {
  const secret = randomBytes(32).toString('base64');
  const relay = await startTurnRelay({ host: '127.0.0.1', port: 0, secret, realm: 'remote-controller-usb' });
  const signaling = await startSignalingServer({
    host: '127.0.0.1',
    port: 0,
    turn: {
      secret,
      urls: [`turn:127.0.0.1:${PHONE_TURN_PORT}?transport=tcp`],
      stunUrls: [],
      // A session lasts up to 12 h and its allocations refresh with the same credentials.
      ttlSeconds: 13 * 3600,
    },
  });
  return {
    signalingPort: signaling.port(),
    turnPort: relay.port(),
    desktopTurnUrl: `turn:127.0.0.1:${relay.port()}?transport=tcp`,
    close: async () => {
      await Promise.all([signaling.close(), relay.close()]);
    },
  };
}
