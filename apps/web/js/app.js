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
import { aiDetect, isAISupported, warmUpAI } from './ai.js';

loadPersisted();

// ── Size limits ──────────────────────────────────────────────────────────
const LIMITS = {
  imageFileMB: 100,       // reject images over this size
  videoFileMB: 500,       // reject videos over this size
  videoMinutes: 10,       // warn about videos over this length
  imageMaxSide: 4096,     // downscale images bigger than this for processing
  videoMaxSide: 1920,     // downscale video output to this max width
};

// ── DOM refs ─────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const progressEl = $('progress');
const progressFill = progressEl?.querySelector('.progress-fill');
const progressLabel = progressEl?.querySelector('.progress-label');
const boxLayer = $('box-layer');
const suggestionEl = $('suggestion');
const suggestionText = $('suggestion-text');
const videoEl = $('video');
const overlayEl = $('overlay');
const canvasEl = $('canvas');
const canvasWrap = document.querySelector('.canvas-wrap');

// ── Null-safe DOM helpers ───────────────────────────────────────────────
const on = (id, event, fn) => {
  const el = $(id);
  if (el) el.addEventListener(event, fn);
  return el;
};
const setHidden = (id, hidden) => {
  const el = $(id);
  if (el) el.hidden = hidden;
};
const setDisabled = (id, disabled) => {
  const el = $(id);
  if (el) el.disabled = disabled;
};

// ── App state ────────────────────────────────────────────────────────────
let mode = 'auto';
let currentKind = null;
let currentFile = null;
let currentImageData = null;
let currentVideoUrl = null;
let currentHits = [];
let currentMask = null;
let currentInpaintResult = null;   // ImageData — only set by full removal
let currentVideoResult = null;     // Blob — only set by full video removal
let previewMode = false;

function resetDownloadState() {
  currentInpaintResult = null;
  currentVideoResult = null;
  ui.setDownloadEnabled(false);
}

// ── Progress ─────────────────────────────────────────────────────────────
function showProgress(phase, pct, detail = '') {
  if (!progressEl) return;
  progressEl.hidden = false;
  if (progressFill) progressFill.style.width = `${(pct * 100).toFixed(1)}%`;
  if (progressLabel) {
    const phaseName = {
      detect: 'Detecting',
      mask: 'Building mask',
      inpaint: 'Inpainting',
      postprocess: 'Post-processing',
      video: 'Video',
      ai: 'AI',
    }[phase] || phase;
    progressLabel.innerHTML =
      `<span class="phase">${phaseName}</span>` +
      `<span class="detail">${(pct * 100).toFixed(0)}% · ${detail}</span>`;
  }
}
function hideProgress() {
  if (!progressEl) return;
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
  if (boxLayer) boxLayer.innerHTML = '';
}

function drawBoxes(hits, imageWidth, imageHeight) {
  if (!boxLayer || !canvasWrap) return;
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
    if (h.region === 'ai') {
      div.style.borderColor = '#22d3ee';
      div.style.background = 'rgba(34,211,238,.08)';
    }
    boxLayer.appendChild(div);
  });
}

// ── Suggestion chip ─────────────────────────────────────────────────────
function showSuggestion(hit, customText = null) {
  if (!suggestionEl || !suggestionText) return;
  if (!hit) { suggestionEl.hidden = true; return; }
  const label = customText || hit.suggested || hit.matchedText || hit.region || 'watermark';
  suggestionText.textContent = label;
  suggestionEl.hidden = false;
}
function hideSuggestion() {
  if (suggestionEl) suggestionEl.hidden = true;
}

// ── Options ─────────────────────────────────────────────────────────────
function readVideoOptions() {
  const quality = $('out-quality')?.value ?? '720';
  const bitrateMbps = +($('out-bitrate')?.value ?? 3);
  return {
    targetHeight: quality === 'source' ? null : +quality,
    bitrate: Math.round(bitrateMbps * 1_000_000),
    preferMp4: ($('out-format')?.value ?? 'mp4') === 'mp4',
    maxSide: LIMITS.videoMaxSide,
  };
}

