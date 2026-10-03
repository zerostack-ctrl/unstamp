import { state, loadPersisted, persist } from './state.js';
import { mountUI } from './ui.js';
import { PRESETS } from './presets.js';
import { stripMetadata } from './metadata.js';
import { MaskEditor } from './mask-editor.js';
import { CompareSlider } from './compare-slider.js';
import { CommandPalette } from './command-palette.js';
import { bindShortcuts } from './shortcuts.js';
import { runBatch } from './batch.js';
import { detectFaces, carveOut } from './safe-mode.js';
import { processVideo } from './video.js';

loadPersisted();

// ── Progress bar ─────────────────────────────────────────────────────────
const progressEl = document.getElementById('progress');
const progressFill = progressEl.querySelector('.progress-fill');
const progressLabel = progressEl.querySelector('.progress-label');

function showProgress(phase, pct, detail = '') {
  progressEl.hidden = false;
  progressFill.style.width = `${(pct * 100).toFixed(1)}%`;
  const phaseName = {
    detect: 'Detecting',
    mask: 'Building mask',
    inpaint: 'Inpainting',
    postprocess: 'Post-processing',
    video: 'Video',
  }[phase] || phase;
  progressLabel.innerHTML =
    `<span class="phase">${phaseName}</span>` +
    `<span class="detail">${(pct * 100).toFixed(0)}% · ${detail}</span>`;
}

function hideProgress() {
  setTimeout(() => { progressEl.hidden = true; }, 800);
}

// ── Worker with progress forwarding ──────────────────────────────────────
const worker = (url) => {
  const w = new Worker(url, { type: 'module' });
  const pending = new Map();
  let seq = 0;

  w.onmessage = (e) => {
    const { id, type, ok, result, error, phase, pct, detail } = e.data;
    const p = pending.get(id);
    if (!p) return;

    if (type === 'progress') {
      p.onProgress?.(phase, pct, detail);
      return;
    }

    pending.delete(id);
    ok ? p.resolve(result) : p.reject(new Error(error));
  };

  return {
    call: (payload, onProgress) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject, onProgress });
        w.postMessage({ id, payload });
      }),
  };
};

const detectWorker = worker('js/workers/detect.worker.js');
const inpaintWorker = worker('js/workers/inpaint.worker.js');

let currentImageData = null;
let currentInpaintResult = null;

// ── Downscale helper ────────────────────────────────────────────────────
function downscaleForDetection(imageData, maxSide = 2048) {
  const { width: W, height: H } = imageData;
  const scale = Math.min(1, maxSide / Math.max(W, H));
  if (scale >= 0.95) return { imageData, scale: 1 };

  const nw = Math.max(1, Math.round(W * scale));
  const nh = Math.max(1, Math.round(H * scale));

  const src = document.createElement('canvas');
  src.width = W; src.height = H;
  src.getContext('2d').putImageData(imageData, 0, 0);

  const dst = document.createElement('canvas');
  dst.width = nw; dst.height = nh;
  dst.getContext('2d').drawImage(src, 0, 0, W, H, 0, 0, nw, nh);

  return {
    imageData: dst.getContext('2d').getImageData(0, 0, nw, nh),
    scale,
  };
}

function upscaleHits(hits, scale) {
  if (scale === 1) return hits;
  return hits.map((h) => ({
    ...h,
    x: h.x / scale,
    y: h.y / scale,
    width: h.width / scale,
    height: h.height / scale,
  }));
}

// ── File handling ────────────────────────────────────────────────────────
async function onFile(file) {
  if (file.type.startsWith('video/')) {
    return onVideoFile(file);
  }

  if (state.stripMetadata) {
    try { file = await stripMetadata(file); } catch (e) { console.warn(e); }
  }
  const bitmap = await createImageBitmap(file);
  state.setImage(bitmap);

  const c = document.getElementById('canvas');
  c.width = bitmap.width;
  c.height = bitmap.height;
  c.getContext('2d').drawImage(bitmap, 0, 0);
  currentImageData = c.getContext('2d').getImageData(0, 0, c.width, c.height);

  maskEditor.reset(bitmap.width, bitmap.height);
  document.getElementById('overlay').style.pointerEvents = 'auto';
  ui.showStage();
  ui.setDownloadEnabled(false);
  document.getElementById('btnRemove').disabled = false;
  document.querySelector('.canvas-wrap').style.display = '';

  // Auto-detect immediately if the user hasn't typed anything
  if (!state.watermarkText) {
    await onDetect();
  }
}

