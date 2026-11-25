import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { readAbc, readMusicXml, readMidiFile, performPart, writeMidiFile, readWav } from '../../src/index.js';
import { findTool, readProject } from '../../src/tools.js';
import { project, tmpDir, track } from '../helpers.js';

const fixtures = path.resolve('tests/fixtures/standards');
const cli = (...args: string[]) => execFileSync(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8' });
function directory(t: TestContext) {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

for (const score of ['beethoven', 'mozart', 'piano-scale']) {
  test(`imported ${score} passes the project gate after rendering`, t => {
    const dir = directory(t);
    const file = path.join(dir, 'project.json');
    const wav = path.join(dir, 'render.wav');
    cli('import-abc', path.join(fixtures, score + '.abc'), '--out', file);
    cli('render', file, '--out', wav);
    const report = JSON.parse(cli('check', wav, '--project', file));
    assert.equal(report.ok, true);
    assert.equal(report.schemaVersion, 'kleos/check/v1');
    assert.equal(report.thresholds.maxClickRatio, 25);
  });
}

test('the ABC and MusicXML commands retain the Mozart parts, cut time and written transpositions', t => {
  const dir = directory(t);
  const file = path.join(dir, 'mozart.json');
  const xml = path.join(dir, 'mozart.musicxml');
  const abc = path.join(dir, 'mozart.abc');
  const mid = path.join(dir, 'mozart.mid');
  cli('import-abc', path.join(fixtures, 'mozart.abc'), '--out', file);
  cli('export-musicxml', file, '--out', xml);
  cli('export-abc', file, '--out', abc);
  cli('export-midi', file, '--out', mid);
  execFileSync('xmllint', ['--nonet', '--noout', '--schema', path.join(fixtures, 'xsd/musicxml.xsd'), xml],
    { env: { ...process.env, XML_CATALOG_FILES: path.join(fixtures, 'xsd/catalog.xml') }, stdio: 'pipe' });
  const song = readMidiFile(fs.readFileSync(mid));
  assert.deepEqual(song.meters, [{ ticks: 0, numerator: 2, denominator: 2 }]);
  assert.equal(song.endTick, 38400);
  assert.equal(song.tracks.flatMap(t => t.notes).length, 555);
  assert.deepEqual(song.keys, [{ ticks: 0, fifths: -2, mode: 'minor' }]);
  for (const score of [readAbc(fs.readFileSync(abc, 'utf8')), readMusicXml(fs.readFileSync(xml, 'utf8'))]) {
    assert.equal(score.parts.length, 14);
    assert.equal(score.parts[0].measures[0].attributes?.time?.symbol, 'cut');
    assert.equal(score.parts[2].measures[0].attributes?.transpose?.chromatic, -2);
    assert.deepEqual(performPart(score.parts[8])[0], song.tracks[8].notes[0]);
  }
});

test('native engraving and subsequent edits to an imported score include the current notes, title and tempo', t => {
  const dir = directory(t);
  const file = path.join(dir, 'project.json'), xml = path.join(dir, 'out.xml'), abc = path.join(dir, 'out.abc');
  fs.writeFileSync(file, JSON.stringify(project({ title: 'Duo', tempo: { bpm: 81, beatsPerBar: 4 }, tracks: [
    track('Duo', 'piano', [{ midi: 60, startBeat: 3, durationBeats: 3 }, { midi: 64, startBeat: 4, durationBeats: 1 }]),
  ] })));
  cli('export-abc', file, '--out', abc);
  assert.match(fs.readFileSync(abc, 'utf8'), /^Q:1\/4=81$/m);
  cli('import-abc', abc, '--out', file);
  const p = readProject(file);
  assert.equal(p.title, 'Duo');
  assert.equal(p.tempo.bpm, 81);
  assert.deepEqual(p.tracks[0].clips[0].notes.map(n => [n.midi, n.startBeat, n.durationBeats]), [[60, 3, 3], [64, 4, 1]]);
  cli('add-notes', file, '--track-id', p.tracks[0].id, '--clip-id', 'main', '--notes', '[{"midi":67,"startBeat":7,"durationBeats":1}]');
  cli('export-musicxml', file, '--out', xml);
  assert.deepEqual(performPart(readMusicXml(fs.readFileSync(xml, 'utf8')).parts[0]).map(n => n.midi), [60, 64, 67]);
});

test('MIDI re-import matches named tracks across reordering and preserves the existing mix', t => {
  const dir = directory(t);
  const file = path.join(dir, 'mix.json'), mid = path.join(dir, 'edit.mid');
  const p = project({ master: { targetLufs: -21 }, tracks: [
    track('lead', { type: 'brass-horn', params: { players: 3 } }, [], { name: 'French horns', gainDb: -4, fx: [{ type: 'reverb', preset: 'room' }] }),
    track('bass', 'synth-bass', [], { pan: 0.4 }),
  ] });
  fs.writeFileSync(file, JSON.stringify(p));
  cli('export-midi', file, '--out', mid);
  const song = readMidiFile(fs.readFileSync(mid));
  song.tracks.reverse();
  song.endTick = 480;
  song.tracks[1].notes.push({ ticks: 240, durationTicks: 240, midi: 65, velocity: 83 });
  song.tracks[1].controls.push({ ticks: 240, number: 11, value: 35 });
  fs.writeFileSync(mid, writeMidiFile(song));
  cli('import-midi', mid, '--into', file);
  const result = readProject(file);
  assert.deepEqual(result.master, p.master);
  assert.deepEqual(result.tracks.map(t => t.id), ['lead', 'bass']);
  for (const key of ['instrument', 'fx', 'gainDb', 'pan', 'automation', 'name', 'role', 'layer', 'mute'] as const)
    assert.deepEqual(result.tracks.map(t => t[key]), p.tracks.map(t => t[key]));
  assert.equal(result.tracks[0].clips[0].notes[0].midi, 65);
  assert.equal(result.tracks[1].clips[0].notes.length, 0);
  cli('export-midi', file, '--out', mid);
  assert.deepEqual(readMidiFile(fs.readFileSync(mid)).tracks[0].controls, song.tracks[1].controls);
  const fresh = path.join(dir, 'new.json');
  cli('import-midi', mid, '--out', fresh);
  assert.equal(readProject(fresh).tracks[0].instrument.type, 'brass-horn');
});

test('the render tool reads a score-relative PCM SF2 and mixes it on the selected track', t => {
  const dir = directory(t);
  const file = path.join(dir, 'sf2.json'), out = path.join(dir, 'sf2.wav');
  fs.copyFileSync(path.join(fixtures, 'sine.sf2'), path.join(dir, 'sine.sf2'));
  const p = project({ kind: 'cue', bars: 1, tracks: [
    track('sample', { type: 'sf2', params: { bank: 'sine.sf2', program: 48 } }, [{ midi: 69, startBeat: 1, durationBeats: 1 }], { pan: -1 }),
  ] });
  fs.writeFileSync(file, JSON.stringify(p));
  const render = findTool('render');
  assert.ok(render?.run({ project: file, out, tracks: ['sample'] }).ok);
  const { channels: [left, right] } = readWav(out);
  assert.ok(left.subarray(0, 23800).every(x => Math.abs(x) < 1e-5));
  assert.ok(left.subarray(24500, 36000).some(x => Math.abs(x) > 0.05));
  assert.ok(right.every(x => Math.abs(x) < 1e-5));
});
