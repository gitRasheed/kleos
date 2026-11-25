#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { serveStdio } from './mcp.js';
import { SCORE_USAGE, scoreCommand } from './score/commands.js';
import { checkFile } from './score/ops.js';
import { readProject } from './tools.js';
import { parseProfile } from './ears/profiles.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAudio, DEFAULT_LOOP_DISCONTINUITY_RATIO, DEFAULT_THRESHOLDS } from './ears/check.js';
import { checkMix, MIX_THRESHOLD_KEYS, MixError, mixStems, parseMixFlag, parseMixManifest, type MixSpec } from './ears/mix.js';
import { writeInspectionPngs } from './io/png.js';
import { errorRow, formatSummaryTable, summaryRow, type SummaryRow } from './ears/summary.js';
import { RecipeError, renderRecipe, validateRecipe } from './recipe/synth.js';
import { FINDING_CODES, THRESHOLD_KEYS, WavError, type AudioBufferData, type CheckReport, type CheckThresholds } from './types.js';
import { decodeWav, encodeWav, readWavFile } from './io/wav.js';

const KNOWN_THRESHOLD_KEYS: ReadonlySet<string> = new Set(THRESHOLD_KEYS);

function usage(): string {
  const keyWidth = Math.max(...THRESHOLD_KEYS.map((key) => key.length));
  const thresholdLines = THRESHOLD_KEYS.map((key) => {
    const loopDefault =
      key === 'maxLoopDiscontinuityRatio' ? `${DEFAULT_LOOP_DISCONTINUITY_RATIO} with --loop` : 'off';
    return `  ${key.padEnd(keyWidth)}  ${DEFAULT_THRESHOLDS[key] ?? loopDefault}`;
  });
  return [
    'Usage:',
    '  agent-audio render <recipe.json> --out <file.wav>',
    '  agent-audio check <file.wav> [--profile raw|music|sfx|ui|ambience] [--project <score.json>] [--require-rolloff] [--bpm N] [--loop] [--strict] [--summary] [--png <dir>] [--out <report.json>] [--thresholds <json | file.json>]',
    '  agent-audio batch <dir> --out <dir> [--loop] [--strict] [--summary] [--png <dir>] [--thresholds <json | file.json>]',
    '  agent-audio mix-check <manifest.json> | --mix <a.wav:gainDb[@offsetS],...> [--out <report.json>] [--wav <mix.wav>] [--png <dir>] [--thresholds <json | file.json>]',
    '  agent-audio gate is an alias for check',
    '  agent-audio skill install [--project]',
    SCORE_USAGE,
    '  agent-audio --help',
    '',
    'Exit codes: 0 pass, 1 gate fail, 2 input/tool error',
    '--strict turns advisory warnings (ALIASING_SUSPECTED, QUIET_TAIL) into failures.',
    '--summary prints one table row per file instead of JSON.',
    '',
    'Threshold keys for --thresholds, with defaults:',
    ...thresholdLines,
    '',
    'WAV finding codes:',
    FINDING_CODES.join(', '),
  ].join('\n');
}

function parseCommandArgs(
  args: readonly string[],
  valueFlags: ReadonlySet<string>,
  boolFlags: ReadonlySet<string>,
): { readonly positional: readonly string[]; readonly flags: ReadonlyMap<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === undefined) {
      continue;
    }
    if (token.startsWith('--')) {
      if (boolFlags.has(token)) {
        flags.set(token, true);
      } else if (valueFlags.has(token)) {
        const val = args[i + 1];
        if (val === undefined || val.startsWith('--')) {
          throw new Error(`Flag ${token} requires a value`);
        }
        flags.set(token, val);
        i += 1;
      } else {
        throw new Error(`Unknown flag: ${token}`);
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function parseThresholds(raw: string | undefined, allowed: ReadonlySet<string> = KNOWN_THRESHOLD_KEYS): CheckThresholds {
  if (raw === undefined) {
    return {};
  }
  const content = fs.existsSync(raw) ? fs.readFileSync(raw, 'utf8') : raw;
  const parsed: unknown = JSON.parse(content);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Thresholds must be a JSON object');
  }
  const validated: Record<string, number> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!allowed.has(k)) {
      throw new Error(`Unknown threshold key: ${k} (allowed here: ${[...allowed].join(', ')})`);
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`Threshold '${k}' must be a finite number, got ${String(v)}`);
    }
    validated[k] = v;
  }
  return validated as CheckThresholds;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeWav(file: string, audio: AudioBufferData): Uint8Array {
  const bytes = encodeWav(audio.channels, audio.sampleRate, audio.format === 'float32' ? 'float32' : 'pcm16');
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, bytes);
  return bytes;
}

