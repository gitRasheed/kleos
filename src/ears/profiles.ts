import type { CheckThresholds } from '../types.js';

export const PROFILES = ['raw', 'music', 'sfx', 'ui', 'ambience'] as const;
export type Profile = (typeof PROFILES)[number];

export function parseProfile(value: string): Profile {
  const profile = PROFILES.find((p) => p === value);
  if (!profile) throw new Error(`Unknown profile "${value}" (expected ${PROFILES.join(', ')})`);
  return profile;
}

const mastered: CheckThresholds = {
  maxDcOffset: 0.002, maxFullScaleSamples: 0, minStereoCorrelation: -0.2,
  humRatioDb: 15, maxSeamStep: 6, seamVsBarRatio: 2,
};

export const PROFILE_THRESHOLDS: Record<Profile, CheckThresholds> = {
  raw: {},
  music: {
    ...mastered, minIntegratedLufs: -18, maxIntegratedLufs: -14, maxMomentaryLufs: -6,
    maxStereoBalanceDb: 9, minCentroidHz: 250, maxCentroidHz: 5000, minRolloff85Hz: 700, maxRolloff85Hz: 13000,
  },
  sfx: {
    ...mastered, minMomentaryLufs: -26, maxMomentaryLufs: -8, maxClickRatio: 40,
    minCentroidHz: 120, maxCentroidHz: 9000, minRolloff85Hz: 300, maxRolloff85Hz: 18000,
  },
  ui: {
    ...mastered, minMomentaryLufs: -30, maxMomentaryLufs: -12, maxClickRatio: 60,
    minCentroidHz: 400, maxCentroidHz: 12000, minRolloff85Hz: 600, maxRolloff85Hz: 16000,
  },
  ambience: {
    ...mastered, minIntegratedLufs: -27, maxIntegratedLufs: -21, maxMomentaryLufs: -12,
    maxStereoBalanceDb: 9, minCentroidHz: 100, maxCentroidHz: 6000, minRolloff85Hz: 300, maxRolloff85Hz: 14000,
  },
};

export interface SeamMetrics {
  readonly bars: number | null;
  readonly wrapStep: number;
  readonly typicalBarStep: number;
  readonly maxBarStep: number;
  readonly wrapJumpDb: number;
  readonly maxBarJumpDb: number;
}

export interface HumMetrics {
  readonly hz: 50 | 60;
  // Line level over the median of its neighbours; weaker of two windows on long files.
  readonly fundamentalDb: number;
  readonly harmonicDb: number;
}

const round = (v: number, d = 3): number => Number(v.toFixed(d));

function percentile(values: Float64Array, p: number): number {
  if (values.length === 0) return 0;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] ?? 0;
}

function goertzelPower(x: Float64Array, start: number, len: number, window: Float64Array, freq: number, sr: number): number {
  const w = (2 * Math.PI * freq) / sr;
  const k = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < len; i += 1) {
    const s = (x[start + i] ?? 0) * (window[i] ?? 0) + k * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return s1 * s1 + s2 * s2 - k * s1 * s2;
}

export function measureHum(channels: readonly Float64Array[], sr: number): HumMetrics[] {
  const n = channels[0]?.length ?? 0;
  if (n < 2 * sr) return [];
  const mono = new Float64Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) mono[i] = (mono[i] ?? 0) + (ch[i] ?? 0) / channels.length;
  const len = Math.min(mono.length, 16 * sr);
  const window = new Float64Array(len);
  for (let i = 0; i < len; i += 1) window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (len - 1)));
  const starts = mono.length >= 2 * len ? [0, mono.length - len] : [Math.floor((mono.length - len) / 2)];
  // Fixed offsets keep the reference spectrum independent of the score tempo.
  const offsets = [-3, -2, -1.5, -1, -0.75, -0.5, 0.5, 0.75, 1, 1.5, 2, 3];
  const lineDb = (start: number, f: number): number => {
    const p = goertzelPower(mono, start, len, window, f, sr);
    const floor = offsets.map((o) => goertzelPower(mono, start, len, window, f + o, sr)).sort((a, b) => a - b);
    const mid = floor.length / 2;
    const med = ((floor[mid - 1] ?? 0) + (floor[mid] ?? 0)) / 2;
    return 10 * Math.log10((p + 1e-30) / (med + 1e-30));
  };
  return ([50, 60] as const).map((hz) => {
    const fund = Math.min(...starts.map((st) => lineDb(st, hz)));
    const harm = Math.min(...starts.map((st) => Math.max(lineDb(st, 2 * hz), lineDb(st, 3 * hz))));
    return { hz, fundamentalDb: round(fund, 2), harmonicDb: round(harm, 2) };
  });
}

