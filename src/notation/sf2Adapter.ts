import { BasicMIDI, BasicSoundBank, SoundBankLoader, SpessaSynthProcessor, SpessaSynthSequencer } from 'spessasynth_core'

export async function renderSf2(midi: Uint8Array, sf2: Uint8Array, sampleRate = 48000, tailSeconds = 0.25) {
  await BasicSoundBank.ready
  return synthesize(midi, sf2, sampleRate, tailSeconds)
}

export function renderPcmSf2(midi: Uint8Array, sf2: Uint8Array, sampleRate: number, tailSeconds: number, program: number) {
  return synthesize(midi, sf2, sampleRate, tailSeconds, program)
}

function synthesize(midi: Uint8Array, sf2: Uint8Array, sampleRate: number, tailSeconds: number, program?: number) {
  if (
    !Number.isSafeInteger(sampleRate) ||
    sampleRate < 8000 ||
    !(tailSeconds >= 0 && Number.isFinite(tailSeconds))
  ) {
    throw new RangeError('Invalid offline render length or sample rate')
  }
  const song = BasicMIDI.fromArrayBuffer(Uint8Array.from(midi).buffer)
  const synth = new SpessaSynthProcessor(sampleRate)
  const bank = SoundBankLoader.fromArrayBuffer(Uint8Array.from(sf2).buffer)
  if (program !== undefined) {
    if (bank.type !== 'sf2' || bank.samples.some(s => s.isCompressed)) throw new Error('Expected an uncompressed PCM SF2 bank')
    if (!bank.presets.some(p => p.program === program && p.bankMSB === 0 && p.bankLSB === 0 && !p.isGMGSDrum))
      throw new Error('SF2 bank has no melodic program ' + program + ' in bank 0')
  }
  synth.soundBankManager.addSoundBank(bank, 'offline')
  const seq = new SpessaSynthSequencer(synth)
  seq.skipToFirstNoteOn = false
  seq.loadNewSongList([song])
  seq.loopCount = 0
  seq.play()
  const frames = Math.ceil((song.duration + tailSeconds) * sampleRate)
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame += 128) {
    seq.processTick()
    synth.process(left, right, frame, Math.min(128, frames - frame))
  }
  return { sampleRate, left, right }
}
