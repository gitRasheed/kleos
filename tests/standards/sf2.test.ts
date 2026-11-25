import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { BasicMIDI, SoundBankLoader, SpessaLog } from 'spessasynth_core'
import { excerpt } from './excerpts.js'
import { tinyBank } from './tinyBank.js'
import { writeMidiFile } from '../../src/notation/midiBridge.js'
import { renderSf2 } from '../../src/notation/sf2Adapter.js'
import type { Performance } from '../../src/notation/conductor.js'

SpessaLog.setLogLevel(false, false, false)
const sf2 = readFileSync('tests/fixtures/standards/sine.sf2')
test('the generated bank reopens as PCM SF2 with one sample and the orchestral GM slots', () => {
  const bytes = tinyBank()
  assert.equal(Buffer.from(bytes.subarray(0, 4)).toString(), 'RIFF')
  assert.equal(Buffer.from(bytes.subarray(8, 12)).toString(), 'sfbk')
  const bank = SoundBankLoader.fromArrayBuffer(bytes.buffer)
  assert.equal(bank.type, 'sf2')
  assert.equal(bank.samples.length, 1)
  assert.deepEqual(
    bank.presets.map((p) => p.program),
    [0, 47, 48, 56, 60, 68, 70, 71, 73]
  )
  assert.equal(bank.samples[0].sampleRate, 22050)
})

for (const name of ['beethoven', 'mozart'] as const) {
  test(
    name + ' SMF renders finite stereo through the real SF2 processor with the written opening rest',
    async () => {
      const midi = writeMidiFile(excerpt(name).played)
      const rate = 22050
      const { left, right } = await renderSf2(midi, sf2, rate)
      const song = BasicMIDI.fromArrayBuffer(Uint8Array.from(midi).buffer)
      assert.equal(left.length, Math.ceil((song.duration + 0.25) * rate))
      assert.equal(right.length, left.length)
      for (const channel of [left, right]) {
        assert.equal(channel.every(Number.isFinite), true)
        const onset = channel.findIndex((x) => Math.abs(x) > 0.0001)
        const writtenOnset = name === 'beethoven' ? (rate * 0.5 * 60) / 216 : 0
        assert.ok(
          onset >= Math.floor(writtenOnset) && onset < writtenOnset + 300,
          'first audible frame ' + onset
        )
        assert.ok(channel.subarray(60000, 80000).some((x) => Math.abs(x) > 0.001))
      }
    }
  )
}

test('expression CC11 changes PCM from the same held note and patch', async () => {
  const score: Performance = {
    name: 'Expression',
    ppq: 480,
    endTick: 960,
    tempos: [{ ticks: 0, bpm: 120 }],
    meters: [],
    keys: [],
    tracks: [
      {
        name: 'Sine',
        channel: 0,
        program: 0,
        controls: [],
        notes: [{ ticks: 0, durationTicks: 960, midi: 69, velocity: 100 }],
      },
    ],
  }
  const full = await renderSf2(writeMidiFile(score), sf2, 22050, 0)
  score.tracks[0].controls.push({ ticks: 240, number: 11, value: 30 })
  const soft = await renderSf2(writeMidiFile(score), sf2, 22050, 0)
  const power = (samples: Float32Array) => samples.subarray(11025, 16000).reduce((sum, x) => sum + x * x, 0)
  assert.ok(power(full.left) > 0.001)
  assert.ok(power(soft.left) < power(full.left) / 10)
})
