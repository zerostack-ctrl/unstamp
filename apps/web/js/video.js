import { detectTextWatermark } from './detect/text.js';
import { detectStaticInVideo, detectCommonStrings } from './detect/auto.js';
import { detectGeneric } from './detect/generic.js';
import { alphaInvert } from './inpaint/alpha-invert.js';

// ── Robust helpers ───────────────────────────────────────────────────────
function createVideoElement() {
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.style.position = 'fixed';
  video.style.left = '-9999px';
  video.style.width = '2px';
  video.style.height = '2px';
  video.style.opacity = '0.01';
  document.body.appendChild(video);
  return video;
}

function loadVideo(video, url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(
        `Video load timed out after ${timeoutMs / 1000}s ` +
        `(readyState=${video.readyState}, networkState=${video.networkState})`,
      ));
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
      const codes = { 1: 'ABORTED', 2: 'NETWORK', 3: 'DECODE', 4: 'SRC_NOT_SUPPORTED' };
      reject(new Error(
        `Video load failed: ${codes[video.error?.code] || 'unknown'} ` +
        `(${video.error?.message || 'no message'})`,
      ));
    };

    video.addEventListener('loadeddata', onReady);
    video.addEventListener('canplay', onReady);
    video.addEventListener('error', onError);

    video.src = url;
    video.load();
  });
}

/**
 * Grab a real, decoded frame from the video.
 * Instead of seeking (which fails silently on some blob URLs), we play
 * for a moment, pause, and read whatever frame the decoder just produced.
 */
async function grabFrame(video, canvas, ctx) {
  try {
    // Some browsers won't produce a valid frame until play() actually
    // advances the pipeline.
    await video.play();
    await new Promise((r) => setTimeout(r, 120));
    video.pause();
    // Give the compositor one frame
    await new Promise((r) => requestAnimationFrame(r));
  } catch (e) {
    throw new Error('Cannot play video: ' + e.message);
  }

  const W = video.videoWidth;
  const H = video.videoHeight;
  canvas.width = W;
  canvas.height = H;
  ctx.drawImage(video, 0, 0, W, H);

  // Sanity check: is the frame black?
  const data = ctx.getImageData(0, 0, Math.min(64, W), Math.min(64, H)).data;
  let brightness = 0;
  for (let i = 0; i < data.length; i += 4) {
    brightness += data[i] + data[i + 1] + data[i + 2];
  }
  brightness /= (data.length / 4) * 3;
  if (brightness < 3) {
    console.warn('[unstamp] sampled frame looks black — retrying once');
    await new Promise((r) => setTimeout(r, 300));
    ctx.drawImage(video, 0, 0, W, H);
  }
}

