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
import { loadVideo, grabFrame, detectInVideo, processVideo, previewCleanedFrame } from './video.js';

loadPersisted();

// ── DOM refs ─────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const progressEl = $('progress');
const progressFill = progressEl.querySelector('.progress-fill');
const progressLabel = progressEl.querySelector('.progress-label');
const boxLayer = $('box-layer');
const suggestionEl = $('suggestion');
const suggestionText = $('suggestion-text');
const videoEl = $('video');
const overlayEl = $('overlay');
const canvasEl = $('canvas');
const canvasWrap = document.querySelector('.canvas-wrap');

// ── App state ────────────────────────────────────────────────────────────
let mode = 'auto';                      // 'auto' | 'manual'
let currentKind = null;                 // 'image' | 'video'
let currentFile = null;
let currentImageData = null;
let currentVideoUrl = null;
let currentHits = [];
let currentMask = null;                 // Float32Array
let currentInpaintResult = null;

// ── Progress ─────────────────────────────────────────────────────────────
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

// ── Worker plumbing ─────────────────────────────────────────────────────
const worker = (url) => {
  const w = new Worker(url, { type: 'module' });
  const pending = new Map();
  let seq = 0;
  w.onmessage = (e) => {
    const { id, type, ok, result, error, phase, pct, detail } = e.data;
    const p = pending.get(id);
    if (!p) return;
    if (type === 'progress') { p.onProgress?.(phase, pct, detail); return; }
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

// ── Detection boxes overlay ─────────────────────────────────────────────
function clearBoxes() {
  boxLayer.innerHTML = '';
}

function drawBoxes(hits, imageWidth, imageHeight) {
  clearBoxes();
  if (!hits.length) return;

  const wrapRect = canvasWrap.getBoundingClientRect();
  const ar = imageWidth / imageHeight;
  const wrapAr = wrapRect.width / wrapRect.height;
  let dispW, dispH;
  if (wrapAr > ar) { dispH = wrapRect.height; dispW = dispH * ar; }
  else { dispW = wrapRect.width; dispH = dispW / ar; }
  const offX = (wrapRect.width - dispW) / 2;
  const offY = (wrapRect.height - dispH) / 2;
  const sx = dispW / imageWidth;
  const sy = dispH / imageHeight;

  hits.forEach((h, i) => {
    const div = document.createElement('div');
    div.className = 'det-box ' + (i === 0 ? 'best' : 'alt');
    div.style.left = (offX + h.x * sx) + 'px';
    div.style.top = (offY + h.y * sy) + 'px';
    div.style.width = (h.width * sx) + 'px';
    div.style.height = (h.height * sy) + 'px';
    boxLayer.appendChild(div);
  });
}

// ── Suggestion chip ─────────────────────────────────────────────────────
function showSuggestion(hit) {
  if (!hit) { suggestionEl.hidden = true; return; }
  const label = hit.suggested || hit.matchedText || hit.region || 'watermark';
  suggestionText.textContent = label;
  suggestionEl.hidden = false;
}

function hideSuggestion() {
  suggestionEl.hidden = true;
}

// ── Options reader ──────────────────────────────────────────────────────
function readVideoOptions() {
  return {
    targetHeight: (() => {
      const v = $('out-quality').value;
      return v === 'source' ? null : +v;
    })(),
    bitrate: (() => {
      const v = $('out-quality').value;
      return v === '1080' ? 12_000_000
           : v === '720'  ? 8_000_000
           : v === '480'  ? 5_000_000
           : 12_000_000;
    })(),
    preferMp4: $('out-format').value === 'mp4',
  };
}

function readTrimRange(duration) {
  const s = +$('trim-start').value;
  const e = +$('trim-end').value;
  return { start: Math.max(0, s), end: Math.min(duration, e) };
}

// ── Mode switch ─────────────────────────────────────────────────────────
function setMode(next) {
  mode = next;
  document.body.classList.toggle('mode-auto', next === 'auto');
  document.body.classList.toggle('mode-manual', next === 'manual');
  $('mode-auto').classList.toggle('active', next === 'auto');
  $('mode-manual').classList.toggle('active', next === 'manual');
  $('mode-auto').setAttribute('aria-selected', next === 'auto');
  $('mode-manual').setAttribute('aria-selected', next === 'manual');

  if (next === 'manual') {
    state.watermarkText = $('watermark-text').value || state.watermarkText;
  } else {
    state.watermarkText = '';
  }
}

// ── Image handling ──────────────────────────────────────────────────────
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
  return { imageData: dst.getContext('2d').getImageData(0, 0, nw, nh), scale };
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

async function onImage(file) {
  currentKind = 'image';
  currentFile = file;

  if (state.stripMetadata) {
    try { file = await stripMetadata(file); } catch (e) { console.warn(e); }
  }
  const bitmap = await createImageBitmap(file);
  state.setImage(bitmap);

  // Show canvas, hide video
  canvasEl.style.display = '';
  videoEl.style.display = 'none';
  try { videoEl.pause(); } catch {}

  canvasEl.width = bitmap.width;
  canvasEl.height = bitmap.height;
  canvasEl.getContext('2d').drawImage(bitmap, 0, 0);
  currentImageData = canvasEl.getContext('2d').getImageData(0, 0, bitmap.width, bitmap.height);

  maskEditor.reset(bitmap.width, bitmap.height);
  overlayEl.style.pointerEvents = 'auto';

  ui.showStage();
  ui.setDownloadEnabled(false);
  $('btnRemove').disabled = true;
  $('btnPreview').disabled = true;
  hideSuggestion();
  clearBoxes();

  await runDetect();
}

// ── Video handling ──────────────────────────────────────────────────────
async function onVideo(file) {
  currentKind = 'video';
  currentFile = file;

  if (currentVideoUrl) URL.revokeObjectURL(currentVideoUrl);
  currentVideoUrl = URL.createObjectURL(file);

  // Show video, hide canvas
  canvasEl.style.display = 'none';
  videoEl.style.display = '';
  maskEditor.disable();
  overlayEl.style.pointerEvents = 'none';

  ui.showStage();
  ui.setDownloadEnabled(false);
  $('btnRemove').disabled = true;
  $('btnPreview').disabled = true;
  hideSuggestion();
  clearBoxes();

  ui.busy(true);
  try {
    await loadVideo(videoEl, currentVideoUrl, 30000);

    // Wire trim sliders to actual duration
    $('trim-start').min = 0;
    $('trim-start').max = videoEl.duration;
    $('trim-end').min = 0;
    $('trim-end').max = videoEl.duration;
    $('trim-start').value = 0;
    $('trim-end').value = videoEl.duration;
    $('trim-out').textContent = `full (${videoEl.duration.toFixed(1)}s)`;

    // Grab a visible poster frame
    videoEl.currentTime = Math.min(1, videoEl.duration * 0.5);
    await grabFrame(videoEl);

    await runDetect();
  } catch (e) {
    alert('Could not load video: ' + e.message);
    console.error(e);
  } finally {
    ui.busy(false);
  }
}

// ── Unified detection ───────────────────────────────────────────────────
async function runDetect() {
  const isVideo = currentKind === 'video';
  const isAuto = mode === 'auto';
  const text = isAuto ? '' : ($('watermark-text').value || '').trim();

  ui.busy(true);
  setAutoBadge('searching', isVideo ? 'Scanning video…' : 'Scanning image…');
  try {
    let hits = [];

    if (isVideo) {
      hits = await detectInVideo(videoEl, {
        text,
        autoDetect: isAuto,
        onProgress: showProgress,
      });
    } else {
      const { imageData: small, scale } = downscaleForDetection(currentImageData, 2048);
      const hitsSmall = await detectWorker.call(
        {
          imageData: small,
          text,
          autoDetect: isAuto,
          angleAuto: $('watermark-angle-auto').checked,
          angle: +$('watermark-angle').value,
          tiled: $('watermark-tiled').checked,
          outline: $('watermark-outline').checked,
        },
        showProgress,
      );
      hits = upscaleHits(hitsSmall, scale);
    }

    currentHits = hits;

    if (!hits.length) {
      setAutoBadge('failed', 'No watermark found');
      hideSuggestion();
      clearBoxes();
      ui.renderCandidates([]);
      $('btnRemove').disabled = true;
      $('btnPreview').disabled = true;
      return;
    }

    setAutoBadge('found', `${hits.length} candidate${hits.length === 1 ? '' : 's'}`);
    showSuggestion(hits[0]);

    const W = isVideo ? videoEl.videoWidth : canvasEl.width;
    const H = isVideo ? videoEl.videoHeight : canvasEl.height;
    drawBoxes(hits, W, H);
    ui.renderCandidates(hits);

    if (!isVideo) {
      maskEditor.loadMaskFromHit(hits[0]);
    }
    $('btnRemove').disabled = false;
    $('btnPreview').disabled = false;
  } catch (e) {
    console.error(e);
    setAutoBadge('failed', e.message || 'Detection failed');
  } finally {
    ui.busy(false);
    hideProgress();
  }
}

function setAutoBadge(kind, text) {
  const el = $('auto-badge');
  el.classList.remove('searching', 'found', 'failed');
  el.classList.add(kind);
  $('auto-badge-text').textContent = text;
}

// ── Build mask from all hits ────────────────────────────────────────────
function buildMaskFromHits(hits, W, H, maxHits = 5) {
  const mask = new Float32Array(W * H);
  for (const hit of hits.slice(0, maxHits)) {
    const x0 = Math.max(0, Math.round(hit.x));
    const y0 = Math.max(0, Math.round(hit.y));
    const x1 = Math.min(W, Math.round(hit.x + hit.width));
    const y1 = Math.min(H, Math.round(hit.y + hit.height));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) mask[y * W + x] = 1;
    }
  }
  return mask;
}

