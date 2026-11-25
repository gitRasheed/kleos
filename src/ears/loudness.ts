import type { LoudnessMetrics } from '../types.js';

interface BiquadCoeffs {
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
  readonly a1: number;
  readonly a2: number;
}

// ITU-R BS.1770-4 analog prototype parameters bilinearly mapped to sampleRate.
function kWeightingStages(sampleRate: number): readonly [BiquadCoeffs, BiquadCoeffs] {
  const f0Shelf = 1681.974450955533;
  const dbGain = 3.999843853973347;
  const qShelf = 0.7071752369554196;
  const kShelf = Math.tan((Math.PI * f0Shelf) / sampleRate);
  const vh = Math.pow(10, dbGain / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const a0Shelf = 1 + kShelf / qShelf + kShelf * kShelf;
  const stage1: BiquadCoeffs = {
    b0: (vh + (vb * kShelf) / qShelf + kShelf * kShelf) / a0Shelf,
    b1: (2 * (kShelf * kShelf - vh)) / a0Shelf,
    b2: (vh - (vb * kShelf) / qShelf + kShelf * kShelf) / a0Shelf,
    a1: (2 * (kShelf * kShelf - 1)) / a0Shelf,
    a2: (1 - kShelf / qShelf + kShelf * kShelf) / a0Shelf,
  };

  const f0Hp = 38.13547087602444;
  const qHp = 0.5003270373238773;
  const kHp = Math.tan((Math.PI * f0Hp) / sampleRate);
  const a0Hp = 1 + kHp / qHp + kHp * kHp;
  const stage2: BiquadCoeffs = {
    b0: 1.0,
    b1: -2.0,
    b2: 1.0,
    a1: (2 * (kHp * kHp - 1)) / a0Hp,
    a2: (1 - kHp / qHp + kHp * kHp) / a0Hp,
  };

  return [stage1, stage2];
}

// K-weighted energy of each 100 ms hop, zero-padding the input up to frames.
function hopEnergies(
  input: Float64Array,
  frames: number,
  hopFrames: number,
  [s1, s2]: readonly [BiquadCoeffs, BiquadCoeffs],
): Float64Array {
  const out = new Float64Array(Math.floor(frames / hopFrames));
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  let z1 = 0;
  let z2 = 0;
  for (let h = 0; h < out.length; h += 1) {
    let sq = 0;
    const end = (h + 1) * hopFrames;
    for (let i = h * hopFrames; i < end; i += 1) {
      const x0 = input[i] ?? 0;
      const y0 = s1.b0 * x0 + s1.b1 * x1 + s1.b2 * x2 - s1.a1 * y1 - s1.a2 * y2;
      const z0 = s2.b0 * y0 + s2.b1 * y1 + s2.b2 * y2 - s2.a1 * z1 - s2.a2 * z2;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
      z2 = z1;
      z1 = z0;
      sq += z0 * z0;
    }
    out[h] = sq;
  }
  return out;
}

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const halfX = x * 0.5;
  for (let k = 1; k <= 24; k += 1) {
    term *= (halfX / k) * (halfX / k);
    sum += term;
  }
  return sum;
}

// 4-phase, 16-tap/phase Kaiser-windowed sinc interpolator (4x oversampling) for accurate BS.1770-4 true peak.
const TAPS_PER_PHASE = 16;
const HALF_TAPS = TAPS_PER_PHASE / 2;
const TRUE_PEAK_TAPS: Float64Array = (() => {
  const beta = 7.0;
  const i0Beta = besselI0(beta);
  const flat = new Float64Array(4 * TAPS_PER_PHASE);
  for (let phase = 0; phase < 4; phase += 1) {
    const frac = phase / 4;
    const taps: number[] = [];
    for (let k = 0; k < TAPS_PER_PHASE; k += 1) {
      const offset = k - (HALF_TAPS - 1) - frac;
      const sinc = Math.abs(offset) < 1e-12 ? 1 : Math.sin(Math.PI * offset) / (Math.PI * offset);
      const u = (2 * (k - frac)) / (TAPS_PER_PHASE - 1) - 1;
      const win = Math.abs(u) <= 1 ? besselI0(beta * Math.sqrt(Math.max(0, 1 - u * u))) / i0Beta : 0;
      taps.push(sinc * win);
    }
    const sum = taps.reduce((a, b) => a + b, 0);
    flat.set(
      taps.map((v) => v / sum),
      phase * TAPS_PER_PHASE,
    );
  }
  return flat;
})();

