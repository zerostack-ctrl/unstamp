// AI inpainting via ONNX Runtime Web (loaded from CDN in index.html).
// Uses:
//   models/migan.onnx  — MI-GAN, fast small-mask inpainting (~28 MB)
//   models/lama.onnx   — LaMa, high-quality large-mask inpainting (~62-107 MB)
//
// Falls back to alpha-inversion if models are missing.

let ort = null;
let miganSession = null;
let lamaSession = null;
let miganPromise = null;
let lamaPromise = null;

function getOrt() {
  if (ort) return ort;
  ort = globalThis.ort;
  if (!ort) throw new Error('onnxruntime-web not loaded');
  return ort;
}

// ── Model loading ───────────────────────────────────────────────────────
export async function loadMigan(onProgress) {
  if (miganSession) return miganSession;
  if (miganPromise) return miganPromise;

  miganPromise = (async () => {
    const o = getOrt();
    onProgress?.('inpaint', 0.05, 'Loading MI-GAN…');
    const session = await o.InferenceSession.create('models/migan.onnx', {
      executionProviders: await bestProviders(o),
      graphOptimizationLevel: 'all',
    });
    miganSession = session;
    return session;
  })();

  return miganPromise;
}

export async function loadLama(onProgress) {
  if (lamaSession) return lamaSession;
  if (lamaPromise) return lamaPromise;

  lamaPromise = (async () => {
    const o = getOrt();
    onProgress?.('inpaint', 0.05, 'Loading LaMa…');
    const session = await o.InferenceSession.create('models/lama.onnx', {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    lamaSession = session;
    return session;
  })();

  return lamaPromise;
}

async function bestProviders(o) {
  try {
    if (typeof navigator !== 'undefined' && navigator.gpu && o.env?.webgpu) {
      return ['webgpu', 'wasm'];
    }
  } catch {}
  return ['wasm'];
}

// ── Public API ──────────────────────────────────────────────────────────
/**
 * Inpaint using the best available AI model.
 * @param {ImageData} imageData
 * @param {Float32Array} mask
 * @param {{ model?: 'auto'|'migan'|'lama', onProgress?: Function }} opts
 * @returns {Promise<ImageData>}
 */
export async function aiInpaint(imageData, mask, opts = {}) {
  const { model = 'auto', onProgress } = opts;

  // Area heuristic: small masks → MI-GAN, large → LaMa
  let pick = model;
  if (pick === 'auto') {
    let covered = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i] > 0.5) covered++;
    const area = covered / mask.length;
    pick = area > 0.15 ? 'lama' : 'migan';
  }

  try {
    if (pick === 'migan') {
      return await miganInpaint(imageData, mask, onProgress);
    }
    return await lamaInpaint(imageData, mask, onProgress);
  } catch (e) {
    console.warn(`AI inpaint (${pick}) failed:`, e);
    // Try the other one before giving up
    try {
      return pick === 'migan'
        ? await lamaInpaint(imageData, mask, onProgress)
        : await miganInpaint(imageData, mask, onProgress);
    } catch (e2) {
      console.warn('Both AI models failed:', e2);
      throw new Error('AI inpainting unavailable. Add models/migan.onnx or models/lama.onnx.');
    }
  }
}

// ── MI-GAN inference ────────────────────────────────────────────────────
async function miganInpaint(imageData, mask, onProgress) {
  const o = getOrt();
  const session = await loadMigan(onProgress);
  const { width: W, height: H } = imageData;

  const size = 512;
  const img = new Float32Array(3 * size * size);
  const msk = new Float32Array(size * size);
  const sx = W / size;
  const sy = H / size;

  onProgress?.('inpaint', 0.2, 'Running MI-GAN…');

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ox = Math.min(W - 1, (x * sx) | 0);
      const oy = Math.min(H - 1, (y * sy) | 0);
      const j = (oy * W + ox) * 4;
      const k = y * size + x;
      img[0 * size * size + k] = imageData.data[j] / 127.5 - 1;
      img[1 * size * size + k] = imageData.data[j + 1] / 127.5 - 1;
      img[2 * size * size + k] = imageData.data[j + 2] / 127.5 - 1;
      msk[k] = mask[oy * W + ox];
    }
  }

  const results = await session.run({
    image: new o.Tensor('float32', img, [1, 3, size, size]),
    mask: new o.Tensor('float32', msk, [1, 1, size, size]),
  });

  onProgress?.('inpaint', 0.85, 'Blending result…');

  const out = new ImageData(W, H);
  const o1 = results.output.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = Math.min(size - 1, (x / sx) | 0);
      const py = Math.min(size - 1, (y / sy) | 0);
      const k = py * size + px;
      const j = (y * W + x) * 4;
      out.data[j] = Math.max(0, Math.min(255, (o1[0 * size * size + k] + 1) * 127.5));
      out.data[j + 1] = Math.max(0, Math.min(255, (o1[1 * size * size + k] + 1) * 127.5));
      out.data[j + 2] = Math.max(0, Math.min(255, (o1[2 * size * size + k] + 1) * 127.5));
      out.data[j + 3] = 255;
    }
  }
  return out;
}

// ── LaMa inference ──────────────────────────────────────────────────────
async function lamaInpaint(imageData, mask, onProgress) {
  const o = getOrt();
  const session = await loadLama(onProgress);
  const { width: W, height: H } = imageData;

  const fw = Math.ceil(W / 8) * 8;
  const fh = Math.ceil(H / 8) * 8;
  const img = new Float32Array(3 * fh * fw);
  const msk = new Float32Array(fh * fw);

  onProgress?.('inpaint', 0.2, 'Running LaMa…');

  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      const ox = Math.min(W - 1, x);
      const oy = Math.min(H - 1, y);
      const j = (oy * W + ox) * 4;
      const k = y * fw + x;
      img[0 * fh * fw + k] = imageData.data[j] / 255;
      img[1 * fh * fw + k] = imageData.data[j + 1] / 255;
      img[2 * fh * fw + k] = imageData.data[j + 2] / 255;
      msk[k] = mask[oy * W + ox];
    }
  }

  const out = await session.run({
    image: new o.Tensor('float32', img, [1, 3, fh, fw]),
    mask: new o.Tensor('float32', msk, [1, 1, fh, fw]),
  });

  onProgress?.('inpaint', 0.85, 'Blending result…');

  const res = new ImageData(W, H);
  const o1 = out.output.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = y * fw + x;
      const j = (y * W + x) * 4;
      res.data[j] = Math.max(0, Math.min(255, o1[0 * fh * fw + k] * 255));
      res.data[j + 1] = Math.max(0, Math.min(255, o1[1 * fh * fw + k] * 255));
      res.data[j + 2] = Math.max(0, Math.min(255, o1[2 * fh * fw + k] * 255));
      res.data[j + 3] = 255;
    }
  }
  return res;
}

// ── Availability probe ──────────────────────────────────────────────────
let _probe = null;
export async function probeModels() {
  if (_probe) return _probe;
  _probe = (async () => {
    const check = async (url) => {
      try {
        const r = await fetch(url, { method: 'HEAD' });
        return r.ok;
      } catch {
        return false;
      }
    };
    const [migan, lama] = await Promise.all([
      check('models/migan.onnx'),
      check('models/lama.onnx'),
    ]);
    return { migan, lama };
  })();
  return _probe;
}