function currentColour() {
  const v = $('watermark-colour').value;
  if (v === 'white') return [255, 255, 255];
  if (v === 'black') return [0, 0, 0];
  return null;
}

// ── Removal dispatch ────────────────────────────────────────────────────
async function onRemove() {
  if (!currentHits.length) return;
  if (currentKind === 'video') return onRemoveVideo();
  return onRemoveImage();
}

async function onRemoveImage() {
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
        model: $('model').value,
        colour: currentColour(),
        useAlphaInvert: $('watermark-transparent').checked && !!currentHits[0]?.suggested,
        postDenoise: $('post-denoise').checked,
        postSharpen: $('post-sharpen').checked,
      },
      showProgress,
    );
    currentInpaintResult = result;
    canvasEl.getContext('2d').putImageData(result, 0, 0);
    compareSlider.show(state.image, result);
    clearBoxes();
    ui.setDownloadEnabled(true);
  } finally {
    ui.busy(false);
    hideProgress();
  }
}

async function onRemoveVideo() {
  ui.busy(true);
  try {
    const W = videoEl.videoWidth;
    const H = videoEl.videoHeight;

    // Multi-region mask from all detected hits
    const mask = buildMaskFromHits(currentHits, W, H, 5);
    currentMask = mask;

    const colour = currentColour();
    const duration = videoEl.duration;
    const { start, end } = readTrimRange(duration);
    const opts = readVideoOptions();

    const blob = await processVideo(videoEl, {
      mask,
      colour,
      trimStart: start,
      trimEnd: end,
      targetHeight: opts.targetHeight,
      bitrate: opts.bitrate,
      preferMp4: opts.preferMp4,
      onProgress: showProgress,
    });

    const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (currentFile?.name || 'video').replace(/\.[^.]+$/, '') + '_unstamped.' + ext;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    console.error(e);
    alert('Video processing failed: ' + e.message);
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

// ── File drop ───────────────────────────────────────────────────────────
async function onFile(file) {
  if (!file.type) { alert('Unknown file type.'); return; }
  if (file.type.startsWith('image/')) return onImage(file);
  if (file.type.startsWith('video/')) return onVideo(file);
  alert('Unsupported file type: ' + file.type);
}

// ── Presets ─────────────────────────────────────────────────────────────
function onPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  Object.assign(state, p);
  state.preset = name;
  persist();
  ui.syncFromState();
  $('watermark-text').value = p.watermarkText || '';
  if (mode === 'auto' && p.watermarkText) setMode('manual');
}

// ── Boot ────────────────────────────────────────────────────────────────
const ui = mountUI({ onFile, onDetect: runDetect, onRemove, onDownload, onPreset });
const maskEditor = new MaskEditor(canvasEl, overlayEl);
maskEditor.bind();
const compareSlider = new CompareSlider($('compare'));
const palette = new CommandPalette($('palette'));

// Mode buttons
$('mode-auto').addEventListener('click', () => setMode('auto'));
$('mode-manual').addEventListener('click', () => setMode('manual'));

// Suggestion chip actions
$('suggestion-accept').addEventListener('click', () => {
  if (currentHits[0]?.suggested) {
    $('watermark-text').value = currentHits[0].suggested;
    state.watermarkText = currentHits[0].suggested;
    setMode('manual');
  }
  hideSuggestion();
});
$('suggestion-dismiss').addEventListener('click', hideSuggestion);

// Preview button — clean one frame for the current mask
$('suggestion-preview').addEventListener('click', () => {
  if (!currentHits.length) return;
  const W = currentKind === 'video' ? videoEl.videoWidth : canvasEl.width;
  const H = currentKind === 'video' ? videoEl.videoHeight : canvasEl.height;
  const mask = buildMaskFromHits(currentHits, W, H, 5);
  const colour = currentColour();

  if (currentKind === 'video') {
    const cleaned = previewCleanedFrame(videoEl, mask, colour);
    canvasEl.width = W;
    canvasEl.height = H;
    canvasEl.style.display = '';
    videoEl.style.display = 'none';
    canvasEl.getContext('2d').drawImage(cleaned, 0, 0);
    $('suggestion-text').textContent = 'Preview shown (not saved)';
  } else {
    // For images, just re-render the mask overlay
    maskEditor.loadMaskFromHit(currentHits[0]);
  }
});

// Preview clean frame button (sidebar)
$('btnPreview').addEventListener('click', () => {
  if (!currentHits.length) return;
  const W = currentKind === 'video' ? videoEl.videoWidth : canvasEl.width;
  const H = currentKind === 'video' ? videoEl.videoHeight : canvasEl.height;
  const mask = buildMaskFromHits(currentHits, W, H, 5);
  const colour = currentColour();

  if (currentKind === 'video') {
    const cleaned = previewCleanedFrame(videoEl, mask, colour);
    canvasEl.width = W;
    canvasEl.height = H;
    canvasEl.style.display = '';
    videoEl.style.display = 'none';
    canvasEl.getContext('2d').drawImage(cleaned, 0, 0);
    $('suggestion-text').textContent = 'Preview shown (not saved)';
    suggestionEl.hidden = false;
  } else {
    maskEditor.loadMaskFromHit(currentHits[0]);
  }
});

// Trim sliders
function updateTrimLabel() {
  const s = +$('trim-start').value;
  const e = +$('trim-end').value;
  const d = videoEl.duration || 1;
  $('trim-out').textContent =
    (s <= 0.05 && e >= d - 0.05)
      ? `full (${d.toFixed(1)}s)`
      : `${s.toFixed(1)}s → ${e.toFixed(1)}s`;
}
$('trim-start').addEventListener('input', (e) => {
  if (+e.target.value > +$('trim-end').value) $('trim-end').value = e.target.value;
  updateTrimLabel();
});
$('trim-end').addEventListener('input', (e) => {
  if (+e.target.value < +$('trim-start').value) $('trim-start').value = e.target.value;
  updateTrimLabel();
});

// Other events
window.addEventListener('unstamp:undo', () => maskEditor.undo());
window.addEventListener('unstamp:redo', () => maskEditor.redo());
window.addEventListener('unstamp:clear', () => maskEditor.clear());
window.addEventListener('unstamp:brush', (e) => (maskEditor.brushSize = e.detail));
window.addEventListener('unstamp:tool', (e) => (maskEditor.tool = e.detail));
window.addEventListener('unstamp:pickcandidate', (e) => {
  if (currentKind === 'image') maskEditor.loadMaskFromHit(e.detail);
  showSuggestion(e.detail);
  const W = currentKind === 'video' ? videoEl.videoWidth : canvasEl.width;
  const H = currentKind === 'video' ? videoEl.videoHeight : canvasEl.height;
  drawBoxes([e.detail], W, H);
});

bindShortcuts({ onDetect: runDetect, onRemove, maskEditor, palette });
$('btnBatch').onclick = () => runBatch(state);

palette.register([
  { label: 'Detect watermark', hint: 'D', run: runDetect },
  { label: 'Remove watermark', hint: 'R', run: onRemove },
  { label: 'Download result', run: onDownload },
  { label: 'Preview clean frame', run: () => $('btnPreview').click() },
  { label: 'Switch to Automatic mode', run: () => setMode('auto') },
  { label: 'Switch to Manual mode', run: () => setMode('manual') },
  { label: 'Clear mask', run: () => maskEditor.clear() },
  { label: 'Undo', hint: 'Ctrl+Z', run: () => maskEditor.undo() },
  { label: 'Redo', hint: 'Ctrl+Shift+Z', run: () => maskEditor.redo() },
  { label: 'Batch process…', run: () => runBatch(state) },
]);

// Redraw boxes on window resize
window.addEventListener('resize', () => {
  if (!currentHits.length) return;
  const W = currentKind === 'video' ? videoEl.videoWidth : canvasEl.width;
  const H = currentKind === 'video' ? videoEl.videoHeight : canvasEl.height;
  drawBoxes(currentHits, W, H);
});

// Default to automatic mode
setMode('auto');

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}