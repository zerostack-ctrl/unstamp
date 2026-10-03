import { describe, it, expect } from 'vitest';
import { ncc } from '../src/detect/fft.js';
import { makeImage, placeText } from './fixtures.js';

function makeGradient(w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[y * w + x] = x / w + y / h;
    }
  }
  return out;
}

function makeDelta(w: number, h: number, dx: number, dy: number): Float32Array {
  const out = new Float32Array(w * h);
  out[dy * w + dx] = 1;
  return out;
}

describe('ncc', () => {
  // Exact-position sanity check: a delta template has a unique, sharp peak.
  it('finds a delta template at the exact position', () => {
    const img = makeImage(128, 128, 0);
    const tpl = makeDelta(8, 4, 3, 1);
    placeText(img, 128, tpl, 8, 4, 50, 60);

    const { x, y } = ncc(img, 128, 128, tpl, 8, 4);
    expect(x).toBe(50);
    expect(y).toBe(60);
  });

  // A gradient template has a broad correlation peak. The algorithm's
  // guarantee is a position within a few pixels (mask dilation absorbs
  // the difference) and a score clearly above the "not present" case.
  it('finds a gradient template within a few pixels', () => {
    const img = makeImage(256, 256, 0);
    const tpl = makeGradient(32, 16);
    placeText(img, 256, tpl, 32, 16, 100, 120);

    const { x, y, score } = ncc(img, 256, 256, tpl, 32, 16);
    expect(Math.abs(x - 100)).toBeLessThanOrEqual(5);
    expect(Math.abs(y - 120)).toBeLessThanOrEqual(5);
    expect(score).toBeGreaterThan(0.3);
  });

  it('returns a low score for a template that is not present', () => {
    const img = makeImage(256, 256, 0);
    const tpl = makeGradient(32, 16);
    const { score } = ncc(img, 256, 256, tpl, 32, 16);
    expect(score).toBeLessThan(0.3);
  });
});