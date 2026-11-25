import test from 'node:test'
import assert from 'node:assert/strict'
import { INSTRUMENT_DEFS, lintScore } from 'agent-audio'

const event = (ticks, ...pitches) => ({ ticks, pitches })
const line = (id, ...events) => ({ id, voice: id, instrument: 'piano', dynamic: 'p', bars: [events] })
const score = (...tracks) => ({ style: 'strict', ticksPerBeat: 2, beatsPerBar: [4], tracks })
const at = (code, severity, beat, trackId, bar = 1) => [code, severity, bar, beat, trackId, trackId]
const fields = (result) =>
  result.map(({ code, severity, where }) => [
    code,
    severity,
    where.bar,
    where.beat,
    where.voice,
    where.trackId,
  ])
const checked = (input) => fields(lintScore(input))

test('short bars locate the gap, long bars locate the first overflowing event', () => {
  const a = line('a', event(5, 'D4')),
    b = line('b', event(6, 'C4'), event(3, 'C4'))
  assert.deepEqual(checked(score(a, b)), [
    at('BAR_DURATION', 'error', 3.5, 'a'),
    at('BAR_DURATION', 'error', 4, 'b'),
  ])
})
test('a missing bar is an empty measure and a pickup uses its declared length', () => {
  assert.deepEqual(checked({ ...score(line('a', event(1))), beatsPerBar: [0.5, 4] }), [
    at('BAR_DURATION', 'error', 1, 'a', 2),
  ])
})
test('flute range boundaries and a simultaneous dyad retain physical severity in free style', () => {
  const a = line('fl', event(2, 'C4'), event(2, 'D4'), event(2, 'B3', 'E4'), event(2, 'D7'))
  a.instrument = 'flute'
  assert.deepEqual(checked({ ...score(a), style: 'free' }), [
    at('RANGE_EXTREME', 'warning', 1, 'fl'),
    at('POLYPHONY', 'error', 3, 'fl'),
    at('RANGE_HARD', 'error', 3, 'fl'),
    at('RANGE_EXTREME', 'warning', 4, 'fl'),
  ])
})
test('the table transposes a written clarinet E3 to sounding D3 exactly once', () => {
  const a = line('cl', event(4, 'E3'), event(4, 'Eb3'))
  a.instrument = 'clarinet-Bb'
  const written = lintScore({ ...score({ ...a, pitchBasis: 'written' }) })
  assert.deepEqual(fields(written), [
    at('RANGE_EXTREME', 'warning', 1, 'cl'),
    at('RANGE_HARD', 'error', 3, 'cl'),
  ])
  assert.match(written[0].message, /D3/)
  assert.match(written[1].message, /Db3/)
  assert.deepEqual(checked(score(a)), [at('RANGE_EXTREME', 'warning', 3, 'cl')])
})
test('dynamics start at the first sounding note and persist through rests and measures', () => {
  const a = line('a', event(2), event(6, 'E4'))
  delete a.dynamic
  a.bars.push([event(2, 'E4'), { ...event(2, 'G4'), dynamic: 'mf' }, event(4, 'D4')])
  assert.deepEqual(checked({ ...score(a), beatsPerBar: [4, 4] }), [at('DYNAMICS_MISSING', 'warning', 2, 'a')])
  a.bars[0][0].dynamic = 'pp'
  assert.deepEqual(checked({ ...score(a), beatsPerBar: [4, 4] }), [])
})
test('pizzicato and a double stop are supported on a violin', () => {
  const a = line('vn', { ...event(8, 'G4', 'D5'), articulations: ['pizzicato'] })
  a.instrument = 'violin-I'
  assert.deepEqual(checked(score(a)), [])
  a.instrument = 'oboe'
  assert.deepEqual(checked(score(a)), [
    at('ARTICULATION_UNSUPPORTED', 'warning', 1, 'vn'),
    at('POLYPHONY', 'error', 1, 'vn'),
  ])
})
test('upper voices may span one octave, tenor to bass may span two', () => {
  const parts = [
    line('s', event(8, 'C6')),
    line('a', event(8, 'B4')),
    line('t', event(8, 'B3')),
    line('b', event(8, 'B1')),
  ]
  assert.deepEqual(checked(score(...parts)), [at('SPACING', 'error', 1, 'a')])
  assert.deepEqual(checked({ ...score(...parts), style: 'free' }), [at('SPACING', 'warning', 1, 'a')])
})
test('crossing is located on the first crossed note, including a crossing against a held voice', () => {
  const input = score(line('a', event(8, 'E4')), line('b', event(2, 'D4'), event(6, 'F4')))
  assert.deepEqual(checked(input), [at('VOICE_CROSSING', 'error', 2, 'b')])
  assert.deepEqual(checked({ ...input, style: 'free' }), [at('VOICE_CROSSING', 'warning', 2, 'b')])
})
test('a small bass interval warns within a chord as well as between parts', () => {
  assert.deepEqual(checked(score(line('pno', event(4, 'C2', 'E2'), event(4, 'C3', 'E3')))), [
    at('LOW_INTERVAL', 'warning', 1, 'pno'),
  ])
  assert.deepEqual(checked(score(line('a', event(8, 'Eb2')), line('b', event(8, 'C2')))), [
    at('LOW_INTERVAL', 'warning', 1, 'b'),
  ])
})
test('leading tones preserve spelling and tagged doublings collapse only in free style', () => {
  const parts = [line('a', event(8, 'F#5')), line('b', event(8, 'F#4'))].map((t) => ({
    ...t,
    doublingGroup: 'melody',
  }))
  const input = { ...score(...parts), tonic: 'G' }
  assert.deepEqual(checked(input), [at('DOUBLED_LEADING_TONE', 'error', 1, 'b')])
  assert.deepEqual(checked({ ...input, style: 'free' }), [])
  parts[1].bars[0][0] = event(8, 'Gb4')
  assert.deepEqual(checked(input), [])
})
test('a held chordal seventh can resolve after the chord change', () => {
  const t = line('a', event(6, 'F4'), event(2, 'E4'))
  const input = {
    ...score(t),
    harmony: [
      { bar: 1, beat: 1, chord: 'G7/B' },
      { bar: 1, beat: 3, chord: 'C' },
    ],
  }
  assert.deepEqual(checked(input), [at('HARMONY_MISMATCH', 'warning', 3, 'a')])
  t.bars[0][1] = event(2, 'G4')
  assert.deepEqual(checked(input), [
    at('HARMONY_MISMATCH', 'warning', 3, 'a'),
    at('UNRESOLVED_SEVENTH', 'error', 4, 'a'),
  ])
  t.bars[0][1] = event(2)
  assert.deepEqual(checked({ ...input, style: 'free' }), [
    at('HARMONY_MISMATCH', 'warning', 3, 'a'),
    at('UNRESOLVED_SEVENTH', 'warning', 4, 'a'),
  ])
})
test('unrelated subdivisions do not repeat a sustained vertical warning', () => {
  const a = line('a', event(8, 'D5')),
    b = line('b', event(2, 'C4'), event(2, 'E4'), event(4, 'G4'))
  assert.deepEqual(checked({ ...score(a, b), harmony: [{ bar: 1, beat: 1, chord: 'C' }] }), [
    at('HARMONY_MISMATCH', 'warning', 1, 'a'),
  ])
})
test('rests and intervening oblique motion break parallel fifths', () => {
  const a = line('a', event(2, 'G4'), event(1), event(2, 'A4'), event(3, 'B4'))
  const b = line('b', event(3, 'C4'), event(3, 'D4'), event(2, 'E4'))
  assert.deepEqual(checked(score(a, b)), [])
})
test('spelled diminished sixths are distinct from perfect fifths', () => {
  assert.deepEqual(
    checked(score(line('a', event(4, 'Abb4'), event(4, 'Bbb4')), line('b', event(4, 'C4'), event(4, 'D4')))),
    [],
  )
})
test('untagged octaves remain visible and each tagged section contributes once to parallel fifths', () => {
  const a = line('a', event(4, 'G5'), event(4, 'A5')),
    b = line('b', event(4, 'G4'), event(4, 'A4'))
  const c = line('c', event(4, 'C4'), event(4, 'D4'))
  assert.deepEqual(checked({ ...score(a, b), style: 'free' }), [at('PARALLEL_OCTAVE', 'warning', 3, 'b')])
  assert.deepEqual(
    checked({ ...score({ ...a, doublingGroup: 'g' }, { ...b, doublingGroup: 'g' }, c), style: 'free' }),
    [at('PARALLEL_FIFTH', 'warning', 3, 'c')],
  )
})
test('orchestral and DAW instrument profiles have nested ranges, valid MIDI programs and articulations', () => {
  assert.deepEqual(
    Object.keys(INSTRUMENT_DEFS).sort(),
    [
      'brass-horn', 'brass-trumpet', 'strings-ensemble', 'strings-cello', 'strings-bass',
      'guitar-electric', 'guitar-acoustic', 'orchestral-perc', 'synth-pad', 'synth-bass', 'cinematic-sfx', 'sf2',
      'violin-I',
      'violin-II',
      'viola',
      'cello',
      'contrabass',
      'flute',
      'oboe',
      'clarinet-Bb',
      'bassoon',
      'horn-F',
      'horn-Eb',
      'trumpet-C',
      'trombone',
      'tuba',
      'timpani',
      'piano',
    ].sort(),
  )
  for (const def of Object.values(INSTRUMENT_DEFS)) {
    const [lo, hi] = def.soundingRange,
      [c, d] = def.comfortableRange
    assert.ok(0 <= lo && lo <= c && c <= d && d <= hi && hi <= 127)
    assert.ok(def.gmProgram >= 0 && def.gmProgram <= 127 && def.articulations.length)
  }
  assert.deepEqual(
    ['clarinet-Bb', 'contrabass', 'horn-F', 'horn-Eb', 'trumpet-C'].map(
      (id) => INSTRUMENT_DEFS[id].transpositionSemitones,
    ),
    [-2, -12, -7, -9, 0],
  )
})
test('invalid chronology, unknown chords, ambiguous pitches and duplicate track IDs fail at the boundary', () => {
  const a = line('a', event(8, 'C4'))
  assert.throws(() => lintScore(score(a, a)), /unique IDs/)
  assert.throws(() => lintScore(score(line('a', event(8, 'C')))), /Invalid pitch/)
  assert.throws(() => lintScore(score(line('a', event(0, 'C4')))), /duration/)
  assert.throws(
    () => lintScore({ ...score(a), harmony: [{ bar: 1, beat: 1, chord: 'NOCHORD' }] }),
    /Unknown chord/,
  )
  assert.throws(() => lintScore({ ...score(a), harmony: [{ bar: 1, beat: 4.75, chord: 'C' }] }), /location/)
  assert.throws(() => lintScore({ ...score(a), tonic: 'G4' }), /tonic/)
})
test('two sections that abandon the same doubled seventh produce one warning, including into a rest', () => {
  const a = { ...line('a', event(4, 'F5'), event(4)), doublingGroup: 'g' }
  const b = { ...line('b', event(4, 'F4'), event(4)), doublingGroup: 'g' }
  const input = { ...score(a, b), style: 'free', harmony: [{ bar: 1, beat: 1, chord: 'G7' }] }
  assert.deepEqual(checked(input), [at('UNRESOLVED_SEVENTH', 'warning', 3, 'a')])
  a.bars[0][1] = event(4, 'G5')
  b.bars[0][1] = event(4, 'G4')
  assert.deepEqual(checked(input), [at('UNRESOLVED_SEVENTH', 'warning', 3, 'a')])
  b.bars[0][1] = event(4, 'E4')
  input.harmony.push({ bar: 1, beat: 3, chord: 'C' })
  assert.deepEqual(checked(input), [at('UNRESOLVED_SEVENTH', 'warning', 3, 'a')])
})
test('diagnostic beat values round-trip into chord annotations on a triplet grid', () => {
  const part = line('a', event(1), event(2, 'D4'))
  const input = { ...score(part), ticksPerBeat: 3, beatsPerBar: [1] }
  delete part.dynamic
  const [{ where }] = lintScore(input)
  assert.equal(where.beat, 1 + 1 / 3)
  input.harmony = [{ bar: where.bar, beat: where.beat, chord: 'C' }]
  assert.deepEqual(checked(input), [
    at('DYNAMICS_MISSING', 'warning', where.beat, 'a'),
    at('HARMONY_MISMATCH', 'warning', where.beat, 'a'),
  ])
})
