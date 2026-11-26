import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { exportMidi, parseMidi, PPQ } from '../src/score/midi.js';
import { expandTrackNotes, parseProject, type Project } from '../src/score/project.js';
import { project, track } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function demo(): Project {
  const r = parseProject(JSON.parse(fs.readFileSync(path.join(root, 'examples/fanfare-overture.daw.json'), 'utf8')));
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
}

test('MIDI export is a valid type-1 SMF that round-trips every note, the tempo and track names', () => {
  const p = demo();
  const bytes = exportMidi(p);
  const m = parseMidi(bytes);
  assert.equal(m.format, 1);
  assert.equal(m.ppq, PPQ);
  assert.equal(m.tracks, p.tracks.length + 1);
  assert.equal(m.tempoUsPerBeat, 500000);
  assert.deepEqual(m.trackNames.slice(1), p.tracks.map((t) => t.name));
  const expected = p.tracks.flatMap((t, i) => expandTrackNotes(p, t).map((n) => `${i + 1}:${n.midi}:${Math.round(n.startBeat * PPQ)}:${Math.max(Math.round(n.startBeat * PPQ) + 1, Math.round((n.startBeat + n.durationBeats) * PPQ))}`));
  // Overlapping repeats of the same key on one channel are legal in the project but merge in MIDI, so compare as multisets of onsets.
  const got = m.notes.map((n) => `${n.track}:${n.midi}:${n.startTick}`).sort();
  const want = expected.map((e) => e.split(':').slice(0, 3).join(':')).sort();
  assert.deepEqual(got, want);
  assert.ok(m.notes.filter((n) => n.track === p.tracks.findIndex((t) => t.instrument.type === 'orchestral-perc') + 1).every((n) => n.channel === 9), 'percussion on channel 10');
});

test('pitch bends export as pitch-wheel sweeps', () => {
  const p = project({ bars: 1, tracks: [track('g', 'guitar-electric', [{ midi: 52, startBeat: 0, durationBeats: 2, velocity: 100, pitchBend: 2 }])] });
  const bytes = exportMidi(p);
  let bends = 0;
  for (let i = 0; i + 2 < bytes.length; i += 1) if ((bytes[i] ?? 0) === 0xe0) bends += 1;
  assert.ok(bends >= 9, `found ${bends} bend events`);
});

// Channel events of one exported track in file order; the exporter writes a full status byte on every event.
function channelEvents(bytes: Uint8Array, trackIndex: number): { tick: number; kind: number; d1: number; d2: number }[] {
  const u32 = (o: number): number => ((bytes[o] ?? 0) << 24 | (bytes[o + 1] ?? 0) << 16 | (bytes[o + 2] ?? 0) << 8 | (bytes[o + 3] ?? 0)) >>> 0;
  let o = 14;
  for (let t = 0; t < trackIndex; t += 1) o += 8 + u32(o + 4);
  const end = o + 8 + u32(o + 4);
  let i = o + 8;
  let tick = 0;
  const vlq = (): number => {
    let v = 0;
    for (;;) {
      const b = bytes[i++] ?? 0;
      v = (v << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) return v;
    }
  };
  const out: { tick: number; kind: number; d1: number; d2: number }[] = [];
  while (i < end) {
    tick += vlq();
    const status = bytes[i++] ?? 0;
    if (status === 0xff) {
      i += 1;
      const len = vlq();
      i += len;
      continue;
    }
    const kind = status & 0xf0;
    const d1 = bytes[i++] ?? 0;
    const d2 = kind === 0xc0 || kind === 0xd0 ? 0 : (bytes[i++] ?? 0);
    out.push({ tick, kind, d1, d2 });
  }
  return out;
}

test('the wheel is back at centre before an unbent note that starts where a bent one ends', () => {
  for (const bentBeats of [1, 4 / PPQ]) {
    const p = project({ bars: 1, tracks: [track('g', 'guitar-electric', [{ midi: 52, startBeat: 0, durationBeats: bentBeats, velocity: 100, pitchBend: 2 }, { midi: 55, startBeat: bentBeats, durationBeats: 1, velocity: 100 }])] });
    const events = channelEvents(exportMidi(p), 1);
    const nextOn = events.findIndex((e) => e.kind === 0x90 && e.d1 === 55);
    const boundary = Math.round(bentBeats * PPQ);
    assert.equal(events[nextOn]?.tick, boundary);
    const bends = events.slice(0, nextOn).filter((e) => e.kind === 0xe0);
    const wheel = (e: { d1: number; d2: number } | undefined): number => (e === undefined ? -1 : e.d1 | (e.d2 << 7));
    assert.equal(wheel(bends.at(-1)), 8192, `wheel at the unbent note-on after a ${bentBeats}-beat bend`);
    assert.ok(bends.some((e) => wheel(e) === 9557), 'the sweep reaches +2 semitones');
    const resetIdx = events.findIndex((e, k) => k < nextOn && e.kind === 0xe0 && e.tick === boundary && wheel(e) === 8192 && events.slice(0, k).some((b) => b.kind === 0xe0 && wheel(b) === 9557));
    assert.ok(resetIdx >= 0, 'a centre reset follows the last bend step');
  }
});

test('overlapping notes of the same pitch retain both starts and velocities in FIFO order', () => {
  const score = project({ tracks: [track('piano', 'piano', [
    { midi: 60, startBeat: 0, durationBeats: 2, velocity: 80 },
    { midi: 60, startBeat: 1, durationBeats: 2, velocity: 110 },
  ])] });
  assert.deepEqual(parseMidi(exportMidi(score)).notes.map(n => [n.startTick, n.endTick, n.velocity]), [
    [0, 2 * PPQ, 80], [PPQ, 3 * PPQ, 110],
  ]);
});
