import { detectTextWatermark } from './text.js';
import { detectGeneric } from './generic.js';
import { findTilePeriod } from './periodic.js';
import { detectTemplate } from './template.js';
import type { Detection, UnstampOptions } from '../types.js';

export { detectTextWatermark, detectGeneric, detectTemplate, findTilePeriod };
export { ncc, fft2d, topKPeaks } from './fft.js';
export { toGray, highPass, renderTextMask, rotateMask, scaleMask } from './text.js';

export function detectAll(
  imageData: ImageData,
  opts: Pick<UnstampOptions, 'text' | 'template' | 'angle' | 'outline' | 'tiled'>,
): Detection[] {
  let hits: Detection[] = [];

  if (opts.template) {
    hits = detectTemplate(imageData, opts.template as any, {
      angle: opts.angle === 'auto' ? null : (opts.angle as number),
    });
  } else if (opts.text) {
    hits = detectTextWatermark(imageData, opts.text, {
      angle: opts.angle === 'auto' ? null : (opts.angle as number),
      outline: opts.outline,
    });
  } else {
    hits = detectGeneric(imageData);
  }

  if (opts.tiled) {
    const periods = findTilePeriod(imageData);
    for (const h of hits) (h as any).tilePeriods = periods;
  }

  return hits;
}
