import { detectTextWatermark } from './detect/text.js';
import { detectStaticInVideo, detectCommonStrings } from './detect/auto.js';
import { detectGeneric } from './detect/generic.js';
import { alphaInvert } from './inpaint/alpha-invert.js';
import { cleanVideoWebCodecs, webCodecsSupported } from './video-clean.js';

// ── Load / frame grab ────────────────────────────────────────────────────
function loadVideo(video, url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Video load timed out (readyState=${video.readyState})`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('canplay', onReady);
      video.removeEventListener('error', onError);
    };
    const onReady = () => {
      if (video.readyState < 2) return;
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      const c = { 1: 'ABORTED', 2: 'NETWORK', 3: 'DECODE', 4: 'SRC_NOT_SUPPORTED' };
      reject(new Error(`Video load failed: ${c[video.error?.code] || 'unknown'}`));
    };
    video.addEventListener('loadeddata', onReady);
    video.addEventListener('canplay', onReady);
    video.addEventListener('error', onError);
    video.src = url;
    video.load();
  });
}

async function grabFrame(video) {
  try {
    await video.play();
    await new Promise((r) => setTimeout(r, 150));
    video.pause();
    await new Promise((r) => requestAnimationFrame(r));
  } catch (e) {
    throw new Error('Cannot play video: ' + e.message);
  }
}

// ── Detect-only ──────────────────────────────────────────────────────────
export async function detectInVideo(video, opts = {}) {
  const { text = '', autoDetect = true, onProgress = () => {}, signal } = opts;
  const W = video.videoWidth;
  const H = video.videoHeight;
  const duration = video.duration;
  if (!W || !H || !isFinite(duration)) throw new Error('Invalid video');

  const sample = document.createElement('canvas');
  sample.width = W;
  sample.height = H;
  const sampleCtx = sample.getContext('2d', { willReadFrequently: true });
  sampleCtx.drawImage(video, 0, 0, W, H);
  const sampleData = sampleCtx.getImageData(0, 0, W, H);

  let hits = [];

  if (text && text.trim()) {
    onProgress('detect', 0.1, `Searching for "${text}"`);
    hits = detectTextWatermark(sampleData, text, {
      angle: null,
      outline: false,
      onProgress: (_, pct, detail) => onProgress('detect', pct * 0.9, detail),
    });
    hits.forEach((h) => { h.suggested = text; });
  } else if (autoDetect) {
    try {
      onProgress('detect', 0.05, 'Sampling frames…');
      hits = await detectStaticInVideo(video, {
        sampleCount: Math.min(20, Math.max(5, Math.floor(duration))),
        onProgress: (_, pct, detail) => onProgress('detect', 0.05 + pct * 0.55, detail),
        signal,
      });
      hits.forEach((h) => { h.suggested = 'static overlay'; });
    } catch (e) {
      console.warn('Static detection failed:', e);
    }
    if (!hits.length) {
      onProgress('detect', 0.6, 'Checking common watermarks…');
      hits.push(...detectCommonStrings(sampleData, {
        onProgress: (_, pct, detail) => onProgress('detect', 0.6 + pct * 0.3, detail),
        signal,
      }));
    }
    if (!hits.length) {
      onProgress('detect', 0.9, 'Scanning for logos…');
      hits.push(...detectGeneric(sampleData).map((h) => ({
        ...h, region: 'blob', suggested: 'logo',
      })));
    }
  }

  hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  onProgress('detect', 1,
    hits.length ? `Found ${hits.length} candidate${hits.length === 1 ? '' : 's'}` : 'Nothing found');
  return hits.slice(0, 10);
}

// ── Preview: clean one frame ─────────────────────────────────────────────
export function previewCleanedFrame(video, mask, colour = null) {
  const W = video.videoWidth;
  const H = video.videoHeight;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, W, H);
  const data = ctx.getImageData(0, 0, W, H);
  ctx.putImageData(alphaInvert(data, mask, { colour }), 0, 0);
  return c;
}

// ── Full processing ──────────────────────────────────────────────────────
export async function processVideo(video, opts = {}) {
  const {
    mask, colour = null,
    trimStart = 0, trimEnd = null,
    targetHeight = null, bitrate = 3_000_000,
    framerate = 30, preferMp4 = true,
    onProgress = () => {}, signal,
  } = opts;

  if (preferMp4 && await webCodecsSupported()) {
    try {
      return await cleanVideoWebCodecs(video, {
        mask, colour, trimStart, trimEnd,
        targetHeight, bitrate, framerate,
        onProgress, signal,
      });
    } catch (e) {
      console.warn('WebCodecs failed, falling back to MediaRecorder:', e);
    }
  }

  return processVideoMediaRecorder(video, {
    mask, colour, bitrate, onProgress, signal,
  });
}

async function processVideoMediaRecorder(video, opts) {
  const { mask, colour = null, bitrate = 3_000_000, onProgress = () => {}, signal } = opts;
  const W = video.videoWidth;
  const H = video.videoHeight;
  const duration = video.duration;

  const sample = document.createElement('canvas');
  sample.width = W;
  sample.height = H;
  const sampleCtx = sample.getContext('2d', { willReadFrequently: true });

  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const outCtx = out.getContext('2d');

  const stream = out.captureStream(30);
  try {
    const vs = video.captureStream?.() || video.mozCaptureStream?.();
    if (vs) for (const t of vs.getAudioTracks()) stream.addTrack(t);
  } catch {}

  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
    ? 'video/webm;codecs=vp9,opus'
    : 'video/webm';

  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise((r) => { recorder.onstop = () => r(new Blob(chunks, { type: 'video/webm' })); });

  video.currentTime = 0;
  await new Promise((r) => setTimeout(r, 250));
  recorder.start(1000);
  await video.play();

  let frames = 0;
  const estTotal = Math.max(30, Math.ceil(duration * 30));

  const tick = () => {
    if (video.paused || video.ended) return;
    if (signal?.aborted) { video.pause(); return; }
    sampleCtx.drawImage(video, 0, 0, W, H);
    const data = sampleCtx.getImageData(0, 0, W, H);
    outCtx.putImageData(alphaInvert(data, mask, { colour }), 0, 0);
    frames++;
    if (frames % 15 === 0) {
      onProgress('video', Math.min(0.95, frames / estTotal),
        `Frame ${frames} · ${video.currentTime.toFixed(1)}s`);
    }
    video.requestVideoFrameCallback(tick);
  };
  video.requestVideoFrameCallback(tick);

  await new Promise((r) => { video.onended = r; });
  await new Promise((r) => setTimeout(r, 300));
  recorder.stop();
  const blob = await done;
  onProgress('video', 1, 'Done');
  return blob;
}

export { loadVideo, grabFrame };