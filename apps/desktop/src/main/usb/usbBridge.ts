import { EventEmitter } from 'node:events';
import { Adb, findAdb, type AdbDevice } from './adb.js';

export interface UsbStatus {
  /** "missing": no adb could be found or started, so USB is unavailable. */
  adb: 'starting' | 'ok' | 'missing';
  devices: AdbDevice[];
}

const POLL_MS = 2_000;
/** `adb reverse` rules vanish when the adb server restarts: re-apply them now and then. */
const REAPPLY_MS = 15_000;

/**
 * Watches phones plugged in over USB and points their `localhost:<phone port>` at this computer's
 * local signaling server and TURN relay (`ports`: phone port -> local port).
 */
export class UsbBridge extends EventEmitter<{ status: [UsbStatus] }> {
  status: UsbStatus = { adb: 'starting', devices: [] };
  private adb?: Adb;
  private timer?: NodeJS.Timeout;
  private applied = new Map<string, number>();
  private stopped = false;

  constructor(private readonly ports: Record<number, number>) {
    super();
  }

  async start() {
    const bin = await findAdb();
    if (!bin) {
      this.set({ adb: 'missing', devices: [] });
      return;
    }
    this.adb = new Adb(bin);
    this.set({ adb: 'ok', devices: [] });
    void this.poll();
  }

  private set(s: UsbStatus) {
    const changed = JSON.stringify(s) !== JSON.stringify(this.status);
    this.status = s;
    if (changed) this.emit('status', s);
  }

  private async poll() {
    if (this.stopped || !this.adb) return;
    try {
      const devices = await this.adb.devices();
      const now = Date.now();
      for (const d of devices) {
        if (d.state !== 'device') continue;
        const last = this.applied.get(d.serial);
        if (last && now - last < REAPPLY_MS) continue;
        try {
          for (const [remote, local] of Object.entries(this.ports)) await this.adb.reverse(d.serial, Number(remote), local);
          this.applied.set(d.serial, now);
        } catch (e) {
          console.warn(`[usb] adb reverse failed for ${d.serial}:`, e instanceof Error ? e.message : e);
        }
      }
      for (const serial of [...this.applied.keys()]) if (!devices.some((d) => d.serial === serial && d.state === 'device')) this.applied.delete(serial);
      this.set({ adb: 'ok', devices });
    } catch {
      this.set({ adb: 'ok', devices: [] });
    }
    this.timer = setTimeout(() => void this.poll(), POLL_MS);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}
