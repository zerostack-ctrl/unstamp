import { describe, it, expect } from 'vitest';
import { ncc } from '../src/detect/fft.js';
import { makeImage, placeText } from './fixtures.js';

describe('ncc', () => {
  it('finds a template at the exact position', () => {
    const img = makeImage(256, 256, 0);
    const tpl = makeImage(32, 16, 1);
    placeText(img, 256, tpl, 32, 16, 100, 120);
    const { x, y, score } = ncc(img, 256, 256, tpl, 32, 16);
    expect(x).toBeCloseTo(100, 0);
    expect(y).toBeCloseTo(120, 0);
    expect(score).toBeGreaterThan(0.9);
  });

  it('returns a low score for a template that is not present', () => {
    const img = makeImage(256, 256, 0);
    const tpl = makeImage(32, 16, 1);
    const { score } = ncc(img, 256, 256, tpl, 32, 16);
    expect(score).toBeLessThan(0.2);
  });
});
