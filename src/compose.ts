import fs from 'node:fs';
import path from 'node:path';
import { FORMAT, type Articulation, type Note, type Project } from './score/project.js';

const PC: Readonly<Record<string, number>> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ARTS: Readonly<Record<string, Articulation>> = { n: 'normal', l: 'legato', s: 'staccato', a: 'accent', z: 'sforzando' };

export const BPB = 4;

export function midi(name: string | number) {
  if (typeof name === 'number') return name;
  const match = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!match) throw new Error(`bad pitch "${name}"`);
  const [, letter, accidental, octave] = match;
  return 12 * (Number(octave) + 1) + PC[letter] + (accidental === '#' ? 1 : accidental === 'b' ? -1 : 0);
}

export function note(pitch: string | number, startBeat: number, durationBeats: number, velocity: number, articulation: Articulation = 'normal'): Note {
  return {
    midi: midi(pitch),
    startBeat: Number(startBeat.toFixed(4)),
    durationBeats: Number(durationBeats.toFixed(4)),
    velocity: Math.max(1, Math.min(127, Math.round(velocity))),
    articulation,
  };
}

const DURATIONS: Readonly<Record<string, number>> = { t: 1 / 3, T: 2 / 3 };

/**
 * A line written left to right: "D4:1.5:104:a F4:.5 -:1 D4+A4:2:90:l".
 * Each token is pitch(es):beats[:velocity][:articulation]; "-" rests, "t" is a triplet eighth,
 * and a token without a velocity or an articulation keeps the previous one.
 */
export function line(startBar: number, text: string, { vel = 96, art = 'n', gain = 1, transpose = 0, offset = 0 } = {}): Note[] {
  const notes = [];
  let beat = startBar * BPB + offset;
  let velocity = vel;
  let articulation = art;
  for (const token of text.trim().split(/\s+/)) {
    const [pitches, length, ...marks] = token.split(':');
    const beats = DURATIONS[length] ?? Number(length);
    if (!(beats > 0)) throw new Error(`bad length in "${token}"`);
    for (const mark of marks) {
      if (Object.hasOwn(ARTS, mark)) articulation = mark;
      else if (Number(mark) > 0) velocity = Number(mark);
      else if (mark !== '') throw new Error(`bad velocity or articulation in "${token}"`);
    }
    if (pitches !== '-') {
      for (const p of pitches.split('+')) notes.push(note(midi(p) + transpose, beat, beats, velocity * gain, ARTS[articulation]));
    }
    beat += beats;
  }
  return notes;
}

export const shift = (notes: readonly Note[], semitones: number) => notes.map((n) => ({ ...n, midi: n.midi + semitones }));
export const scaleVel = (notes: readonly Note[], factor: number) => notes.map((n) => ({ ...n, velocity: Math.max(1, Math.min(127, Math.round(n.velocity * factor))) }));

/** One clip holding notes placed in absolute beats. */
export const clip = (id: string, notes: readonly Note[]) => ({ id, startBeat: 0, notes: [...notes].sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi) });

export const reverb = (preset: 'room' | 'hall' | 'plate', mix: number, extra: Record<string, number> = {}) => ({ type: 'reverb', preset, mix, ...extra });
export const eq = (lowDb: number, midDb: number, highDb: number, extra: Record<string, number> = {}) => ({ type: 'eq3', lowDb, midDb, highDb, ...extra });

interface ScoreTrack {
  readonly id: string;
  readonly clips: readonly { readonly notes?: readonly Note[] }[];
}

export function writeProject<T extends { readonly id: string; readonly tracks: readonly ScoreTrack[] }>(project: T, directory = process.cwd()) {
  const file = path.join(directory, `${project.id}.daw.json`);
  // One note per line keeps the file reviewable without five lines per note.
  const noteBlock = /\{\s+"midi": (\d+),\s+"startBeat": ([\d.]+),\s+"durationBeats": ([\d.]+),\s+"velocity": (\d+),\s+"articulation": "(\w+)"\s+\}/g;
  const text = JSON.stringify(project, null, 2).replace(noteBlock, '{ "midi": $1, "startBeat": $2, "durationBeats": $3, "velocity": $4, "articulation": "$5" }');
  fs.writeFileSync(file, `${text}\n`);
  const notes = project.tracks.reduce((sum, t) => sum + t.clips.reduce((s, c) => s + (c.notes?.length ?? 0), 0), 0);
  process.stdout.write(`${path.basename(file)}: ${project.tracks.length} tracks, ${notes} notes\n`);
}

export function loopProject<T extends ScoreTrack>({ id, title, tonic, mode, sections, tracks, compressor = { thresholdDb: -16, ratio: 2, attackMs: 25, releaseMs: 250 } }: {
  id: string; title: string; tonic: string; mode: string;
  sections: Project['sections']; tracks: readonly T[];
  compressor?: { thresholdDb: number; ratio: number; attackMs: number; releaseMs: number };
}) {
  return {
    format: FORMAT,
    id,
    title,
    kind: 'loop',
    loop: true,
    tempo: { bpm: 120, beatsPerBar: BPB },
    key: { tonic, mode },
    bars: 16,
    master: { targetLufs: -16, ceilingDbtp: -1.5, hpfHz: 30, compressor },
    sections,
    patterns: {},
    tracks,
  };
}
