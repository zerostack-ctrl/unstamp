import { ncc } from './fft.js';
import { toGray, highPass, rotateMask, scaleMask } from './text.js';
import type { Detection } from '../types.js';

export function detectTemplate(
  imageData: ImageData,
  templateBitmap: ImageBitmap | HTMLCanvasElement,
  opts: { angle?: number | null; scales?: number[] } = {},
): Detection[] {
  const { width: W, height: H } = imageData;
  const residual = highPass(toGray(imageData), W, H, 15);

  const tc =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(1, 1)
      : document.createElement('canvas');
  const tw = (templateBitmap as ImageBitmap).width ?? (templateBitmap as HTMLCanvasElement).width;
  const th = (templateBitmap as ImageBitmap).height ?? (templateBitmap as HTMLCanvasElement).height;
  tc.width = tw; tc.height = th;
  const ctx = (tc as HTMLCanvasElement).getContext('2d')!;
  ctx.drawImage(templateBitmap as any, 0, 0);
  const tdata = ctx.getImageData(0, 0, tw, th);
  const base = new Float32Array(tw * th);
  for (let i = 0, j = 0; i < base.length; i++, j += 4) {
    const l = (0.299 * tdata.data[j]! + 0.587 * tdata.data[j + 1]! + 0.114 * tdata.data[j + 2]!) / 255;
    const a = tdata.data[j + 3]! / 255;
    base[i] = l * a;
  }
  const baseObj = { mask: base, w: tw, h: th };

  const angles = opts.angle != null ? [opts.angle] : [-45, -30, -15, 0, 15, 30, 45];
  const scales = opts.scales ?? [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
  const hits: Detection[] = [];

  for (const a of angles) {
    for (const s of scales) {
      const t = rotateMask(scaleMask(baseObj, s), a);
      if (t.w >= W || t.h >= H) continue;
      const { x, y, score } = ncc(residual, W, H, t.mask, t.w, t.h);
      if (score > 0.15) {
        hits.push({
          x, y, width: t.w, height: t.h,
          angle: a, scale: s, score, region: 'template',
        });
      }
    }
  }
  hits.sort((p, q) => q.score - p.score);
  return hits.slice(0, 10);
}
