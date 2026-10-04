import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.0';

env.allowLocalModels = false;
env.useBrowserCache = true;

// ── Default prompts fed to OWL-ViT ─────────────────────────────────────
export const AI_PROMPTS = [
  'watermark',
  'logo',
  'text overlay',
  'channel name',
  'username handle',
  '@username',
  'subscribe button',
  'follow button',
  'social media icon',
  'corner text',
  'lower third text',
];

let detector = null;
let detectorPromise = null;

export function isAISupported() {
  return typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined';
}

export async function loadAIDetector(onProgress) {
  if (detector) return detector;
  if (detectorPromise) return detectorPromise;

  detectorPromise = (async () => {
    const p = await pipeline(
      'zero-shot-object-detection',
      'Xenova/owlvit-base-patch32',
      {
        quantized: true,
        progress_callback: (x) => {
          if (!onProgress) return;
          if (x.status === 'progress' && x.file) {
            const pct = x.total ? x.loaded / x.total : 0;
            onProgress('detect', pct * 0.9,
              `Loading AI model… ${(pct * 100).toFixed(0)}% (${x.file})`);
          } else if (x.status === 'ready') {
            onProgress('detect', 1, 'AI model ready');
          }
        },
      },
    );
    detector = p;
    return p;
  })();

  return detectorPromise;
}

/**
 * Run AI detection on an image.
 * @param {ImageBitmap|HTMLCanvasElement|ImageData} source
 * @param {string[]} prompts — overrides AI_PROMPTS if given
 * @param {{ threshold?: number, onProgress?: Function }} opts
 * @returns {Promise<Detection[]>}
 */
export async function aiDetect(source, prompts, opts = {}) {
  const { onProgress, threshold = 0.1 } = opts;

  onProgress?.('detect', 0.02, 'Preparing AI model…');
  const det = await loadAIDetector(onProgress);

  const queries = (prompts && prompts.length) ? prompts : AI_PROMPTS;
  onProgress?.('detect', 0.92, `Searching for: ${queries.slice(0, 3).join(', ')}…`);

  // transformers.js expects a canvas / image / bitmap it can draw
  const canvas = toCanvas(source);

  const results = await det(canvas, queries, { threshold });

  onProgress?.('detect', 1, `AI found ${results.length} region${results.length === 1 ? '' : 's'}`);

  return results.map((r) => ({
    x: r.box.xmin,
    y: r.box.ymin,
    width: Math.max(1, r.box.xmax - r.box.xmin),
    height: Math.max(1, r.box.ymax - r.box.ymin),
    score: r.score,
    label: r.label,
    angle: 0,
    scale: 1,
    region: 'ai',
    suggested: cleanLabel(r.label),
  }));
}

// ── Helpers ─────────────────────────────────────────────────────────────
function toCanvas(source) {
  if (source instanceof HTMLCanvasElement) return source;
  const W = source.width;
  const H = source.height;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  if (source instanceof ImageData) {
    ctx.putImageData(source, 0, 0);
  } else {
    ctx.drawImage(source, 0, 0, W, H);
  }
  return c;
}

function cleanLabel(raw) {
  if (!raw) return 'watermark';
  return String(raw)
    .replace(/^a\s+/i, '')
    .replace(/\s+on.*$/i, '')
    .trim()
    .slice(0, 40);
}

// Warm up in the background (call from idle time)
export function warmUpAI() {
  if (!isAISupported()) return;
  if ('requestIdleCallback' in window) {
    requestIdleCallback(() => loadAIDetector().catch(() => {}));
  } else {
    setTimeout(() => loadAIDetector().catch(() => {}), 3000);
  }
}