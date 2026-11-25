import fs from 'node:fs';
import type { EditOp } from './edit.js';
import { critiqueProject, importNotes } from './ops.js';
import { saveProjectFile } from './project.js';
import { ToolError, findTool, readProject } from '../tools.js';

export const SCORE_USAGE = `Project
  init <project.json> --id <id> [--bpm 120 --bars 16 --tonic D --mode minor --kind loop --target-lufs -16]
  validate <project.json>
  lint <score.json> [--style strict|free]
  dump <project.json> [--full]
  add-track <project.json> --track '<json>'
  remove-track <project.json> --track-id <id>
  add-clip <project.json> --track-id <id> --clip '<json>'
  add-notes <project.json> --track-id <id> --clip-id <id> --notes '<json array>'
  set-instrument <project.json> --track-id <id> --instrument '<json|type>'
  add-fx <project.json> --track-id <id> --fx '<json>'
  add-automation <project.json> --track-id <id> --automation '<json>'
  import-notes <score.notes.json> <project.json>
  import-abc <tune.abc> --out <project.json>
  export-abc <project.json> --out <tune.abc>
  import-midi <file.mid> (--out <project.json> | --into <existing.json>)
  export-musicxml <project.json> --out <score.musicxml>

Sound
  audition <project.json> --out <dir>
  masking <project.json>
  render <recipe.json | project.json> --out <file.wav>
         Score options: [--bit-depth 24] [--stems-dir dir] [--repeats 2] [--layers base,combat] [--tracks id1,id2]
         --repeats N   loops only: --out X.wav keeps one pass and X_xN.wav beside it holds N; both paths
                       are printed as "out" and "repeatedOut"
         --tracks ids  render only these tracks, muted or not (alias --solo); the master still
                       normalizes the result to the target LUFS
         The report lists each track's peak, LUFS and RMS dBFS before the master bus, and warns
         (trackBalance) when a track sits over 16 LU below the loudest.
  critique <project.json> [--min 0.85]
  analyze <file.wav | project.json>
  edit <op> --in <a.wav> [--in <b.wav>] --out <file> [--backend native|sox|rubberband|ffmpeg] [--<param> value ...]
       ops: trim-silence, fade, normalize, pitch, stretch, layer, export
       export --codec opus|ogg|mp3|flac [--bitrate 96k]: encode through ffmpeg with bitexact flags,
       so the same WAV gives the same bytes (defaults: opus 96k VBR, ogg 128k, mp3 192k)
  export-midi <project.json> --out <file.mid>

  mcp     stdio MCP server exposing project and audio tools`;

interface Parsed {
  readonly positional: string[];
  readonly flags: Map<string, string[]>;
}

function parseArgs(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? '';
    if (a.startsWith('--')) {
      const key = a.slice(2).replace(/[A-Z]/g, c => '-' + c.toLowerCase());
      const next = argv[i + 1];
      const missing = next === undefined || next.startsWith('--');
      if (missing && !BOOLEAN_FLAGS.has(key)) throw new ToolError(`--${key} requires a value`);
      const value = missing ? 'true' : (i += 1, next);
      flags.set(key, [...(flags.get(key) ?? []), value]);
    } else positional.push(a);
  }
  return { positional, flags };
}

const camel = (k: string): string => k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

const BOOLEAN_FLAGS = new Set(['overwrite', 'full', 'loop', 'preserve-duration']);
const JSON_FLAGS = new Set(['track', 'clip', 'notes', 'fx', 'automation', 'gains-db', 'offsets-s']);
const EDIT_FLAGS: Record<EditOp, readonly string[]> = {
  'trim-silence': ['threshold-db', 'pad-ms'],
  fade: ['in-s', 'out-s', 'curve'],
  normalize: ['lufs', 'peak-db', 'category', 'ceiling-dbtp', 'loop'],
  pitch: ['semitones', 'preserve-duration'],
  stretch: ['ratio'],
  layer: ['gains-db', 'offsets-s'],
  export: ['codec', 'bitrate'],
};

