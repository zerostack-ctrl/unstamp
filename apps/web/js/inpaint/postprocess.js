export function denoise(imageData, strength = 0.4) {
  const { data, width: W, height: H } = imageData;
  const out = new ImageData(new Uint8ClampedArray(data), W, H);
  const r = 1;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const j = (y * W + x) * 4;
    let sumR = 0, sumG = 0, sumB = 0, wsum = 0;
    const cr = data[j], cg = data[j + 1], cb = data[j + 2];
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const k = ((y + dy) * W + (x + dx)) * 4;
      const dR = data[k] - cr, dG = data[k + 1] - cg, dB = data[k + 2] - cb;
      const w = Math.exp(-(dR * dR + dG * dG + dB * dB) / (2 * 30 * 30));
      sumR += data[k] * w; sumG += data[k + 1] * w; sumB += data[k + 2] * w; wsum += w;
    }
    out.data[j]   = cr * (1 - strength) + (sumR / wsum) * strength;
    out.data[j+1] = cg * (1 - strength) + (sumG / wsum) * strength;
    out.data[j+2] = cb * (1 - strength) + (sumB / wsum) * strength;
  }
  return out;
}

export function sharpen(imageData, amount = 0.5) {
  const { data, width: W, height: H } = imageData;
  const out = new ImageData(new Uint8ClampedArray(data), W, H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const j = (y * W + x) * 4;
    for (let c = 0; c < 3; c++) {
      const centre = data[j + c];
      const n = data[((y-1)*W+x)*4 + c] + data[((y+1)*W+x)*4 + c]
              + data[(y*W+x-1)*4 + c] + data[(y*W+x+1)*4 + c];
      const lap = centre - n / 4;
      out.data[j + c] = Math.max(0, Math.min(255, centre + lap * amount));
    }
  }
  return out;
}
