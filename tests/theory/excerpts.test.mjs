import test from 'node:test'
import assert from 'node:assert/strict'
import { lintScore } from 'kleos'

const note = (pitch, ticks) => ({ pitches: pitch ? [pitch] : [], ticks })
function beethovenPart(id, instrument, g, eb, pitchBasis = 'sounding') {
  return {
    id,
    voice: id,
    instrument,
    pitchBasis,
    doublingGroup: 'motto',
    dynamic: 'ff',
    bars: [[note(null, 1), note(g, 1), note(g, 1), note(g, 1)], [note(eb, 4)]],
  }
}
function beethoven() {
  return {
    style: 'free',
    ticksPerBeat: 2,
    beatsPerBar: [2, 2],
    tracks: [
      beethovenPart('cl', 'clarinet-Bb', 'A4', 'F4', 'written'),
      beethovenPart('v1', 'violin-I', 'G4', 'Eb4'),
      beethovenPart('v2', 'violin-II', 'G4', 'Eb4'),
      beethovenPart('va', 'viola', 'G3', 'Eb3'),
      beethovenPart('vc', 'cello', 'G2', 'Eb2'),
    ],
  }
}
function mozartViolin(instrument, octave) {
  const eb = 'Eb' + octave,
    d = 'D' + octave
  return {
    id: instrument,
    voice: instrument,
    instrument,
    dynamic: 'p',
    doublingGroup: 'theme',
    bars: [
      [note(null, 6), note(eb, 1), note(d, 1)],
      [note(d, 2), note(eb, 1), note(d, 1), note(d, 2), note(eb, 1), note(d, 1)],
    ],
  }
}
function mozart() {
  return {
    style: 'free',
    ticksPerBeat: 2,
    beatsPerBar: [4, 4],
    tracks: [
      { id: 'fl', voice: 'flute', instrument: 'flute', bars: [[note(null, 8)], [note(null, 8)]] },
      mozartViolin('violin-I', 5),
      mozartViolin('violin-II', 4),
      {
        id: 'vc',
        voice: 'bass',
        instrument: 'cello',
        dynamic: 'p',
        bars: [
          [note('G2', 2), note(null, 6)],
          [note('G3', 2), note(null, 6)],
        ],
      },
    ],
  }
}

test('Beethoven 5/I bars 1–2: the clarinet and string motto reduces to one voice', () => {
  const score = beethoven()
  assert.deepEqual(lintScore(score), [])
  const octaves = lintScore({ ...score, style: 'strict' }).filter((d) => d.code === 'PARALLEL_OCTAVE')
  assert.equal(octaves.length, 10)
  assert.ok(octaves.every((d) => d.severity === 'error' && d.where.bar === 2 && d.where.beat === 1))
})
test('Mozart 40/I bars 1–2: the octave melody stays clean through repeated notes and rests', () => {
  assert.deepEqual(lintScore(mozart()), [])
})
test('a Mozart inner part that breaks away in parallel fifths warns on the second eighth', () => {
  const score = mozart()
  const part = score.tracks[2]
  part.bars[0][1] = note('Ab4', 1)
  part.bars[0][2] = note('G4', 1)
  const issues = lintScore(score)
  assert.deepEqual(
    issues.map(({ code, severity, where }) => ({ code, severity, where })),
    [
      {
        code: 'PARALLEL_FIFTH',
        severity: 'warning',
        where: { bar: 1, beat: 4.5, trackId: 'violin-II', voice: 'violin-II' },
      },
    ],
  )
})
test('a flute below C4 remains a hard error in free style', () => {
  const score = mozart()
  score.tracks[0].bars[0] = [note(null, 6), { ...note('B3', 2), dynamic: 'p' }]
  const result = lintScore(score).filter((d) => d.severity === 'error')
  assert.deepEqual(
    result.map(({ code, where }) => [code, where]),
    [['RANGE_HARD', { bar: 1, beat: 4, voice: 'flute', trackId: 'fl' }]],
  )
})
