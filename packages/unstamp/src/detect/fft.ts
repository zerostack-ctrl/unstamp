export function fft2d(
  re: Float32Array,
  im: Float32Array,
  W: number,
  H: number,
  inverse = false,
): void {
  for (let y = 0; y < H; y++) fft1d(re, im, y * W, 1, W, inverse);
  for (let x = 0; x < W; x++) fft1d(re, im, x, W, H, inverse);
}

function fft1d(
  re: Float32Array,
  im: Float32Array,
  off: number,
  stride: number,
  n: number,
  inverse: boolean,
): void {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const ai = off + i * stride;
      const aj = off + j * stride;
      const tr = re[ai]!;
      re[ai] = re[aj]!;
      re[aj] = tr;
      const ti = im[ai]!;
      im[ai] = im[aj]!;
      im[aj] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cRe = 1;
      let cIm = 0;
      for (let j = 0; j < len >> 1; j++) {
        const u = off + (i + j) * stride;
        const v = off + (i + j + (len >> 1)) * stride;
        const tRe = re[v]! * cRe - im[v]! * cIm;
        const tIm = re[v]! * cIm + im[v]! * cRe;
        re[v] = re[u]! - tRe;
        im[v] = im[u]! - tIm;
        re[u] = re[u]! + tRe;
        im[u] = im[u]! + tIm;
        const nRe = cRe * wRe - cIm * wIm;
        cIm = cRe * wIm + cIm * wRe;
        cRe = nRe;
      }
    }
  }
  if (inverse) {
    const inv = 1 / n;
    for (let i = 0; i < n; i++) {
      re[off + i * stride]! *= inv;
      im[off + i * stride]! *= inv;
    }
  }
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

export interface NccResult { x: number; y: number; score: number; }

export function ncc(
  img: Float32Array,
  iw: number,
  ih: number,
  tpl: Float32Array,
  tw: number,
  th: number,
): NccResult {
  // Radix-2 FFT requires power-of-2 sizes. Pad up to the next power.
  const W = nextPow2(iw + tw);
  const H = nextPow2(ih + th);

  const iRe = new Float32Array(W * H);
  const iIm = new Float32Array(W * H);
  const tRe = new Float32Array(W * H);
  const tIm = new Float32Array(W * H);

  let iMean = 0;
  for (let i = 0; i < iw * ih; i++) iMean += img[i]!;
  iMean /= iw * ih;
  let iVar = 0;
  for (let i = 0; i < iw * ih; i++) {
    const v = img[i]! - iMean;
    iVar += v * v;
  }
  iVar = Math.sqrt(iVar) || 1;

  for (let y = 0; y < ih; y++)
    for (let x = 0; x < iw; x++) iRe[y * W + x] = img[y * iw + x]! - iMean;

  let tMean = 0;
  for (let i = 0; i < tw * th; i++) tMean += tpl[i]!;
  tMean /= tw * th;
  let tVar = 0;
  for (let i = 0; i < tw * th; i++) {
    const v = tpl[i]! - tMean;
    tVar += v * v;
  }
  tVar = Math.sqrt(tVar) || 1;

  for (let y = 0; y < th; y++)
    for (let x = 0; x < tw; x++) tRe[y * W + x] = tpl[y * tw + x]! - tMean;

  fft2d(iRe, iIm, W, H);
  fft2d(tRe, tIm, W, H);

  for (let i = 0; i < W * H; i++) {
    const a = iRe[i]!;
    const b = iIm[i]!;
    const c = tRe[i]!;
    const d = -tIm[i]!;
    iRe[i] = a * c - b * d;
    iIm[i] = a * d + b * c;
  }
  fft2d(iRe, iIm, W, H, true);

  const maxX = iw - tw;
  const maxY = ih - th;
  let bestX = 0;
  let bestY = 0;
  let best = -Infinity;
  for (let y = 0; y <= maxY; y++) {
    for (let x = 0; x <= maxX; x++) {
      const v = iRe[y * W + x]! / (iVar * tVar);
      if (v > best) {
        best = v;
        bestX = x;
        bestY = y;
      }
    }
  }
  return { x: bestX, y: bestY, score: best };
}

export interface Peak { fx: number; fy: number; mag: number; }

export function topKPeaks(
  re: Float32Array,
  im: Float32Array,
  W: number,
  H: number,
  k = 6,
): Peak[] {
  const peaks: Peak[] = [];
  const cx = W >> 1;
  const cy = H >> 1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const fx = x - cx;
      const fy = y - cy;
      if (Math.abs(fx) < 3 && Math.abs(fy) < 3) continue;
      const mag = Math.hypot(re[y * W + x]!, im[y * W + x]!);
      peaks.push({ fx, fy, mag });
    }
  }
  peaks.sort((a, b) => b.mag - a.mag);
  const out: Peak[] = [];
  for (const p of peaks) {
    if (out.some((q) => Math.hypot(q.fx - p.fx, q.fy - p.fy) < 4)) continue;
    out.push(p);
    if (out.length >= k) break;
  }
  return out;
}