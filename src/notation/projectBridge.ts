import { isDeepStrictEqual } from 'node:util';
import type { Measure, NoteEntry, Part, Pitch, Score, TieInfo } from 'musicxml-io/musicxml';
import { Note } from 'tonal';
import { INSTRUMENT_DEFS } from '../theory/instruments.js';
import { keySignature } from '../score/midi.js';
import { expandTrackNotes, FORMAT, NATIVE_INSTRUMENTS, parseProject, type Project, type Track } from '../score/project.js';
import { readAbc } from './abcBridge.js';
import { dawNotes, performance, PPQ, type Performance, type PerformanceTrack } from './conductor.js';

const majorTonics = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
const minorTonics = ['Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#'];

function abcPerformance(score: Score): Performance {
  const attrs = score.parts[0]?.measures[0]?.attributes;
  const shift = attrs?.transpose;
  const fifths = (attrs?.key?.fifths ?? 0) + (shift ? 7 * shift.chromatic - 12 * (shift.diatonic ?? 0) : 0);
  const patches = new Map(score.partList.filter(p => p.type === 'score-part').map((p, i) => {
    const patch = p.midiInstruments?.[0];
    const ch = i % 15;
    return [p.name ?? p.id, { program: (patch?.program ?? 1) - 1, channel: patch?.channel === undefined ? ch + Number(ch >= 9) : patch.channel - 1 }];
  }));
  return performance(score, { ticks: 0, fifths, mode: attrs?.key?.mode === 'minor' ? 'minor' : 'major' }, patches);
}

function importedTrack(part: PerformanceTrack, ppq: number, id: string, existing?: Track) {
  const instrument = part.channel === 9 ? 'orchestral-perc' : NATIVE_INSTRUMENTS.find(type => INSTRUMENT_DEFS[type].gmProgram === part.program) ?? 'piano';
  const program = existing?.instrument.type === 'sf2' ? existing.instrument.params.program :
    existing ? existing.midi?.program ?? INSTRUMENT_DEFS[existing.instrument.type].gmProgram : part.program;
  return {
    id, name: part.name || id, instrument, ...existing,
    midi: { program, channel: existing?.midi?.channel ?? part.channel, controls: part.controls.map(c => ({ beat: c.ticks / ppq, number: c.number, value: c.value })) },
    clips: [{ id: 'main', startBeat: 0, notes: dawNotes(part, ppq) }],
  };
}

export function importPerformance(song: Performance, id: string, into?: Project, sourceAbc?: string) {
  const meter = song.meters.find(m => m.ticks === 0);
  const beatsPerBar = into?.tempo.beatsPerBar ?? (meter ? meter.numerator * 4 / meter.denominator : 4);
  const bars = Math.max(into?.bars ?? 1, Math.ceil(song.endTick / (beatsPerBar * song.ppq)));
  const key = song.keys.find(k => k.ticks === 0);
  const mode = key?.mode ?? 'major';
  const tonic = (mode === 'minor' ? minorTonics : majorTonics)[(key?.fifths ?? 0) + 7];
  if (!tonic) throw new Error('Concert key signature outside the supported range');
  if (!into && [...song.tempos, ...song.keys, ...song.meters].some(event => event.ticks > 0))
    throw new Error('A DAW project needs a single tempo, key and meter. Use readMidiFile or readAbc for conductor changes.');
  const tracks: (Track | ReturnType<typeof importedTrack>)[] = [...(into?.tracks ?? [])];
  const used = new Set<number>();
  const ids = new Set(tracks.map(t => t.id));
  for (const [i, part] of song.tracks.entries()) {
    const matches = into?.tracks.flatMap((t, index) => part.name === t.id || part.name === t.name ? [index] : []) ?? [];
    if (matches.length > 1) throw new Error('Ambiguous MIDI track name: ' + part.name);
    const index = matches[0] ?? (!part.name && into?.tracks[i] ? i : -1);
    if (index >= 0 && used.has(index)) throw new Error('Multiple MIDI tracks match ' + tracks[index].name);
    if (index >= 0) used.add(index);
    const old = into?.tracks[index];
    let number = i + 1;
    while (!old && ids.has('part' + number)) number++;
    const trackId = old?.id ?? 'part' + number;
    ids.add(trackId);
    const raw = importedTrack(part, song.ppq, trackId, old);
    tracks[index >= 0 ? index : tracks.length] = raw;
  }
  return parseProject({
    format: FORMAT, id, title: song.name || id, kind: 'cue',
    tempo: { bpm: song.tempos.find(t => t.ticks === 0)?.bpm ?? 120, beatsPerBar, beatUnit: meter?.denominator ?? 4 }, key: { tonic, mode },
    ...into, bars, tracks, ...(sourceAbc ? { sourceAbc } : {}),
  });
}