function renderRecipeData(data: unknown): { readonly id: string; readonly kind: string; readonly audio: AudioBufferData } {
  const recipe = validateRecipe(data);
  return { id: recipe.id, kind: recipe.kind, audio: renderRecipe(recipe) };
}

function runRender(args: readonly string[]): number {
  const parsed = parseCommandArgs(args, new Set(['--out', '--bit-depth', '--repeats', '--stems-dir', '--layers', '--solo', '--tracks']), new Set());
  const source = parsed.positional[0];
  const outPath = parsed.flags.get('--out');
  if (parsed.positional.length !== 1 || source === undefined || typeof outPath !== 'string') {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const data: unknown = JSON.parse(fs.readFileSync(source, 'utf8'));
  if (typeof data === 'object' && data !== null && 'format' in data) return scoreCommand('render', args);
  if (parsed.flags.size !== 1) throw new Error('Recipe render accepts only --out');
  const { id, kind, audio } = renderRecipeData(data);
  const bytes = writeWav(outPath, audio);
  const frames = audio.channels[0]?.length ?? 0;
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 'agent-audio/render/v1',
        ok: true,
        id,
        kind,
        out: outPath,
        sampleRateHz: audio.sampleRate,
        channels: audio.channels.length,
        encoding: audio.format === 'float32' ? 'float32' : 'pcm16',
        frames,
        durationS: Number((frames / audio.sampleRate).toFixed(6)),
        bytes: bytes.byteLength,
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

interface GateOptions {
  readonly loop: boolean;
  readonly strict: boolean;
  readonly thresholds: CheckThresholds;
  readonly pngDir: string | undefined;
}

function gate(audio: AudioBufferData, file: string, options: GateOptions): CheckReport {
  const report = checkAudio(audio, file, options);
  if (options.pngDir === undefined) {
    return report;
  }
  return { ...report, pngs: writeInspectionPngs(audio, options.pngDir, path.parse(file).name, options.loop) };
}

function stringFlag(flags: ReadonlyMap<string, string | true>, name: string): string | undefined {
  const v = flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

function runCheck(args: readonly string[]): number {
  const { positional, flags } = parseCommandArgs(
    args,
    new Set(['--png', '--png-dir', '--out', '--thresholds', '--profile', '--category', '--project', '--bpm', '--beats-per-bar']),
    new Set(['--loop', '--strict', '--summary', '--require-rolloff']),
  );
  const wavPath = positional[0];
  if (positional.length !== 1 || wavPath === undefined) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const project = stringFlag(flags, '--project');
  const profile = stringFlag(flags, '--profile') ?? stringFlag(flags, '--category');
  const pngDir = stringFlag(flags, '--png') ?? stringFlag(flags, '--png-dir');
  const report = checkFile(wavPath, project === undefined ? null : readProject(project), {
    ...(profile === undefined ? {} : { profile: parseProfile(profile) }),
    ...(flags.has('--loop') ? { loop: true } : {}),
    ...(flags.has('--bpm') ? { bpm: Number(flags.get('--bpm')) } : {}),
    ...(flags.has('--beats-per-bar') ? { beatsPerBar: Number(flags.get('--beats-per-bar')) } : {}),
    ...(pngDir === undefined ? {} : { pngDir }),
    strict: flags.has('--strict'), requireRolloff: flags.has('--require-rolloff'),
    thresholds: parseThresholds(stringFlag(flags, '--thresholds')),
  });
  const outJson = stringFlag(flags, '--out');
  if (outJson !== undefined) {
    writeJson(outJson, report);
  }
  process.stdout.write(
    flags.get('--summary') === true
      ? `${formatSummaryTable([summaryRow(report)])}\n`
      : `${JSON.stringify(report, null, 2)}\n`,
  );
  return report.ok ? 0 : 1;
}

const RECIPE_SUFFIX = '.recipe.json';

interface BatchEntry {
  readonly source: string;
  readonly ok: boolean;
  readonly row: SummaryRow;
  readonly wav?: string;
  readonly report?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

function errorInfo(err: unknown): { readonly code: string; readonly message: string } {
  const code =
    err instanceof WavError || err instanceof MixError
      ? err.code
      : err instanceof RecipeError
        ? 'INVALID_RECIPE'
        : 'CLI_ERROR';
  return { code, message: err instanceof Error ? err.message : String(err) };
}

// A recipe is the source of its WAV, so a WAV sharing a recipe's base name is the recipe's earlier render.
function batchSources(dir: string): readonly string[] {
  const names = fs.readdirSync(dir).sort();
  const recipeBases = new Set(names.filter((n) => n.endsWith(RECIPE_SUFFIX)).map((n) => n.slice(0, -RECIPE_SUFFIX.length)));
  return names.filter(
    (n) => n.endsWith(RECIPE_SUFFIX) || (n.toLowerCase().endsWith('.wav') && !recipeBases.has(n.slice(0, -4))),
  );
}

function batchOne(dir: string, name: string, outDir: string, options: GateOptions): BatchEntry {
  const source = path.join(dir, name);
  try {
    const isRecipe = name.endsWith(RECIPE_SUFFIX);
    const base = isRecipe ? name.slice(0, -RECIPE_SUFFIX.length) : path.parse(name).name;
    let audio: AudioBufferData;
    let wav = source;
    let loop = options.loop;
    if (isRecipe) {
      const rendered = renderRecipeData(JSON.parse(fs.readFileSync(source, 'utf8')) as unknown);
      loop = rendered.kind === 'loop';
      wav = path.join(outDir, `${base}.wav`);
      // Gate the quantised file on disk, so batch and check agree on it.
      audio = decodeWav(writeWav(wav, rendered.audio));
    } else {
      audio = readWavFile(source);
    }
    const report = gate(audio, wav, { ...options, loop });
    const reportPath = path.join(outDir, `${base}.report.json`);
    writeJson(reportPath, report);
    return { source, ok: report.ok, row: summaryRow(report, name), wav, report: reportPath };
  } catch (err) {
    const error = errorInfo(err);
    return { source, ok: false, row: errorRow(name, error.code), error };
  }
}

function runBatch(args: readonly string[]): number {
  const { positional, flags } = parseCommandArgs(
    args,
    new Set(['--out', '--png', '--thresholds']),
    new Set(['--loop', '--strict', '--summary']),
  );
  const dir = positional[0];
  const outDir = stringFlag(flags, '--out');
  if (positional.length !== 1 || dir === undefined || outDir === undefined) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const options: GateOptions = {
    loop: flags.get('--loop') === true,
    strict: flags.get('--strict') === true,
    thresholds: parseThresholds(stringFlag(flags, '--thresholds')),
    pngDir: stringFlag(flags, '--png'),
  };
  const sources = batchSources(dir);
  if (sources.length === 0) {
    throw new Error(`No *.recipe.json or *.wav files in ${dir}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const entries = sources.map((name) => batchOne(dir, name, outDir, options));

  if (flags.get('--summary') === true) {
    process.stdout.write(`${formatSummaryTable(entries.map((e) => e.row))}\n`);
  } else {
    const results = entries.map(({ row, ...rest }) => ({ ...rest, verdict: row.verdict, findings: row.findings }));
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 'agent-audio/batch/v1', ok: entries.every((e) => e.ok), results }, null, 2)}\n`,
    );
  }
  if (entries.some((e) => e.error !== undefined)) {
    return 2;
  }
  return entries.every((e) => e.ok) ? 0 : 1;
}

const MIX_THRESHOLD_KEY_SET: ReadonlySet<string> = new Set(MIX_THRESHOLD_KEYS);

function runMixCheck(args: readonly string[]): number {
  const { positional, flags } = parseCommandArgs(
    args,
    new Set(['--mix', '--out', '--wav', '--png', '--thresholds']),
    new Set(),
  );
  const manifestPath = positional[0];
  const mixFlag = stringFlag(flags, '--mix');
  if (positional.length > 1 || (manifestPath === undefined) === (mixFlag === undefined)) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const spec: MixSpec =
    manifestPath !== undefined
      ? parseMixManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown, path.dirname(manifestPath))
      : parseMixFlag(mixFlag ?? '');
  const stems = spec.stems.map((s) => ({ ...s, audio: readWavFile(s.file) }));
  const composite = mixStems(stems, spec.durationS);
  const report = checkMix(stems, composite, parseThresholds(stringFlag(flags, '--thresholds'), MIX_THRESHOLD_KEY_SET));

  const wavOut = stringFlag(flags, '--wav');
  if (wavOut !== undefined) {
    writeWav(wavOut, composite);
  }
  const pngDir = stringFlag(flags, '--png');
  const label = manifestPath !== undefined ? path.parse(manifestPath).name.replace(/\.mix$/, '') : 'mix';
  const full = pngDir !== undefined ? { ...report, pngs: writeInspectionPngs(composite, pngDir, label, false) } : report;
  const outJson = stringFlag(flags, '--out');
  if (outJson !== undefined) {
    writeJson(outJson, full);
  }
  process.stdout.write(`${JSON.stringify(full, null, 2)}\n`);
  return report.ok ? 0 : 1;
}

export function main(argv: readonly string[]): number {
  if (argv[0] === 'help' || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const cmd = argv[0];
  try {
    if (cmd === 'render') {
      return runRender(argv.slice(1));
    }
    if (cmd === 'check' || cmd === 'gate') {
      return runCheck(argv.slice(1));
    }
    if (cmd === 'batch') {
      return runBatch(argv.slice(1));
    }
    if (cmd === 'mix-check') {
      return runMixCheck(argv.slice(1));
    }
    if (cmd === 'mcp') {
      serveStdio();
      return 0;
    }
    if (cmd === 'skill') {
      if (argv[1] !== 'install' || argv.slice(2).some((arg) => arg !== '--project')) throw new Error('Usage: agent-audio skill install [--project]');
      const root = argv.includes('--project') ? process.cwd() : os.homedir();
      const pkg = path.dirname(createRequire(import.meta.url).resolve('agent-audio/package.json'));
      for (const agent of ['.agents', '.claude']) {
        const dir = path.join(root, agent, 'skills', 'agent-audio');
        fs.mkdirSync(dir, { recursive: true });
        const target = path.join(dir, 'SKILL.md');
        fs.copyFileSync(path.join(pkg, 'skills', 'agent-audio', 'SKILL.md'), target);
        process.stdout.write(target + '\n');
      }
      return 0;
    }
    if (cmd !== undefined) return scoreCommand(cmd, argv.slice(1));
    process.stderr.write(`${usage()}\n`);
    return 2;
  } catch (err) {
    process.stderr.write(`${JSON.stringify({ ok: false, ...errorInfo(err) })}\n`);
    return 2;
  }
}

const isEntry =
  process.argv[1] !== undefined &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isEntry) {
  process.exitCode = main(process.argv.slice(2));
}
