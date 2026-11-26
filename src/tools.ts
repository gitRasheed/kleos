import path from 'node:path';
import fs from 'node:fs';
import { lintScore } from './theory/index.js';
import { parseLintScore } from './score/theory.js';
import { EDIT_OPS, runEdit, type Backend, type EditOp } from './score/edit.js';
import { PROFILES, parseProfile } from './ears/profiles.js';
import { analyzeAudioFile, inspectMix, dump, checkFile, renderToFiles, writeMidi } from './score/ops.js';
import {
  KINDS,
  LAYERS,
  MODES,
  initProject,
  loadProjectFile,
  saveProjectFile,
  type Layer,
  type ParseResult,
  type Project,
  type ProjectKind,
} from './score/project.js';

import { importAbcProject, importPerformance, projectNotation } from './notation/projectBridge.js';
import { readMidiFile } from './notation/midiBridge.js';
import { writeAbc } from './notation/abcBridge.js';
import { writeMusicXml } from './notation/musicxmlBridge.js';

type Args = Readonly<Record<string, unknown>>;

export interface ToolResult {
  readonly ok: boolean;
  readonly data: unknown;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  // Verdict tools report pass/fail in their data; a failing verdict is still a successful call.
  readonly verdict?: boolean;
  run(args: Args): ToolResult;
}

export class ToolError extends Error {}

const s = (description: string): Record<string, unknown> => ({ type: 'string', description });
const n = (description: string): Record<string, unknown> => ({ type: 'number', description });
const o = (description: string): Record<string, unknown> => ({ type: 'object', description });
const schema = (properties: Record<string, unknown>, required: readonly string[]): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false });

function reqStr(a: Args, k: string): string {
  const v = a[k];
  if (typeof v !== 'string' || v === '') throw new ToolError(`"${k}" must be a non-empty string`);
  return v;
}

function optNum(a: Args, k: string): number | undefined {
  const v = a[k];
  if (v === undefined) return undefined;
  const x = typeof v === 'string' ? Number(v) : v;
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new ToolError(`"${k}" must be a number`);
  return x;
}

function optStr(a: Args, k: string): string | undefined {
  const v = a[k];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new ToolError(`"${k}" must be a string`);
  return v;
}

type Defined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

function defined<T extends object>(o: T): Defined<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Defined<T>;
}

function load(a: Args): Project {
  const file = reqStr(a, 'project');
  return readProject(file);
}

function bitDepth(args: Args) {
  const depth = optNum(args, 'bitDepth');
  if (depth !== undefined && depth !== 16 && depth !== 24 && depth !== 32) throw new ToolError('bitDepth must be 16, 24 or 32');
  return depth;
}

export function readProject(file: string): Project {
  const r = loadProjectFile(file);
  if (!r.ok) throw new ToolError(`project ${file} is invalid:\n${r.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`);
  return r.value;
}

function commit(a: Args, r: ParseResult<Project>): ToolResult {
  if (!r.ok) return { ok: false, data: { errors: r.errors, warnings: r.warnings } };
  saveProjectFile(reqStr(a, 'project'), r.value);
  return { ok: true, data: { project: reqStr(a, 'project'), warnings: r.warnings, summary: dump(r.value) } };
}

const projectArg = { project: s('Path to the kleos/score/v1 project JSON file') };

const checkTool: Tool = {
  name: 'check',
  verdict: true,
  description: 'Objective listening gate on a WAV: BS.1770-4 loudness, 4x true peak, loop seam vs bar lines, DC, clicks, 50/60 Hz hum, silent channel, stereo phase, spectral balance; writes waveform and spectrogram PNGs.',
  inputSchema: schema({
    wav: s('WAV path'), project: s('Project path for tempo, loop and loudness target'),
    profile: { type: 'string', enum: PROFILES }, requireRolloff: { type: 'boolean' },
    pngDir: s('Directory for PNGs'), loop: { type: 'boolean' }, bpm: n('Tempo for bar-line seam comparison'),
    beatsPerBar: { type: 'integer', minimum: 1, description: 'Beats per bar for seam comparison' },
  }, ['wav']),
  run: (a) => {
    const p = typeof a.project === 'string' ? load(a) : null;
    const profile = optStr(a, 'profile');
    const report = checkFile(reqStr(a, 'wav'), p, defined({
      profile: profile === undefined ? undefined : parseProfile(profile), pngDir: optStr(a, 'pngDir'),
      loop: typeof a.loop === 'boolean' ? a.loop : undefined, bpm: optNum(a, 'bpm'), beatsPerBar: optNum(a, 'beatsPerBar'), requireRolloff: a.requireRolloff === true,
    }));
    return { ok: report.ok, data: report };
  },
};

