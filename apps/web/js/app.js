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

loadPersisted();

const worker = (url) => {
  const w = new Worker(url, { type: 'module' });
  const pending = new Map();
  let seq = 0;
  w.onmessage = (e) => {
    const { id, ok, result, error } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    ok ? p.resolve(result) : p.reject(new Error(error));
  };
  return {
    call: (payload) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        w.postMessage({ id, payload });
      }),
  };
};

const detectWorker = worker('js/workers/detect.worker.js');
const inpaintWorker = worker('js/workers/inpaint.worker.js');

let currentImageData = null;
let currentInpaintResult = null;

async function onFile(file) {
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
  ui.showStage();
  ui.setDownloadEnabled(false);
  document.getElementById('btnRemove').disabled = false;
}

async function onDetect() {
  if (!currentImageData) return;
  ui.busy(true);
  try {
    const hits = await detectWorker.call({
      imageData: currentImageData,
      text: state.watermarkText,
      angleAuto: state.watermarkAngleAuto,
      angle: state.watermarkAngle,
      tiled: state.watermarkTiled,
      outline: state.watermarkOutline,
    });
    if (state.safeMode) {
      const faces = await detectFaces(state.image);
      if (faces.length) window.__faces = faces;
    }
    if (hits[0]) maskEditor.loadMaskFromHit(hits[0]);
    ui.renderCandidates(hits);
  } finally { ui.busy(false); }
}

async function onRemove() {
  if (!currentImageData) return;
  ui.busy(true);
  try {
    let mask = maskEditor.toMask();
    if (state.safeMode && window.__faces?.length) {
      mask = new Float32Array(mask);
      carveOut(mask, currentImageData.width, currentImageData.height, window.__faces);
    }
    const result = await inpaintWorker.call({
      imageData: currentImageData,
      mask,
      model: state.model,
      colour: state.watermarkColour === 'white' ? [255, 255, 255]
            : state.watermarkColour === 'black' ? [0, 0, 0] : null,
      useAlphaInvert: state.watermarkTransparent && !!state.watermarkText,
      postDenoise: state.postDenoise,
      postSharpen: state.postSharpen,
    });
    currentInpaintResult = result;
    const c = document.getElementById('canvas');
    c.getContext('2d').putImageData(result, 0, 0);
    compareSlider.show(state.image, result);
    ui.setDownloadEnabled(true);
  } finally { ui.busy(false); }
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
  { label: 'Detect watermark', hint: 'D', run: onDetect },
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