// How far the sample step at a boundary stands out from the steps around it (first and second differences,
// each over its local median), so tonal material is judged strictly and noisy material leniently.
function boundaryStep(buf: Float64Array, at: number, sr: number, level: number): number {
  const n = buf.length;
  const x = (i: number): number => buf[((i % n) + n) % n] ?? 0;
  const d1 = (i: number): number => Math.abs(x(i) - x(i - 1));
  const d2 = (i: number): number => Math.abs(x(i) - 2 * x(i - 1) + x(i - 2));
  const span = Math.round(sr * 0.02);
  const a = new Float64Array(2 * span);
  const b = new Float64Array(2 * span);
  let k = 0;
  for (let i = at - span; i < at + span; i += 1) {
    if (Math.abs(i - at) <= 2) continue;
    a[k] = d1(i);
    b[k] = d2(i);
    k += 1;
  }
  const floor = level * 1e-4 + 1e-9;
  const m1 = Math.max(percentile(a.subarray(0, k), 0.5), floor);
  const m2 = Math.max(percentile(b.subarray(0, k), 0.5), floor);
  return Math.max(d1(at) / m1, d2(at) / m2, d2(at + 1) / m2);
}

function levelJumpDb(buf: Float64Array, at: number, sr: number): number {
  const n = buf.length;
  const w = Math.round(sr * 0.01);
  let a = 0;
  let b = 0;
  for (let i = 1; i <= w; i += 1) {
    const before = buf[(((at - i) % n) + n) % n] ?? 0;
    const after = buf[(at + i - 1) % n] ?? 0;
    a += before * before;
    b += after * after;
  }
  return Math.abs(10 * Math.log10((a + 1e-12) / (b + 1e-12)));
}

// The loop wrap must look like an ordinary bar line. The reference is the 75th percentile of bar-line steps,
// because downbeat hits make the roughest bar line a poor yardstick.
export function measureSeam(channels: readonly Float64Array[], sr: number, barFrames: number | null, level: number): SeamMetrics {
  let wrapStep = 0;
  let wrapJumpDb = 0;
  let maxBarJumpDb = 0;
  const barSteps: number[] = [];
  const n = channels[0]?.length ?? 0;
  for (const ch of channels) {
    wrapStep = Math.max(wrapStep, boundaryStep(ch, 0, sr, level));
    wrapJumpDb = Math.max(wrapJumpDb, levelJumpDb(ch, 0, sr));
    if (barFrames !== null && barFrames > 0) {
      for (let b = barFrames; b < n - 2; b += barFrames) {
        const at = Math.round(b);
        barSteps.push(boundaryStep(ch, at, sr, level));
        maxBarJumpDb = Math.max(maxBarJumpDb, levelJumpDb(ch, at, sr));
      }
    }
  }
  const steps = Float64Array.from(barSteps);
  return {
    bars: barFrames !== null && barFrames > 0 ? round(n / barFrames, 4) : null,
    wrapStep: round(wrapStep),
    typicalBarStep: round(percentile(steps, 0.75)),
    maxBarStep: round(steps.length > 0 ? Math.max(...steps) : 0),
    wrapJumpDb: round(wrapJumpDb, 2),
    maxBarJumpDb: round(maxBarJumpDb, 2),
  };
}
