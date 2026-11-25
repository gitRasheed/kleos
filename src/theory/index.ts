import { Note } from 'tonal'
import { timeline } from './timeline.js'
import type { Harmony, Pitch, Sound } from './timeline.js'
import type { Code, Diagnostic, Score } from './types.js'

export { INSTRUMENT_DEFS } from './instruments.js'
export type { Instrument, InstrumentDef } from './instruments.js'
export type * from './types.js'

type Emit = (code: Code, track: number, message: string, key?: string) => void
const single = (sound: Sound | undefined) => (sound?.pitches.length === 1 ? sound.pitches[0] : undefined)

function perfect(a: Pitch, b: Pitch) {
  const semitones = Math.abs(a.midi - b.midi) % 12
  const steps = Math.abs(a.degree - b.degree) % 7
  if (steps === 4 && semitones === 7) return 'PARALLEL_FIFTH'
  if (steps === 0 && semitones === 0) return 'PARALLEL_OCTAVE'
}

function octaveOffset(a?: Sound, b?: Sound) {
  if (!a || !b || a.start !== b.start || a.end !== b.end) return
  const p = single(a),
    q = single(b)
  if (p && q && p.pc === q.pc) return p.midi - q.midi
}

function representatives(score: Score, sounds: (Sound | undefined)[], before?: (Sound | undefined)[]) {
  const reps: number[] = []
  return score.tracks.map((track, i) => {
    if (score.style === 'free' && track.doublingGroup) {
      for (const j of reps) {
        if (track.doublingGroup !== score.tracks[j].doublingGroup) continue
        const offset = octaveOffset(sounds[i], sounds[j])
        const previous = before && octaveOffset(before[i], before[j])
        if (offset !== undefined && (!before || previous === offset)) return j
        if (previous !== undefined && !sounds[i] && !sounds[j]) return j
      }
    }
    reps.push(i)
    return i
  })
}

function vertical(
  score: Score,
  sounds: (Sound | undefined)[],
  harmony: Harmony | undefined,
  leading: string | undefined,
  emit: Emit,
) {
  const rep = representatives(score, sounds)
  const voices = rep.filter((index, i) => index === i)
  const bass = rep.at(-1)
  const notes: { pitch: Pitch; index: number }[] = []
  for (const [rank, i] of voices.entries()) {
    const sound = sounds[i]
    if (!sound) continue
    const name = score.tracks[i].voice
    for (const pitch of sound.pitches) {
      if (harmony && !harmony.members.has(pitch.pc)) {
        emit(
          'HARMONY_MISMATCH',
          i,
          `${pitch.name} is outside ${harmony.symbol}.`,
          pitch.name + harmony.symbol,
        )
      }
      for (const { pitch: other, index: j } of notes) {
        const gap = Math.abs(other.midi - pitch.midi)
        const key = `${j}/${other.name}/${pitch.name}`
        if (gap > 0 && gap <= 4 && Math.min(other.midi, pitch.midi) < 48) {
          emit('LOW_INTERVAL', i, `${other.name} and ${pitch.name} form a close interval below C3.`, key)
        }
        if (pitch.pc === leading && other.pc === leading) {
          emit(
            'DOUBLED_LEADING_TONE',
            i,
            `Leading tone ${leading} is doubled with ${score.tracks[j].voice}.`,
            key,
          )
        }
      }
      notes.push({ pitch, index: i })
    }
    const lower = single(sound)
    if (!lower) continue
    for (let upperRank = 0; upperRank < rank; upperRank++) {
      const j = voices[upperRank]
      const upper = single(sounds[j])
      if (!upper) continue
      const gap = upper.midi - lower.midi
      const key = `${j}/${upper.name}/${lower.name}`
      if (gap < 0) emit('VOICE_CROSSING', i, `${name} is above ${score.tracks[j].voice}.`, key)
      if (upperRank === rank - 1 && i !== bass && gap > 12) {
        emit('SPACING', i, `${name} is more than an octave below ${score.tracks[j].voice}.`, key)
      }
    }
  }
}

function motion(
  score: Score,
  before: (Sound | undefined)[],
  now: (Sound | undefined)[],
  reps: number[],
  emit: Emit,
) {
  const moved: { i: number; from: Pitch; to: Pitch; direction: number }[] = []
  for (let i = 0; i < reps.length; i++) {
    if (reps[i] !== i) continue
    const from = single(before[i]),
      to = single(now[i])
    if (!from || !to || from.midi === to.midi) continue
    const direction = Math.sign(to.midi - from.midi)
    for (const other of moved) {
      if (direction !== other.direction) continue
      const interval = perfect(other.to, to)
      if (interval && perfect(other.from, from) === interval) {
        const label = interval === 'PARALLEL_FIFTH' ? 'fifths' : 'octaves or unisons'
        emit(
          interval,
          i,
          `Parallel ${label} with ${score.tracks[other.i].voice} (${other.from.name}/${from.name} to ${other.to.name}/${to.name}).`,
          String(other.i),
        )
      }
    }
    moved.push({ i, from, to, direction })
  }
}

export function lintScore(score: Score): Diagnostic[] {
  const result: Diagnostic[] = []
  const { starts, frames } = timeline(score, result)
  if (score.tonic !== undefined && (!Note.get(score.tonic).pc || Note.get(score.tonic).oct !== undefined)) {
    throw new RangeError('tonic must be a spelled pitch class')
  }
  const leading = score.tonic && Note.transpose(score.tonic, '-2m')
  const sounds: (Sound | undefined)[] = Array(score.tracks.length).fill(undefined)
  const pending: (Pitch | undefined)[] = Array(score.tracks.length).fill(undefined)
  let bar = 0
  let harmony: Harmony | undefined
  let previous = new Set<string>()
  for (const [tick, frame] of frames) {
    bar = frame.bar ?? bar
    harmony = frame.harmony ?? harmony
    const before = sounds.slice()
    for (const [index, sound] of frame.changes) sounds[index] = sound
    const seen = new Set<string>()
    const emit: Emit = (code, i, message) => {
      const { voice, id: trackId } = score.tracks[i]
      const severity =
        score.style === 'free' || code === 'HARMONY_MISMATCH' || code === 'LOW_INTERVAL' ? 'warning' : 'error'
      result.push({
        code,
        severity,
        message,
        where: { bar: bar + 1, beat: 1 + (tick - starts[bar]) / score.ticksPerBeat, voice, trackId },
      })
    }
    vertical(score, sounds, harmony, leading, (code, i, message, key) => {
      const id = `${code}/${i}/${key}`
      if (!previous.has(id) && !seen.has(id)) emit(code, i, message)
      seen.add(id)
    })
    const reps = representatives(score, sounds, before)
    motion(score, before, sounds, reps, emit)
    const unresolved = new Set<number>()
    for (const [i, held] of pending.entries()) {
      const note = single(sounds[i])
      if (held && note?.name === held.name) continue
      if (held && !(note && held.degree - note.degree === 1 && [1, 2].includes(held.midi - note.midi))) {
        if (!unresolved.has(reps[i]))
          emit('UNRESOLVED_SEVENTH', i, `The chordal seventh ${held.name} should resolve down by step.`)
        unresolved.add(reps[i])
      }
      pending[i] = note && note.pc === harmony?.seventh ? note : undefined
    }
    previous = seen
  }
  return result.sort((a, b) => a.where.bar - b.where.bar || a.where.beat - b.where.beat)
}
