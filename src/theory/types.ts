import type { Instrument } from './instruments.js'

export interface Event {
  readonly ticks: number
  /** Empty for a rest. Multiple pitches sound together for the whole event. */
  readonly pitches: readonly string[]
  readonly dynamic?: string
  readonly articulations?: readonly string[]
}
export interface Track {
  readonly id: string
  readonly voice: string
  readonly instrument: Instrument
  readonly pitchBasis?: 'written' | 'sounding'
  readonly doublingGroup?: string
  readonly dynamic?: string
  readonly bars: readonly (readonly Event[])[]
}
export interface Score {
  readonly style: 'strict' | 'free'
  readonly ticksPerBeat: number
  readonly beatsPerBar: readonly number[]
  /** Fixed registral order, highest voice first. */
  readonly tracks: readonly Track[]
  /** Major or raised minor leading tone, a semitone below this spelled tonic. */
  readonly tonic?: string
  readonly harmony?: readonly { bar: number; beat: number; chord: string }[]
}
export interface Location {
  bar: number
  beat: number
  voice: string
  trackId: string
}
export type Code =
  | 'BAR_DURATION'
  | 'RANGE_HARD'
  | 'RANGE_EXTREME'
  | 'POLYPHONY'
  | 'PARALLEL_FIFTH'
  | 'PARALLEL_OCTAVE'
  | 'VOICE_CROSSING'
  | 'SPACING'
  | 'LOW_INTERVAL'
  | 'DOUBLED_LEADING_TONE'
  | 'UNRESOLVED_SEVENTH'
  | 'HARMONY_MISMATCH'
  | 'DYNAMICS_MISSING'
  | 'ARTICULATION_UNSUPPORTED'
export interface Diagnostic {
  code: Code
  severity: 'error' | 'warning'
  message: string
  where: Location
}
