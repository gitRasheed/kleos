import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handleMessage, parseProject, renderProject } from 'agent-audio';

const project = { format: 'agent-daw/v1', id: 'cue', bars: 1, loop: true };
const compressor = { type: 'compressor', thresholdDb: -36, ratio: 4 };
const lead = {
  id: 'lead', role: 'lead', instrument: 'piano', to: 'group',
  clips: [{ id: 'phrase', notes: [{ midi: 69, startBeat: 0, durationBeats: 3 }] }],
  fx: [{ type: 'eq', bands: [{ type: 'bell', hz: 440, gainDb: 4 }] }, compressor],
  sends: [{ to: 'echo', levelDb: -6, pre: true }],
};
const score = { ...project, tracks: [lead], buses: [
  { id: 'echo', fx: [{ type: 'delay', wetOnly: true, timeBeats: 0.25 }] },
  { id: 'group', fx: [compressor] },
] };

test('score validation rejects unknown fields at their JSON paths', () => {
  const parsed = parseProject({ ...score, tempoo: 1, tracks: [{ ...lead, clips: [{ id: 'phrase', notse: [] }] }] });
  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.errors.map(issue => issue.path).sort(), ['$.tempoo', '$.tracks[0].clips[0].notse']);
  assert.equal(parseProject({ ...score, buses: [{ id: 'group', to: 'echo' }, { id: 'echo', to: 'group' }] }).ok, false);
});

test('score routing drives the written stems, compressor meters and audition tool', t => {
  const dir = mkdtempSync(join(tmpdir(), 'audio-studio-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'cue.json');
  writeFileSync(file, JSON.stringify(score));
  function call(name, args) {
    const { result } = handleMessage({ id: 1, method: 'tools/call', params: { name, arguments: { project: file, ...args } } });
    assert.equal(result.isError, false, result.content[0].text);
    return result.structuredContent.result;
  }
  const output = call('render', { out: join(dir, 'cue.wav'), stemsDir: dir });
  for (const stem of ['base', 'bus_echo', 'bus_group', 'bus_master']) {
    assert.ok(output.files.includes(join(dir, 'cue_' + stem + '.wav')));
  }
  assert.deepEqual(output.reductions.map(r => [r.id, r.insert]), [['lead', 1], ['group', 0]]);
  assert.ok(output.reductions.every(r => r.maxGrDb >= r.meanGrDb && r.meanGrDb > 0));
  const audition = call('audition', { out: join(dir, 'audition') });
  assert.deepEqual(audition.findings, call('masking', {}).findings);
  assert.deepEqual(audition.stems.sort(), ['echo', 'group']);
  assert.match(readFileSync(audition.file, 'utf8'), /audio\/wav|UklGR/);
});

test('a muted group solo closes its inputs to the master', () => {
  const parsed = parseProject({ ...score, buses: [{ id: 'group', solo: true, mute: true }, { id: 'echo' }] });
  assert.equal(parsed.ok, true);
  const result = renderProject(parsed.value);
  assert.ok(result.mix.left.every(x => x === 0));
});
