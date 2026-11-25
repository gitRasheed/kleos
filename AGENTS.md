# Working on agent-audio

## Module boundaries

- `src/recipe/` owns oscillator recipes, synthesis and recipe effects. `src/score/` owns projects, native instruments, track processing, bus routing, mastering and WAV edits. Preserve the arithmetic and summation order of existing render paths.
- `src/io/` owns WAV encoding and decoding, plots, inspection PNGs and the offline audition page. `src/ears/` measures audio, chooses findings and formats gate summaries. Renderers can use loudness meters without depending on gate verdicts.
- `src/theory/` checks notes, ranges and voice leading. The score adapter expands project clips into theory events. `src/notation/` bridges conductor data, ABC, MusicXML, MIDI and sampled playback.
- `src/tools.ts` defines the shared score and audio tools with their MCP input schemas. `src/mcp.ts` handles newline-delimited JSON-RPC. `src/score/commands.ts` maps score CLI commands to tools. `src/cli.ts` also owns recipe rendering, batch checks, mix manifests and skill installation.

## Invariants

Parse a project before rendering or saving edits. Keep unknown-key errors at the offending path. Patterns are keyed by user IDs. Instrument and effect parameters depend on the selected type. Optional additions must preserve published projects’ WAV bytes.

Preserve the seeded draw order for recipes and score notes. Compare decoded data for interchange tests and encoded WAV bytes for render compatibility. Compressed audio bytes also depend on the encoder build.

Use `planRouting` for both project validation and rendering. A strip can feed several buses. Every destination must exist, every strip ID must be unique within the graph, and the master is a sink. Changes to solo, mute or fader position need a pre-send and post-send check.

Check the delivered WAV after quantization. The shared WAV finding codes are in `src/types.ts`. Mix routing and masking have separate located findings. Base WAV thresholds live in `src/ears/check.ts` and profile overrides in `src/ears/profiles.ts`.

## Verify changes

- Run `npm run check`. The suite exercises the compiler, lint rules, note interchange, DSP, MCP and the offline audition page. Install `xmllint` and point `CHROME` at Chrome or Chromium if needed.
- For renderer changes, compare existing WAV pins. For a detector, include a signal that triggers it and a clean control that resembles the defect.
- For loop effects, test across the wrap. Long feedback tails can outlast the warm-up period.
- For packaging or CLI changes, install `npm pack` output in an empty directory and exercise the installed binary. Verify both skill destinations against the packaged file.
- Keep the skill in one file. Put the full flag and threshold lists in CLI help. Run the examples you change.
