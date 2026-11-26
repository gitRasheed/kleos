import { readAbc } from '../../src/notation/abcBridge.js'
import { performance } from '../../src/notation/conductor.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import tone from '@tonejs/midi'
import wire from 'midi-file'
import { readMidiFile, writeMidiFile } from '../../src/notation/midiBridge.js'
import { dawNotes } from '../../src/notation/conductor.js'
import { excerpt } from './excerpts.js'

test('direct SMF export writes the wrong signed key byte for C minor', () => {
  const midi = new tone.Midi()
  midi.header.keySignatures = [{ ticks: 0, key: 'Eb', scale: 'minor' }]
  const bytes = midi.toArray()
  const key = wire.parseMidi(bytes).tracks[0].find((e) => e.type === 'keySignature')
  assert.equal(key?.key, 11)
  assert.equal(new tone.Midi(bytes).header.keySignatures[0].key, undefined)
})

for (const name of ['beethoven', 'mozart'] as const) {
  test(
    name +
      ' retains all sounding notes, patches, tempo/meter/key changes and CC1/CC11 in independent SMF decode',
    () => {
      const { played } = excerpt(name)
      const fifths = played.keys[0].fifths
      const meter = played.meters[0]
      played.tempos = [
        { ticks: 0, bpm: 120 },
        { ticks: 1920, bpm: 80 },
        { ticks: 2880, bpm: 150 },
      ]
      played.keys.push({ ticks: 3840, fifths: 3, mode: 'major' })
      played.meters.push({ ticks: 3840, numerator: 6, denominator: 8 })
      const track = played.tracks.find((t) => t.name.includes('Violin'))
      assert.ok(track)
      track.controls = [
        { ticks: 0, number: 1, value: 20 },
        { ticks: 0, number: 11, value: 63 },
        { ticks: 240, number: 1, value: 42 },
        { ticks: 480, number: 11, value: 96 },
        { ticks: 960, number: 11, value: 127 },
      ]
      const bytes = writeMidiFile(played)
      const raw = wire.parseMidi(bytes)
      assert.deepEqual(raw.header, { format: 1, numTracks: played.tracks.length + 1, ticksPerBeat: 480 })
      assert.deepEqual(
        raw.tracks[0].filter((e) => e.type === 'keySignature').map((e) => [e.key, e.scale]),
        [
          [fifths, 1],
          [3, 0],
        ]
      )
      assert.deepEqual(
        raw.tracks[0].filter((e) => e.type === 'timeSignature').map((e) => [e.numerator, e.denominator]),
        [
          [meter.numerator, meter.denominator],
          [6, 8],
        ]
      )
      const decoded = new tone.Midi(bytes)
      assert.equal(decoded.header.ticksToSeconds(2880), 3.5)
      assert.deepEqual(
        decoded.header.tempos.map((t) => t.ticks),
        [0, 1920, 2880]
      )
      const wireTrack = raw.tracks[played.tracks.indexOf(track) + 1]
      let tick = 0
      assert.deepEqual(
        wireTrack.flatMap((e) => {
          tick += e.deltaTime
          return e.type === 'controller' ? [[tick, e.controllerType, e.value, e.channel]] : []
        }),
        track.controls.map((c) => [c.ticks, c.number, c.value, track.channel])
      )
      assert.deepEqual(readMidiFile(bytes), played)
      assert.deepEqual(dawNotes(track, 480)[0], {
        midi: track.notes[0].midi,
        velocity: track.notes[0].velocity,
        startBeat: name === 'mozart' ? 3 : 0.5,
        durationBeats: 0.5,
        articulation: 'normal',
      })
    }
  )
}

test('standalone SMF input keeps a nondefault PPQ and a control-only channel', () => {
  const bytes = wire.writeMidi({
    header: { format: 1, numTracks: 2, ticksPerBeat: 96 },
    tracks: [
      [
        { deltaTime: 0, type: 'keySignature', key: -2, scale: 1 },
        { deltaTime: 384, type: 'endOfTrack' },
      ],
      [
        { deltaTime: 12, type: 'controller', channel: 6, controllerType: 11, value: 72 },
        { deltaTime: 0, type: 'endOfTrack' },
      ],
    ],
  })
  const p = readMidiFile(Uint8Array.from(bytes))
  assert.equal(p.tracks[0].channel, 6)
  assert.equal(p.endTick, 384)
  assert.equal(p.ppq, 96)
  assert.deepEqual(p.keys, [{ ticks: 0, fifths: -2, mode: 'minor' }])
  assert.deepEqual(readMidiFile(writeMidiFile(p)), p)
})

test('track names retain UTF-8 and legacy single-byte accents', () => {
  const { played } = excerpt('mozart')
  played.tracks[0].name = 'Flûte Ⅰ'
  assert.equal(readMidiFile(writeMidiFile(played)).tracks[0].name, 'Flûte Ⅰ')
  const data = wire.parseMidi(writeMidiFile(played))
  const name = data.tracks[1].find(e => e.type === 'trackName')
  assert.ok(name)
  name.text = 'Flûte'
  assert.equal(readMidiFile(Uint8Array.from(wire.writeMidi(data))).tracks[0].name, 'Flûte')
})

test('import/export preserves the original 400008 microseconds per quarter exactly', () => {
  const data = wire.writeMidi({
    header: { format: 1, numTracks: 1, ticksPerBeat: 480 },
    tracks: [
      [
        { deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 400008 },
        { deltaTime: 480, type: 'endOfTrack' },
      ],
    ],
  })
  const bytes = Uint8Array.from(data)
  const tempo = (input: Uint8Array) =>
    wire.parseMidi(input).tracks[0].find((e) => e.type === 'setTempo')?.microsecondsPerBeat
  assert.equal(tempo(new tone.Midi(bytes).toArray()), 400007)
  assert.equal(tempo(writeMidiFile(readMidiFile(bytes))), 400008)
})

test('an ABC change of key, meter and tempo lands on the same MIDI tick', () => {
  const notation = readAbc('X:1\nM:2/4\nL:1/4\nQ:1/4=120\nK:Cm\nC D | [M:3/4][K:Gm][Q:1/4=80]G A B |]')
  const p = performance(
    notation,
    { ticks: 0, fifths: -3, mode: 'minor' },
    new Map([['Music', { program: 0, channel: 0 }]])
  )
  const q = readMidiFile(writeMidiFile(p))
  assert.deepEqual(q.keys[1], { ticks: 960, fifths: -2, mode: 'minor' })
  assert.deepEqual(q.meters[1], { ticks: 960, numerator: 3, denominator: 4 })
  assert.deepEqual(q.tempos[1], { ticks: 960, bpm: 80 })
})
