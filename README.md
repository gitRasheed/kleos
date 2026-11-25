# agent-audio

Render JSON recipes and orchestral scores to WAV. Check the result for BS.1770-4 loudness, true peak, clicks, cut tails, DC offset, stereo phase, loop seams, and advisory aliasing and quiet-tail warnings. It can gate a whole folder at once and check the headroom of several sounds mixed together. The score linter uses Tonal to check instrument ranges and voice leading before rendering.

## Status

Version 0.2.0. The package is not published to npm, so build it from source or install a packed tarball. Recipes written for 0.1.0 render byte for byte the same; every new recipe key is optional.

## Install

Requires Node 20 or later.

```bash
npm ci
npm run build
node dist/cli.js --help
```

To use it from another project:

```bash
npm pack
npm install -g ./agent-audio-0.2.0.tgz
agent-audio --help
```

## Use

```bash
agent-audio render recipes/cannon-shot.recipe.json --out out/cannon-shot.wav
agent-audio check out/cannon-shot.wav --png out/inspect

agent-audio render recipes/combat-loop.recipe.json --out out/combat-loop.wav
agent-audio check out/combat-loop.wav --loop

agent-audio render examples/fanfare-overture.daw.json --out out/fanfare.wav
agent-audio check out/fanfare.wav --profile music --project examples/fanfare-overture.daw.json
agent-audio critique examples/fanfare-overture.daw.json

agent-audio batch recipes --out out/batch --summary
agent-audio mix-check --mix out/combat-loop.wav:-6,out/cannon-shot.wav:-3@1.5
```

`check` prints a JSON report and exits `0` when the file passes, `1` when a gate fails and `2` on bad input. It reads mono or stereo WAV at 44.1 or 48 kHz in PCM16, PCM24 or float32. `batch` renders every recipe and checks every WAV in a folder, and `--summary` prints one row per file:

```text
FILE                     VERDICT  DUR_S   LUFS    DBTP   CENTROID_HZ  SEAM  FINDINGS
cannon-shot.recipe.json  PASS     0.240   M-22.4  -5.9   1109         -     -
combat-loop.recipe.json  PASS     25.600  I-17.4  -2.2   803          0.01  -
```

A failing report names each defect and where it is:

```json
{
  "code": "IMPULSE_CLICK",
  "severity": "fail",
  "channel": 0,
  "frame": 12000,
  "timeS": 0.25,
  "message": "Channel 0 impulse curvature ratio 491.918 at 0.25 s (limit 25)"
}
```

`--png <dir>` writes a waveform, a log-frequency spectrogram and, for loops, a seam view of the wrap point, each with labelled time and level or frequency axes.

The synth has sine, triangle, saw, square, noise and two-operator FM voices with ADSR envelopes, biquad filters with an optional filter envelope, tanh drive, PolyBLEP band-limited saw and square, pitch sweeps on one-shots and loop notes, pattern repeats, a feedback delay send per loop track, and a master DC blocker and true-peak limiter that keep loops seamless.

[SKILL.md](SKILL.md) is the full reference: the recipe schema, every finding code, every threshold key with its default, the batch and mix-check formats, and the authoring workflow. It doubles as an agent skill file.

Choose a check profile with `--profile raw|music|sfx|ui|ambience`. Without a project the default is `raw`. A score supplies its loop settings, tempo and loudness target. Music allows written opening rests and reports low spectral rolloff as a warning. Use `--thresholds '{"maxLeadingSilenceS":0.02}'` or `--require-rolloff` to enforce either limit. The symbolic critic prints advice and exits successfully unless you pass a minimum score with `--min`.

`agent-daw` is a second name for the CLI, and `gate` is an alias for `check`. Install the bundled skill with `agent-audio skill install` for your account or `agent-audio skill install --project` for the current directory. Both write `.agents/skills/agent-audio/SKILL.md` under the selected root.

## Library

