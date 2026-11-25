import { checkAudio } from '../src/ears/check.js';
import { measureLoudness } from '../src/ears/loudness.js';
import { WavError } from '../src/types.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gateAudio, type GateReport } from '../src/ears/gate.js';
import { renderProject } from '../src/score/render.js';
import { decodeWav, encodeDitheredWav as encodeWav, type Audio } from '../src/io/wav.js';
import { SR, project, tmpDir, track } from './helpers.js';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/cli.js');

// A short, clean orchestral loop: strings, piano, timpani and snare through the loop-safe master.
const clean: Audio = (() => {
  const chords = [[50, 57, 65], [46, 53, 62], [48, 55, 64], [45, 52, 61]];
  const p = project({
    bars: 4,
    tracks: [
      track('str', 'strings-ensemble', chords.flatMap((c, b) => c.map((midi) => ({ midi: midi + 12, startBeat: b * 4, durationBeats: 4, velocity: 90, articulation: 'legato' }))), { fx: [{ type: 'reverb', preset: 'hall', mix: 0.3 }] }),
      track('pno', 'piano', chords.flatMap((c, b) => [0, 1, 2, 1, 0, 1, 2, 1].map((k, i) => ({ midi: (c[k] ?? 60) + 12, startBeat: b * 4 + i * 0.5, durationBeats: 0.5, velocity: 80, articulation: i % 2 === 0 ? 'staccato' : 'normal' })))),
      track('cb', 'strings-bass', chords.map((c, b) => ({ midi: (c[0] ?? 48) - 12, startBeat: b * 4, durationBeats: 4, velocity: 95 })), { gainDb: -6 }),
      track('tim', 'timpani', [0, 4, 8, 12, 14].map((s) => ({ midi: 38, startBeat: s, durationBeats: 1, velocity: 115 })), { gainDb: -6 }),
      track('sn', 'orchestral-perc', [1, 3, 5, 7, 9, 11, 13, 15].map((s) => ({ midi: 38, startBeat: s, durationBeats: 0.5, velocity: 105 }))),
    ],
  });
  const r = renderProject(p);
  // Round-trip through 24-bit PCM: the gate judges the file, not the float buffer.
  return decodeWav(encodeWav({ sampleRate: SR, channels: [r.mix.left, r.mix.right] }, 24));
})();

const opts = { loop: true, bpm: 120, targetLufs: -16 } as const;
const codes = (r: GateReport): string[] => r.findings.map((f) => f.code);
const copy = (a: Audio): Audio => ({ sampleRate: a.sampleRate, channels: a.channels.map((c) => c.slice()) });
const L = (a: Audio): Float64Array => a.channels[0] ?? new Float64Array(0);
const R = (a: Audio): Float64Array => a.channels[1] ?? new Float64Array(0);

test('a clean rendered loop passes the gate with zero findings', () => {
  const r = gateAudio(clean, opts);
  assert.deepEqual(r.findings, []);
  assert.ok(r.ok);
});

test('timpani, snare and staccato piano onsets are not mistaken for clicks', () => {
  const r = gateAudio(clean, opts);
  assert.ok(Math.max(...r.clickRatio) < 25, `click ratios ${r.clickRatio.join(', ')}`);
});

test('planted clipping is caught', () => {
  const a = copy(clean);
  for (let i = 30000; i < 30040; i += 1) L(a)[i] = 1;
  assert.ok(codes(gateAudio(a, opts)).includes('FULL_SCALE_SAMPLES'));
});

test('planted DC offset is caught', () => {
  const a = copy(clean);
  for (const ch of a.channels) for (let i = 0; i < ch.length; i += 1) ch[i] += 0.01;
  assert.ok(codes(gateAudio(a, opts)).includes('DC_OFFSET'));
});

test('a single-sample click mid-file is caught', () => {
  const a = copy(clean);
  L(a)[100000] += 0.35;
  const r = gateAudio(a, opts);
  assert.ok(codes(r).includes('IMPULSE_CLICK'), JSON.stringify(r.clickRatio));
  assert.ok(Math.abs((r.findings.find((f) => f.code === 'IMPULSE_CLICK')?.timeS ?? 0) - 100000 / SR) < 0.001);
});