function updateBitrateLabel() {
  const out = $('bitrate-out');
  const slider = $('out-bitrate');
  if (!out || !slider) return;
  const mbps = +slider.value;
  const mbPerMin = (mbps * 60) / 8;
  const size = mbPerMin < 1
    ? `${(mbPerMin * 1000).toFixed(0)} KB/min`
    : `${mbPerMin.toFixed(1)} MB/min`;
  out.textContent = `${mbps} Mbps · ~${size}`;
}

function applyQualityPreset() {
  const q = $('out-quality')?.value ?? '720';
  const slider = $('out-bitrate');
  if (!slider) return;
  const preset = { '480': 1.5, '720': 3, '1080': 6, 'source': 8 }[q] ?? 3;
  slider.value = preset;
  updateBitrateLabel();
}

function readTrimRange(duration) {
  const s = +($('trim-start')?.value ?? 0);
  const e = +($('trim-end')?.value ?? duration);
  return { start: Math.max(0, s), end: Math.min(duration, e) };
}

function currentColour() {
  const v = $('watermark-colour')?.value ?? 'auto';
  if (v === 'white') return [255, 255, 255];
  if (v === 'black') return [0, 0, 0];
  return null;
}

function buildMaskFromHits(hits, W, H, maxHits = 5) {
  const mask = new Float32Array(W * H);
  for (const hit of hits.slice(0, maxHits)) {
    const x0 = Math.max(0, Math.round(hit.x));
    const y0 = Math.max(0, Math.round(hit.y));
    const x1 = Math.min(W, Math.round(hit.x + hit.width));
    const y1 = Math.min(H, Math.round(hit.y + hit.height));
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) mask[y * W + x] = 1;
  }
  return mask;
}

// ── Mode switch ─────────────────────────────────────────────────────────
function setMode(next) {
  mode = next;
  document.body.classList.toggle('mode-auto', next === 'auto');
  document.body.classList.toggle('mode-ai', next === 'ai');
  document.body.classList.toggle('mode-manual', next === 'manual');
  $('mode-auto')?.classList.toggle('active', next === 'auto');
  $('mode-ai')?.classList.toggle('active', next === 'ai');
  $('mode-manual')?.classList.toggle('active', next === 'manual');
  $('mode-auto')?.setAttribute('aria-selected', next === 'auto');
  $('mode-ai')?.setAttribute('aria-selected', next === 'ai');
  $('mode-manual')?.setAttribute('aria-selected', next === 'manual');

  const hint = $('mode-hint');
  if (hint) {
    hint.innerHTML = next === 'ai'
      ? 'AI mode understands natural language. Describe the watermark — <em>"the logo in the corner"</em>, <em>"@channel"</em>, <em>"TikTok badge"</em>.'
      : next === 'manual'
        ? 'Type the exact watermark text. Best for known watermarks like <code>Gemini</code>, <code>Sora</code>, or <code>DALL·E</code>.'
        : 'Detects common watermarks automatically — <code>@username</code>, <code>subscribe</code>, links, and anything static across video frames.';
  }

  if (next === 'ai' && !isAISupported()) {
    setAutoBadge('failed', 'AI not supported in this browser');
  } else if (next === 'ai') {
    warmUpAI();
  }
  if (next === 'manual') {
    state.watermarkText = $('watermark-text')?.value || state.watermarkText;
  } else {
    state.watermarkText = '';
  }
}

// ── Size guards ─────────────────────────────────────────────────────────
function checkFileSize(file, kind) {
  const mb = file.size / (1024 * 1024);
  const maxMB = kind === 'video' ? LIMITS.videoFileMB : LIMITS.imageFileMB;

  if (mb > maxMB) {
    const ok = confirm(
      `This ${kind} is ${mb.toFixed(0)} MB — larger than the recommended ${maxMB} MB.\n\n` +
      `Processing very large files may crash the browser tab.\n\nContinue anyway?`,
    );
    if (!ok) return false;
  } else if (mb > maxMB * 0.6) {
    // soft warning for 60–100% of the limit
    setAutoBadge('searching', `${kind} is ${mb.toFixed(0)} MB — this may take a while`);
  }
  return true;
}

