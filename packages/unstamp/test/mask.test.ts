import { describe, it, expect } from 'vitest';
import { buildMask, carveOut } from '../src/mask/index.js';

describe('buildMask', () => {
  it('creates a positive mask over a detection', () => {
    const mask = buildMask(
      [{ x: 10, y: 10, width: 20, height: 10, angle: 0, scale: 1, score: 1, region: 'text' }],
      { width: 100, height: 100 },
      { feather: 0, dilate: 0 },
    );
    expect(mask[15 * 100 + 15]).toBeCloseTo(1);
    expect(mask[50 * 100 + 50]).toBe(0);
  });

  it('respects dilate', () => {
    const mask = buildMask(
      [{ x: 10, y: 10, width: 10, height: 10, angle: 0, scale: 1, score: 1, region: 'text' }],
      { width: 100, height: 100 },
      { feather: 0, dilate: 5 },
    );
    expect(mask[7 * 100 + 7]).toBeCloseTo(1);
  });
});

describe('carveOut', () => {
  it('zeros out a region', () => {
    const mask = new Float32Array(100 * 100).fill(1);
    carveOut(mask, { width: 100, height: 100 }, [
      { x: 10, y: 10, width: 20, height: 20 },
    ]);
    expect(mask[15 * 100 + 15]).toBe(0);
    expect(mask[50 * 100 + 50]).toBe(1);
  });
});
