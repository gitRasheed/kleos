import test from 'node:test';
import assert from 'node:assert/strict';
import { applyParametricEq } from '../../dist/score/eqParametric.js';
import { fftInPlace } from '../../dist/ears/fft.js';
const sr = 48000, n = 131072, length = 96000, corner = 1117, q = 0.83, gain = 9;
const k = Math.log(20000 / 30) / length;
const chirp = Float64Array.from({ length: n }, (_, i) => i >= length ? 0 :
  Math.sin(2 * Math.PI * 30 / (sr * k) * Math.expm1(k * i)) * Math.min(1, i / 1200, (length - i) / 1200));
function transform(audio) {
  const real = audio.slice(), imag = new Float64Array(n);
  fftInPlace(real, imag);
  return real.map((x, i) => Math.hypot(x, imag[i]));
}
const input = transform(chirp);
function analytic(type, hz) {
  const f = Math.tan(Math.PI * hz / sr) / Math.tan(Math.PI * corner / sr);
  const den = Math.hypot(1 - f * f, f / q), a = 10 ** (gain / 40);
  switch (type) {
    case 'hp12': return f * f / den;
    case 'lp12': return 1 / den;
    case 'hp24': return f ** 4 / Math.sqrt(1 + f ** 8);
    case 'lp24': return 1 / Math.sqrt(1 + f ** 8);
    case 'notch': return Math.abs(1 - f * f) / den;
    case 'bell': return Math.hypot(1 - f * f, f * a / q) / Math.hypot(1 - f * f, f / (a * q));
    default: {
      const x = type === 'lowshelf' ? f : 1 / f;
      return a * Math.hypot(a - x * x, Math.sqrt(a) * x / q) / Math.hypot(1 - a * x * x, Math.sqrt(a) * x / q);
    }
  }
}
for (const type of ['hp12', 'hp24', 'lp12', 'lp24', 'lowshelf', 'highshelf', 'bell', 'notch']) {
  test(type + ' follows independent prewarped analog response on a logarithmic sweep', t => {
    const buf = { left: chirp.slice(), right: new Float64Array(n) };
    applyParametricEq(buf, [{ type, hz: corner, q, gainDb: gain }], sr);
    const output = transform(buf.left);
    let worst = 0;
    for (let i = Math.ceil(60 * n / sr); i <= Math.floor(16000 * n / sr); i++) {
      const expected = analytic(type, i * sr / n);
      const error = 20 * Math.log10(output[i] / input[i] / expected);
      worst = Math.max(worst, Math.abs(error));
    }
    assert.ok(worst <= 0.5, 'worst error ' + worst + ' dB');
    t.diagnostic('worst error ' + worst.toExponential(2) + ' dB');
    assert.ok(buf.right.every(x => x === 0));
  });
}
test('eight simultaneous bands compose and a ninth fails before touching input', () => {
  const boost = { type: 'bell', hz: 1000, q: 1, gainDb: 3 };
  const cut = { ...boost, gainDb: -3 };
  const buf = { left: chirp.slice(), right: chirp.slice() };
  const bands = [boost, cut, boost, cut, boost, cut, boost, cut];
  applyParametricEq(buf, bands, sr);
  assert.ok(buf.left.every((v, i) => Math.abs(v - chirp[i]) < 1e-10));
  const before = buf.left.slice();
  assert.throws(() => applyParametricEq(buf, [...bands, cut], sr), /eight/);
  assert.deepEqual(buf.left, before);
});
