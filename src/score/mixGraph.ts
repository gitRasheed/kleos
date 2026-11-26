import { dbToGain, gainToDb, stereo, tile, SAMPLE_RATE, type Stereo } from './dsp.js';
import { applyFx, compressWithMeter, type FxContext } from './fx.js';
import { crop, limit } from './master.js';
import type { FxConfig } from './project.js';

export interface Send { readonly to: string; readonly levelDb: number; readonly pre: boolean }
type Insert = FxConfig | { type: 'limiter'; thresholdDb: number };
interface Strip {
  readonly id: string;
  readonly to?: string;
  readonly gainDb?: number;
  readonly mute?: boolean;
  readonly solo?: boolean;
  readonly sends?: readonly Send[];
  readonly fx?: readonly Insert[];
}
export interface MixTrack extends Strip { readonly audio: Stereo }
export type MixBus = Strip;
export interface GraphFinding {
  code: 'LIMITER_OVERWORKED' | 'BUS_OVER' | 'DYNAMICS_FLAT';
  id: string;
  timeS: number;
  valueDb: number;
}
export interface Reduction { id: string; insert: number; maxGrDb: number; meanGrDb: number }

function add(dest: Stereo, src: Stereo, gain: number) {
  for (let i = 0; i < src.left.length; i++) {
    dest.left[i] += src.left[i] * gain;
    dest.right[i] += src.right[i] * gain;
  }
}

function get<T>(map: ReadonlyMap<string, T>, id: string): T {
  const value = map.get(id);
  if (value === undefined) throw new Error('Missing strip ' + id);
  return value;
}

function connected(ids: string[], neighbors: ReadonlyMap<string, string[]>) {
  const visited = new Set<string>(ids);
  for (const id of visited) for (const next of neighbors.get(id) ?? []) visited.add(next);
  return visited;
}

function busFindings(buf: Stereo, id: string, sr: number, findings: GraphFinding[]) {
  let peak = 0, frame = 0, squares = 0;
  for (let i = 0; i < buf.left.length; i++) {
    const magnitude = Math.max(Math.abs(buf.left[i]), Math.abs(buf.right[i]));
    if (magnitude > peak) { peak = magnitude; frame = i; }
    squares += buf.left[i] ** 2 + buf.right[i] ** 2;
  }
  if (peak > 1) findings.push({ code: 'BUS_OVER', id, timeS: frame / sr, valueDb: gainToDb(peak) });
  if (peak === 0 || buf.left.length < 0.4 * sr) return;
  const crest = gainToDb(peak / Math.sqrt(squares / (2 * buf.left.length)));
  if (crest < 3) findings.push({ code: 'DYNAMICS_FLAT', id, timeS: frame / sr, valueDb: crest });
}

function inserts(buf: Stereo, strip: Strip, ctx: FxContext, reductions: Reduction[], findings: GraphFinding[]) {
  for (const [insert, fx] of (strip.fx ?? []).entries()) {
    switch (fx.type) {
      case 'compressor':
        reductions.push({ id: strip.id, insert, ...compressWithMeter(buf, fx, ctx) });
        break;
      case 'limiter': {
        const limited = limit(buf, fx.thresholdDb, ctx.sampleRate);
        if (limited.deepestDb > 6) {
          let peak = 0, frame = 0;
          for (let i = 0; i < buf.left.length; i++) {
            const magnitude = Math.max(Math.abs(buf.left[i]), Math.abs(buf.right[i]));
            if (magnitude > peak) { peak = magnitude; frame = i; }
          }
          findings.push({ code: 'LIMITER_OVERWORKED', id: strip.id, timeS: (ctx.loopFrames ? frame % ctx.loopFrames : frame) / ctx.sampleRate, valueDb: limited.deepestDb });
        }
        buf = limited.out;
        break;
      }
      default:
        if (ctx.sampleRate !== SAMPLE_RATE) throw new RangeError('Legacy DAW inserts require 48 kHz');
        applyFx(buf, fx, ctx);
    }
  }
  return buf;
}

