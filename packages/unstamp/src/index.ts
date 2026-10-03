import { detectAll } from './detect/index.js';
import { buildMask, carveOut } from './mask/index.js';
import { inpaintPipeline } from './inpaint/index.js';
import { stripMetadata } from './metadata.js';
import type { Detection, Result, UnstampOptions, Phase } from './types.js';

export type { Detection, Result, UnstampOptions, Phase, ImageSource, ColourHint } from './types.js';

export { stripMetadata } from './metadata.js';
export { PRESETS } from './presets.js';
export type { Preset, PresetName } from './presets.js';
export { detectAll, detectTextWatermark, detectGeneric, detectTemplate, findTilePeriod } from './detect/index.js';
export { buildMask, carveOut } from './mask/index.js';
export { inpaintPipeline, alphaInvert, frequencyNotch, denoise, sharpen } from './inpaint/index.js';

function toImageData(src: any, W: number, H: number): ImageData {
  const c =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(W, H)
      : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const ctx = (c as HTMLCanvasElement).getContext('2d')!;
  ctx.drawImage(src, 0, 0, W, H);
  return ctx.getImageData(0, 0, W, H);
}

function sourceSize(src: any): { width: number; height: number } {
  const w = src.width ?? src.naturalWidth;
  const h = src.height ?? src.naturalHeight;
  return { width: w, height: h };
}

export async function detect(image: any, opts: UnstampOptions = {}): Promise<Detection[]> {
  const { width, height } = sourceSize(image);
  const id = image instanceof ImageData ? image : toImageData(image, width, height);
  return detectAll(id, {
    text: opts.text,
    template: opts.template,
    angle: opts.angle ?? 'auto',
    outline: opts.outline,
    tiled: opts.tiled,
  });
}

export async function inpaint(
  image: any, mask: Float32Array,
  opts: { model?: UnstampOptions['model']; ort?: any; miganUrl?: string; lamaUrl?: string } = {},
): Promise<ImageData> {
  const { width, height } = sourceSize(image);
  const id = image instanceof ImageData ? image : toImageData(image, width, height);
  return inpaintPipeline(id, mask, {
    model: opts.model ?? 'auto',
    ort: opts.ort,
    miganUrl: opts.miganUrl,
    lamaUrl: opts.lamaUrl,
  });
}

export async function unstamp(image: any, opts: UnstampOptions = {}): Promise<Result> {
  const timings: Partial<Record<Phase, number>> = {};
  const t = (phase: Phase) => {
    const start = performance.now();
    return () => { timings[phase] = performance.now() - start; };
  };

  let input = image;
  if (opts.metadata && input instanceof Blob) {
    const done = t('metadata');
    input = await stripMetadata(input);
    done();
  }

  let bitmap: any = input;
  if (input instanceof Blob) bitmap = await createImageBitmap(input);
  if (input instanceof HTMLImageElement) bitmap = input;
  const { width, height } = sourceSize(bitmap);
  const id: ImageData = bitmap instanceof ImageData ? bitmap : toImageData(bitmap, width, height);

  opts.onProgress?.('detect', 0);
  let done = t('detect');
  const detections = detectAll(id, {
    text: opts.text, template: opts.template,
    angle: opts.angle ?? 'auto',
    outline: opts.outline, tiled: opts.tiled,
  });
  done();
  opts.onProgress?.('detect', 1);

  opts.onProgress?.('mask', 0);
  done = t('mask');
  let mask = buildMask(detections, { width, height }, { feather: 2, dilate: 3 });
  if (opts.safeMode && 'FaceDetector' in globalThis) {
    try {
      const fd = new (globalThis as any).FaceDetector({ fastMode: true });
      const faces = await fd.detect(bitmap);
      if (faces.length) {
        mask = new Float32Array(mask);
        carveOut(
          mask,
          { width, height },
          faces.map((f: any) => ({
            x: f.boundingBox.x, y: f.boundingBox.y,
            width: f.boundingBox.width, height: f.boundingBox.height,
          })),
          Math.max(width, height) * 0.02,
        );
      }
    } catch {}
  }
  done();
  opts.onProgress?.('mask', 1);

  opts.onProgress?.('inpaint', 0);
  done = t('inpaint');
  const colour: [number, number, number] | null =
    opts.colour === 'white' ? [255, 255, 255]
    : opts.colour === 'black' ? [0, 0, 0]
    : null;
  const output = await inpaintPipeline(id, mask, {
    model: opts.model ?? 'auto',
    ort: opts.ort,
    useAlphaInvert: opts.transparent && !!opts.text,
    colour, opacity: 0,
    postDenoise: opts.denoise !== false,
    postSharpen: opts.sharpen !== false,
    miganUrl: opts.resolveModelUrl?.('migan'),
    lamaUrl: opts.resolveModelUrl?.('lama'),
  });
  done();
  opts.onProgress?.('inpaint', 1);
  opts.onProgress?.('done', 1);

  return { image: output, mask, detections, timings };
}
