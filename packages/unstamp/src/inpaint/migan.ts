let sessionPromise: Promise<any> | null = null;
let cachedKey = '';

async function getSession(ort: any, url: string) {
  if (!sessionPromise || cachedKey !== url) {
    cachedKey = url;
    sessionPromise = ort.InferenceSession.create(url, {
      executionProviders: await bestProvider(ort),
    });
  }
  return sessionPromise;
}

async function bestProvider(ort: any): Promise<string[]> {
  try {
    if (typeof navigator !== 'undefined' && (navigator as any).gpu && ort.env.webgpu) {
      return ['webgpu', 'wasm'];
    }
  } catch {}
  return ['wasm'];
}

export async function miganInpaint(
  imageData: ImageData, mask: Float32Array,
  ort: any, modelUrl = 'models/migan.onnx',
): Promise<ImageData> {
  const session = await getSession(ort, modelUrl);
  const { width: W, height: H } = imageData;
  const size = 512;
  const img = new Float32Array(3 * size * size);
  const msk = new Float32Array(size * size);
  const sx = W / size; const sy = H / size;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ox = Math.min(W - 1, (x * sx) | 0);
      const oy = Math.min(H - 1, (y * sy) | 0);
      const j = (oy * W + ox) * 4;
      const k = y * size + x;
      img[0 * size * size + k] = imageData.data[j]! / 127.5 - 1;
      img[1 * size * size + k] = imageData.data[j + 1]! / 127.5 - 1;
      img[2 * size * size + k] = imageData.data[j + 2]! / 127.5 - 1;
      msk[k] = mask[oy * W + ox]!;
    }
  }

  const results = await session.run({
    image: new ort.Tensor('float32', img, [1, 3, size, size]),
    mask: new ort.Tensor('float32', msk, [1, 1, size, size]),
  });

  const out = new ImageData(W, H);
  const o = results.output.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = Math.min(size - 1, (x / sx) | 0);
      const py = Math.min(size - 1, (y / sy) | 0);
      const k = py * size + px;
      const j = (y * W + x) * 4;
      out.data[j] = (o[0 * size * size + k] + 1) * 127.5;
      out.data[j + 1] = (o[1 * size * size + k] + 1) * 127.5;
      out.data[j + 2] = (o[2 * size * size + k] + 1) * 127.5;
      out.data[j + 3] = 255;
    }
  }
  return out;
}
