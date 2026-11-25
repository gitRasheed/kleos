import { parseAbcTunes, serializeAbc } from 'musicxml-io/abc'
import type { Part, Score } from 'musicxml-io/musicxml'

// ABC supplies semitones only. Choose a conventional diatonic spelling on XML export.
function transposition(semitones: number) {
  const octaveChange = Math.trunc(semitones / 12)
  const chromatic = semitones % 12
  const steps = [0, 1, 1, 2, 2, 3, 3, 4, 5, 5, 6, 6]
  return { diatonic: Math.sign(chromatic) * steps[Math.abs(chromatic)], chromatic, octaveChange }
}

function restoreTieStops(part: Part) {
  let cursor = 0
  let chordStart = 0
  const ends = new Map<string, number>()
  for (const measure of part.measures) {
    for (const note of measure.entries) {
      if (note.type === 'backup') cursor -= note.duration
      if (note.type === 'forward') cursor += note.duration
      if (note.type !== 'note' || note.grace) continue
      if (!note.chord) {
        chordStart = cursor
        cursor += note.duration
      }
      if (!note.pitch) continue
      const { step, octave, alter = 0 } = note.pitch
      const id = [note.voice, step, octave, alter].join('/')
      if (ends.get(id) === chordStart && !note.ties?.some((t) => t.type === 'stop')) {
        const stop = { type: 'stop' } as const
        note.ties = [stop, ...(note.ties ?? [])]
        note.tie = stop
        note.notations = [...(note.notations ?? []), { type: 'tied', tiedType: 'stop' }]
      }
      if (note.ties?.some((t) => t.type === 'start')) ends.set(id, chordStart + note.duration)
      else ends.delete(id)
    }
  }
}

export function readAbc(text: string): Score {
  const tunes = parseAbcTunes(text)
  if (tunes.length !== 1) throw new Error('Expected one ABC tune')
  const score = tunes[0]
  const headers = new Map<string, { shift: number; name: string | undefined }>()
  for (const line of text.split(/\r?\n/)) {
    const voice = /^V:\s*(\S+)/.exec(line)
    const shift = /(?:^|\s)transpose=([+-]?\d+)(?=\s|$)/.exec(line)
    if (voice) {
      const old = headers.get(voice[1])
      const name = /(?:^|\s)name="([^"]*)"/.exec(line)?.[1] ?? old?.name
      headers.set(voice[1], { shift: shift ? Number(shift[1]) : (old?.shift ?? 0), name })
    }
  }
  const ids = score.metadata.miscellaneous?.find((field) => field.name === 'abc-voice-ids')
  const order: string[] = ids ? JSON.parse(ids.value) : [...headers.keys()]
  score.parts.forEach((part, index) => {
    for (const measure of part.measures) {
      let atStart = true
      measure.entries = measure.entries.filter((entry) => {
        if (entry.type === 'note') atStart = false
        if (!atStart || entry.type !== 'direction' || entry.directionTypes.length !== 1) return true
        const [field] = entry.directionTypes
        if (field.kind !== 'words' || !/^\[K:.*\]$/.test(field.text) || !measure.attributes?.key) return true
        if (field.text === '[K:none]') measure.attributes.key.mode = 'none'
        return false
      })
    }
    restoreTieStops(part)
    const header = headers.get(order[index])
    const shift = header?.shift
    const info = score.partList.find((p) => p.type === 'score-part' && p.id === part.id)
    if (info?.type === 'score-part' && header?.name) info.name = header.name
    const attrs = part.measures[0]?.attributes
    if (attrs && shift) attrs.transpose = transposition(shift)
  })
  return score
}

export function writeAbc(score: Score): string {
  const metadata = {
    ...score.metadata,
    miscellaneous: score.metadata.miscellaneous?.filter((f) => !f.name.startsWith('abc-')) ?? [],
  }
  const output = serializeAbc({ ...score, metadata })
  const voices = [...new Set(Array.from(output.matchAll(/^V:\s*(\S+)/gm), (match) => match[1]))]
  if (!voices.length && score.parts.length === 1) voices.push('1')
  if (voices.length !== score.parts.length) throw new Error('Expected one ABC voice per part')
  const declarations = voices.map((id, i) => {
    const part = score.parts[i]
    const info = score.partList.find((p) => p.type === 'score-part' && p.id === part.id)
    const name = info?.type === 'score-part' ? (info.name ?? id) : id
    if (/["\r\n]/.test(name)) throw new Error('Unsupported character in ABC part name')
    const attrs = part.measures[0]?.attributes
    const shift = attrs?.transpose
    const semitones = shift ? shift.chromatic + 12 * (shift.octaveChange ?? 0) : 0
    const clef = attrs?.clef?.[0]?.sign
    return (
      'V:' +
      id +
      ' name="' +
      name +
      '"' +
      (clef === 'F' ? ' clef=bass' : clef === 'C' ? ' clef=alto' : '') +
      (semitones ? ' transpose=' + semitones : '')
    )
  })
  const lines = output.trimEnd().split('\n')
  const key = lines.findIndex((line) => line.startsWith('K:'))
  if (key < 0) throw new Error('Missing ABC key field')
  const header = lines.slice(0, key).filter((line) => !line.startsWith('V:'))
  if (!header.includes('%abc-2.1')) header.unshift('%abc-2.1')
  let index = 0
  const firstLine = new Set<number>()
  const body = lines.slice(key + 1).map((line) => {
    const voice = /^V:(\S+)/.exec(line)
    if (voice) {
      index = voices.indexOf(voice[1])
      return 'V:' + voice[1]
    }
    if (!line || firstLine.has(index)) return line
    firstLine.add(index)
    if (score.parts[index]?.measures[0]?.attributes?.key?.mode !== 'none') return line
    return '[K:none]' + line.replace(/^\[K:[^\]]+\]/, '')
  })
  return [...header, ...declarations, lines[key], ...body, ''].join('\n')
}
