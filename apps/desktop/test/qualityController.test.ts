import { describe, expect, it } from 'vitest';
import { AUTO_TUNING, QualityController, type LinkSample } from '../src/renderer/src/rtc/qualityController';

const good: LinkSample = { lossPct: 0, rttMs: 20, jitterBufferMs: 20, availableBitrate: 10e6, qualityLimitation: 'none' };
const lossy: LinkSample = { lossPct: 8, rttMs: 40, jitterBufferMs: 30 };

/** Runs `seconds` one-second ticks and returns every decision taken. */
function run(c: QualityController, sample: LinkSample, seconds: number, start: number) {
  const out: { t: number; preset: string }[] = [];
  for (let i = 1; i <= seconds; i++) {
    const d = c.tick(sample, start + i * 1000);
    if (d) out.push({ t: i, preset: d.preset });
  }
  return out;
}

describe('QualityController', () => {
  it('steps down after sustained loss, one level at a time', () => {
    const c = new QualityController('high', 0);
    const d = run(c, lossy, 12, 0);
    expect(d.map((x) => x.preset)).toEqual(['medium', 'low']);
    expect(d[0]!.t).toBeGreaterThanOrEqual(AUTO_TUNING.badTicksToDegrade);
    expect(d[1]!.t - d[0]!.t).toBeGreaterThanOrEqual(AUTO_TUNING.minChangeIntervalMs / 1000);
  });

  it('ignores a short spike (hysteresis)', () => {
    const c = new QualityController('medium', 0);
    expect(c.tick(lossy, 5000)).toBeNull();
    expect(c.tick(lossy, 6000)).toBeNull();
    expect(c.tick(good, 7000)).toBeNull();
    expect(c.tick(lossy, 8000)).toBeNull();
    expect(c.current).toBe('medium');
  });

  it('probes up after a clean period and backs off when the probe fails', () => {
    const c = new QualityController('low', 0);
    const up = run(c, good, 15, 0);
    expect(up[0]).toEqual({ t: 11, preset: 'medium' });

    // The probe fails: congestion right after the upgrade -> back to low.
    const down = run(c, lossy, 8, 15_000);
    expect(down[0]?.preset).toBe('low');

    // Next probe waits twice as long.
    const retry = run(c, good, 40, 23_000);
    expect(retry[0]!.t).toBeGreaterThanOrEqual(20);
  });

  it('does not upgrade when the phone reports too little bandwidth for the current level', () => {
    const c = new QualityController('medium', 0);
    expect(run(c, { ...good, availableBitrate: 1.5e6 }, 30, 0)).toEqual([]);
  });

  it('degrades on encoder bandwidth limitation even without loss', () => {
    const c = new QualityController('high', 0);
    const d = run(c, { ...good, availableBitrate: 2e6, qualityLimitation: 'bandwidth' }, 6, 0);
    expect(d[0]?.preset).toBe('medium');
  });

  it('ignores a sticky encoder CPU limitation (network signals decide)', () => {
    const c = new QualityController('low', 0);
    const d = run(c, { ...good, qualityLimitation: 'cpu' }, 15, 0);
    expect(d[0]?.preset).toBe('medium');
  });

  it('never goes beyond the ladder ends', () => {
    expect(run(new QualityController('low', 0), lossy, 30, 0)).toEqual([]);
    const top = new QualityController('high', 0);
    expect(run(top, good, 300, 0)).toEqual([]);
  });
});
