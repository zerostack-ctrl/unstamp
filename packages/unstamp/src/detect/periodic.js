import { fft2d, topKPeaks } from './fft.js';
import { toGray, highPass } from './text.js';

export function findTilePeriod(imageData, maxPeriods = 4) {
  const { width: W, height: H } = imageData;
  const residual = highPass(toGray(imageData), W, H, 20);
  const re = new Float32Array(W * H);
  const im = new Float32Array(W * H);
  re.set(residual);
  fft2d(re, im, W, H);
  const peaks = topKPeaks(re, im, W, H, 8);
  return peaks.slice(0, maxPeriods).map((p) => ({
    dx: p.fx === 0 ? 0 : (W / Math.abs(p.fx)) * Math.sign(p.fx),
    dy: p.fy === 0 ? 0 : (H / Math.abs(p.fy)) * Math.sign(p.fy),
    strength: p.mag,
  }));
}
