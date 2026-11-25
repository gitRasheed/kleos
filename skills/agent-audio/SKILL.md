---
name: agent-audio
description: Compose and render sound effects, UI sounds, loops and music cues with agent-audio. Check WAVs for measured defects, lint scores, inspect masking and prepare an offline stem audition.
---

# Agent audio

Use a recipe for oscillator-based sounds and a score for instrument parts, automation and mixing. For an existing WAV, start with `check`. Run `agent-audio --help` for commands, flags, threshold keys and finding codes.

## Make a sound

Save this as `ping.recipe.json`. The attack and release ease the edges of the note.

```json
{
  "schemaVersion": "agent-audio/recipe/v1", "kind": "one-shot", "id": "ping",
  "durationS": 0.11, "masterGainDb": -6,
  "voices": [{
    "id": "ping", "waveform": "sine", "gainDb": -2, "freqStartHz": 1320, "freqEndHz": 1760,
    "envelope": { "attackS": 0.003, "decayS": 0.04, "sustainLevel": 0.3, "releaseS": 0.02 }
  }]
}
```

```sh
agent-audio render ping.recipe.json --out ping.wav
agent-audio check ping.wav --profile ui --summary
```

A loop recipe uses `kind: "loop"`, `bpm`, `beats` and tracks with a voice and beat-positioned notes. Choose a whole number of frames for the loop length. Use `bandLimited: true` on bright saws and squares when aliasing is audible.

## Write and mix music

Import a tune with `agent-audio import-abc theme.abc --out cue.json`, or start a score with `agent-audio init cue.json --id cue`. A score track has an ID, an instrument and clips. Notes use clip-relative `startBeat`, `durationBeats`, MIDI pitch in `midi` and velocity from 1 to 127. Reuse phrases through named patterns. For sampled instruments, set `instrument` to `{"type":"sf2","params":{"bank":"piano.sf2","program":0}}` with a bank path relative to the score.

```sh
agent-audio validate cue.json
agent-audio lint cue.json --style free
agent-audio render cue.json --out cue.wav --stems-dir stems
agent-audio check cue.wav --project cue.json --summary
agent-audio masking cue.json
agent-audio audition cue.json --out audition
```

Use strict lint for four-part writing. Theory findings use one-based bars. Masking findings use zero-based bars and give the time, band and competing tracks. For a buried lead, change the register or level of the named masker, then render again.

Track and bus inserts run in order. Add an `eq` with a `bands` array for a targeted cut. Route tracks to a group with `to`. For a shared delay or reverb, send to a bus with a wet-only insert. Compare `maxGrDb` and `meanGrDb` to distinguish a compressor catching a transient from one working through the phrase.

## Check the delivery

Check the written WAV so the gate measures the delivered samples. A bare WAV uses the raw profile. Pass `--loop` for a standalone loop, or `--project cue.json` to supply the loop setting, tempo and loudness target. Read `PROFILE` and `LOOP_CHECKED` in the summary. For a loop score, `render --repeats 2` also writes a twice-through WAV for listening across the wrap.

Check a composite with `agent-audio mix-check mix.json`. Paths in the manifest resolve beside the manifest. Set gains and offsets to the values used in playback.

```json
{
  "schemaVersion": "agent-audio/mix/v1", "durationS": 4,
  "stems": [
    { "file": "cue.wav", "gainDb": -6, "loop": true },
    { "file": "ping.wav", "gainDb": -3, "offsetS": 0.5 },
    { "file": "ping.wav", "gainDb": -4, "offsetS": 1.25 }
  ]
}
```

Exit 1 indicates a failed verdict. Exit 2 indicates an input or execution error. Read the JSON finding and its location to decide what to change. A flat-top finding can survive normalization even when true peak is below the ceiling.

Open `audition/index.html` locally to solo stems or jump to a finding. Copied gains are trims relative to the rendered stems. Use `export-musicxml` for notation or `export-midi` for performance edits. Bring edited MIDI clips back with `agent-audio import-midi cue.mid --into cue.json` to retain the mix on matching tracks.
