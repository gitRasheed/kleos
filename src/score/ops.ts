import fs from 'node:fs';
import path from 'node:path';
import { critique, type Critique } from './critic.js';
import { gateAudio } from '../ears/gate.js';
import { checkAudio, type CheckOptions } from '../ears/check.js';
import { writeInspectionPngs } from '../io/png.js';
import type { CheckReport } from '../types.js';
import { exportMidi } from './midi.js';
import { FORMAT, parseProject, projectSummary, type Layer, type ParseResult, type Project } from './project.js';
import { renderProject, tile } from './render.js';
import { readWav, readWavFile, writeWav, type BitDepth } from '../io/wav.js';

export interface RenderFilesOptions {
  readonly out: string;
  readonly bitDepth?: BitDepth;
  readonly stemsDir?: string;
  readonly repeats?: number;
  readonly layers?: readonly Layer[];
  readonly trackIds?: readonly string[];
}

export function renderToFiles(p: Project, o: RenderFilesOptions): Record<string, unknown> {
  const t0 = performance.now();
  const r = renderProject(p, { ...(o.layers !== undefined ? { layers: o.layers } : {}), ...(o.trackIds !== undefined ? { trackIds: o.trackIds } : {}) });
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
    for (const [layer, stem] of Object.entries(r.stems)) {
      const file = path.join(o.stemsDir, `${p.id}_${layer}.wav`);
      writeWav(file, { sampleRate: p.sampleRate, channels: [stem.left, stem.right] }, bitDepth);
      written.push(file);
    }
  }
  return {
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
  const audio = profile === 'raw' ? readWavFile(file) : readWav(file);
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

export function critiqueProject(p: Project): Critique {
  return critique(p);
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

export function dump(p: Project): Record<string, unknown> {
  return projectSummary(p);
}

// notes/v1: the minimal agent score format (parts of {pitch|midi, start, dur, vel, art}) lifted into a project.
export function importNotes(raw: unknown, id?: string): ParseResult<Project> {
  if (typeof raw !== 'object' || raw === null || (raw as { format?: unknown }).format !== 'notes/v1')
    return { ok: false, errors: [{ path: '$.format', message: 'must be "notes/v1"' }], warnings: [] };
  const s = raw as Record<string, unknown>;
  const parts = Array.isArray(s.parts) ? (s.parts as Record<string, unknown>[]) : [];
  const bpb = typeof s.beatsPerBar === 'number' ? s.beatsPerBar : 4;
  let lastBeat = 0;
  const tracks = parts.map((part, i) => {
    const notes = (Array.isArray(part.notes) ? (part.notes as Record<string, unknown>[]) : []).map((n) => {
      const start = Number(n.start ?? n.startBeat);
      const dur = Number(n.dur ?? n.durationBeats);
      lastBeat = Math.max(lastBeat, start + dur);
      return { midi: n.midi ?? n.pitch, startBeat: start, durationBeats: dur, velocity: n.vel ?? n.velocity ?? 96, articulation: n.art ?? n.articulation ?? 'normal' };
    });
    return {
      id: typeof part.id === 'string' ? part.id : `part${i + 1}`,
      instrument: part.instrument ?? 'piano',
      ...(typeof part.role === 'string' ? { role: part.role } : {}),
      clips: [{ id: 'main', startBeat: 0, notes }],
    };
  });
  const key = (typeof s.key === 'object' && s.key !== null ? s.key : {}) as Record<string, unknown>;
  return parseProject({
    format: FORMAT,
    id: id ?? (typeof s.id === 'string' ? s.id : 'imported'),
    title: typeof s.title === 'string' ? s.title : 'imported',
    kind: 'cue',
    loop: s.loop === true,
    tempo: { bpm: typeof s.bpm === 'number' ? s.bpm : 120, beatsPerBar: bpb },
    key: { tonic: key.tonic ?? 'C', mode: key.mode ?? 'major' },
    bars: typeof s.bars === 'number' ? s.bars : Math.max(1, Math.ceil(lastBeat / bpb)),
    tracks,
  });
}