export const TOOLS: readonly Tool[] = [
  {
    name: 'project_init',
    description: 'Create a new kleos/score/v1 project file. Pick a tempo whose loop is an integer number of frames (120 BPM is always safe).',
    inputSchema: schema({ ...projectArg, id: s('Project id'), title: s('Title'), kind: { type: 'string', enum: KINDS }, bpm: n('Tempo'), beatsPerBar: n('Beats per bar'), bars: n('Length in bars'), tonic: s('Key tonic, e.g. D or Bb'), mode: { type: 'string', enum: Object.keys(MODES) }, targetLufs: n('Master loudness target'), overwrite: { type: 'boolean' } }, ['project', 'id']),
    run: (a) => {
      const file = reqStr(a, 'project');
      if (fs.existsSync(file) && a.overwrite !== true) throw new ToolError(`${file} exists; pass overwrite: true to replace it`);
      const kind = optStr(a, 'kind');
      const r = initProject({
        id: reqStr(a, 'id'),
        ...defined({
          title: optStr(a, 'title'),
          kind: kind as ProjectKind | undefined,
          bpm: optNum(a, 'bpm'),
          beatsPerBar: optNum(a, 'beatsPerBar'),
          bars: optNum(a, 'bars'),
          tonic: optStr(a, 'tonic'),
          mode: optStr(a, 'mode'),
          targetLufs: optNum(a, 'targetLufs'),
        }),
      });
      return commit(a, r);
    },
  },
  {
    name: 'project_validate',
    verdict: true,
    description: 'Parse and lint a project: schema errors, non-integer loop frames, notes past the end, automation that jumps at the wrap.',
    inputSchema: schema(projectArg, ['project']),
    run: (a) => {
      const r = loadProjectFile(reqStr(a, 'project'));
      return r.ok ? { ok: true, data: { valid: true, warnings: r.warnings } } : { ok: false, data: { valid: false, errors: r.errors, warnings: r.warnings } };
    },
  },
  {
    name: 'project_dump',
    description: 'Summarize a project (tracks, note counts, fx, sections). Pass full: true for the normalized JSON.',
    inputSchema: schema({ ...projectArg, full: { type: 'boolean' } }, ['project']),
    run: (a) => {
      const p = load(a);
      return { ok: true, data: a.full === true ? p : dump(p) };
    },
  },
  {
    name: 'render',
    description: 'Render the project to a 48 kHz stereo WAV through the loop-safe master bus. Reports per-track peak, LUFS and RMS before the master, plus trackBalance warnings for tracks over 16 LU under the loudest. Optional per-layer stems, a track subset, and an N-times looped file written beside out as <name>_xN.wav.',
    inputSchema: schema({
      ...projectArg, out: s('Output WAV path'), bitDepth: { type: 'number', enum: [16, 24, 32] },
      stemsDir: s('Directory for per-layer stems'),
      repeats: { type: 'integer', minimum: 1, description: 'For loops, N > 1 also writes <name>_xN.wav with N passes' },
      layers: { type: 'array', items: { type: 'string', enum: LAYERS } },
      tracks: { type: 'array', items: { type: 'string' }, description: 'Render the selected tracks even when muted. The master normalizes to the target LUFS.' },
    }, ['project', 'out']),
    run: (a) => {
      const p = load(a);
      const bd = bitDepth(a);
      const layers = Array.isArray(a.layers) ? (a.layers as unknown[]).map(String) : undefined;
      if (layers?.some((l) => !(LAYERS as readonly string[]).includes(l))) throw new ToolError(`layers must be among ${LAYERS.join(', ')}`);
      const trackIds = Array.isArray(a.tracks) ? (a.tracks as string[]) : undefined;
      return {
        ok: true,
        data: renderToFiles(p, {
          projectDir: path.dirname(reqStr(a, 'project')),
          out: reqStr(a, 'out'),
          ...defined({ bitDepth: bd, stemsDir: optStr(a, 'stemsDir'), repeats: optNum(a, 'repeats'), layers: layers as Layer[] | undefined, trackIds }),
        }),
      };
    },
  },
  {
    name: 'edit',
    description: `Edit WAV files: ${EDIT_OPS.join(', ')}. Backends: native (default), sox, rubberband (pitch/stretch), ffmpeg (export to other formats). Export params codec opus|ogg|mp3|flac and bitrate (e.g. 96k) encode deterministically through ffmpeg.`,
    inputSchema: schema({ op: { type: 'string', enum: EDIT_OPS }, inputs: { type: 'array', items: { type: 'string' } }, out: s('Output path'), backend: { type: 'string', enum: ['native', 'sox', 'rubberband', 'ffmpeg'] }, bitDepth: { type: 'number', enum: [16, 24, 32] }, params: o('Op parameters, e.g. {semitones}, {ratio}, {lufs|profile|peakDb}, {in, out}, {codec, bitrate}') }, ['op', 'inputs', 'out']),
    run: (a) => {
      const op = reqStr(a, 'op');
      if (!(EDIT_OPS as readonly string[]).includes(op)) throw new ToolError(`op must be one of ${EDIT_OPS.join(', ')}`);
      const inputs = Array.isArray(a.inputs) ? (a.inputs as unknown[]).map(String) : [];
      const bd = bitDepth(a);
      return {
        ok: true,
        data: runEdit({
          op: op as EditOp,
          inputs,
          out: reqStr(a, 'out'),
          ...(optStr(a, 'backend') !== undefined ? { backend: optStr(a, 'backend') as Backend } : {}),
          ...defined({ bitDepth: bd }),
          ...(typeof a.params === 'object' && a.params !== null ? { params: a.params as Record<string, unknown> } : {}),
        }),
      };
    },
  },
  {
    name: 'analyze',
    description: 'Measure WAV loudness, spectrum and stereo balance.',
    inputSchema: schema({ wav: s('WAV path') }, ['wav']),
    run: a => ({ ok: true, data: analyzeAudioFile(reqStr(a, 'wav')) }),
  },
  {
    name: 'lint',
    verdict: true,
    description: 'Check score notation, instrument ranges and voice leading. Findings include a one-based bar and beat, voice, and track id.',
    inputSchema: schema({ score: s('Path to the score JSON'), style: { type: 'string', enum: ['strict', 'free'] } }, ['score']),
    run: (a) => {
      const raw: unknown = JSON.parse(fs.readFileSync(reqStr(a, 'score'), 'utf8'));
      const score = parseLintScore(raw, a.style);
      const findings = lintScore(score);
      const ok = findings.every(d => d.severity !== 'error');
      return { ok, data: { ok, style: score.style, findings } };
    },
  },
  {
    name: 'masking',
    description: 'Locate lead masking and mono loss in the rendered project.',
    inputSchema: schema(projectArg, ['project']),
    run: a => ({ ok: true, data: inspectMix(load(a), path.dirname(reqStr(a, 'project'))) }),
  },
  {
    name: 'audition',
    description: 'Write an offline stem audition player with synchronized playback and located mix findings.',
    inputSchema: schema({ ...projectArg, out: s('Output directory for index.html') }, ['project', 'out']),
    run: a => ({ ok: true, data: inspectMix(load(a), path.dirname(reqStr(a, 'project')), reqStr(a, 'out')) }),
  },
  checkTool,
  {
    name: 'import_abc',
    description: 'Import one ABC tune into a DAW project, retaining its written notation.',
    inputSchema: schema({ abc: s('Input ABC path'), out: s('Output project JSON path') }, ['abc', 'out']),
    run: a => {
      const out = reqStr(a, 'out');
      return commit({ project: out }, importAbcProject(fs.readFileSync(reqStr(a, 'abc'), 'utf8'), path.parse(out).name));
    },
  },
  {
    name: 'import_midi',
    description: 'Import a Type 1 MIDI file. Use out for a new project, or into to replace notes on matching tracks in an existing mix.',
    inputSchema: { ...schema({ midi: s('Input MIDI path'), into: s('Existing project to update'), out: s('New project path') }, ['midi']),
      oneOf: [{ required: ['into'] }, { required: ['out'] }] },
    run: a => {
      if ((a.into === undefined) === (a.out === undefined)) throw new ToolError('Specify exactly one of into or out');
      const file = reqStr(a, a.into === undefined ? 'out' : 'into');
      const into = a.into === undefined ? undefined : readProject(file);
      const song = readMidiFile(fs.readFileSync(reqStr(a, 'midi')));
      return commit({ project: file }, importPerformance(song, path.parse(file).name, into));
    },
  },
  ...([['export_abc', 'ABC', writeAbc], ['export_musicxml', 'MusicXML 4.0', writeMusicXml]] as const).map(([name, format, serialize]): Tool => ({
    name,
    description: 'Export each project track as a part in ' + format + '.',
    inputSchema: schema({ ...projectArg, out: s('Output notation path') }, ['project', 'out']),
    run: a => {
      const file = reqStr(a, 'out');
      const notation = serialize(projectNotation(load(a)));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, notation);
      return { ok: true, data: { file, bytes: Buffer.byteLength(notation) } };
    },
  })),
  {
    name: 'export_midi',
    description: 'Export the project as a Standard MIDI File, type 1, 480 PPQ: a conductor track (tempo, meter, key, section markers) plus one track per instrument.',
    inputSchema: schema({ ...projectArg, out: s('Output .mid path') }, ['project', 'out']),
    run: (a) => ({ ok: true, data: writeMidi(load(a), reqStr(a, 'out')) }),
  },
];

export function findTool(name: string): Tool | undefined {
  return TOOLS.find((t) => t.name === name);
}