function flagArgs(flags: Map<string, string[]>, skip: readonly string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, values] of flags) {
    if (skip.includes(key)) continue;
    const value = values[values.length - 1];
    if (BOOLEAN_FLAGS.has(key)) {
      if (value !== 'true' && value !== 'false') throw new ToolError(`--${key} expects true or false`);
      out[camel(key)] = value === 'true';
    } else if (JSON_FLAGS.has(key) || (key === 'instrument' && /^[{"]/.test(value.trimStart()))) {
      out[camel(key)] = JSON.parse(value) as unknown;
    } else {
      out[camel(key)] = value;
    }
  }
  return out;
}

const COMMAND_TOOL: Readonly<Record<string, string>> = {
  init: 'project_init',
  validate: 'project_validate',
  dump: 'project_dump',
  'add-track': 'add_track',
  'remove-track': 'remove_track',
  'add-clip': 'add_clip',
  'add-notes': 'add_notes',
  'set-instrument': 'set_instrument',
  'add-fx': 'add_fx',
  'add-automation': 'add_automation',
  render: 'render',
  masking: 'masking',
  audition: 'audition',
  'export-midi': 'export_midi',
  'export-abc': 'export_abc',
  'export-musicxml': 'export_musicxml',
};

function print(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function callTool(name: string, args: Record<string, unknown>): number {
  const tool = findTool(name);
  if (tool === undefined) throw new ToolError(`no tool ${name}`);
  const r = tool.run(args);
  print(r.data);
  return r.ok ? 0 : 1;
}

export function scoreCommand(cmd: string, rest: readonly string[]): number {
  const { positional, flags } = parseArgs(rest);
  const first = positional[0];
  const tool = COMMAND_TOOL[cmd];
  if (tool !== undefined) {
    if (first === undefined) throw new ToolError(`${cmd} needs a project path`);
    const args: Record<string, unknown> = { project: first, ...flagArgs(flags) };
    if (cmd === 'render') {
      // Ids and layer names stay strings, so `--tracks 1` is track "1", not the number 1.
      for (const k of ['layers', 'tracks', 'solo']) {
        const v = flags.get(k)?.at(-1);
        if (v !== undefined) args[k] = v.split(',').map((x) => x.trim()).filter((x) => x !== '');
      }
    }
    return callTool(tool, args);
  }
  switch (cmd) {
    case 'import-abc':
    case 'import-midi': {
      const input = cmd === 'import-abc' ? 'abc' : 'midi';
      const options = input === 'abc' ? ['out'] : ['out', 'into'];
      if (!first || positional.length !== 1 || flags.size !== 1) throw new ToolError('Usage: ' + cmd + ' <file> ' + options.map(k => '--' + k + ' <project.json>').join(' | '));
      const [key, values] = [...flags][0];
      if (!options.includes(key) || values.length !== 1 || values[0] === 'true') throw new ToolError('Expected a project path for ' + cmd);
      return callTool('import_' + input, { [input]: first, [key]: values[0] });
    }
    case 'lint': {
      if (first === undefined || positional.length !== 1 || [...flags.keys()].some(k => k !== 'style') || (flags.get('style')?.length ?? 0) > 1)
        throw new ToolError('Usage: lint <score.json> [--style strict|free]');
      return callTool('lint', { score: first, style: flags.get('style')?.[0] });
    }
    case 'critique': {
      if (first === undefined) throw new ToolError('critique needs a project path');
      const result = critiqueProject(readProject(first));
      print(result);
      const value = flags.get('min')?.at(-1);
      if (value === undefined) return 0;
      const min = Number(value);
      if (!Number.isFinite(min) || min < 0 || min > 1) throw new ToolError('--min requires a number from 0 to 1');
      return result.score < min ? 1 : 0;
    }
    case 'analyse':
    case 'analyze':
      if (first === undefined) throw new ToolError('analyze needs a file');
      return callTool('analyse', first.endsWith('.wav') ? { wav: first } : { project: first });
    case 'edit': {
      const op = first;
      if (op === undefined) throw new ToolError('edit needs an op');
      if (!Object.hasOwn(EDIT_FLAGS, op)) throw new ToolError(`unknown edit operation "${op}"`);
      const common = ['in', 'out', 'backend', 'bit-depth'];
      const allowed = [...common, ...EDIT_FLAGS[op as EditOp]];
      for (const key of flags.keys()) {
        if (!allowed.includes(key)) throw new ToolError(`Unknown flag for edit ${op}: --${key}`);
      }
      const inputs = flags.get('in') ?? [];
      const out = flags.get('out')?.[0];
      if (out === undefined) throw new ToolError('edit needs --out');
      const backend = flags.get('backend')?.[0];
      const bitDepth = flags.get('bit-depth')?.[0];
      return callTool('edit', {
        op,
        inputs,
        out,
        ...(backend !== undefined ? { backend } : {}),
        ...(bitDepth !== undefined ? { bitDepth: Number(bitDepth) } : {}),
        params: flagArgs(flags, common),
      });
    }
    case 'import-notes': {
      const out = positional[1];
      if (first === undefined || out === undefined) throw new ToolError('import-notes needs <score.notes.json> <project.json>');
      const r = importNotes(JSON.parse(fs.readFileSync(first, 'utf8')) as unknown);
      if (!r.ok) {
        print({ errors: r.errors });
        return 1;
      }
      saveProjectFile(out, r.value);
      print({ project: out, warnings: r.warnings });
      return 0;
    }
    default:
      throw new ToolError(`unknown command "${cmd}"\n\n${SCORE_USAGE}`);
  }
}