// ── Main entry ───────────────────────────────────────────────────────────
export async function processVideo(file, opts = {}) {
  const {
    text = '',
    colour = null,
    autoDetect = true,
    onProgress = () => {},
    signal,
  } = opts;

  const url = URL.createObjectURL(file);
  const video = createVideoElement();

  try {
    // ── 1. Load ──────────────────────────────────────────────────────────
    onProgress('video', 0.01, 'Loading video');
    await loadVideo(video, url, 30000);

    const W = video.videoWidth;
    const H = video.videoHeight;
    const duration = video.duration;
    if (!W || !H || !isFinite(duration) || duration <= 0) {
      throw new Error(`Invalid video (${W}×${H}, duration=${duration})`);
    }

    // Codec sanity check
    if (file.type && video.canPlayType(file.type) === '') {
      console.warn('[unstamp] browser reports it cannot play:', file.type);
    }

    onProgress('video', 0.03, `Loaded ${W}×${H}, ${duration.toFixed(1)}s`);

    // ── 2. Grab a sample frame ───────────────────────────────────────────
    onProgress('video', 0.04, 'Sampling first frame');
    const sample = document.createElement('canvas');
    const sampleCtx = sample.getContext('2d', { willReadFrequently: true });
    await grabFrame(video, sample, sampleCtx);
    const sampleData = sampleCtx.getImageData(0, 0, W, H);

    onProgress('video', 0.06, 'Frame captured');

    // ── 3. Detect ────────────────────────────────────────────────────────
    let hits = [];

    if (text && text.trim()) {
      onProgress('video', 0.07, `Searching for "${text}"`);
      hits = detectTextWatermark(sampleData, text, {
        angle: null,
        outline: false,
        onProgress: (_, pct, detail) =>
          onProgress('video', 0.07 + pct * 0.04, detail),
      });
    } else if (autoDetect) {
      try {
        onProgress('video', 0.07, 'Auto-detecting (sampling frames)');
        hits = await detectStaticInVideo(video, {
          sampleCount: Math.min(20, Math.max(5, Math.floor(duration))),
          onProgress: (_, pct, detail) =>
            onProgress('video', 0.07 + pct * 0.06, detail),
          signal,
        });
      } catch (e) {
        console.warn('Static detection failed:', e);
      }

      if (!hits.length) {
        onProgress('video', 0.13, 'No static region — trying common strings');
        hits = detectCommonStrings(sampleData, {
          onProgress: (_, pct, detail) =>
            onProgress('video', 0.13 + pct * 0.04, detail),
          signal,
        });
      }

      if (!hits.length) {
        onProgress('video', 0.17, 'Trying blob detector');
        hits = detectGeneric(sampleData).map((h) => ({ ...h, region: 'blob' }));
      }
    } else {
      throw new Error('No watermark text given and auto-detect is disabled');
    }

    if (!hits.length) throw new Error('Could not find a watermark in this video');

    const best = hits[0];
    onProgress('video', 0.2,
      `Removing region at ${Math.round(best.x)},${Math.round(best.y)} ` +
      `(${Math.round(best.width)}×${Math.round(best.height)})`);

    // ── 4. Build mask ────────────────────────────────────────────────────
    const mask = new Float32Array(W * H);
    const x0 = Math.max(0, Math.round(best.x));
    const y0 = Math.max(0, Math.round(best.y));
    const x1 = Math.min(W, Math.round(best.x + best.width));
    const y1 = Math.min(H, Math.round(best.y + best.height));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) mask[y * W + x] = 1;
    }

    // ── 5. Output canvas + recorder ──────────────────────────────────────
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const outCtx = out.getContext('2d');

    const stream = out.captureStream(30);
    try {
      const vs = video.captureStream?.() || video.mozCaptureStream?.();
      if (vs) for (const t of vs.getAudioTracks()) stream.addTrack(t);
    } catch { /* no audio */ }

    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
        ? 'video/webm;codecs=vp8,opus'
        : 'video/webm';

    const recorder = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: 8_000_000,
    });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

    const recordingDone = new Promise((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
    });

    // ── 6. Reset to start and record ─────────────────────────────────────
    video.currentTime = 0;
    await new Promise((r) => setTimeout(r, 200));

    recorder.start(1000);
    await video.play();

    let frames = 0;
    const estTotal = Math.max(30, Math.ceil(duration * 30));

    const processFrame = () => {
      if (video.paused || video.ended) return;
      if (signal?.aborted) { video.pause(); return; }

      sampleCtx.drawImage(video, 0, 0, W, H);
      const frameData = sampleCtx.getImageData(0, 0, W, H);
      const cleaned = alphaInvert(frameData, mask, { colour });
      outCtx.putImageData(cleaned, 0, 0);

      frames++;
      if (frames % 15 === 0) {
        const pct = 0.25 + (frames / estTotal) * 0.7;
        onProgress(
          'video',
          Math.min(pct, 0.95),
          `Frame ${frames} · ${video.currentTime.toFixed(1)}s / ${duration.toFixed(1)}s`,
        );
      }

      if (video.requestVideoFrameCallback) {
        video.requestVideoFrameCallback(processFrame);
      } else {
        requestAnimationFrame(processFrame);
      }
    };

    if (video.requestVideoFrameCallback) {
      video.requestVideoFrameCallback(processFrame);
    } else {
      requestAnimationFrame(processFrame);
    }

    await new Promise((resolve) => { video.onended = resolve; });
    await new Promise((r) => setTimeout(r, 300));
    recorder.stop();
    const blob = await recordingDone;

    onProgress('video', 1, 'Done');
    return blob;
  } finally {
    try { video.pause(); } catch {}
    video.remove();
    URL.revokeObjectURL(url);
  }
}