function downscaleForDetection(imageData, maxSide) {
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
    x: h.x / scale, y: h.y / scale,
    width: h.width / scale, height: h.height / scale,
  }));
}

// ── Image handling ──────────────────────────────────────────────────────
async function onImage(file) {
  currentKind = 'image';
  currentFile = file;

  if (!checkFileSize(file, 'image')) return;

  if (state.stripMetadata) {
    try { file = await stripMetadata(file); } catch (e) { console.warn(e); }
  }
  const bitmap = await createImageBitmap(file);
  state.setImage(bitmap);

  // Show canvas, hide video
  canvasEl.style.display = '';
  videoEl.style.display = 'none';
  try { videoEl.pause(); } catch {}

  // Downscale for display if the source is enormous — keeps memory sane
  const maxSide = LIMITS.imageMaxSide;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const dispW = Math.round(bitmap.width * scale);
  const dispH = Math.round(bitmap.height * scale);

  canvasEl.width = dispW;
  canvasEl.height = dispH;
  canvasEl.getContext('2d').drawImage(bitmap, 0, 0, dispW, dispH);
  currentImageData = canvasEl.getContext('2d').getImageData(0, 0, dispW, dispH);

  if (scale < 0.95) {
    setAutoBadge('searching',
      `Downscaled ${bitmap.width}×${bitmap.height} → ${dispW}×${dispH} for processing`);
  }

  maskEditor.reset(dispW, dispH);
  overlayEl.style.pointerEvents = 'auto';

  ui.showStage();
  resetDownloadState();
  setDisabled('btnRemove', true);
  setDisabled('btnPreview', true);
  setHidden('back-to-video', true);
  setHidden('preview-badge', true);
  previewMode = false;
  hideSuggestion();
  clearBoxes();

  await runDetect();
}

