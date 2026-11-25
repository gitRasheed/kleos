import test from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { parseAbc } from 'musicxml-io/abc'
import { serialize } from 'musicxml-io/musicxml'
import { readAbc, writeAbc } from '../../src/notation/abcBridge.js'
import { readMusicXml, writeMusicXml } from '../../src/notation/musicxmlBridge.js'
import { readPart } from '../../src/notation/conductor.js'
import { excerpt } from './excerpts.js'

function validateXml(input: string) {
  const result = spawnSync('xmllint', ['--nonet', '--noout', '--schema', 'tests/fixtures/standards/xsd/musicxml.xsd', '-'], {
    input,
    encoding: 'utf8',
    env: { ...process.env, XML_CATALOG_FILES: process.cwd() + '/tests/fixtures/standards/xsd/catalog.xml' },
  })
  if (result.error) throw result.error
  return result
}

for (const name of ['beethoven', 'mozart'] as const) {
  test(name + ' ABC → MusicXML 4.0 → ABC matches the source transcription at every note', () => {
    const { score, reference } = excerpt(name)
    delete score.metadata.miscellaneous
    const xml = writeMusicXml(score)
    const validation = validateXml(xml)
    assert.equal(validation.status, 0, validation.stderr)
    const external = readMusicXml(xml)
    for (const result of [score, external, readAbc(writeAbc(external))]) {
      assert.equal(result.parts.length, reference.length)
      result.parts.forEach((part, i) => {
        const want = reference[i]
        const attrs = part.measures[0].attributes
        assert.ok(attrs)
        const actual = readPart(part)
        const shift = attrs.transpose
        const names = result.partList.filter((p) => p.type === 'score-part')
        assert.equal(names[i].name, want.name)
        assert.equal((shift?.chromatic ?? 0) + 12 * (shift?.octaveChange ?? 0), want.transpose, want.name)
        assert.equal(attrs.key?.fifths, want.fifths, want.name)
        assert.deepEqual(
          [attrs.time?.beats, attrs.time?.beatType, attrs.time?.symbol],
          name === 'beethoven' ? ['2', 4, undefined] : ['2', 2, 'cut']
        )
        const barTicks = name === 'beethoven' ? 960 : 1920
        const bars = name === 'beethoven' ? 21 : 20
        assert.deepEqual(
          actual.bars,
          Array.from({ length: bars }, (_, i) => i * barTicks)
        )
        assert.equal(actual.endTick, bars * barTicks)
        assert.deepEqual(
          actual.notes.map((n) => [n.ticks, n.durationTicks, n.step, n.alter, n.octave, n.ties]),
          want.notes,
          want.name
        )
        assert.deepEqual([...new Set(actual.fermatas)], want.fermatas, want.name)
        assert.deepEqual(
          actual.dynamics.map((d) => [d.ticks, d.value]),
          want.dynamics,
          want.name
        )
      })
    }
  })
}

test('raw parser preserves cut time, fermata, dynamic and a single tie, but loses the transpose and truncates the name', () => {
  const input =
    'X:1\nT:Probe\nM:C|\nL:1/2\nV:a name="Horn in Eb" transpose=-9\nK:C\n[V:a] !p!C2- | !fermata!C2 |]'
  const native = parseAbc(input)
  const xml = serialize(native)
  assert.match(xml, /<time symbol="cut">/)
  assert.match(xml, /<fermata/)
  assert.match(xml, /<dynamics>/)
  assert.match(xml, /<tie type="stop"/)
  assert.match(xml, /<part-name>Horn<\/part-name>/)
  assert.doesNotMatch(xml, /<transpose>/)
  assert.match(writeMusicXml(readAbc(input)), /<chromatic>-9<\/chromatic>/)
  const validation = validateXml(xml)
  assert.notEqual(validation.status, 0)
  assert.match(validation.stderr, /attribute 'id'.*not allowed/)
})

test('raw ABC import drops alternate stops on a four-note chain', () => {
  const abc = 'X:1\nM:2/4\nL:1/2\nK:C\nC- | C- | C- | C |]'
  const native = readPart(parseAbc(abc).parts[0]).notes
  assert.deepEqual(
    native.map((n) => n.ties),
    [['start'], ['start', 'stop'], ['start'], ['stop']]
  )
  assert.deepEqual(readPart(readAbc(abc).parts[0]).notes[2].ties, ['start', 'stop'])
})

test('Beethoven opens in concert unison, and the D4 tie sounds once across bars 4 and 5', () => {
  const { played } = excerpt('beethoven')
  const violin = played.tracks.find((p) => p.name === 'Violins 1')
  assert.ok(violin)
  const clarinet = played.tracks.find((p) => p.name === 'Bb Clarinet 1')
  assert.ok(clarinet)
  assert.deepEqual(
    violin.notes.slice(0, 8).map((n) => n.midi),
    [67, 67, 67, 63, 65, 65, 65, 62]
  )
  assert.deepEqual(clarinet.notes.slice(0, 8), violin.notes.slice(0, 8))
  assert.equal(violin.notes[7].durationTicks, 1920)
  assert.equal(played.endTick, 20160)
})

test('Mozart has two viola lines on beat one and octave violin pickups on the last quarter', () => {
  const { played } = excerpt('mozart')
  const at = (name: string) => {
    const track = played.tracks.find(t => t.name === name)
    assert.ok(track)
    return track.notes[0]
  }
  assert.deepEqual(
    ['Viola 1', 'Viola 2', 'Violoncello', 'Contrabasso', 'Violino I', 'Violino II'].map((n) => [
      at(n).ticks,
      at(n).midi,
    ]),
    [
      [0, 58],
      [0, 55],
      [0, 43],
      [0, 31],
      [1440, 75],
      [1440, 63],
    ]
  )
  assert.equal(played.endTick, 38400)
})

test('a real short first measure places the next downbeat after the pickup', () => {
  const { bars } = readPart(readAbc('X:1\nM:C|\nL:1/8\nK:Gm\nE D | D8 |]').parts[0])
  assert.deepEqual(bars, [0, 480])
})

for (const name of ['beethoven', 'mozart'] as const) {
  test(
    name + ' independently engraved MusicXML → ABC → MusicXML keeps notes, bars, dynamics and holds',
    () => {
      const original = readMusicXml(readFileSync('tests/fixtures/standards/' + name + '.musicxml', 'utf8'))
      const result = readMusicXml(writeMusicXml(readAbc(writeAbc(original))))
      function events(part: (typeof original.parts)[number]) {
        const { notes, bars, dynamics, fermatas, endTick } = readPart(part)
        const pitches = notes
          .map((n) =>
            JSON.stringify([n.ticks, n.durationTicks, n.step, n.octave, n.alter, n.transpose, n.ties])
          )
          .sort()
        return { pitches, bars, dynamics, fermatas, endTick }
      }
      assert.deepEqual(result.parts.map(events), original.parts.map(events))
      assert.deepEqual(
        result.partList.filter((p) => p.type === 'score-part').map((p) => p.name),
        original.partList.filter((p) => p.type === 'score-part').map((p) => p.name)
      )
    }
  )
}

test('on a shared Mozart viola staff the ABC writer folds divisi voice IDs together', () => {
  const score = readMusicXml(readFileSync('tests/fixtures/standards/mozart.musicxml', 'utf8'))
  const restored = readAbc(writeAbc(score))
  const voices = (part: (typeof score.parts)[number]) => [
    ...new Set(readPart(part).notes.map((n) => n.voice)),
  ]
  assert.deepEqual(voices(score.parts[8]), ['1', '2'])
  assert.deepEqual(voices(restored.parts[8]), ['1'])
})
