import { toGray, highPass } from './text.js';
import type { Detection } from '../types.js';

export function detectGeneric(imageData: ImageData): Detection[] {
  const { width: W, height: H } = imageData;
  const hp = highPass(toGray(imageData), W, H, 20);
  const thresh = 0.06;
  const visited = new Uint8Array(W * H);
  const blobs: Detection[] = [];

  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const i = y * W + x;
      if (visited[i] || Math.abs(hp[i]!) < thresh) continue;
      const stack = [i]; const px: number[] = [];
      let minX = x, maxX = x, minY = y, maxY = y;
      const sign = Math.sign(hp[i]!);
      let sum = 0;
      while (stack.length) {
        const j = stack.pop()!;
        if (visited[j]) continue;
        visited[j] = 1;
        const jy = (j / W) | 0; const jx = j % W;
        if (Math.sign(hp[j]!) !== sign) continue;
        px.push(j);
        sum += Math.abs(hp[j]!);
        if (jx < minX) minX = jx; if (jx > maxX) maxX = jx;
        if (jy < minY) minY = jy; if (jy > maxY) maxY = jy;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = jx + dx; const ny = jy + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const k = ny * W + nx;
          if (!visited[k] && Math.abs(hp[k]!) >= thresh) stack.push(k);
        }
        if (px.length > 20000) break;
      }
      const bw = maxX - minX + 1; const bh = maxY - minY + 1;
      if (px.length < 40 || bw < 8 || bh < 8) continue;
      const aspect = bw / bh;
      if (aspect > 12 || aspect < 0.08) continue;
      const cx = (minX + maxX) / 2 / W; const cy = (minY + maxY) / 2 / H;
      const cornerDist = Math.min(
        Math.hypot(cx - 0.85, cy - 0.9),
        Math.hypot(cx - 0.15, cy - 0.9),
        Math.hypot(cx - 0.85, cy - 0.15),
        Math.hypot(cx - 0.15, cy - 0.15),
      );
      const score = (sum / px.length) * (1 - Math.min(1, cornerDist));
      blobs.push({
        x: minX, y: minY, width: bw, height: bh,
        angle: 0, scale: 1, score, region: 'blob',
      });
    }
  }
  blobs.sort((a, b) => b.score - a.score);
  return blobs.slice(0, 10);
}