// ── Video handling ──────────────────────────────────────────────────────
async function onVideo(file) {
  currentKind = 'video';
  currentFile = file;

  if (!checkFileSize(file, 'video')) return;

  if (currentVideoUrl) URL.revokeObjectURL(currentVideoUrl);
  currentVideoUrl = URL.createObjectURL(file);

  canvasEl.style.display = 'none';
  videoEl.style.display = '';
  maskEditor.disable();
  overlayEl.style.pointerEvents = 'none';

  ui.showStage();
  resetDownloadState();
  setDisabled('btnRemove', true);
  setDisabled('btnPreview', true);
  setHidden('back-to-video', true);
  setHidden('preview-badge', true);
  previewMode = false;
  hideSuggestion();
  clearBoxes();

  ui.busy(true);
  try {
    await loadVideo(videoEl, currentVideoUrl, 30000);

    // Duration warning
    if (videoEl.duration > LIMITS.videoMinutes * 60) {
      const mins = (videoEl.duration / 60).toFixed(1);
      setAutoBadge('searching',
        `${mins} min video — consider trimming to speed things up`);
    }

    // Resolution cap for processing
    if (videoEl.videoWidth > LIMITS.videoMaxSide) {
      setAutoBadge('searching',
        `Video is ${videoEl.videoWidth}px wide — output will be capped at ${LIMITS.videoMaxSide}px`);
    }

    const ts = $('trim-start'), te = $('trim-end'), to = $('trim-out');
    if (ts) { ts.min = 0; ts.max = videoEl.duration; ts.value = 0; }
    if (te) { te.min = 0; te.max = videoEl.duration; te.value = videoEl.duration; }
    if (to) to.textContent = `full (${videoEl.duration.toFixed(1)}s)`;

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

// ── Detection dispatcher ────────────────────────────────────────────────
async function runDetect() {
  const isVideo = currentKind === 'video';

  ui.busy(true);
  const label = mode === 'ai' ? 'AI scanning…' : (isVideo ? 'Scanning video…' : 'Scanning image…');
  setAutoBadge('searching', label);

  try {
    let hits = [];
    if (mode === 'ai') {
      hits = await runAIDetection();
    } else {
      hits = await runClassicDetection(isVideo);
    }

    currentHits = hits;

    if (!hits.length) {
      setAutoBadge('failed', 'No watermark found');
      hideSuggestion();
      clearBoxes();
      ui.renderCandidates([]);
      setDisabled('btnRemove', true);
      setDisabled('btnPreview', true);
      return;
    }

    setAutoBadge('found', `${hits.length} candidate${hits.length === 1 ? '' : 's'}`);
    showSuggestion(hits[0]);

    const W = isVideo ? videoEl.videoWidth : canvasEl.width;
    const H = isVideo ? videoEl.videoHeight : canvasEl.height;
    drawBoxes(hits, W, H);
    ui.renderCandidates(hits);

    if (!isVideo && hits[0]) maskEditor.loadMaskFromHit(hits[0]);
    setDisabled('btnRemove', false);
    setDisabled('btnPreview', false);
    ui.setDownloadEnabled(false);
  } catch (e) {
    console.error(e);
    setAutoBadge('failed', e.message || 'Detection failed');
  } finally {
    ui.busy(false);
    hideProgress();
  }
}

async function runClassicDetection(isVideo) {
  const isAuto = mode === 'auto';
  const text = isAuto ? '' : ($('watermark-text')?.value || '').trim();

  if (isVideo) {
    return detectInVideo(videoEl, { text, autoDetect: isAuto, onProgress: showProgress });
  }

  const { imageData: small, scale } = downscaleForDetection(currentImageData, 2048);
  const hitsSmall = await detectWorker.call(
    {
      imageData: small, text, autoDetect: isAuto,
      angleAuto: $('watermark-angle-auto')?.checked ?? true,
      angle: +($('watermark-angle')?.value ?? 0),
      tiled: $('watermark-tiled')?.checked ?? false,
      outline: $('watermark-outline')?.checked ?? false,
    },
    showProgress,
  );
  return upscaleHits(hitsSmall, scale);
}

async function runAIDetection() {
  if (!isAISupported()) throw new Error('AI not supported in this browser');

  const userPrompt = ($('ai-prompt')?.value || '').trim();
  const prompts = userPrompt
    ? userPrompt.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

  let source;
  if (currentKind === 'video') {
    const c = document.createElement('canvas');
    c.width = videoEl.videoWidth;
    c.height = videoEl.videoHeight;
    c.getContext('2d').drawImage(videoEl, 0, 0);
    source = c;
  } else {
    source = canvasEl;
  }

  return aiDetect(source, prompts, { onProgress: showProgress, threshold: 0.08 });
}

function setAutoBadge(kind, text) {
  const el = $('auto-badge');
  if (!el) return;
  el.classList.remove('searching', 'found', 'failed');
  el.classList.add(kind);
  const t = $('auto-badge-text');
  if (t) t.textContent = text;
}

// ── Removal ─────────────────────────────────────────────────────────────
async function onRemove() {
  if (!currentHits.length) return;
  if (previewMode) exitPreview();
  if (currentKind === 'video') return onRemoveVideo();
  return onRemoveImage();
}

async function onRemoveImage() {
  if (!currentImageData) return;
  ui.busy(true);
  ui.setDownloadEnabled(false);
  currentInpaintResult = null;
  currentVideoResult = null;

  try {
    let mask = maskEditor.toMask();
    if (state.safeMode && window.__faces?.length) {
      mask = new Float32Array(mask);
      carveOut(mask, currentImageData.width, currentImageData.height, window.__faces);
    }
    const result = await inpaintWorker.call(
      {
        imageData: currentImageData, mask,
        model: $('model')?.value ?? 'auto',
        colour: currentColour(),
        useAlphaInvert: ($('watermark-transparent')?.checked ?? true) && !!currentHits[0]?.suggested,
        postDenoise: $('post-denoise')?.checked ?? true,
        postSharpen: $('post-sharpen')?.checked ?? true,
      },
      showProgress,
    );

    currentInpaintResult = result;
    canvasEl.getContext('2d').putImageData(result, 0, 0);
    compareSlider.show(state.image, result);
    clearBoxes();
    ui.setDownloadEnabled(true);
  } catch (e) {
    console.error('Removal failed:', e);
    alert('Removal failed: ' + (e.message || e));
  } finally {
    ui.busy(false);
    hideProgress();
  }
}

async function onRemoveVideo() {
  ui.busy(true);
  ui.setDownloadEnabled(false);
  currentVideoResult = null;
  currentInpaintResult = null;

  try {
    const W = videoEl.videoWidth;
    const H = videoEl.videoHeight;
    const mask = buildMaskFromHits(currentHits, W, H, 5);
    currentMask = mask;

    const colour = currentColour();
    const duration = videoEl.duration;
    const { start, end } = readTrimRange(duration);
    const opts = readVideoOptions();

    const blob = await processVideo(videoEl, {
      mask, colour,
      trimStart: start, trimEnd: end,
      targetHeight: opts.targetHeight,
      bitrate: opts.bitrate,
      preferMp4: opts.preferMp4,
      maxSide: opts.maxSide,
      onProgress: showProgress,
    });

    currentVideoResult = blob;
    ui.setDownloadEnabled(true);
  } catch (e) {
    console.error('Video removal failed:', e);
    alert('Video processing failed: ' + (e.message || e));
  } finally {
    ui.busy(false);
    hideProgress();
  }
}

// ── Preview (NOT saved) ─────────────────────────────────────────────────
function enterPreview() {
  if (!currentHits.length) return;

  // For images: preview is just the mask overlay
  if (currentKind !== 'video') {
    maskEditor.loadMaskFromHit(currentHits[0]);
    return;
  }

  const W = videoEl.videoWidth;
  const H = videoEl.videoHeight;
  const mask = buildMaskFromHits(currentHits, W, H, 5);
  const colour = currentColour();

  // Render a cleaned frame on the canvas — purely visual
  const cleaned = previewCleanedFrame(videoEl, mask, colour);
  canvasEl.width = W;
  canvasEl.height = H;
  canvasEl.style.display = '';
  videoEl.style.display = 'none';
  canvasEl.getContext('2d').drawImage(cleaned, 0, 0);

  // Do NOT store as a result. Do NOT enable download.
  currentInpaintResult = null;
  currentVideoResult = null;
  ui.setDownloadEnabled(false);

  setHidden('back-to-video', false);
  setHidden('preview-badge', false);
  const badge = $('preview-badge');
  if (badge) badge.textContent = 'Preview · not saved';
  previewMode = true;

  showSuggestion(currentHits[0], 'Preview (not saved) — click "Remove watermark" to process the full video');
}

function exitPreview() {
  previewMode = false;
  setHidden('back-to-video', true);
  setHidden('preview-badge', true);
  canvasEl.style.display = 'none';
  videoEl.style.display = '';
  if (currentHits.length) {
    drawBoxes(currentHits, videoEl.videoWidth, videoEl.videoHeight);
    showSuggestion(currentHits[0]);
  }
}

// ── Download ────────────────────────────────────────────────────────────
function onDownload() {
  if (currentVideoResult) {
    const ext = currentVideoResult.type.includes('mp4') ? 'mp4' : 'webm';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(currentVideoResult);
    a.download = (currentFile?.name || 'video').replace(/\.[^.]+$/, '') + '_unstamped.' + ext;
    a.click();
    URL.revokeObjectURL(a.href);
    return;
  }

  if (currentInpaintResult) {
    const c = document.createElement('canvas');
    c.width = currentInpaintResult.width;
    c.height = currentInpaintResult.height;
    c.getContext('2d').putImageData(currentInpaintResult, 0, 0);
    c.toBlob((b) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      const baseName = (currentFile?.name || 'result').replace(/\.[^.]+$/, '');
      a.download = baseName + '_unstamped.png';
      a.click();
      URL.revokeObjectURL(a.href);
    }, 'image/png');
  }
}

async function onFile(file) {
  if (!file.type) { alert('Unknown file type.'); return; }
  if (file.type.startsWith('image/')) return onImage(file);
  if (file.type.startsWith('video/')) return onVideo(file);
  alert('Unsupported file type: ' + file.type);
}

function onPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  Object.assign(state, p);
  state.preset = name;
  persist();
  ui.syncFromState();
  const input = $('watermark-text');
  if (input) input.value = p.watermarkText || '';
  if (mode === 'auto' && p.watermarkText) setMode('manual');
}

