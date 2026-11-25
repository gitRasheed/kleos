import { readFileSync } from 'node:fs'
import { readAbc } from '../../src/notation/abcBridge.js'
import { performance } from '../../src/notation/conductor.js'

type ExpectedNote = [number, number, string, number, number, string[]]
interface ReferencePart {
  name: string
  transpose: number
  fifths: number
  program: number
  notes: ExpectedNote[]
  dynamics: [number, string][]
  fermatas: number[]
}
export function excerpt(name: 'beethoven' | 'mozart') {
  const abc = readFileSync('tests/fixtures/standards/' + name + '.abc', 'utf8')
  const reference: ReferencePart[] = JSON.parse(readFileSync('tests/fixtures/standards/' + name + '.json', 'utf8'))
  const programs = [...new Set(reference.map((p) => p.program))]
  const patches = new Map(
    reference.map((p) => [p.name, { program: p.program, channel: programs.indexOf(p.program) }])
  )
  const score = readAbc(abc)
  const fifths = name === 'beethoven' ? -3 : -2
  return { abc, reference, score, played: performance(score, { ticks: 0, fifths, mode: 'minor' }, patches) }
}