```ts
import { checkAudio, checkMix, mixStems, readWavFile, renderRecipe, validateRecipe } from 'agent-audio';

const report = checkAudio(readWavFile('out/cannon-shot.wav'), 'cannon-shot.wav', { loop: false });

const stems = [
  { file: 'out/combat-loop.wav', gainDb: -6, offsetS: 0, loop: true },
  { file: 'out/cannon-shot.wav', gainDb: -3, offsetS: 1.5, loop: false },
].map((s) => ({ ...s, audio: readWavFile(s.file) }));
const mix = checkMix(stems, mixStems(stems));
```

Import the score-writing helpers from `agent-audio/compose`. For example, `line(0, 'D4:1 F4:1 A4:2')` returns the notes for a bar. `writeProject(score)` writes `<id>.daw.json` in the current directory. Pass a directory as its second argument to choose the destination.

## Project format (`agent-daw/v1`)

```json
{
  "format": "agent-daw/v1",
  "id": "overture", "kind": "loop", "loop": true,
  "tempo": { "bpm": 120, "beatsPerBar": 4 },
  "key": { "tonic": "D", "mode": "minor" },
  "bars": 16,
  "master": { "targetLufs": -16, "ceilingDbtp": -1.5, "hpfHz": 30, "compressor": { "thresholdDb": -16, "ratio": 2 } },
  "sections": [{ "id": "fanfare", "startBar": 0, "bars": 4, "layer": "base" }],
  "patterns": { "riff": { "lengthBeats": 4, "notes": [] } },
  "tracks": [{
    "id": "horns", "role": "lead", "layer": "base", "gainDb": -2, "pan": -0.15,
    "instrument": { "type": "brass-horn", "params": { "players": 4 } },
    "fx": [{ "type": "reverb", "preset": "hall", "mix": 0.3 }],
    "automation": [{ "param": "volume", "points": [{ "beat": 0, "value": 0 }, { "beat": 64, "value": 0 }] }],
    "clips": [{ "id": "a", "startBeat": 0, "notes": [
      { "midi": 62, "startBeat": 0, "durationBeats": 0.75, "velocity": 104, "articulation": "accent" }
    ] }]
  }]
}
```

- Notes take `midi` (or `pitch`), `startBeat` relative to the clip, `durationBeats`, `velocity` 1-127, `articulation` (`normal`, `legato`, `staccato`, `accent`, `sforzando`), and optional `pan` and `pitchBend` (semitones, a glide across the note; brass, strings and synths honour it, while piano, guitars, timpani, percussion and SFX ignore it).
- Clips either carry notes or point at a `pattern` with `repeat`, `transpose` and `velocityScale`.
- `role` (`lead`, `counter`, `harmony`, `bass`, `percussion`, `pad`, `fx`) tells the critic what each track does. Each instrument has a default.
- `layer` (`base`, `tension`, `combat`, `climax`) groups tracks into adaptive stems. Keep the hook in `base`.
- Validation reports errors by JSON path. It warns when a loop is not a whole number of frames (110 BPM x 16 bars is not; 120 BPM always is), when notes start after the end, and when automation does not return to its start value before the wrap.
- `notes/v1` scores (`{format, bpm, key, parts: [{id, instrument, notes: [{pitch, start, dur, vel, art}]}]}`) import with `import-notes`. This schema is defined here; it has not been checked against the research kit's `notes/v1`.

## Instruments

All synthesis is procedural TypeScript, seeded per note, so renders are bit-identical across runs.

