# agent-audio

Render sound effects and multitrack scores to WAV, then check the written audio for clipping, clicks, loudness and loop seams. The score linter locates notation and voice-leading problems. An offline stem player lets a listener solo parts and jump to mix findings.

## Install

Build with Node 20.12 or later. From the checkout:

```sh
npm ci
npm run build
npm pack
npm install -g ./agent-audio-0.2.0.tgz
agent-audio --help
```

`agent-daw` is an alias for the CLI. Run `agent-audio skill install` for your account or `agent-audio skill install --project` in a project directory. Both copy the same file to `.agents/skills/agent-audio/SKILL.md` and `.claude/skills/agent-audio/SKILL.md` under the selected root. [Authoring skill](skills/agent-audio/SKILL.md)

## Render and check a sound

```sh
agent-audio render recipes/cannon-shot.recipe.json --out out/shot.wav
agent-audio check out/shot.wav --summary
```

The bundled cannon shot lasts 0.240 s. Its raw summary reports a momentary maximum of −22.4 LUFS and a true peak of −5.9 dBTP. `PROFILE` shows which limits applied and `LOOP_CHECKED` tells you whether the gate inspected the wrap. Omit `--summary` for the JSON report with thresholds and findings. `--png out/inspect` writes inspection plots.

Recipes support sine, triangle, square, saw, noise and FM voices. One-shot voices can sweep in pitch. Loop tracks can repeat notes and send to a delay. Set `bandLimited` on a saw or square to use PolyBLEP. The bundled recipes are editable starting points. [Recipes](recipes/)

| Command | What it measures |
| --- | --- |
| `check file.wav` | Uses the raw profile by default. Add `--loop` to inspect a standalone loop, or `--project cue.json` for the score’s tempo, loop flag, loudness target and default profile. |
| `check file.wav --profile music` | Applies music thresholds, including −18 to −14 integrated LUFS by default. Other profiles are `ui`, `sfx` and `ambience`. |
| `batch recipes --out out/batch --summary` | Renders and checks recipes and checks existing WAVs in the input directory. Recipe kind supplies the loop flag. |
| `mix-check --mix out/shot.wav:-3,out/shot.wav:-6@0.1` | Checks summed headroom at the stated gains and offsets. All inputs must share a sample rate. |

The loudness report includes BS.1770 integrated LUFS, momentary and short-term maxima, 4× true peak, EBU Tech 3342 loudness range (`lraLu`), peak-to-loudness ratio (`plrDb`) and sample peak relative to pooled RMS (`crestFactorDb`). Unavailable measurements are `null`. `FLAT_TOP_CLIPPING` detects repeated flat peaks even when subsequent gain reduction places them below full scale.

Exit 0 means the command succeeded. Exit 1 reports a failed verdict, including an invalid score passed to `validate`. Exit 2 reports an input or execution error. `check --strict` promotes advisory findings to failures.

## Write a score

An `agent-daw/v1` project contains tempo, key, tracks and a master configuration. Each track has an instrument, clips of notes, optional automation and ordered inserts. Scores render at 48 kHz. Thirteen modeled instruments cover piano, brass, strings, guitars, percussion, synths and cinematic effects. The `sf2` instrument reads an uncompressed PCM SoundFont. For example, `{"type":"sf2","params":{"bank":"piano.sf2","program":0}}` selects program 0 in melodic bank 0. Bank paths resolve relative to the project.

Start from a bundled score, create an empty one with `init`, or import a tune:

```sh
agent-audio import-abc theme.abc --out cue.json
agent-audio validate cue.json
agent-audio lint cue.json --style free
agent-audio render cue.json --out out/cue.wav --stems-dir out/stems
agent-audio check out/cue.wav --project cue.json --summary
```

`validate` reports structural errors by JSON path. `lint` checks notation, register and voice leading, with one-based bar and beat locations. Use `strict` for four-part writing or `free` for orchestral textures. `critique` scores motif recall, harmonic flow, rhythm, register and dynamics. Its score becomes a gate when you pass `--min`.

## Mix tracks and buses

For a group, set the track’s `to` to a bus ID. For a parallel return, add a send. This excerpt routes a piano through a keys group and feeds a shared delay from the track’s pre-fader signal.

