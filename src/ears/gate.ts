import { checkAudio } from './check.js';
import { writeInspectionPngs } from '../io/png.js';
import type { Audio } from '../io/wav.js';
import type { CheckThresholds } from '../types.js';
import { PROFILES } from './profiles.js';

export const CATEGORIES = PROFILES.filter((p) => p !== 'raw');
export type Category = (typeof CATEGORIES)[number];

export interface GateThresholds {
  readonly lufsMin: number | null;
  readonly lufsMax: number | null;
  readonly momentaryMin: number | null;
  readonly momentaryMax: number;
  readonly maxTruePeakDbtp: number;
  readonly maxDcOffset: number;
  readonly maxClippedSamples: number;
  readonly maxClickRatio: number;
  readonly humRatioDb: number;
  readonly minCorrelation: number;
  readonly maxBalanceDb: number;
  readonly centroidHz: readonly [number, number];
  readonly rolloff85Hz: readonly [number, number];
  readonly maxSeamStep: number;
  readonly seamVsBarRatio: number;
}

export interface GateOptions {
  readonly category?: Category;
  readonly loop?: boolean;
  readonly bpm?: number;
  readonly beatsPerBar?: number;
  readonly targetLufs?: number;
  readonly lufsTolerance?: number;
  readonly thresholds?: Partial<GateThresholds>;
  readonly pngDir?: string;
  readonly title?: string;
}

export function gateAudio(audio: Audio, o: GateOptions = {}) {
  const category = o.category ?? 'music';
  const t = o.thresholds ?? {};
  const overrides = {
    maxDcOffset: t.maxDcOffset, maxTruePeakDbtp: t.maxTruePeakDbtp, maxFullScaleSamples: t.maxClippedSamples,
    maxClickRatio: t.maxClickRatio, minStereoCorrelation: t.minCorrelation, maxStereoBalanceDb: t.maxBalanceDb,
    minCentroidHz: t.centroidHz?.[0], maxCentroidHz: t.centroidHz?.[1],
    minRolloff85Hz: t.rolloff85Hz?.[0], maxRolloff85Hz: t.rolloff85Hz?.[1], humRatioDb: t.humRatioDb,
    maxSeamStep: t.maxSeamStep, seamVsBarRatio: t.seamVsBarRatio, minMomentaryLufs: t.momentaryMin, maxMomentaryLufs: t.momentaryMax,
    minIntegratedLufs: t.lufsMin !== undefined ? t.lufsMin : o.targetLufs === undefined ? undefined : o.targetLufs - (o.lufsTolerance ?? 2),
    maxIntegratedLufs: t.lufsMax !== undefined ? t.lufsMax : o.targetLufs === undefined ? undefined : o.targetLufs + (o.lufsTolerance ?? 2),
  };
  const thresholds = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)
    .map(([key, value]) => [key, value === null ? undefined : value])) as CheckThresholds;
  const r = checkAudio({ ...audio, format: 'float64' }, o.title ?? category, { ...o, profile: category, thresholds });
  const th = r.thresholds;
  const thresholdsUsed: GateThresholds = {
    lufsMin: th.minIntegratedLufs ?? null, lufsMax: th.maxIntegratedLufs ?? null,
    momentaryMin: th.minMomentaryLufs ?? null, momentaryMax: th.maxMomentaryLufs ?? Infinity,
    maxTruePeakDbtp: th.maxTruePeakDbtp ?? Infinity, maxDcOffset: th.maxDcOffset ?? Infinity,
    maxClippedSamples: th.maxFullScaleSamples ?? Infinity, maxClickRatio: th.maxClickRatio ?? Infinity,
    humRatioDb: th.humRatioDb ?? Infinity, minCorrelation: th.minStereoCorrelation ?? -1,
    maxBalanceDb: th.maxStereoBalanceDb ?? Infinity,
    centroidHz: [th.minCentroidHz ?? 0, th.maxCentroidHz ?? Infinity],
    rolloff85Hz: [th.minRolloff85Hz ?? 0, th.maxRolloff85Hz ?? Infinity],
    maxSeamStep: th.maxSeamStep ?? Infinity, seamVsBarRatio: th.seamVsBarRatio ?? Infinity,
  };
  return {
    ok: r.ok, category, durationS: r.format.durationS, sampleRate: audio.sampleRate, channels: audio.channels.length,
    loudness: r.loudness, dcOffset: r.channels.map((c) => c.dcOffset), clippedSamples: r.channels.reduce((sum, c) => sum + c.fullScaleSamples, 0),
    clickRatio: r.channels.map((c) => c.clickRatio), clickTimeS: r.channels.map((c) => c.clickTimeS),
    channelRmsDb: r.channels.map((c) => c.rmsDbfs ?? -200), correlation: r.stereo?.correlation ?? null, balanceDb: r.stereo?.balanceDb ?? null,
    ...r.spectral, hum: r.hum, seam: r.seam, findings: r.findings, thresholds: thresholdsUsed,
    ...(o.pngDir !== undefined ? { pngs: writeInspectionPngs(audio, o.pngDir, 'gate', r.loopChecked, { title: o.title ?? category, ...(o.bpm ? { barS: (o.beatsPerBar ?? 4) * 60 / o.bpm } : {}) }) } : {}),
  };
}
export type GateReport = ReturnType<typeof gateAudio>;
