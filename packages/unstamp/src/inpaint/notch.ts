import { fft2d } from '../detect/fft.js';

export function frequencyNotch(
  imageData: ImageData,
  peaks: Array<{ fx: number; fy: number }>,
  radius = 4,
): ImageData {
  const { data, width: W, height: H } = imageData;
  const out = new ImageData(new Uint8ClampedArray(data), W, H);

  for (let c = 0; c < 3; c++) {
    const re = new Float32Array(W * H);
    const im = new Float32Array(W * H);
    for (let i = 0, j = c; i < re.length; i++, j += 4) re[i] = data[j]!;
    fft2d(re, im, W, H);
    const cx = W >> 1; const cy = H >> 1;
    for (const p of peaks) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const x = cx + p.fx + dx; const y = cy + p.fy + dy;
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          re[y * W + x] = 0; im[y * W + x] = 0;
          const kx = (W - x) % W; const ky = (H - y) % H;
          re[ky * W + kx] = 0; im[ky * W + kx] = 0;
        }
      }
    }
    fft2d(re, im, W, H, true);
    for (let i = 0, j = c; i < re.length; i++, j += 4)
      out.data[j] = Math.max(0, Math.min(255, re[i]!));
  }
  return out;
}