| type | model |
| --- | --- |
| `piano` | Up to 32 stiff-string partials at `n·f0·√(1+Bn²)` with B rising toward the treble, 1-3 detuned strings per key, velocity-dependent hammer hardness and strike-position comb, two-stage decay, felt knock, damper release, pedal resonance, pitch-spread stereo |
| `brass-horn`, `brass-trumpet` | Ensemble of 3-4 detuned band-limited saws with an onset scoop, delayed vibrato and loose onsets; a dynamic low-pass and a wave-steepening term make forte notes brassier; breath noise; bell formant filters (horn dark, trumpet bright) |
| `strings-ensemble`, `strings-cello`, `strings-bass` | 3-6 detuned PolyBLEP saws per note with per-player vibrato, rosin onset noise, violin, cello or bass body resonances, articulation-shaped envelopes; seated violins left, cellos right, basses centre-right |
| `guitar-electric`, `guitar-acoustic` | Karplus-Strong with fractional-delay tuning (within 5 cents over three octaves), pick-position comb, damping filter, palm mute on staccato. Electric: double-tracked takes, then a biased tube stage and 4x12 cabinet on the summed track. Acoustic: wooden body resonances |
| `timpani` | Tuned kettle-drum modes with a strike pitch glide and mallet noise |
| `orchestral-perc` | GM-style map: 35/36 taiko, 41-50 toms, 38/40 snare, 39 hybrid trailer hit, 42/46 hats, 49/57 crash, 51 ride, 52/55 suspended-cymbal swell (swells over the note length) |
| `synth-pad`, `synth-bass` | 7-voice supersaw pad with slow filter drift; saw-plus-sub bass with a filter envelope |
| `cinematic-sfx` | `params.preset`: `doppler` fly-by, `bell-impact` FM hit, `glass`, `shield-shatter`, `chime`, `riser`, `sub-drop` |

Brass and strings take `brightness` (default 0, range -1 to 2). At 1 the section's low-pass opens by half and a 6 dB shelf lifts everything above 1.5 kHz. At 0 the output is sample-identical to a track without the param. The piano's `brightness` (default 0.5) is a separate control for hammer hardness.

Each piano partial starts at zero phase. Striking the same key at the same velocity at 50 positions in a score gives peaks within 0.5 dB.

## Effects and mastering

Track inserts: `eq3`, `chorus`, `delay` (tempo-synced, ping-pong), `reverb` (Freeverb with `hall`, `plate`, `room` presets, early reflections and a band-limited wet path), `overdrive`, `cab`, `compressor`. Automation lanes: `volume` (dB) and `cutoff` (Hz, swept in log frequency).

Loops are rendered so the wrap is inaudible:

- Note tails past the end fold back onto the start.
- Each track's effect chain runs over two loop periods and keeps the second, so reverb and delay tails wrap.
- Chorus rates snap to whole cycles per loop.
- The master bus (30 Hz DC-blocking high-pass, RMS bus compressor, constant gain to the LUFS target, lookahead limiter) runs on the loop padded with 2 s of wrapped audio at each end, then crops the exact loop frames back out. The limiter threshold steps down until the 4x-oversampled true peak sits under the ceiling.

`render --repeats N --out X.wav` (loops only) writes `X.wav` once through and `X_xN.wav`, the loop tiled N times. The summary prints both as `out` and `repeatedOut`, and lists every file in `files`.

`render --tracks a,b` (alias `--solo`) renders only those tracks, muted or not. An unknown id is an error that lists the valid ones. The master still normalises the result to the target LUFS.

The render summary gives each track `peak`, `lufs` (integrated, BS.1770) and `rmsDbfs`, measured where the track enters the master bus. `warnings` holds a `trackBalance` line for each track more than 16 LU below the loudest one. The warning is advisory and never changes the exit code.

`render --stems-dir` writes one WAV per layer. Each stem gets the master's high-pass and the bus compressor's per-frame gain curve (taken from the full mix), so the stems sum to the master before the limiter, to within 1e-9. The limiter is the only stage the sum lacks; it took 0 dB off the demo, whose stem sum gates identically to the master.

## Music theory lint

Run `agent-audio lint <score.json> [--style strict|free]` or call the MCP tool `lint` with a `score` path and optional `style`. Each finding includes its rule code, severity, track ID, voice, and one-based bar and beat. The CLI exits with 0 for a clean score or warnings alone, 1 for error findings, and 2 for bad input.

DAW projects tagged `agent-daw/v1` or `agent-audio/score/v1` use their expanded clips at MIDI export resolution (480 ticks per beat). Lint follows track order, highest voice first, and skips muted tracks, unpitched percussion and cinematic effects. Velocities supply dynamics. DAW pitches are concert MIDI numbers, spelled using the project key.

