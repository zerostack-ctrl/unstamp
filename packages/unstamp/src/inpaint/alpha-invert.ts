export function alphaInvert(
  imageData: ImageData,
  mask: Float32Array,
  opts: { colour?: [number, number, number]; opacity?: number } = {},
): ImageData {
  const { data, width: W, height: H } = imageData;
  const out = new ImageData(new Uint8ClampedArray(data), W, H);
  const colour = opts.colour ?? estimateColour(imageData, mask);
  const alphaHint = opts.opacity && opts.opacity > 0 ? opts.opacity / 100 : 0;

  for (let i = 0; i < W * H; i++) {
    const m = mask[i]!;
    if (m < 0.05) continue;
    let a = alphaHint;
    if (a === 0) a = Math.min(0.95, Math.max(0.05, m));
    const j = i * 4;
    for (let c = 0; c < 3; c++) {
      const v = data[j + c]!;
      const cv = colour[c]!;
      const denom = 1 - a * m;
      if (denom < 0.05) continue;
      const b = (v - a * m * cv) / denom;
      out.data[j + c] = Math.max(0, Math.min(255, b));
    }
  }
  return out;
}

function estimateColour(imageData: ImageData, mask: Float32Array): [number, number, number] {
  const { data } = imageData;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]! < 0.4) continue;
    const j = i * 4;
    r += data[j]!; g += data[j + 1]!; b += data[j + 2]!;
    n++;
  }
  if (!n) return [255, 255, 255];
  r /= n; g /= n; b /= n;
  return (r + g + b) / 3 > 128 ? [255, 255, 255] : [0, 0, 0];
}
