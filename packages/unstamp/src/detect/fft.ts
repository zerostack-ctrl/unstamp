export function fft2d(re, im, W, H, inverse = false) {
  for (let y = 0; y < H; y++) fft1d(re, im, y * W, 1, W, inverse);
  for (let x = 0; x < W; x++) fft1d(re, im, x, W, H, inverse);
}

function fft1d(re, im, off, stride, n, inverse) {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const ai = off + i * stride, aj = off + j * stride;
      [re[ai], re[aj]] = [re[aj], re[ai]];
      [im[ai], im[aj]] = [im[aj], im[ai]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cRe = 1, cIm = 0;
      for (let j = 0; j < len >> 1; j++) {
        const u = off + (i + j) * stride;
        const v = off + (i + j + (len >> 1)) * stride;
        const tRe = re[v] * cRe - im[v] * cIm;
        const tIm = re[v] * cIm + im[v] * cRe;
        re[v] = re[u] - tRe; im[v] = im[u] - tIm;
        re[u] += tRe;        im[u] += tIm;
        const nRe = cRe * wRe - cIm * wIm;
        cIm = cRe * wIm + cIm * wRe;
        cRe = nRe;
      }
    }
  }
  if (inverse) {
    const inv = 1 / n;
    for (let i = 0; i < n; i++) { re[off+i*stride] *= inv; im[off+i*stride] *= inv; }
  }
}

export function ncc(img, iw, ih, tpl, tw, th) {
  const W = iw + tw, H = ih + th;
  const iRe = new Float32Array(W * H), iIm = new Float32Array(W * H);
  const tRe = new Float32Array(W * H), tIm = new Float32Array(W * H);
  let iMean = 0; for (let i = 0; i < iw * ih; i++) iMean += img[i];
  iMean /= iw * ih;
  let iVar = 0;
  for (let i = 0; i < iw * ih; i++) { const v = img[i] - iMean; iVar += v * v; }
  iVar = Math.sqrt(iVar) || 1;
  for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) iRe[y * W + x] = img[y * iw + x] - iMean;
  let tMean = 0; for (let i = 0; i < tw * th; i++) tMean += tpl[i];
  tMean /= tw * th;
  let tVar = 0;
  for (let i = 0; i < tw * th; i++) { const v = tpl[i] - tMean; tVar += v * v; }
  tVar = Math.sqrt(tVar) || 1;
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) tRe[y * W + x] = tpl[y * tw + x] - tMean;
  fft2d(iRe, iIm, W, H);
  fft2d(tRe, tIm, W, H);
  for (let i = 0; i < W * H; i++) {
    const a = iRe[i], b = iIm[i], c = tRe[i], d = -tIm[i];
    iRe[i] = a * c - b * d; iIm[i] = a * d + b * c;
  }
  fft2d(iRe, iIm, W, H, true);
  let best = { x: 0, y: 0, score: -Infinity };
  for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) {
    const v = iRe[y * W + x] / (iVar * tVar);
    if (v > best.score) best = { x, y, score: v };
  }
  return best;
}

export function topKPeaks(re, im, W, H, k = 6) {
  const peaks = [];
  const cx = W >> 1, cy = H >> 1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const fx = x - cx, fy = y - cy;
    if (Math.abs(fx) < 3 && Math.abs(fy) < 3) continue;
    peaks.push({ fx, fy, mag: Math.hypot(re[y*W+x], im[y*W+x]) });
  }
  peaks.sort((a, b) => b.mag - a.mag);
  const out = [];
  for (const p of peaks) {
    if (out.some((q) => Math.hypot(q.fx - p.fx, q.fy - p.fy) < 4)) continue;
    out.push(p);
    if (out.length >= k) break;
  }
  return out;
}
