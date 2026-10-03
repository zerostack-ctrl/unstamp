import { ncc } from './fft.js';
import type { Detection } from '../types.js';

export interface MaskShape { mask: Float32Array; w: number; h: number; }

export function renderTextMask(
  text: string, fontSize = 48,
  font = 'bold Arial', outline = false,
): MaskShape {
  const c =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(1, 1)
      : document.createElement('canvas');
  const ctx = (c as HTMLCanvasElement).getContext('2d')!;
  ctx.font = `${fontSize}px ${font}`;
  const m = ctx.measureText(text);
  const pad = Math.ceil(fontSize * 0.4);
  c.width = Math.ceil(m.width) + pad * 2;
  c.height = Math.ceil(fontSize * 1.4) + pad * 2;
  ctx.font = `${fontSize}px ${font}`;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  if (outline) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = Math.max(2, fontSize * 0.06);
    ctx.strokeText(text, pad, c.height / 2);
  }
  ctx.fillText(text, pad, c.height / 2);
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  const mask = new Float32Array(c.width * c.height);
  for (let i = 0, j = 3; i < mask.length; i++, j += 4) mask[i] = data[j]! / 255;
  return { mask, w: c.width, h: c.height };
}

export function rotateMask(shape: MaskShape, angleDeg: number): MaskShape {
  const { mask, w, h } = shape;
  const a = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(a); const sin = Math.sin(a);
  const cx = w / 2; const cy = h / 2;
  const nw = Math.ceil(Math.abs(w * cos) + Math.abs(h * sin));
  const nh = Math.ceil(Math.abs(w * sin) + Math.abs(h * cos));
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const dx = x - nw / 2; const dy = y - nh / 2;
      const sx = cos * dx + sin * dy + cx;
      const sy = -sin * dx + cos * dy + cy;
      if (sx < 0 || sy < 0 || sx >= w - 1 || sy >= h - 1) continue;
      const x0 = sx | 0; const y0 = sy | 0;
      const fx = sx - x0; const fy = sy - y0;
      out[y * nw + x] =
        mask[y0 * w + x0]! * (1 - fx) * (1 - fy) +
        mask[y0 * w + x0 + 1]! * fx * (1 - fy) +
        mask[(y0 + 1) * w + x0]! * (1 - fx) * fy +
        mask[(y0 + 1) * w + x0 + 1]! * fx * fy;
    }
  }
  return { mask: out, w: nw, h: nh };
}

export function scaleMask(shape: MaskShape, s: number): MaskShape {
  const { mask, w, h } = shape;
  const nw = Math.max(4, Math.round(w * s));
  const nh = Math.max(4, Math.round(h * s));
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const sy = y / s; const y0 = sy | 0; const fy = sy - y0;
    for (let x = 0; x < nw; x++) {
      const sx = x / s; const x0 = sx | 0; const fx = sx - x0;
      out[y * nw + x] =
        mask[y0 * w + x0]! * (1 - fx) * (1 - fy) +
        mask[y0 * w + x0 + 1]! * fx * (1 - fy) +
        mask[(y0 + 1) * w + x0]! * (1 - fx) * fy +
        mask[(y0 + 1) * w + x0 + 1]! * fx * fy;
    }
  }
  return { mask: out, w: nw, h: nh };
}

export function toGray(imageData: ImageData): Float32Array {
  const { data, width, height } = imageData;
  const g = new Float32Array(width * height);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) {
    g[i] = (0.299 * data[j]! + 0.587 * data[j + 1]! + 0.114 * data[j + 2]!) / 255;
  }
  return g;
}

export function highPass(
  gray: Float32Array, w: number, h: number, radius = 15,
): Float32Array {
  const blurred = boxBlur(gray, w, h, radius);
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = gray[i]! - blurred[i]!;
  return out;
}

function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[y * w + Math.min(w - 1, Math.max(0, x))]!;
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum * inv;
      sum += src[y * w + Math.min(w - 1, x + r + 1)]! - src[y * w + Math.max(0, x - r)]!;
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]!;
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum * inv;
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x]! - tmp[Math.max(0, y - r) * w + x]!;
    }
  }
  return out;
}

export interface TextDetectOptions {
  angle?: number | null;
  outline?: boolean;
  coarseAngle?: number;
  scaleRange?: [number, number, number];
}

export function detectTextWatermark(
  imageData: ImageData,
  text: string,
  opts: TextDetectOptions = {},
): Detection[] {
  const { width: W, height: H } = imageData;
  const residual = highPass(toGray(imageData), W, H, 15);
  const angles =
    opts.angle != null ? [opts.angle] : range(-60, 60, opts.coarseAngle ?? 5);
  const scales = opts.scaleRange
    ? range(opts.scaleRange[0], opts.scaleRange[1], opts.scaleRange[2])
    : range(0.6, 1.8, 0.2);
  const base = renderTextMask(text, 48, 'bold Arial', opts.outline);
  const hits: Detection[] = [];

  for (const a of angles) {
    for (const s of scales) {
      const t = rotateMask(scaleMask(base, s), a);
      if (t.w >= W || t.h >= H) continue;
      const { x, y, score } = ncc(residual, W, H, t.mask, t.w, t.h);
      if (score > 0.15) {
        hits.push({
          x, y, width: t.w, height: t.h,
          angle: a, scale: s, score, region: 'text',
        });
      }
    }
  }

  hits.sort((p, q) => q.score - p.score);
  const best = hits[0];
  if (best) {
    for (let a = best.angle - 4; a <= best.angle + 4; a += 1) {
      for (let s = best.scale - 0.15; s <= best.scale + 0.15; s += 0.05) {
        const t = rotateMask(scaleMask(base, s), a);
        if (t.w >= W || t.h >= H) continue;
        const { x, y, score } = ncc(residual, W, H, t.mask, t.w, t.h);
        if (score > best.score) {
          hits.unshift({
            x, y, width: t.w, height: t.h,
            angle: a, scale: s, score, region: 'text',
          });
        }
      }
    }
  }

  return hits.slice(0, 10).sort((p, q) => q.score - p.score);
}

function range(a: number, b: number, step: number): number[] {
  const out: number[] = [];
  for (let v = a; v <= b + 1e-9; v += step) out.push(+v.toFixed(4));
  return out;
}