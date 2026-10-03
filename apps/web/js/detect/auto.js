import { detectTextWatermark } from './text.js';
import { detectGeneric } from './generic.js';

// ── Common watermark strings ─────────────────────────────────────────────
export const COMMON_TEXTS = [
  '@', 'subscribe', 'Subscribe', 'SUBSCRIBE',
  'support', 'Support', 'SUPPORT',
  'follow', 'Follow', 'FOLLOW',
  'like', 'share', 'channel', 'Channel',
  'www.', 'http', 'https',
  'tiktok', 'youtube', 'instagram', 'facebook', 'twitter',
  'patreon', 'discord', 'telegram', 'whatsapp',
];

// ── Helpers ──────────────────────────────────────────────────────────────
function toGrayFloat(imageData) {
  const { data, width, height } = imageData;
  const g = new Float32Array(width * height);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) {
    g[i] = (0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2]) / 255;
  }
  return g;
}

function dilate(mask, W, H, r) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let dy = -r; dy <= r && !v; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= H) continue;
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= W) continue;
          if (mask[ny * W + nx]) { v = 1; break; }
        }
      }
      out[y * W + x] = v;
    }
  }
  return out;
}

function erode(mask, W, H, r) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let all = 1;
      for (let dy = -r; dy <= r && all; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= H) { all = 0; break; }
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= W) { all = 0; break; }
          if (!mask[ny * W + nx]) { all = 0; break; }
        }
      }
      out[y * W + x] = all;
    }
  }
  return out;
}

function connectedComponents(mask, W, H, minArea) {
  const visited = new Uint8Array(mask.length);
  const boxes = [];
  const stack = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!mask[i] || visited[i]) continue;
      stack.length = 0;
      stack.push(i);
      let minX = x, maxX = x, minY = y, maxY = y, count = 0;
      while (stack.length) {
        const j = stack.pop();
        if (visited[j]) continue;
        visited[j] = 1;
        count++;
        const jy = (j / W) | 0;
        const jx = j % W;
        if (jx < minX) minX = jx;
        if (jx > maxX) maxX = jx;
        if (jy < minY) minY = jy;
        if (jy > maxY) maxY = jy;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = jx + dx, ny = jy + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const k = ny * W + nx;
          if (mask[k] && !visited[k]) stack.push(k);
        }
      }
      if (count >= minArea) {
        boxes.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, area: count });
      }
    }
  }
  return boxes;
}

function edgeDensity(gray, W, H, box) {
  let edges = 0, total = 0;
  for (let y = box.y + 1; y < box.y + box.h - 1; y++) {
    for (let x = box.x + 1; x < box.x + box.w - 1; x++) {
      const i = y * W + x;
      const gx = Math.abs(gray[i + 1] - gray[i - 1]);
      const gy = Math.abs(gray[i + W] - gray[i - W]);
      if (gx + gy > 0.08) edges++;
      total++;
    }
  }
  return total ? edges / total : 0;
}

// ── Common-string prefilter ──────────────────────────────────────────────
// Runs the text detector against every COMMON_TEXT at coarse angle/scale.
// Fast enough for one image; for videos, use only after temporal invariance
// fails.
export function detectCommonStrings(imageData, opts = {}) {
  const { onProgress = () => {}, signal } = opts;
  const hits = [];
  const total = COMMON_TEXTS.length;

  for (let i = 0; i < total; i++) {
    if (signal?.aborted) break;
    const text = COMMON_TEXTS[i];
    onProgress('detect', (i / total) * 0.8, `Trying "${text}"`);
    try {
      const found = detectTextWatermark(imageData, text, {
        angle: null,
        coarseAngle: 15,                 // coarse — we only need rough candidates
        scaleRange: [0.7, 1.6, 0.3],     // 4 scales only
        onProgress: () => {},
      });
      for (const h of found) {
        if (h.score > 0.22) hits.push({ ...h, matchedText: text, region: 'common' });
      }
    } catch { /* skip individual failures */ }
  }

  hits.sort((a, b) => b.score - a.score);
  onProgress('detect', 1, `Matched ${hits.length} string${hits.length === 1 ? '' : 's'}`);
  return hits.slice(0, 10);
}

// ── Video: temporal invariance ───────────────────────────────────────────
/**
 * Detects watermarks by sampling frames and finding pixels that don't move.
 * Anything that stays fixed in the exact same place while the scene changes
 * is almost certainly a watermark.
 *
 * Returns an array of {x, y, width, height, score, region: 'static'}.
 */
