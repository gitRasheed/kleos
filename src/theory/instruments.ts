import * as Interval from '@tonaljs/interval'

export interface InstrumentDef {
  /** Inclusive sounding MIDI pitches, C4 = 60. */
  readonly soundingRange: readonly [number, number]
  readonly comfortableRange: readonly [number, number]
  /** Interval from a written pitch to the sounding pitch. */
  readonly transposition: string
  readonly transpositionSemitones: number
  readonly clef: 'treble' | 'alto' | 'bass' | 'grand'
  /** Zero-based General MIDI program. */
  readonly gmProgram: number
  readonly monophonic: boolean
  readonly articulations: readonly string[]
}

const common = ['legato', 'tenuto', 'staccato', 'accent', 'marcato']
const strings = [...common, 'arco', 'pizzicato', 'spiccato', 'tremolo', 'harmonic']
const brass = [...common, 'muted']

function instrument(
  soundingRange: InstrumentDef['soundingRange'],
  comfortableRange: InstrumentDef['comfortableRange'],
  transposition: string,
  clef: InstrumentDef['clef'],
  gmProgram: number,
  monophonic: boolean,
  articulations: readonly string[],
): InstrumentDef {
  return {
    soundingRange,
    comfortableRange,
    transposition,
    transpositionSemitones: Interval.semitones(transposition),
    clef,
    gmProgram,
    monophonic,
    articulations,
  }
}

const violin = instrument([55, 103], [55, 88], '1P', 'treble', 40, false, strings)
const orchestra = {
  'violin-I': violin,
  'violin-II': violin,
  viola: instrument([48, 91], [48, 79], '1P', 'alto', 41, false, strings),
  cello: instrument([36, 88], [36, 72], '1P', 'bass', 42, false, strings),
  contrabass: instrument([28, 67], [28, 55], '-8P', 'bass', 43, false, strings),
  flute: instrument([60, 98], [62, 91], '1P', 'treble', 73, true, common),
  oboe: instrument([58, 93], [62, 86], '1P', 'treble', 68, true, common),
  'clarinet-Bb': instrument([50, 94], [52, 86], '-2M', 'treble', 71, true, common),
  bassoon: instrument([34, 77], [38, 70], '1P', 'bass', 70, true, common),
  'horn-F': instrument([35, 77], [41, 72], '-5P', 'treble', 60, true, [...brass, 'stopped']),
  'horn-Eb': instrument([33, 75], [39, 70], '-6M', 'treble', 60, true, [...brass, 'stopped']),
  'trumpet-C': instrument([54, 86], [60, 79], '1P', 'treble', 56, true, brass),
  trombone: instrument([40, 82], [43, 72], '1P', 'bass', 57, true, [...brass, 'glissando']),
  tuba: instrument([26, 65], [29, 58], '1P', 'bass', 58, true, brass),
  timpani: instrument([38, 57], [41, 55], '1P', 'bass', 47, false, ['accent', 'tenuto', 'staccato', 'roll']),
  piano: instrument([21, 108], [21, 108], '1P', 'grand', 0, false, [...common, 'tremolo']),
} as const

const keyboard = (gmProgram: number) => instrument([0, 127], [0, 127], '1P', 'grand', gmProgram, false, common)
const guitar = (gmProgram: number) => instrument([40, 88], [40, 82], '-8P', 'treble', gmProgram, false, common)

export const INSTRUMENT_DEFS = {
  ...orchestra,
  sf2: { ...keyboard(0), defaultRole: 'harmony', defaultPan: 0 },
  piano: { ...orchestra.piano, defaultRole: 'harmony', defaultPan: 0 },
  'brass-horn': { ...orchestra['horn-F'], defaultRole: 'lead', defaultPan: -0.15 },
  'brass-trumpet': { ...orchestra['trumpet-C'], defaultRole: 'lead', defaultPan: 0.2 },
  'strings-ensemble': { ...instrument([28, 103], [36, 88], '1P', 'grand', 48, false, strings), defaultRole: 'harmony', defaultPan: -0.45 },
  'strings-cello': { ...orchestra.cello, defaultRole: 'counter', defaultPan: 0.4 },
  'strings-bass': { ...orchestra.contrabass, defaultRole: 'bass', defaultPan: 0.12 },
  'guitar-electric': { ...guitar(30), defaultRole: 'counter', defaultPan: 0 },
  'guitar-acoustic': { ...guitar(25), defaultRole: 'harmony', defaultPan: -0.25 },
  timpani: { ...orchestra.timpani, defaultRole: 'percussion', defaultPan: 0.2 },
  'orchestral-perc': { ...keyboard(0), defaultRole: 'percussion', defaultPan: 0 },
  'synth-pad': { ...keyboard(89), defaultRole: 'pad', defaultPan: 0 },
  'synth-bass': { ...keyboard(38), defaultRole: 'bass', defaultPan: 0 },
  'cinematic-sfx': { ...keyboard(98), defaultRole: 'fx', defaultPan: 0 },
} as const

export type Instrument = keyof typeof INSTRUMENT_DEFS
