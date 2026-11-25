import { Chord, Note } from 'tonal'
import { INSTRUMENT_DEFS } from './instruments.js'
import type { Diagnostic, Event, Location, Score, Track } from './types.js'

export interface Pitch {
  name: string
  pc: string
  midi: number
  degree: number
}
export interface Sound {
  start: number
  end: number
  pitches: Pitch[]
}
export interface Harmony {
  symbol: string
  members: Set<string>
  seventh: string | undefined
}
interface Frame {
  changes: Map<number, Sound | undefined>
  bar?: number
  harmony?: Harmony
}

function readPitch(name: string, track: Track, where: Location): Pitch {
  const written = Note.get(name)
  if (written.midi === null)
    throw new RangeError(`Invalid pitch "${name}" on ${track.id} in bar ${where.bar}, beat ${where.beat}`)
  const def = INSTRUMENT_DEFS[track.instrument]
  const note = track.pitchBasis === 'written' ? Note.get(Note.transpose(name, def.transposition)) : written
  if (note.oct === undefined) throw new RangeError(`Invalid pitch on ${track.id}`)
  return { name: note.name, pc: note.pc, midi: note.height, degree: note.oct * 7 + note.step }
}

type ReportNote = (code: Diagnostic['code'], severity: Diagnostic['severity'], message: string) => void

function checkInstrument(track: Track, event: Event, pitches: Pitch[], emit: ReportNote) {
  const def = INSTRUMENT_DEFS[track.instrument]
  for (const mark of event.articulations ?? []) {
    if (!def.articulations.includes(mark))
      emit('ARTICULATION_UNSUPPORTED', 'warning', `${track.instrument} does not support ${mark}.`)
  }
  if (def.monophonic && pitches.length > 1)
    emit('POLYPHONY', 'error', `${track.instrument} has ${pitches.length} simultaneous notes.`)
  for (const pitch of pitches) {
    if (pitch.midi < def.soundingRange[0] || pitch.midi > def.soundingRange[1]) {
      emit('RANGE_HARD', 'error', `Sounding ${pitch.name} is outside the range of ${track.instrument}.`)
    } else if (pitch.midi < def.comfortableRange[0] || pitch.midi > def.comfortableRange[1]) {
      emit(
        'RANGE_EXTREME',
        'warning',
        `Sounding ${pitch.name} is in the extreme register of ${track.instrument}.`,
      )
    }
  }
}

function parseHarmony(symbol: string): Harmony {
  const chord = Chord.get(symbol)
  if (chord.empty || !chord.tonic) throw new RangeError(`Unknown chord "${symbol}"`)
  const seventhIndex = chord.intervals.findIndex((interval) => /^7/.test(interval))
  return { symbol, members: new Set(chord.notes), seventh: chord.notes[seventhIndex] }
}

export function timeline(score: Score, report: Diagnostic[]) {
  if (score.style !== 'strict' && score.style !== 'free') throw new RangeError('Unknown lint style')
  const ppb = score.ticksPerBeat
  if (!Number.isSafeInteger(ppb) || ppb <= 0) throw new RangeError('ticksPerBeat must be a positive integer')
  let total = 0
  const starts = score.beatsPerBar.map((beats) => {
    const start = total
    const length = Math.round(beats * ppb)
    total += length
    if (
      length / ppb !== beats ||
      !Number.isSafeInteger(length) ||
      length <= 0 ||
      !Number.isSafeInteger(total)
    ) {
      throw new RangeError('Bar lengths must be positive whole ticks within the safe integer range')
    }
    return start
  })
  const frames = new Map<number, Frame>()
  function at(tick: number): Frame {
    let frame = frames.get(tick)
    if (!frame) {
      frame = { changes: new Map() }
      frames.set(tick, frame)
    }
    return frame
  }
  starts.forEach((start, bar) => {
    at(start).bar = bar
  })
  for (const { bar, beat, chord } of score.harmony ?? []) {
    const offset = Math.round((beat - 1) * ppb)
    if (
      !Number.isInteger(bar) ||
      bar < 1 ||
      bar > starts.length ||
      !Number.isSafeInteger(offset) ||
      beat !== 1 + offset / ppb ||
      offset < 0 ||
      offset >= Math.round(ppb * score.beatsPerBar[bar - 1])
    )
      throw new RangeError('Invalid chord location')
    const frame = at(starts[bar - 1] + offset)
    if (frame.harmony) throw new RangeError(`Two chord symbols at bar ${bar}, beat ${beat}`)
    frame.harmony = parseHarmony(chord)
  }
  const ids = new Set<string>()
  score.tracks.forEach((track, index) => {
    if (!track.id || ids.has(track.id) || !track.voice)
      throw new RangeError('Tracks need unique IDs and a voice name')
    ids.add(track.id)
    if (!Object.hasOwn(INSTRUMENT_DEFS, track.instrument))
      throw new RangeError(`Unknown instrument on ${track.id}`)
    if (track.pitchBasis && !['written', 'sounding'].includes(track.pitchBasis))
      throw new RangeError('Unknown pitchBasis')
    if (track.bars.length > starts.length) throw new RangeError(`Extra measures on ${track.id}`)
    let dynamic = track.dynamic?.trim()
    let missingDynamicReported = false
    starts.forEach((start, bar) => {
      const length = (starts[bar + 1] ?? total) - start
      let offset = 0
      let overrun: Location | undefined
      for (const event of track.bars[bar] ?? []) {
        if (
          !Number.isSafeInteger(event.ticks) ||
          event.ticks <= 0 ||
          !Number.isSafeInteger(offset + event.ticks)
        ) {
          throw new RangeError(`Invalid event duration on ${track.id} in bar ${bar + 1}`)
        }
        const where = { bar: bar + 1, beat: 1 + offset / ppb, trackId: track.id, voice: track.voice }
        const emit = (code: Diagnostic['code'], severity: Diagnostic['severity'], message: string) =>
          report.push({ code, severity, message, where })
        const pitches = event.pitches.map((name) => readPitch(name, track, where))
        if (event.dynamic?.trim()) dynamic = event.dynamic.trim()
        if (pitches.length && !dynamic && !missingDynamicReported) {
          emit('DYNAMICS_MISSING', 'warning', 'Set a dynamic before the first sounding note.')
          missingDynamicReported = true
        }
        checkInstrument(track, event, pitches, emit)
        if (offset < length) {
          at(start + offset).changes.set(
            index,
            pitches.length
              ? { start: start + offset, end: start + Math.min(offset + event.ticks, length), pitches }
              : undefined,
          )
        }
        offset += event.ticks
        if (offset > length) overrun ??= where
      }
      if (offset < length) at(start + offset).changes.set(index, undefined)
      if (offset !== length)
        report.push({
          code: 'BAR_DURATION',
          severity: 'error',
          message: `Expected ${length} ticks, found ${offset}.`,
          where: overrun ?? { bar: bar + 1, beat: 1 + offset / ppb, trackId: track.id, voice: track.voice },
        })
    })
  })
  return { starts, frames: [...frames].sort(([a], [b]) => a - b) }
}
