import { biquad, filterChain, type Stereo } from './dsp.js';

export type EqBand =
  | { readonly type: 'hp12' | 'lp12' | 'notch'; readonly hz: number; readonly q?: number }
  | { readonly type: 'hp24' | 'lp24'; readonly hz: number }
  | { readonly type: 'bell' | 'lowshelf' | 'highshelf'; readonly hz: number; readonly gainDb: number; readonly q?: number };

export function applyParametricEq(audio: Stereo, bands: readonly EqBand[], sampleRate: number): void {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || bands.length > 8) throw new RangeError('Expected up to eight EQ bands and a positive sample rate');
  const filters = bands.flatMap(band => {
    const q = 'q' in band ? band.q ?? Math.SQRT1_2 : Math.SQRT1_2;
    const gain = 'gainDb' in band ? band.gainDb : 0;
    if (!(band.hz >= 5 && band.hz <= 0.49 * sampleRate && q >= 0.0001 && Number.isFinite(q) && Number.isFinite(gain))) throw new RangeError('Invalid EQ frequency, Q or gain');
    switch (band.type) {
      case 'hp24': case 'lp24':
        return [0.541196100146197, 1.306562964876377].map(poleQ => biquad(band.type === 'hp24' ? 'highpass' : 'lowpass', band.hz, poleQ, 0, sampleRate));
      case 'hp12': return [biquad('highpass', band.hz, q, 0, sampleRate)];
      case 'lp12': return [biquad('lowpass', band.hz, q, 0, sampleRate)];
      case 'bell': return [biquad('peak', band.hz, q, gain, sampleRate)];
      default: return [biquad(band.type, band.hz, q, gain, sampleRate)];
    }
  });
  filterChain(audio.left, filters.map(f => ({ ...f })));
  filterChain(audio.right, filters);
}