async function onVideoFile(file) {
  currentImageData = null;
  currentInpaintResult = null;

  document.getElementById('drop').hidden = true;
  document.getElementById('stage').hidden = false;
  document.querySelector('.canvas-wrap').style.display = 'none';
  maskEditor.disable();

  ui.busy(true);
  try {
    const blob = await processVideo(file, {
      text: state.watermarkText,
      colour: state.watermarkColour === 'white'
        ? [255, 255, 255]
        : state.watermarkColour === 'black'
          ? [0, 0, 0]
          : null,
      autoDetect: true,
      onProgress: showProgress,
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = file.name.replace(/\.[^.]+$/, '') + '_unstamped.webm';
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    alert('Video processing failed: ' + e.message);
  } finally {
    ui.busy(false);
    hideProgress();
  }
}

// ── Detection ────────────────────────────────────────────────────────────
async function onDetect() {
  if (!currentImageData) return;
  ui.busy(true);
  try {
    const { imageData: small, scale } = downscaleForDetection(currentImageData, 2048);
    const hitsSmall = await detectWorker.call(
      {
        imageData: small,
        text: state.watermarkText,
        autoDetect: !state.watermarkText,
        angleAuto: state.watermarkAngleAuto,
        angle: state.watermarkAngle,
        tiled: state.watermarkTiled,
        outline: state.watermarkOutline,
      },
      showProgress,
    );
    const hits = upscaleHits(hitsSmall, scale);

    if (state.safeMode) {
      const faces = await detectFaces(state.image);
      if (faces.length) window.__faces = faces;
    }
    if (hits[0]) maskEditor.loadMaskFromHit(hits[0]);
    ui.renderCandidates(hits);
  } finally {
    ui.busy(false);
    hideProgress();
  }
}

// ── Removal ──────────────────────────────────────────────────────────────
async function onRemove() {
  if (!currentImageData) return;
  ui.busy(true);
  try {
    let mask = maskEditor.toMask();
    if (state.safeMode && window.__faces?.length) {
      mask = new Float32Array(mask);
      carveOut(mask, currentImageData.width, currentImageData.height, window.__faces);
    }
    const result = await inpaintWorker.call(
      {
        imageData: currentImageData,
        mask,
        model: state.model,
        colour: state.watermarkColour === 'white'
          ? [255, 255, 255]
          : state.watermarkColour === 'black'
            ? [0, 0, 0]
            : null,
        useAlphaInvert: state.watermarkTransparent && !!state.watermarkText,
        postDenoise: state.postDenoise,
        postSharpen: state.postSharpen,
      },
      showProgress,
    );
    currentInpaintResult = result;
    const c = document.getElementById('canvas');
    c.getContext('2d').putImageData(result, 0, 0);
    compareSlider.show(state.image, result);
    ui.setDownloadEnabled(true);
  } finally {
    ui.busy(false);
    hideProgress();
  }
}

function onDownload() {
  if (!currentInpaintResult) return;
  const c = document.createElement('canvas');
  c.width = currentInpaintResult.width;
  c.height = currentInpaintResult.height;
  c.getContext('2d').putImageData(currentInpaintResult, 0, 0);
  c.toBlob((b) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = 'unstamped.png';
    a.click();
    URL.revokeObjectURL(a.href);
  }, 'image/png');
}

function onPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  Object.assign(state, p);
  state.preset = name;
  persist();
  ui.syncFromState();
}

// ── Wire everything ──────────────────────────────────────────────────────
const ui = mountUI({ onFile, onDetect, onRemove, onDownload, onPreset });
const maskEditor = new MaskEditor(
  document.getElementById('canvas'),
  document.getElementById('overlay'),
);
maskEditor.bind();
const compareSlider = new CompareSlider(document.getElementById('compare'));
const palette = new CommandPalette(document.getElementById('palette'));

window.addEventListener('unstamp:undo', () => maskEditor.undo());
window.addEventListener('unstamp:redo', () => maskEditor.redo());
window.addEventListener('unstamp:clear', () => maskEditor.clear());
window.addEventListener('unstamp:brush', (e) => (maskEditor.brushSize = e.detail));
window.addEventListener('unstamp:tool', (e) => (maskEditor.tool = e.detail));
window.addEventListener('unstamp:pickcandidate', (e) => maskEditor.loadMaskFromHit(e.detail));

bindShortcuts({ onDetect, onRemove, maskEditor, palette });

document.getElementById('btnBatch').onclick = () => runBatch(state);

palette.register([
  { label: 'Detect watermark (auto)', hint: 'D', run: onDetect },
  { label: 'Remove watermark', hint: 'R', run: onRemove },
  { label: 'Download result', run: onDownload },
  { label: 'Clear mask', run: () => maskEditor.clear() },
  { label: 'Undo', hint: 'Ctrl+Z', run: () => maskEditor.undo() },
  { label: 'Redo', hint: 'Ctrl+Shift+Z', run: () => maskEditor.redo() },
  { label: 'Batch process…', run: () => runBatch(state) },
]);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}