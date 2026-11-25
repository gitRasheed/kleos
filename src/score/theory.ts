import { Note, Scale } from 'tonal';
import { INSTRUMENT_DEFS, type Instrument } from '../theory/instruments.js';
import type { Event, Score, Track } from '../theory/types.js';
import { PPQ } from './midi.js';
import { expandTrackNotes, FORMAT, parseProject, type PlacedNote, type Project, type Track as ProjectTrack } from './project.js';

function trackBars(project: Project, track: ProjectTrack, ticksPerBar: number, spell: (midi: number) => string): Event[][] {
  const changes = new Map<number, { on: PlacedNote[]; off: PlacedNote[] }>();
  function at(tick: number) {
    let change = changes.get(tick);
    if (!change) {
      change = { on: [], off: [] };
      changes.set(tick, change);
    }
    return change;
  }
  const bars: Event[][] = Array.from({ length: project.bars }, () => []);
  for (let i = 0; i <= bars.length; i++) at(i * ticksPerBar);
  for (const note of expandTrackNotes(project, track)) {
    const start = Math.round(note.startBeat * PPQ);
    const end = Math.max(start + 1, Math.round((note.startBeat + note.durationBeats) * PPQ));
    at(start).on.push(note);
    at(end).off.push(note);
  }
  const ticks = [...changes.keys()].sort((a, b) => a - b);
  const active = new Set<PlacedNote>();
  for (let i = 0; i < ticks.length - 1; i++) {
    const tick = ticks[i];
    const { on, off } = at(tick);
    for (const note of off) active.delete(note);
    for (const note of on) active.add(note);
    const articulations = on.map(n => n.articulation).filter(mark => mark !== 'normal' && mark !== 'sforzando');
    const bar = Math.min(Math.floor(tick / ticksPerBar), bars.length - 1);
    bars[bar].push({
      ticks: ticks[i + 1] - tick,
      pitches: Array.from(active, n => spell(n.midi)),
      articulations: [...new Set(articulations)],
    });
  }
  return bars;
}

export function projectToTheoryScore(project: Project, style: Score['style'] = 'free'): Score {
  const ticksPerBar = Math.round(project.tempo.beatsPerBar * PPQ);
  const mode = project.key.mode.replace('-', ' ');
  const scale = Scale.get(`${project.key.tonic} ${mode}`).notes;
  const leading = Note.transpose(project.key.tonic, '-2m');
  const spelling = new Map([leading, ...scale].map(pc => [Note.chroma(pc), pc]));
  function spell(midi: number) {
    const name = Note.fromMidi(midi);
    const pc = spelling.get(midi % 12);
    return pc ? Note.enharmonic(name, pc) : name;
  }
  const pitched = project.tracks.filter(t => !t.mute && t.instrument.type !== 'orchestral-perc' && t.instrument.type !== 'cinematic-sfx');
  return {
    style, ticksPerBeat: PPQ, beatsPerBar: Array<number>(project.bars).fill(ticksPerBar / PPQ),
    tonic: project.key.tonic,
    tracks: pitched.map(track => ({
      id: track.id, voice: track.name, instrument: track.instrument.type,
      dynamic: 'velocity', bars: trackBars(project, track, ticksPerBar, spell),
    })),
  };
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string');
const optionalString = (v: unknown) => v === undefined || typeof v === 'string';
const knownInstrument = (v: unknown): v is Instrument => typeof v === 'string' && Object.hasOwn(INSTRUMENT_DEFS, v);

function eventShape(v: unknown): v is Event {
  return record(v) && typeof v.ticks === 'number' && strings(v.pitches) && optionalString(v.dynamic)
    && (v.articulations === undefined || strings(v.articulations));
}

function trackShape(v: unknown): v is Track {
  return record(v) && typeof v.id === 'string' && typeof v.voice === 'string' && knownInstrument(v.instrument)
    && (v.pitchBasis === undefined || v.pitchBasis === 'written' || v.pitchBasis === 'sounding')
    && optionalString(v.doublingGroup) && optionalString(v.dynamic)
    && Array.isArray(v.bars) && v.bars.every(bar => Array.isArray(bar) && bar.every(eventShape));
}

function theoryShape(v: Record<string, unknown>): v is Record<string, unknown> & Score {
  return (v.style === 'strict' || v.style === 'free') && typeof v.ticksPerBeat === 'number' && Array.isArray(v.beatsPerBar) && v.beatsPerBar.length > 0
    && v.beatsPerBar.every(b => typeof b === 'number') && optionalString(v.tonic)
    && Array.isArray(v.tracks) && v.tracks.every(trackShape)
    && (v.harmony === undefined || (Array.isArray(v.harmony) && v.harmony.every(h =>
      record(h) && typeof h.bar === 'number' && typeof h.beat === 'number' && typeof h.chord === 'string')));
}

export function parseLintScore(raw: unknown, override?: unknown): Score {
  if (!record(raw)) throw new Error('Expected a score object');
  const format = raw.format ?? raw.schemaVersion;
  const declared = raw.style === undefined ? 'free' : raw.style;
  const style = override === undefined ? declared : override;
  if (style !== 'free' && style !== 'strict') throw new Error('style must be strict or free');
  if (format !== undefined && format !== FORMAT && format !== 'agent-audio/score/v1') throw new Error(`Unknown score format: ${String(format)}`);
  if (format === FORMAT || (format === 'agent-audio/score/v1' && !('ticksPerBeat' in raw))) {
    const parsed = parseProject({ ...raw, format: FORMAT });
    if (!parsed.ok) throw new Error(parsed.errors.map(e => `${e.path}: ${e.message}`).join('\n'));
    return projectToTheoryScore(parsed.value, style);
  }
  const score = { ...raw, style };
  if (!theoryShape(score)) throw new Error('Invalid theory score: expected ticksPerBeat, beatsPerBar and tracks with measured pitch events');
  return score;
}
