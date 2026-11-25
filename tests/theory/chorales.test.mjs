import test from 'node:test'
import assert from 'node:assert/strict'
import { lintScore } from 'agent-audio'

const track = (id, instrument, notes) => ({
  id,
  voice: id,
  instrument,
  dynamic: 'mf',
  bars: notes.map((pitch) => [{ ticks: 4, pitches: [pitch] }]),
})
const location = (bar, voice) => ({ bar, beat: 1, voice, trackId: voice })
const score = (tracks) => ({
  style: 'strict',
  ticksPerBeat: 1,
  beatsPerBar: tracks[0].bars.map(() => 4),
  tracks,
})

test('strict chorale locates seven moving perfect intervals and the crossed low violin', () => {
  const bad = score([
    track('soprano', 'violin-I', ['G4', 'A4', 'G4', 'A4', 'G5', 'A5', 'G5', 'A5', 'G5', 'G2']),
    track('alto', 'violin-II', ['C4', 'D4', 'C4', 'D4', 'G4', 'A4', 'G4', 'A4', 'G4', 'G4']),
    track('tenor', 'viola', Array(10).fill('C4')),
    track('bass', 'cello', Array(10).fill('C3')),
  ])
  const result = lintScore(bad)
  const actual = (code) => result.filter((d) => d.code === code).map((d) => [d.severity, d.where])
  assert.deepEqual(
    actual('PARALLEL_FIFTH'),
    [2, 3, 4].map((bar) => ['error', location(bar, 'alto')]),
  )
  assert.deepEqual(
    actual('PARALLEL_OCTAVE'),
    [6, 7, 8, 9].map((bar) => ['error', location(bar, 'alto')]),
  )
  assert.deepEqual(actual('RANGE_HARD'), [['error', location(10, 'soprano')]])
  assert.ok(result.some((d) => d.code === 'VOICE_CROSSING' && d.severity === 'error'))
  assert.deepEqual(
    [...new Set(result.filter((d) => d.code === 'VOICE_CROSSING').map((d) => d.where.bar))],
    [10],
  )
})

test('four-part I-IV-V7-I cadence is clean in strict style', () => {
  const clean = score([
    track('soprano', 'violin-I', ['E5', 'F5', 'D5', 'C5']),
    track('alto', 'violin-II', ['C5', 'C5', 'B4', 'C5']),
    track('tenor', 'viola', ['G4', 'A4', 'F4', 'E4']),
    track('bass', 'cello', ['C3', 'F3', 'G3', 'C3']),
  ])
  clean.tonic = 'C'
  clean.harmony = ['C', 'F', 'G7', 'C'].map((chord, i) => ({ bar: i + 1, beat: 1, chord }))
  assert.deepEqual(lintScore(clean), [])
})
