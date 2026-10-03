let sessionPromise: Promise<any> | null = null;
let cachedKey = '';

async function getSession(ort: any, url: string) {
  if (!sessionPromise || cachedKey !== url) {
    cachedKey = url;
    sessionPromise = ort.InferenceSession.create(url, {
      executionProviders: ['wasm'],
    });
  }
  return sessionPromise;
}

export async function lamaInpaint(
  imageData: ImageData, mask: Float32Array,
  ort: any, modelUrl = 'models/lama.onnx',
): Promise<ImageData> {
  const session = await getSession(ort, modelUrl);
  const { width: W, height: H } = imageData;
  const fw = Math.ceil(W / 8) * 8;
  const fh = Math.ceil(H / 8) * 8;
  const img = new Float32Array(3 * fh * fw);
  const msk = new Float32Array(fh * fw);

  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      const ox = Math.min(W - 1, x);
      const oy = Math.min(H - 1, y);
      const j = (oy * W + ox) * 4;
      const k = y * fw + x;
      img[0 * fh * fw + k] = imageData.data[j]! / 255;
      img[1 * fh * fw + k] = imageData.data[j + 1]! / 255;
      img[2 * fh * fw + k] = imageData.data[j + 2]! / 255;
      msk[k] = mask[oy * W + ox]!;
    }
  }

  const out = await session.run({
    image: new ort.Tensor('float32', img, [1, 3, fh, fw]),
    mask: new ort.Tensor('float32', msk, [1, 1, fh, fw]),
  });

  const res = new ImageData(W, H);
  const o = out.output.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = y * fw + x;
      const j = (y * W + x) * 4;
      res.data[j] = Math.max(0, Math.min(255, o[0 * fh * fw + k] * 255));
      res.data[j + 1] = Math.max(0, Math.min(255, o[1 * fh * fw + k] * 255));
      res.data[j + 2] = Math.max(0, Math.min(255, o[2 * fh * fw + k] * 255));
      res.data[j + 3] = 255;
    }
  }
  return res;
}