// ── Boot ────────────────────────────────────────────────────────────────
const maskEditor = new MaskEditor(canvasEl, overlayEl);
maskEditor.bind();
const compareSlider = new CompareSlider($('compare'));
const palette = new CommandPalette($('palette'));
const ui = mountUI({ onFile, onDetect: runDetect, onRemove, onDownload, onPreset });

on('mode-auto', 'click', () => setMode('auto'));
on('mode-ai', 'click', () => setMode('ai'));
on('mode-manual', 'click', () => setMode('manual'));

on('suggestion-accept', 'click', () => {
  if (currentHits[0]?.suggested) {
    const input = $('watermark-text');
    if (input) input.value = currentHits[0].suggested;
    state.watermarkText = currentHits[0].suggested;
    setMode('manual');
  }
  hideSuggestion();
});
on('suggestion-dismiss', 'click', hideSuggestion);
on('suggestion-preview', 'click', enterPreview);
on('btnPreview', 'click', enterPreview);
on('back-to-video', 'click', exitPreview);

on('out-quality', 'change', applyQualityPreset);
on('out-bitrate', 'input', updateBitrateLabel);
applyQualityPreset();

function updateTrimLabel() {
  const s = +($('trim-start')?.value ?? 0);
  const e = +($('trim-end')?.value ?? 0);
  const d = videoEl.duration || 1;
  const out = $('trim-out');
  if (out) {
    out.textContent = (s <= 0.05 && e >= d - 0.05)
      ? `full (${d.toFixed(1)}s)`
      : `${s.toFixed(1)}s → ${e.toFixed(1)}s`;
  }
}
on('trim-start', 'input', (e) => {
  const endEl = $('trim-end');
  if (endEl && +e.target.value > +endEl.value) endEl.value = e.target.value;
  updateTrimLabel();
});
on('trim-end', 'input', (e) => {
  const startEl = $('trim-start');
  if (startEl && +e.target.value < +startEl.value) startEl.value = e.target.value;
  updateTrimLabel();
});

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
const batchBtn = $('btnBatch');
if (batchBtn) batchBtn.onclick = () => runBatch(state);

palette.register([
  { label: 'Detect watermark', hint: 'D', run: runDetect },
  { label: 'Remove watermark', hint: 'R', run: onRemove },
  { label: 'Preview clean frame', run: enterPreview },
  { label: 'Download result', run: onDownload },
  { label: 'Switch to Automatic mode', run: () => setMode('auto') },
  { label: 'Switch to AI mode', run: () => setMode('ai') },
  { label: 'Switch to Manual mode', run: () => setMode('manual') },
  { label: 'Clear mask', run: () => maskEditor.clear() },
  { label: 'Undo', hint: 'Ctrl+Z', run: () => maskEditor.undo() },
  { label: 'Redo', hint: 'Ctrl+Shift+Z', run: () => maskEditor.redo() },
  { label: 'Batch process…', run: () => runBatch(state) },
]);

window.addEventListener('resize', () => {
  if (!currentHits.length || previewMode) return;
  const W = currentKind === 'video' ? videoEl.videoWidth : canvasEl.width;
  const H = currentKind === 'video' ? videoEl.videoHeight : canvasEl.height;
  drawBoxes(currentHits, W, H);
});

setMode('auto');

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}