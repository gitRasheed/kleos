import { PPQ } from '../notation/conductor.js';
import { expandTrackNotes, type Project, type Track } from './project.js';

export function trackSegments(project: Project, track: Track, width: number, extendBars: boolean) {
  const notes = expandTrackNotes(project, track).map((note, index) => {
    const start = Math.round(note.startBeat * PPQ);
    const end = Math.max(start + 1, Math.round((note.startBeat + note.durationBeats) * PPQ));
    return { ...note, index, start, end };
  });
  type Note = typeof notes[number];
  const changes = new Map<number, { on: Note[]; off: Note[] }>();
  function at(tick: number) {
    let change = changes.get(tick);
    if (!change) { change = { on: [], off: [] }; changes.set(tick, change); }
    return change;
  }
  let bars = project.bars;
  for (const note of notes) {
    at(note.start).on.push(note);
    at(note.end).off.push(note);
    if (extendBars) bars = Math.max(bars, Math.ceil(note.end / width));
  }
  for (let bar = 0; bar <= bars; bar++) at(bar * width);
  const ticks = [...changes.keys()].sort((a, b) => a - b);
  function* segments() {
    const active = new Set<Note>();
    for (let i = 0; i + 1 < ticks.length; i++) {
      const tick = ticks[i], next = ticks[i + 1];
      const { on, off } = at(tick);
      for (const n of off) active.delete(n);
      for (const n of on) active.add(n);
      yield { active, on, tick, next, bar: Math.min(Math.floor(tick / width), bars - 1) };
    }
  }
  return { bars, segments: segments() };
}