// Pre sends tap the post-insert signal. Mute closes every output, including pre sends.
export function planRouting(tracks: readonly Strip[], buses: readonly MixBus[]) {
  const allBuses = buses.some(b => b.id === 'master') ? buses : [...buses, { id: 'master' }];
  const busIds = new Set(allBuses.map(b => b.id));
  const strips = [...tracks, ...allBuses];
  const byId = new Map(strips.map(s => [s.id, s]));
  if (byId.size !== strips.length) throw new Error('Duplicate strip id');
  const forward = new Map<string, string[]>(), reverse = new Map<string, string[]>();
  const edges = new Map<string, Send[]>();
  for (const strip of strips) {
    const routes = [...strip.sends ?? []];
    if (strip.id !== 'master') routes.push({ to: strip.to ?? 'master', levelDb: 0, pre: false });
    else if (strip.to !== undefined || routes.length) throw new Error('Master must be a sink');
    if (!Number.isFinite(strip.gainDb ?? 0) && strip.gainDb !== -Infinity) throw new Error('Invalid gain on ' + strip.id);
    for (const route of routes) {
      if (!busIds.has(route.to)) throw new Error('Unknown bus: ' + route.to);
      if (!Number.isFinite(route.levelDb) && route.levelDb !== -Infinity) throw new Error('Invalid send on ' + strip.id);
      const inputs = reverse.get(route.to) ?? [];
      inputs.push(strip.id);
      reverse.set(route.to, inputs);
    }
    edges.set(strip.id, routes);
    forward.set(strip.id, routes.map(r => r.to));
  }
  const pending = new Map(strips.map(s => [s.id, reverse.get(s.id)?.length ?? 0]));
  const order = strips.filter(s => pending.get(s.id) === 0);
  for (const strip of order) for (const to of get(forward, strip.id)) {
    const count = get(pending, to) - 1;
    pending.set(to, count);
    if (!count) order.push(get(byId, to));
  }
  if (order.length !== strips.length) throw new Error('Cycle in group or send routing');

  const solos = strips.filter(s => s.solo).map(s => s.id);
  const ancestors = connected(solos, reverse), descendants = connected(solos, forward);
  return { order, allBuses, edges, solos, ancestors, descendants };
}

export function renderMixGraph(tracks: readonly MixTrack[], buses: readonly MixBus[], ctx: FxContext, frames = tracks[0]?.audio.left.length ?? 0, captureInputs = false) {
  if (!Number.isFinite(ctx.sampleRate) || ctx.sampleRate <= 0) throw new RangeError('Invalid sample rate');
  for (const t of tracks) if (t.audio.left.length !== frames || t.audio.right.length !== frames) throw new Error('Unaligned track: ' + t.id);
  const { order, allBuses, edges, solos, ancestors, descendants } = planRouting(tracks, buses);
  const masterInputs = new Map<string, Stereo>();
  const trackStems = new Map<string, Stereo>();
  const stems = new Map<string, Stereo>();
  const reductions: Reduction[] = [], findings: GraphFinding[] = [];
  const inputs = new Map(allBuses.map(bus => [bus.id, stereo(frames)]));
  const audio = new Map(tracks.map(t => [t.id, t.audio]));
  for (const strip of order) {
    const bus = inputs.get(strip.id);
    if (strip.mute || (solos.length && !ancestors.has(strip.id) && !descendants.has(strip.id))) {
      if (bus) stems.set(strip.id, stereo(frames));
      continue;
    }
    const track = audio.get(strip.id);
    const source = bus ?? get(audio, strip.id);
    const input = bus ?? { left: source.left.slice(), right: source.right.slice() };
    const warm = ctx.loopFrames === frames && Boolean(strip.fx?.length);
    const processed = inserts(warm ? tile(input, 2) : input, strip, ctx, reductions, findings);
    const buf = warm ? crop(processed, frames, frames) : processed;
    const routes = get(edges, strip.id).filter(r => !solos.length ||
      (ancestors.has(strip.id) && ancestors.has(r.to)) || (descendants.has(strip.id) && descendants.has(r.to)));
    function send(route: Send) {
      const gain = dbToGain(route.levelDb);
      add(get(inputs, route.to), buf, gain);
      if (captureInputs && route.to === 'master') {
        const stem = masterInputs.get(strip.id) ?? stereo(frames);
        add(stem, buf, gain);
        masterInputs.set(strip.id, stem);
      }
    }
    for (const route of routes) if (route.pre) send(route);
    const gain = dbToGain(strip.gainDb ?? 0);
    for (const ch of [buf.left, buf.right]) for (let i = 0; i < frames; i++) ch[i] *= gain;
    if (track) trackStems.set(strip.id, buf);
    if (bus) {
      stems.set(strip.id, buf);
      busFindings(buf, strip.id, ctx.sampleRate, findings);
    }
    for (const route of routes) if (!route.pre) send(route);
  }
  return { mix: get(stems, 'master'), stems, trackStems, masterInputs, reductions, findings };
}
