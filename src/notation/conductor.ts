import type { Part, Score } from 'musicxml-io/musicxml'

export const PPQ = 480
export type KeyChange = { ticks: number; fifths: number; mode: 'major' | 'minor' }
export type Controls = { ticks: number; number: 1 | 11; value: number }
export type PlayedNote = { ticks: number; durationTicks: number; midi: number; velocity: number }
export type Patch = { channel: number; program: number }
export type PerformanceTrack = Patch & { name: string; notes: PlayedNote[]; controls: Controls[] }
export interface Performance {
  name: string
  ppq: number
  endTick: number
  tempos: { ticks: number; bpm: number }[]
  meters: { ticks: number; numerator: number; denominator: number }[]
  keys: KeyChange[]
  tracks: PerformanceTrack[]
}

interface WrittenNote {
  ticks: number
  durationTicks: number
  step: string
  alter: number
  octave: number
  ties: string[]
  voice: string
  transpose: number
}
const semitones: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

export function readPart(part: Part) {
  const notes: WrittenNote[] = []
  const dynamics: { ticks: number; value: string }[] = []
  const fermatas: number[] = []
  const bars: number[] = []
  const tempos: Performance['tempos'] = []
  const meters: Performance['meters'] = []
  const keys: KeyChange[] = []
  let divisions = 0
  let transpose = 0
  let endTick = 0
  for (const measure of part.measures) {
    bars.push(endTick)
    const attrs = measure.attributes
    divisions = attrs?.divisions ?? divisions
    if (attrs?.time) {
      const numerator = Number(attrs.time.beats)
      if (!Number.isSafeInteger(numerator) || numerator <= 0) throw new Error('Unsupported compound meter')
      meters.push({ ticks: endTick, numerator, denominator: attrs.time.beatType })
    }
    if (attrs?.key && (attrs.key.mode === 'major' || attrs.key.mode === 'minor')) {
      keys.push({ ticks: endTick, fifths: attrs.key.fifths, mode: attrs.key.mode })
    }
    const shift = attrs?.transpose
    if (shift) transpose = shift.chromatic + 12 * (shift.octaveChange ?? 0)
    if (divisions <= 0) throw new Error('A part needs divisions before its first note')
    function toTicks(duration: number) {
      const value = (duration * PPQ) / divisions
      if (!Number.isSafeInteger(value)) throw new Error('Duration falls outside the 480 PPQ grid')
      return value
    }
    let cursor = endTick
    let chordStart = cursor
    for (const entry of measure.entries) {
      if (
        entry.type === 'attributes' &&
        (entry.attributes.time ||
          entry.attributes.key ||
          entry.attributes.divisions ||
          entry.attributes.transpose)
      ) {
        throw new Error('Mid-measure timing, key or transpose change requires another timeline segment')
      }
      if (entry.type === 'sound' && entry.tempo) tempos.push({ ticks: cursor, bpm: entry.tempo })
      if (entry.type === 'direction') {
        if (entry.sound?.tempo)
          tempos.push({ ticks: cursor + toTicks(entry.offset ?? 0), bpm: entry.sound.tempo })
        for (const mark of entry.directionTypes) {
          if (mark.kind === 'dynamics' && mark.value)
            dynamics.push({ ticks: cursor + toTicks(entry.offset ?? 0), value: mark.value })
        }
      }
      if (entry.type === 'backup') cursor -= toTicks(entry.duration)
      if (entry.type === 'forward') cursor += toTicks(entry.duration)
      if (entry.type === 'note' && !entry.grace) {
        if (!entry.chord) chordStart = cursor
        const durationTicks = toTicks(entry.duration)
        if (!entry.chord) cursor += durationTicks
        if (entry.notations?.some((mark) => mark.type === 'fermata')) fermatas.push(chordStart)
        if (entry.pitch) {
          const { step, octave, alter = 0 } = entry.pitch
          const ties = entry.ties ?? (entry.tie ? [entry.tie] : [])
          notes.push({
            ticks: chordStart,
            durationTicks,
            step,
            alter,
            octave,
            ties: ties.map((t) => t.type).sort(),
            voice: entry.voice ?? '1',
            transpose,
          })
        }
        endTick = Math.max(endTick, chordStart + durationTicks)
      }
      endTick = Math.max(endTick, cursor)
    }
  }
  return { notes, dynamics, fermatas, bars, endTick, tempos, meters, keys }
}

const levels: Record<string, number> = { ppp: 28, pp: 40, p: 52, mp: 64, mf: 78, f: 94, ff: 110, fff: 122 }

export function performPart(part: Part, timeline = readPart(part)): PlayedNote[] {
  const { notes, dynamics } = timeline
  const output: PlayedNote[] = []
  const open = new Map<string, PlayedNote>()
  for (const note of notes) {
    const midi = (note.octave + 1) * 12 + semitones[note.step] + note.alter + note.transpose
    if (!Number.isInteger(midi) || midi < 0 || midi > 127) throw new RangeError('Pitch outside MIDI range')
    const id = [note.voice, note.step, note.alter, note.octave, note.transpose].join('/')
    let played = open.get(id)
    if (note.ties.includes('stop')) {
      if (!played || played.ticks + played.durationTicks !== note.ticks)
        throw new Error('Unmatched tie stop in ' + part.id)
      played.durationTicks += note.durationTicks
      open.delete(id)
    } else {
      if (played) throw new Error('Unmatched tie start in ' + part.id)
      const marking = dynamics.findLast((d) => d.ticks <= note.ticks)
      played = {
        ticks: note.ticks,
        durationTicks: note.durationTicks,
        midi,
        velocity: levels[marking?.value ?? 'mf'] ?? 78,
      }
      output.push(played)
    }
    if (note.ties.includes('start')) open.set(id, played)
  }
  return output.sort((a, b) => a.ticks - b.ticks || a.midi - b.midi)
}

export function performance(
  score: Score,
  concertKey: KeyChange,
  patches: ReadonlyMap<string, Patch>
): Performance {
  const first = score.parts[0]
  if (!first || concertKey.ticks !== 0) throw new Error('Expected an opening concert key')
  const timelines = score.parts.map(readPart)
  const conductor = timelines[0]
  if (!conductor.meters.length) throw new Error('Expected an opening meter in the conductor part')
  const laterKeys = conductor.keys.filter((k) => k.ticks > 0)
  if (laterKeys.length && first.measures.some((m) => m.attributes?.transpose)) {
    throw new Error('Key changes need a concert-pitch conductor part')
  }
  const tracks = score.parts.map((part, index) => {
    const info = score.partList.find((p) => p.type === 'score-part' && p.id === part.id)
    const name = info?.type === 'score-part' ? (info.name ?? part.id) : part.id
    const patch = patches.get(name)
    if (!patch) throw new Error('Missing MIDI patch for ' + name)
    return { ...patch, name, controls: [], notes: performPart(part, timelines[index]) }
  })
  return {
    name: score.metadata.movementTitle ?? score.metadata.workTitle ?? '',
    ppq: PPQ,
    endTick: Math.max(...timelines.map((p) => p.endTick)),
    tracks,
    tempos:
      conductor.tempos[0]?.ticks === 0 ? conductor.tempos : [{ ticks: 0, bpm: 120 }, ...conductor.tempos],
    keys: [concertKey, ...laterKeys],
    meters: conductor.meters,
  }
}

export function dawNotes(track: PerformanceTrack, ppq: number) {
  return track.notes.map((n) => ({
    midi: n.midi,
    velocity: n.velocity,
    startBeat: n.ticks / ppq,
    durationBeats: n.durationTicks / ppq,
    articulation: 'normal' as const,
  }))
}
