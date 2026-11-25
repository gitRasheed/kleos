import test from 'node:test';
import assert from 'node:assert/strict';
import { readWav } from '../../dist/io/wav.js';
import { measureLoudness, loudnessRange } from '../../dist/ears/loudness.js';
import { detectFlatTopClipping } from '../../dist/ears/clipDetect.js';
import { integratedLufs } from '../../dist/ears/loudness.js';
const sr = 16000;
const tone = (seconds, dbAt) => Float64Array.from({ length: seconds * sr }, (_, i) => 10 ** (dbAt(i / sr) / 20) * Math.sin(2 * Math.PI * 1000 * i / sr));
const near = (value, target, tolerance) => assert.ok(Math.abs(value - target) <= tolerance, value + ' vs ' + target);

test('EBU two equally long tone levels separated by 20 LU, with gated quiet passages', () => {
  const a = tone(100, t => t < 20 ? -90 : t < 40 ? -60 : t < 70 ? -32 : -12);
  near(loudnessRange([a], sr), 20, 0.1);
  near(loudnessRange([a, a], sr), 20, 0.1);
});
test('no eligible windows, silence and empty input yield null', () => {
  assert.equal(loudnessRange([tone(1, () => -12)], sr), null);
  assert.equal(loudnessRange([tone(10, () => -90)], sr), null);
  const empty = measureLoudness([], sr);
  for (const k of ['lraLu', 'integratedLufs', 'truePeakDbtp', 'plrDb', 'crestFactorDb']) assert.equal(empty[k], null);
});
test('1 kHz mono sine has about 3 LU of PLR and 3.01 dB of crest', () => {
  const m = measureLoudness([tone(15, () => -18)], sr);
  near(m.plrDb, 3, 0.2); near(m.crestFactorDb, 3.0103, 0.001); near(m.lraLu, 10 * Math.log10(3 / 2.9), 0.002);
});
test('mutant clipping followed by loudness normalization leaves detectable plateaus', () => {
  const a = tone(4, () => -3).map(x => Math.max(-0.2, Math.min(0.2, x)));
  const gain = 10 ** ((-16 - integratedLufs([a], sr)) / 20);
  const normalized = a.map(x => x * gain);
  near(integratedLufs([normalized], sr), -16, 0.001);
  const hits = detectFlatTopClipping([normalized], sr);
  assert.equal(hits.length, 2);
  assert.ok(hits.every(h => h.code === 'FLAT_TOP_CLIPPING' && h.railDbfs < -10 && h.runs > 100));
});
test('the normalized Mozart mutation still clips at -16 LUFS and below -15 dBTP', () => {
  const { channels, sampleRate } = readWav('tests/studio/fixtures/flat.wav');
  const m = measureLoudness(channels, sampleRate);
  near(m.integratedLufs, -16, 0.05); near(m.truePeakDbtp, -15.6, 0.1);
  const hits = detectFlatTopClipping(channels, sampleRate);
  assert.equal(hits.length, 4);
  assert.deepEqual(new Set(hits.map(h => h.channel)), new Set([0, 1]));
  assert.ok(hits.every(h => h.runs > 4000 && Math.abs(h.railDbfs + 16.7) < 0.1));
});
for (const name of ['mozart', 'beethoven', 'voice-sine', 'voice-square', 'voice-saw']) {
  test('clean fixture passes: ' + name, () => {
    const a = readWav('tests/studio/fixtures/' + name + '.wav');
    assert.deepEqual(detectFlatTopClipping(a.channels, a.sampleRate), []);
  });
}
for (const [levels, expected] of [[[-20, -30], 10], [[-20, -15], 5], [[-40, -20], 20], [[-50, -35, -20, -35, -50], 15]]) {
  test('EBU Tech 3342 tone sequence ' + levels.join(', ') + ' dBFS', () => {
    const channel = tone(20 * levels.length, t => levels[Math.floor(t / 20)]);
    near(loudnessRange([channel, channel], sr), expected, 1);
  });
}
for (const [name, expected] of [['flat', 1.9], ['mozart', 1.8], ['beethoven', 8.9]]) {
  test('music LRA within 1 LU of FFmpeg ebur128: ' + name, () => {
    const { channels, sampleRate } = readWav('tests/studio/fixtures/' + name + '.wav');
    near(loudnessRange(channels, sampleRate), expected, 1);
  });
}
test('a unipolar PWM oscillator is clean despite its repeated upper rail', () => {
  const pulse = Float64Array.from({ length: sr }, (_, i) => i % 40 < 14 ? 0.25 : 0);
  assert.deepEqual(detectFlatTopClipping([pulse], sr), []);
});
