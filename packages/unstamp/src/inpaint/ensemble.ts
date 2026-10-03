import { miganInpaint } from './migan.js';
import { lamaInpaint } from './lama.js';

export async function ensembleInpaint(
  imageData: ImageData, mask: Float32Array, ort: any,
  urls?: { migan?: string; lama?: string },
): Promise<ImageData> {
  const { width: W, height: H } = imageData;
  let covered = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]! > 0.5) covered++;
  const area = covered / (W * H);

  if (area < 0.02) return miganInpaint(imageData, mask, ort, urls?.migan);
  if (area > 0.15) return lamaInpaint(imageData, mask, ort, urls?.lama);

  const [a, b] = await Promise.all([
    miganInpaint(imageData, mask, ort, urls?.migan),
    lamaInpaint(imageData, mask, ort, urls?.lama),
  ]);
  return blend(a, b, mask, W, H);
}

function blend(a: ImageData, b: ImageData, mask: Float32Array, W: number, H: number): ImageData {
  const out = new ImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    const m = mask[i]!;
    const j = i * 4;
    for (let c = 0; c < 3; c++) {
      out.data[j + c] = a.data[j + c]! * (1 - m) + b.data[j + c]! * m;
    }
    out.data[j + 3] = 255;
  }
  return out;
}
