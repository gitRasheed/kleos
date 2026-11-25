# State machines in kleos

## Render and output files

A score render runs synchronously. It parses the project, expands clips, synthesizes each selected track, applies track processing, sums the mix and masters it. A routed project sums each bus after its inputs have run. Recipe rendering follows a separate path through voices, optional effects, the recipe master and WAV encoding.

| Transition | Result |
| --- | --- |
| Invalid project or route | Validation returns errors with paths. Project rendering stops before writing audio. |
| Selected tracks → stereo mix | Without routing, tracks sum in project order. With routing, strips run in topological order. A muted strip contributes neither its main output nor its sends. |
| Stereo mix → master | The master high-passes, applies optional compression, adjusts gain to the target and limits peaks. After at most six adjustment passes, the report contains the measured result. |
| Master → output files | The render writes the single pass, an optional repeated loop, then requested stems. A one-shot’s decay sets a common cut and fade for its outputs. |

Files from earlier renders can remain in a reused stems directory. Consume the current report’s `files` list. A process interrupted between writes can leave a partial output set. The audition page embeds stems from its own render.

## Loop processing

| Stage | Boundary behavior |
| --- | --- |
| Score note placement | Releases that extend past the loop end wrap to its beginning. |
| Track and bus inserts | Stateful effects process two periods and keep the second. A feedback tail lasting several periods can still differ from continuous playback. |
| Track automation and chorus | Automation repeats at the loop boundary. Validation warns when its endpoints differ. Chorus modulation snaps to a whole number of cycles per loop. |
| Score master | The master adds up to two seconds of wrapped audio on each side, processes the padded buffer and crops the body. |
| Recipe effects | Periodic DC blocking warms the filter across repeated input. The periodic limiter processes three copies and keeps the middle one. |

`--repeats` tiles the rendered loop. It reproduces any seam already present in that loop.

## Profile selection and verdicts

| Input | Effective state |
| --- | --- |
| Bare WAV | Raw profile, seam unchecked. |
| WAV with a project | Project tempo, loop flag and loudness target. The default profile is `sfx` for an SFX project and `music` otherwise. |
| Explicit profile or loop flag | The explicit setting takes precedence over the project default. Tempo can also be supplied on the command line. |
| Batch recipe | The recipe kind determines the loop flag. The batch checks the encoded samples. |
| Completed check | A failed finding yields exit 1. Advisory findings alone yield success unless promoted by strict mode. Summary rows carry the effective profile and loop status. |

Raw checks use the recipe WAV decoder, which accepts mono or stereo PCM16, PCM24 and float32 at 44.1 or 48 kHz. Other profiles use the broader score WAV decoder. The JSON report records the applied thresholds. A successful raw check with an unchecked seam gives no evidence about the wrap.

## MCP and project files

The stdio server dispatches each JSON-RPC line independently. Initialize returns server information. Tool listing reads the shared registry. Tool calls run synchronously, so a long render delays later messages. Cancellation notifications have no effect on work already running.

A project edit reads the file, applies the mutation in memory and parses the whole project before writing normalized JSON. Invalid input or an invalid edit returns an error before the write. Separate CLI or server processes can race when editing the same file. The direct file write has no revision check or transaction.

## Offline audition

The page decodes its embedded WAVs before enabling playback. Play creates sources at one audio-context time. Pause records the current position and stops the sources. Seeking during playback stops the old sources and starts a new set at the chosen offset. A revision counter discards a pending start if another transport action supersedes it. Gain, mute and solo update the gain nodes while the sources keep their shared clock.

At the end, the transport stops. The next play starts at zero. Copying the mix writes the current controls to the clipboard or shows a selectable JSON field when clipboard access fails.
