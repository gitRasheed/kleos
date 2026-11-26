import type { EditOp } from './edit.js';
import { ToolError, findTool } from '../tools.js';

export const SCORE_USAGE = `Project
  init <project.json> --id <id> [--title <title>] [--overwrite] [--bpm 120 --beats-per-bar 4 --bars 16 --tonic D --mode minor --kind loop --target-lufs -16]
  validate <project.json>
  lint <score.json> [--style strict|free]
  dump <project.json> [--full]
  import-abc <tune.abc> --out <project.json>
  export-abc <project.json> --out <tune.abc>
  import-midi <file.mid> (--out <project.json> | --into <existing.json>)
  export-musicxml <project.json> --out <score.musicxml>

Sound
  audition <project.json> --out <dir>
  masking <project.json>
  render <recipe.json | project.json> --out <file.wav>
         Score options: [--bit-depth 24] [--stems-dir dir] [--repeats 2] [--layers <layer1,layer2>] [--tracks id1,id2]
         --repeats N   loops only: --out X.wav keeps one pass and X_xN.wav beside it holds N; both paths
                       are printed as "out" and "repeatedOut"
         --tracks ids  render the selected tracks even when muted. The master normalizes to the target LUFS.
         The report lists each track's peak, LUFS and RMS dBFS before the master bus, and warns
         (trackBalance) when a track sits over 16 LU below the loudest.
  analyze <file.wav>
  edit <op> --in <a.wav> [--in <b.wav>] --out <file> [--bit-depth 16|24|32] [--backend native|sox|rubberband|ffmpeg] [--<param> value ...]
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
const JSON_FLAGS = new Set(['gains-db', 'offsets-s']);
const EDIT_FLAGS: Record<EditOp, readonly string[]> = {
  'trim-silence': ['threshold-db', 'pad-ms'],
  fade: ['in-s', 'out-s', 'curve'],
  normalize: ['lufs', 'peak-db', 'profile', 'ceiling-dbtp', 'loop'],
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
    } else if (JSON_FLAGS.has(key)) {
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
  const tool = Object.hasOwn(COMMAND_TOOL, cmd) ? COMMAND_TOOL[cmd] : undefined;
  if (tool !== undefined) {
    if (positional.length !== 1) throw new ToolError(cmd + ' needs one project path');
    const properties = findTool(tool)?.inputSchema.properties;
    for (const key of flags.keys()) {
      if (key === 'project' || !properties || !Object.hasOwn(properties, camel(key))) throw new ToolError('Unknown flag for ' + cmd + ': --' + key);
    }
    const args: Record<string, unknown> = { project: first, ...flagArgs(flags) };
    if (cmd === 'render') {
      // Ids and layer names stay strings, so `--tracks 1` is track "1", not the number 1.
      for (const k of ['layers', 'tracks']) {
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
    case 'analyze':
      if (positional.length !== 1 || flags.size) throw new ToolError('Usage: analyze <file.wav>');
      return callTool('analyze', { wav: first });
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
    default:
      process.stderr.write(`Unknown command ${JSON.stringify(cmd)}. Run kleos --help.\n`);
      return 2;
  }
}