test('50 Hz mains hum with harmonics is caught', () => {
  const a = copy(clean);
  for (const ch of a.channels) for (let i = 0; i < ch.length; i += 1) ch[i] += 0.006 * Math.sin((2 * Math.PI * 50 * i) / SR) + 0.003 * Math.sin((2 * Math.PI * 100 * i) / SR) + 0.002 * Math.sin((2 * Math.PI * 150 * i) / SR);
  const r = gateAudio(a, opts);
  assert.ok(codes(r).includes('MAINS_HUM'), JSON.stringify(r.hum));
});

test('sustained G1 (49 Hz) and B1 (61.7 Hz) bass under a steady timpani pulse are not mistaken for hum', () => {
  const p = project({
    bars: 4,
    tracks: [
      track('cb', 'strings-bass', [{ midi: 31, startBeat: 0, durationBeats: 16, velocity: 110 }]),
      track('sub', 'synth-bass', [0, 4, 8, 12].map((s) => ({ midi: 35, startBeat: s, durationBeats: 3, velocity: 100 }))),
      track('tim', 'timpani', [0, 2, 4, 6, 8, 10, 12, 14].map((s) => ({ midi: 38, startBeat: s, durationBeats: 1, velocity: 110 }))),
    ],
  });
  const r = renderProject(p);
  const g = gateAudio({ sampleRate: SR, channels: [r.mix.left, r.mix.right] }, opts);
  assert.ok(!codes(g).includes('MAINS_HUM'), JSON.stringify(g.hum));
});

test('a silent channel is caught', () => {
  const a = copy(clean);
  R(a).fill(0);
  assert.ok(codes(gateAudio(a, opts)).includes('SILENT_CHANNEL'));
});

test('a polarity-inverted channel is caught as a phase problem', () => {
  const a = copy(clean);
  const r = R(a);
  const l = L(a);
  for (let i = 0; i < r.length; i += 1) r[i] = -l[i];
  assert.ok(codes(gateAudio(a, opts)).includes('STEREO_PHASE_INVERTED'));
});

test('a loop cut short is caught by its length, and the cut by the seam step', () => {
  const a = copy(clean);
  const cut = (a.channels[0]?.length ?? 0) - 7000;
  const cropped: Audio = { sampleRate: SR, channels: a.channels.map((c) => c.slice(0, cut)) };
  const r = gateAudio(cropped, opts);
  assert.ok(codes(r).includes('LOOP_LENGTH'), JSON.stringify(r.seam));
  assert.ok(codes(r).includes('LOOP_BAR_SEAM'), JSON.stringify(r.seam));
});

test('a gain step at the wrap (what a limiter run without wrap padding does) is caught', () => {
  const a = copy(clean);
  const ramp = Math.round(0.05 * SR);
  for (const ch of a.channels) for (let i = 0; i < SR / 4 + ramp; i += 1) ch[i] *= i < SR / 4 ? 0.3 : 0.3 + (0.7 * (i - SR / 4)) / ramp;
  const r = gateAudio(a, opts);
  assert.ok(codes(r).includes('LOOP_BAR_SEAM') || codes(r).includes('LOOP_LEVEL_JUMP'), JSON.stringify(r.seam));
});

test('too quiet and muffled audio is caught', () => {
  const a = copy(clean);
  let z = 0;
  for (const ch of a.channels) {
    z = 0;
    for (let i = 0; i < ch.length; i += 1) {
      z += 0.01 * (ch[i] - z);
      ch[i] = z * 0.3;
    }
  }
  const c = codes(gateAudio(a, opts));
  assert.ok(c.includes('LOUDNESS_INTEGRATED_LOW') && c.includes('SPECTRAL_DULL'), c.join(','));
});

test('the gate writes labelled waveform and spectrogram PNGs', () => {
  const dir = tmpDir();
  const r = gateAudio(clean, { ...opts, pngDir: dir, title: 'clean' });
  for (const f of [r.pngs?.waveform, r.pngs?.spectrogram]) {
    assert.ok(f !== undefined && fs.existsSync(f));
    assert.deepEqual([...fs.readFileSync(f).subarray(1, 4)], [80, 78, 71]);
  }
  fs.rmSync(path.resolve(dir), { recursive: true, force: true });
});

