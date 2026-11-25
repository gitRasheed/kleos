import tone from '@tonejs/midi'
import wire from 'midi-file'
import type { MidiEvent } from 'midi-file'
import type { Controls, KeyChange, Performance } from './conductor.js'

const { Midi } = tone
const { parseMidi, writeMidi } = wire
const fifthsNames = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#']

function limit(value: number, low: number, high: number, field: string) {
  if (!Number.isInteger(value) || value < low || value > high) throw new RangeError('Invalid MIDI ' + field)
  return value
}

function trackEnd(events: MidiEvent[]) {
  return events.reduce((last, event) => last + event.deltaTime, 0)
}

export function writeMidiFile(score: Performance): Uint8Array {
  const midi = new Midi()
  limit(score.ppq, 1, 32767, 'PPQ')
  limit(score.endTick, 0, 0x0fffffff, 'score length')
  const tick = (value: number) => limit(value, 0, score.endTick, 'tick')
  const tempos = [...score.tempos].sort((a, b) => a.ticks - b.ticks)
  const micros = tempos.map((t) => limit(Math.round(60000000 / t.bpm), 1, 0xffffff, 'tempo'))
  for (const tempo of tempos) tick(tempo.ticks)
  for (const m of score.meters) {
    tick(m.ticks)
    limit(m.numerator, 1, 255, 'meter numerator')
    limit(Math.log2(m.denominator), 0, 15, 'meter denominator exponent')
  }
  const keys = [...score.keys].sort((a, b) => a.ticks - b.ticks)
  for (const key of keys) tick(key.ticks)
  midi.header.fromJSON({
    name: score.name,
    ppq: score.ppq,
    meta: [],
    tempos,
    timeSignatures: score.meters.map((m) => ({
      ticks: m.ticks,
      timeSignature: [m.numerator, m.denominator],
    })),
    keySignatures: keys.map((k) => ({
      ticks: k.ticks,
      key: fifthsNames[limit(k.fifths, -7, 7, 'fifths') + 7],
      scale: k.mode,
    })),
  })
  for (const part of score.tracks) {
    const track = midi.addTrack()
    track.name = part.name
    track.channel = limit(part.channel, 0, 15, 'channel')
    track.instrument.number = limit(part.program, 0, 127, 'program')
    for (const note of part.notes) {
      tick(note.ticks)
      tick(note.ticks + limit(note.durationTicks, 1, score.endTick, 'note duration'))
      limit(note.midi, 0, 127, 'note number')
      track.addNote({ ...note, velocity: limit(note.velocity, 1, 127, 'velocity') / 127 })
    }
    for (const cc of part.controls) {
      tick(cc.ticks)
      track.addCC({ ...cc, value: limit(cc.value, 0, 127, 'controller value') / 127 })
    }
  }
  const data = parseMidi(midi.toArray())
  let keyIndex = 0
  let tempoIndex = 0
  for (const event of data.tracks[0]) {
    if (event.type === 'setTempo') event.microsecondsPerBeat = micros[tempoIndex++]
    if (event.type === 'keySignature') event.key = keys[keyIndex++].fifths
  }
  const conductor = data.tracks[0]
  const last = conductor.at(-1)
  if (last?.type !== 'endOfTrack') throw new Error('Missing conductor end-of-track event')
  const latest = Math.max(...data.tracks.map(trackEnd))
  if (latest > score.endTick) throw new RangeError('MIDI event beyond score end')
  last.deltaTime += score.endTick - trackEnd(conductor)
  return Uint8Array.from(writeMidi(data))
}

export function readMidiFile(bytes: Uint8Array): Performance {
  const data = parseMidi(bytes)
  if (data.header.format !== 1 || !data.header.ticksPerBeat)
    throw new Error('Expected Type 1 MIDI with PPQ timing')
  const midi = new Midi(bytes)
  const keys: KeyChange[] = midi.header.keySignatures.map((k) => ({
    ticks: k.ticks,
    fifths: limit(fifthsNames.indexOf(k.key) - 7, -7, 7, 'fifths'),
    mode: k.scale === 'minor' ? 'minor' : 'major',
  }))
  // Keep one wire track per part, including parts that contain only controls or a patch.
  const tracks = data.tracks
    .filter((events) => events.some((e) => 'channel' in e))
    .map((events) => {
      const channels = new Set(events.flatMap((e) => ('channel' in e ? [e.channel] : [])))
      const programs = new Set(events.flatMap((e) => (e.type === 'programChange' ? [e.programNumber] : [])))
      if (channels.size !== 1 || programs.size > 1)
        throw new Error('Split multi-channel or multi-patch tracks before import')
      const fragment = writeMidi({ header: { ...data.header, format: 0, numTracks: 1 }, tracks: [events] })
      const [track] = new Midi(Uint8Array.from(fragment)).tracks
      const controls: Controls[] = ([1, 11] as const).flatMap((number) =>
        (track.controlChanges[number] ?? []).map((cc) => ({
          number,
          ticks: cc.ticks,
          value: Math.round(cc.value * 127),
        }))
      )
      controls.sort((a, b) => a.ticks - b.ticks || a.number - b.number)
      const notes = track.notes
        .map((n) => ({
          ticks: n.ticks,
          durationTicks: n.durationTicks,
          midi: n.midi,
          velocity: Math.round(n.velocity * 127),
        }))
        .sort((a, b) => a.ticks - b.ticks || a.midi - b.midi)
      return { name: track.name, channel: [...channels][0], program: [...programs][0] ?? 0, controls, notes }
    })
  return {
    name: midi.name,
    ppq: midi.header.ppq,
    endTick: Math.max(...data.tracks.map(trackEnd)),
    tracks,
    keys,
    tempos: midi.header.tempos.map(({ ticks, bpm }) => ({ ticks, bpm })),
    meters: midi.header.timeSignatures.map((t) => ({
      ticks: t.ticks,
      numerator: t.timeSignature[0],
      denominator: t.timeSignature[1],
    })),
  }
}
