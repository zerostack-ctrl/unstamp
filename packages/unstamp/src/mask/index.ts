import type { Detection } from '../types.js';

export interface BuildMaskOptions {
  feather?: number;
  dilate?: number;
}

export function buildMask(
  detections: Detection[],
  size: { width: number; height: number },
  opts: BuildMaskOptions = {},
): Float32Array {
  const { width: W, height: H } = size;
  const dilate = opts.dilate ?? 3;
  const feather = opts.feather ?? 2;
  const raw = new Uint8Array(W * H);

  for (const d of detections) {
    const x0 = Math.max(0, Math.floor(d.x - dilate));
    const y0 = Math.max(0, Math.floor(d.y - dilate));
    const x1 = Math.min(W, Math.ceil(d.x + d.width + dilate));
    const y1 = Math.min(H, Math.ceil(d.y + d.height + dilate));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (d.angle === 0) {
          raw[y * W + x] = 1;
        } else {
          const cx = d.x + d.width / 2;
          const cy = d.y + d.height / 2;
          const a = (-d.angle * Math.PI) / 180;
          const dx = x - cx; const dy = y - cy;
          const rx = dx * Math.cos(a) - dy * Math.sin(a);
          const ry = dx * Math.sin(a) + dy * Math.cos(a);
          if (
            Math.abs(rx) <= d.width / 2 + dilate &&
            Math.abs(ry) <= d.height / 2 + dilate
          ) {
            raw[y * W + x] = 1;
          }
        }
      }
    }
  }

  if (feather === 0) {
    const out = new Float32Array(W * H);
    for (let i = 0; i < out.length; i++) out[i] = raw[i]!;
    return out;
  }

  const tmp = new Float32Array(W * H);
  const out = new Float32Array(W * H);
  const r = feather;
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < H; y++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += raw[y * W + Math.min(W - 1, Math.max(0, x))]!;
    for (let x = 0; x < W; x++) {
      tmp[y * W + x] = sum * inv;
      sum += raw[y * W + Math.min(W - 1, x + r + 1)]! - raw[y * W + Math.max(0, x - r)]!;
    }
  }
  for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(H - 1, Math.max(0, y)) * W + x]!;
    for (let y = 0; y < H; y++) {
      out[y * W + x] = sum * inv;
      sum += tmp[Math.min(H - 1, y + r + 1) * W + x]! - tmp[Math.max(0, y - r) * W + x]!;
    }
  }
  return out;
}

export function carveOut(
  mask: Float32Array,
  size: { width: number; height: number },
  regions: Array<{ x: number; y: number; width: number; height: number }>,
  padding = 0,
): void {
  const { width: W, height: H } = size;
  for (const r of regions) {
    const x0 = Math.max(0, r.x - padding);
    const y0 = Math.max(0, r.y - padding);
    const x1 = Math.min(W, r.x + r.width + padding);
    const y1 = Math.min(H, r.y + r.height + padding);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) mask[y * W + x] = 0;
  }
}
