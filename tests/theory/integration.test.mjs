import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, URL } from 'node:url'
import { handleMessage, lintScore, parseLintScore } from 'agent-audio'

const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url))
const note = (midi, startBeat, durationBeats) => ({ midi, startBeat, durationBeats })
const project = {
  format: 'agent-daw/v1', id: 'test', bars: 2,
  patterns: { figure: { lengthBeats: 2, notes: [note(50, 0, 1)] } },
  tracks: [{
    id: 'horn', name: 'First horn', instrument: 'brass-horn',
    clips: [{ id: 'line', startBeat: 3.5, notes: [note(60, 0.25, 1)], pattern: 'figure', repeat: 2, transpose: -17 }],
  }],
}

test('DAW clips preserve rests, overlap, barlines, concert pitch and transposed repeats', () => {
  for (const format of ['agent-daw/v1', 'agent-audio/score/v1']) {
    const score = parseLintScore({ ...project, format })
    const findings = lintScore(score)
    assert.deepEqual(findings.filter(f => f.code === 'POLYPHONY').map(f => f.where), [
      { bar: 1, beat: 4.75, voice: 'First horn', trackId: 'horn' },
      { bar: 2, beat: 1, voice: 'First horn', trackId: 'horn' },
    ])
    assert.ok(findings.some(f => f.code === 'RANGE_HARD' && f.where.bar === 2 && f.where.beat === 2.5))
    assert.ok(findings.every(f => f.code === 'POLYPHONY' || f.code === 'RANGE_HARD'))
  }
})

test('DAW spelling preserves the leading tone in a sharp key', () => {
  const tracks = [78, 66].map((midi, i) => ({
    id: String(i), instrument: 'piano', clips: [{ id: 'c', notes: [note(midi, 0, 4)] }],
  }))
  const score = parseLintScore({ ...project, tracks, key: { tonic: 'G', mode: 'major' } }, 'strict')
  assert.deepEqual(lintScore(score).map(f => [f.code, f.severity]), [['DOUBLED_LEADING_TONE', 'error']])
})

test('CLI and MCP distinguish warnings, error findings, and invalid input', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-audio-lint-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'score.json')
  const tracks = ['C4', 'E4'].map(pitch => ({
    id: pitch, voice: pitch, instrument: 'piano', dynamic: 'p', bars: [[{ ticks: 4, pitches: [pitch] }]],
  }))
  const score = { format: 'agent-audio/score/v1', style: 'strict', ticksPerBeat: 1, beatsPerBar: [4], tracks }
  fs.writeFileSync(file, JSON.stringify(score))
  const run = (...args) => spawnSync(process.execPath, [cli, 'lint', file, ...args], { encoding: 'utf8' })
  const call = (args) => handleMessage({ id: 1, method: 'tools/call', params: { name: 'lint', arguments: { score: file, ...args } } }).result
  for (const [args, flags, status] of [[{}, [], 1], [{ style: 'free' }, ['--style', 'free'], 0]]) {
    const result = run(...flags)
    assert.equal(result.status, status, result.stderr)
    const mcp = call(args)
    assert.equal(mcp.isError, false)
    assert.deepEqual(mcp.structuredContent.result, JSON.parse(result.stdout))
    assert.equal(mcp.structuredContent.result.findings[0].code, 'VOICE_CROSSING')
  }
  assert.equal(run('--style', 'loose').status, 2)
  assert.equal(run('--style').status, 2)
  assert.equal(run('--unknown').status, 2)
  assert.equal(call({ style: 'loose' }).isError, true)
  for (const bad of ['{', '{}', JSON.stringify({ ...score, tracks: [{ ...tracks[0], bars: [[{ ticks: 4, pitches: 60 }]] }] })]) {
    fs.writeFileSync(file, bad)
    assert.equal(run().status, 2)
    assert.equal(call({}).isError, true)
  }
})
