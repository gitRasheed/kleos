import { isUtf8 } from 'node:buffer'
import wire from 'midi-file'
import type { MidiEvent } from 'midi-file'
import type { Performance, PerformanceTrack, PlayedNote } from './conductor.js'

function limit(value: number, low: number, high: number, field: string) {
  if (!Number.isInteger(value) || value < low || value > high) throw new RangeError('Invalid MIDI ' + field)
  return value
}

type TimedEvent = { ticks: number; event: MidiEvent }

function encodeTrack(events: TimedEvent[], endTick?: number) {
  let last = 0
  const track = events.sort((a, b) => a.ticks - b.ticks).map(({ ticks, event }) => {
    const deltaTime = ticks - last
    last = ticks
    return { ...event, deltaTime }
  })
  track.push({ deltaTime: (endTick ?? last) - last, type: 'endOfTrack' })
  return track
}

export function writeMidiFile(score: Performance): Uint8Array {
  const ppq = limit(score.ppq, 1, 32767, 'PPQ')
  limit(score.endTick, 0, 0x0fffffff, 'score length')
  const tick = (value: number) => limit(value, 0, score.endTick, 'tick')
  const named = (name: string): TimedEvent => ({ ticks: 0, event: { deltaTime: 0, type: 'trackName', text: Buffer.from(name).toString('latin1') } })
  const conductor = [named(score.name)]
  for (const { ticks, fifths, mode } of score.keys) conductor.push({ ticks: tick(ticks), event: {
    deltaTime: 0, type: 'keySignature', key: limit(fifths, -7, 7, 'fifths'), scale: mode === 'minor' ? 1 : 0,
  } })
  for (const { ticks, bpm } of score.tempos) conductor.push({ ticks: tick(ticks), event: {
    deltaTime: 0, type: 'setTempo', microsecondsPerBeat: limit(Math.round(60000000 / bpm), 1, 0xffffff, 'tempo'),
  } })
  for (const { ticks, numerator, denominator } of score.meters) {
    limit(Math.log2(denominator), 0, 15, 'meter denominator exponent')
    conductor.push({ ticks: tick(ticks), event: { deltaTime: 0, type: 'timeSignature',
      numerator: limit(numerator, 1, 255, 'meter numerator'), denominator, metronome: 24, thirtyseconds: 8 } })
  }
  const tracks = [encodeTrack(conductor, score.endTick)]
  for (const part of score.tracks) {
    const channel = limit(part.channel, 0, 15, 'channel')
    const events = [named(part.name)]
    events.push({ ticks: 0, event: { deltaTime: 0, type: 'programChange', channel, programNumber: limit(part.program, 0, 127, 'program') } })
    for (const note of [...part.notes].sort((a, b) => a.ticks - b.ticks)) {
      const noteNumber = limit(note.midi, 0, 127, 'note number')
      events.push({ ticks: tick(note.ticks), event: { deltaTime: 0, type: 'noteOn', channel, noteNumber, velocity: limit(note.velocity, 1, 127, 'velocity') } })
      events.push({ ticks: tick(note.ticks + limit(note.durationTicks, 1, score.endTick, 'note duration')), event: { deltaTime: 0, type: 'noteOff', channel, noteNumber, velocity: 0 } })
    }
    for (const cc of [...part.controls].sort((a, b) => a.number - b.number)) events.push({ ticks: tick(cc.ticks), event: { deltaTime: 0, type: 'controller', channel,
      controllerType: cc.number, value: limit(cc.value, 0, 127, 'controller value') } })
    tracks.push(encodeTrack(events))
  }
  return Uint8Array.from(wire.writeMidi({ header: { format: 1, ticksPerBeat: ppq, numTracks: tracks.length }, tracks }))
}

export function decodeMidi(bytes: Uint8Array) {
  try {
    const file = wire.parseMidi(bytes)
    if (file.tracks.length !== file.header.numTracks) throw new Error('Missing MIDI track')
    return file
  } catch (error) {
    if (error instanceof Error) throw error
    throw new Error(String(error))
  }
}

export function decodeTrack(events: MidiEvent[]) {
  const notes: (PlayedNote & { channel: number })[] = []
  const pending = new Map<number, { ticks: number; velocity: number }[]>()
  let ticks = 0, name = ''
  const timeline = events.map(event => {
    ticks += event.deltaTime
    if (event.type === 'trackName') {
      const bytes = Buffer.from(event.text, 'latin1')
      name = isUtf8(bytes) ? bytes.toString('utf8') : event.text
    }
    if (event.type === 'noteOn' || event.type === 'noteOff') {
      const key = event.channel * 128 + event.noteNumber
      const queue = pending.get(key) ?? []
      if (event.type === 'noteOn' && event.velocity > 0) {
        queue.push({ ticks, velocity: event.velocity })
        pending.set(key, queue)
      } else {
        const start = queue.shift()
        if (start) notes.push({ ...start, channel: event.channel, midi: event.noteNumber, durationTicks: ticks - start.ticks })
        if (!queue.length) pending.delete(key)
      }
    }
    return { ticks, event }
  })
  return { name, notes, timeline, endTick: ticks }
}

export function readMidiFile(bytes: Uint8Array): Performance {
  const { header, tracks } = decodeMidi(bytes)
  if (header.format !== 1 || !header.ticksPerBeat) throw new Error('Expected Type 1 MIDI with PPQ timing')
  const score: Performance = { name: '', ppq: header.ticksPerBeat, tracks: [], endTick: 0, tempos: [], keys: [], meters: [] }
  for (const [index, events] of tracks.entries()) {
    const { timeline, name, notes, endTick } = decodeTrack(events)
    if (index === 0) score.name = name
    score.endTick = Math.max(endTick, score.endTick)
    const channels = new Set<number>(), programs = new Set<number>()
    const controls: PerformanceTrack['controls'] = []
    for (const { ticks, event } of timeline) {
      if ('channel' in event && !('meta' in event)) channels.add(event.channel)
      switch (event.type) {
        case 'programChange': programs.add(event.programNumber); break
        case 'keySignature': score.keys.push({ ticks, fifths: limit(event.key, -7, 7, 'fifths'), mode: event.scale ? 'minor' : 'major' }); break
        case 'setTempo': score.tempos.push({ ticks, bpm: 60000000 / event.microsecondsPerBeat }); break
        case 'timeSignature': score.meters.push({ ticks, numerator: event.numerator, denominator: event.denominator }); break
        case 'controller':
          if (event.controllerType === 1 || event.controllerType === 11) controls.push({ ticks, number: event.controllerType, value: event.value })
      }
    }
    if (!channels.size) continue
    if (channels.size !== 1 || programs.size > 1) throw new Error('Split multi-channel or multi-patch tracks before import')
    controls.sort((a, b) => a.ticks - b.ticks || a.number - b.number)
    notes.sort((a, b) => a.ticks - b.ticks || a.midi - b.midi)
    score.tracks.push({ name, channel: [...channels][0], program: [...programs][0] ?? 0, controls,
      notes: notes.map(({ ticks, durationTicks, midi, velocity }) => ({ ticks, durationTicks, midi, velocity })) })
  }
  for (const changes of [score.keys, score.tempos, score.meters]) changes.sort((a, b) => a.ticks - b.ticks)
  return score
}
