import { alphaInvert } from '../inpaint/alpha-invert.js';
import { frequencyNotch } from '../inpaint/notch.js';
import { denoise, sharpen } from '../inpaint/postprocess.js';

self.onmessage = async (e) => {
  const { id, payload } = e.data;
  try {
    let out = payload.imageData;
    if (payload.useNotch && payload.peaks?.length) out = frequencyNotch(out, payload.peaks);

    if (payload.useAlphaInvert) {
      out = alphaInvert(out, payload.mask, { colour: payload.colour ?? undefined });
    } else {
      out = fastBlurInpaint(out, payload.mask);
    }

    if (payload.postDenoise) out = denoise(out, 0.3);
    if (payload.postSharpen) out = sharpen(out, 0.4);

    self.postMessage({ id, ok: true, result: out }, [out.data.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err) });
  }
};

function fastBlurInpaint(imageData, mask) {
  const { data, width: W, height: H } = imageData;
  const out = new ImageData(new Uint8ClampedArray(data), W, H);
  const radius = 8;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (mask[i] < 0.05) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -radius; dy <= radius; dy += 2) {
        for (let dx = -radius; dx <= radius; dx += 2) {
          const px = x + dx, py = y + dy;
          if (px < 0 || py < 0 || px >= W || py >= H) continue;
          const k = py * W + px;
          if (mask[k] > 0.3) continue;
          const j = k * 4;
          r += data[j]; g += data[j + 1]; b += data[j + 2]; n++;
        }
      }
      if (!n) continue;
      const j = i * 4;
      out.data[j] = r / n;
      out.data[j + 1] = g / n;
      out.data[j + 2] = b / n;
    }
  }
  return out;
}