```json
{
  "format": "agent-daw/v1", "id": "echo-study", "bars": 1, "loop": true,
  "tracks": [{
    "id": "piano", "role": "lead", "instrument": "piano", "to": "keys",
    "sends": [{ "to": "echo", "levelDb": -12, "pre": true }],
    "clips": [{ "id": "theme", "notes": [{ "midi": 69, "startBeat": 1, "durationBeats": 1 }] }]
  }],
  "buses": [
    { "id": "keys", "fx": [{ "type": "eq", "bands": [{ "type": "hp12", "hz": 80 }] }] },
    { "id": "echo", "fx": [{ "type": "delay", "timeBeats": 0.75, "wetOnly": true }] }
  ]
}
```

- Each `eq` accepts up to eight bands in order. Use `hp12`, `hp24`, `lp12`, `lp24`, `lowshelf`, `highshelf`, `bell` or `notch`. Every band takes `hz`. Bells and shelves take `gainDb`. All except the fourth-order cuts accept `q`. Existing `eq3` inserts keep their three-band settings and response.
- Tracks and buses feed `master` by default. A pre-fader send taps after inserts. A post-fader send follows the strip gain. Mute closes both. Solo follows the selected strip’s inputs and outputs, including returns. Cycles and unknown destinations fail validation.
- A render reports per-track peak, LUFS and RMS, and each track or bus compressor’s maximum and mean reduction in dB. The master reports its compressor and limiter separately. Bus stems are post-fader, before final mastering. Nested stems contain their inputs. Layer stems share the master’s gain curve. Shared nonlinear bus effects can give isolated layers a different sum from the full mix.
- `render --tracks id1,id2` selects tracks even when those tracks are muted. `--repeats 2` writes a second, twice-through WAV for loop scores. The render report’s `files` lists the outputs of that run.

## Inspect a mix

```sh
agent-audio masking cue.json
agent-audio audition cue.json --out out/audition
```

`masking` checks 24 Bark bands in 50 ms windows. A `MASKED` finding identifies the lead, contributing maskers, frequency band, time in seconds and zero-based project bar. The threshold is a lead-to-masker power ratio of −10 dB or lower in a band carrying at least 10% of the lead’s power. Routed tracks are measured through their buses in isolation. The full master supplies the spectral balance and mono checks. `LOW_MID_BUILDUP`, `HARSH_BAND`, `SUB_RUMBLE` and `MONO_LOSS` are listening cues. The masking command reports them without failing the WAV gate.

Open `out/audition/index.html` directly in a browser. The page embeds the WAVs and schedules their playback together. It plays the inputs to the master before final mastering. Routed projects expose the groups, returns or tracks feeding that bus. Click a finding to seek, or use mute, solo and gain to compare stems. “Copy Mix JSON” exports trims relative to the embedded stems.

## Exchange and edit

- `export-midi cue.json --out cue.mid` writes Type 1 MIDI at 480 PPQ. `import-midi cue.mid --out imported.json` builds a project. Use `--into cue.json` to replace clips on matching track IDs or names while preserving their instruments, processing and mix settings. Unnamed tracks match by position.
- `export-abc cue.json --out theme.abc` and `export-musicxml cue.json --out cue.musicxml` write one part per track. ABC imports retain their source notation. A project uses one tempo, meter and key.
- `edit` can trim, fade, normalize, pitch-shift, stretch, layer or export audio. FFmpeg is required for compressed export. SoX and Rubber Band are optional backends.
- Import the renderer, `checkAudio`, `analyzeMix` or the interchange functions from `agent-audio`. Score-writing helpers live in `agent-audio/compose`. `agent-audio mcp` exposes project operations, WAV analysis and editing over stdio. Run `tools/list` through the MCP client for the installed tool schemas.

## Develop

Run `npm run check` for TypeScript, ESLint and the test suites. The MusicXML schema tests use `xmllint`. The audition test uses Chrome or Chromium through the `CHROME` executable setting. The loudness suite compares with FFmpeg when available. [Working rules](AGENTS.md) · [State machines](STATE_MACHINES.md)

## License

MIT