test('a WAV cut short under its original header is rejected, by decodeWav and by gate with exit 2', () => {
  const full = encodeWav({ sampleRate: SR, channels: [new Float64Array(2 * SR).fill(0.25), new Float64Array(2 * SR).fill(0.25)] }, 32);
  const half = full.slice(0, Math.floor(full.length / 2));
  assert.throws(() => decodeWav(half), (e: Error) => e instanceof WavError && /truncated/.test(e.message));
  const file = path.join(tmpDir(), 'half.wav');
  fs.writeFileSync(file, half);
  const r = spawnSync(process.execPath, [cli, 'gate', file], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /truncated/);
  // A missing pad byte after an odd-sized final chunk is not truncation.
  const odd = encodeWav({ sampleRate: SR, channels: [new Float64Array(3)] }, 24);
  assert.equal(decodeWav(odd).channels[0]?.length, 3);
});

test('hard clipping survives gain matching to -16 LUFS, well below full scale', () => {
  const source = Float64Array.from({ length: SR }, (_, i) => {
    const phase = 2 * Math.PI * 330 * i / SR;
    const fade = Math.min(1, i / 480, (SR - 1 - i) / 480);
    return fade * (0.09 * Math.sin(phase) + 0.045 * Math.sin(1.5 * phase));
  });
  const clipped = source.map((v) => Math.max(-0.074, Math.min(0.074, v)));
  const lufs = measureLoudness([clipped, clipped], SR).integratedLufs;
  assert.notEqual(lufs, null);
  const gain = 10 ** ((-16 - Number(lufs)) / 20);
  const matched = clipped.map((v) => Math.fround(v * gain));
  const report = gateAudio({ sampleRate: SR, channels: [matched, matched] });
  assert.equal(report.loudness.integratedLufs, -16);
  assert.ok(Math.abs((report.loudness.truePeakDbtp ?? 0) + 15.6) < 0.5);
  assert.equal(report.clippedSamples, 0);
  assert.deepEqual(report.findings.filter((f) => f.severity === 'fail').map((f) => f.code), ['FLAT_TOP_CLIPPING', 'FLAT_TOP_CLIPPING']);
  assert.equal(report.ok, false);
  assert.ok(!codes(gateAudio({ sampleRate: SR, channels: [source, source] })).includes('FLAT_TOP_CLIPPING'));
});

test('the hum reference on pitched bass is independent of score tempo', () => {
  const bass = Float64Array.from({ length: SR * 4 }, (_, i) =>
    0.2 * Math.sin(2 * Math.PI * 49 * i / SR) + 0.06 * Math.sin(2 * Math.PI * 98 * i / SR));
  const audio = { sampleRate: SR, channels: [bass] };
  const blind = gateAudio(audio);
  const scored = gateAudio(audio, { bpm: 208 });
  assert.deepEqual(scored.hum, blind.hum);
  assert.ok(!codes(scored).includes('MAINS_HUM'));
});

test('music permits a written opening rest and dark rolloff until explicitly gated', () => {
  const tone = Float64Array.from({ length: SR }, (_, i) =>
    i < SR / 8 ? 0 : 0.2 * Math.sin(2 * Math.PI * 440 * i / SR));
  const audio = { sampleRate: SR, channels: [tone, tone], format: 'float32' } as const;
  const music = checkAudio(audio, 'opening-rest', { profile: 'music' });
  assert.ok(!music.findings.some((f) => f.code === 'LEADING_SILENCE'));
  assert.equal(music.findings.find((f) => f.code === 'SPECTRAL_ROLLOFF')?.severity, 'warn');
  const required = checkAudio(audio, 'opening-rest', { profile: 'music', thresholds: { maxLeadingSilenceS: 0.02 }, requireRolloff: true });
  assert.equal(required.findings.find((f) => f.code === 'LEADING_SILENCE')?.severity, 'fail');
  assert.equal(required.findings.find((f) => f.code === 'SPECTRAL_ROLLOFF')?.severity, 'fail');
});

test('critique gates a sparse score only when given an explicit minimum', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'sparse.json');
    fs.writeFileSync(file, JSON.stringify(project({ tracks: [] })));
    const advisory = spawnSync(process.execPath, [cli, 'critique', file], { encoding: 'utf8' });
    const required = spawnSync(process.execPath, [cli, 'critique', file, '--min', '0.85'], { encoding: 'utf8' });
    assert.equal(advisory.status, 0, advisory.stderr);
    assert.equal(required.status, 1, required.stderr);
    assert.equal(advisory.stdout, required.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
