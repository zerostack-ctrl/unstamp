import { miganInpaint } from './migan.js';
import { lamaInpaint } from './lama.js';
import { ensembleInpaint } from './ensemble.js';
import { alphaInvert } from './alpha-invert.js';
import { frequencyNotch } from './notch.js';
import { denoise, sharpen } from './postprocess.js';
import type { UnstampOptions } from '../types.js';

export { miganInpaint, lamaInpaint, ensembleInpaint, alphaInvert, frequencyNotch, denoise, sharpen };

export interface InpaintOptions {
  model?: UnstampOptions['model'];
  ort?: any;
  useAlphaInvert?: boolean;
  useNotch?: boolean;
  peaks?: Array<{ fx: number; fy: number }>;
  colour?: [number, number, number] | null;
  opacity?: number;
  postDenoise?: boolean;
  postSharpen?: boolean;
  miganUrl?: string;
  lamaUrl?: string;
}

export async function inpaintPipeline(
  imageData: ImageData, mask: Float32Array, opts: InpaintOptions = {},
): Promise<ImageData> {
  let out = imageData;

  if (opts.useNotch && opts.peaks?.length) {
    out = frequencyNotch(out, opts.peaks);
  }

  if (opts.useAlphaInvert) {
    out = alphaInvert(out, mask, {
      colour: opts.colour ?? undefined,
      opacity: opts.opacity,
    });
  } else {
    const model = opts.model ?? 'auto';
    if (model === 'migan') out = await miganInpaint(out, mask, opts.ort, opts.miganUrl);
    else if (model === 'lama') out = await lamaInpaint(out, mask, opts.ort, opts.lamaUrl);
    else out = await ensembleInpaint(out, mask, opts.ort, {
      migan: opts.miganUrl,
      lama: opts.lamaUrl,
    });
  }

  if (opts.postDenoise) out = denoise(out, 0.3);
  if (opts.postSharpen) out = sharpen(out, 0.4);
  return out;
}
