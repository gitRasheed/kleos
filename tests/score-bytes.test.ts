import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { renderToFiles } from '../src/score/ops.js';
import { exportMidi } from '../src/score/midi.js';
import { project, tmpDir, track } from './helpers.js';

for (const [name, instrument, wavHash, midiHash] of [
  ['native', 'piano', '11522a239b793c7012c663522369d705bfeac35333d108da6f9c88618f342114', 'bc489bd1295157c38553e87289b4d6c3560a59cc64218c5368588af0dc128c61'],
  ['SF2', { type: 'sf2', params: { bank: 'sine.sf2', program: 48 } }, 'f102715e3359035c06a799108ba2a77412daed817710f01ecb2c9747bef00bfa', '15035fcf6067c090c6ebf3f747c3be8fffe0452d076cfd3c61db04ef2ef65904'],
] as const) {
  test(name + ' score WAV and MIDI match the released render', t => {
    const dir = tmpDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const out = path.join(dir, 'score.wav');
    const p = project({ kind: 'cue', bars: 1, tracks: [
      track('voice', instrument, [{ midi: 69, startBeat: 0.5, durationBeats: 1 }]),
    ] });
    renderToFiles(p, { out, projectDir: 'tests/fixtures/standards' });
    assert.equal(createHash('sha256').update(fs.readFileSync(out)).digest('hex'), wavHash);
    assert.equal(createHash('sha256').update(exportMidi(p)).digest('hex'), midiHash);
  });
}