export async function detectStaticInVideo(video, opts = {}) {
  const {
    sampleCount,
    workingSide = 512,
    staticThreshold = 0.03,
    minArea = 30,
    maxAreaFrac = 0.15,
    cornerBonus = 0.5,
    onProgress = () => {},
    signal,
  } = opts;

  const W = video.videoWidth;
  const H = video.videoHeight;
  const duration = video.duration;
  if (!W || !H || !isFinite(duration)) throw new Error('Invalid video');

  const count = sampleCount ?? Math.min(30, Math.max(5, Math.floor(duration)));

  // Working resolution — small for speed
  const scale = Math.min(1, workingSide / Math.max(W, H));
  const wW = Math.max(1, Math.round(W * scale));
  const wH = Math.max(1, Math.round(H * scale));

  const canvas = document.createElement('canvas');
  canvas.width = wW;
  canvas.height = wH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  // Sample N frames evenly across the video
  const grays = [];
  const originalTime = video.currentTime;
  for (let i = 0; i < count; i++) {
    if (signal?.aborted) throw new Error('Aborted');
    const t = ((i + 0.5) / count) * duration;
    video.currentTime = Math.min(t, duration - 0.05);
    await new Promise((resolve) => { video.onseeked = resolve; });
    ctx.drawImage(video, 0, 0, wW, wH);
    const img = ctx.getImageData(0, 0, wW, wH);
    grays.push(toGrayFloat(img));
    onProgress('detect', ((i + 1) / count) * 0.5,
      `Sampling frame ${i + 1}/${count}`);
  }

  // Restore original time
  video.currentTime = originalTime;

  // Per-pixel mean and standard deviation
  const N = grays.length;
  const mean = new Float32Array(wW * wH);
  for (const g of grays) for (let i = 0; i < mean.length; i++) mean[i] += g[i];
  for (let i = 0; i < mean.length; i++) mean[i] /= N;

  const std = new Float32Array(wW * wH);
  for (const g of grays) for (let i = 0; i < std.length; i++) {
    const d = g[i] - mean[i];
    std[i] += d * d;
  }
  for (let i = 0; i < std.length; i++) std[i] = Math.sqrt(std[i] / N);

  onProgress('detect', 0.6, 'Finding static pixels');

  // Pixels with low temporal variance = static
  const mask = new Uint8Array(wW * wH);
  for (let i = 0; i < mask.length; i++) mask[i] = std[i] < staticThreshold ? 1 : 0;

  // Morphological close: dilate to unify text blobs, then erode back
  const dilated = dilate(mask, wW, wH, 2);
  const closed = erode(dilated, wW, wH, 1);

  onProgress('detect', 0.75, 'Clustering regions');
  const boxes = connectedComponents(closed, wW, wH, minArea);

  // Filter out letterboxing, large static backgrounds, thin lines
  const filtered = boxes.filter((b) => {
    const areaFrac = (b.w * b.h) / (wW * wH);
    if (areaFrac > maxAreaFrac) return false;
    if (b.w < 8 || b.h < 8) return false;
    const aspect = b.w / b.h;
    if (aspect > 15 || aspect < 0.06) return false;
    const touchesTop = b.y <= 2;
    const touchesBottom = b.y + b.h >= wH - 2;
    const touchesLeft = b.x <= 2;
    const touchesRight = b.x + b.w >= wW - 2;
    // Reject if it spans the full frame in either axis (letterbox)
    if ((touchesTop && touchesBottom) || (touchesLeft && touchesRight)) return false;
    return true;
  });

  onProgress('detect', 0.9, `Ranking ${filtered.length} region${filtered.length === 1 ? '' : 's'}`);

  // Score: corner proximity + edge density (text-likeness)
  const scored = filtered.map((b) => {
    const cx = (b.x + b.w / 2) / wW;
    const cy = (b.y + b.h / 2) / wH;
    const cornerDist = Math.min(
      Math.hypot(cx - 0.85, cy - 0.9),
      Math.hypot(cx - 0.15, cy - 0.9),
      Math.hypot(cx - 0.85, cy - 0.15),
      Math.hypot(cx - 0.15, cy - 0.15),
    );
    const edge = edgeDensity(grays[0], wW, wH, b);
    const cornerScore = 1 - Math.min(1, cornerDist);
    const score = cornerScore * cornerBonus + edge * (1 - cornerBonus);
    return { ...b, score, edge };
  });

  scored.sort((a, b) => b.score - a.score);

  // Upscale boxes back to original resolution
  const inv = 1 / scale;
  const hits = scored.slice(0, 6).map((b) => ({
    x: Math.round(b.x * inv),
    y: Math.round(b.y * inv),
    width: Math.round(b.w * inv),
    height: Math.round(b.h * inv),
    angle: 0,
    scale: 1,
    score: b.score,
    edge: b.edge,
    region: 'static',
  }));

  onProgress('detect', 1,
    `Found ${hits.length} static region${hits.length === 1 ? '' : 's'}`);
  return hits;
}

// ── Image: combined auto-detect ──────────────────────────────────────────
/**
 * Auto-detect watermarks in a single image.
 * Tries common strings first, then falls back to generic blob detection.
 */
export async function detectInImage(imageData, opts = {}) {
  const { onProgress = () => {}, signal } = opts;

  onProgress('detect', 0.05, 'Scanning for common watermarks');
  const common = detectCommonStrings(imageData, {
    onProgress: (_, pct, detail) => onProgress('detect', pct * 0.7, detail),
    signal,
  });

  onProgress('detect', 0.75, 'Scanning for blob-shaped watermarks');
  const blobs = detectGeneric(imageData).map((b) => ({ ...b, region: 'blob' }));

  const all = [...common, ...blobs];
  // Deduplicate overlapping boxes (keep the higher-scored one)
  const kept = [];
  for (const h of all) {
    const overlaps = kept.some((k) => {
      const ix = Math.max(0, Math.min(h.x + h.width, k.x + k.width) - Math.max(h.x, k.x));
      const iy = Math.max(0, Math.min(h.y + h.height, k.y + k.height) - Math.max(h.y, k.y));
      const inter = ix * iy;
      const union = h.width * h.height + k.width * k.height - inter;
      return union > 0 && inter / union > 0.4;
    });
    if (!overlaps) kept.push(h);
  }
  kept.sort((a, b) => b.score - a.score);
  onProgress('detect', 1, `Found ${kept.length} candidate${kept.length === 1 ? '' : 's'}`);
  return kept.slice(0, 10);
}