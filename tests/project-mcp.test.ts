import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { expandTrackNotes, initProject, parseProject } from '../src/score/project.js';
import { tmpDir, track } from './helpers.js';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/cli.js');

test('parse errors name the JSON path', () => {
  const r = parseProject({ format: 'agent-daw/v1', id: 'x', bars: 2, tracks: [{ id: 't', instrument: 'kazoo', clips: [{ id: 'c', notes: [{ midi: 200, startBeat: 0, durationBeats: 1 }] }] }] });
  assert.equal(r.ok, false);
  const paths = r.ok ? [] : r.errors.map((e) => e.path);
  assert.ok(paths.includes('$.tracks[0].instrument.type'));
  assert.ok(paths.includes('$.tracks[0].clips[0].notes[0].midi'));
});

test('a tempo with a fractional loop length warns; 120 BPM does not', () => {
  const at = (bpm: number): number => {
    const r = initProject({ id: 'x', bpm, bars: 16 });
    assert.ok(r.ok);
    return r.warnings.length;
  };
  assert.equal(at(120), 0);
  assert.equal(at(110), 1);
});

test('patterns expand with repeat and transpose', () => {
  const r = parseProject({ format: 'agent-daw/v1', id: 'x', bars: 4, patterns: { riff: { lengthBeats: 2, notes: [{ midi: 50, startBeat: 0, durationBeats: 1 }, { midi: 53, startBeat: 1, durationBeats: 1 }] } }, tracks: [{ id: 'g', instrument: 'guitar-electric', clips: [{ id: 'c', startBeat: 4, pattern: 'riff', repeat: 3, transpose: 2 }] }] });
  assert.ok(r.ok);
  if (!r.ok) return;
  const t = r.value.tracks[0];
  assert.ok(t !== undefined);
  assert.deepEqual(expandTrackNotes(r.value, t).map((n) => [n.midi, n.startBeat]), [[52, 4], [55, 5], [52, 6], [55, 7], [52, 8], [55, 9]]);
});

class McpClient {
  private readonly proc = spawn(process.execPath, [cli, 'mcp'], { stdio: ['pipe', 'pipe', 'inherit'] });
  private readonly pending = new Map<number, { resolve(v: Record<string, unknown>): void; reject(err: Error): void }>();
  readonly unsolicited: unknown[] = [];
  private next = 1;
  constructor() {
    this.proc.once('exit', (code) => {
      for (const pending of this.pending.values()) pending.reject(new Error(`MCP exited with code ${code}`));
      this.pending.clear();
    });
    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => {
      const msg = JSON.parse(line) as { id?: number } & Record<string, unknown>;
      const pending = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
      if (pending === undefined) this.unsolicited.push(msg);
      else {
        this.pending.delete(msg.id as number);
        pending.resolve(msg);
      }
    });
  }
  request(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })}\n`);
    });
  }
  notify(method: string): void {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }
  async call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: unknown }> {
    const msg = await this.request('tools/call', { name, arguments: args });
    const result = msg.result as { isError: boolean; content: { text: string }[] };
    const text = result.content[0]?.text ?? '';
    return { isError: result.isError, data: result.isError ? text : (JSON.parse(text) as unknown) };
  }
  kill(): void {
    if (this.proc.exitCode === null) this.proc.kill();
  }
  close(): Promise<void> {
    return new Promise((resolve) => {
      this.proc.on('exit', () => resolve());
      this.proc.stdin.end();
    });
  }
}

test('MCP stdio server: handshake, the audio and score tools, and a compose-render-gate-export round trip', async () => {
  const dir = tmpDir();
  const proj = path.join(dir, 'cue.json');
  const c = new McpClient();
  try {
    await roundTrip(c, dir, proj);
  } finally {
    c.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP checks the published input schema before running a tool', async t => {
  const c = new McpClient();
  t.after(() => c.kill());
  const project = 'missing.json';
  const invalid = [
    ['project_dump', { project, extra: 1 }, /extra/],
    ['project_dump', {}, /project/],
    ['project_init', { project, id: 'cue', bars: '2' }, /bars/],
    ['render', { project, out: 'x.wav', repeats: 0 }, /repeats/],
    ['render', { project, out: 'x.wav', repeats: 1.5 }, /repeats/],
    ['render', { project, out: 'x.wav', tracks: [1] }, /tracks/],
    ['check', { wav: 'x.wav', profile: 'unknown' }, /profile/],
    ['import_midi', { midi: 'x.mid', into: project, out: project }, /oneOf/],
  ] as const;
  for (const [name, args, expected] of invalid) {
    const result = await c.call(name, args);
    assert.equal(result.isError, true);
    assert.match(String(result.data), expected);
  }
});

async function roundTrip(c: McpClient, dir: string, proj: string): Promise<void> {
  const init = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal((init.result as { serverInfo: { name: string } }).serverInfo.name, 'kleos');
  c.notify('notifications/initialized');
  const list = await c.request('tools/list');
  const names = (list.result as { tools: { name: string }[] }).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['analyze', 'audition', 'masking', 'check', 'edit', 'export_midi', 'export_abc', 'export_musicxml', 'import_abc', 'import_midi', 'lint', 'project_dump', 'project_init', 'project_validate', 'render'].sort());

  assert.equal((await c.call('project_init', { project: proj, id: 'cue', bars: 2, bpm: 120, tonic: 'D', mode: 'minor' })).isError, false);
  const score = JSON.parse(fs.readFileSync(proj, 'utf8'));
  score.tracks = [track('horn', 'brass-horn', [
    { midi: 62, startBeat: 0, durationBeats: 4 }, { midi: 69, startBeat: 4, durationBeats: 4 },
  ])];
  fs.writeFileSync(proj, JSON.stringify(score));
  assert.equal((await c.call('project_validate', { project: proj })).isError, false);

  const dumped = (await c.call('project_dump', { project: proj })).data as { tracks: { notes: number }[] };
  assert.deepEqual(dumped.tracks.map((t) => t.notes), [2]);

  const wav = path.join(dir, 'cue.wav');
  const rendered = await c.call('render', { project: proj, out: wav, bitDepth: 24 });
  assert.equal(rendered.isError, false);
  assert.equal((rendered.data as { schemaVersion: string }).schemaVersion, 'kleos/render/v1');
  assert.ok(fs.existsSync(wav));
  const gate = await c.call('check', { wav, project: proj, profile: 'music', beatsPerBar: 4 });
  assert.equal(typeof (gate.data as { ok?: unknown }).ok, 'boolean');
  const audio = (await c.call('analyze', { wav })).data as { loudness: { integratedLufs: number } };
  assert.ok(Math.abs(audio.loudness.integratedLufs + 16) < 0.5);
  await c.call('edit', { op: 'normalize', inputs: [wav], out: path.join(dir, 'n.wav'), params: { lufs: -18 } });
  assert.ok(fs.existsSync(path.join(dir, 'n.wav')));
  await c.call('export_midi', { project: proj, out: path.join(dir, 'cue.mid') });
  assert.ok(fs.readFileSync(path.join(dir, 'cue.mid')).subarray(0, 4).toString() === 'MThd');

  const unknown = await c.request('nope/method');
  assert.equal((unknown.error as { code: number }).code, -32601);
  await c.close();
  assert.deepEqual(c.unsolicited, [], 'notifications must not get responses');
}