// A loop is measured circularly: its seam has no edge, so the taps wrap instead of reading zeros.
export function measureTruePeak(channels: readonly Float64Array[], options?: { readonly loop?: boolean }): {
  readonly truePeakLinear: number;
  readonly truePeakDbtp: number | null;
  readonly channel: number | null;
  readonly frame: number | null;
} {
  let maxVal = 0;
  let maxCh: number | null = null;
  let maxFrame: number | null = null;

  for (let c = 0; c < channels.length; c += 1) {
    const buf = channels[c];
    if (buf === undefined || buf.length === 0) {
      continue;
    }
    const n = buf.length;
    const loop = options?.loop === true;
    for (let i = loop ? 0 : -HALF_TAPS; i < (loop ? n : n + HALF_TAPS); i += 1) {
      const base = i - (HALF_TAPS - 1);
      const interior = base >= 0 && base + TAPS_PER_PHASE <= n;
      for (let p = 0; p < TRUE_PEAK_TAPS.length; p += TAPS_PER_PHASE) {
        let acc = 0;
        if (interior) {
          for (let k = 0; k < TAPS_PER_PHASE; k += 1) {
            acc += (buf[base + k] ?? 0) * (TRUE_PEAK_TAPS[p + k] ?? 0);
          }
        } else if (loop) {
          for (let k = 0; k < TAPS_PER_PHASE; k += 1) {
            acc += (buf[(((base + k) % n) + n) % n] ?? 0) * (TRUE_PEAK_TAPS[p + k] ?? 0);
          }
        } else {
          for (let k = 0; k < TAPS_PER_PHASE; k += 1) {
            const idx = base + k;
            if (idx >= 0 && idx < n) {
              acc += (buf[idx] ?? 0) * (TRUE_PEAK_TAPS[p + k] ?? 0);
            }
          }
        }
        const abs = Math.abs(acc);
        if (abs > maxVal) {
          maxVal = abs;
          maxCh = c;
          maxFrame = Math.max(0, Math.min(n - 1, i));
        }
      }
    }
  }

  return {
    truePeakLinear: maxVal,
    truePeakDbtp: maxVal > 0 ? 20 * Math.log10(maxVal) : null,
    channel: maxCh,
    frame: maxFrame,
  };
}

// Per-frame max of the 4x-oversampled magnitude, the same interpolator measureTruePeak uses.
export function truePeakEnvelope(buf: Float64Array): Float64Array {
  const n = buf.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const base = i - (HALF_TAPS - 1);
    let maxAbs = 0;
    for (let p = 0; p < TRUE_PEAK_TAPS.length; p += TAPS_PER_PHASE) {
      let acc = 0;
      for (let k = 0; k < TAPS_PER_PHASE; k += 1) {
        const idx = base + k;
        if (idx >= 0 && idx < n) {
          acc += (buf[idx] ?? 0) * (TRUE_PEAK_TAPS[p + k] ?? 0);
        }
      }
      maxAbs = Math.max(maxAbs, Math.abs(acc));
    }
    out[i] = maxAbs;
  }
  return out;
}

const HOPS_PER_BLOCK = 4;

function blockEnergies(
  channels: readonly Float64Array[],
  sampleRate: number,
  frames: number,
): readonly number[] {
  const hopFrames = Math.round(0.1 * sampleRate);
  const stages = kWeightingStages(sampleRate);
  const perChannel = channels.map((ch) => hopEnergies(ch, frames, hopFrames, stages));
  const blocks = Math.max(0, Math.floor(frames / hopFrames) - HOPS_PER_BLOCK + 1);
  const energies: number[] = [];
  for (let b = 0; b < blocks; b += 1) {
    let sumEnergy = 0;
    for (const hops of perChannel) {
      let sq = 0;
      for (let h = b; h < b + HOPS_PER_BLOCK; h += 1) {
        sq += hops[h] ?? 0;
      }
      sumEnergy += sq / (HOPS_PER_BLOCK * hopFrames);
    }
    energies.push(sumEnergy);
  }
  return energies;
}

// EBU Tech 3342 uses 3 s windows, a -20 LU relative gate and the 10th and 95th percentiles.
export function loudnessRange(channels: readonly Float64Array[], sampleRate: number): number | null {
  const frames = channels[0]?.length ?? 0;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new RangeError('Invalid sample rate');
  const hop = Math.max(1, Math.round(sampleRate / 10));
  const padded = frames + Math.ceil(1.5 * sampleRate);
  if (padded < 30 * hop || frames === 0) return null;
  const stages = kWeightingStages(sampleRate);
  const energies = channels.map(channel => hopEnergies(channel, padded, hop, stages));
  const absolute = 10 ** ((-70 + 0.691) / 10);
  const levels: number[] = [];
  let sum = 0;
  for (let h = 0; h < Math.floor(padded / hop); h++) {
    for (const channel of energies) sum += (channel[h] ?? 0) - (channel[h - 30] ?? 0);
    const power = sum / (30 * hop);
    if (h >= 29 && power >= absolute) levels.push(power);
  }
  if (!levels.length) return null;
  const gate = 0.01 * levels.reduce((a, b) => a + b, 0) / levels.length;
  const kept = levels.filter(x => x >= gate).sort((a, b) => a - b);
  const percentile = (p: number) => kept[Math.round((kept.length - 1) * p)] ?? 0;
  return 10 * Math.log10(percentile(0.95) / percentile(0.10));
}

