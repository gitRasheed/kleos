import test from 'node:test'
import assert from 'node:assert/strict'
import * as Interval from '@tonaljs/interval'
import * as Note from '@tonaljs/note'
import { excerpt } from './excerpts.js'
import { readPart } from '../../src/notation/conductor.js'

test('written clarinet transposition and the descending Mozart pickup agree with the parsed parts', () => {
  const { score, played } = excerpt('beethoven')
  const index = played.tracks.findIndex((t) => t.name === 'Bb Clarinet 1')
  const clarinet = readPart(score.parts[index]).notes[0]
  assert.equal(
    Note.midi(Note.transpose(clarinet.step + clarinet.octave, '-2M')),
    played.tracks[index].notes[0].midi
  )
  const violin = excerpt('mozart').played.tracks.find((t) => t.name === 'Violino I')
  assert.ok(violin)
  assert.deepEqual(
    violin.notes.slice(0, 2).map((n) => n.midi),
    ['Eb5', 'D5'].map(Note.midi)
  )
  assert.equal(Interval.distance('Eb5', 'D5'), '-2m')
})
