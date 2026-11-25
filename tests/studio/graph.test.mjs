import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMixGraph } from '../../dist/score/mixGraph.js';
const ctx = { sampleRate: 48000, secondsPerBeat: 0.5, loopFrames: null };
const minus6 = 20 * Math.log10(0.5);
function audio(x, n = 16) { return { left: new Float64Array(n).fill(x), right: new Float64Array(n).fill(x) }; }
const tracks = [{ id: 'lead', audio: audio(0.5), to: 'group', gainDb: minus6, sends: [{ to: 'room', pre: true, levelDb: minus6 }, { to: 'echo', pre: false, levelDb: minus6 }] },
{ id: 'bass', audio: audio(0.125), to: 'group' }, { id: 'noise', audio: audio(0.25), to: 'room' }];
const buses = [{ id: 'room', gainDb: minus6 }, { id: 'echo' }, { id: 'group', gainDb: minus6 }];
test('pre and post sends, unordered group buses and independent captures sum exactly', () => {
  const r = renderMixGraph(tracks, [{ id: 'master' }, ...buses], ctx);
  assert.equal(r.stems.get('group').left[0], 0.1875);
  assert.equal(r.stems.get('room').left[0], 0.25);
  assert.equal(r.stems.get('echo').right[0], 0.125);
  assert.ok(r.mix.left.every(x => x === 0.5625));
  assert.equal(tracks[0].audio.left[0], 0.5);
});
test('solo lead retains its return effects and excludes other inputs to shared buses', () => {
  const r = renderMixGraph([{ ...tracks[0], solo: true }, ...tracks.slice(1)], buses, ctx);
  assert.equal(r.mix.left[0], 0.375);
});
test('solo group or aux includes its upstream inputs only on the path through the soloed bus', () => {
  assert.equal(renderMixGraph(tracks, buses.map(b => ({ ...b, solo: b.id === 'group' })), ctx).mix.left[0], 0.1875);
  assert.equal(renderMixGraph(tracks, buses.map(b => ({ ...b, solo: b.id === 'room' })), ctx).mix.left[0], 0.25);
});
test('mute silences pre sends, including when the same track is soloed', () => {
  const muted = { ...tracks[0], mute: true, solo: true };
  assert.ok(renderMixGraph([muted, ...tracks.slice(1)], buses, ctx).mix.left.every(x => x === 0));
});
test('a post-insert pre-fader send survives a closed fader', () => {
  const src = {
    id: 'src', audio: audio(0.25), gainDb: -Infinity,
    fx: [{ type: 'compressor', thresholdDb: 0, ratio: 1, attackMs: 1, releaseMs: 5, makeupDb: 6 }],
    sends: [{ to: 'aux', pre: true, levelDb: 0 }]
  };
  assert.equal(renderMixGraph([src], [{ id: 'aux' }], ctx).mix.left[0], 0.25 * 10 ** (6 / 20));
});
test('per-insert reduction agrees with actual sample gains, independently of makeup', () => {
  const src = audio(0.8, 48000);
  const comp = { type: 'compressor', thresholdDb: -18, ratio: 4, attackMs: 1, releaseMs: 50, kneeDb: 0, makeupDb: 3 };
  const r = renderMixGraph([{ id: 'input', audio: src, to: 'bus' }], [{ id: 'bus', fx: [comp, { ...comp, ratio: 1 }] }], ctx);
  const db = r.mix.left.map((x, i) => 6 - 20 * Math.log10(x / src.left[i]));
  const expected = db.reduce((a, b) => a + b, 0) / db.length;
  assert.deepEqual(r.reductions.map(x => [x.id, x.insert]), [['bus', 0], ['bus', 1]]);
  assert.ok(Math.abs(r.reductions[0].meanGrDb - expected) < 1e-8);
  assert.ok(Math.abs(r.reductions[0].maxGrDb - db.reduce((a, b) => Math.max(a, b), 0)) < 1e-8);
  assert.ok(r.reductions[1].meanGrDb < 1e-8);
});
test('limiter, bus overload and flat crest diagnostics have identifiable sources', () => {
  const active = { id: 'track', to: 'group', audio: audio(1.1, 48000) };
  const r = renderMixGraph([active], [{ id: 'group' }, { id: 'master', fx: [{ type: 'limiter', thresholdDb: -12 }] }], ctx);
  assert.ok(r.findings.some(f => f.code === 'BUS_OVER' && f.id === 'group' && f.valueDb > 0));
  assert.ok(r.findings.some(f => f.code === 'LIMITER_OVERWORKED' && f.id === 'master' && f.valueDb > 12));
  assert.ok(r.findings.some(f => f.code === 'DYNAMICS_FLAT' && f.id === 'group' && Math.abs(f.valueDb) < 1e-8));
  assert.ok(!r.findings.some(f => f.code === 'BUS_OVER' && f.id === 'master'));
  const quiet = renderMixGraph([{ id: 't', audio: audio(0, 48000) }], [{ id: 'master', fx: [{ type: 'limiter', thresholdDb: -12 }] }], ctx);
  assert.deepEqual(quiet.findings, []);
});
test('feedback through a send, duplicate ids and missing buses fail closed', () => {
  assert.throws(() => renderMixGraph([], [{ id: 'a', to: 'b' }, { id: 'b', sends: [{ to: 'a', levelDb: -12, pre: true }] }], ctx), /Cycle/);
  assert.throws(() => renderMixGraph(tracks, [...buses, { id: 'lead' }], ctx), /Duplicate/);
  assert.throws(() => renderMixGraph(tracks, [], ctx), /Unknown/);
});
test('a wet delay return stays aligned with the dry group and uses the aux fader', () => {
  const impulse = audio(0, 48000);
  impulse.left[0] = 1;
  const src = { id: 'src', to: 'dry', audio: impulse, sends: [{ to: 'delay', levelDb: 0, pre: false }] };
  const delay = { type: 'delay', wetOnly: true, timeBeats: 0.25, feedback: 0, mix: 1, dampHz: 8000, pingPong: false };
  const r = renderMixGraph([src], [{ id: 'dry' }, { id: 'delay', gainDb: minus6, fx: [delay] }], ctx);
  assert.equal(r.mix.left[0], 1);
  assert.equal(r.mix.left[6000], 0.5);
  assert.equal(r.stems.get('delay').left[0], 0);
  assert.equal(r.stems.get('dry').left[6000], 0);
  assert.ok(r.mix.right.every(x => x === 0));
});