export function measureLoudness(
  channels: readonly Float64Array[],
  sampleRate: number,
  options?: { readonly loop?: boolean },
): LoudnessMetrics {
  const truePeak = measureTruePeak(channels, options);
  const frames = channels[0]?.length ?? 0;
  const blockFrames = HOPS_PER_BLOCK * Math.round(0.1 * sampleRate);

  let momentaryMaxLufs: number | null = null;
  let shortTermMaxLufs: number | null = null;
  let momentaryPadded = false;
  let integratedLufs: number | null = null;
  let integratedReason: string | null = null;

  if (frames < blockFrames) {
    momentaryPadded = true;
    integratedReason = 'duration_below_400ms';
    const energies = blockEnergies(channels, sampleRate, blockFrames);
    const e0 = energies[0] ?? 0;
    if (e0 > 0) {
      momentaryMaxLufs = -0.691 + 10 * Math.log10(e0);
    }
  } else {
    const energies = blockEnergies(channels, sampleRate, frames);
    const blockLoudness = energies.map((e) => (e > 0 ? -0.691 + 10 * Math.log10(e) : -Infinity));
    let maxM = -Infinity;
    for (const l of blockLoudness) {
      if (l > maxM) {
        maxM = l;
      }
    }
    momentaryMaxLufs = Number.isFinite(maxM) ? maxM : null;

    const hopsPerShort = 30;
    const hopFrames = Math.round(0.1 * sampleRate);
    if (frames >= hopsPerShort * hopFrames) {
      const perChannel = channels.map((ch) => hopEnergies(ch, frames, hopFrames, kWeightingStages(sampleRate)));
      const hops = perChannel[0]?.length ?? 0;
      let maxS = -Infinity;
      for (let h = 0; h + hopsPerShort <= hops; h += 1) {
        let e = 0;
        for (const ch of perChannel) for (let k = h; k < h + hopsPerShort; k += 1) e += (ch[k] ?? 0) / (hopsPerShort * hopFrames);
        if (e > 0) maxS = Math.max(maxS, -0.691 + 10 * Math.log10(e));
      }
      shortTermMaxLufs = Number.isFinite(maxS) ? Number(maxS.toFixed(3)) : null;
    }

    // Relative gate operates strictly on blocks that already passed the -70 LUFS absolute gate.
    const absSurviving: { readonly energy: number; readonly lufs: number }[] = [];
    for (let i = 0; i < energies.length; i += 1) {
      const lufs = blockLoudness[i] ?? -Infinity;
      if (lufs > -70) {
        absSurviving.push({ energy: energies[i] ?? 0, lufs });
      }
    }
    if (absSurviving.length === 0) {
      integratedReason = 'below_absolute_gate';
    } else {
      const absMean = absSurviving.reduce((a, b) => a + b.energy, 0) / absSurviving.length;
      const relativeGate = -0.691 + 10 * Math.log10(absMean) - 10;
      const relSurviving = absSurviving.filter((b) => b.lufs > relativeGate);
      if (relSurviving.length === 0) {
        integratedReason = 'below_relative_gate';
      } else {
        const relMean = relSurviving.reduce((a, b) => a + b.energy, 0) / relSurviving.length;
        integratedLufs = -0.691 + 10 * Math.log10(relMean);
      }
    }
  }

  let peak = 0, squares = 0;
  for (const channel of channels) for (const x of channel) {
    peak = Math.max(peak, Math.abs(x));
    squares += x * x;
  }
  return {
    lraLu: loudnessRange(channels, sampleRate),
    plrDb: truePeak.truePeakDbtp === null || integratedLufs === null ? null : truePeak.truePeakDbtp - integratedLufs,
    crestFactorDb: squares === 0 ? null : 20 * Math.log10(peak / Math.sqrt(squares / (frames * channels.length))),
    integratedLufs: integratedLufs !== null ? Number(integratedLufs.toFixed(3)) : null,
    integratedReason,
    momentaryMaxLufs: momentaryMaxLufs !== null ? Number(momentaryMaxLufs.toFixed(3)) : null,
    shortTermMaxLufs,
    momentaryPadded,
    truePeakDbtp: truePeak.truePeakDbtp !== null ? Number(truePeak.truePeakDbtp.toFixed(3)) : null,
    truePeakChannel: truePeak.channel,
    truePeakFrame: truePeak.frame,
  };
}

export function integratedLufs(channels: readonly Float64Array[], sampleRate: number): number | null {
  const frames = channels[0]?.length ?? 0;
  const energies = blockEnergies(channels, sampleRate, Math.max(frames, HOPS_PER_BLOCK * Math.round(0.1 * sampleRate)));
  const abs = energies.filter((e) => e > 0 && -0.691 + 10 * Math.log10(e) > -70);
  if (abs.length === 0) return null;
  const gate = -0.691 + 10 * Math.log10(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const rel = abs.filter((e) => -0.691 + 10 * Math.log10(e) > gate);
  if (rel.length === 0) return null;
  return -0.691 + 10 * Math.log10(rel.reduce((a, b) => a + b, 0) / rel.length);
}
