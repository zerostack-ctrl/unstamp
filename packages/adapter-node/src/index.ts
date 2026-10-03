import { createCanvas, loadImage } from '@napi-rs/canvas';
import sharp from 'sharp';
import * as ort from 'onnxruntime-node';
import { detectAll, buildMask, inpaintPipeline, stripMetadataBytes } from '@zerostack-labc/unstamp';
import type { UnstampOptions } from '@zerostack-labc/unstamp';

export interface NodeUnstampOptions extends UnstampOptions {
  miganPath?: string;
  lamaPath?: string;
}

export async function unstampFile(
  input: string | Buffer,
  opts: NodeUnstampOptions = {},
): Promise<Buffer> {
  const raw =
    typeof input === 'string'
      ? await import('node:fs/promises').then((m) => m.readFile(input))
      : input;

  let buf = new Uint8Array(raw);
  if (opts.metadata) buf = stripMetadataBytes(buf);

  const img = await loadImage(Buffer.from(buf));
  const W = img.width;
  const H = img.height;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, W, H);

  const hits = detectAll(id as any, {
    text: opts.text, template: opts.template,
    angle: opts.angle ?? 'auto',
    outline: opts.outline, tiled: opts.tiled,
  });

  const mask = buildMask(hits, { width: W, height: H }, { feather: 2, dilate: 3 });

  const colour: [number, number, number] | null =
    opts.colour === 'white' ? [255, 255, 255]
    : opts.colour === 'black' ? [0, 0, 0]
    : null;

  const out = await inpaintPipeline(id as any, mask, {
    model: opts.model ?? 'auto',
    ort,
    useAlphaInvert: opts.transparent && !!opts.text,
    colour,
    postDenoise: opts.denoise !== false,
    postSharpen: opts.sharpen !== false,
    miganUrl: opts.miganPath,
    lamaUrl: opts.lamaPath,
  });

  const outCanvas = createCanvas(W, H);
  outCanvas.getContext('2d').putImageData(out as any, 0, 0);
  return sharp(Buffer.from(outCanvas.toBuffer('image/png'))).png().toBuffer();
}
