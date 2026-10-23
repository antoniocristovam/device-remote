import { QUALITY_LADDER, QualityProfiles, type QualityPreset } from '@rc/protocol';

/** One-second view of the link, combining receiver (desktop) and sender (phone) statistics. */
export interface LinkSample {
  /** Packet loss over the last interval, percent. */
  lossPct?: number;
  rttMs?: number;
  /** Average jitter-buffer delay, ms: grows when the network delivers frames unevenly. */
  jitterBufferMs?: number;
  /** Sender bandwidth estimate (availableOutgoingBitrate), bit/s. */
  availableBitrate?: number | null;
  /** Sender's encoder limitation: "bandwidth" | "cpu" | "none" | "other". */
  qualityLimitation?: string | null;
}

export interface QualityDecision {
  preset: QualityPreset;
  reason: string;
}

export const AUTO_TUNING = {
  /** Consecutive bad seconds before stepping down. */
  badTicksToDegrade: 3,
  /** Good seconds required before trying the next level up (doubles after a failed attempt). */
  initialUpgradeAfterMs: 10_000,
  maxUpgradeAfterMs: 120_000,
  /** An upgrade that turns bad within this window counts as failed. */
  failedUpgradeWindowMs: 20_000,
  /** Minimum time between any two changes. */
  minChangeIntervalMs: 4_000,
  /** Staying this long on a level without trouble resets the upgrade backoff. */
  stableResetMs: 120_000,
};

/**
 * Adaptive quality, AIMD-style: step down quickly on sustained congestion, probe upwards slowly
 * after a clean period, and back off exponentially when a probe fails. Hysteresis comes from the
 * gap between the "bad" and "good" thresholds plus the time windows.
 *
 * WebRTC's own congestion control already adapts bitrate inside a level; the controller moves
 * between levels (resolution + fps + bitrate cap), which is what keeps latency low on weak links.
 */
export class QualityController {
  private badTicks = 0;
  private goodSince?: number;
  private lastChangeAt: number;
  private lastUpgradeAt?: number;
  private upgradeAfterMs = AUTO_TUNING.initialUpgradeAfterMs;
  private troubleFreeSince: number;

  constructor(
    private level: QualityPreset = 'medium',
    now = Date.now(),
  ) {
    this.lastChangeAt = now;
    this.troubleFreeSince = now;
  }

  get current() {
    return this.level;
  }

  /** Explains why a sample is bad, or returns null. */
  static badReason(s: LinkSample, level: QualityPreset): string | null {
    if ((s.lossPct ?? 0) > 4) return `perda de pacotes ${s.lossPct!.toFixed(1)}%`;
    if ((s.rttMs ?? 0) > 300) return `RTT ${Math.round(s.rttMs!)} ms`;
    if ((s.jitterBufferMs ?? 0) > 200) return `buffer ${Math.round(s.jitterBufferMs!)} ms`;
    const cap = QualityProfiles[level].maxBitrate;
    if (s.qualityLimitation === 'bandwidth' && s.availableBitrate != null && s.availableBitrate < cap * 0.6) {
      return `banda ~${(s.availableBitrate / 1e6).toFixed(1)} Mbps`;
    }
    // "cpu" limitation is deliberately ignored: WebRTC already downscales inside the level for that,
    // and the flag sticks on mostly-static screens (too few frames to measure recovery), which
    // would otherwise pin the session at the lowest level forever.
    return null;
  }

  static isGood(s: LinkSample, level: QualityPreset): boolean {
    if ((s.lossPct ?? 0) >= 1 || (s.rttMs ?? 0) >= 150 || (s.jitterBufferMs ?? 0) >= 100) return false;
    if (s.qualityLimitation === 'bandwidth') return false;
    // The link must at least carry the current cap comfortably (when the phone reports it).
    if (s.availableBitrate != null && s.availableBitrate < QualityProfiles[level].maxBitrate * 0.9) return false;
    return true;
  }

  /** Feed one sample per second; returns a decision when the level should change. */
  tick(s: LinkSample, now = Date.now()): QualityDecision | null {
    const idx = QUALITY_LADDER.indexOf(this.level);
    const bad = QualityController.badReason(s, this.level);

    if (bad) {
      this.badTicks++;
      this.goodSince = undefined;
      this.troubleFreeSince = now;
    } else {
      this.badTicks = 0;
      if (QualityController.isGood(s, this.level)) this.goodSince ??= now;
      else this.goodSince = undefined;
    }

    if (now - this.troubleFreeSince >= AUTO_TUNING.stableResetMs) this.upgradeAfterMs = AUTO_TUNING.initialUpgradeAfterMs;
    if (now - this.lastChangeAt < AUTO_TUNING.minChangeIntervalMs) return null;

    if (bad && this.badTicks >= AUTO_TUNING.badTicksToDegrade && idx < QUALITY_LADDER.length - 1) {
      if (this.lastUpgradeAt != null && now - this.lastUpgradeAt < AUTO_TUNING.failedUpgradeWindowMs) {
        this.upgradeAfterMs = Math.min(this.upgradeAfterMs * 2, AUTO_TUNING.maxUpgradeAfterMs);
      }
      return this.change(QUALITY_LADDER[idx + 1]!, now, `reduzido: ${bad}`);
    }

    if (!bad && this.goodSince != null && now - this.goodSince >= this.upgradeAfterMs && idx > 0) {
      this.lastUpgradeAt = now;
      return this.change(QUALITY_LADDER[idx - 1]!, now, 'conexão estável');
    }
    return null;
  }

  private change(preset: QualityPreset, now: number, reason: string): QualityDecision {
    this.level = preset;
    this.lastChangeAt = now;
    this.badTicks = 0;
    this.goodSince = undefined;
    return { preset, reason };
  }
}
