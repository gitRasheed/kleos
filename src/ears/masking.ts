import { rfftMagnitude } from './fft.js';

interface Stereo { readonly left: Float64Array; readonly right: Float64Array }

const edges = [0, 100, 200, 300, 400, 510, 630, 770, 920, 1080, 1270, 1480, 1720, 2000, 2320, 2700, 3150, 3700, 4400, 5300, 6400, 7700, 9500, 12000, 15500] as const;
type Band = readonly [number, number];
export interface AnalysisTrack { readonly id: string; readonly role: string; readonly audio: Stereo }
export interface SpectralFinding {
  readonly code: 'MASKED' | 'MONO_LOSS';
  readonly trackId: string;
  readonly maskers: readonly string[];
  readonly bandHz: Band;
  readonly timeS: number;
  readonly bar: number;
  readonly valueDb: number;
}

function spectrum(channel: Float64Array, start: number, end: number, fftSize: number, sampleRate: number) {
  const bark = new Float64Array(24);
  let total = 0;
  const mag = rfftMagnitude(channel.subarray(start, end), fftSize);
  let b = 0;
  for (const [k, magnitude] of mag.entries()) {
    const hz = k * sampleRate / fftSize;
    while (b < 24 && hz >= (edges[b + 1] ?? Infinity)) b++;
    const power = magnitude ** 2 * (k === 0 || k === mag.length - 1 ? 1 : 2);
    if (b < 24) bark[b] = (bark[b] ?? 0) + power;
    total += power;
  }
  return { bark, total };
}

// Findings use project bars (zero-based) and retain the worst 50 ms frame per bar and band.
export function analyzeMix(tracks: readonly AnalysisTrack[], sampleRate: number, tempo: { bpm: number; beatsPerBar: number }, master?: Stereo) {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || !(tempo.bpm > 0 && Number.isFinite(tempo.bpm)) ||
    !(tempo.beatsPerBar > 0 && Number.isFinite(tempo.beatsPerBar))) throw new RangeError('Invalid sample rate or tempo');
  const n = master?.left.length ?? tracks[0]?.audio.left.length ?? 0;
  if (tracks.some(t => t.audio.left.length !== n || t.audio.right.length !== n)) throw new Error('Unaligned analysis tracks');
  if (new Set(tracks.map(t => t.id)).size !== tracks.length) throw new Error('Duplicate track id');
  const fftSize = 2 ** Math.ceil(Math.log2(Math.ceil(sampleRate / 20)));
  const size = Math.ceil(sampleRate / 20);
  const mix = { left: new Float64Array(size), right: new Float64Array(size) };
  const findings = new Map<string, SpectralFinding>();
  function record(f: SpectralFinding) {
    const key = JSON.stringify([f.code, f.bar, f.trackId, f.bandHz]);
    const previous = findings.get(key);
    if (!previous || f.valueDb < previous.valueDb) findings.set(key, f);
  }
  for (let frame = 0; ; frame++) {
    const start = Math.round(frame * sampleRate / 20);
    if (start >= n) break;
    const end = Math.min(n, Math.round((frame + 1) * sampleRate / 20));
    const timeS = start / sampleRate, bar = Math.floor(timeS * tempo.bpm / (60 * tempo.beatsPerBar));
    const size = end - start;
    if (size < sampleRate / 40) break;
    const floor = 1e-8 * fftSize * size * 0.75;
    for (const side of ['left', 'right'] as const) {
      const powers = tracks.map(t => ({ ...spectrum(t.audio[side], start, end, fftSize, sampleRate), track: t }));
      for (const [lead, power] of powers.entries()) {
        const t = power.track;
        if (t.role !== 'lead' || power.total < floor) continue;
        for (const [b, signal] of power.bark.entries()) {
          if (signal < power.total * 0.1) continue;
          const masker = powers.reduce((sum, p, index) => index === lead ? sum : sum + (p.bark[b] ?? 0), 0);
          const ratio = 10 * Math.log10(signal / masker);
          if (ratio > -10) continue;
          const maskers = powers.map((p, i) => ({ id: p.track.id, power: i === lead ? 0 : p.bark[b] ?? 0 }))
            .filter(m => m.power >= 0.05 * masker).sort((a, b) => b.power - a.power).map(m => m.id);
          record({ code: 'MASKED', trackId: t.id, maskers, bandHz: [edges[b] ?? 0, edges[b + 1] ?? 15500], timeS, bar, valueDb: ratio });
        }
      }
    }
    mix.left.fill(0); mix.right.fill(0);
    if (master) {
      mix.left.set(master.left.subarray(start, end));
      mix.right.set(master.right.subarray(start, end));
    } else for (const { audio } of tracks) for (let i = 0; i < size; i++) {
      mix.left[i] = (mix.left[i] ?? 0) + (audio.left[start + i] ?? 0);
      mix.right[i] = (mix.right[i] ?? 0) + (audio.right[start + i] ?? 0);
    }
    let mono = 0, stereoPower = 0;
    for (let i = 0; i < size; i++) {
      const l = mix.left[i] ?? 0, r = mix.right[i] ?? 0;
      mono += ((l + r) / 2) ** 2;
      stereoPower += (l ** 2 + r ** 2) / 2;
    }
    if (stereoPower < size * 1e-8) continue;
    const loss = 10 * Math.log10(Math.max(1e-12, mono / stereoPower));
    if (loss < -6) record({ timeS, bar, trackId: 'master', maskers: [], code: 'MONO_LOSS', bandHz: [0, sampleRate / 2], valueDb: loss });
  }
  return [...findings.values()].sort((a, b) => a.timeS - b.timeS);
}
