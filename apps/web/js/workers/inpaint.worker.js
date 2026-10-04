import { alphaInvert } from '../inpaint/alpha-invert.js';
import { frequencyNotch } from '../inpaint/notch.js';
import { denoise, sharpen } from '../inpaint/postprocess.js';
import { aiInpaint, probeModels } from '../ai-inpaint.js';

self.onmessage = async (e) => {
  const { id, payload } = e.data;

  const emit = (phase, pct, detail) => {
    self.postMessage({ id, type: 'progress', phase, pct, detail });
  };

  try {
    let out = payload.imageData;

    if (payload.useNotch && payload.peaks?.length) {
      emit('inpaint', 0.05, 'Applying frequency notch');
      out = frequencyNotch(out, payload.peaks);
    }

    const wantsAI = !payload.useAlphaInvert && payload.model !== 'alpha';
    const models = wantsAI ? await probeModels() : { migan: false, lama: false };
    const aiAvailable = models.migan || models.lama;

    if (payload.useAlphaInvert) {
      emit('inpaint', 0.3, 'Alpha inversion');
      out = alphaInvert(out, payload.mask, { colour: payload.colour ?? undefined });
      emit('inpaint', 0.9, 'Alpha inversion done');
    } else if (aiAvailable) {
      emit('inpaint', 0.1, 'AI inpainting…');
      try {
        out = await aiInpaint(out, payload.mask, {
          model: payload.model === 'migan' && !models.migan
               ? 'lama'
               : payload.model === 'lama' && !models.lama
                 ? 'migan'
                 : payload.model,
          onProgress: emit,
        });
      } catch (err) {
        console.warn('AI inpaint failed, using blur fallback:', err);
        emit('inpaint', 0.5, 'Falling back to fast inpaint');
        out = fastBlurInpaint(out, payload.mask);
      }
    } else {
      emit('inpaint', 0.3, 'Fast inpaint (models not found)');
      out = fastBlurInpaint(out, payload.mask);
    }

    if (payload.postDenoise) {
      emit('inpaint', 0.92, 'Denoising');
      out = denoise(out, 0.3);
    }
    if (payload.postSharpen) {
      emit('inpaint', 0.96, 'Sharpening');
      out = sharpen(out, 0.4);
    }

    self.postMessage({ id, ok: true, result: out }, [out.data.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err) });
  }
};

// Placeholder inpainting: nearest-neighbour fill from unmasked neighbours.
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