export function importAbcProject(text: string, id: string) {
  return importPerformance(abcPerformance(readAbc(text)), id, undefined, text);
}

function notationFields(p: Project) {
  return [p.title, p.tempo, p.key, p.bars, p.tracks.map(t => [t.name,
    expandTrackNotes(p, t).map(n => [n.startBeat, n.durationBeats, n.midi, n.velocity, n.articulation])])];
}

function meterFor({ beatsPerBar, beatUnit }: Project['tempo']) {
  if (beatUnit !== undefined) return { beats: String(beatsPerBar * beatUnit / 4), beatType: beatUnit };
  for (const denominator of [4, 8, 16, 32, 64]) {
    const numerator = beatsPerBar * denominator / 4;
    if (Number.isInteger(numerator)) return { beats: String(numerator), beatType: denominator };
  }
  throw new Error('Cannot engrave fractional meter ' + beatsPerBar);
}

function writtenPitch(midi: number, flats: boolean): Pitch {
  const pitch = Note.get(flats ? Note.fromMidi(midi) : Note.fromMidiSharps(midi));
  if (pitch.oct === undefined || pitch.oct < 0 || pitch.oct > 9)
    throw new Error('Pitch outside MusicXML octave range: ' + midi);
  return { step: pitch.letter as Pitch['step'], alter: pitch.alt, octave: pitch.oct };
}

function engrave(p: Project, track: Track, id: string): Part {
  const [fifths, minor] = keySignature(p);
  const width = Math.round(p.tempo.beatsPerBar * PPQ);
  const timeline = new Map<number, { start: number[]; stop: number[] }>();
  function at(tick: number) {
    let change = timeline.get(tick);
    if (!change) { change = { start: [], stop: [] }; timeline.set(tick, change); }
    return change;
  }
  const notes = expandTrackNotes(p, track).map(n => {
    const start = Math.round(n.startBeat * PPQ);
    return { start, end: Math.max(start + 1, Math.round((n.startBeat + n.durationBeats) * PPQ)), pitch: writtenPitch(n.midi, fifths < 0) };
  });
  const end = notes.reduce((last, n) => Math.max(last, n.end), width * p.bars);
  const bars = Math.ceil(end / width);
  const measures: Measure[] = Array.from({ length: bars }, (_, i) => {
    at(i * width);
    return { _id: id + 'm' + i, number: String(i + 1), entries: [] };
  });
  at(bars * width);
  measures[0].attributes = { divisions: PPQ, key: { fifths, mode: minor ? 'minor' : 'major' }, time: meterFor(p.tempo) };
  measures[0].entries.push({ _id: id + 'tempo', type: 'direction',
    directionTypes: [{ kind: 'metronome', beatUnit: 'quarter', perMinute: p.tempo.bpm }], sound: { tempo: p.tempo.bpm } });
  notes.forEach((n, i) => { at(n.start).start.push(i); at(n.end).stop.push(i); });
  const active = new Set<number>();
  const ticks = [...timeline.keys()].sort((a, b) => a - b);
  for (let i = 0; i + 1 < ticks.length; i++) {
    const tick = ticks[i], next = ticks[i + 1];
    const change = at(tick);
    change.stop.forEach(n => active.delete(n));
    change.start.forEach(n => active.add(n));
    const entries = measures[Math.floor(tick / width)].entries;
    const entry: NoteEntry = { _id: id + 't' + tick, type: 'note', duration: next - tick, voice: '1' };
    if (!active.size) entries.push({ ...entry, rest: {} });
    let chord = false;
    for (const n of active) {
      const note = notes[n];
      const ties: TieInfo[] = [];
      if (note.start < tick) ties.push({ type: 'stop' });
      if (next < note.end) ties.push({ type: 'start' });
      entries.push({ ...entry, _id: entry._id + 'n' + n, pitch: note.pitch, chord, ties,
        notations: ties.map(t => ({ type: 'tied', tiedType: t.type })) });
      chord = true;
    }
  }
  return { _id: id, id, measures };
}

export function projectNotation(p: Project): Score {
  if (p.sourceAbc) {
    const score = readAbc(p.sourceAbc);
    const original = importPerformance(abcPerformance(score), p.id);
    if (original.ok && isDeepStrictEqual(notationFields(original.value), notationFields(p))) return score;
  }
  if (!p.tracks.length) throw new Error('A part score needs at least one track');
  const parts = p.tracks.map((t, i) => engrave(p, t, 'P' + (i + 1)));
  return { _id: 'score', metadata: { movementTitle: p.title }, parts,
    partList: parts.map((part, i) => ({ _id: 'info' + part.id, id: part.id, type: 'score-part', name: p.tracks[i].name })) };
}