For written pitches, changing meters or explicit chord symbols, supply a theory score directly. Give each track an `id`, `voice`, `instrument` and `bars`. Each bar contains sequential events with integer `ticks` and an array of spelled `pitches` (empty for a rest). Set `ticksPerBeat` and give each measure's length in `beatsPerBar`. Optional fields include a spelled `tonic`, `harmony` entries with `bar`, `beat` and `chord`, and a track's `pitchBasis: "written"` for transposing instruments.

The CLI uses the score's style, defaulting to `free`. Strict style treats parallel fifths and octaves, voice crossing, spacing, doubled leading tones and unresolved sevenths as errors. Free style warns and recognizes explicit octave doublings tagged with the same `doublingGroup`. Bar duration, hard range and monophony violations are errors in both styles.

## Symbolic critic (`critique`, MCP `analyse` with `project`)

The critic rates the arrangement from 0 to 1 using five weights.

| subscore | weight | what it measures |
| --- | --- | --- |
| `motifRecall` | 0.25 | transposition-invariant 3-interval figures in the lead skyline that recur across sections; penalises both one-figure repetition and all-new material |
| `harmonicFlow` | 0.25 | per-bar chord detection: cadence into the loop wrap (or final cadence), chord diversity, change rate, chord-tone fit, key fit |
| `rhythmicVariety` | 0.15 | off-beat onsets, density contrast between sections, note-length variety in the lead |
| `registerSeparation` | 0.15 | lead/harmony/bass spacing, close intervals below E3, lead notes buried under the harmony, overall span |
| `dynamicContrast` | 0.20 | section energy range, where the peak falls, lead velocity shaping, articulation variety |

Each low subscore includes advice, for example "End the loop on a V (major, with the leading tone) or bVII so the wrap resolves to the tonic." Percussion and SFX tracks are excluded from melody and harmony. Use the advice when it fits the piece.

## Edit (`edit`)

`trim-silence`, `fade`, `normalize` (LUFS, category or peak; constant gain, limiter only if the ceiling would break, `--loop true` for the loop-safe path), `pitch` (semitones; Lanczos resample plus WSOLA, or `--backend rubberband|sox`), `stretch` (`--ratio` = output/input duration), `layer` (several `--in`, `--gains-db`, `--offsets-s`), `export` (WAV natively; `--backend ffmpeg|sox` for other formats; `--codec opus|ogg|mp3|flac [--bitrate 96k]` encodes through ffmpeg with `-map_metadata -1 -fflags +bitexact`, so the same input gives the same bytes; defaults are Opus 96k VBR, Vorbis 128k and MP3 192k, and FLAC rejects a bitrate). The binaries are optional and only run when asked for.

## MCP server

`node dist/cli.js mcp` speaks newline-delimited JSON-RPC 2.0 on stdio with 16 tools: `project_init`, `project_validate`, `project_dump`, `add_track`, `remove_track`, `add_clip`, `add_notes`, `set_instrument`, `add_fx`, `add_automation`, `render`, `edit`, `analyse`, `check`, `gate`, `export_midi`. Every edit re-validates the whole project before it is saved.

```json
{ "mcpServers": { "agent-daw": { "command": "node", "args": ["<repo>/dist/cli.js", "mcp"] } } }
```

## MIDI

`export-midi` writes SMF type 1 at 480 PPQ: a conductor track (tempo, meter, key signature, section markers), then one track per instrument with GM program, volume, pan, notes and pitch-wheel sweeps (bend range set to 12 semitones). Orchestral percussion goes on channel 10.

## Develop

```bash
npm run check
```

The loudness tests compare against `ffmpeg` when it is installed and skip that comparison when it is not. The files in `recipes/` are examples. Tests that pin rendering or exact gate behaviour use `tests/fixtures/` or inline recipes. A few tests still read `cannon-shot`, `lock-chirp` and `combat-loop` from `recipes/` and expect them to pass the gate, and one runs `batch` over the whole folder.

## License

MIT
