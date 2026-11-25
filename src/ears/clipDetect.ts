export interface FlatTopFinding {
  readonly code: 'FLAT_TOP_CLIPPING';
  readonly channel: number;
  readonly timeS: number;
  readonly railDbfs: number;
  readonly runs: number;
  readonly flatSamples: number;
}

export function detectFlatTopClipping(channels: readonly Float64Array[], sampleRate: number): FlatTopFinding[] {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new RangeError('Invalid sample rate');
  const findings: FlatTopFinding[] = [];
  for (const [channel, samples] of channels.entries()) {
    let peak = 0;
    for (const x of samples) peak = Math.max(peak, Math.abs(x));
    const railFloor = peak * 10 ** (-24 / 20);
    const rails = new Map<number, { runs: number; first: number; samples: number }>();
    for (let start = 1; start + 3 < samples.length;) {
      const rail = samples[start] ?? 0;
      let end = start + 1;
      while (end < samples.length && samples[end] === rail) end++;
      if (end - start >= 3 && end < samples.length && Math.abs(rail) > railFloor) {
        const entry = (rail - (samples[start - 1] ?? 0)) / rail;
        const exit = (rail - (samples[end] ?? 0)) / rail;
        const step = samples[start - 2] === samples[start - 1] && samples[end + 1] === samples[end];
        // Abrupt steps between stable levels are common in undistorted pulse oscillators.
        if (!step && entry > 0.0003 && exit > 0.0003 && entry < 1.5 && exit < 1.5) {
          const evidence = rails.get(rail) ?? { runs: 0, first: start, samples: 0 };
          evidence.runs++;
          evidence.samples += end - start;
          rails.set(rail, evidence);
        }
      }
      start = end;
    }
    for (const [rail, hit] of rails) {
      if (hit.runs >= 3) findings.push({
        code: 'FLAT_TOP_CLIPPING', channel,
        timeS: hit.first / sampleRate, railDbfs: 20 * Math.log10(Math.abs(rail)), runs: hit.runs, flatSamples: hit.samples
      });
    }
  }
  return findings.sort((a, b) => a.timeS - b.timeS);
}
