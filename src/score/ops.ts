import { auditionHtml } from '../io/auditionHtml.js';
import { analyzeMix } from '../ears/masking.js';
import fs from 'node:fs';
import path from 'node:path';
import { gateAudio } from '../ears/gate.js';
import { checkAudio, type CheckOptions } from '../ears/check.js';
import { writeInspectionPngs } from '../io/png.js';
import type { CheckReport } from '../types.js';
import { exportMidi } from './midi.js';
import { type Layer, type Project } from './project.js';
export { projectSummary as dump } from './project.js';
import { renderProject, tile } from './render.js';
import { encodeDitheredWav, readWav, writeWav, type BitDepth } from '../io/wav.js';

export interface RenderFilesOptions {
  readonly projectDir?: string;
  readonly out: string;
  readonly bitDepth?: BitDepth;
  readonly stemsDir?: string;
  readonly repeats?: number;
  readonly layers?: readonly Layer[];
  readonly trackIds?: readonly string[];
}

export function inspectMix(p: Project, projectDir: string, auditionDir?: string) {
  const render = renderProject(p, { projectDir, captureTracks: true });
  const tracks = p.tracks.flatMap(t => {
    const audio = render.trackStems.get(t.id);
    return audio ? [{ id: t.id, role: t.role, audio }] : [];
  });
  const findings = [...analyzeMix(tracks, p.sampleRate, p.tempo, render.mix), ...render.findings].sort((a, b) => a.timeS - b.timeS);
  if (auditionDir === undefined) return { findings, reductions: render.reductions };
  const inputs = render.auditionStems.size ? render.auditionStems : new Map([['master', render.mix]]);
  const stems = Array.from(inputs, ([id, audio]) => ({
    id, wav: encodeDitheredWav({ channels: [audio.left, audio.right], sampleRate: p.sampleRate }, 32),
  }));
  const file = path.join(auditionDir, 'index.html');
  fs.mkdirSync(auditionDir, { recursive: true });
  fs.writeFileSync(file, auditionHtml(stems, findings));
  return { file, stems: stems.map(s => s.id), findings };
}

export function renderToFiles(p: Project, o: RenderFilesOptions): Record<string, unknown> {
  const t0 = performance.now();
  const r = renderProject(p, o);
  const bitDepth = o.bitDepth ?? 24;
  writeWav(o.out, { sampleRate: p.sampleRate, channels: [r.mix.left, r.mix.right] }, bitDepth);
  const written: string[] = [o.out];
  let repeatedOut: string | null = null;
  if ((o.repeats ?? 1) > 1 && p.loop) {
    const looped = tile(r.mix, o.repeats ?? 1);
    repeatedOut = repeatsPath(o.out, o.repeats ?? 1);
    writeWav(repeatedOut, { sampleRate: p.sampleRate, channels: [looped.left, looped.right] }, bitDepth);
    written.push(repeatedOut);
  }
  if (o.stemsDir !== undefined) {
    fs.mkdirSync(o.stemsDir, { recursive: true });
    const stems = [...Object.entries(r.stems), ...Array.from(r.busStems, ([id, audio]) => ['bus_' + encodeURIComponent(id), audio] as const)];
    for (const [name, stem] of stems) {
      const file = path.join(o.stemsDir, `${encodeURIComponent(p.id)}_${name}.wav`);
      writeWav(file, { sampleRate: p.sampleRate, channels: [stem.left, stem.right] }, bitDepth);
      written.push(file);
    }
  }
  return {
    reductions: r.reductions,
    findings: r.findings,
    out: o.out,
    repeatedOut,
    files: written,
    frames: r.frames,
    durationS: Number((r.frames / p.sampleRate).toFixed(4)),
    loop: r.loop,
    master: r.master,
    tracks: r.tracks,
    warnings: r.warnings,
    renderMs: Math.round(performance.now() - t0),
  };
}

// `--repeats N --out X.wav` writes X.wav once through and X_xN.wav tiled N times.
export function repeatsPath(out: string, repeats: number): string {
  return /\.wav$/i.test(out) ? out.replace(/\.wav$/i, `_x${repeats}.wav`) : `${out}_x${repeats}.wav`;
}

export function checkFile(file: string, p: Project | null, o: CheckOptions & { pngDir?: string } = {}): CheckReport {
  const profile = o.profile ?? (p === null ? 'raw' : p.kind === 'sfx' ? 'sfx' : 'music');
  const audio = readWav(file);
  const options = {
    ...(p ? { bpm: p.tempo.bpm, beatsPerBar: p.tempo.beatsPerBar, loop: p.loop, targetLufs: p.master.targetLufs } : {}),
    ...o, profile,
  };
  const report = checkAudio(audio, file, options);
  if (o.pngDir === undefined) return report;
  const name = path.parse(file).name;
  const labels = profile === 'raw' ? undefined : {
    title: name,
    ...(options.bpm ? { barS: (options.beatsPerBar ?? 4) * 60 / options.bpm } : {}),
  };
  return { ...report, pngs: writeInspectionPngs(audio, o.pngDir, name, report.loopChecked, labels) };
}

export function analyseAudioFile(file: string): Record<string, unknown> {
  const audio = readWav(file);
  const report = gateAudio(audio, { category: 'music' });
  return {
    file,
    durationS: report.durationS,
    sampleRate: audio.sampleRate,
    channels: audio.channels.length,
    loudness: report.loudness,
    centroidHz: report.centroidHz,
    rolloff85Hz: report.rolloff85Hz,
    rolloff95Hz: report.rolloff95Hz,
    correlation: report.correlation,
    balanceDb: report.balanceDb,
    channelRmsDb: report.channelRmsDb,
    dcOffset: report.dcOffset,
    clickRatio: report.clickRatio,
    hum: report.hum,
  };
}

export function writeMidi(p: Project, out: string): Record<string, unknown> {
  const bytes = exportMidi(p);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, bytes);
  return { file: out, bytes: bytes.length, tracks: p.tracks.length + 1 };
}
