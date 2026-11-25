import { BasicSoundBank, BasicPreset, BasicInstrument, EmptySample } from 'spessasynth_core'

export function tinyBank() {
  const bank = new BasicSoundBank('sf2')
  const sample = new EmptySample()
  sample.name = 'Sine A4'
  sample.originalKey = 69
  sample.setAudioData(
    Float32Array.from({ length: 2205 }, (_, i) => 0.6 * Math.sin((2 * Math.PI * i * 440) / 22050)),
    22050
  )
  sample.loopStart = 0
  sample.loopEnd = 2205
  const instrument = new BasicInstrument()
  instrument.name = 'Looped sine'
  instrument.createZone(sample).setGenerator(54, 1)
  bank.samples.push(sample)
  bank.instruments.push(instrument)
  for (const program of [0, 47, 48, 56, 60, 68, 70, 71, 73]) {
    const preset = new BasicPreset(bank)
    preset.name = 'Sine ' + program
    preset.program = program
    preset.createZone(instrument)
    bank.presets.push(preset)
  }
  return new Uint8Array(bank.writeSF2())
}
