import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMix } from '../../dist/ears/masking.js';
const sr = 24000, tempo = { bpm: 120, beatsPerBar: 4 };
function track(id, role, hz, db, start = 0, end = 2.4, phase = 1) {
  const left = Float64Array.from({ length: 2.4 * sr }, (_, i) => i < start * sr || i >= end * sr ? 0 : 10 ** (db / 20) * Math.sin(2 * Math.PI * hz * i / sr));
  return { id, role, audio: { left, right: left.map(x => x * phase) } };
}
const lead = track('flute', 'lead', 440, -25);
const masked = tracks => analyzeMix(tracks, sr, tempo).filter(f => f.code === 'MASKED');
test('lead buried by 13 dB names the masker, time, project bar and Bark band', () => {
  const hits = masked([lead, track('pad', 'pad', 440, -12, 2, 2.2), track('bass', 'bass', 110, -15)]);
  assert.equal(hits.length, 1);
  const [f] = hits;
  assert.equal(f.bar, 1); assert.ok(f.timeS >= 2 && f.timeS < 2.2);
  assert.deepEqual(f.bandHz, [400, 510]); assert.equal(f.trackId, 'flute'); assert.deepEqual(f.maskers, ['pad']);
  assert.ok(Math.abs(f.valueDb + 13) < 0.01);
});
test('a lifted lead or a pad up two octaves clears masking', () => {
  assert.deepEqual(masked([track('flute', 'lead', 440, -13), track('pad', 'pad', 440, -12)]), []);
  assert.deepEqual(masked([lead, track('pad', 'pad', 1760, -12)]), []);
});
test('non-overlapping notes and silent leads produce no masking', () => {
  assert.deepEqual(masked([track('lead', 'lead', 440, -25, 0, 1), track('pad', 'pad', 440, -12, 1)]), []);
  assert.deepEqual(masked([track('lead', 'lead', 440, -Infinity), track('pad', 'pad', 440, -12)]), []);
});
for (const [code, hz, phase] of [['LOW_MID_BUILDUP', 330, 1], ['HARSH_BAND', 4000, 1], ['SUB_RUMBLE', 25, 1], ['MONO_LOSS', 880, -1]]) {
  test(code + ' is located and clears on a centered 880 Hz control', () => {
    const hits = analyzeMix([track('voice', 'pad', hz, -12, 0, 2.4, phase)], sr, tempo);
    assert.ok(hits.some(f => f.code === code && f.trackId === 'master' && f.bar === 1 && Number.isFinite(f.valueDb)));
    assert.deepEqual(analyzeMix([track('voice', 'pad', 880, -12)], sr, tempo), []);
  });
}
