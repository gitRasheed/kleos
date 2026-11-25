import fs from 'node:fs';
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
  render <project.json> --out <file.wav> [--bit-depth 24] [--stems-dir dir] [--repeats 2] [--layers base,combat] [--tracks id1,id2]
         --repeats N   loops only: --out X.wav keeps one pass and X_xN.wav beside it holds N; both paths
                       are printed as "out" and "repeatedOut"
         --tracks ids  render only these tracks, muted or not (alias --solo); the master still
                       normalises the result to the target LUFS
         The report lists each track's peak, LUFS and RMS dBFS before the master bus, and warns
         (trackBalance) when a track sits over 16 LU below the loudest.
  critique <project.json> [--min 0.85]
  analyse <file.wav | project.json>
  edit <op> --in <a.wav> [--in <b.wav>] --out <file> [--backend native|sox|rubberband|ffmpeg] [--<param> value ...]
       ops: trim-silence, fade, normalize, pitch, stretch, layer, export
       export --codec opus|ogg|mp3|flac [--bitrate 96k]: encode through ffmpeg with bitexact flags,
       so the same WAV gives the same bytes (defaults: opus 96k VBR, ogg 128k, mp3 192k)
  export-midi <project.json> --out <file.mid>

  mcp     stdio MCP server exposing project and audio tools

Exit codes: 0 pass, 1 failed check (invalid project, gate findings, critic below --min), 2 usage or runtime error.`;

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
      const key = a.slice(2);
      const next = argv[i + 1];
      const value = next === undefined || next.startsWith('--') ? 'true' : (i += 1, next);
      flags.set(key, [...(flags.get(key) ?? []), value]);
    } else positional.push(a);
  }
  return { positional, flags };
}

const camel = (k: string): string => k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

function jsonish(v: string): unknown {
  const t = v.trim();
  if (t === 'true' || t === 'false') return t === 'true';
  if (t !== '' && Number.isFinite(Number(t))) return Number(t);
  if (t.startsWith('{') || t.startsWith('[') || t.startsWith('"')) return JSON.parse(t) as unknown;
  return v;
}

function flagArgs(flags: Map<string, string[]>, skip: readonly string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, vs] of flags) if (!skip.includes(k)) out[camel(k)] = jsonish(vs[vs.length - 1] ?? '');
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
      if (first === undefined) throw new ToolError('analyse needs a file');
      return callTool('analyse', first.endsWith('.wav') ? { wav: first } : { project: first });
    case 'edit': {
      const op = first;
      if (op === undefined) throw new ToolError('edit needs an op');
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
        params: flagArgs(flags, ['in', 'out', 'backend', 'bit-depth']),
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
