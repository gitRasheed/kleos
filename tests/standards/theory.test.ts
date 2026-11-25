import test from 'node:test'
import assert from 'node:assert/strict'
import { Chord, Interval, Key, Mode, Note, Progression, RomanNumeral, Scale } from 'tonal'
import { excerpt } from './excerpts.js'
import { readPart } from '../../src/notation/conductor.js'

test('key, mode, scale and harmony queries retain C minor and G minor spelling', () => {
  assert.equal(Key.minorKey('C').keySignature, 'bbb')
  assert.equal(Key.minorKey('G').keySignature, 'bb')
  assert.equal(Mode.get('minor').name, 'aeolian')
  assert.deepEqual(Scale.get('C harmonic minor').notes, ['C', 'D', 'Eb', 'F', 'G', 'Ab', 'B'])
  assert.deepEqual(Chord.get('Gm').notes, ['G', 'Bb', 'D'])
  assert.equal(RomanNumeral.get('V7').interval, '5P')
  assert.deepEqual(Progression.fromRomanNumerals('G', ['i', 'bIII', 'V7']), ['Gm', 'Bb', 'D7'])
  assert.equal(Key.minorKey('G').harmonic.chords[4], 'D7')
})

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

test('Roman numeral parsing accepts arbitrary chord suffixes and progression degrees use a major-scale reference', () => {
  assert.equal(RomanNumeral.get('invalid').chordType, 'nvalid')
  assert.equal(Chord.get('Cnvalid').empty, true)
  assert.deepEqual(Progression.fromRomanNumerals('C', ['III', 'bIII']), ['E', 'Eb'])
})
